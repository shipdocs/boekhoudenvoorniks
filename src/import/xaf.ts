import { XMLParser } from 'fast-xml-parser';
import { roundHalfAwayFromZero, type Cents } from '../shared/money';
import { isValidIban, normalizeIban } from '../shared/validation';
import { isIsoDate, type IsoDate } from '../shared/dates';

/**
 * XML Auditfile Financieel (XAF 3.0, 3.1 en 3.2): het standaard exportformaat van vrijwel elk
 * Nederlands boekhoudpakket (Exact, Twinfield, e-Boekhouden, Moneybird, SnelStart, Jortt, AFAS, Yuki, …).
 * Hier alleen lezen en normaliseren; wat het betekent voor de startbalans staat in
 * onboarding/xaf-import.ts. Bedragen zijn in centen, debet positief.
 */

export interface XafAccount {
  id: string;
  name: string;
  /** B = balans, P = winst en verlies (soms ook andere codes; dan kijken we naar RGS en de naam) */
  type: string;
  /** officiële RGS-code als het pakket die meegeeft */
  rgs: string | null;
}

export interface XafRelation {
  id: string;
  name: string;
  /** C = klant, S = leverancier, B = beide, O = anders */
  type: string;
  kvk: string | null;
  vatNumber: string | null;
  iban: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  postcode: string | null;
  city: string | null;
  country: string | null;
}

export interface XafLine {
  journalId: string;
  /** B = bank, S = verkoop, P = inkoop, G = memoriaal, … */
  journalType: string;
  /** IBAN van de bankrekening bij een bankdagboek */
  journalIban: string | null;
  transactionNr: string;
  date: IsoDate;
  accountId: string;
  /** debet positief, credit negatief */
  amount: Cents;
  relationId: string | null;
  invoiceRef: string | null;
  docRef: string | null;
  description: string;
  vat: { percentage: number | null; amount: Cents } | null;
}

export interface XafOpenItem {
  accountId: string | null;
  relationId: string | null;
  invoiceRef: string | null;
  invoiceDate: IsoDate | null;
  dueDate: IsoDate | null;
  description: string;
  /** debet positief */
  amount: Cents;
}

export interface XafFile {
  version: string;
  software: string;
  fiscalYear: string;
  startDate: IsoDate;
  endDate: IsoDate;
  company: { name: string; kvk: string | null; vatNumber: string | null };
  accounts: XafAccount[];
  relations: XafRelation[];
  opening: { date: IsoDate | null; lines: { accountId: string; amount: Cents }[]; items: XafOpenItem[] };
  lines: XafLine[];
  warnings: string[];
  /** alleen totalen per rekening (bv. een kolommenbalans): geen losse boekingen of facturen */
  totalsOnly?: boolean;
}

export class XafError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XafError';
  }
}

const ARRAYS = new Set([
  'ledgerAccount', 'customerSupplier', 'journal', 'transaction', 'trLine', 'obLine', 'obSubledger', 'obSbLine',
  'subledger', 'sbLine', 'bankAccount', 'streetAddress', 'postalAddress', 'taxonomy', 'txAcctMap', 'vat', 'currency',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ARRAYS.has(name),
});

type X = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function text(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return String((v as X)['#text'] ?? '').trim();
  return String(v).trim();
}
const opt = (v: unknown): string | null => text(v) || null;
const list = (v: unknown): X[] => (Array.isArray(v) ? (v as X[]) : v ? [v as X] : []);

function date(v: unknown): IsoDate | null {
  const s = text(v).slice(0, 10);
  // echte kalenderdatums: 31 februari zou later stilletjes 3 maart worden
  return isIsoDate(s) ? s : null;
}

/** "1234.50" → 123450. XAF gebruikt altijd een punt als decimaalteken. */
function cents(v: unknown): Cents {
  const s = text(v).replace(',', '.');
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new XafError(`Onleesbaar bedrag in de auditfile: ${s}`);
  return roundHalfAwayFromZero(n * 100);
}

/** Bedrag met debet/credit: XAF 3.x `amnt` + `amntTp`, oudere varianten `debitAmount`/`creditAmount`. */
function signed(x: X): Cents {
  if (x.amnt !== undefined) {
    const a = cents(x.amnt);
    const tp = text(x.amntTp).toUpperCase();
    return tp === 'C' ? -Math.abs(a) : tp === 'D' ? Math.abs(a) : a;
  }
  return cents(x.debitAmount) - cents(x.creditAmount);
}

/** Een RGS-code herkennen: begint met B of W en drie letters, zoals BLimBanRba of WOmzNopOlh. */
const RGS_RE = /^[BW][A-Z][a-z]{2}[A-Za-z0-9]*$/;

function rgsOf(a: X): string | null {
  const candidates: string[] = [];
  for (const t of list(a.taxonomies?.taxonomy)) for (const m of list(t.txAcctMap)) candidates.push(text(m.txLink));
  candidates.push(text(a.leadReference), text(a.leadCrossRef), text(a.leadCode));
  return candidates.find((c) => RGS_RE.test(c)) ?? null;
}

function iban(v: unknown): string | null {
  const s = text(v).replace(/\s/g, '').toUpperCase();
  return isValidIban(s) ? normalizeIban(s) : null;
}

export function parseXaf(xml: string): XafFile {
  let doc: X;
  try {
    doc = parser.parse(xml) as X;
  } catch {
    throw new XafError('Dit bestand kunnen we niet lezen. Is het een auditfile (.xaf)?');
  }
  const root = doc.auditfile as X | undefined;
  if (!root) throw new XafError('Dit is geen auditfile. Exporteer in je vorige programma een "XML Auditfile Financieel" (.xaf).');
  // de versie staat in de namespace (het attribuut verdwijnt bij het parsen, dus uit de tekst)
  const version = /auditfiles\.nl\/XAF\/(\d+(?:\.\d+)?)/i.exec(xml.slice(0, 2000))?.[1] ?? '';
  if (version && Number(version) < 3) {
    throw new XafError(`Dit is een auditfile versie ${version}. Exporteer opnieuw als versie 3 (3.1 of 3.2); dat kan in vrijwel elk pakket.`);
  }
  const header = (root.header ?? {}) as X;
  const company = (root.company ?? {}) as X;
  const warnings: string[] = [];

  const accounts: XafAccount[] = list(company.generalLedger?.ledgerAccount).map((a) => ({
    id: text(a.accID),
    name: text(a.accDesc) || text(a.accID),
    type: text(a.accTp).toUpperCase(),
    rgs: rgsOf(a),
  }));
  if (accounts.length === 0) throw new XafError('In deze auditfile staat geen grootboek. Exporteer hem opnieuw met alle gegevens.');

  const relations: XafRelation[] = list(company.customersSuppliers?.customerSupplier).map((r) => {
    const addr = list(r.streetAddress)[0] ?? list(r.postalAddress)[0] ?? {};
    const street = [text(addr.streetname), text(addr.number), text(addr.numberExtension)].filter(Boolean).join(' ');
    return {
      id: text(r.custSupID),
      name: text(r.custSupName) || text(r.custSupID),
      type: text(r.custSupTp).toUpperCase(),
      kvk: opt(r.commerceNr),
      vatNumber: opt(r.taxRegIdent),
      iban: list(r.bankAccount).map((b) => iban(b.bankAccNr)).find(Boolean) ?? null,
      email: opt(r.eMail),
      phone: opt(r.telephone),
      address: street || null,
      postcode: opt(addr.postalCode),
      city: opt(addr.city),
      country: opt(addr.country),
    };
  });

  const ob = (company.openingBalance ?? {}) as X;
  const opening = {
    date: date(ob.opBalDate),
    lines: list(ob.obLine).map((l) => ({ accountId: text(l.accID), amount: signed(l) })).filter((l) => l.accountId && l.amount !== 0),
    items: list(ob.obSubledgers?.obSubledger).flatMap((sb) =>
      list(sb.obSbLine).map((l) => ({
        accountId: opt(l.accID),
        relationId: opt(l.custSupID),
        invoiceRef: opt(l.invRef) ?? opt(l.docRef),
        invoiceDate: date(l.invDt),
        dueDate: date(l.invDueDt),
        description: text(l.desc),
        amount: signed(l),
      })),
    ),
  };

  const lines: XafLine[] = [];
  for (const j of list(company.transactions?.journal)) {
    const journalId = text(j.jrnID);
    const journalType = text(j.jrnTp).toUpperCase();
    const journalIban = iban(j.bankAccNr);
    for (const t of list(j.transaction)) {
      const trDate = date(t.trDt);
      for (const l of list(t.trLine)) {
        const d = date(l.effDate) ?? trDate;
        if (!d) {
          warnings.push(`Boekingsregel zonder datum overgeslagen (dagboek ${journalId}, boeking ${text(t.nr)})`);
          continue;
        }
        const vat = list(l.vat)[0];
        lines.push({
          journalId,
          journalType,
          journalIban,
          transactionNr: text(t.nr),
          date: d,
          accountId: text(l.accID),
          amount: signed(l),
          relationId: opt(l.custSupID),
          invoiceRef: opt(l.invRef),
          docRef: opt(l.docRef),
          description: text(l.desc) || text(t.desc),
          vat: vat ? { percentage: text(vat.vatPerc) ? Number(text(vat.vatPerc)) : null, amount: text(vat.vatAmnt) ? (text(vat.vatAmntTp).toUpperCase() === 'C' ? -1 : 1) * Math.abs(cents(vat.vatAmnt)) : 0 } : null,
        });
      }
    }
  }

  const known = new Set(accounts.map((a) => a.id));
  const unknown = new Set([...lines.map((l) => l.accountId), ...opening.lines.map((l) => l.accountId)].filter((id) => !known.has(id)));
  for (const id of unknown) {
    accounts.push({ id, name: `Rekening ${id}`, type: '', rgs: null });
    warnings.push(`Rekening ${id} staat niet in het grootboek van de auditfile`);
  }

  const startDate = date(header.startDate) ?? opening.date ?? lines.map((l) => l.date).sort()[0] ?? '';
  const endDate = date(header.endDate) ?? lines.map((l) => l.date).sort().at(-1) ?? startDate;
  if (!startDate) throw new XafError('In deze auditfile staat geen periode. Exporteer hem opnieuw.');
  return {
    version: version || '3',
    software: [text(header.softwareDesc), text(header.softwareVersion)].filter(Boolean).join(' '),
    fiscalYear: text(header.fiscalYear) || startDate.slice(0, 4),
    startDate,
    endDate,
    company: { name: text(company.companyName), kvk: opt(company.companyIdent), vatNumber: opt(company.taxRegIdent) },
    accounts,
    relations,
    opening,
    lines,
    warnings,
  };
}
