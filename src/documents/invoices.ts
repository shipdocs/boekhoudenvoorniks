import type { Db } from '../db/database';
import { tx } from '../db/database';
import { Ledger, signedLine, type PostLine } from '../core-ledger/ledger';
import { ACCOUNTS, SALES_ACCOUNTS } from '../core-ledger/accounts';
import { checkInvoiceRequirements, leesFactuurNummer, type FactuurVelden } from '@gratis-boekhouden/kern';
import type { SettingsService } from '../settings/settings';
import type { RelationsService, Relation } from '../relations/relations';
import type { TemplateService } from './templates';
import { renderDocumentHtml, type RenderableParty } from './templates';
import { computeTotals, type DocumentTotals, type LineInput } from './totals';
import { normalizeLines, readLines, toLineInputs, writeLines, type DocLine } from './lines';
import { counterKey, formatDocumentNumber } from './numbering';
import { addDays, assertIsoDate, formatDateNl, today, type IsoDate } from '../shared/dates';
import { assertCents, type Cents } from '../shared/money';
import { ValidationError } from '../shared/validation';

export type InvoiceStatus = 'concept' | 'verzonden' | 'betaald';
export type InvoiceDisplayStatus = 'concept' | 'openstaand' | 'vervallen' | 'betaald';

import { buildInvoiceUbl } from './ubl-out';
import { wijzigJob } from '../jobs/revisie';

/** JSON met alfabetisch gesorteerde sleutels: twee gelijke objecten geven dezelfde tekst, ongeacht de volgorde. */
function canoniek(waarde: unknown): string {
  const sorteer = (w: unknown): unknown => (Array.isArray(w) ? w.map(sorteer) : w && typeof w === 'object' ? Object.fromEntries(Object.entries(w).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sorteer(v)])) : w);
  return JSON.stringify(sorteer(waarde));
}

export interface InvoiceRow {
  id: number;
  /** alleen gevuld bij een factuur die van de telefoon is overgenomen */
  uuid: string | null;
  regeltabel_versie: string | null;
  relation_id: number;
  quote_id: number | null;
  credit_of_invoice_id: number | null;
  number: string | null;
  invoice_date: IsoDate;
  due_date: IsoDate;
  /** datum van levering of dienst, of het begin van de periode; null = de factuurdatum */
  delivery_date: IsoDate | null;
  delivery_date_to: IsoDate | null;
  status: InvoiceStatus;
  template_id: number | null;
  reference: string | null;
  intro: string | null;
  notes: string | null;
  subtotal: Cents | null;
  vat_total: Cents | null;
  total: Cents | null;
  amount_paid: Cents;
  relation_snapshot: string | null;
  company_snapshot: string | null;
  journal_entry_id: number | null;
  sent_at: string | null;
  paid_at: string | null;
  reminder_count: number;
  last_reminder_at: string | null;
  external_source: string | null;
  external_id: string | null;
  /** 1 = uit de vorige administratie (overstap): alleen het openstaande bedrag, geen eigen factuur-PDF */
  is_opening: number;
  created_at: string;
}

export interface Invoice extends InvoiceRow {
  relation_name: string;
  relation_email: string | null;
  lines: DocLine[];
  totals: DocumentTotals;
  open_amount: Cents;
  display_status: InvoiceDisplayStatus;
  days_overdue: number;
}

export interface InvoiceSummary {
  id: number;
  number: string | null;
  relation_id: number;
  relation_name: string;
  invoice_date: IsoDate;
  due_date: IsoDate;
  status: InvoiceStatus;
  display_status: InvoiceDisplayStatus;
  total: Cents;
  amount_paid: Cents;
  open_amount: Cents;
  sent_at: string | null;
  credit_of_invoice_id: number | null;
}

export interface InvoiceDraftInput {
  relationId: number;
  invoiceDate?: IsoDate;
  dueDate?: IsoDate;
  /** datum van levering of dienst (of begin van de periode); leeg = de factuurdatum */
  deliveryDate?: IsoDate | null;
  /** einde van de periode, alleen samen met deliveryDate */
  deliveryDateTo?: IsoDate | null;
  reference?: string | null;
  intro?: string | null;
  notes?: string | null;
  templateId?: number | null;
  quoteId?: number | null;
  lines: LineInput[];
  externalSource?: string | null;
  externalId?: string | null;
}

export interface PaymentInput {
  amount: Cents;
  date: IsoDate;
  /** RGS-code van de geldrekening; standaard de bank */
  moneyAccount?: string;
  bankTransactionId?: number | null;
  description?: string;
}

/** Een factuur van de telefoon zoals de pc hem overneemt: de uuid van de wijziging en de gecontroleerde velden. */
export interface ImportDefinitiefInvoer {
  uuid: string;
  velden: FactuurVelden;
}

export interface ImportDefinitiefResultaat {
  uitkomst: 'nieuw' | 'al_aanwezig' | 'conflict' | 'geweigerd';
  /** Nederlandse uitleg bij conflict of geweigerd, anders null */
  reden: string | null;
  factuurId: number | null;
  /** waar als de boeking op een andere dag staat dan de factuurdatum (een gewoon afgesloten periode) */
  boekingsdatum_verschoven: boolean;
  /** de datum waarop de boeking werkelijk staat */
  boekingsdatum: IsoDate | null;
}

export class InvoiceService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly settings: SettingsService,
    private readonly relations: RelationsService,
    private readonly templates: TemplateService,
  ) {}

  createDraft(input: InvoiceDraftInput): Invoice {
    const relation = this.relations.get(input.relationId);
    const s = this.settings.get();
    const date = input.invoiceDate ?? today();
    assertIsoDate(date, 'factuurdatum');
    const due = input.dueDate ?? addDays(date, relation.payment_term_days ?? s.paymentTermDays);
    assertIsoDate(due, 'vervaldatum');
    const lines = normalizeLines(input.lines);
    const delivery = normalizeDelivery(input.deliveryDate, input.deliveryDateTo);
    return tx(this.db, () => {
      const result = this.db
        .prepare(
          `INSERT INTO invoices (relation_id, quote_id, invoice_date, due_date, delivery_date, delivery_date_to, template_id, reference, intro, notes, external_source, external_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(relation.id, input.quoteId ?? null, date, due, delivery.from, delivery.to, input.templateId ?? null, input.reference ?? null, input.intro ?? null, input.notes ?? null, input.externalSource ?? null, input.externalId ?? null);
      const id = Number(result.lastInsertRowid);
      writeLines(this.db, 'invoice_lines', 'invoice_id', id, lines);
      return this.get(id);
    });
  }

  updateDraft(id: number, input: Partial<InvoiceDraftInput>): Invoice {
    const inv = this.row(id);
    if (inv.status !== 'concept') throw new ValidationError('Een verstuurde factuur kun je niet meer aanpassen. Draai hem terug met "Factuur terugdraaien" en maak een nieuwe.');
    const relationId = input.relationId ?? inv.relation_id;
    this.relations.get(relationId);
    const date = input.invoiceDate ?? inv.invoice_date;
    const due = input.dueDate ?? inv.due_date;
    assertIsoDate(date, 'factuurdatum');
    assertIsoDate(due, 'vervaldatum');
    const lines = input.lines ? normalizeLines(input.lines) : null;
    const delivery = normalizeDelivery(input.deliveryDate !== undefined ? input.deliveryDate : inv.delivery_date, input.deliveryDateTo !== undefined ? input.deliveryDateTo : inv.delivery_date_to);
    return tx(this.db, () => {
      this.db
        .prepare('UPDATE invoices SET relation_id = ?, invoice_date = ?, due_date = ?, delivery_date = ?, delivery_date_to = ?, template_id = ?, reference = ?, intro = ?, notes = ? WHERE id = ?')
        .run(
          relationId,
          date,
          due,
          delivery.from,
          delivery.to,
          input.templateId !== undefined ? input.templateId : inv.template_id,
          input.reference !== undefined ? input.reference : inv.reference,
          input.intro !== undefined ? input.intro : inv.intro,
          input.notes !== undefined ? input.notes : inv.notes,
          id,
        );
      if (lines) writeLines(this.db, 'invoice_lines', 'invoice_id', id, lines);
      return this.get(id);
    });
  }

  deleteDraft(id: number): void {
    const inv = this.row(id);
    if (inv.status !== 'concept') throw new ValidationError('Een verstuurde factuur moet je 7 jaar bewaren en kun je niet verwijderen. Draai hem terug met "Factuur terugdraaien".');
    tx(this.db, () => {
      this.db.prepare('UPDATE quotes SET status = ? WHERE id = ? AND status = ?').run('geaccepteerd', inv.quote_id, 'gefactureerd');
      // werkbonregels komen weer vrij, en de klus is weer "klaar" als er geen andere factuur meer is (#32)
      const jobId = (this.db.prepare('SELECT job_id FROM invoices WHERE id = ?').get(id) as { job_id: number | null } | undefined)?.job_id ?? null;
      this.db.prepare('UPDATE job_work_items SET invoice_id = NULL WHERE invoice_id = ?').run(id);
      this.db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
      if (jobId && !this.db.prepare('SELECT 1 FROM invoices WHERE job_id = ?').get(jobId)) {
        const job = this.db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string } | undefined;
        if (job?.status === 'gefactureerd') wijzigJob(this.db, jobId, { status: 'klaar' });
      }
    });
  }

  /**
   * Maakt een concept definitief: ken een doorlopend factuurnummer toe, bevries klant- en
   * bedrijfsgegevens en totalen, en boek automatisch de journaalpost. Alles in één transactie.
   */
  finalize(id: number): Invoice {
    return tx(this.db, () => {
      const inv = this.get(id);
      if (inv.status !== 'concept') throw new ValidationError(`Factuur ${inv.number} is al definitief`);
      const s = this.settings.get();
      const relation = this.relations.get(inv.relation_id);
      checkInvoiceRequirements(inv, relation, s.kor, s.company);

      const key = counterKey('factuur', s.invoiceNumberFormat, inv.invoice_date);
      const seq = this.settings.nextCounter(key);
      const number = formatDocumentNumber(s.invoiceNumberFormat, inv.invoice_date, seq);
      if (this.db.prepare('SELECT 1 FROM invoices WHERE number = ?').get(number)) {
        throw new ValidationError(`Factuurnummer ${number} bestaat al. Pas je factuurnummer aan bij Instellingen → Facturen & offertes`);
      }
      const totals = inv.totals;
      const entryId = this.postInvoice(id, inv.invoice_date, this.vatDateOption(inv.lines.map((l) => l.vat_code), inv.invoice_date, inv.delivery_date, inv.delivery_date_to), totals, relation.id, relation.name, number);
      this.db
        .prepare(
          `UPDATE invoices SET number = ?, status = 'verzonden', subtotal = ?, vat_total = ?, total = ?,
             relation_snapshot = ?, company_snapshot = ?, journal_entry_id = ? WHERE id = ?`,
        )
        .run(number, totals.subtotal, totals.vatTotal, totals.total, JSON.stringify(relation), JSON.stringify(s.company), entryId, id);

      if (inv.credit_of_invoice_id) this.settleCreditAgainstOriginal(id, inv.credit_of_invoice_id);
      return this.get(id);
    });
  }

  /**
   * Neemt een definitieve factuur van de telefoon over als verzonden factuur, met dezelfde boeking en
   * btw als een pc-factuur (journalLines, btw-datum en weigerregel zijn gedeeld met finalize). Het nummer
   * (M1-2026-0001) is dat van de telefoon: de pc-teller wordt niet gebruikt en geen instelling wijzigt.
   * `invoer` is de uuid van de wijziging met de velden uit leesFactuurVelden. Alles in een transactie met een terugdraaipunt: een geweigerde
   * of mislukte import laat geen halve rijen achter. De factuur wordt hierna nooit meer bewerkt.
   *
   * Dezelfde uuid met dezelfde inhoud is al_aanwezig, met afwijkende inhoud conflict (er verandert niets);
   * een bestaand nummer van een andere factuur of een onbekende creditnota_van is geweigerd. Een periode
   * bij de boekhouder of een beginbalans-slot geeft ook geweigerd; een gewoon afgesloten periode schuift de
   * boeking naar de eerste open dag. Het zoeken van project_uuid naar een klus is aan de aanroeper: jobId.
   */
  importDefinitive(invoer: ImportDefinitiefInvoer, relationId: number, jobId: number | null = null): ImportDefinitiefResultaat {
    return tx(this.db, () => {
      this.db.exec('SAVEPOINT import_definitief');
      try {
        const resultaat = this.importDefinitiefBinnenTx(invoer.uuid, invoer.velden, relationId, jobId);
        if (resultaat.uitkomst === 'nieuw') this.db.exec('RELEASE import_definitief');
        else {
          this.db.exec('ROLLBACK TO import_definitief');
          this.db.exec('RELEASE import_definitief');
        }
        return resultaat;
      } catch (e) {
        this.db.exec('ROLLBACK TO import_definitief');
        this.db.exec('RELEASE import_definitief');
        if (e instanceof ValidationError) return { uitkomst: 'geweigerd', reden: e.message, factuurId: null, boekingsdatum_verschoven: false, boekingsdatum: null };
        throw e;
      }
    });
  }

  private importDefinitiefBinnenTx(uuid: string, f: FactuurVelden, relationId: number, jobId: number | null): ImportDefinitiefResultaat {
    const geweigerd = (reden: string): ImportDefinitiefResultaat => ({ uitkomst: 'geweigerd', reden, factuurId: null, boekingsdatum_verschoven: false, boekingsdatum: null });
    const reeks = leesFactuurNummer(f.nummer);
    if (!reeks.ok) return geweigerd(reeks.melding);
    const delivery = normalizeDelivery(f.leverdatum, f.leverdatum_tot);
    // dezelfde afronding als normalizeLines (createDraft): een afwijkende hoeveelheid zou anders anders boeken dan op de pc
    for (const r of f.regels) {
      if (Math.round(r.hoeveelheid * 1000) / 1000 !== r.hoeveelheid) return geweigerd('Een hoeveelheid op de factuur heeft meer dan drie decimalen.');
    }
    const lines = f.regels.map((r) => ({ description: r.omschrijving, quantity: r.hoeveelheid, unit: r.eenheid, unitPrice: r.prijs, vatCode: r.btw_soort, vatPercentage: r.btw_percentage }));
    const totals = computeTotals(lines);
    if (totals.subtotal !== f.totalen.subtotaal || totals.vatTotal !== f.totalen.btw || totals.total !== f.totalen.totaal) {
      return geweigerd('De totalen van de factuur kloppen niet met de regels.');
    }

    // dezelfde uuid: dezelfde inhoud is al binnen, afwijkende inhoud is een conflict
    const bestaand = this.db.prepare('SELECT * FROM invoices WHERE uuid = ?').get(uuid) as InvoiceRow | undefined;
    if (bestaand) {
      const entry = bestaand.journal_entry_id ? (this.db.prepare('SELECT entry_date FROM journal_entries WHERE id = ?').get(bestaand.journal_entry_id) as { entry_date: IsoDate } | undefined) : undefined;
      // alle vaste inhoud telt mee, canoniek vergeleken (sleutelvolgorde van een momentopname doet er niet toe).
      // Het jobId telt bewust NIET mee: dat is een uitkomst van de aanroeper (welke klus bij het project hoort), geen
      // inhoud van de factuur. Een herhaling met een ander jobId is dus al_aanwezig en wijzigt de factuur niet.
      const creditUuid = bestaand.credit_of_invoice_id ? ((this.db.prepare('SELECT uuid FROM invoices WHERE id = ?').get(bestaand.credit_of_invoice_id) as { uuid: string | null } | undefined)?.uuid ?? null) : null;
      const inhoud = (o: unknown) => canoniek(o);
      const gelijk =
        bestaand.relation_id === relationId &&
        bestaand.number === f.nummer &&
        bestaand.invoice_date === f.datum &&
        bestaand.due_date === f.vervaldatum &&
        (bestaand.delivery_date ?? null) === (delivery.from ?? null) &&
        (bestaand.delivery_date_to ?? null) === (delivery.to ?? null) &&
        (bestaand.reference ?? null) === (f.referentie ?? null) &&
        (bestaand.intro ?? null) === (f.intro ?? null) &&
        (bestaand.notes ?? null) === (f.opmerking ?? null) &&
        inhoud(JSON.parse(bestaand.relation_snapshot ?? 'null')) === inhoud(f.klant_momentopname) &&
        inhoud(JSON.parse(bestaand.company_snapshot ?? 'null')) === inhoud(f.bedrijf_momentopname) &&
        creditUuid === (f.creditnota_van ?? null) &&
        bestaand.sent_at === f.verzonden_op &&
        bestaand.regeltabel_versie === f.regeltabel_versie &&
        bestaand.subtotal === totals.subtotal &&
        bestaand.vat_total === totals.vatTotal &&
        bestaand.total === totals.total &&
        JSON.stringify(readLines(this.db, 'invoice_lines', 'invoice_id', bestaand.id).map((l) => [l.description, l.quantity, l.unit ?? null, l.unit_price, l.vat_code, l.vat_percentage])) ===
          JSON.stringify(lines.map((l) => [l.description, l.quantity, l.unit ?? null, l.unitPrice, l.vatCode, l.vatPercentage]));
      const boekingsdatum = entry?.entry_date ?? null;
      return gelijk
        ? { uitkomst: 'al_aanwezig', reden: null, factuurId: bestaand.id, boekingsdatum_verschoven: boekingsdatum !== null && boekingsdatum !== bestaand.invoice_date, boekingsdatum }
        : { uitkomst: 'conflict', reden: `Factuur ${f.nummer} is al eerder ontvangen, maar met andere gegevens. De pc laat de bestaande factuur ongemoeid.`, factuurId: bestaand.id, boekingsdatum_verschoven: false, boekingsdatum };
    }
    if (this.db.prepare('SELECT 1 FROM invoices WHERE number = ?').get(f.nummer)) return geweigerd(`Factuurnummer ${f.nummer} bestaat al bij een andere factuur.`);

    let creditOf: number | null = null;
    if (f.creditnota_van) {
      const origineel = this.db.prepare('SELECT id, status, credit_of_invoice_id, relation_id, total FROM invoices WHERE uuid = ?').get(f.creditnota_van) as { id: number; status: InvoiceStatus; credit_of_invoice_id: number | null; relation_id: number; total: Cents | null } | undefined;
      if (!origineel) return geweigerd('De creditnota hoort bij een factuur die de pc niet kent.');
      if (origineel.credit_of_invoice_id) return geweigerd('De factuur waarvoor deze creditnota is gemaakt, is zelf al een creditnota.');
      if (this.db.prepare('SELECT 1 FROM invoices WHERE credit_of_invoice_id = ?').get(origineel.id)) return geweigerd('De factuur waarvoor deze creditnota is gemaakt, is al teruggedraaid.');
      if (origineel.relation_id !== relationId) return geweigerd('De creditnota hoort bij een factuur van een andere klant dan de creditnota zelf.');
      // zoals createCreditNote: een creditnota draait (een deel van) het origineel terug, nooit meer dan het origineel
      if (totals.total >= 0) return geweigerd('Een creditnota moet een negatief totaal hebben.');
      if ((origineel.total ?? 0) <= 0 || -totals.total > (origineel.total ?? 0)) return geweigerd('De creditnota is groter dan de factuur waarvoor hij is gemaakt.');
      creditOf = origineel.id;
    }

    const relation = this.relations.get(relationId);
    const vatDate = this.vatDateOption(lines.map((l) => l.vatCode), f.datum, delivery.from, delivery.to);
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO invoices (relation_id, credit_of_invoice_id, number, invoice_date, due_date, delivery_date, delivery_date_to, status, reference, intro, notes,
             subtotal, vat_total, total, relation_snapshot, company_snapshot, sent_at, job_id, uuid, apparaat_code, reeks_jaar, reeks_volgnr, regeltabel_versie)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'verzonden', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          relation.id, creditOf, f.nummer, f.datum, f.vervaldatum, delivery.from, delivery.to, f.referentie, f.intro, f.opmerking,
          totals.subtotal, totals.vatTotal, totals.total, JSON.stringify(f.klant_momentopname), JSON.stringify(f.bedrijf_momentopname), f.verzonden_op, jobId,
          uuid, reeks.apparaat_code, reeks.reeks_jaar, reeks.reeks_volgnr, f.regeltabel_versie,
        ).lastInsertRowid,
    );
    writeLines(this.db, 'invoice_lines', 'invoice_id', id, lines);
    const entryId = this.postInvoice(id, f.datum, vatDate, totals, relation.id, f.klant_momentopname.name, f.nummer);
    this.db.prepare('UPDATE invoices SET journal_entry_id = ? WHERE id = ?').run(entryId, id);
    if (creditOf) this.settleCreditAgainstOriginal(id, creditOf);
    const boekingsdatum = (this.db.prepare('SELECT entry_date FROM journal_entries WHERE id = ?').get(entryId) as { entry_date: IsoDate }).entry_date;
    return { uitkomst: 'nieuw', reden: null, factuurId: id, boekingsdatum_verschoven: boekingsdatum !== f.datum, boekingsdatum };
  }

  /**
   * De btw-datum van een EU-dienst (icp-dienst): de dienst valt in het tijdvak van de leverdatum. Staat
   * die dienst in een ander tijdvak dan de andere regels van de factuur, dan weigert dit: dat zijn twee
   * facturen. Gedeeld door finalize en importDefinitive, zodat een pc- en een telefoonfactuur gelijk boeken.
   */
  private vatDateOption(vatCodes: readonly string[], invoiceDate: IsoDate, deliveryDate: IsoDate | null, deliveryDateTo: IsoDate | null): { vatDate?: IsoDate } {
    const serviceDate = deliveryDateTo ?? deliveryDate ?? invoiceDate;
    const icpService = vatCodes.some((c) => c === 'icp-dienst');
    if (icpService && serviceDate.slice(0, 7) !== invoiceDate.slice(0, 7) && vatCodes.some((c) => c !== 'icp-dienst')) {
      throw new ValidationError('Deze EU-dienst hoort in een ander btw-tijdvak dan de andere regels. Maak aparte facturen voor de EU-dienst en de overige leveringen, met hun eigen leverdatum.');
    }
    return icpService && serviceDate !== invoiceDate ? { vatDate: serviceDate } : {};
  }

  /** Boekt een definitieve factuur (debiteuren aan omzet en btw); gedeeld door finalize en importDefinitive. */
  private postInvoice(id: number, invoiceDate: IsoDate, vatDate: { vatDate?: IsoDate }, totals: DocumentTotals, relationId: number, relationName: string, number: string): number {
    return this.ledger.post({
      date: invoiceDate,
      ...vatDate,
      description: `${totals.total < 0 ? 'Creditfactuur' : 'Factuur'} ${number} ${relationName}`,
      source: 'factuur',
      sourceRef: `invoice:${id}`,
      lines: this.journalLines(totals, relationId, number),
    });
  }

  private journalLines(totals: DocumentTotals, relationId: number, number: string): PostLine[] {
    const lines: (PostLine | null)[] = [signedLine(ACCOUNTS.debiteuren, totals.total, { relationId, description: number })];
    for (const g of totals.groups) {
      const accounts = SALES_ACCOUNTS[g.vatCode];
      if (!accounts) throw new ValidationError('Er ging iets mis met de btw-keuze op deze factuur. Kies het btw-tarief opnieuw.');
      lines.push(signedLine(accounts.revenue, -g.net, { relationId, vatCode: g.vatCode }));
      if (g.vat !== 0) {
        if (!accounts.vat) throw new ValidationError('Er ging iets mis met de btw-keuze op deze factuur. Kies het btw-tarief opnieuw.');
        lines.push(signedLine(accounts.vat, -g.vat, { relationId, vatCode: g.vatCode }));
      }
    }
    return lines.filter((l): l is PostLine => l !== null);
  }

  /** Verrekent een creditfactuur met de openstaande originele factuur (zonder geldstroom). */
  private settleCreditAgainstOriginal(creditId: number, originalId: number): void {
    const credit = this.row(creditId);
    const original = this.row(originalId);
    if (original.status === 'concept' || original.total == null || credit.total == null) return;
    const originalOpen = original.total - original.amount_paid;
    const creditOpen = credit.total - credit.amount_paid; // negatief
    const settle = Math.min(originalOpen, -creditOpen);
    if (settle <= 0) return;
    this.applyPaymentAmount(originalId, settle, credit.invoice_date);
    this.applyPaymentAmount(creditId, -settle, credit.invoice_date);
  }

  private applyPaymentAmount(id: number, amount: Cents, date: IsoDate): void {
    const inv = this.row(id);
    const paid = inv.amount_paid + amount;
    const total = inv.total ?? 0;
    const fullyPaid = total >= 0 ? paid >= total : paid <= total;
    this.db
      .prepare(`UPDATE invoices SET amount_paid = ?, status = ?, paid_at = ? WHERE id = ?`)
      .run(paid, fullyPaid ? 'betaald' : 'verzonden', fullyPaid ? date : null, id);
  }

  /** Registreert een (deel)betaling: bank aan debiteuren. */
  registerPayment(id: number, payment: PaymentInput): Invoice {
    assertCents(payment.amount, 'betaald bedrag');
    assertIsoDate(payment.date, 'betaaldatum');
    if (payment.amount === 0) throw new ValidationError('Bedrag mag niet nul zijn');
    return tx(this.db, () => {
      const inv = this.row(id);
      if (inv.status === 'concept') throw new ValidationError('Maak de factuur eerst definitief');
      const entryId = this.ledger.post({
        date: payment.date,
        description: payment.description ?? `Betaling factuur ${inv.number}`,
        source: 'bank',
        sourceRef: `invoice:${id}`,
        lines: [
          signedLine(payment.moneyAccount ?? ACCOUNTS.bank, payment.amount)!,
          signedLine(ACCOUNTS.debiteuren, -payment.amount, { relationId: inv.relation_id, description: inv.number })!,
        ],
      });
      this.applyPaymentAmount(id, payment.amount, payment.date);
      this.redeclareAfterWriteOff(id, inv, payment.amount, payment.date);
      if (payment.bankTransactionId) {
        this.db
          .prepare(`UPDATE bank_transactions SET status = 'gematcht', matched_journal_entry_id = ?, matched_invoice_id = ? WHERE id = ?`)
          .run(entryId, id, payment.bankTransactionId);
      }
      return this.get(id);
    });
  }

  /**
   * Oninbare factuur (factuurstelsel): de omzet en de btw van het onbetaalde deel gaan terug, in de aangifte van
   * het tijdvak van de afschrijfdatum. De Belastingdienst beschouwt een vordering uiterlijk 1 jaar na de uiterste
   * betaaldatum als oninbaar (belastingdienst.nl, Teruggaaf door oninbare vorderingen, 2026-10-04).
   */
  writeOffBadDebt(id: number, date: IsoDate = today()): Invoice {
    assertIsoDate(date, 'datum');
    return tx(this.db, () => {
      const inv = this.get(id);
      if (inv.status !== 'verzonden' || inv.open_amount <= 0 || (inv.total ?? 0) <= 0) throw new ValidationError('Alleen een factuur die nog (deels) openstaat kun je als oninbaar afboeken');
      if (inv.credit_of_invoice_id || inv.is_opening) throw new ValidationError('Een creditfactuur of beginsaldo kun je niet als oninbaar afboeken');
      if (date < inv.invoice_date) throw new ValidationError('De datum ligt vóór de factuurdatum');
      if (this.db.prepare('SELECT 1 FROM invoice_writeoffs WHERE invoice_id = ? AND amount > recovered').get(id)) throw new ValidationError('Deze factuur is al als oninbaar afgeboekt');
      const open = inv.open_amount;
      const ratio = open / inv.total!;
      const lines: PostLine[] = [];
      let used = 0;
      for (const g of inv.totals.groups) {
        const accounts = SALES_ACCOUNTS[g.vatCode];
        if (!accounts) throw new ValidationError('Er ging iets mis met de btw-keuze op deze factuur');
        const net = Math.round(g.net * ratio);
        const vat = Math.round(g.vat * ratio);
        used += net + vat;
        lines.push({ account: accounts.revenue, debit: net, relationId: inv.relation_id, vatCode: g.vatCode });
        if (vat !== 0 && accounts.vat) lines.push({ account: accounts.vat, debit: vat, relationId: inv.relation_id, vatCode: g.vatCode });
      }
      lines[0]!.debit = (lines[0]!.debit ?? 0) + (open - used); // afrondingsverschil naar de eerste omzetregel
      const entryId = this.ledger.post({
        date,
        description: `Oninbare vordering factuur ${inv.number}`,
        source: 'handmatig',
        sourceRef: `invoice:${id}`,
        lines: [...lines.filter((l) => (l.debit ?? 0) !== 0), { account: ACCOUNTS.debiteuren, credit: open, relationId: inv.relation_id, description: inv.number }],
      });
      this.db.prepare('INSERT INTO invoice_writeoffs (invoice_id, journal_entry_id, amount, written_off_on) VALUES (?, ?, ?, ?)').run(id, entryId, open, date);
      return this.get(id);
    });
  }

  /** Komt er na een afschrijving alsnog betaald, dan geef je de btw over dat deel opnieuw aan (in het tijdvak van de betaling). */
  private redeclareAfterWriteOff(id: number, inv: InvoiceRow, paid: Cents, date: IsoDate): void {
    if (paid <= 0) return;
    const w = this.db.prepare('SELECT * FROM invoice_writeoffs WHERE invoice_id = ? AND amount > recovered ORDER BY id LIMIT 1').get(id) as { id: number; journal_entry_id: number; amount: Cents; recovered: Cents } | undefined;
    if (!w) return;
    const part = Math.min(paid, w.amount - w.recovered);
    const original = this.db.prepare(`SELECT l.account_id, a.rgs_code, l.debit, l.vat_code FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id WHERE l.journal_entry_id = ? AND l.debit > 0`).all(w.journal_entry_id) as { rgs_code: string; debit: Cents; vat_code: string | null }[];
    const lines: PostLine[] = [];
    let used = 0;
    for (const o of original) {
      const amount = Math.round((o.debit * part) / w.amount);
      used += amount;
      lines.push({ account: o.rgs_code, credit: amount, relationId: inv.relation_id, vatCode: o.vat_code });
    }
    lines[0]!.credit = (lines[0]!.credit ?? 0) + (part - used);
    this.ledger.post({
      date,
      description: `Alsnog betaald na afschrijving oninbaar, factuur ${inv.number}: btw opnieuw aangeven`,
      source: 'handmatig',
      sourceRef: `invoice:${id}`,
      lines: [{ account: ACCOUNTS.debiteuren, debit: part, relationId: inv.relation_id, description: inv.number }, ...lines.filter((l) => (l.credit ?? 0) !== 0)],
    });
    this.db.prepare('UPDATE invoice_writeoffs SET recovered = recovered + ? WHERE id = ?').run(part, w.id);
  }

  /** Openstaande facturen per ouderdomsklasse op `asOf`. */
  aging(asOf: IsoDate = today()): AgingBucket[] {
    const open = this.listOpen(asOf).filter((i) => i.open_amount > 0);
    return AGING_BUCKETS.map((b) => {
      const inBucket = open.filter((i) => {
        const late = Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${i.due_date}T00:00:00Z`)) / 86_400_000);
        return late >= b.from && late <= b.to;
      });
      return { key: b.key, label: b.label, count: inBucket.length, amount: inBucket.reduce((sum, i) => sum + i.open_amount, 0) };
    });
  }

  /**
   * Waarschuwingen bij de datum van een nieuwe of aangepaste factuur: een datum in de toekomst of vóór de
   * datum van de vorige definitieve factuur (de nummers lopen dan niet in datumvolgorde). Alleen een signaal. Een telefoonfactuur heeft een eigen
   * nummerreeks en telt hier niet mee.
   */
  dateWarnings(invoiceDate: IsoDate, excludeId?: number, asOf: IsoDate = today()): string[] {
    assertIsoDate(invoiceDate, 'factuurdatum');
    const out: string[] = [];
    if (invoiceDate > asOf) {
      out.push(`De factuurdatum (${formatDateNl(invoiceDate)}) ligt in de toekomst. De omzet en de btw komen dan pas in die periode. Klopt het jaar en de maand?`);
    }
    const last = this.db
      .prepare(`SELECT number, invoice_date FROM invoices WHERE status <> 'concept' AND number IS NOT NULL AND is_opening = 0 AND credit_of_invoice_id IS NULL AND apparaat_code IS NULL AND id IS NOT ? ORDER BY invoice_date DESC, id DESC LIMIT 1`)
      .get(excludeId ?? null) as { number: string; invoice_date: IsoDate } | undefined;
    if (last && invoiceDate < last.invoice_date) {
      out.push(`Factuur ${last.number} heeft een latere datum (${formatDateNl(last.invoice_date)}). Je nieuwe factuur krijgt een hoger nummer maar een eerdere datum; dat mag, maar controleer of de datum klopt.`);
    }
    return out;
  }

  /** Draait een eerder geregistreerde betaling terug (bv. bij het ontkoppelen van een banktransactie). */
  undoPayment(id: number, amount: Cents, journalEntryId: number, date: IsoDate = today()): Invoice {
    return tx(this.db, () => {
      this.ledger.reverse(journalEntryId, date);
      this.applyPaymentAmount(id, -amount, date);
      return this.get(id);
    });
  }

  /**
   * Klanten die meer betaalden dan ze moesten (debiteurensaldo onder nul), bv. een factuur twee keer
   * betaald of een te hoog bedrag overgemaakt. Het verschil hoort terugbetaald of verrekend te worden.
   */
  overpaidCustomers(): { relationId: number; name: string; amount: Cents }[] {
    return (
      this.db
        .prepare(
          `SELECT r.id AS relationId, r.name, -SUM(l.debit - l.credit) AS amount
           FROM journal_lines l
           JOIN chart_of_accounts a ON a.id = l.account_id
           JOIN relations r ON r.id = l.relation_id
           WHERE a.rgs_code = ?
           GROUP BY r.id HAVING SUM(l.debit - l.credit) < 0
           ORDER BY amount DESC`,
        )
        .all(ACCOUNTS.debiteuren) as { relationId: number; name: string; amount: Cents }[]
    );
  }

  /** Boekt een klein restverschil af (bv. klant betaalde € 0,02 te weinig). */
  writeOffRemainder(id: number, date: IsoDate = today()): Invoice {
    return tx(this.db, () => {
      const inv = this.get(id);
      if (inv.status !== 'verzonden') throw new ValidationError('Alleen bij een factuur die nog open staat kun je een klein verschil laten vallen');
      const open = inv.open_amount;
      if (Math.abs(open) > 500) throw new ValidationError('Laten vallen kan alleen bij een verschil tot € 5');
      this.ledger.post({
        date,
        description: `Betalingsverschil factuur ${inv.number}`,
        source: 'handmatig',
        sourceRef: `invoice:${id}`,
        lines: [signedLine(ACCOUNTS.betalingsverschillen, open)!, signedLine(ACCOUNTS.debiteuren, -open, { relationId: inv.relation_id })!],
      });
      this.applyPaymentAmount(id, open, date);
      return this.get(id);
    });
  }

  /** Maakt een concept-creditfactuur voor een definitieve factuur (alle regels negatief). */
  createCreditNote(id: number): Invoice {
    const inv = this.get(id);
    if (inv.status === 'concept') throw new ValidationError('Een concept kun je gewoon aanpassen of verwijderen');
    if (inv.credit_of_invoice_id) throw new ValidationError('Deze factuur is zelf al een terugdraai-factuur');
    const existing = this.db.prepare('SELECT id FROM invoices WHERE credit_of_invoice_id = ?').get(id) as { id: number } | undefined;
    if (existing) throw new ValidationError('Deze factuur is al teruggedraaid');
    const draft = this.createDraft({
      relationId: inv.relation_id,
      reference: `Creditering van factuur ${inv.number}`,
      templateId: inv.template_id,
      lines: toLineInputs(inv.lines).map((l) => ({ ...l, quantity: -l.quantity })),
    });
    this.db.prepare('UPDATE invoices SET credit_of_invoice_id = ? WHERE id = ?').run(id, draft.id);
    return this.get(draft.id);
  }

  markSent(id: number): void {
    // het tijdstip van een telefoonfactuur komt van de telefoon en blijft staan
    this.db.prepare(`UPDATE invoices SET sent_at = datetime('now') WHERE id = ? AND (uuid IS NULL OR sent_at IS NULL)`).run(id);
  }

  recordReminder(id: number): void {
    this.db.prepare(`UPDATE invoices SET reminder_count = reminder_count + 1, last_reminder_at = datetime('now') WHERE id = ?`).run(id);
  }

  private row(id: number): InvoiceRow {
    const row = this.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as InvoiceRow | undefined;
    if (!row) throw new ValidationError('Deze factuur bestaat niet (meer)');
    return row;
  }

  get(id: number, asOf?: IsoDate): Invoice {
    const row = this.row(id);
    const lines = readLines(this.db, 'invoice_lines', 'invoice_id', id);
    const totals = computeTotals(toLineInputs(lines));
    const snapshot = row.relation_snapshot ? (JSON.parse(row.relation_snapshot) as Relation) : null;
    const relation = snapshot ?? this.relations.get(row.relation_id);
    const total = row.total ?? totals.total;
    const open = row.status === 'concept' ? 0 : this.openAt(asOf ?? '9999-12-31').get(id) ?? 0;
    const historicalStatus = row.status === 'concept' ? 'concept' : (total >= 0 ? open <= 0 : open >= 0) ? 'betaald' : 'verzonden';
    const display = displayStatus(historicalStatus, row.due_date, open, asOf ?? today());
    return {
      ...row,
      status: historicalStatus,
      amount_paid: row.status === 'concept' ? 0 : total - open,
      relation_name: relation.name,
      relation_email: this.relations.get(row.relation_id).email ?? relation.email,
      lines,
      totals,
      open_amount: open,
      display_status: display,
      days_overdue: display === 'vervallen' ? Math.max(0, Math.round((Date.parse(asOf ?? today()) - Date.parse(row.due_date)) / 86_400_000)) : 0,
    };
  }

  list(filter: { status?: InvoiceDisplayStatus; relationId?: number; search?: string; from?: IsoDate; to?: IsoDate } = {}, asOf?: IsoDate): InvoiceSummary[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.relationId) (where.push('i.relation_id = ?'), params.push(filter.relationId));
    if (filter.from) (where.push('i.invoice_date >= ?'), params.push(filter.from));
    if (filter.to) (where.push('i.invoice_date <= ?'), params.push(filter.to));
    if (filter.search) {
      where.push('(i.number LIKE ? OR r.name LIKE ? OR i.reference LIKE ?)');
      params.push(`%${filter.search}%`, `%${filter.search}%`, `%${filter.search}%`);
    }
    const rows = this.db
      .prepare(
        `SELECT i.id, i.number, i.relation_id, r.name AS relation_name, i.invoice_date, i.due_date, i.status, i.total,
                i.amount_paid, i.sent_at, i.credit_of_invoice_id
         FROM invoices i JOIN relations r ON r.id = i.relation_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY CASE WHEN i.status = 'concept' THEN 0 ELSE 1 END, i.invoice_date DESC, i.id DESC`,
      )
      .all(...params) as (Omit<InvoiceSummary, 'display_status' | 'open_amount' | 'total'> & { total: number | null })[];
    const balances = this.openAt(asOf ?? '9999-12-31');
    const result = rows.map((r) => {
      const total = r.total ?? (r.status === 'concept' ? this.get(r.id, asOf).totals.total : 0);
      const open = r.status === 'concept' ? 0 : balances.get(r.id) ?? 0;
      const status: InvoiceStatus = r.status === 'concept' ? 'concept' : (total >= 0 ? open <= 0 : open >= 0) ? 'betaald' : 'verzonden';
      return { ...r, status, amount_paid: r.status === 'concept' ? 0 : total - open, total, open_amount: open, display_status: displayStatus(status, r.due_date, open, asOf ?? today()) };
    });
    return filter.status ? result.filter((r) => r.display_status === filter.status) : result;
  }

  /** Open bedrag op de peildatum, inclusief deelbetalingen, tegenboekingen en creditverrekening. */
  private openAt(asOf: IsoDate): Map<number, Cents> {
    const rows = this.db.prepare(`SELECT e.source_ref AS ref, SUM(l.debit - l.credit) AS amount
      FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
      JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE a.rgs_code = ? AND e.entry_date <= ? AND e.source_ref LIKE 'invoice:%'
      GROUP BY e.source_ref`).all(ACCOUNTS.debiteuren, asOf) as { ref: string; amount: Cents }[];
    const open = new Map(rows.map(r => [Number(r.ref.slice(8)), r.amount]));
    const credits = this.db.prepare(`SELECT id, credit_of_invoice_id AS original FROM invoices
      WHERE status <> 'concept' AND credit_of_invoice_id IS NOT NULL AND invoice_date <= ? ORDER BY id`).all(asOf) as { id: number; original: number }[];
    for (const c of credits) {
      const settle = Math.min(Math.max(0, open.get(c.original) ?? 0), Math.max(0, -(open.get(c.id) ?? 0)));
      open.set(c.original, (open.get(c.original) ?? 0) - settle);
      open.set(c.id, (open.get(c.id) ?? 0) + settle);
    }
    return open;
  }

  /** Openstaande (definitieve, niet volledig betaalde) facturen — voor matching en dashboard. */
  listOpen(asOf: IsoDate = today()): InvoiceSummary[] {
    return this.list({ to: asOf }, asOf).filter((i) => i.status === 'verzonden' && i.open_amount !== 0);
  }

  /** E-factuur (UBL, Peppol BIS 3.0) met de gegevens zoals ze op de definitieve factuur staan (#24). */
  ublXml(id: number): string {
    const inv = this.get(id);
    if (inv.status === 'concept') throw new ValidationError('Maak de factuur eerst definitief');
    const company = inv.company_snapshot ? { ...this.settings.get().company, ...JSON.parse(inv.company_snapshot) } : this.settings.get().company;
    const snap = inv.relation_snapshot ? (JSON.parse(inv.relation_snapshot) as Partial<Relation>) : {};
    const rel = { ...this.relations.get(inv.relation_id), ...snap };
    return buildInvoiceUbl(inv, company, { name: rel.name, address: rel.address ?? null, postcode: rel.postcode ?? null, city: rel.city ?? null, country: rel.country ?? 'NL', vat_number: rel.vat_number ?? null, kvk_number: rel.kvk_number ?? null, email: rel.email ?? null });
  }

  renderHtml(id: number): string {
    const inv = this.get(id);
    const template = inv.template_id ? this.templates.get(inv.template_id) : this.templates.getDefault('factuur');
    const s = this.settings.get();
    const company = inv.company_snapshot ? JSON.parse(inv.company_snapshot) : s.company;
    const customer: RenderableParty = inv.relation_snapshot ? JSON.parse(inv.relation_snapshot) : this.relations.get(inv.relation_id);
    const creditOf = inv.credit_of_invoice_id ? this.row(inv.credit_of_invoice_id).number : null;
    return renderDocumentHtml(
      {
        kind: 'factuur',
        number: inv.number,
        date: inv.invoice_date,
        dueDate: inv.due_date,
        deliveryDate: inv.delivery_date,
        deliveryDateTo: inv.delivery_date_to,
        reference: inv.reference,
        intro: inv.intro,
        notes: inv.notes,
        creditOf,
        lines: inv.lines,
      },
      customer,
      company,
      template,
      { kor: s.kor },
    );
  }
}

/** Datum van levering of dienst (of een periode): beide optioneel, het einde alleen met een begin en niet eerder dan het begin. */
export function normalizeDelivery(from: IsoDate | null | undefined, to: IsoDate | null | undefined): { from: IsoDate | null; to: IsoDate | null } {
  const a = from || null;
  const b = to || null;
  if (a) assertIsoDate(a, 'datum levering');
  if (b) {
    if (!a) throw new ValidationError('Vul ook de begindatum van de levering of dienst in');
    assertIsoDate(b, 'einddatum levering');
    if (b < a) throw new ValidationError('De einddatum van de levering ligt vóór de begindatum');
  }
  return { from: a, to: b && b !== a ? b : null };
}

/** Indeling van openstaande facturen naar dagen na de vervaldatum, zoals een boekhouder ze doorloopt. */
export const AGING_BUCKETS = [
  { key: 'op-tijd', label: 'Nog niet vervallen', from: -Infinity, to: 0 },
  { key: '1-30', label: '1 tot 30 dagen te laat', from: 1, to: 30 },
  { key: '31-60', label: '31 tot 60 dagen te laat', from: 31, to: 60 },
  { key: '61-90', label: '61 tot 90 dagen te laat', from: 61, to: 90 },
  { key: '90+', label: 'Meer dan 90 dagen te laat', from: 91, to: Infinity },
] as const;
export type AgingBucket = { key: (typeof AGING_BUCKETS)[number]['key']; label: string; count: number; amount: Cents };

export function displayStatus(status: InvoiceStatus, dueDate: IsoDate, open: Cents, asOf: IsoDate): InvoiceDisplayStatus {
  if (status === 'concept') return 'concept';
  if (status === 'betaald') return 'betaald';
  return open > 0 && dueDate < asOf ? 'vervallen' : 'openstaand';
}
