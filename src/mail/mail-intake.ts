import type { Db } from '../db/database';
import type { IntakeService } from '../intake/intake';
import type { SettingsService } from '../settings/settings';
import { today, type IsoDate } from '../shared/dates';

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

function normalizeAddress(a: string): string {
  return a.trim().toLowerCase();
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
  ) {}

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

  async poll(source: MailSource, asOf: IsoDate = today()): Promise<PollResult> {
    const cfg = this.settings.get().mailIn;
    const result: PollResult = { documents: 0, onlineInvoices: 0, fromCustomers: 0, other: 0, errors: 0, missingFolders: [] };
    const customers = this.customersByAddress();
    const own = this.ownAddresses();
    const since = /^\d{4}-\d{2}-\d{2}$/.test(cfg.since) ? cfg.since : null;
    const folders = [cfg.folder || 'INBOX', ...cfg.extraFolders.filter((f) => f && f !== cfg.folder && f !== cfg.processedFolder)];
    let budget = MAIL_LIMITS.maxMessagesPerPoll;

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
          if (own.has(from)) {
            // bv. een kopie (bcc) van je eigen factuur: geen inkoop
            this.record(key, folder, uid, m, 'eigen');
            result.other++;
          } else if (customers.has(from)) {
            // klant: niet aankomen, ook geen bijlagen als bonnetje (bv. een getekende offerte)
            this.record(key, folder, uid, m, 'klant', { relationId: customers.get(from)! });
            result.fromCustomers++;
          } else {
            const files = usableAttachments(m.attachments);
            if (files.length > 0) {
              const ids: number[] = [];
              for (const f of files) ids.push((await this.intake.add(f.name, f.data, asOf, { autoConfirm: false })).id);
              let movedTo: string | null = null;
              if (main && cfg.processedFolder) {
                try {
                  await source.move(uid, cfg.processedFolder);
                  movedTo = cfg.processedFolder;
                } catch {
                  // verplaatsen lukt niet (bv. geen rechten): dan blijft hij staan; we herkennen hem toch
                }
              }
              this.record(key, folder, uid, m, 'bijlage', { documentIds: ids, movedTo });
              result.documents += ids.length;
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
          // bijlagen die al binnen waren, worden bij een nieuwe poging herkend (zelfde bestand)
          if (failed(uid, m, key, (e as Error).message.slice(0, 300)) === 'opnieuw') break;
          continue;
        }
        setLast(uid);
      }
    }
    return result;
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

  /** Voor Vandaag: facturen die online staan en mail van klanten. */
  attention(): (MailRecord & { relation_name: string | null })[] {
    return this.db
      .prepare(`SELECT m.*, r.name AS relation_name FROM mail_messages m LEFT JOIN relations r ON r.id = m.relation_id WHERE m.outcome IN ('online-factuur','klant') ORDER BY m.id DESC LIMIT 50`)
      .all() as (MailRecord & { relation_name: string | null })[];
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
