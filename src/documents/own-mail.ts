import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SettingsService } from '../settings/settings';
import { formatDateNl } from '../shared/dates';
import { formatEuro } from '../shared/money';
import { formatIban, isValidEmail, ValidationError } from '../shared/validation';
import type { InvoiceService } from './invoices';
import type { QuoteService } from './quotes';
import { DocumentSender, fillPlaceholders, type SendOptions } from './sending';

/**
 * Versturen met je eigen mailprogramma (#450): de app geeft de mail door aan het standaardmailprogramma
 * van het besturingssysteem — op Windows via Simple MAPI (het standaardmechanisme om met bijlage te
 * versturen), op Linux via `xdg-email --attach`. Geen lijstje van mailprogramma's en geen nieuw account.
 *
 * Het document wordt hier nooit "verzonden" gemarkeerd: dat gebeurt pas als de gebruiker daarna
 * bevestigt dat de mail echt de deur uit is (net als bij SMTP dus, alleen met de gebruiker als schakel).
 */

/** De mail zoals het mailprogramma hem krijgt: niets wordt aangepast of ge-escaped. */
export interface OwnMailMessage {
  to: string;
  subject: string;
  body: string;
  attachmentPath: string;
}

/** Uitkomst van het doorgeven: gelukt, of waarom niet (het scherm bepaalt wat er dan te zien is). */
export type HandoverResult = { ok: true } | { ok: false; reason: 'no-handler' | 'cancelled' | 'failed' };

/**
 * De Simple MAPI-aanroep op Windows, achter een interface zodat tests hem kunnen nabootsen.
 * De retourcode is die van MAPISendMailW: 0 = gelukt (SUCCESS_SUCCESS).
 */
export interface MapiSender {
  send(msg: OwnMailMessage): Promise<number>;
}

/** Retourcodes van MAPISendMailW (mapi.h). */
export const MAPI_SUCCESS = 0;
export const MAPI_E_USER_ABORT = 1;
export const MAPI_E_LOGIN_FAILURE = 3;

/** Net genoeg van child_process.spawn om het aanroepen van xdg-email te kunnen nabootsen. */
export interface ChildProcessLike {
  on(event: 'error', cb: (err: NodeJS.ErrnoException) => void): unknown;
  on(event: 'close', cb: (code: number | null) => void): unknown;
}
export type SpawnFn = (cmd: string, args: string[]) => ChildProcessLike;

/**
 * Linux: xdg-email als argv-array, zonder shell. Aanhalingstekens, &, accenten en spaties in het
 * onderwerp, de tekst en het pad gaan als één argument byte voor byte mee naar het mailprogramma.
 */
export function buildXdgEmailArgs(msg: OwnMailMessage): string[] {
  return ['xdg-email', '--subject', msg.subject, '--body', msg.body, '--attach', msg.attachmentPath, msg.to];
}

/** Zo lang wachten we op een mailprogramma dat nog niet klaar is, voordat we aannemen dat het venster open staat. */
export const HANDOVER_WAIT_MS = 5000;

/**
 * Start een mailprogramma als argv-array (zonder shell). Een spawnfout ENOENT (het programma is er niet) is
 * "geen handler"; een andere eindcode dan 0 betekent dat het mailprogramma het niet pakte. Sluit het proces
 * niet af binnen `waitMs` (xdg-email en Thunderbird blijven draaien zolang het programma zelf open is), dan nemen
 * we aan dat het mailvenster open staat: zo blijft de app niet wachten op het sluiten van je mailprogramma.
 */
export function runHandler(cmd: string, args: string[], spawn: SpawnFn, waitMs: number = HANDOVER_WAIT_MS): Promise<HandoverResult> {
  return new Promise((resolve) => {
    let afgehandeld = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const klaar = (r: HandoverResult) => {
      if (afgehandeld) return;
      afgehandeld = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    let child: ChildProcessLike;
    try {
      child = spawn(cmd, args);
    } catch (e) {
      klaar((e as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: false, reason: 'no-handler' } : { ok: false, reason: 'failed' });
      return;
    }
    child.on('error', (err) => klaar(err.code === 'ENOENT' ? { ok: false, reason: 'no-handler' } : { ok: false, reason: 'failed' }));
    child.on('close', (code) => klaar(code === 0 ? { ok: true } : { ok: false, reason: 'failed' }));
    timer = setTimeout(() => klaar({ ok: true }), waitMs);
  });
}

/** Linux: xdg-email. */
export function spawnXdgEmail(msg: OwnMailMessage, spawn: SpawnFn, waitMs?: number): Promise<HandoverResult> {
  return runHandler('xdg-email', buildXdgEmailArgs(msg).slice(1), spawn, waitMs);
}

/** De standaardmailprogramma's waar xdg-email de bijlage laat vallen: Thunderbird (ook als snap) en Icedove. */
const THUNDERBIRD_ID = /thunderbird|icedove/i;

/**
 * Thunderbird rechtstreeks: `-compose` met de bijlage als file://-adres. xdg-email geeft het pad zonder file://
 * door, en Thunderbird (zeker als snap) laat de bijlage dan stil weg. Waarden staan tussen enkele aanhalingstekens;
 * Thunderbird leest onderwerp en tekst met komma's, aanhalingstekens, & en apostrofs goed in.
 */
export function buildThunderbirdArgs(msg: OwnMailMessage): string[] {
  const compose = `to='${msg.to}',subject='${msg.subject}',body='${msg.body}',attachment='${pathToFileURL(msg.attachmentPath).href}'`;
  return ['-compose', compose];
}

/** Retourcode van MAPISendMailW vertalen naar wat het scherm te zien krijgt. */
export function mapMapiResult(code: number): HandoverResult {
  if (code === MAPI_SUCCESS) return { ok: true };
  if (code === MAPI_E_USER_ABORT) return { ok: false, reason: 'cancelled' };
  if (code === MAPI_E_LOGIN_FAILURE) return { ok: false, reason: 'no-handler' };
  return { ok: false, reason: 'failed' };
}

/**
 * Windows: het bericht via Simple MAPI sturen. `mapi` is null als er geen MAPI-programma te laden is
 * (geen standaardmailprogramma); een fout tijdens het aanroepen zelf is "mislukt".
 */
export async function sendWithMapi(msg: OwnMailMessage, mapi: MapiSender | null): Promise<HandoverResult> {
  if (!mapi) return { ok: false, reason: 'no-handler' };
  let code: number;
  try {
    code = await mapi.send(msg);
  } catch {
    return { ok: false, reason: 'failed' };
  }
  return mapMapiResult(code);
}

export interface HandOverDeps {
  platform: string;
  spawn: SpawnFn;
  /** Simple MAPI op Windows; op andere platformen null */
  mapi: MapiSender | null;
  /** welk programma het standaard mailprogramma is (bv. `xdg-mime query default x-scheme-handler/mailto`); null als onbekend */
  mailHandler?: () => Promise<string | null>;
  /** hoe lang we op een nog draaiend mailprogramma wachten (tests) */
  waitMs?: number;
}

/**
 * Geeft de mail door aan het eigen mailprogramma: op Windows via Simple MAPI, verderop via xdg-email.
 * Is Thunderbird de standaard, dan gaat het rechtstreeks (xdg-email laat daar de bijlage vallen); lukt dat niet
 * omdat het programma niet te starten is, dan alsnog via xdg-email.
 */
export async function handOverToOwnMailProgram(msg: OwnMailMessage, deps: HandOverDeps): Promise<HandoverResult> {
  if (deps.platform === 'win32') return sendWithMapi(msg, deps.mapi);
  let handler: string | null = null;
  try {
    handler = (await deps.mailHandler?.()) ?? null;
  } catch {
    handler = null;
  }
  if (handler && THUNDERBIRD_ID.test(handler)) {
    const cmd = /icedove/i.test(handler) ? 'icedove' : 'thunderbird';
    const r = await runHandler(cmd, buildThunderbirdArgs(msg), deps.spawn, deps.waitMs);
    if (r.ok || r.reason !== 'no-handler') return r;
  }
  return spawnXdgEmail(msg, deps.spawn, deps.waitMs);
}

/**
 * Standaardmap voor de tijdelijke PDF's (tests). De app zelf geeft een map in Documenten mee: een mailprogramma
 * dat als snap of flatpak draait ziet de gewone tijdelijke map niet en laat de bijlage dan stil weg.
 */
export const OWN_MAIL_PDF_DIR = join(tmpdir(), 'boekhoudenvoorniks');

/** Zo lang blijft een tijdelijke PDF staan; het mailprogramma heeft hem dan lang genoeg gehad. */
const PDF_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/** Ruimt mapjes met PDF's op die ouder zijn dan `maxAgeMs`. Fouten (bestand in gebruik, geen rechten) negeren we. */
export function pruneOldPdfs(dir: string, now: number = Date.now(), maxAgeMs: number = PDF_MAX_AGE_MS): void {
  try {
    for (const naam of readdirSync(dir)) {
      const pad = join(dir, naam);
      try {
        if (now - statSync(pad).mtimeMs > maxAgeMs) rmSync(pad, { recursive: true, force: true });
      } catch {
        /* blijft staan tot de volgende keer */
      }
    }
  } catch {
    /* map bestaat nog niet */
  }
}

/**
 * Schrijft de PDF weg in een eigen map per document (twee administraties en twee documenten lopen
 * niet over elkaar heen) en laat het bestand staan: het mailprogramma leest het zelf in, soms pas
 * als de gebruiker op verzenden klikt, dus de app verwijdert hem niet na het doorgeven.
 * Alleen verouderde mapjes (ouder dan 30 dagen) ruimt hij op.
 */
export function writeTempPdf(dir: string, perDocument: string, filename: string, content: Buffer): string {
  pruneOldPdfs(dir);
  const map = join(dir, perDocument);
  mkdirSync(map, { recursive: true });
  const pad = join(map, filename);
  writeFileSync(pad, content);
  return pad;
}

export interface OwnMailSenderDeps {
  /** PDF's en e-mailwaarden, dezelfde als bij versturen via SMTP */
  sender: DocumentSender;
  settings: SettingsService;
  invoices: InvoiceService;
  quotes: QuoteService;
  /** blokkeert de demo en de kopie bij de boekhouder, net als bij elke uitgaande mail */
  guard: () => void;
  /** geeft de mail aan het besturingssysteem; in tests vervangen */
  handOver: (msg: OwnMailMessage) => Promise<HandoverResult>;
  /** map voor de tijdelijke PDF; standaard OWN_MAIL_PDF_DIR */
  pdfDir?: string;
}

/** Welke webmail de gebruiker kiest als er geen (werkend) mailprogramma is. */
export type WebmailProvider = 'gmail' | 'outlook';

/** Te lange teksten maken de adresregel te lang voor de browser; langer dan dit gaat niet mee in de link. */
const WEBMAIL_MAX_BODY = 1500;

/**
 * Link naar het schrijfvenster van Gmail of Outlook op het web, met ontvanger, onderwerp en tekst alvast
 * ingevuld. Alles gaat via URLSearchParams, dus &, aanhalingstekens, accenten en spaties blijven heel.
 * Een bijlage kan zo'n link niet meegeven: de PDF toont de app in de bestandsbeheerder om te slepen.
 */
export function webmailUrl(provider: WebmailProvider, msg: Pick<OwnMailMessage, 'to' | 'subject' | 'body'>): string {
  const body = msg.body.length > WEBMAIL_MAX_BODY ? msg.body.slice(0, WEBMAIL_MAX_BODY) : msg.body;
  if (provider === 'gmail') {
    const q = new URLSearchParams({ view: 'cm', fs: '1', to: msg.to, su: msg.subject, body });
    return `https://mail.google.com/mail/?${q.toString()}`;
  }
  const q = new URLSearchParams({ to: msg.to, subject: msg.subject, body });
  return `https://outlook.office.com/mail/deeplink/compose?${q.toString()}`;
}

/**
 * Doorgeven van een factuur of offerte aan het eigen mailprogramma van de gebruiker (#450).
 * Bouwt de mail precies zo op als de SMTP-route (ontvanger, onderwerp, tekst, PDF) en markeert
 * het document zelf nooit als verzonden: alleen `confirmSent...` doet dat, na "Ja" in het scherm.
 */
export class OwnMailSender {
  constructor(private readonly deps: OwnMailSenderDeps) {}

  /** Stelt de mail samen en schrijft de PDF weg, zonder iets door te geven. */
  async prepareInvoice(id: number, opts: SendOptions = {}): Promise<OwnMailMessage> {
    const { sender, settings, invoices } = this.deps;
    this.deps.guard();
    let inv = invoices.get(id);
    // de echte factuur staat in je vorige programma; hier alleen het openstaande bedrag
    if (inv.is_opening) throw new ValidationError('Deze factuur komt uit je vorige administratie. Stuur hem vanuit je vorige programma; een herinnering kan wel vanuit hier.');
    // een telefoonfactuur (uuid) stuurt de telefoon zelf; de pc verstuurt hem nooit
    if (inv.uuid) throw new ValidationError(`Factuur ${inv.number} komt van je telefoon en is daar al verstuurd. De pc verstuurt deze factuur niet opnieuw.`);
    const to = (opts.to ?? inv.relation_email ?? '').trim();
    if (!isValidEmail(to)) throw new ValidationError(`Geen geldig e-mailadres voor ${inv.relation_name}`);
    if (inv.status === 'concept') inv = invoices.finalize(id);
    const s = settings.get();
    const values = sender.invoiceValues(inv, s);
    const subject = fillPlaceholders(opts.subject ?? s.invoiceEmailSubject, values);
    const body = fillPlaceholders(opts.body ?? s.invoiceEmailBody, values);
    const attachment = await sender.invoicePdf(id);
    const attachmentPath = writeTempPdf(this.pdfDir(), `factuur-${id}`, attachment.filename, attachment.content);
    return { to, subject, body, attachmentPath };
  }

  async prepareQuote(id: number, opts: SendOptions = {}): Promise<OwnMailMessage> {
    const { sender, settings, quotes } = this.deps;
    this.deps.guard();
    const q = quotes.get(id);
    const to = (opts.to ?? q.relation_email ?? '').trim();
    if (!isValidEmail(to)) throw new ValidationError(`Geen geldig e-mailadres voor ${q.relation_name}`);
    const s = settings.get();
    const values = {
      nummer: q.number,
      klant: q.relation_name,
      bedrag: formatEuro(q.totals.total),
      geldig_tot: formatDateNl(q.valid_until),
      bedrijf: s.company.name,
    };
    const subject = fillPlaceholders(opts.subject ?? s.quoteEmailSubject, values);
    const body = fillPlaceholders(opts.body ?? s.quoteEmailBody, values);
    const attachment = await sender.quotePdf(id);
    const attachmentPath = writeTempPdf(this.pdfDir(), `offerte-${id}`, attachment.filename, attachment.content);
    return { to, subject, body, attachmentPath };
  }

  async sendInvoice(id: number, opts: SendOptions = {}): Promise<HandoverResult> {
    return this.deps.handOver(await this.prepareInvoice(id, opts));
  }

  async sendQuote(id: number, opts: SendOptions = {}): Promise<HandoverResult> {
    return this.deps.handOver(await this.prepareQuote(id, opts));
  }

  /** Webmail als vervanging: de link om te openen en de PDF die in de bestandsbeheerder getoond moet worden. */
  async webmailInvoice(id: number, provider: WebmailProvider, opts: SendOptions = {}): Promise<{ url: string; pdfPath: string }> {
    const msg = await this.prepareInvoice(id, opts);
    return { url: webmailUrl(provider, msg), pdfPath: msg.attachmentPath };
  }

  async webmailQuote(id: number, provider: WebmailProvider, opts: SendOptions = {}): Promise<{ url: string; pdfPath: string }> {
    const msg = await this.prepareQuote(id, opts);
    return { url: webmailUrl(provider, msg), pdfPath: msg.attachmentPath };
  }

  /** De gebruiker zegt "Ja, verstuurd": nu pas telt het document als verzonden (en lopen de herinneringen). */
  confirmInvoiceSent(id: number): void {
    this.deps.guard();
    this.deps.invoices.markSent(id);
  }

  confirmQuoteSent(id: number): void {
    this.deps.guard();
    this.deps.quotes.markSent(id);
  }

  private pdfDir(): string {
    return this.deps.pdfDir ?? OWN_MAIL_PDF_DIR;
  }
}
