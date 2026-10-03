import { isIP } from 'node:net';
import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { Cents } from '../shared/money';
import { addDays, toSqliteUtc, type IsoDate } from '../shared/dates';
import { normalizeIban, ValidationError } from '../shared/validation';
import { BANK_FEED, BANK_FEED_SECRET_KEYS } from '../shared/bank-feed';
import type { FetchLike, SecretStore } from '../integrations/types';
import { PontoClient, PontoError, type PontoAccount, type PontoCredentials, type PontoRead } from '../integrations/ponto';
import type { SettingsService } from '../settings/settings';
import type { BankService } from '../import/bank';
import type { ParseResult } from '../import/types';

/**
 * BankFeedService (WP4A, #246): de basis van de Ponto-bankfeed — veilige credentials, status,
 * verbinding testen, rekeningkeuzes bewaren/verwijderen en één gedeelde single-flight-lock.
 * Sinds WP4B (#253) voert dezelfde service ook de financiële ophaalronde uit: bewezen
 * transactiedekking via `BankService.import` en de conservatieve saldocontrole. Er wordt nooit
 * een echte netwerkaanroep gedaan door deze service zelf: de client wordt van buiten
 * aangeleverd (in productie een echte `PontoClient`, in tests een nep).
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
 * - `saveLinks` valideert alle Ponto-id's tegen het laatste geslaagde testresultaat in
 *   dezelfde service-instantie; onbekende of dubbele id's worden geweigerd;
 * - `remove()` wist beide credentials en alle feedkoppelingen, maar nooit banktransacties
 *   of bankrekeningen;
 * - één service-brede lock die opslaan + eerste ronde (#253), ophalen en later #247
 *   door dezelfde poort laten lopen;
 * - guards: vlag uit, read-only, kantoorkopie, demo/outbound blocked en MCP mogen niet
 *   configureren of netwerk gebruiken.
 *
 * Bindende regels uit #253 (ophaalronde): alleen `status = 'actief'` mét bankrekening wordt
 * opgehaald; `readonly` wordt overgeslagen zonder iets te overschrijven; ontbrekend of
 * deprecated wordt `weg` met foutsoort `account-gone`; dekking gaat alleen vooruit na een
 * volledige ronde met geslaagde transactiesynchronisatie; het terugleesvenster is
 * uitsluitend `max(link_from, covered_to - 7 dagen)`; fouten gelden per rekening en stoppen
 * de rest van de ronde niet; er worden nooit credentials, tokens, ruwe responses of IP's
 * bewaard; `autoProcess()` wordt hier niet aangeroepen.
 *
 * Bindende regels uit #247 (handmatig "Nu bijwerken"): uitsluitend door een expliciete
 * aanroep, nooit timer of achtergrond; dezelfde service-brede lock, zonder geneste
 * `exclusive()`/`round()`-aanroepen; binnen 30 minuten sinds een werkelijk gestarte handmatige
 * synchronisatie geen enkele netwerkaanroep, dus ook geen Cloudflare-trace; het publieke IP
 * wordt precies één keer per toegestane klik opgevraagd, uitsluitend uit `ip=` van de trace
 * gelezen, met `node:net.isIP` gevalideerd en nooit bewaard, gelogd of teruggegeven;
 * `accountTransactions` en `accountDetails` starten onafhankelijk en worden per subtype
 * gepolld (elke drie seconden, maximaal twee minuten, nooit automatische retry; een 429 geldt
 * alleen voor het eigen subtype); `manual_sync_at` wordt pas gezet zodra minstens één
 * synchronisatie werkelijk is gestart; na afloop leest precies één gerichte ronde de
 * transacties opnieuw en schuift alléén transactieresponsmetadata de dekking op; mislukte
 * accountDetails betekent: transacties wél importeren, maar geen nieuwe saldovergelijking in
 * die ronde; fouten en time-outs zijn gewone, veilige tekst/status, nooit een ruwe
 * providerresponse, token, credential of IP.
 */
// ---------- types (contract #246 en #253) ----------

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

/**
 * Het resultaat van één ophaalronde (#253), minimaal en zonder geheimen of ruwe providerdata:
 * per behandelde koppeling hoeveel transacties werkelijk nieuw zijn geïmporteerd, welke
 * koppelingen zijn overgeslagen (readonly) en welke mislukten — uitsluitend met de
 * afgesproken foutsoort. Een fout bij één rekening stopt de rest van de ronde niet; dat is
 * aan deze lijsten te zien.
 */
export interface RoundSummary {
  /** de behandelde actieve koppelingen, met het aantal werkelijk nieuw geïmporteerde transacties */
  accounts: { pontoId: string; bankAccountId: number; imported: number }[];
  /** de koppelingen die deze ronde zijn overgeslagen omdat de bank ze tijdelijk readonly gaf */
  skipped: { pontoId: string }[];
  /** de koppelingen die mislukten of wegvielen, uitsluitend met de afgesproken foutsoort */
  failed: { pontoId: string; errorKind: string }[];
  /** of er in deze ronde minstens één nieuwe transactie is geïmporteerd */
  importedAny: boolean;
}

/**
 * De clientmogelijkheden die de service gebruikt (#246/#253/#247). De synchronisatiemethoden
 * bestaan sinds WP2 en zijn nodig voor het handmatig bijwerken; een client zonder die methoden
 * kan alleen de bestaande basis en de ronde (#253).
 */
export type BankFeedClient = Pick<PontoClient, 'accounts' | 'transactions'> &
  Partial<Pick<PontoClient, 'startSynchronization' | 'synchronization'>>;

// ---------- handmatig bijwerken (#247): constanten ----------

/** Binnen dit venster na een werkelijk gestarte handmatige synchronisatie: geen enkel netwerkverzoek. */
const MANUAL_SYNC_WINDOW_MS = 30 * 60_000;
/** Pollinterval voor handmatig gestarte synchronisaties (#247). */
const MANUAL_SYNC_POLL_MS = 3_000;
/** Maximale pollduur per gestarte synchronisatie (#247). */
const MANUAL_SYNC_POLL_MAX_MS = 2 * 60_000;
/** Maximale wachttijd op de Cloudflare-trace, zodat de service-lock nooit onbeperkt vaststaat. */
const CLOUDFLARE_TRACE_TIMEOUT_MS = 30_000;
/** Het enige toegestane trace-adres voor het publieke IP (#247). */
const CLOUDFLARE_TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

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
  covered_to: string | null;
  link_from: string | null;
  expires_at: string | null;
  balance: number | null;
  balance_at: string | null;
  balance_diff: number | null;
  balance_diff_rounds: number;
  gap_from: string | null;
  gap_to: string | null;
  last_round_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_error_kind: string | null;
  manual_sync_at: string | null;
}

export interface BankFeedDeps {
  db: Db;
  secrets: SecretStore;
  bank: BankService;
  settings: SettingsService;
  /** injecteerbare klok voor deterministische ronde-/fouttijdstippen */
  now?: () => Date;
  /** maakt de client voor één netwerkaanroep; in productie de echte, in tests een nep */
  client: (creds: PontoCredentials) => BankFeedClient;
  /**
   * fetch voor het eenmalig opvragen van het publieke IP bij Cloudflare (#247); nooit voor
   * iets anders. Standaard een functie die weigert, zodat een omgeving zonder netwerkbasis
   * geen trace kan doen.
   */
  fetch?: FetchLike;
  /**
   * Wachttijd tussen pollrondes voor handmatige synchronisaties (#247). Standaard echt
   * wachten; in tests geïnjecteerd zodat er nooit echt geslapen wordt.
   */
  wait?: (ms: number) => Promise<void>;
}

export class BankFeedService {
  private readonly db: Db;
  private readonly secrets: SecretStore;
  private readonly bank: BankService;
  private readonly settings: SettingsService;
  private readonly now: () => Date;
  private readonly makeClient: (creds: PontoCredentials) => BankFeedClient;
  /** Alleen voor de eenmalige Cloudflare-trace (#247); nooit voor Ponto-verkeer. */
  private readonly traceFetch: FetchLike;
  /** Wachttijd tussen pollrondes; in productie echt, in tests geïnjecteerd (#247). */
  private readonly wait: (ms: number) => Promise<void>;
  /**
   * Het laatste expliciete testresultaat van deze service-instantie; alleen hiertegen zijn
   * Ponto-id's in `saveLinks` te valideren (regel 7). Expliciet: pas na een geslaagde `test()`.
   */
  private lastTest: { accounts: PontoAccount[]; creds: PontoCredentials } | null = null;
  /** Alleen de laatst gestarte verbindingstest mag het bewaarbare resultaat opleveren. */
  private testGeneration = 0;
  /** Eén gedeelde single-flight-lock (regel 9); opslaan + eerste ronde (#253) lopen hierdoorheen. */
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * De op dit moment in-flight ronde (#253), of null. Twee overlappende gewone `round()`-
   * aanroepen delen deze ene uitvoering: er draaien nooit twee netwerk-/importrondes
   * tegelijk. De teller wordt vóór het afruimen van de lock gewist, zodat een volgende
   * taak in de lock nooit een al afgeronde ronde per ongeluk "meepakt".
   */
  private inFlight: Promise<RoundSummary> | null = null;

  constructor(deps: BankFeedDeps) {
    this.db = deps.db;
    this.secrets = deps.secrets;
    this.bank = deps.bank;
    this.settings = deps.settings;
    this.now = deps.now ?? (() => new Date());
    this.makeClient = deps.client;
    this.traceFetch = deps.fetch ?? (async () => { throw new Error('Deze omgeving heeft geen netwerkbasis voor het publieke IP-adres.'); });
    this.wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  }

  // ---------- lock (regel 9) ----------

  /**
   * Voert één asynchrone taak uit in de service-brede lock: twee gelijktijdige aanroepen
   * lopen nooit door elkaar, de tweede begint pas als de eerste klaar is (ook bij een fout).
   * #253: opslaan + eerste ronde lopen als één handeling hierdoorheen.
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
      // zonder leesbare credential is er ook geen betrouwbaar laatste-vier-venster (regel 4)
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
    const generation = ++this.testGeneration;
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
    if (generation !== this.testGeneration) {
      throw new ValidationError('Er is inmiddels een nieuwere verbindingstest gestart; gebruik daarvan het resultaat.');
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
      // completeTo is de koppeling incompleet; een afschrift/openingssaldo blijft nodig
      // (#253 sluit pas aan op bewezen dekking)
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

  /**
   * De definitieve opslag (#253): bewaart via de bestaande servicebasis en voert daarna
   * precies één ronde uit, als één atomische servicehandeling door dezelfde lock — zonder
   * geneste `exclusive()`-aanroepen en dus zonder deadlock. `saveLinks` is synchroon en kan
   * daarom veilig binnen de gehouden lock draaien.
   */
  async save(creds: PontoCredentials | null, links: FeedLink[]): Promise<RoundSummary> {
    const run = this.exclusive(async () => {
      this.saveLinks(creds, links);
      return this.roundLocked();
    });
    // Een gewone round() die tijdens opslaan binnenkomt, hoort bij deze verplichte eerste
    // ronde aan te sluiten. Anders zou hij achter `save()` in dezelfde queue belanden en
    // direct daarna een tweede netwerk-/importronde uitvoeren.
    return this.trackInFlight(run);
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

  // ---------- handmatig bijwerken (#247) ----------

  /**
   * Het door de gebruiker gestarte "Nu bijwerken" voor één koppeling, uitsluitend door een
   * expliciete aanroep en altijd door dezelfde service-brede lock als round()/save() (#247).
   * Binnen 30 minuten sinds een werkelijk gestarte handmatige synchronisatie gebeurt er
   * helemáál geen netwerk — geen trace, geen synchronisatie, geen ronde — en volgt
   * `allowed: false` met het moment waarop weer mag. Bij een toegestane klik wordt het
   * publieke IP precies één keer opgevraagd (Cloudflare-trace, uitsluitend `ip=`, gevalideerd
   * met `node:net.isIP`, nergens bewaard), starten `accountTransactions` en `accountDetails`
   * onafhankelijk, wordt ieder gestart id gepolld (drie seconden interval, maximaal twee
   * minuten, zonder automatische retry) en leest daarna precies één gerichte ronde de
   * transacties opnieuw. Mislukte accountDetails betekent: transacties wél importeren, maar
   * geen nieuwe saldovergelijking in die ronde.
   */
  async refreshNow(feedAccountId: number): Promise<{ allowed: true; summary: RoundSummary } | { allowed: false; allowedAt: string }> {
    return this.exclusive(() => this.refreshNowLocked(feedAccountId));
  }

  /** De uitvoering van refreshNow binnen de gehouden lock; gebruikt nooit de publieke round(). */
  private async refreshNowLocked(feedAccountId: number): Promise<{ allowed: true; summary: RoundSummary } | { allowed: false; allowedAt: string }> {
    const blocked = this.blocked();
    if (blocked !== null) throw new ValidationError(blocked);
    if (!Number.isInteger(feedAccountId)) throw new ValidationError('Onbekende bankkoppeling; ververs het scherm en probeer het opnieuw.');
    const row = this.db
      .prepare('SELECT * FROM bank_feed_accounts WHERE id = ? AND provider = \'ponto\'')
      .get(feedAccountId) as FeedRow | undefined;
    if (row === undefined || row.status !== 'actief' || row.bank_account_id === null) {
      throw new ValidationError('Deze bankkoppeling is niet actief; koppel de rekening eerst via de instellingen.');
    }
    // Het venster telt sinds een werkelijk gestarte handmatige synchronisatie (#247): eerst het
    // venster, daarna pas — en alléén bij een toegestane klik — enige netwerkaanroep.
    const lastManualMs = parseMoment(row.manual_sync_at);
    const nowMs = this.now().getTime();
    if (lastManualMs !== null && nowMs - lastManualMs < MANUAL_SYNC_WINDOW_MS) {
      return { allowed: false, allowedAt: new Date(lastManualMs + MANUAL_SYNC_WINDOW_MS).toISOString() };
    }
    const creds = this.readCredentials();
    if (creds === null) throw new ValidationError('Er staan nog geen werkende inloggegevens in de veilige opslag; test eerst de verbinding.');
    const client = this.makeClient(creds);
    // aanroepen gebeuren als methode op de client: de echte client gebruikt `this`
    if (typeof client.startSynchronization !== 'function' || typeof client.synchronization !== 'function') {
      throw new ValidationError('Handmatig bijwerken is in deze omgeving niet beschikbaar.');
    }
    // Precies één trace per toegestane klik; het IP bestaat uitsluitend hier in geheugen.
    const customerIp = await this.publicIp();
    // Twee volstrekt onafhankelijke starts (#247): een fout bij de ene laat de andere onverlet.
    const [txStart, detailsStart] = await Promise.allSettled([
      client.startSynchronization!(row.external_id, 'accountTransactions', customerIp),
      client.startSynchronization!(row.external_id, 'accountDetails', customerIp),
    ]);
    const txRun = this.startOutcome(txStart);
    const detailsRun = this.startOutcome(detailsStart);
    if (txRun.started || detailsRun.started) {
      // pas zodra minstens één synchronisatie werkelijk is gestart (#247)
      this.db.prepare('UPDATE bank_feed_accounts SET manual_sync_at = ? WHERE id = ?').run(this.sqliteNow(), row.id);
    }
    if (!txRun.started) this.markError(row.id, txRun.errorKind);
    if (!detailsRun.started) this.markError(row.id, detailsRun.errorKind);
    // Ieder gestart id onafhankelijk gepolld; een 429, fout of time-out geldt alleen voor het
    // eigen subtype, zonder automatische retry (#247).
    const [txErrorKind, detailsErrorKind] = await Promise.all([
      txRun.started ? this.pollSynchronization(client, txRun.id) : Promise.resolve(null),
      detailsRun.started ? this.pollSynchronization(client, detailsRun.id) : Promise.resolve(null),
    ]);
    if (txErrorKind !== null) this.markError(row.id, txErrorKind);
    if (detailsErrorKind !== null) this.markError(row.id, detailsErrorKind);
    // Na afloop precies één gerichte ronde (#253/#247); zonder geslaagde details-sync geen
    // nieuwe saldovergelijking in die ronde.
    const summary = await this.roundLocked(feedAccountId, { skipBalanceCheck: detailsErrorKind !== null || !detailsRun.started });
    // De twee starts blijven twee afzonderlijke resultaten (#247): een subtype dat niet
    // startte, faalde of time-out liep, staat als veilige foutsoort in de samenvatting —
    // naast een eventueel wél geslaagde andere subtype. Uitsluitend vaste foutsoorten,
    // nooit ruwe providerfouten.
    const txFailure = txRun.started ? txErrorKind : txRun.errorKind;
    const detailsFailure = detailsRun.started ? detailsErrorKind : detailsRun.errorKind;
    const firstFailure = [txFailure, detailsFailure].find((kind) => kind !== null);
    if (firstFailure !== undefined && !summary.failed.some((f) => f.pontoId === row.external_id)) {
      summary.failed.push({ pontoId: row.external_id, errorKind: firstFailure });
      // Een volledige transactieronde wist terecht eerdere rondefouten, maar mag een zojuist
      // mislukte handmatige subsynchronisatie niet maskeren in de blijvende feedstatus.
      this.markError(row.id, firstFailure);
    }
    return { allowed: true, summary };
  }

  /** Uitkomst van één startpoging, uitsluitend met de veilige foutsoort. */
  private startOutcome(result: PromiseSettledResult<{ id: string }>): SubtypeRun {
    if (result.status === 'fulfilled') return { started: true, id: result.value.id };
    return { started: false, errorKind: this.errorKind(result.reason) };
  }

  /**
   * Pollt één gestarte synchronisatie elke drie seconden tot success/error, maximaal twee
   * minuten (#247). Geeft de veilige foutsoort terug bij een pollfout, time-out of foutstatus,
   * en null bij succes — nooit ruwe providerfouten en nooit een automatische retry.
   */
  private async pollSynchronization(client: BankFeedClient, id: string): Promise<string | null> {
    const deadline = this.now().getTime() + MANUAL_SYNC_POLL_MAX_MS;
    for (;;) {
      if (this.now().getTime() >= deadline) return 'timeout';
      let status: 'pending' | 'running' | 'success' | 'error';
      try {
        status = (await client.synchronization!(id)).status;
      } catch (e) {
        return this.errorKind(e);
      }
      if (status === 'success') return null;
      if (status === 'error') return 'synchronization-error';
      const remaining = deadline - this.now().getTime();
      if (remaining <= 0) return 'timeout';
      await this.wait(Math.min(MANUAL_SYNC_POLL_MS, remaining));
    }
  }

  /**
   * Vraagt het publieke IP precies éénmaal op bij Cloudflare (#247), leest uitsluitend de
   * `ip=`-regel en valideert haar met `node:net.isIP`. Geen fallback, geen verzonnen adres en
   * het IP wordt nooit bewaard, gelogd of teruggegeven.
   */
  private async publicIp(): Promise<string> {
    let text: string;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLOUDFLARE_TRACE_TIMEOUT_MS);
    try {
      const response = await this.traceFetch(CLOUDFLARE_TRACE_URL, { method: 'GET', signal: controller.signal });
      if (!response.ok) throw new Error('trace mislukt');
      text = await response.text();
    } catch {
      throw new ValidationError('Het publieke IP-adres kon nu niet worden bepaald; het handmatig bijwerken is niet gestart. Probeer het later opnieuw.');
    } finally {
      clearTimeout(timer);
    }
    const ip = traceIp(text);
    if (ip === null) {
      throw new ValidationError('Het publieke IP-adres kon nu niet worden bepaald; het handmatig bijwerken is niet gestart. Probeer het later opnieuw.');
    }
    return ip;
  }

  // ---------- ophaalronde (#253) ----------

  /**
   * Eén volledige ophaalronde over alle actief gekoppelde rekeningen, in de service-brede
   * lock. Twee overlappende gewone aanroepen delen aantoonbaar dezelfde in-flight
   * uitvoering: er draaien nooit twee netwerk-/importrondes tegelijk. Een optioneel
   * `accountId` beperkt de ronde tot die ene feedkoppeling (een dergelijke ronde wordt niet
   * gedeeld, maar loopt wel door dezelfde lock).
   */
  round(accountId?: number): Promise<RoundSummary> {
    // meelopen op de ronde die al draait (#253): nooit twee rondes naast elkaar
    if (accountId === undefined && this.inFlight !== null) return this.inFlight;
    const run = this.exclusive(() => this.roundLocked(accountId));
    if (accountId !== undefined) return run;
    // registreer de in-flight ronde vóór de eerste await: een tweede, overlappende
    // aanroep sluit nog vóórdat de lock draait aan op dezelfde uitvoering
    return this.trackInFlight(run);
  }

  /** Publiceert één reeds ingeplande volledige ronde als de gedeelde in-flight uitvoering. */
  private trackInFlight(run: Promise<RoundSummary>): Promise<RoundSummary> {
    const settled = run.then(
      (v) => {
        if (this.inFlight === settled) this.inFlight = null;
        return v;
      },
      (e) => {
        if (this.inFlight === settled) this.inFlight = null;
        throw e;
      },
    );
    this.inFlight = settled;
    return settled;
  }

  /**
   * De ronde zelf, binnen de gehouden lock. Haalt aan het begin eenmaal de actuele
   * Ponto-accountlijst op en verwerkt daarna fouten per gekoppelde rekening, zonder de
   * overige rekeningen te blokkeren (#253). Neemt aan dat de lock al gehouden wordt.
   */
  private async roundLocked(accountId?: number, opts?: { skipBalanceCheck?: boolean }): Promise<RoundSummary> {
    const blocked = this.blocked();
    if (blocked !== null) throw new ValidationError(blocked);
    const creds = this.readCredentials();
    if (creds === null) throw new ValidationError('Er staan nog geen werkende inloggegevens in de veilige opslag; test eerst de verbinding.');
    const summary: RoundSummary = { accounts: [], skipped: [], failed: [], importedAny: false };
    // uitsluitend actieve koppelingen mét bankrekening worden opgehaald (#246/#253):
    // een link met `bankAccountId: null` blijft `niet-gebruiken` en wordt nooit geactiveerd
    const rows = (this.db
      .prepare('SELECT * FROM bank_feed_accounts WHERE provider = \'ponto\' ORDER BY id')
      .all() as FeedRow[])
      .filter((row) => accountId === undefined || row.id === accountId)
      .filter((row) => row.status === 'actief' && row.bank_account_id !== null);
    if (rows.length === 0) return summary; // niets te halen: ook geen netwerkaanroep
    const client = this.makeClient(creds);
    // éénmaal aan het begin van de ronde de actuele accountlijst; lukt dat niet, dan
    // mislukt de ronde voor alle koppelingen met dezelfde foutsoort — zonder ruwe
    // respons of credentials te bewaren
    let found: PontoAccount[];
    try {
      found = (await client.accounts()).accounts;
    } catch (e) {
      const kind = this.errorKind(e);
      for (const row of rows) {
        this.markError(row.id, kind);
        summary.failed.push({ pontoId: row.external_id, errorKind: kind });
      }
      return summary;
    }
    const byId = new Map(found.map((a) => [a.id, a]));
    for (const row of rows) {
      const bankAccountId = row.bank_account_id!;
      try {
        const account = byId.get(row.external_id);
        if (account === undefined || account.deprecated) {
          // ontbrekend, niet meer geselecteerd of deprecated: `weg` + `account-gone` (#253)
          this.markGone(row.id);
          summary.failed.push({ pontoId: row.external_id, errorKind: 'account-gone' });
          continue;
        }
        if ((account.availability ?? '').toLowerCase() === 'readonly') {
          // tijdelijk alleen-lezen bij de bank: overslaan zonder ook maar iets te overschrijven (#184)
          summary.skipped.push({ pontoId: row.external_id });
          continue;
        }
        const imported = await this.roundAccount(row, account, client, opts);
        summary.accounts.push({ pontoId: row.external_id, bankAccountId, imported });
        if (imported > 0) summary.importedAny = true;
      } catch (e) {
        // een fout bij één rekening stopt de rekeningen erna niet (#253); uitsluitend de
        // afgesproken foutsoort wordt bewaard, nooit ruwe respons, tokens of IP's
        const kind = this.errorKind(e);
        this.markError(row.id, kind);
        summary.failed.push({ pontoId: row.external_id, errorKind: kind });
      }
    }
    return summary;
  }

  /**
   * De transactieronde voor één actieve koppeling, met bewezen dekking en saldo (#253).
   * Neemt aan dat de accountlijst al gelezen is en de rekening niet weg of readonly is.
   */
  private async roundAccount(row: FeedRow, account: PontoAccount, client: Pick<PontoClient, 'transactions'>, opts?: { skipBalanceCheck?: boolean }): Promise<number> {
    const bankAccountId = row.bank_account_id!;
    // bewezen grens: de dekking die de feed al bewees (covered_to) of die van een bestaand
    // afschrift van de gebruiker — hier sluit de ronde gatloos op aan. De eerste
    // transactiedatum bewijst nooit begindekking (#253).
    const provenTo = laterDate(row.covered_to, this.bankCompleteTo(bankAccountId));
    // terugleesvenster uitsluitend max(link_from, covered_to - 7 dagen) wanneer die bewezen
    // grenzen bestaan; zeven dagen is alleen voor dedup/wijzigingen, niet voor begindekking
    const window: string[] = [];
    if (row.link_from !== null) window.push(row.link_from);
    if (provenTo !== null) window.push(addDays(provenTo, -7));
    const sinceDate = window.length === 0 ? undefined : window.reduce((a, b) => (a >= b ? a : b));
    const read = await client.transactions(row.external_id, { sinceDate });
    const syncUtc = sqliteUtcOrNull(read.synchronizedAt);
    const syncMs = parseMoment(read.synchronizedAt);
    const storedSyncMs = parseMoment(row.transactions_synchronized_at);
    // Bruikbare metadata: alle cursorpagina's volledig gelezen, de laatste synchronisatie
    // geslaagd en `synchronizedAt` bruikbaar (#253).
    const provable = read.complete
      && read.latestSynchronization !== null
      && read.latestSynchronization.status === 'success'
      && syncUtc !== null;
    // Dekking mag alleen vooruit wanneer de metadata bruikbaar is én het
    // transactiesynchronisatietijdstip nieuwer is dan het opgeslagen tijdstip.
    const forwarded = provable && (storedSyncMs === null || syncMs! > storedSyncMs);
    // Importeren via de bestaande BankService.import met bron `openbanking` en de expliciete
    // rekening. `importedAt` komt uitsluitend uit `PontoRead.synchronizedAt` (nooit uit
    // `detailsSynchronizedAt`, #253). Veilige transacties uit een onvolledige of
    // metadata-onbruikbare response mogen ook zonder dekking worden geïmporteerd — dan
    // uitsluitend zonder `period`, zodat `covered_to` en het synchronisatietijdstip niet
    // vooruit gaan. Het bestaande conservatieve dubbelpad (#184/#224/#225) blijft staan:
    // dezelfde Ponto-id met veranderde inhoud wordt niet stil overschreven.
    const options: { bankAccountId: number; importedAt?: string; period?: { from: IsoDate; to: IsoDate } } = { bankAccountId };
    if (syncUtc !== null) options.importedAt = syncUtc;
    if (forwarded && provenTo !== null) {
      // aansluiten zonder gat op de bewezen grens (#253): de volledige leesronde bewees álles
      // sinds het venster, dus de dagen na de bewezen grens zijn gedekt — ook als de rekening
      // stil was. Een nieuwe rekening zonder bewezen grens blijft expliciet incompleet: geen
      // periode, geen covered_to.
      const from = addDays(provenTo, 1);
      const to = syncUtc!.slice(0, 10);
      if (from <= to) options.period = { from, to };
    }
    // `BankService.import` leidt zonder expliciete `period` voor gewone afschriften alsnog
    // een periode af uit de eerste/laatste transactie. Voor Ponto mag dat juist nooit: een
    // transactie bewijst geen stille dagen en een onvolledige lezing mag `completeTo` niet
    // opschuiven. Verwijder daarom die afgeleide statistiek atomair wanneer deze ronde geen
    // bewezen periode levert; de veilige transacties en hun importbatch blijven bestaan.
    const result = tx(this.db, () => {
      const imported = this.bank.import({ source: 'openbanking', warnings: [], transactions: read.transactions } satisfies ParseResult, options);
      if (options.period === undefined) {
        this.db.prepare('DELETE FROM import_batch_accounts WHERE batch_id = ? AND bank_account_id = ?').run(imported.batchId, bankAccountId);
      }
      return imported;
    });
    if (forwarded) {
      // het nieuwe, nieuwere transactiesynchronisatietijdstip wordt vastgelegd; covered_to
      // schuift alleen mee als er een bewezen grens was om op aan te sluiten (#253: dekking
      // mag alleen vooruit met een bewezen aansluiting — de dag zelf telt pas bij een
      // latere ronde, zoals de bestaande importadministratie dat ook begrenst)
      const covered = addDays(syncUtc!.slice(0, 10), -1);
      if (provenTo !== null) {
        this.db
          .prepare('UPDATE bank_feed_accounts SET transactions_synchronized_at = ?, covered_to = ? WHERE id = ?')
          .run(read.synchronizedAt, laterDate(row.covered_to, covered), row.id);
      } else {
        this.db
          .prepare('UPDATE bank_feed_accounts SET transactions_synchronized_at = ? WHERE id = ?')
          .run(read.synchronizedAt, row.id);
      }
    }
    // Rekeningdetails en saldo apart, strikt gescheiden van de transactiesynchronisatie
    // (#253): alleen bijwerken als Ponto nieuwere details geeft; bekende waarden blijven staan.
    const detailsMs = parseMoment(account.detailsSynchronizedAt);
    const storedDetailsMs = parseMoment(row.details_synchronized_at);
    if (detailsMs !== null && (storedDetailsMs === null || detailsMs > storedDetailsMs)) {
      this.db
        .prepare('UPDATE bank_feed_accounts SET details_synchronized_at = ?, balance = COALESCE(?, balance), balance_at = COALESCE(?, balance_at) WHERE id = ?')
        .run(account.detailsSynchronizedAt, account.balance, account.balanceAt, row.id);
    }
    // Bij een handmatige ronde zonder geslaagde accountDetails (#247) wordt géén nieuwe
    // saldovergelijking gedaan en ook de teller niet aangeraakt: het saldo van Ponto kan dan
    // ouder zijn dan de net geïmporteerde transacties.
    const skipBalance = opts?.skipBalanceCheck === true;
    if (provable) {
      // de ronde op deze rekening is volledig en geslaagd: pas dáár hoort `last_ok_at` bij
      // (niet door testen of alleen opslaan, #246)
      const now = this.sqliteNow();
      this.db
        .prepare('UPDATE bank_feed_accounts SET last_ok_at = ?, last_error = NULL, last_error_kind = NULL, last_round_at = ? WHERE id = ?')
        .run(now, now, row.id);
      // Dezelfde provider-snapshot opnieuw lezen is geen tweede onafhankelijke bevestiging
      // van een saldoafwijking. Vergelijk alleen wanneer het transactiesynchronisatiemoment
      // werkelijk vooruitging; een identieke snapshot behoudt de bestaande teller.
      if (forwarded) {
        if (!skipBalance) this.compareBalance(row.id, bankAccountId, account, read, result.batchId);
      } else if (!skipBalance && !this.balanceMetadataComparable(account, read)) {
        this.resetBalanceDiff(row.id);
      }
    } else {
      if (!skipBalance) this.resetBalanceDiff(row.id);
      // niet-vergelijkbare ronde (onvolledige paginering of onbruikbare metadata): de
      // saldoafwijkingsteller conservatief resetten (#253)
      this.db.prepare('UPDATE bank_feed_accounts SET last_round_at = ? WHERE id = ?').run(this.sqliteNow(), row.id);
    }
    return result.imported;
  }

  /** De actuele bewezen `completeTo` volgens de bestaande centrale importstatus (#226). */
  private bankCompleteTo(bankAccountId: number): string | null {
    // `importStatus()` is de ene bestaande bron van waarheid voor bewezen dekking. Die
    // verwerkt ook een nog open gedeeltelijke dag/gat en handmatige dekking. Een lokale
    // MAX-query zou zo'n ouder gat kunnen overslaan en de feed te laat laten aansluiten.
    return this.bank.importStatus().find((status) => status.bankAccountId === bankAccountId)?.completeTo ?? null;
  }

  /**
   * De saldocontrole van deze ronde (#253): het verschil tussen het saldo volgens Ponto en
   * het saldo van de app op hetzelfde referentiemoment. Alleen geldig na een volledige
   * transactieronde (de aanroeper garandeert dat) én wanneer saldo- en
   * transactiemetadata aantoonbaar hetzelfde vergelijkbare referentiemoment vertegenwoordigen.
   * Zonder geboekt beginsaldo is er niets te vergelijken; `closing_balance` wordt nooit
   * geschreven en `balanceCheck()` zelf wordt niet aangeraakt.
   */
  private compareBalance(feedRowId: number, bankAccountId: number, account: PontoAccount, read: PontoRead, batchId: number): void {
    const balanceDay = sqliteUtcOrNull(account.balanceAt);
    if (account.balance === null || !this.balanceMetadataComparable(account, read) || balanceDay === null) {
      this.resetBalanceDiff(feedRowId);
      return;
    }
    const booked = this.bank.openingBalance(bankAccountId);
    if (booked.date === null) {
      // zonder geboekt beginsaldo is er geen saldocontrole (#253)
      this.resetBalanceDiff(feedRowId);
      return;
    }
    // Gebruik voor dubbelen uit deze Ponto-import de datum die Ponto zelf meegaf. Een al
    // bestaande afschriftregel kan enkele werkdagen verschoven zijn; rond de saldogrens zou
    // zijn oude datum anders een vals verschil veroorzaken. Dit is hetzelfde conservatieve
    // dubbelpad als `BankService.balanceCheck()` gebruikt voor een specifieke importbatch.
    const sum = (this.db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS s FROM (
           SELECT t.amount, COALESCE(
             (SELECT MIN(k.transaction_date) FROM import_skipped k WHERE k.matched_transaction_id = t.id AND k.batch_id = ? AND k.added_transaction_id IS NULL),
             (SELECT MIN(d.transaction_date) FROM bank_transactions d WHERE d.duplicate_of = t.id AND d.import_batch_id = ?),
             t.transaction_date) AS date
           FROM bank_transactions t WHERE t.bank_account_id = ? AND t.duplicate_of IS NULL)
         WHERE date >= ? AND date <= ?`,
      )
      .get(batchId, batchId, bankAccountId, booked.date, balanceDay.slice(0, 10)) as { s: number }).s;
    this.recordBalanceDiff(feedRowId, (account.balance - (booked.amount + sum)) as Cents);
  }

  /** Saldo en transacties beschrijven aantoonbaar exact hetzelfde provider-moment. */
  private balanceMetadataComparable(account: PontoAccount, read: PontoRead): boolean {
    const balanceMs = parseMoment(account.balanceAt);
    const syncMs = parseMoment(read.synchronizedAt);
    return account.balance !== null && balanceMs !== null && syncMs !== null && balanceMs === syncMs;
  }

  /**
   * Legt de saldoafwijking van één vergelijkbare volledige ronde vast (#253): één
   * vergelijkbare ronde met een niet-nulverschil levert `rounds: 1`; pas dezelfde niet-nul-
   * afwijking in een tweede vergelijkbare volledige ronde levert `rounds: 2`. Een ander
   * verschil of een nulverschil reset de teller conservatief.
   */
  private recordBalanceDiff(feedRowId: number, difference: Cents): void {
    const row = this.db
      .prepare('SELECT balance_diff, balance_diff_rounds FROM bank_feed_accounts WHERE id = ?')
      .get(feedRowId) as { balance_diff: number | null; balance_diff_rounds: number } | undefined;
    if (row === undefined) return;
    if (difference === 0) {
      if (row.balance_diff !== 0 || row.balance_diff_rounds !== 0) {
        this.db.prepare('UPDATE bank_feed_accounts SET balance_diff = 0, balance_diff_rounds = 0 WHERE id = ?').run(feedRowId);
      }
      return;
    }
    if (row.balance_diff === difference && row.balance_diff_rounds > 0) {
      this.db
        .prepare('UPDATE bank_feed_accounts SET balance_diff = ?, balance_diff_rounds = ? WHERE id = ?')
        .run(difference, row.balance_diff_rounds + 1, feedRowId);
      return;
    }
    this.db.prepare('UPDATE bank_feed_accounts SET balance_diff = ?, balance_diff_rounds = 1 WHERE id = ?').run(difference, feedRowId);
  }

  /** Een niet-vergelijkbare ronde maakt een oude afwijking onbruikbaar: conservatief resetten. */
  private resetBalanceDiff(feedRowId: number): void {
    this.db.prepare('UPDATE bank_feed_accounts SET balance_diff = NULL, balance_diff_rounds = 0 WHERE id = ?').run(feedRowId);
  }

  /**
   * De saldocontrole zoals #249 die leest: het huidige verschil en hoeveel vergelijkbare
   * volledige rondes dezelfde niet-nulafwijking al achter elkaar zagen. Zonder geboekt
   * beginsaldo, zonder saldo of zonder transactiemetadata is er niets geldigs te melden
   * (null). Leest uitsluitend; het schrijven gebeurt in de ronde zelf.
   */
  balanceDifference(feedAccountId: number): { difference: Cents; rounds: number } | null {
    const row = this.db
      .prepare('SELECT * FROM bank_feed_accounts WHERE id = ? AND provider = \'ponto\'')
      .get(feedAccountId) as FeedRow | undefined;
    if (row === undefined || row.bank_account_id === null) return null;
    if (row.balance === null || row.balance_at === null || row.transactions_synchronized_at === null) return null;
    // zonder geboekt beginsaldo is balanceDifference null (#253)
    if (this.bank.openingBalance(row.bank_account_id).date === null) return null;
    // nog nooit vergelijkbaar vergeleken (of conservatief gereset): niets geldigs te melden
    if (row.balance_diff === null) return null;
    return { difference: row.balance_diff as Cents, rounds: row.balance_diff_rounds };
  }

  /** Actueel SQLite-UTC-moment, zoals de rest van de app het schrijft. */
  private sqliteNow(): string {
    return toSqliteUtc(this.now().toISOString());
  }

  /**
   * Zet een feedrij op `weg` met foutsoort `account-gone` (#253): de rekening bestaat niet
   * (meer) bij Ponto of is buiten gebruik. De rij zelf blijft bestaan; dekking, saldo en
   * eerdere gegevens worden niet gewist.
   */
  private markGone(feedRowId: number): void {
    this.db
      .prepare('UPDATE bank_feed_accounts SET status = \'weg\', last_error_kind = \'account-gone\', last_round_at = ? WHERE id = ?')
      .run(this.sqliteNow(), feedRowId);
  }

  /** Bewaar uitsluitend de afgesproken foutsoort, nooit ruwe respons of credentials (#253). */
  private markError(feedRowId: number, kind: string): void {
    this.db
      .prepare('UPDATE bank_feed_accounts SET last_error_kind = ?, last_round_at = ? WHERE id = ?')
      .run(kind, this.sqliteNow(), feedRowId);
  }

  /** Foutsoort van een Ponto- of netwerkfout, zonder foutteksten of geheimen. */
  private errorKind(e: unknown): string {
    if (e instanceof PontoError) return e.kind;
    if (e instanceof ValidationError) return 'geblokkeerd';
    return 'onbekend';
  }
}

// ---------- hulpjes (module-niveau, geen state) ----------

/** Het latere van twee kalenderdagen of null. */
function laterDate(a: IsoDate | null, b: IsoDate | null): IsoDate | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

/**
 * Milliseconden van een ISO-moment of SQLite-UTC-moment ("YYYY-MM-DD HH:MM:SS", altijd UTC),
 * of null bij onbruikbare invoer. Het SQLite-formaat wordt expliciet als UTC gelezen:
 * `Date.parse` zou het anders als lokale tijd lezen.
 */
function parseMoment(iso: string | null): number | null {
  if (iso === null) return null;
  const sqlite = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(iso.trim());
  if (sqlite) return Date.parse(`${sqlite[1]}-${sqlite[2]}-${sqlite[3]}T${sqlite[4]}:${sqlite[5]}:${sqlite[6]}Z`);
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** ISO-moment naar SQLite-UTC; null bij een formaat dat de app niet accepteert. */
function sqliteUtcOrNull(iso: string | null): string | null {
  if (iso === null) return null;
  try {
    return toSqliteUtc(iso);
  } catch {
    return null;
  }
}

/**
 * Uitkomst van één synchronisatiesubtype tijdens het handmatig bijwerken; bestaat uitsluitend
 * in geheugen tijdens de aanroep (#247), nooit op schijf.
 */
type SubtypeRun = { started: true; id: string } | { started: false; errorKind: string };

/**
 * Leest uitsluitend de eerste `ip=`-regel uit een Cloudflare-trace en valideert haar met
 * `node:net.isIP`; alles anders is null (#247). Het resultaat wordt nergens bewaard.
 */
function traceIp(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('ip=')) continue;
    const value = line.slice('ip='.length).trim();
    return isIP(value) !== 0 ? value : null;
  }
  return null;
}
