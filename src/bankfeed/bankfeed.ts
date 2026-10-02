import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { Cents } from '../shared/money';
import type { IsoDate } from '../shared/dates';
import { normalizeIban, ValidationError } from '../shared/validation';
import { BANK_FEED, BANK_FEED_SECRET_KEYS } from '../shared/bank-feed';
import type { SecretStore } from '../integrations/types';
import { PontoClient, PontoError, type PontoAccount, type PontoCredentials } from '../integrations/ponto';
import type { SettingsService } from '../settings/settings';
import type { BankService } from '../import/bank';

/**
 * BankFeedService (WP4A, #246): uitsluitend de basis van de Ponto-bankfeed — veilige
 * credentials, status, verbinding testen, rekeningkeuzes bewaren/verwijderen en één
 * gedeelde single-flight-lock. De financiële ophaalronde komt apart in #253; er is hier
 * dan ook geen import, geen `completeTo`-berekening, geen saldovergelijking, geen UI,
 * IPC, taak of timer. Er wordt nooit een echte netwerkaanroep gedaan door deze service
 * zelf: de client wordt van buiten aangeleverd (in productie een echte `PontoClient`,
 * in tests een nep).
 *
 * Bindende regels uit #246, hier afgedwongen:
 * - de generieke `IntegrationService`/`INTEGRATIONS`/tabel `integrations` worden niet gebruikt;
 * - Client ID en secret staan uitsluitend in de `SecretStore` onder de sleutels van
 *   `BANK_FEED_SECRET_KEYS`, nooit in `integrations.config` of ergens in JSON;
 * - `status()` geeft hooguit de laatste vier tekens van de Client ID, nooit een credential;
 * - zonder `SecretStore.available` weigert `saveLinks`; een onleesbare credential is
 *   `configured: false`, geen terugval op plaintext;
 * - `test()` bewaart niets, weigert `pi`-scope, markeert alleen EUR+IBAN+niet-deprecated
 *   als bruikbaar en stelt een bestaande rekening alleen op exact genormaliseerd IBAN voor;
 * - een nieuwe zakelijke rekening is nooit de standaardkeuze en zonder bewezen
 *   `completeTo` is `link.proven = false`;
 * - `saveLinks` valideert alle Ponto-id's tegen het laatste expliciete testresultaat in
 *   dezelfde service-instantie; onbekende of dubbele id's worden geweigerd;
 * - `remove()` wist beide credentials en alle feedkoppelingen, maar nooit banktransacties
 *   of bankrekeningen;
 * - één service-brede lock die #253 en #247 later kunnen hergebruiken;
 * - guards: vlag uit, read-only, kantoorkopie, demo/outbound blocked en MCP mogen niet
 *   configureren of netwerk gebruiken.
 */
// ---------- types (contract #246) ----------

export interface FeedAccountInfo {
  id: number;
  pontoId: string;
  name: string;
  iban: string | null;
  bankAccountId: number | null;
  status: 'actief' | 'niet-gebruiken' | 'weg';
  expiresAt: IsoDate | null;
  transactionsSynchronizedAt: string | null;
  detailsSynchronizedAt: string | null;
  lastOkAt: string | null;
  lastErrorKind: string | null;
  balance: Cents | null;
  balanceAt: string | null;
  gap: { from: IsoDate; to: IsoDate } | null;
  manualSyncAt: string | null;
}

export interface FeedStatus {
  available: boolean;
  secureStorage: boolean;
  configured: boolean;
  clientIdLast4: string | null;
  accounts: FeedAccountInfo[];
}

export interface FeedTestAccount {
  pontoId: string;
  name: string;
  iban: string | null;
  balance: Cents | null;
  expiresAt: IsoDate | null;
  usable: boolean;
  reason: string | null;
  suggestedBankAccountId: number | null;
  link: { completeTo: IsoDate | null; from: IsoDate | null; proven: boolean; note: string };
}

export interface FeedLink {
  pontoId: string;
  bankAccountId: number | 'nieuw' | null;
  name?: string;
}

// ---------- service ----------

/** Een rij uit `bank_feed_accounts` zoals migratie 33 hem maakt. */
interface FeedRow {
  id: number;
  external_id: string;
  bank_account_id: number | null;
  iban: string | null;
  name: string | null;
  status: string;
  transactions_synchronized_at: string | null;
  details_synchronized_at: string | null;
  expires_at: string | null;
  balance: number | null;
  balance_at: string | null;
  gap_from: string | null;
  gap_to: string | null;
  last_ok_at: string | null;
  last_error_kind: string | null;
  manual_sync_at: string | null;
}

export interface BankFeedDeps {
  db: Db;
  secrets: SecretStore;
  bank: BankService;
  settings: SettingsService;
  /** maakt de client voor één netwerkaanroep; in productie de echte, in tests een nep */
  client: (creds: PontoCredentials) => Pick<PontoClient, 'accounts'>;
}

export class BankFeedService {
  private readonly db: Db;
  private readonly secrets: SecretStore;
  private readonly bank: BankService;
  private readonly settings: SettingsService;
  private readonly makeClient: (creds: PontoCredentials) => Pick<PontoClient, 'accounts'>;
  /**
   * Het laatste expliciete testresultaat van deze service-instantie; alleen hiertegen zijn
   * Ponto-id's in `saveLinks` te valideren (regel 7). Expliciet: pas na een geslaagde `test()`.
   */
  private lastTest: { accounts: PontoAccount[]; creds: PontoCredentials } | null = null;
  /** Eén gedeelde single-flight-lock (regel 9); #253 en #247 hergebruiken dezelfde. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: BankFeedDeps) {
    this.db = deps.db;
    this.secrets = deps.secrets;
    this.bank = deps.bank;
    this.settings = deps.settings;
    this.makeClient = deps.client;
  }

  // ---------- lock (regel 9) ----------

  /**
   * Voert één asynchrone taak uit in de service-brede lock: twee gelijktijdige aanroepen
   * lopen nooit door elkaar, de tweede begint pas als de eerste klaar is (ook bij een fout).
   * later (#253): opslaan + eerste ronde, ophalen en handmatig bijwerken lopen hierdoorheen.
   */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---------- guards ----------

  /** Waarom de feed nu niets mag configureren of het netwerk op, of null als het mag. */
  private blocked(): string | null {
    if (!BANK_FEED.available) return 'De Ponto-bankfeed is nog niet beschikbaar in deze versie.';
    if (this.db.readonly) return 'Deze administratie is alleen-lezen; de bankfeed kan niet worden ingesteld.';
    // demo en de kopie bij de boekhouder sturen niets naar buiten (#246 regel 10); MCP draait read-only
    const outbound = this.settings.outboundBlocked();
    if (outbound !== null) return outbound;
    return null;
  }

  // ---------- credentials ----------

  private readCredentials(): { clientId: string; clientSecret: string } | null {
    const clientId = this.secrets.get(BANK_FEED_SECRET_KEYS.clientId);
    const clientSecret = this.secrets.get(BANK_FEED_SECRET_KEYS.clientSecret);
    // beide zijn credentials en moeten allebei leesbaar zijn; één onleesbaar = niet ingesteld
    // (regel 4: nooit terugvallen op plaintext of een half geheim)
    if (clientId === null || clientId.trim() === '' || clientSecret === null || clientSecret.trim() === '') return null;
    return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
  }

  // ---------- status ----------

  status(): FeedStatus {
    const creds = this.readCredentials();
    const rows = this.db
      .prepare('SELECT * FROM bank_feed_accounts WHERE provider = \'ponto\' ORDER BY id')
      .all() as FeedRow[];
    return {
      available: BANK_FEED.available,
      secureStorage: this.secrets.available,
      configured: creds !== null && this.secrets.available,
      // regel 3: hooguit de laatste vier tekens van de Client ID, nooit een volledige credential;
      // zonder leesbare credential is er ook geen betrouwbaar laatste-vier om te tonen (regel 4)
      clientIdLast4: creds === null || !this.secrets.available ? null : creds.clientId.slice(-4),
      accounts: rows.map((row) => ({
        id: row.id,
        pontoId: row.external_id,
        name: row.name ?? '',
        iban: row.iban,
        bankAccountId: row.bank_account_id,
        status: row.status as FeedAccountInfo['status'],
        expiresAt: row.expires_at,
        transactionsSynchronizedAt: row.transactions_synchronized_at,
        detailsSynchronizedAt: row.details_synchronized_at,
        lastOkAt: row.last_ok_at,
        lastErrorKind: row.last_error_kind,
        balance: row.balance,
        balanceAt: row.balance_at,
        gap: row.gap_from !== null && row.gap_to !== null ? { from: row.gap_from, to: row.gap_to } : null,
        manualSyncAt: row.manual_sync_at,
      })),
    };
  }

  // ---------- verbinding testen ----------

  /**
   * Test de verbinding en geeft de rekeningen terug zoals Ponto ze geeft, met een advies per
   * rekening. Bewaart niets (regel 5): geen credential, geen rij, geen testresultaat op schijf.
   * Weigert een `pi`-scope: de client geeft daarvoor `forbidden`.
   */
  async test(creds: PontoCredentials): Promise<{ accounts: FeedTestAccount[] }> {
    const blocked = this.blocked();
    if (blocked !== null) throw new ValidationError(blocked);
    // Een nieuwe expliciete testpoging maakt een ouder resultaat ongeldig. Na een mislukte
    // hertest mogen rekeningen of andere credentials nooit alsnog met dat oude resultaat
    // worden opgeslagen.
    this.lastTest = null;
    if (typeof creds?.clientId !== 'string' || creds.clientId.trim() === '' || typeof creds?.clientSecret !== 'string' || creds.clientSecret.trim() === '') {
      throw new ValidationError('Vul zowel de Client ID als het Client Secret in');
    }
    // eerst veilig proberen met alleen de scope-controle: de nepclient in tests geeft de scope
    // mee, maar het contract van `test()` kent geen losse probe; de verbindingstest zelf
    // weigert `pi` via de scope-controle in de client (PontoError 'forbidden').
    const testedCreds = { clientId: creds.clientId.trim(), clientSecret: creds.clientSecret.trim() };
    const client = this.makeClient(testedCreds);
    let scope = 'ai';
    let found: PontoAccount[];
    try {
      const result = await client.accounts();
      found = result.accounts;
      scope = result.scope;
    } catch (e) {
      if (e instanceof PontoError && (e.kind === 'credentials' || e.kind === 'forbidden')) {
        throw new ValidationError('Ponto heeft deze inloggegevens geweigerd. Controleer de Client ID, het Client Secret en of de scope "ai" is (geen "pi").');
      }
      throw e;
    }
    if (scope.split(/\s+/).includes('pi')) {
      throw new ValidationError('Deze Ponto-toegang heeft de scope "pi" (betalen). De bankfeed is alleen-lezen en weigert die scope.');
    }
    const existing = this.bank.listAccounts();
    const accounts: FeedTestAccount[] = [];
    for (const account of found) {
      accounts.push(this.describeAccount(account, existing));
    }
    // regel 7: het laatste expliciete testresultaat van deze instantie, waartegen saveLinks valideert
    this.lastTest = { accounts: found, creds: testedCreds };
    return { accounts };
  }

  /** Advies bij één gevonden rekening, op basis van de bestaande bankrekeningen. */
  private describeAccount(account: PontoAccount, existing: ReturnType<BankService['listAccounts']>): FeedTestAccount {
    // alleen EUR + IBAN + niet-deprecated is bruikbaar (regel 5)
    const usable = this.usable(account);
    let reason: string | null = null;
    if (!usable) {
      if (account.currency !== 'EUR') reason = 'Deze rekening is niet in euro\'s; de bankfeed leest alleen eurorekeningen.';
      else if (account.iban === null) reason = 'Van deze rekening is geen geldig IBAN bekend; de bankfeed kan haar niet koppelen.';
      else reason = 'Deze rekening is door de bank buiten gebruik gesteld (deprecated).';
    }
    // een bestaande rekening stel je uitsluitend voor op exact genormaliseerd IBAN (regel 5)
    const normalized = account.iban === null ? null : normalizeIban(account.iban);
    const match = normalized === null ? undefined : existing.find((a) => a.iban === normalized);
    const suggested = match ? match.id : null;
    const completeTo: IsoDate | null = null;
    let note: string;
    if (match) {
      note = 'Deze rekening bestaat al in je administratie; de feed hangt haar daar aan.'
        + (usable ? '' : ` Let op: ${reason}`);
    } else if (!usable) {
      note = `${reason} De feed koppelt haar niet.`;
    } else {
      // regel 6: een nieuwe zakelijke rekening is nooit de standaardkeuze en zonder bewezen
      // completeTo is de koppeling incompleet; een afschrift/openingssaldo blijft nodig (#253 vult later aan)
      note = 'Nieuwe rekening: geen standaardkeuze. Koppel haar alleen als je haar via de feed wilt inlezen. Zonder bewezen eindpunt blijft een afschrift of openingssaldo nodig om alle saldi te dekken.';
    }
    return {
      pontoId: account.id,
      name: account.name,
      iban: account.iban,
      balance: account.balance,
      expiresAt: account.expiresAt,
      usable,
      reason,
      suggestedBankAccountId: suggested,
      link: { completeTo, from: null, proven: false, note },
    };
  }

  private usable(account: PontoAccount): boolean {
    return account.currency === 'EUR' && account.iban !== null && !account.deprecated;
  }

  // ---------- rekeningkeuzes bewaren ----------

  /**
   * Bewaart credentials (tenzij `creds === null`: dan bestaande behouden, regel 7-testlijst)
   * en schrijft de gekozen rekeningkoppelingen weg. Alle Ponto-id's moeten in het laatste
   * expliciete testresultaat van deze instantie zitten; onbekende of dubbele id's worden
   * geweigerd. Alleen bij `'nieuw'` wordt een bankrekening gemaakt.
   */
  saveLinks(creds: PontoCredentials | null, links: FeedLink[]): void {
    const blocked = this.blocked();
    if (blocked !== null) throw new ValidationError(blocked);
    if (!this.secrets.available) {
      throw new ValidationError('Deze computer heeft geen veilige opslag voor wachtwoorden; de bankfeed kan daarom niet worden ingesteld.');
    }
    if (creds !== null) {
      if (typeof creds.clientId !== 'string' || creds.clientId.trim() === '' || typeof creds.clientSecret !== 'string' || creds.clientSecret.trim() === '') {
        throw new ValidationError('Vul zowel de Client ID als het Client Secret in');
      }
    } else if (this.readCredentials() === null) {
      throw new ValidationError('Er staan nog geen werkende inloggegevens in de veilige opslag; test eerst de verbinding.');
    }
    // alle id's tegen het laatste expliciete testresultaat valideren (regel 7)
    if (this.lastTest === null) throw new ValidationError('Test eerst de verbinding voordat je rekeningen koppelt.');
    const savedCreds = creds === null ? this.readCredentials()! : { clientId: creds.clientId.trim(), clientSecret: creds.clientSecret.trim() };
    if (savedCreds.clientId !== this.lastTest.creds.clientId || savedCreds.clientSecret !== this.lastTest.creds.clientSecret) {
      throw new ValidationError('Test deze inloggegevens opnieuw voordat je de rekeningkeuzes bewaart.');
    }
    if (!Array.isArray(links)) throw new ValidationError('De rekeningkeuzes ontbreken; test eerst opnieuw de verbinding.');
    const known = new Map(this.lastTest.accounts.map((a) => [a.id, a]));
    const seen = new Set<string>();
    for (const link of links) {
      if (typeof link?.pontoId !== 'string' || link.pontoId.trim() === '') throw new ValidationError('Kies een geldige rekening van Ponto.');
      if (!known.has(link.pontoId.trim())) throw new ValidationError('Onbekende Ponto-rekening; test eerst opnieuw de verbinding.');
      if (seen.has(link.pontoId.trim())) throw new ValidationError('Deze Ponto-rekening staat twee keer in de lijst; koppel haar één keer.');
      seen.add(link.pontoId.trim());
      if (link.bankAccountId !== null && link.bankAccountId !== 'nieuw'
        && (typeof link.bankAccountId !== 'number' || !Number.isInteger(link.bankAccountId))) {
        throw new ValidationError('Onbekende bankrekening; kies een bestaande rekening of "nieuw".');
      }
      const account = known.get(link.pontoId.trim())!;
      if (link.bankAccountId !== null && !this.usable(account)) {
        throw new ValidationError('Deze Ponto-rekening is niet bruikbaar; kies "niet gebruiken".');
      }
      if (typeof link.bankAccountId === 'number') {
        try {
          this.bank.getAccount(link.bankAccountId);
        } catch {
          throw new ValidationError('Onbekende bankrekening; kies een bestaande rekening of "nieuw".');
        }
      }
    }
    tx(this.db, () => {
      for (const link of links) {
        const pontoId = link.pontoId.trim();
        const account = known.get(pontoId)!;
        if (link.bankAccountId === null) {
          // `null` is de expliciete keuze "niet gebruiken" uit de wizard. Een bestaande
          // actieve koppeling moet daarmee ook echt stoppen voordat #253 rondes toevoegt.
          this.upsertFeedRow(pontoId, null, account, 'niet-gebruiken');
          continue;
        }
        if (link.bankAccountId === 'nieuw') {
          if (!account.iban) throw new ValidationError('Voor een nieuwe rekening is een IBAN nodig; deze Ponto-rekening heeft geen bruikbaar IBAN.');
          // al eerder op "nieuw" gekoppeld: de rekening bestaat dan al; geen dubbele aanmaken
          const previous = this.db
            .prepare('SELECT bank_account_id FROM bank_feed_accounts WHERE provider = \'ponto\' AND external_id = ?')
            .get(pontoId) as { bank_account_id: number | null } | undefined;
          if (previous?.bank_account_id != null) {
            this.upsertFeedRow(pontoId, previous.bank_account_id, account, 'actief');
            continue;
          }
          const name = link.name?.trim() || account.name?.trim() || 'Bankrekening (Ponto)';
          const created = this.bank.addAccount(name, account.iban, { pot: false });
          this.upsertFeedRow(pontoId, created.id, account, 'actief');
        } else {
          this.upsertFeedRow(pontoId, link.bankAccountId, account, 'actief');
        }
      }
      // credentials uitsluitend in de SecretStore (regel 2). Schrijf ze pas nadat alle
      // rekeningkeuzes zonder fout zijn verwerkt; de productie-store deelt deze DB-transactie.
      this.secrets.set(BANK_FEED_SECRET_KEYS.clientId, savedCreds.clientId);
      this.secrets.set(BANK_FEED_SECRET_KEYS.clientSecret, savedCreds.clientSecret);
    });
  }

  /** Maakt of actualiseert de feedrij voor één gekoppelde Ponto-rekening (migratie 33). */
  private upsertFeedRow(
    pontoId: string,
    bankAccountId: number | null,
    account: PontoAccount,
    status: 'actief' | 'niet-gebruiken',
  ): void {
    const existing = this.db
      .prepare('SELECT id FROM bank_feed_accounts WHERE provider = \'ponto\' AND external_id = ?')
      .get(pontoId) as { id: number } | undefined;
    if (existing !== undefined) {
      this.db
        .prepare('UPDATE bank_feed_accounts SET bank_account_id = ?, iban = ?, name = ?, holder = ?, status = ?, expires_at = ?, details_synchronized_at = COALESCE(?, details_synchronized_at), balance = COALESCE(?, balance), balance_at = COALESCE(?, balance_at) WHERE id = ?')
        .run(bankAccountId, account.iban, account.name, account.holder, status, account.expiresAt, account.detailsSynchronizedAt, account.balance, account.balanceAt, existing.id);
      return;
    }
    this.db
      .prepare(`INSERT INTO bank_feed_accounts (provider, external_id, bank_account_id, iban, name, holder, status, details_synchronized_at, expires_at, balance, balance_at)
        VALUES ('ponto', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(pontoId, bankAccountId, account.iban, account.name, account.holder, status, account.detailsSynchronizedAt, account.expiresAt, account.balance, account.balanceAt);
  }

  // ---------- loskoppelen ----------

  /**
   * Wist beide credentials uit de veilige opslag én alle Ponto-feedkoppelingen (regel 8).
   * Raakt nooit banktransacties of bankrekeningen aan.
   */
  remove(): void {
    const blocked = this.blocked();
    if (blocked !== null) throw new ValidationError(blocked);
    tx(this.db, () => {
      this.db.prepare('DELETE FROM bank_feed_accounts WHERE provider = \'ponto\'').run();
      this.secrets.delete(BANK_FEED_SECRET_KEYS.clientId);
      this.secrets.delete(BANK_FEED_SECRET_KEYS.clientSecret);
    });
    this.lastTest = null;
  }
}
