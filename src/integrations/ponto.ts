/**
 * Ponto-client (WP2, #244): uitsluitend de HTTP-client en de defensieve JSON:API-mapping.
 * Geen opslag, geen service, geen UI, geen BankService. Elk antwoord wordt defensief gelezen:
 * een afwijkende vorm geeft `bad-response` of wordt overgeslagen, nooit een crash. Foutteksten
 * bevatten nooit credentials, tokens, (delen van) de response of rekeninggegevens — alleen
 * vaste woorden, de soort en eventueel de HTTP-status. Er wordt nergens een sorteervolgorde
 * aangenomen en het pending-transactie-eindpunt wordt nooit aangeroepen.
 */
import { basicAuth } from './http';
import type { FetchLike } from './types';
import { parseEuro, type Cents } from '../shared/money';
import { isIsoDate, type IsoDate } from '../shared/dates';
import type { NormalizedTransaction } from '../import/types';

export const PONTO_BASE_URL = 'https://api.myponto.com';

export interface PontoCredentials {
  clientId: string;
  clientSecret: string;
}

export type PontoErrorKind =
  | 'credentials'
  | 'forbidden'
  | 'rate-limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'bad-response';

/** Fout zonder geheimen: vaste tekst, de soort en eventueel de HTTP-status. */
export class PontoError extends Error {
  constructor(message: string, readonly kind: PontoErrorKind, readonly status?: number) {
    super(message);
    this.name = 'PontoError';
  }
}

export interface PontoAccount {
  id: string;
  iban: string | null;
  referenceType: string;
  name: string;
  holder: string | null;
  currency: string;
  subtype: string | null;
  deprecated: boolean;
  availability: string | null;
  balance: Cents | null;
  balanceAt: string | null;
  detailsSynchronizedAt: string | null;
  expiresAt: IsoDate | null;
}

export interface PontoRead {
  transactions: NormalizedTransaction[];
  skippedForeign: number;
  complete: boolean;
  pages: number;
  synchronizedAt: string | null;
  latestSynchronization: {
    id: string;
    status: 'success' | 'error';
    subtype: string;
    errors: string[];
  } | null;
}

type UnknownRecord = Record<string, unknown>;
/** Vorm van `meta.latestSynchronization` in de transactielijst (gelijk aan het contract). */
type LatestSync = { id: string; status: 'success' | 'error'; subtype: string; errors: string[] };
type SyncStatus = 'pending' | 'running' | 'success' | 'error';

const PAGE_LIMIT = 100;
/** Vernieuw het token ruim vóór `expires_in` (maar nooit later dan de helft van de looptijd). */
const TOKEN_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Hard vangnet tegen een server die eindeloos nieuwe volgende-URL's verzint. */
const MAX_SAFE_PAGES = 10_000;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Eerste bruikbare (niet-lege) string uit de bronnen, in volgorde. */
function pickString(key: string, ...sources: (UnknownRecord | undefined)[]): string | null {
  for (const source of sources) {
    if (source === undefined) continue;
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * Normaliseert een IBAN (spaties eruit, hoofdletters) en controleert de mod-97-som;
 * geeft null terug bij een ongeldig of ontbrekend IBAN.
 */
function normalizeIban(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(compact)) return null;
  const digits = (compact.slice(4) + compact.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const digit of digits) rest = (rest * 10 + (digit.charCodeAt(0) - 48)) % 97;
  return rest === 1 ? compact : null;
}

/** Eerste waarde die als geldig IBAN normaliseert; null als geen vanallen geldig is. */
function firstIban(...values: unknown[]): string | null {
  for (const value of values) {
    const iban = normalizeIban(value);
    if (iban !== null) return iban;
  }
  return null;
}

/** Nederlandse kalenderdatum van een datum of ISO-moment; null bij onbruikbare invoer. */
function calendarDate(value: unknown): IsoDate | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (isIsoDate(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(parsed) as IsoDate;
}

/** Bedrag (number of string) via de bestaande geldparser naar centen; null bij onbruikbare invoer. */
function amountToCents(value: unknown): Cents | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  try {
    return parseEuro(value);
  } catch {
    return null;
  }
}

/** Scope moet `ai` als aparte scope bevatten en mag `pi` niet bevatten. */
function scopeOk(scope: string): boolean {
  const items = scope.trim().toLowerCase().split(/\s+/).filter((item) => item !== '');
  return items.includes('ai') && !items.includes('pi');
}

function errorList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim() !== '') out.push(entry.trim());
    else if (isRecord(entry)) {
      const message = pickString('message', entry) ?? pickString('title', entry);
      if (message !== null) out.push(message);
    }
  }
  return out;
}

/**
 * Leest één gestructureerd betalingskenmerk: een string of een object met een
 * referentieveld. Geeft null terug bij afwezig of leeg.
 */
function structuredRemittance(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() !== '' ? value.trim() : null;
  if (isRecord(value)) {
    for (const key of ['creditorReference', 'reference', 'remittanceReference']) {
      const found = value[key];
      if (typeof found === 'string' && found.trim() !== '') return found.trim();
    }
  }
  return null;
}

function endToEndReference(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  return trimmed === 'NOTPROVIDED' ? null : trimmed;
}

/**
 * Mapt één JSON:API-transactieresource defensief naar een genormaliseerde transactie.
 * Geeft null terug als de regel overgeslagen moet worden (geen EUR, geen bruikbare
 * datum of geen bruikbaar bedrag). Er wordt geen sorteervolgorde aangenomen;
 * `ownIban` komt van de aanroepende partij uit de gekoppelde rekening.
 */
export function mapPontoTransaction(raw: unknown, ownIban: string | null): NormalizedTransaction | null {
  if (!isRecord(raw)) return null;
  const attributes = isRecord(raw.attributes) ? raw.attributes : {};
  const currency = pickString('currency', attributes)?.toUpperCase() ?? null;
  if (currency !== 'EUR') return null;
  const date = calendarDate(attributes.executionDate) ?? calendarDate(attributes.valueDate);
  if (date === null) return null;
  const amount = amountToCents(attributes.amount);
  if (amount === null) return null;
  const counterName = pickString('counterpartName', attributes);
  const counterIban = firstIban(attributes.counterpartReference, attributes.counterpartIban, attributes.counterpartAccount);
  const remittanceType = pickString('remittanceInformationType', attributes)?.toLowerCase() ?? null;
  const remittance = pickString('remittanceInformation', attributes);
  const structured = remittanceType === 'structured'
    ? structuredRemittance(attributes.structuredRemittanceInformation) ?? remittance
    : null;
  const reference = structured ?? endToEndReference(attributes.endToEndId);
  const description = remittanceType === 'structured' ? counterName ?? '' : remittance ?? counterName ?? '';
  return {
    date,
    amount,
    counterIban,
    counterName,
    description,
    reference,
    ownIban: ownIban ?? null,
    bankId: pickString('id', raw),
  };
}

/**
 * Mapt één JSON:API-accountresource defensief: velden komen uit `attributes`, met de
 * meta van de resource (`meta.account`, anders top-level `meta`) als terugval.
 * `detailsSynchronizedAt` en `expiresAt` komen uitsluitend uit die account-meta.
 * Het IBAN wordt alleen gezet bij `referenceType === 'IBAN'` én een geldig IBAN.
 */
function mapPontoAccount(raw: unknown): PontoAccount | null {
  if (!isRecord(raw)) return null;
  const id = pickString('id', raw);
  if (id === null) return null;
  const attributes = isRecord(raw.attributes) ? raw.attributes : {};
  const meta = isRecord(raw.meta) ? raw.meta : {};
  const accountMeta = isRecord(meta.account) ? meta.account : meta;
  const referenceType = pickString('referenceType', attributes, accountMeta) ?? '';
  return {
    id,
    iban: referenceType === 'IBAN' ? firstIban(attributes.reference, accountMeta.reference) : null,
    referenceType,
    name: pickString('description', attributes, accountMeta)
      ?? pickString('name', attributes, accountMeta)
      ?? pickString('naturalName', attributes, accountMeta)
      ?? '',
    holder: pickString('holderName', attributes, accountMeta) ?? pickString('holder', attributes, accountMeta),
    currency: pickString('currency', attributes, accountMeta) ?? '',
    subtype: pickString('subtype', attributes, accountMeta),
    deprecated: attributes.deprecated === true || attributes.deprecated === 'true' || accountMeta.deprecated === true || accountMeta.deprecated === 'true',
    availability: pickString('availability', attributes, accountMeta),
    balance: amountToCents(attributes.currentBalance)
      ?? amountToCents(accountMeta.currentBalance)
      ?? amountToCents(attributes.balance)
      ?? amountToCents(accountMeta.balance),
    balanceAt: pickString('currentBalanceReferenceDate', attributes, accountMeta)
      ?? pickString('balanceAt', attributes, accountMeta),
    detailsSynchronizedAt: pickString('synchronizedAt', accountMeta)
      ?? pickString('detailsSynchronizedAt', accountMeta),
    expiresAt: calendarDate(pickString('authorizationExpirationExpectedAt', attributes, accountMeta)
      ?? pickString('expiresAt', accountMeta)),
  };
}

/** Leest `meta.latestSynchronization` defensief; null bij afwezig of onbruikbaar. */
function parseLatestSynchronization(value: unknown): LatestSync | null {
  if (!isRecord(value)) return null;
  const attributes = isRecord(value.attributes) ? value.attributes : value;
  const id = pickString('id', value);
  const subtype = pickString('subtype', attributes);
  if (id === null || subtype === null) return null;
  if (attributes.status !== 'success' && attributes.status !== 'error') return null;
  return { id, status: attributes.status, subtype, errors: errorList(attributes.errors) };
}

/**
 * Leest `links.next`: alleen volgen als het een HTTPS-URL op exact dezelfde
 * geconfigureerde origin is. `null` = geen volgende pagina, `ok: false` = volgende
 * URL niet veilig (niet volgen).
 */
function nextLink(json: UnknownRecord, baseUrl: string): { ok: true; url: string } | { ok: false } | null {
  const links = isRecord(json.links) ? json.links : {};
  const raw = typeof links.next === 'string'
    ? links.next
    : isRecord(links.next) && typeof links.next.href === 'string'
      ? links.next.href
      : null;
  if (raw === null) return null;
  try {
    const next = new URL(raw);
    const base = new URL(baseUrl);
    if (next.protocol !== 'https:' || next.origin !== base.origin) return { ok: false };
    return { ok: true, url: next.toString() };
  } catch {
    return { ok: false };
  }
}

/** Cursorwaarde uit een volgende-URL, om cursorlussen te kunnen zien. */
function cursorOf(url: string): string | null {
  try {
    return new URL(url).searchParams.get('page[cursor]');
  } catch {
    return null;
  }
}

export class PontoClient {
  private readonly fetchImpl: FetchLike;
  private readonly creds: PontoCredentials;
  private readonly baseUrl: string;
  private readonly nowFn: () => Date;
  private readonly timeoutMs: number;
  /** Alleen in geheugen, nooit ergens opgeslagen. */
  private token: { value: string; scope: string; expiresAtMs: number } | null = null;
  /** Gelijktijdige eerste aanvragen delen één tokenrequest; fouten worden niet gecachet. */
  private tokenRequest: Promise<{ value: string; scope: string }> | null = null;

  constructor(
    fetchImpl: FetchLike,
    creds: PontoCredentials,
    opts: { baseUrl?: string; now?: () => Date; timeoutMs?: number } = {},
  ) {
    this.fetchImpl = fetchImpl;
    this.creds = creds;
    this.baseUrl = (opts.baseUrl ?? PONTO_BASE_URL).replace(/\/+$/, '');
    this.nowFn = opts.now ?? (() => new Date());
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * De rekeningen van de eerste pagina, plus de scope uit het token. Volgt bewust geen
   * `links.next`: rekeningenlijsten zijn klein en het contract vraagt hier geen paginering.
   */
  async accounts(): Promise<{ accounts: PontoAccount[]; scope: string }> {
    const token = await this.getToken();
    const json = await this.request(`${this.baseUrl}/accounts`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token.value}` },
    }, 'rekeningen');
    if (!isRecord(json) || !Array.isArray(json.data)) {
      throw new PontoError('Ponto: onverwacht antwoord bij het ophalen van rekeningen', 'bad-response');
    }
    const accounts: PontoAccount[] = [];
    for (const entry of json.data) {
      const account = mapPontoAccount(entry);
      if (account !== null) accounts.push(account);
    }
    return { accounts, scope: token.scope };
  }

  /**
   * Leest transacties pagina voor pagina via `links.next`, tot klaar of tot een limiet,
   * en geeft de regels terug in ontvangen volgorde (geen sorteeraanname). `complete` is
   * alleen `true` als elke pagina gelezen is zonder paginalimiet, lus of onveilige
   * volgende-URL én de transactiemetadata (top-level meta, nooit het account) bruikbaar
   * is. Een HTTP-fout halverwege wordt gegooid, niet ingeslikt. Het pending-eindpunt
   * wordt nooit aangeroepen. Voor `ownIban` wordt eenmaal de gekoppelde rekening gelezen
   * (`GET /accounts/{id}`); lukt dat niet, dan blijven de regels zonder eigen IBAN.
   */
  async transactions(accountId: string, opts: { sinceDate?: IsoDate; maxPages?: number } = {}): Promise<PontoRead> {
    if (accountId.trim() === '') throw new PontoError('Ponto: ontbrekend account-id', 'bad-response');
    let since: IsoDate | null = null;
    if (opts.sinceDate !== undefined) {
      if (typeof opts.sinceDate !== 'string' || !isIsoDate(opts.sinceDate)) {
        throw new PontoError('Ponto: ongeldige sinceDate (verwacht jjjj-mm-dd)', 'bad-response');
      }
      since = opts.sinceDate;
    }
    const limit = typeof opts.maxPages === 'number' && Number.isFinite(opts.maxPages) && opts.maxPages >= 0
      ? Math.min(Math.floor(opts.maxPages), MAX_SAFE_PAGES)
      : MAX_SAFE_PAGES;
    let ownIban: string | null = null;
    try {
      ownIban = (await this.accountById(accountId))?.iban ?? null;
    } catch {
      ownIban = null; // optioneel: zonder eigen IBAN zijn de transacties nog steeds bruikbaar
    }
    const seenUrls = new Set<string>();
    const seenCursors = new Set<string>();
    const transactions: NormalizedTransaction[] = [];
    let skippedForeign = 0;
    let pages = 0;
    let synchronizedAt: string | null = null;
    let latestSynchronization: LatestSync | null = null;
    let sawSynchronizedAt = false;
    let sawLatest = false;
    let complete = true;
    let url: string | null = `${this.baseUrl}/accounts/${encodeURIComponent(accountId)}/transactions?page[limit]=${PAGE_LIMIT}`;
    while (url !== null) {
      if (seenUrls.has(url)) { complete = false; break; } // URL-lus
      seenUrls.add(url);
      const cursor = cursorOf(url);
      if (cursor !== null) {
        if (seenCursors.has(cursor)) { complete = false; break; } // cursorlus
        seenCursors.add(cursor);
      }
      if (pages >= limit) { complete = false; break; } // paginalimiet bereikt
      const token = await this.getToken();
      const json = await this.request(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token.value}` },
      }, 'transacties');
      if (!isRecord(json) || !Array.isArray(json.data)) {
        throw new PontoError('Ponto: onverwacht antwoord bij het ophalen van transacties', 'bad-response');
      }
      pages += 1;
      const meta = isRecord(json.meta) ? json.meta : {};
      const pageSynchronizedAt = pickString('synchronizedAt', meta);
      if (pageSynchronizedAt !== null) {
        synchronizedAt = pageSynchronizedAt;
        sawSynchronizedAt = true;
      }
      const pageLatest = parseLatestSynchronization(meta.latestSynchronization);
      if (pageLatest !== null) {
        latestSynchronization = pageLatest;
        sawLatest = true;
      }
      for (const entry of json.data) {
        const attributes = isRecord(entry) && isRecord(entry.attributes) ? entry.attributes : null;
        const currency = attributes === null ? null : pickString('currency', attributes)?.toUpperCase() ?? null;
        if (currency !== null && currency !== 'EUR') {
          skippedForeign += 1;
          continue;
        }
        if (currency === null) continue;
        const mapped = mapPontoTransaction(entry, ownIban);
        if (mapped === null) continue;
        if (since !== null && mapped.date < since) continue;
        transactions.push(mapped);
      }
      const next = nextLink(json, this.baseUrl);
      if (next === null) url = null;
      else if (next.ok && seenUrls.has(next.url)) { complete = false; break; } // URL-lus: niet opnieuw lezen
      else if (next.ok) url = next.url;
      else { complete = false; break; } // externe of ongeldige volgende-URL: niet volgen
    }
    const metadataUsable = sawSynchronizedAt && sawLatest && latestSynchronization !== null && latestSynchronization.status === 'success';
    return {
      transactions,
      skippedForeign,
      complete: complete && metadataUsable,
      pages,
      synchronizedAt,
      latestSynchronization,
    };
  }

  /** Start een synchronisatie voor de rekening; geeft het synchronisatie-id terug. */
  async startSynchronization(
    accountId: string,
    subtype: 'accountTransactions' | 'accountDetails',
    customerIp: string,
  ): Promise<{ id: string }> {
    if (accountId.trim() === '') throw new PontoError('Ponto: ontbrekend account-id', 'bad-response');
    const token = await this.getToken();
    const json = await this.request(`${this.baseUrl}/synchronizations`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token.value}`,
      },
      body: JSON.stringify({
        data: {
          type: 'synchronization',
          attributes: { resourceType: 'account', resourceId: accountId, subtype, customerIpAddress: customerIp },
        },
      }),
    }, 'synchronisatie starten');
    const data = isRecord(json) && isRecord(json.data) ? json.data : null;
    const id = data === null ? null : pickString('id', data);
    if (id === null) throw new PontoError('Ponto: onverwacht antwoord bij het starten van de synchronisatie', 'bad-response');
    return { id };
  }

  /** Leest de status van één synchronisatie; een foutstatus is een antwoord, geen gooibare fout. */
  async synchronization(id: string): Promise<{ status: SyncStatus; errors: string[] }> {
    if (id.trim() === '') throw new PontoError('Ponto: ontbrekend synchronisatie-id', 'bad-response');
    const token = await this.getToken();
    const json = await this.request(`${this.baseUrl}/synchronizations/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token.value}` },
    }, 'synchronisatie');
    const data = isRecord(json) && isRecord(json.data) ? json.data : null;
    const attributes = data === null ? null : isRecord(data.attributes) ? data.attributes : null;
    const status = attributes === null ? null : attributes.status;
    if (status !== 'pending' && status !== 'running' && status !== 'success' && status !== 'error') {
      throw new PontoError('Ponto: onverwachte synchronisatiestatus', 'bad-response');
    }
    return { status, errors: errorList(attributes?.errors) };
  }

  /** Leest één rekening defensief; null bij een afwijkende vorm. */
  private async accountById(accountId: string): Promise<PontoAccount | null> {
    const token = await this.getToken();
    const json = await this.request(`${this.baseUrl}/accounts/${encodeURIComponent(accountId)}`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token.value}` },
    }, 'rekening');
    const data = isRecord(json) && isRecord(json.data) ? json.data : null;
    return data === null ? null : mapPontoAccount(data);
  }

  /** Haalt het token op (alleen in geheugen) of hergebruikt het zolang het geldig is. */
  private async getToken(): Promise<{ value: string; scope: string }> {
    const nowMs = this.nowFn().getTime();
    if (this.token !== null && nowMs < this.token.expiresAtMs) return this.token;
    if (this.tokenRequest !== null) return this.tokenRequest;
    if (this.creds.clientId.trim() === '' || this.creds.clientSecret.trim() === '') {
      throw new PontoError('Ponto: ontbrekende client-id of client-secret', 'credentials');
    }
    const request = this.fetchToken(nowMs);
    this.tokenRequest = request;
    try {
      return await request;
    } finally {
      if (this.tokenRequest === request) this.tokenRequest = null;
    }
  }

  /** Voert één daadwerkelijke tokenaanvraag uit en vult pas na volledige validatie de cache. */
  private async fetchToken(nowMs: number): Promise<{ value: string; scope: string }> {
    const json = await this.request(`${this.baseUrl}/oauth2/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuth(this.creds.clientId, this.creds.clientSecret),
      },
      body: 'grant_type=client_credentials',
    }, 'token');
    if (!isRecord(json)) throw new PontoError('Ponto: onverwacht token-antwoord', 'bad-response');
    const value = pickString('access_token', json);
    const expiresIn = typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) && json.expires_in > 0
      ? json.expires_in
      : null;
    const scope = pickString('scope', json);
    if (value === null || expiresIn === null || scope === null) {
      throw new PontoError('Ponto: onverwacht token-antwoord', 'bad-response');
    }
    if (!scopeOk(scope)) throw new PontoError('Ponto: ontoereikende scope voor een alleen-lezen bankfeed', 'forbidden');
    const marginMs = Math.min(TOKEN_MARGIN_MS, Math.floor((expiresIn * 1000) / 2));
    this.token = { value, scope, expiresAtMs: nowMs + expiresIn * 1000 - marginMs };
    return this.token;
  }

  /**
   * Eén HTTP-aanvraag met time-out via AbortSignal, met de foutmapping uit het contract.
   * Bij een fout wordt de response nooit gelezen of in de fouttekst opgenomen.
   */
  private async request(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
    context: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      } catch {
        if (controller.signal.aborted) throw new PontoError(`Ponto: time-out bij ${context}`, 'timeout');
        throw new PontoError(`Ponto: netwerkfout bij ${context}`, 'network');
      }
      const status = response.status;
      if (!response.ok) {
        if (status === 401 || (context === 'token' && status === 403)) {
          throw new PontoError(`Ponto: inloggegevens geweigerd (fout ${status})`, 'credentials', status);
        }
        if (status === 403) throw new PontoError(`Ponto: geen toegang (fout ${status})`, 'forbidden', status);
        if (status === 429) throw new PontoError(`Ponto: te veel aanvragen (fout ${status})`, 'rate-limit', status);
        if (status >= 500) throw new PontoError(`Ponto: serverstoring (fout ${status})`, 'server', status);
        throw new PontoError(`Ponto: onverwacht antwoord (fout ${status})`, 'bad-response', status);
      }
      try {
        return await response.json();
      } catch {
        if (controller.signal.aborted) throw new PontoError(`Ponto: time-out bij ${context}`, 'timeout');
        throw new PontoError(`Ponto: ongeldig antwoord (geen JSON) bij ${context}`, 'bad-response');
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
