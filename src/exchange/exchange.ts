import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { AccountCategory } from '../core-ledger/accounts';
import type { Ledger } from '../core-ledger/ledger';
import type { PeriodCloseService } from '../closing/period-close';
import type { SettingsService } from '../settings/settings';
import type { SecretStore } from '../integrations/types';
import type { Cents } from '../shared/money';
import { assertIsoDate, formatDateNl, today, type IsoDate } from '../shared/dates';
import { ValidationError } from '../shared/validation';
import { formatEuro } from '../shared/money';
import { assertOfficePublicKey, checkCode, newExchangeKey, openAsOffice, openWithKey, readHeader, sealForOffice, sealWithKey, type OfficeKeys, type PackageHeader } from './crypto';

/**
 * Uitwisseling met de boekhouder (docs/uitwisseling.md), naar het model van de periode-uitwisseling in
 * SnelStart: de klant stuurt een periode, de boekhouder corrigeert in zijn kopie, de klant leest het
 * antwoord in. De administratie van de klant is altijd de echte; er wordt nooit samengevoegd.
 *
 * - Klant: uitnodiging openen (koppelen), export maken (periode gaat op slot), antwoord inlezen.
 * - Kantoor: uitnodiging maken, export openen als kopie, handelingen doen, antwoord maken.
 *
 * Het antwoord is een lijst handelingen (correctieboeking, terugdraaien, rekening toevoegen) die de app
 * van de klant opnieuw uitvoert. In de kopie kan verder niets geboekt worden, zodat alles wat de
 * boekhouder doet ook bij de klant terechtkomt.
 */

/** Het kantoor, bij de boekhouder zelf bewaard (niet in een administratie). */
export interface OfficeProfile extends OfficeKeys {
  office: string;
  email: string;
}

/** Bij de klant: aan welk kantoor deze administratie gekoppeld is. */
export interface ExchangePartner {
  office: string;
  email: string;
  publicKey: string;
  code: string;
  linkedAt: string;
}

/** Een correctie van de boekhouder, zoals hij in het antwoord staat. */
export type ExchangeAction =
  | { kind: 'memoriaal'; input: { date: IsoDate; description: string; lines: { account: string; debit?: Cents; credit?: Cents }[] } }
  | { kind: 'terugdraaien'; input: { entry: EntryRef; date: IsoDate } }
  | { kind: 'rekening'; input: { code: string; rgs: string; rgsRef?: string | null; name: string; category: AccountCategory } };

/** Een correctie zoals de boekhouder hem in de kopie doet (terugdraaien met het nummer van de post hier). */
export type CopyAction =
  | Extract<ExchangeAction, { kind: 'memoriaal' }>
  | { kind: 'terugdraaien'; input: { entryId: number; date: IsoDate } }
  | Extract<ExchangeAction, { kind: 'rekening' }>;

/** Een journaalpost die al bij de klant bestond (id), of die een eerdere handeling in dit antwoord maakte. */
export type EntryRef = { id: number } | { action: number; index: number };

interface ExportMeta {
  /** sleutel K voor het antwoord, base64 */
  key: string;
  company: string;
  email: string;
  createdAt: string;
}

interface AnswerBody {
  office: string;
  actions: (ExchangeAction & { seq: number; summary: string })[];
}

/** In de kopie bij de boekhouder: waar het antwoord heen moet. */
interface ReturnInfo {
  company: string;
  email: string;
  /** hoogste id's bij het inlezen: alles daarboven maakte de boekhouder */
  baseEntryId: number;
  answeredAt: string | null;
}

const INVITE_TYPE = 'boekhoudenvoorniks-uitnodiging';
const ANSWER_KEY = 'exchange:answer-key';
const exportKeySecret = (no: number) => `exchange:key:${no}`;

export class ExchangeService {
  /** >0 zolang een vastgelegde handeling van de boekhouder loopt */
  private recording = 0;

  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly settings: SettingsService,
    private readonly periods: PeriodCloseService,
    private readonly secrets: SecretStore,
  ) {
    // in de kopie bij de boekhouder: alleen boeken via een vastgelegde handeling
    ledger.setWriteGuard(() =>
      this.recording === 0 && this.settings.officeCopy()
        ? 'In de kopie voor de boekhouder kun je alleen correctieboekingen maken, boekingen terugdraaien en grootboekrekeningen toevoegen (Boekhouding > expertmodus). Die gaan mee in het antwoord aan je klant.'
        : null,
    );
  }

  // ---- kantoor ------------------------------------------------------------------------------

  /** Uitnodigingsbestand voor een klant: de publieke sleutel van het kantoor is geen geheim. */
  static invite(profile: OfficeProfile): Buffer {
    if (!profile.office.trim()) throw new ValidationError('Vul de naam van je kantoor in');
    return Buffer.from(JSON.stringify({ type: INVITE_TYPE, versie: 1, kantoor: profile.office.trim(), email: profile.email.trim(), publiekeSleutel: profile.publicKey }, null, 2));
  }

  /** Een export van een klant openen (alleen met de sleutel van dit kantoor). */
  static openExport(profile: OfficeProfile, data: Uint8Array, appVersion: string): { header: PackageHeader; meta: ExportMeta; bundle: Buffer } {
    const { header, plain } = openAsOffice(profile, data);
    if (header.appVersie !== appVersion) {
      throw new ValidationError(`Je klant gebruikt versie ${header.appVersie} en jij ${appVersion}. Werk allebei bij naar dezelfde versie; daarna maakt je klant een nieuwe export.`);
    }
    const len = plain.readUInt32BE(0);
    const meta = JSON.parse(plain.subarray(4, 4 + len).toString('utf8')) as ExportMeta;
    return { header, meta, bundle: plain.subarray(4 + len) };
  }

  /** De net uitgepakte administratie wordt de kopie bij de boekhouder. */
  initCopy(header: PackageHeader, meta: ExportMeta, office: string): void {
    tx(this.db, () => {
      if (this.settings.administrationId() !== header.administratie) throw new ValidationError('Deze kopie hoort niet bij deze export');
      // bij de boekhouder ligt de periode niet vast: hij boekt er juist in
      this.periods.abortExchange();
      this.settings.markOfficeCopy({ office, exchange: header.uitwisseling, endDate: header.einddatum });
      const base = (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM journal_entries').get() as { n: number }).n;
      const info: ReturnInfo = { company: meta.company, email: meta.email, baseEntryId: base, answeredAt: null };
      this.setSetting('exchangeReturn', info);
      this.db.prepare(`DELETE FROM settings WHERE key = 'exchangePartner'`).run();
    });
    this.secrets.set(ANSWER_KEY, meta.key);
  }

  /** Een correctie van de boekhouder in de kopie: uitvoeren en vastleggen voor het antwoord. */
  act(action: CopyAction): { entryIds: number[] } {
    const copy = this.settings.officeCopy();
    if (!copy) throw new ValidationError('Dit kan alleen in de kopie van een klant bij de boekhouder');
    const info = this.returnInfo();
    if (info.answeredAt) throw new ValidationError(`Het antwoord is al gemaakt (${formatDateNl(info.answeredAt.slice(0, 10))}). Maak het opnieuw als je nog iets wijzigt.`);
    return tx(this.db, () => {
      this.recording++;
      try {
        let recorded: ExchangeAction;
        let created: number[] = [];
        let summary: string;
        if (action.kind === 'memoriaal') {
          const input = action.input;
          this.assertInPeriod(input.date, copy.endDate);
          created = [this.ledger.post({ ...input, source: 'handmatig' })];
          recorded = { kind: 'memoriaal', input: { date: input.date, description: input.description, lines: input.lines } };
          const total = input.lines.reduce((t, l) => t + (l.debit ?? 0), 0);
          summary = `Correctieboeking ${formatDateNl(input.date)}: ${input.description} (${formatEuro(total)})`;
        } else if (action.kind === 'terugdraaien') {
          const input = action.input;
          this.assertInPeriod(input.date, copy.endDate);
          const entry = this.ledger.getEntry(input.entryId);
          this.assertInPeriod(entry.entry_date, copy.endDate);
          created = [this.ledger.reverse(input.entryId, input.date)];
          recorded = { kind: 'terugdraaien', input: { entry: this.refFor(input.entryId, info.baseEntryId), date: input.date } };
          summary = `Teruggedraaid: ${entry.description} (${formatDateNl(entry.entry_date)})`;
        } else if (action.kind === 'rekening') {
          const input = action.input;
          this.ledger.createAccount(input);
          recorded = { kind: 'rekening', input };
          summary = `Grootboekrekening toegevoegd: ${input.code} ${input.name}`;
        } else {
          throw new ValidationError('Deze handeling kan niet mee in het antwoord');
        }
        this.db.prepare('INSERT INTO exchange_actions (kind, input, created, summary) VALUES (?, ?, ?, ?)').run(recorded.kind, JSON.stringify(recorded.input), JSON.stringify(created), summary);
        return { entryIds: created };
      } finally {
        this.recording--;
      }
    });
  }

  /** Wat de boekhouder in deze kopie deed. */
  actions(): { seq: number; kind: string; summary: string; createdAt: string }[] {
    return this.db.prepare('SELECT id AS seq, kind, summary, created_at AS createdAt FROM exchange_actions ORDER BY id').all() as { seq: number; kind: string; summary: string; createdAt: string }[];
  }

  /**
   * Het antwoord aan de klant: alle handelingen, versleuteld met de sleutel uit zijn export. Markeert
   * nog niets; dat doet `markAnswered` pas als het bestand bewaard is.
   */
  createAnswer(appVersion: string): { file: Buffer; filename: string; count: number; email: string } {
    const copy = this.settings.officeCopy();
    if (!copy) throw new ValidationError('Dit kan alleen in de kopie van een klant bij de boekhouder');
    const key = this.secrets.get(ANSWER_KEY);
    if (!key) throw new ValidationError('De sleutel voor het antwoord ontbreekt; lees de export van je klant opnieuw in');
    const info = this.returnInfo();
    const rows = this.db.prepare('SELECT id, kind, input, summary FROM exchange_actions ORDER BY id').all() as { id: number; kind: ExchangeAction['kind']; input: string; summary: string }[];
    const body: AnswerBody = { office: copy.office, actions: rows.map((r) => ({ seq: r.id, kind: r.kind, input: JSON.parse(r.input), summary: r.summary }) as AnswerBody['actions'][number]) };
    const header = { administratie: this.settings.administrationId(), uitwisseling: copy.exchange, einddatum: copy.endDate, appVersie: appVersion };
    const file = sealWithKey(Buffer.from(key, 'base64'), header, Buffer.from(JSON.stringify(body), 'utf8'));
    return { file, filename: `antwoord-${header.administratie.slice(0, 8)}-${copy.exchange}.gbpakket`, count: rows.length, email: info.email };
  }

  /** Het antwoord is bewaard: vanaf nu geen wijzigingen meer, tenzij bewust heropend. */
  markAnswered(): void {
    this.setSetting('exchangeReturn', { ...this.returnInfo(), answeredAt: new Date().toISOString() });
  }

  /** Na "antwoord gemaakt" toch nog iets wijzigen: het antwoord moet dan opnieuw. */
  reopenAnswer(): void {
    this.setSetting('exchangeReturn', { ...this.returnInfo(), answeredAt: null });
  }

  copyStatus(): (ReturnInfo & { office: string; exchange: number; endDate: IsoDate; actions: number }) | null {
    const copy = this.settings.officeCopy();
    if (!copy) return null;
    return { ...copy, ...this.returnInfo(), actions: this.actions().length };
  }

  // ---- klant --------------------------------------------------------------------------------

  partner(): ExchangePartner | null {
    return this.getSetting<ExchangePartner>('exchangePartner');
  }

  /** Uitnodigingsbestand van het kantoor lezen, zonder al te koppelen: om de controlecode te tonen. */
  static readInvite(data: Uint8Array): { office: string; email: string; publicKey: string; code: string } {
    let raw: { type?: unknown; kantoor?: unknown; email?: unknown; publiekeSleutel?: unknown };
    try {
      raw = JSON.parse(Buffer.from(data).toString('utf8'));
    } catch {
      throw new ValidationError('Dit is geen uitnodiging van een boekhouder');
    }
    if (raw.type !== INVITE_TYPE || typeof raw.kantoor !== 'string' || typeof raw.publiekeSleutel !== 'string') throw new ValidationError('Dit is geen uitnodiging van een boekhouder');
    try {
      assertOfficePublicKey(raw.publiekeSleutel);
    } catch {
      throw new ValidationError('Deze uitnodiging is beschadigd: de sleutel van het kantoor klopt niet. Vraag je boekhouder om een nieuwe.');
    }
    return { office: raw.kantoor, email: typeof raw.email === 'string' ? raw.email : '', publicKey: raw.publiekeSleutel, code: checkCode(raw.publiekeSleutel) };
  }

  /** Koppelen aan het kantoor van de uitnodiging. Een nieuwe uitnodiging vervangt de oude koppeling. */
  link(data: Uint8Array): ExchangePartner {
    if (this.settings.officeCopy()) throw new ValidationError('Dit is de kopie van een klant; koppelen doet de klant zelf');
    if (this.ledger.periodLock().exchange) throw new ValidationError('Er loopt nog een uitwisseling. Lees eerst het antwoord in, of breek hem af.');
    const invite = ExchangeService.readInvite(data);
    const partner: ExchangePartner = { ...invite, linkedAt: new Date().toISOString() };
    this.setSetting('exchangePartner', partner);
    return partner;
  }

  unlink(): void {
    if (this.ledger.periodLock().exchange) throw new ValidationError('Er loopt nog een uitwisseling. Lees eerst het antwoord in, of breek hem af.');
    this.db.prepare(`DELETE FROM settings WHERE key = 'exchangePartner'`).run();
  }

  /**
   * De periode t/m `until` naar de boekhouder: op slot, en versleuteld naar zijn kantoor. `bundle` maakt
   * de administratie als pakket (database zonder geheimen, met bijlagen); dat gebeurt ná het slot, zodat
   * de boekhouder precies krijgt wat er vastligt.
   */
  async createExport(until: IsoDate, confirmed: string[], appVersion: string, bundle: () => Promise<Buffer>, asOf: IsoDate = today()): Promise<{ file: Buffer; filename: string; exchange: number; partner: ExchangePartner }> {
    const partner = this.partner();
    if (!partner) throw new ValidationError('Open eerst de uitnodiging van je boekhouder');
    const no = this.settings.nextCounter('exchange');
    const key = newExchangeKey();
    this.periods.startExchange(until, no, confirmed, asOf);
    try {
      this.secrets.set(exportKeySecret(no), key.toString('base64'));
      const company = this.settings.get().company;
      const meta: ExportMeta = { key: key.toString('base64'), company: company.name, email: company.email, createdAt: new Date().toISOString() };
      const metaBytes = Buffer.from(JSON.stringify(meta), 'utf8');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(metaBytes.length);
      const header = { administratie: this.settings.administrationId(), uitwisseling: no, einddatum: until, appVersie: appVersion };
      const file = sealForOffice(partner.publicKey, header, Buffer.concat([len, metaBytes, await bundle()]));
      return { file, filename: `export-${header.administratie.slice(0, 8)}-${no}.gbpakket`, exchange: no, partner };
    } catch (e) {
      this.periods.abortExchange();
      this.secrets.delete(exportKeySecret(no));
      throw e;
    }
  }

  /** De uitwisseling afbreken: de periode is weer open, een later antwoord past niet meer. */
  abort(): void {
    const ex = this.ledger.periodLock().exchange;
    if (!ex) return;
    this.periods.abortExchange();
    if (ex.no) this.secrets.delete(exportKeySecret(ex.no));
  }

  /**
   * Het antwoord van de boekhouder inlezen: controleren dat het bij deze administratie, deze uitwisseling
   * en deze versie hoort, de handelingen opnieuw uitvoeren in de vergrendelde periode, en afsluiten.
   * Alles of niets.
   */
  readAnswer(data: Uint8Array, appVersion: string): { office: string; count: number; summaries: string[]; closedUntil: IsoDate } {
    const header = readHeader(data);
    if (header.richting !== 'naar-klant') throw new ValidationError('Dit is een export naar de boekhouder, geen antwoord');
    if (header.administratie !== this.settings.administrationId()) throw new ValidationError('Dit antwoord hoort bij een andere administratie');
    const ex = this.ledger.periodLock().exchange;
    if (!ex) throw new ValidationError(`Er loopt geen uitwisseling. Dit antwoord (uitwisseling ${header.uitwisseling}) is al ingelezen of de uitwisseling is afgebroken.`);
    if (ex.no !== header.uitwisseling) throw new ValidationError(`Dit antwoord hoort bij uitwisseling ${header.uitwisseling}, maar de lopende uitwisseling is ${ex.no}`);
    if (header.appVersie !== appVersion) throw new ValidationError(`Je boekhouder gebruikt versie ${header.appVersie} en jij ${appVersion}. Werk bij naar dezelfde versie en lees het antwoord dan opnieuw in.`);
    const key = this.secrets.get(exportKeySecret(ex.no));
    if (!key) throw new ValidationError('De sleutel van deze uitwisseling ontbreekt (bv. na een nieuwe installatie). Breek de uitwisseling af en maak een nieuwe export.');
    const body = JSON.parse(openWithKey(Buffer.from(key, 'base64'), data).plain.toString('utf8')) as AnswerBody;
    const until = ex.until;
    this.periods.withoutLock(() => {
      const created = new Map<number, number[]>();
      const resolve = (ref: EntryRef): number => {
        if ('id' in ref) return ref.id;
        const id = created.get(ref.action)?.[ref.index];
        if (id === undefined) throw new ValidationError('Het antwoord verwijst naar een boeking die er niet in staat');
        return id;
      };
      for (const a of body.actions) {
        if (a.kind === 'memoriaal') {
          this.assertInPeriod(a.input.date, until);
          created.set(a.seq, [this.ledger.post({ ...a.input, source: 'handmatig' })]);
        } else if (a.kind === 'terugdraaien') {
          this.assertInPeriod(a.input.date, until);
          const id = resolve(a.input.entry);
          this.assertInPeriod(this.ledger.getEntry(id).entry_date, until);
          created.set(a.seq, [this.ledger.reverse(id, a.input.date)]);
        } else if (a.kind === 'rekening') {
          this.ledger.createAccount(a.input);
        } else {
          throw new ValidationError('Het antwoord bevat een onbekende handeling; werk de app bij');
        }
      }
      this.periods.finishExchange(ex.no!);
    });
    this.secrets.delete(exportKeySecret(ex.no));
    this.setSetting('exchangeLast', { exchange: ex.no, until, office: body.office, count: body.actions.length, readAt: new Date().toISOString() });
    return { office: body.office, count: body.actions.length, summaries: body.actions.map((a) => a.summary), closedUntil: until };
  }

  lastAnswer(): { exchange: number; until: IsoDate; office: string; count: number; readAt: string } | null {
    return this.getSetting('exchangeLast');
  }

  // ---- hulp ---------------------------------------------------------------------------------

  private refFor(entryId: number, baseEntryId: number): EntryRef {
    if (entryId <= baseEntryId) return { id: entryId };
    for (const row of this.db.prepare('SELECT id, created FROM exchange_actions ORDER BY id').all() as { id: number; created: string }[]) {
      const index = (JSON.parse(row.created) as number[]).indexOf(entryId);
      if (index >= 0) return { action: row.id, index };
    }
    throw new ValidationError('Deze boeking kan niet mee in het antwoord');
  }

  private assertInPeriod(date: IsoDate, endDate: IsoDate): void {
    assertIsoDate(date);
    if (date > endDate) throw new ValidationError(`Correcties horen in de periode van de uitwisseling (t/m ${formatDateNl(endDate)})`);
  }

  private returnInfo(): ReturnInfo {
    const info = this.getSetting<ReturnInfo>('exchangeReturn');
    if (!info) throw new ValidationError('Dit is geen kopie uit een export');
    return info;
  }

  private getSetting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  private setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }
}

/** De losse kopie van de database klaarmaken voor de boekhouder: geen geheimen, geen koppelingen of mailinstellingen. */
export function sanitizeForExchange(db: Db): void {
  db.exec(`
    DELETE FROM secrets;
    UPDATE integrations SET enabled = 0, config = '{}';
    DELETE FROM settings WHERE key IN ('smtp', 'mailIn', 'ocr', 'exchangePartner', 'exchangeLast');
  `);
}
