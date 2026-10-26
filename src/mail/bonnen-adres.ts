import type { Db } from '../db/database';
import type { SecretStore } from '../integrations/types';
import type { MailInSettings, SettingsService } from '../settings/settings';
import { BONNEN_CONSENT_VERSION } from '../shared/legal';

/**
 * Het bonnen-adres op post.boekhoudenvoorniks.nl (#450, stap 3): een eigen mailbox per administratie die
 * alleen kan ontvangen. Aanvragen, bevestigen en goedkeuren gebeuren op de licentieserver (niet in deze
 * repository); de app bewaart de machtiging van deze computer en het IMAP-wachtwoord versleuteld
 * met het sleutelbeheer van het systeem. In een back-up op een andere computer zijn die niet te
 * ontsleutelen: daar moet het adres eerst worden overgenomen (met een link naar het bevestigde adres).
 */

export const BONNEN_TOKEN_SECRET = 'bonnen:token';
export const BONNEN_PASSWORD_SECRET = 'bonnen:password';
const STATE_KEY = 'bonnenAdres';

/** Stand bij de server, plus wat de app zelf ziet. */
export type BonnenStatus =
  | 'geen'
  | 'onbevestigd'
  | 'overnemen'
  | 'wacht'
  | 'actief'
  | 'geweigerd'
  | 'vervallen'
  | 'gestopt'
  | 'verwijderd'
  /** deze computer heeft geen toegang meer (overgenomen op een andere computer of gestopt) */
  | 'ingetrokken'
  /** er loopt een aanvraag of adres, maar de machtiging is hier niet te lezen (back-up van een andere computer) */
  | 'andere-computer';

interface StoredState {
  status: Exclude<BonnenStatus, 'geen' | 'andere-computer'>;
  adres?: string;
  /** zoals de server het toont: p***@voorbeeld.nl */
  email: string;
  aangevraagd: string;
  toestemming: string;
  bijgewerkt: string;
}

export interface BonnenView {
  /** false: niet aan te vragen op deze computer of in deze administratie; `reden` zegt waarom */
  beschikbaar: boolean;
  reden: string | null;
  status: BonnenStatus;
  adres: string | null;
  email: string | null;
  aangevraagd: string | null;
  bijgewerkt: string | null;
  toestemmingVersie: string;
}

/** Wat naar de server gaat. Bij overnemen op een andere computer ontbreken kvk, namen en telefoon en staat `overnemen: true`. */
export interface BonnenAanmelding {
  administratie: string;
  email: string;
  bedrijfsnaam: string;
  kvk?: string;
  voornaam?: string;
  achternaam?: string;
  /** leeg ("") als de gebruiker het niet invult */
  telefoon?: string;
  toestemming: string;
  overnemen?: true;
}

/** Het aanvraagformulier. Met `overnemen` (stand 'andere-computer') worden kvk, namen en telefoon niet gevraagd en niet meegestuurd. */
export interface BonnenAanvraag {
  email: string;
  bedrijfsnaam: string;
  kvk?: string;
  voornaam?: string;
  achternaam?: string;
  telefoon?: string;
  toestemming: string;
  overnemen?: boolean;
}

/** De licentieserver; in main.ts met fetch, in de tests nagebootst. */
export interface BonnenServer {
  aanmelden(body: BonnenAanmelding, token: string | null): Promise<{ status: 'onbevestigd' | 'overnemen'; installatie: string; email: string }>;
  status(token: string): Promise<{ status: string; adres?: string }>;
  inloggegevens(token: string): Promise<{ adres: string; server: string; poort: number; gebruiker: string; wachtwoord: string }>;
  stoppen(token: string): Promise<{ ok: true; status: string }>;
}

/**
 * Fout van de server, met de HTTP-status (403 met `ingetrokken`: deze computer heeft geen toegang meer) en
 * eventueel een `code` van de server (bv. `app_bijwerken`). De melding is altijd de `fout` van de server.
 */
export class BonnenServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly ingetrokken = false,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** KvK-nummer: spaties weg, precies 8 cijfers. Null als het niet klopt (ook bij ruwe invoer langer dan 20 tekens). Gelijk aan de licentieserver. */
export function normalizeKvk(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 20) return null;
  const kvk = raw.replace(/\s/g, '');
  return /^\d{8}$/.test(kvk) ? kvk : null;
}

/**
 * Telefoonnummer in compacte vorm, of null. Spaties en streepjes vallen weg; daarna geldig als NL (0, dan 1-9,
 * samen 10 cijfers) of internationaal (+ of 00, landcode zonder 0 vooraan, 8 t/m 15 cijfers; 00 wordt +).
 * Begint het met 00, dan is het altijd internationaal. Ruwe invoer langer dan 50 tekens wordt geweigerd.
 * Gelijk aan de licentieserver.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 50) return null;
  const s = raw.replace(/[\s-]/g, '');
  if (s.startsWith('00') || s.startsWith('+')) {
    const intl = s.startsWith('00') ? `+${s.slice(2)}` : s;
    return /^\+[1-9]\d{7,14}$/.test(intl) ? intl : null;
  }
  return /^0[1-9]\d{8}$/.test(s) ? s : null;
}

/** Telefoon is optioneel: leeg is undefined, null of (tot 50 tekens) een string met alleen spaties en streepjes. Gelijk aan de licentieserver. */
export function isPhoneEmpty(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  return typeof raw === 'string' && raw.length <= 50 && raw.replace(/[\s-]/g, '') === '';
}

const KVK_VERPLICHT = 'Vul je KvK-nummer in (8 cijfers). Zonder KvK-nummer kunnen we je geen bonnen-adres geven. Heb je geen KvK-nummer? Mail dan naar stacy@shipdocs.app.';
const TELEFOON_ONGELDIG = 'Vul een geldig telefoonnummer in, bijvoorbeeld 06 12345678 of +32 470 12 34 56';

/** Voor- of achternaam: getrimd, verplicht, hooguit 100 tekens (langer wordt geweigerd, niet afgekapt). */
function naam(raw: unknown, label: 'voornaam' | 'achternaam'): string {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) throw new Error(`Vul je ${label} in`);
  if (v.length > 100) throw new Error(`Je ${label} is te lang (hooguit 100 tekens)`);
  return v;
}

const LIVE: StoredState['status'][] = ['onbevestigd', 'overnemen', 'wacht', 'actief'];
const KNOWN: StoredState['status'][] = ['onbevestigd', 'overnemen', 'wacht', 'actief', 'geweigerd', 'vervallen', 'gestopt', 'verwijderd', 'ingetrokken'];

export class BonnenAdresService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly secrets: SecretStore,
    private readonly server: BonnenServer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private stored(): StoredState | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(STATE_KEY) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as StoredState) : null;
  }

  private save(state: StoredState): void {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(STATE_KEY, JSON.stringify(state));
  }

  private update(patch: Partial<StoredState>): void {
    const cur = this.stored();
    if (cur) this.save({ ...cur, ...patch, bijgewerkt: this.now().toISOString() });
  }

  private token(): string | null {
    return this.secrets.available ? this.secrets.get(BONNEN_TOKEN_SECRET) : null;
  }

  private forget(): void {
    this.secrets.delete(BONNEN_TOKEN_SECRET);
    this.secrets.delete(BONNEN_PASSWORD_SECRET);
  }

  /** Waarom aanvragen hier niet kan, of null. */
  private blocked(): string | null {
    const out = this.settings.outboundBlocked();
    if (out) return out;
    if (!this.secrets.available) {
      return 'Op deze computer is geen sleutelhanger gevonden om de inloggegevens veilig te bewaren. Daarom kan het bonnen-adres hier niet. De Bonnenmap werkt wel: zet je bonnen in die map, dan haalt de app ze op.';
    }
    return null;
  }

  view(): BonnenView {
    const s = this.stored();
    const reden = this.blocked();
    let status: BonnenStatus = s?.status ?? 'geen';
    // een lopende aanvraag of een adres, maar de machtiging is hier niet te lezen: een back-up van een andere computer
    if (s && LIVE.includes(s.status) && !this.token() && this.secrets.available) status = 'andere-computer';
    return {
      beschikbaar: reden === null,
      reden,
      status,
      adres: s?.adres ?? null,
      email: s?.email ?? null,
      aangevraagd: s?.aangevraagd ?? null,
      bijgewerkt: s?.bijgewerkt ?? null,
      toestemmingVersie: BONNEN_CONSENT_VERSION,
    };
  }

  /** Is er een adres om op te halen, met een machtiging op deze computer? */
  actief(): boolean {
    return this.stored()?.status === 'actief' && this.token() !== null;
  }

  /** Wacht er iets bij de server (bevestigen, goedkeuren)? Dan kijkt de app af en toe naar de stand. */
  lopend(): boolean {
    const s = this.stored()?.status;
    return (s === 'onbevestigd' || s === 'overnemen' || s === 'wacht') && this.token() !== null;
  }

  /**
   * Aanvragen, of (als deze administratie al een adres heeft) overnemen op deze computer. De oude machtiging
   * gaat mee: dan mag de server een nog niet bevestigde aanvraag van deze computer vervangen.
   */
  async aanvragen(input: BonnenAanvraag): Promise<BonnenView> {
    const reden = this.blocked();
    if (reden) throw new Error(reden);
    // volgorde gelijk aan de server: e-mail, bedrijfsnaam, akkoord; bij een nieuwe aanvraag daarna KvK, namen, telefoon
    const email = input.email.trim();
    const bedrijfsnaam = input.bedrijfsnaam.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Vul een geldig e-mailadres in');
    if (!bedrijfsnaam) throw new Error('Vul je bedrijfsnaam in');
    if (input.toestemming !== BONNEN_CONSENT_VERSION) throw new Error('Ga eerst akkoord met de afspraken voor het bonnen-adres');
    const basis = { administratie: this.settings.administrationId(), email, bedrijfsnaam, toestemming: input.toestemming };
    let body: BonnenAanmelding;
    if (input.overnemen) {
      body = { ...basis, overnemen: true };
    } else {
      if (typeof input.kvk !== 'string' || !input.kvk.replace(/\s/g, '')) throw new Error(KVK_VERPLICHT);
      const kvk = normalizeKvk(input.kvk);
      if (!kvk) throw new Error('Een KvK-nummer heeft 8 cijfers');
      const voornaam = naam(input.voornaam, 'voornaam');
      const achternaam = naam(input.achternaam, 'achternaam');
      // telefoon mag leeg: dan "" naar de server; al het andere moet kloppen (gelijk aan de server)
      let telefoon = '';
      if (!isPhoneEmpty(input.telefoon)) {
        const t = normalizePhone(input.telefoon);
        if (!t) throw new Error(TELEFOON_ONGELDIG);
        telefoon = t;
      }
      body = { ...basis, kvk, voornaam, achternaam, telefoon };
    }
    let r: Awaited<ReturnType<BonnenServer['aanmelden']>>;
    try {
      r = await this.server.aanmelden(body, this.token());
    } catch (e) {
      // de aanvraag bestaat niet meer bij de server: lokaal vergeten, dan verschijnt het volledige aanvraagformulier
      if (input.overnemen && e instanceof BonnenServerError && e.status === 409 && e.code === 'geen_adres') {
        this.forget();
        this.db.prepare('DELETE FROM settings WHERE key = ?').run(STATE_KEY);
      }
      throw e;
    }
    this.forget();
    this.secrets.set(BONNEN_TOKEN_SECRET, r.installatie);
    const at = this.now().toISOString();
    const prev = this.stored();
    this.save({ status: r.status, email: r.email, aangevraagd: at, toestemming: input.toestemming, bijgewerkt: at, ...(r.status === 'overnemen' && prev?.adres ? { adres: prev.adres } : {}) });
    return this.view();
  }

  /** De stand bij de server ophalen (na bevestigen of goedkeuren). */
  async verversen(): Promise<BonnenView> {
    const token = this.token();
    if (!token || !this.stored()) return this.view();
    try {
      const r = await this.server.status(token);
      const status = KNOWN.includes(r.status as StoredState['status']) ? (r.status as StoredState['status']) : null;
      if (status) this.update({ status, ...(r.adres ? { adres: r.adres } : {}) });
      if (status && !LIVE.includes(status)) this.forget();
    } catch (e) {
      if (e instanceof BonnenServerError && e.status === 403) {
        this.update({ status: 'ingetrokken' });
        this.forget();
      } else throw e;
    }
    return this.view();
  }

  /**
   * Het IMAP-wachtwoord. Elke vraag aan de server maakt een nieuw wachtwoord (het vorige werkt dan niet meer),
   * dus alleen als er nog geen is of als inloggen mislukte (`nieuw`).
   */
  async wachtwoord(nieuw = false): Promise<string> {
    const token = this.token();
    if (!token) throw new Error('Deze computer heeft geen toegang tot het bonnen-adres');
    if (!nieuw) {
      const pw = this.secrets.get(BONNEN_PASSWORD_SECRET);
      if (pw) return pw;
    }
    try {
      const r = await this.server.inloggegevens(token);
      this.secrets.set(BONNEN_PASSWORD_SECRET, r.wachtwoord);
      this.update({ adres: r.adres });
      return r.wachtwoord;
    } catch (e) {
      if (e instanceof BonnenServerError && e.status === 403) {
        this.update({ status: 'ingetrokken' });
        this.forget();
      } else if (e instanceof BonnenServerError && e.status === 409) {
        // niet (meer) actief bij de server, bv. gestopt of verwijderd: de stand bijwerken, anders blijft hij hier "actief"
        await this.verversen().catch(() => undefined);
      }
      throw e;
    }
  }

  /** Waarmee ImapSource verbindt. */
  mailSettings(): MailInSettings {
    const s = this.stored();
    if (!s?.adres) throw new Error('Er is nog geen bonnen-adres');
    return { enabled: true, host: BONNEN_IMAP_HOST, port: 993, secure: true, user: s.adres, folder: 'INBOX', extraFolders: [], processedFolder: 'Verwerkt', since: '' };
  }

  /**
   * Stoppen: het adres ontvangt meteen niets meer en wordt na 30 dagen verwijderd. Zonder machtiging hier
   * (andere computer) kan dat niet; dan alleen lokaal vergeten.
   */
  async stoppen(): Promise<BonnenView> {
    const token = this.token();
    let status: StoredState['status'] = token ? 'gestopt' : 'ingetrokken';
    if (token) {
      try {
        await this.server.stoppen(token);
      } catch (e) {
        // 403: op een andere computer overgenomen; 404/409/410: bij de server al afgelopen. Dan alleen hier opruimen.
        if (!(e instanceof BonnenServerError && [403, 404, 409, 410].includes(e.status))) throw e;
        if (e.status === 403) status = 'ingetrokken';
      }
    }
    this.forget();
    if (this.stored()) this.update({ status });
    return this.view();
  }

  /** Lokaal vergeten (na stoppen of een geweigerde aanvraag), zodat opnieuw aanvragen schoon begint. */
  vergeten(): BonnenView {
    const s = this.stored();
    if (s && LIVE.includes(s.status) && this.token()) throw new Error('Stop het bonnen-adres eerst');
    this.forget();
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(STATE_KEY);
    return this.view();
  }
}

export const BONNEN_IMAP_HOST = 'mx.post.boekhoudenvoorniks.nl';

/** De licentieserver via fetch (main.ts). */
export function httpBonnenServer(baseUrl: string, fetchImpl: typeof fetch = fetch): BonnenServer {
  async function call<T>(method: 'GET' | 'POST', path: string, token: string | null, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error('De server van BoekhoudenVoorNiks is niet te bereiken. Heb je internet? Probeer het later opnieuw.');
    }
    const data = (await res.json().catch(() => ({}))) as T & { fout?: string; ingetrokken?: boolean; code?: string };
    if (!res.ok) throw new BonnenServerError(data.fout ?? `De server gaf een fout (${res.status}); probeer het later opnieuw`, res.status, data.ingetrokken === true, typeof data.code === 'string' ? data.code : undefined);
    return data;
  }
  return {
    aanmelden: (body, token) => call('POST', '/bonnen/aanmelden', token, body),
    status: (token) => call('GET', '/bonnen/status', token),
    inloggegevens: (token) => call('POST', '/bonnen/inloggegevens', token, {}),
    stoppen: (token) => call('POST', '/bonnen/stoppen', token, {}),
  };
}
