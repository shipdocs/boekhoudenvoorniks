import { createHash } from 'node:crypto';
import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { IntakeService } from '../intake/intake';
import type { SettingsService } from '../settings/settings';
import { diffDays, today, type IsoDate } from '../shared/dates';
import { PHONE_SCANNER } from '../shared/phone-scanner';
import { legProbleem, onleesbaar, schoonNaam, type Probleem, type TelefoonHandler } from '../scanner/map-route';
import { LIMITS } from '../scanner/protocol';

/** Eén bijlage uit een e-mail. */
export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
  /** inline plaatje in de tekst (logo, handtekening) */
  inline: boolean;
}

/** Een e-mail zoals de mailbox hem geeft (al uit elkaar gehaald). */
export interface MailMessage {
  uid: number;
  messageId: string | null;
  fromAddress: string;
  fromName: string;
  subject: string;
  date: IsoDate;
  text: string;
  attachments: MailAttachment[];
}

/**
 * De mailbox (IMAP). Lezen mag de gelezen-status niet veranderen; er wordt nooit iets verwijderd.
 * Zie mail/imap-source.ts voor de echte; tests gebruiken een nep-mailbox.
 */
export interface MailSource {
  /** opent een map; null als hij niet bestaat */
  open(folder: string): Promise<{ uidValidity: string } | null>;
  /** UID's in de open map groter dan afterUid, vanaf een datum, oplopend */
  list(afterUid: number, since: IsoDate | null): Promise<number[]>;
  fetch(uid: number): Promise<MailMessage | null>;
  /** verplaatst een bericht (maakt de map aan als die er nog niet is) */
  move(uid: number, target: string): Promise<void>;
}

export type MailOutcome = 'bijlage' | 'online-factuur' | 'klant' | 'eigen' | 'overig' | 'fout';

export interface MailRecord {
  id: number;
  message_key: string;
  folder: string;
  uid: number;
  from_address: string | null;
  from_name: string | null;
  subject: string | null;
  received_on: string | null;
  outcome: MailOutcome;
  relation_id: number | null;
  link_domain: string | null;
  document_ids: string;
  note: string | null;
  moved_to: string | null;
  created_at: string;
}

export interface PollResult {
  /** bonnetjes/facturen die als document binnenkwamen */
  documents: number;
  onlineInvoices: number;
  fromCustomers: number;
  /** mail waar de app niets mee doet */
  other: number;
  errors: number;
  /** mappen die niet bestaan */
  missingFolders: string[];
}

/** Wat er van één mail als document binnenkwam, en welke bijlagen er al in stonden. */
interface AddedFiles {
  ids: number[];
  notices: Parameters<IntakeService['notify']>[0][];
}

export const MAIL_LIMITS = {
  /** grootste bijlage die we lezen */
  maxAttachmentBytes: 10 * 1024 * 1024,
  /** plaatjes kleiner dan dit zijn bijna altijd een logo of icoon */
  minImageBytes: 15 * 1024,
  maxAttachmentsPerMail: 10,
  /** zoveel berichten per keer ophalen; de rest volgt de volgende keer */
  maxMessagesPerPoll: 200,
  /** zo vaak opnieuw proberen als een bericht niet te lezen is; daarna overslaan (als "fout") */
  maxAttempts: 3,
};

/**
 * De mailroute van de telefoon (stap mailroute): een afzonderlijke mail met een versleutelde .bvns-bijlage (dezelfde envelop als bij
 * het netwerk en de bonnenmap). Deze grenzen staan los van die voor gewone bijlagen (MAIL_LIMITS.maxAttachmentBytes):
 * - een .bvns is hoogstens zo groot als het netwerk aanneemt (LIMITS.maxBodyBytes); groter wordt definitief afgewezen zonder de inhoud te lezen;
 * - hoogstens zoveel .bvns-bijlagen per mail worden verwerkt; de rest wordt als probleem vastgelegd;
 * - een mail zo groot dat ImapSource hem niet inleest (MAIL_LIMITS.maxAttachmentBytes x maxAttachmentsPerMail) komt zonder bijlagen binnen;
 * - een herhaalbaar bericht (wachtrij vol, opslaan mislukt, nog onbekende klant of project, niet ondersteund) blijft liggen en wordt bij
 *   de volgende ophaalronde opnieuw geprobeerd; pas na zoveel pogingen wordt de mail als probleem vastgelegd en overgeslagen.
 */
export const MAIL_TELEFOON_LIMITS = {
  maxBvnsBytes: LIMITS.maxBodyBytes,
  maxBvnsPerMail: 10,
  maxPogingen: 200,
};
/** De notitie bij een vastgelegde mail met telefoonberichten (nooit de inhoud). */
export const TELEFOON_NOTE = 'telefoonbericht';
const BVNS_TYPE = 'application/vnd.boekhoudenvoorniks.scanner';

/** De bijlagen die telefoonberichten zijn: de naam eindigt op .bvns of het contenttype is dat van de scanner. */
export function telefoonBijlagen(attachments: MailAttachment[]): MailAttachment[] {
  return attachments.filter((a) => a.filename.toLowerCase().endsWith('.bvns') || a.contentType.toLowerCase().split(';')[0]!.trim() === BVNS_TYPE);
}

/** Alleen de naam van de bijlage, zonder mappen of stuurtekens, voor het probleemregister. */
function bijlageNaam(a: MailAttachment): string {
  return schoonNaam(a.filename.split(/[\\/]/).pop() ?? '') || 'bijlage.bvns';
}

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

function extension(name: string): string {
  return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
}

function startsWith(data: Uint8Array, bytes: number[]): boolean {
  return bytes.every((b, i) => data[i] === b);
}

/** Echt het bestandstype dat de naam zegt? (geen .exe met .pdf erachter) */
function kindOf(a: MailAttachment): 'pdf' | 'jpg' | 'png' | 'ubl' | null {
  const ext = extension(a.filename);
  const d = a.content;
  if ((ext === 'pdf' || ext === '' || a.contentType === 'application/pdf') && startsWith(d, [0x25, 0x50, 0x44, 0x46])) return 'pdf';
  if (['jpg', 'jpeg'].includes(ext) && startsWith(d, [0xff, 0xd8, 0xff])) return 'jpg';
  if (ext === 'png' && startsWith(d, [0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (ext === 'xml') {
    const head = new TextDecoder().decode(d.subarray(0, 4096));
    if (/urn:oasis:names:specification:ubl:schema:xsd:(Invoice|CreditNote)-2/.test(head)) return 'ubl';
  }
  return null;
}

/**
 * Welke bijlagen worden een document? Alleen PDF, JPG, PNG en e-facturen (UBL-XML), gecontroleerd op
 * de inhoud, niet te groot, geen logo's. Staat er een e-factuur bij, dan alleen die: de PDF ernaast is
 * dezelfde factuur.
 */
export function usableAttachments(attachments: MailAttachment[]): { name: string; data: Uint8Array }[] {
  const ok = attachments
    .filter((a) => a.content.length > 0 && a.content.length <= MAIL_LIMITS.maxAttachmentBytes)
    .map((a) => ({ a, kind: kindOf(a) }))
    .filter(({ a, kind }) => kind && !((kind === 'jpg' || kind === 'png') && (a.inline || a.content.length < MAIL_LIMITS.minImageBytes)));
  const ubl = ok.filter((x) => x.kind === 'ubl');
  return (ubl.length > 0 ? ubl : ok).slice(0, MAIL_LIMITS.maxAttachmentsPerMail).map(({ a, kind }) => ({ name: safeName(a.filename, kind!), data: a.content }));
}

/** Bestandsnaam zonder mappen of rare tekens, met de juiste extensie. */
function safeName(name: string, kind: string): string {
  const base = name.split(/[\\/]/).pop()!.replace(/[^\p{L}\p{N} ._()-]/gu, '_').replace(/^\.+/, '').slice(0, 80) || 'bijlage';
  const ext = kind === 'ubl' ? 'xml' : kind;
  return extension(base) === ext || (ext === 'jpg' && extension(base) === 'jpeg') ? base : `${base}.${ext}`;
}

/**
 * "Je factuur staat klaar": een mail over een factuur zonder bijlage, met een link. We geven alleen
 * de naam van de website terug, geen klikbare link (een nep-mail met een link is een bekende truc).
 */
export function onlineInvoiceDomain(m: Pick<MailMessage, 'subject' | 'text'>): string | null {
  const words = /\b(factuur|facturen|nota|rekening|invoice|receipt|kwitantie|betaalbewijs)\b/i;
  if (!words.test(m.subject) && !words.test(m.text.slice(0, 3000))) return null;
  const url = m.text.match(/https:\/\/[^\s<>"')\]]+/i)?.[0];
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Een bon of factuur in de tekst van de mail zelf (geen bijlage), bv. van een webshop of app:
 * een woord als factuur/bon/bestelling én een bedrag in euro's.
 */
export function looksLikeReceipt(m: Pick<MailMessage, 'subject' | 'text'>): boolean {
  const text = m.text.slice(0, 20_000);
  if (text.trim().length < 40) return false;
  const words = /\b(factuur|nota|bon|kassabon|bestelling|bestelbevestiging|orderbevestiging|aankoop|betaalbewijs|kwitantie|receipt|invoice|order|totaal|total)\b/i;
  if (!words.test(m.subject) && !words.test(text)) return false;
  const amount = /(€|eur)\s?-?\d{1,3}(?:[.\s]\d{3})*,\d{2}\b|\b\d{1,3}(?:\.\d{3})*,\d{2}\s?(€|eur)|\b(totaal|total|te betalen|bedrag)\b[^\n\d]{0,25}\d+[.,]\d{2}\b/i;
  return amount.test(text);
}

/**
 * Mailtekst opschonen. Nieuwsbrieven en bonnen (Google, Apple, webshops) zetten vaak een verborgen
 * "preheader" vol onzichtbare tekens (&zwnj;, &#847;, &nbsp;) boven de mail; in de platte tekst worden
 * dat bladzijden met lege regels, zodat de bon zelf pas op pagina 2 of later staat.
 */
export function cleanMailText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00ad\u034f\u180e\u200b-\u200f\u2028\u2029\u2060-\u2064\ufeff]/g, '')
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000\t]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * De mail als eenvoudige pagina om als PDF te bewaren: alleen de platte tekst, dus geen plaatjes,
 * geen links en geen scripts uit de mail (volgpixels en nep-links komen er niet in).
 */
export function receiptHtml(m: Pick<MailMessage, 'fromName' | 'fromAddress' | 'subject' | 'date' | 'text'>): string {
  const from = m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress;
  const body = cleanMailText(m.text).slice(0, 20_000);
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>${escapeHtml(m.subject)}</title>
<style>body{font:11pt/1.45 Helvetica,Arial,sans-serif;margin:32px;color:#111}h1{font-size:14pt;margin:0 0 6px}.meta{color:#555;font-size:9.5pt;margin-bottom:16px;border-bottom:1px solid #ccc;padding-bottom:8px}pre{white-space:pre-wrap;font:inherit;margin:0}</style>
</head><body><h1>${escapeHtml(m.subject || 'Bon uit e-mail')}</h1>
<div class="meta">Van: ${escapeHtml(from)}<br>Datum: ${escapeHtml(m.date)}<br>Bewaard uit e-mail door BoekhoudenVoorNiks</div>
<pre>${escapeHtml(body)}</pre></body></html>`;
}

function receiptFilename(m: Pick<MailMessage, 'subject' | 'date'>): string {
  const base = m.subject.replace(/^(fwd?|fw|doorst|tr|wg):\s*/i, '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 60) || 'bon';
  return `mail ${m.date} ${base}.pdf`;
}

function normalizeAddress(a: string): string {
  return a.trim().toLowerCase();
}

/** Zoveel dagen na de originele mail telt een doorgestuurde kopie nog als dezelfde mail; een maandfactuur komt later. */
export const COPY_WINDOW_DAYS = 21;
/** Bij de mail die blijft liggen omdat hij een kopie is van een mail die al verwerkt is (#229). */
export const COPY_NOTE = 'kopie van een mail die al verwerkt is';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Staat dit nummer als heel woord in de tekst? "0917" in "20260917" of "A-0917-B" telt niet. */
function hasNumber(text: string, number: string): boolean {
  return new RegExp(`(^|[^\\w-])${escapeRe(number)}([^\\w-]|$)`, 'i').test(text);
}

/** Een nummer waar je een factuur aan herkent: lang genoeg, met een cijfer, en geen jaartal ("2026" staat in elke datum). */
function usableNumber(number: string): boolean {
  return number.length >= 4 && /\d/.test(number) && !/^(19|20)\d{2}$/.test(number);
}

/** Bedragen in een tekst, in centen ("€ 1.234,56", "12.99"). Een datum als 01.09.2026 telt niet. */
function amountsIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/(?<![\d.,])(\d{1,3}(?:[.,]\d{3})+|\d+)[.,](\d{2})(?![.,]?\d)/g)) out.add(Number(m[1]!.replace(/[.,]/g, '')) * 100 + Number(m[2]));
  return out;
}

/** Nummers die de tekst zelf een factuur-, bestel- of bonnummer noemt ("Bestelnummer: 880377", "Order #1001"). */
function labelledNumbers(text: string): string[] {
  const re = /\b(?:factuur|bestel|order|kassabon|bon|invoice|receipt)(?:[\s-]?(?:nummer|nr|number|no)\b\.?\s*[:#]?|\s*#)\s*([a-z0-9][\w/.-]{2,})/gi;
  return [...text.matchAll(re)].map((m) => m[1]!.replace(/[.,;:]+$/, '').toLowerCase()).filter((n) => /\d/.test(n));
}

/** Onderwerp om te vergelijken: zonder hoofdletters, dubbele spaties en "Fw:", "Fwd:" of "Re:" ervoor. */
function bareSubject(subject: string): { subject: string; forwarded: boolean } {
  const clean = subject.slice(0, 300).replace(/\s+/g, ' ').trim().toLowerCase();
  const bare = clean.replace(/^(?:(?:re|fwd?|doorst|antw|tr|wg|aw)\s*:\s*)+/, '');
  return { subject: bare, forwarded: bare !== clean };
}

/**
 * Inkomende post: haalt bonnetjes en facturen uit een apart mailadres voor de administratie.
 *
 * Veilig met gelezen en gearchiveerde mail: de app kijkt niet naar "ongelezen", maar onthoudt per map
 * tot welk bericht hij gelezen heeft (UID) en welke berichten hij al zag (Message-ID). Lezen verandert
 * de gelezen-status niet. Er wordt nooit iets verwijderd; alleen mail met een verwerkte bijlage gaat
 * naar de map "Verwerkt", en dan alleen uit de gewone map (nooit uit een archiefmap).
 * Mail van klanten blijft onaangeroerd: die krijg je als seintje op Vandaag.
 * Niets uit de mail wordt vanzelf geboekt: elk document wacht op je controle.
 */
export class MailIntakeService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly intake: IntakeService,
    /** HTML → PDF, om een bon in de mailtekst te bewaren; null = niet mogelijk */
    private pdf: ((html: string) => Promise<Uint8Array>) | null = null,
  ) {}

  /** De scanner voor telefoonberichten per mail (alleen als koppelen aanstaat); null of zonder handler blijft alles zoals bij gewone mail. */
  private telefoon: TelefoonHandler | null = null;

  setPdfRenderer(pdf: ((html: string) => Promise<Uint8Array>) | null): void {
    this.pdf = pdf;
  }

  setTelefoonHandler(handler: TelefoonHandler | null): void {
    this.telefoon = handler;
  }

  /** De mailtekst als PDF-bon toevoegen (wacht op controle, nooit vanzelf geboekt). */
  private async addBodyAsReceipt(key: string, m: MailMessage, asOf: IsoDate): Promise<AddedFiles> {
    if (!this.pdf) throw new Error('Een mail als bon bewaren kan hier niet');
    const data = await this.pdf(receiptHtml(m));
    return this.addFiles(key, m, [{ name: receiptFilename(m), data }], asOf);
  }

  /**
   * Alle bijlagen van één mail bewaren en beoordelen (#179). Niets wordt vanzelf geboekt of gekoppeld:
   * een mogelijk dubbele bon of een bon bij een al geboekte betaling wacht als vraag op Vandaag. Stond
   * een bijlage er al in, dan komt daar een melding van. Pas als dit voor élke bijlage gelukt is, mag de
   * mail naar "Verwerkt"; mislukt er een, dan volgt een fout en blijft de mail staan.
   * Wat bij een eerdere, mislukte poging van dezelfde mail al binnenkwam, telt niet als dubbel.
   */
  private async addFiles(key: string, m: MailMessage, files: { name: string; data: Uint8Array }[], asOf: IsoDate): Promise<AddedFiles> {
    const ids: number[] = [];
    const notices: AddedFiles['notices'] = [];
    const sender = m.fromName || m.fromAddress || null;
    for (const f of files) {
      const sha = createHash('sha256').update(f.data).digest('hex');
      const earlier = this.db.prepare('SELECT document_id FROM mail_attachment_progress WHERE message_key = ? AND sha256 = ?').get(key, sha) as { document_id: number } | undefined;
      if (earlier) {
        if (!ids.includes(earlier.document_id)) ids.push(earlier.document_id);
        continue;
      }
      const d = await this.intake.add(f.name, f.data, asOf, { autoConfirm: false });
      this.db.prepare('INSERT OR IGNORE INTO mail_attachment_progress (message_key, sha256, document_id) VALUES (?, ?, ?)').run(key, sha, d.id);
      if (!ids.includes(d.id)) ids.push(d.id);
      const purchaseId = d.link?.target.kind === 'aankoop' ? d.link.target.id : null;
      if (d.already_present) notices.push({ kind: 'stond-er-al', originalName: f.name, source: 'mail', sender, existingDocumentId: d.id, purchaseId });
      else if (d.outcome === 'dubbel') notices.push({ kind: 'dubbel', originalName: f.name, source: 'mail', sender, existingDocumentId: d.duplicate_of_document_id ?? d.id, purchaseId });
    }
    const unassessed = ids.filter((id) => this.intake.get(id).status === 'nieuw');
    if (unassessed.length > 0) throw new Error('Nog niet alle bijlagen zijn beoordeeld');
    return { ids, notices };
  }

  /** De mail is klaar: vastleggen wat ermee gebeurd is, met de meldingen over bijlagen die er al in stonden. */
  private finish(key: string, added: AddedFiles, record: () => void): void {
    tx(this.db, () => {
      record();
      for (const n of added.notices) this.intake.notify(n);
      this.db.prepare('DELETE FROM mail_attachment_progress WHERE message_key = ?').run(key);
    });
  }

  /** Verwerkte mail naar de map "Verwerkt" (alleen uit de gewone map); lukt dat niet, dan blijft hij staan. */
  private async moveProcessed(source: MailSource, uid: number, main: boolean): Promise<string | null> {
    const target = this.settings.get().mailIn.processedFolder;
    if (!main || !target) return null;
    try {
      await source.move(uid, target);
      return target;
    } catch {
      return null;
    }
  }

  /**
   * "Toch als bon bewaren" voor een mail die bleef liggen: haalt hem opnieuw op (zelfde map, zelfde
   * bericht, gecontroleerd op de Message-ID) en bewaart de tekst als bon.
   */
  async saveAsReceipt(source: MailSource, id: number, asOf: IsoDate = today()): Promise<MailRecord> {
    const rec = this.get(id);
    if (!['overig', 'online-factuur'].includes(rec.outcome) || rec.note === TELEFOON_NOTE) throw new Error('Deze mail is al verwerkt, of komt van een klant');
    const box = await source.open(rec.folder);
    if (!box) throw new Error(`De map "${rec.folder}" bestaat niet meer`);
    const m = await source.fetch(rec.uid);
    const key = m?.messageId ? `id:${m.messageId}` : null;
    // hetzelfde bericht? (bij een Message-ID moet die kloppen; de UID kan intussen van een ander bericht zijn)
    if (!m || (rec.message_key.startsWith('id:') && key !== rec.message_key)) {
      throw new Error('Deze mail staat niet meer op dezelfde plek (verplaatst of verwijderd). Sla hem zelf op als PDF en zet hem bij Aankopen.');
    }
    const added = await this.addBodyAsReceipt(rec.message_key, m, asOf);
    const main = rec.folder === (this.settings.get().mailIn.folder || 'INBOX');
    const movedTo = await this.moveProcessed(source, rec.uid, main);
    this.finish(rec.message_key, added, () =>
      this.db
        .prepare(`UPDATE mail_messages SET outcome = 'bijlage', document_ids = ?, note = ?, moved_to = ? WHERE id = ?`)
        .run(JSON.stringify(added.ids), 'mailtekst als bon bewaard', movedTo, id),
    );
    return this.get(id);
  }

  private seen(key: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM mail_messages WHERE message_key = ?').get(key));
  }

  /** Klanten op mailadres (een relatie kan meerdere adressen hebben, gescheiden door , of ;). */
  private customersByAddress(): Map<string, number> {
    const rows = this.db.prepare(`SELECT id, email FROM relations WHERE email IS NOT NULL AND email != '' AND (type IN ('klant','beide') OR id IN (SELECT relation_id FROM invoices))`).all() as { id: number; email: string }[];
    const map = new Map<string, number>();
    for (const r of rows) for (const a of r.email.split(/[,;\s]+/)) if (EMAIL.test(a)) map.set(normalizeAddress(a), r.id);
    return map;
  }

  private ownAddresses(): Set<string> {
    const s = this.settings.get();
    return new Set([s.smtp.fromEmail, s.smtp.replyTo, s.smtp.user, s.mailIn.user, s.company.email].filter((a) => a && EMAIL.test(a)).map(normalizeAddress));
  }

  /**
   * Een kopie van je eigen factuur of offerte (bv. een stille kopie aan jezelf)? Herkend aan een van
   * je eigen factuur- of offertenummers in het onderwerp of de bestandsnaam. Een factuur die je zelf
   * doorstuurt (bv. "Fwd: factuur van Knab") is géén eigen factuur en wordt gewoon verwerkt.
   */
  private isOwnDocument(m: MailMessage): boolean {
    const numbers = (this.db.prepare(`SELECT number FROM invoices WHERE number IS NOT NULL UNION SELECT number FROM quotes WHERE number IS NOT NULL`).all() as { number: string }[]).map((r) => r.number);
    if (numbers.length === 0) return false;
    const haystack = [m.subject, ...m.attachments.map((a) => a.filename)].join(' ');
    return numbers.some((n) => new RegExp(`(^|[^\\w-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w-]|$)`).test(haystack));
  }

  /** Wat de app weet van de documenten uit een eerdere mail: factuurnummers en totaalbedragen (ook in een vreemde munt). */
  private documentFacts(ids: number[]): { numbers: string[]; totals: Set<number> } {
    const numbers: string[] = [];
    const totals = new Set<number>();
    const add = (number: string | null | undefined, total: number | null | undefined) => {
      const n = (number ?? '').trim().toLowerCase();
      if (usableNumber(n) && !numbers.includes(n)) numbers.push(n);
      if (total) totals.add(Math.abs(total));
    };
    for (const id of ids) {
      const row = this.db.prepare('SELECT d.result, p.supplier_reference, p.total FROM documents d LEFT JOIN purchase_invoices p ON p.id = d.purchase_invoice_id WHERE d.id = ?').get(id) as { result: string | null; supplier_reference: string | null; total: number | null } | undefined;
      if (!row) continue;
      const result = row.result ? (JSON.parse(row.result) as { invoiceNumber?: { value?: string } | null; total?: { value?: number } | null; foreign?: { total?: number } | null }) : null;
      add(result?.invoiceNumber?.value, result?.total?.value);
      add(null, result?.foreign?.total);
      // na het controleren: wat de gebruiker zelf verbeterde
      add(row.supplier_reference, row.total);
    }
    return { numbers, totals };
  }

  /**
   * Een doorgestuurde kopie ("Fw:", "Fwd:", "Re:") zonder bijlage van een mail waarvan de bijlage (of de
   * tekst) al een document is (#229): er is niets meer te doen. Alleen als jij hem zelf doorstuurt of de
   * afzender van toen hem nog eens stuurt, én de inhoud die van toen is. Hetzelfde onderwerp zegt weinig
   * ("Uw factuur", "Bedankt voor je bestelling"), dus:
   *  - het factuurnummer van toen staat erin (als heel woord): een kopie, ook later nog;
   *  - anders alleen kort na de originele mail (de factuur van een volgende maand heeft vaak hetzelfde
   *    onderwerp en is wel nieuw). Staat er in de tekst zelf een bon, dan moet het bedrag van toen erin staan
   *    en geen ander factuur- of bestelnummer. Staat er alleen een link naar een factuur in, dan moet de
   *    afzender van toen in de doorgestuurde tekst staan. Staat er geen van beide in, dan valt er niets te doen.
   * Bij twijfel is het geen kopie: de mail gaat de gewone weg (bon uit de tekst met de dubbel-controle, of
   * het seintje dat de factuur online staat), zodat er nooit stil een aankoop wegvalt.
   */
  private isCopyOfProcessed(m: MailMessage, fromOwner: boolean, own: Set<string>): boolean {
    const { subject, forwarded } = bareSubject(m.subject);
    if (!forwarded || !subject) return false;
    const from = normalizeAddress(m.fromAddress);
    const earlier = (this.db.prepare(`SELECT from_address, subject, received_on, document_ids FROM mail_messages WHERE outcome = 'bijlage' AND subject IS NOT NULL`).all() as Pick<MailRecord, 'from_address' | 'subject' | 'received_on' | 'document_ids'>[])
      .filter((r) => bareSubject(r.subject!).subject === subject && (fromOwner || normalizeAddress(r.from_address ?? '') === from));
    if (earlier.length === 0) return false;
    const text = `${m.subject}\n${m.text}`;
    const receipt = looksLikeReceipt(m);
    const link = onlineInvoiceDomain(m) !== null;
    const amounts = amountsIn(text);
    const named = labelledNumbers(text);
    return earlier.some((r) => {
      const facts = this.documentFacts(JSON.parse(r.document_ids) as number[]);
      if (facts.numbers.some((n) => hasNumber(text, n))) return true;
      const days = r.received_on ? diffDays(r.received_on, m.date) : null;
      if (days === null || days < 0 || days > COPY_WINDOW_DAYS) return false;
      if (receipt) {
        // een bon in de tekst: alleen dezelfde als het bedrag van toen erin staat en er geen ander nummer genoemd wordt
        const otherNumber = facts.numbers.length > 0 && named.some((n) => !facts.numbers.includes(n));
        return !otherNumber && [...facts.totals].some((t) => amounts.has(t));
      }
      if (!link) return true;
      const sender = normalizeAddress(r.from_address ?? '');
      return !fromOwner || (sender !== '' && !own.has(sender) && text.toLowerCase().includes(sender));
    });
  }

  async poll(source: MailSource, asOf: IsoDate = today()): Promise<PollResult> {
    const cfg = this.settings.get().mailIn;
    const result: PollResult = { documents: 0, onlineInvoices: 0, fromCustomers: 0, other: 0, errors: 0, missingFolders: [] };
    const customers = this.customersByAddress();
    const own = this.ownAddresses();
    const since = /^\d{4}-\d{2}-\d{2}$/.test(cfg.since) ? cfg.since : null;
    const folders = [cfg.folder || 'INBOX', ...cfg.extraFolders.filter((f) => f && f !== cfg.folder && f !== cfg.processedFolder)];
    let budget = MAIL_LIMITS.maxMessagesPerPoll;
    // telefoonberichten worden alleen herkend als de route aanstaat en de scanner er is
    const telefoon = PHONE_SCANNER.available && this.telefoon?.actief() ? this.telefoon : null;

    for (const [index, folder] of folders.entries()) {
      const main = index === 0;
      const box = await source.open(folder);
      if (!box) {
        result.missingFolders.push(folder);
        continue;
      }
      const state = this.db.prepare('SELECT uid_validity, last_uid FROM mail_folders WHERE folder = ?').get(folder) as { uid_validity: string; last_uid: number } | undefined;
      // map opnieuw aangemaakt of verhuisd: alles opnieuw bekijken; wat we al zagen, herkennen we aan de Message-ID
      const afterUid = state && state.uid_validity === box.uidValidity ? state.last_uid : 0;
      const setLast = (uid: number) =>
        this.db
          .prepare(`INSERT INTO mail_folders (folder, uid_validity, last_uid, checked_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(folder) DO UPDATE SET uid_validity = excluded.uid_validity, last_uid = excluded.last_uid, checked_at = excluded.checked_at`)
          .run(folder, box.uidValidity, uid);
      setLast(afterUid);

      /**
       * Mislukt: niet meteen opgeven (vaak is de verbinding even weg). De map stopt hier en de
       * volgende keer proberen we dit bericht opnieuw; pas na een paar keer slaan we het over.
       */
      const failed = (uid: number, m: MailMessage | null, key: string, note: string): 'opnieuw' | 'overgeslagen' => {
        const row = this.db.prepare('SELECT failed_uid, failed_count FROM mail_folders WHERE folder = ?').get(folder) as { failed_uid: number | null; failed_count: number };
        const count = row.failed_uid === uid ? row.failed_count + 1 : 1;
        result.errors++;
        if (count < MAIL_LIMITS.maxAttempts) {
          this.db.prepare('UPDATE mail_folders SET failed_uid = ?, failed_count = ? WHERE folder = ?').run(uid, count, folder);
          return 'opnieuw';
        }
        if (!this.seen(key)) this.record(key, folder, uid, m, 'fout', { note });
        this.db.prepare('UPDATE mail_folders SET failed_uid = NULL, failed_count = 0 WHERE folder = ?').run(folder);
        setLast(uid);
        return 'overgeslagen';
      };

      for (const uid of await source.list(afterUid, since)) {
        if (budget-- <= 0) break;
        let m: MailMessage | null = null;
        try {
          m = await source.fetch(uid);
        } catch {
          m = null;
        }
        const key = m?.messageId ? `id:${m.messageId}` : `uid:${folder}:${box.uidValidity}:${uid}`;
        if (!m) {
          if (failed(uid, null, key, 'Kon dit bericht niet lezen') === 'opnieuw') break;
          continue;
        }
        if (this.seen(key)) {
          setLast(uid);
          continue;
        }
        const from = normalizeAddress(m.fromAddress);
        try {
          if (telefoon && telefoonBijlagen(m.attachments).length > 0) {
            // een telefoonbericht gaat vóór de takken eigen adres en klant: de afzender, het onderwerp en de tekst tellen niet
            if ((await this.telefoonMail(telefoon, source, folder, main, uid, key, m, setLast, result)) === 'opnieuw') break;
            continue;
          }
          if (own.has(from) && this.isOwnDocument(m)) {
            // een kopie (bcc) van je eigen factuur of offerte: geen inkoop
            this.record(key, folder, uid, m, 'eigen');
            result.other++;
          } else if (customers.has(from) && !own.has(from)) {
            // klant: niet aankomen, ook geen bijlagen als bonnetje (bv. een getekende offerte). Je eigen adres is
            // nooit een klant, ook niet als je eigen bedrijf als klant in de app staat (#229)
            this.record(key, folder, uid, m, 'klant', { relationId: customers.get(from)! });
            result.fromCustomers++;
          } else {
            const files = usableAttachments(m.attachments);
            if (files.length > 0) {
              // eerst alle bijlagen bewaren en beoordelen, dan pas de mail verplaatsen
              const added = await this.addFiles(key, m, files, asOf);
              const movedTo = await this.moveProcessed(source, uid, main);
              this.finish(key, added, () => this.record(key, folder, uid, m!, 'bijlage', { documentIds: added.ids, movedTo }));
              result.documents += added.ids.length;
            } else if (this.isCopyOfProcessed(m, own.has(from), own)) {
              // de factuur uit de originele mail staat er al: geen tweede bon uit de tekst en geen seintje (#229)
              this.record(key, folder, uid, m, 'overig', { note: COPY_NOTE });
              result.other++;
            } else if (this.pdf && looksLikeReceipt(m)) {
              // de bon staat in de mail zelf (webshop, app): de tekst als PDF bewaren
              const added = await this.addBodyAsReceipt(key, m, asOf);
              const movedTo = await this.moveProcessed(source, uid, main);
              this.finish(key, added, () => this.record(key, folder, uid, m!, 'bijlage', { documentIds: added.ids, movedTo, note: 'mailtekst als bon bewaard' }));
              result.documents++;
            } else {
              const domain = onlineInvoiceDomain(m);
              if (domain) {
                this.record(key, folder, uid, m, 'online-factuur', { linkDomain: domain });
                result.onlineInvoices++;
              } else {
                this.record(key, folder, uid, m, 'overig');
                result.other++;
              }
            }
          }
        } catch (e) {
          // bijlagen die al binnen waren, worden bij een nieuwe poging herkend (mail_attachment_progress)
          if (failed(uid, m, key, (e as Error).message.slice(0, 300)) === 'opnieuw') break;
          continue;
        }
        setLast(uid);
      }
    }
    return result;
  }

  /**
   * Een mail met telefoonberichten (.bvns-bijlagen): elke bijlage gaat door dezelfde functie als de bonnenmap (route mail). Het register van
   * de synchronisatie zorgt dat een bijlage die bij een eerdere poging al was toegepast niet dubbel telt.
   * - Definitief (ook een probleem): de mail en de probleemregels worden samen vastgelegd, daarna gaat de mail naar de verwerkt-map.
   * - Herhaalbaar: de mail blijft onverwerkt (niet vastgelegd, niet verplaatst) en de map gaat niet verder; er is een eigen, ruimere teller
   *   (MAIL_TELEFOON_LIMITS.maxPogingen) naast de teller van gewone mail. Na de grens wordt de mail als probleem vastgelegd (en blijft hij
   *   in de mailbox staan) en gaat de map verder.
   * De pc antwoordt nooit per mail en schrijft niets naar de mailbox behalve het verplaatsen.
   */
  private async telefoonMail(
    handler: TelefoonHandler,
    source: MailSource,
    folder: string,
    main: boolean,
    uid: number,
    key: string,
    m: MailMessage,
    setLast: (uid: number) => void,
    result: PollResult,
  ): Promise<'klaar' | 'opnieuw' | 'overgeslagen'> {
    const alle = telefoonBijlagen(m.attachments);
    const problemen: { naam: string; probleem: Probleem }[] = [];
    let herhaal = false;
    for (const a of alle.slice(0, MAIL_TELEFOON_LIMITS.maxBvnsPerMail)) {
      const naam = bijlageNaam(a);
      if (a.content.length > MAIL_TELEFOON_LIMITS.maxBvnsBytes) {
        // te groot: definitief afgewezen zonder de inhoud te verwerken
        problemen.push({ naam, probleem: onleesbaar('te-groot').afronding.probleem! });
        continue;
      }
      let uitslag: ReturnType<TelefoonHandler['verwerk']>;
      try {
        uitslag = handler.verwerk(Buffer.from(a.content.buffer, a.content.byteOffset, a.content.byteLength));
      } catch {
        uitslag = 'herhaal';
      }
      if (uitslag === 'herhaal') {
        herhaal = true;
        break;
      }
      try {
        uitslag.na?.();
      } catch {
        /* een nieuwe bon naar de inbox kan later nog */
      }
      if (uitslag.probleem) problemen.push({ naam, probleem: uitslag.probleem });
    }
    if (!herhaal && alle.length > MAIL_TELEFOON_LIMITS.maxBvnsPerMail) {
      // meer dan de grens: de rest wordt niet verwerkt maar wel vastgelegd
      problemen.push({ naam: bijlageNaam(alle[MAIL_TELEFOON_LIMITS.maxBvnsPerMail]!), probleem: { soort: 'afgewezen', apparaat: null, fout: 'te-veel-bijlagen', veld: null } });
    }

    const rij = this.db.prepare('SELECT telefoon_uid, telefoon_pogingen FROM mail_folders WHERE folder = ?').get(folder) as { telefoon_uid: number | null; telefoon_pogingen: number };
    const pogingen = (rij.telefoon_uid === uid ? rij.telefoon_pogingen : 0) + 1;
    if (herhaal && pogingen < MAIL_TELEFOON_LIMITS.maxPogingen) {
      this.db.prepare('UPDATE mail_folders SET telefoon_uid = ?, telefoon_pogingen = ? WHERE folder = ?').run(uid, pogingen, folder);
      return 'opnieuw';
    }
    if (herhaal) problemen.push({ naam: bijlageNaam(alle[0]!), probleem: { soort: 'afgewezen', apparaat: null, fout: 'te-vaak-geprobeerd', veld: null } });

    // mail en probleemregels samen; bij een mislukking (bv. de administratie gaat dicht) blijft alles onverwerkt
    const nu = Date.now();
    tx(this.db, () => {
      for (const { naam, probleem } of problemen) legProbleem(this.db, probleem, naam, 'mail', nu);
      this.record(key, folder, uid, m, herhaal ? 'fout' : 'overig', { note: herhaal ? `${TELEFOON_NOTE}: te vaak opnieuw geprobeerd` : TELEFOON_NOTE });
      this.db.prepare('UPDATE mail_folders SET telefoon_uid = NULL, telefoon_pogingen = 0 WHERE folder = ?').run(folder);
    });
    if (herhaal) {
      // de mail blijft in de mailbox staan; de map gaat verder
      result.errors++;
    } else {
      const movedTo = await this.moveProcessed(source, uid, main);
      if (movedTo) this.db.prepare('UPDATE mail_messages SET moved_to = ? WHERE message_key = ?').run(movedTo, key);
      result.other++;
    }
    setLast(uid);
    return herhaal ? 'overgeslagen' : 'klaar';
  }

  private record(
    key: string,
    folder: string,
    uid: number,
    m: MailMessage | null,
    outcome: MailOutcome,
    extra: { relationId?: number; linkDomain?: string; documentIds?: number[]; note?: string; movedTo?: string | null } = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO mail_messages (message_key, folder, uid, from_address, from_name, subject, received_on, outcome, relation_id, link_domain, document_ids, note, moved_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        folder,
        uid,
        m?.fromAddress.slice(0, 200) ?? null,
        m?.fromName.slice(0, 200) ?? null,
        m?.subject.slice(0, 300) ?? null,
        m?.date ?? null,
        outcome,
        extra.relationId ?? null,
        extra.linkDomain ?? null,
        JSON.stringify(extra.documentIds ?? []),
        extra.note ?? null,
        extra.movedTo ?? null,
      );
  }

  get(id: number): MailRecord {
    const r = this.db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(id) as MailRecord | undefined;
    if (!r) throw new Error('Bericht niet gevonden');
    return r;
  }

  /** Voor Vandaag: facturen die online staan en mail van klanten. Mail van je eigen adres is geen mail van een klant (#229). */
  attention(): (MailRecord & { relation_name: string | null })[] {
    const own = this.ownAddresses();
    return (this.db
      .prepare(`SELECT m.*, r.name AS relation_name FROM mail_messages m LEFT JOIN relations r ON r.id = m.relation_id WHERE m.outcome IN ('online-factuur','klant') ORDER BY m.id DESC LIMIT 50`)
      .all() as (MailRecord & { relation_name: string | null })[]).filter((m) => !(m.outcome === 'klant' && own.has(normalizeAddress(m.from_address ?? ''))));
  }

  /** Mail van deze klant (nieuwste eerst), voor het seintje bij de klant en de factuur. */
  fromCustomer(relationId: number): MailRecord[] {
    return this.db.prepare(`SELECT * FROM mail_messages WHERE outcome = 'klant' AND relation_id = ? ORDER BY id DESC LIMIT 10`).all(relationId) as MailRecord[];
  }

  /** Overzicht voor Instellingen: wat is er de afgelopen tijd binnengekomen? */
  summary(): { lastChecked: string | null; counts: Record<MailOutcome, number>; recent: MailRecord[] } {
    const lastChecked = (this.db.prepare('SELECT MAX(checked_at) AS t FROM mail_folders').get() as { t: string | null }).t;
    const counts = { bijlage: 0, 'online-factuur': 0, klant: 0, eigen: 0, overig: 0, fout: 0 } as Record<MailOutcome, number>;
    for (const r of this.db.prepare(`SELECT outcome, COUNT(*) AS n FROM mail_messages GROUP BY outcome`).all() as { outcome: MailOutcome; n: number }[]) counts[r.outcome] = r.n;
    const recent = this.db.prepare('SELECT * FROM mail_messages ORDER BY id DESC LIMIT 20').all() as MailRecord[];
    return { lastChecked, counts, recent };
  }
}
