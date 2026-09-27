import { tx, type Db } from '../db/database';
import type { BankService } from '../import/bank';
import type { RelationsService } from '../relations/relations';
import type { SettingsService } from '../settings/settings';
import { parseXaf, type XafAccount, type XafFile, type XafLine } from '../import/xaf';
import { addDays, formatDateNl, periodFor, type IsoDate } from '../shared/dates';
import { formatEuro, type Cents } from '../shared/money';
import { ValidationError } from '../shared/validation';
import type { OpeningInput, SwitchoverService, SwitchoverState } from './switchover';

/**
 * Overstappen met een auditfile (XAF) uit je vorige programma: de app rekent uit wat er op de dag vóór
 * de instapdatum op elke rekening stond en maakt daar voorstellen van voor de overstap-hulp.
 *
 *  - rekeningen herkennen: eerst de RGS-code die het pakket meegeeft, anders de naam (en B/P)
 *  - openstaande facturen per klant/leverancier uit de openingsbalans en de boekingen (factuurnummer),
 *    anders per klant het saldo; het totaal sluit altijd aan op de rekening Debiteuren/Crediteuren
 *  - bus en gereedschap: per groep de boekwaarde (aanschaf min afschrijving)
 *  - midden in het jaar: omzet en kosten van 1 januari tot de instapdatum (zonder afschrijving)
 *  - midden in een btw-periode: omzet en btw van dat stuk (uit de btw-gegevens op de regels)
 *  - het eigen vermogen volgens de auditfile, om de startbalans mee te vergelijken
 *
 * Alles is een voorstel: de gebruiker vinkt aan wat hij overneemt. Wat de app niet herkent, staat er
 * apart bij (standaard uit).
 */

export type XafClass =
  | 'bank' | 'kas' | 'debiteuren' | 'crediteuren' | 'bezit' | 'afschrijving-cum' | 'btw' | 'lening' | 'vordering' | 'schuld'
  | 'eigen-vermogen' | 'omzet' | 'materiaal' | 'auto' | 'afschrijving' | 'kosten' | 'onbekend';

export interface XafProposal {
  key: string;
  input: OpeningInput;
  label: string;
  /** positief = bezit/tegoed, negatief = schuld (zoals in de startbalans) */
  amount: Cents;
  /** standaard aangevinkt? */
  include: boolean;
  note: string | null;
}

export interface XafBank {
  accountId: string;
  name: string;
  iban: string | null;
  amount: Cents;
  /** bestaande rekening in de app die erbij lijkt te horen, of null (dan nieuw aanmaken) */
  bankAccountId: number | null;
}

export interface XafPlan {
  meta: { software: string; version: string; fiscalYear: string; startDate: IsoDate; endDate: IsoDate; company: string; accounts: number; lines: number };
  /** de instapdatum waarvoor gerekend is */
  date: IsoDate;
  /** voorgestelde instapdatum: de dag na het einde van de auditfile */
  suggestedDate: IsoDate;
  banks: XafBank[];
  proposals: XafProposal[];
  relations: { total: number; fresh: number };
  /** wat er van jou in de zaak zat volgens de auditfile (bezittingen min schulden) */
  equity: Cents;
  accounts: { id: string; name: string; rgs: string | null; class: XafClass; balance: Cents }[];
  warnings: string[];
}

export interface XafApplyChoices {
  /** keys van de voorstellen die de gebruiker overneemt */
  include: string[];
  /** per bankrekening in de auditfile: bestaande rekening in de app, 'nieuw', of null (overslaan) */
  banks: Record<string, number | 'nieuw' | null>;
  relations: boolean;
}

// ---------- rekeningen herkennen ----------

const has = (s: string, re: RegExp) => re.test(s.toLowerCase());

/** Soort rekening uit de RGS-code (officieel, of een code die daarop lijkt). */
function classByRgs(rgs: string): XafClass | null {
  const r = rgs;
  if (r.startsWith('BLimBan') || r.startsWith('BLiqBan')) return 'bank';
  if (r.startsWith('BLimKas') || r.startsWith('BLiqKas')) return 'kas';
  if (r.startsWith('BVorDeb')) return 'debiteuren';
  if (r.startsWith('BSchCre')) return 'crediteuren';
  if (r.startsWith('BMva') || r.startsWith('BIva')) return /Cae|Cua|Cuh|Afs|Cum/.test(r.slice(7)) ? 'afschrijving-cum' : 'bezit';
  if (r.startsWith('BSchBepBtw')) return 'btw';
  if (r.startsWith('BEiv')) return 'eigen-vermogen';
  if (r.startsWith('BLas') || r.startsWith('BSchAos') || r.startsWith('BSchSkk')) return 'lening';
  if (r.startsWith('BVor') || r.startsWith('BFva') || r.startsWith('BLimKru') || r.startsWith('BLiqKru')) return 'vordering';
  if (r.startsWith('BSch') || r.startsWith('BVrz')) return 'schuld';
  if (r.startsWith('WOmz')) return 'omzet';
  if (r.startsWith('WKpr')) return 'materiaal';
  if (r.startsWith('WBedAut')) return 'auto';
  if (r.startsWith('WAfs')) return 'afschrijving';
  if (r.startsWith('W')) return 'kosten';
  return null;
}

/** Zonder RGS: op de naam (en het soort rekening B/P). */
function classByName(a: XafAccount): XafClass {
  const n = a.name;
  const pl = a.type === 'P' || /^[48]\d{3}/.test(a.id) || /^7\d{3}/.test(a.id);
  if (pl) {
    if (has(n, /omzet|opbrengst|verkoop|verkopen|revenue|sales/)) return 'omzet';
    if (has(n, /afschrijving/)) return 'afschrijving';
    if (has(n, /inkoop|materiaal|kostprijs|uitbesteed|onderaanneming|grondstof/)) return 'materiaal';
    if (has(n, /auto|brandstof|benzine|diesel|vervoer|bus\b|lease|parkeer|kilometer/)) return 'auto';
    return 'kosten';
  }
  // eerst de specifieke soorten: "Lening Rabobank" is een lening, "Voorbelasting" geen bank
  if (has(n, /afschrijving/)) return 'afschrijving-cum';
  if (has(n, /btw|omzetbelasting|voorbelasting|\bob\b/)) return 'btw';
  if (has(n, /debiteur/)) return 'debiteuren';
  if (has(n, /crediteur/)) return 'crediteuren';
  if (has(n, /lening|hypothe|financiering|krediet/)) return 'lening';
  if (has(n, /eigen vermogen|kapitaal|priv[eé]|onttrekking|storting|resultaat|winst/)) return 'eigen-vermogen';
  if (has(n, /\bkas\b|kasgeld|contant/)) return 'kas';
  if (has(n, /\bbank|rabo|\bing\b|abn|knab|bunq|triodos|\bsns\b|\basn\b|regiobank|spaar|betaalrekening/)) return 'bank';
  if (has(n, /machine|inventaris|gereedschap|auto|bus\b|vervoer|computer|installatie|verbouwing|bedrijfsmiddel|materieel/)) return 'bezit';
  if (has(n, /vooruitbetaald|borg|waarborg|te ontvangen|vordering|voorschot|kruispost|tussenrekening/)) return 'vordering';
  if (has(n, /te betalen|schuld|loonheffing|nog te/)) return 'schuld';
  return 'onbekend';
}

export function classify(a: XafAccount): XafClass {
  return (a.rgs ? classByRgs(a.rgs) : null) ?? classByName(a);
}

/** Btw-rekening: hoog, laag, voorbelasting of anders (af te dragen / afrekening). */
function vatKind(a: XafAccount): 'hoog' | 'laag' | 'voor' | 'anders' {
  const r = a.rgs ?? '';
  const n = a.name.toLowerCase();
  if (/BtwVoo|Voorbelasting/i.test(r) || /voorbelasting|te vorderen|input/.test(n)) return 'voor';
  if (/BtwOlt|BtwAfdLaa|BtwLaa/.test(r) || /laag|9\s?%|6\s?%/.test(n)) return 'laag';
  if (/BtwOla|BtwAfdHoo|BtwHoo/.test(r) || /hoog|21\s?%/.test(n)) return 'hoog';
  return 'anders';
}

// ---------- de analyse ----------

export class XafImportService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly relations: RelationsService,
    private readonly bank: BankService,
    private readonly switchover: SwitchoverService,
  ) {}

  /** Wat de auditfile betekent voor de startbalans op `date` (standaard: de gekozen instapdatum). */
  analyze(xml: string, date?: IsoDate): XafPlan {
    return this.plan(parseXaf(xml), date);
  }

  private plan(xaf: XafFile, requested?: IsoDate): XafPlan {
    const s = this.settings.get();
    const suggestedDate = addDays(xaf.endDate, 1);
    const date = requested ?? (s.switchover.mode === 'overstapper' && s.switchover.date ? s.switchover.date : suggestedDate);
    const until = addDays(date, -1);
    const warnings = [...xaf.warnings];
    if (xaf.startDate > date) throw new ValidationError(`Deze auditfile begint op ${formatDateNl(xaf.startDate)}, na je instapdatum (${formatDateNl(date)}). Exporteer het jaar ervoor, of kies een latere instapdatum.`);
    if (xaf.endDate < until) {
      warnings.push(`De auditfile loopt tot ${formatDateNl(xaf.endDate)}. Boekingen van ${formatDateNl(addDays(xaf.endDate, 1))} tot ${formatDateNl(date)} ontbreken: exporteer tot en met ${formatDateNl(until)}, of kies ${formatDateNl(suggestedDate)} als instapdatum.`);
    }

    const byId = new Map(xaf.accounts.map((a) => [a.id, a]));
    const cls = new Map(xaf.accounts.map((a) => [a.id, classify(a)]));
    const lines = xaf.lines.filter((l) => l.date <= until);
    const balance = new Map<string, Cents>();
    const add = (id: string, amount: Cents) => balance.set(id, (balance.get(id) ?? 0) + amount);
    // de openingsbalans hoort bij de begindatum van het bestand (tenzij die ná de instapdatum ligt)
    if (!xaf.opening.date || xaf.opening.date <= date) for (const l of xaf.opening.lines) add(l.accountId, l.amount);
    for (const l of lines) add(l.accountId, l.amount);
    const of = (c: XafClass) => xaf.accounts.filter((a) => cls.get(a.id) === c);
    const sum = (accs: XafAccount[]) => accs.reduce((t, a) => t + (balance.get(a.id) ?? 0), 0);

    const isBalance = (c: XafClass) => !['omzet', 'materiaal', 'auto', 'afschrijving', 'kosten'].includes(c);
    const yearStart = `${date.slice(0, 4)}-01-01`;
    // resultaat van vorige jaren zit in het eigen vermogen; alleen de P-rekeningen van dit jaar tellen als "tot nu toe"
    const ytd = (accs: XafAccount[]) =>
      accs.reduce((t, a) => t + lines.filter((l) => l.accountId === a.id && l.date >= yearStart).reduce((x, l) => x + l.amount, 0) + (xaf.opening.date && xaf.opening.date >= yearStart ? xaf.opening.lines.filter((l) => l.accountId === a.id).reduce((x, l) => x + l.amount, 0) : 0), 0);

    const relName = new Map(xaf.relations.map((r) => [r.id, r.name]));
    const proposals: XafProposal[] = [];
    const push = (p: Omit<XafProposal, 'amount' | 'include' | 'note'> & Partial<Pick<XafProposal, 'include' | 'note'>>, amount: Cents) =>
      proposals.push({ include: true, note: null, ...p, amount });

    // --- bank
    const appBanks = this.bank.listAccounts();
    const banks: XafBank[] = of('bank')
      .filter((a) => (balance.get(a.id) ?? 0) !== 0 || lines.some((l) => l.accountId === a.id))
      .map((a) => {
        const iban = xaf.lines.find((l) => l.accountId === a.id && l.journalIban)?.journalIban ?? null;
        // één rekening aan beide kanten: dezelfde, tenzij de rekeningnummers verschillen
        const only = of('bank').length === 1 && appBanks.length === 1 && (!iban || !appBanks[0]!.iban) ? appBanks[0] : undefined;
        const match = appBanks.find((b) => (iban && b.iban === iban) || b.name.toLowerCase() === a.name.toLowerCase()) ?? only;
        return { accountId: a.id, name: a.name, iban, amount: balance.get(a.id) ?? 0, bankAccountId: match?.id ?? null };
      });

    // --- kas
    for (const a of of('kas')) {
      const amount = balance.get(a.id) ?? 0;
      if (amount > 0) push({ key: `kas:${a.id}`, label: a.name.toLowerCase() === 'kas' ? 'Kas' : `Kas: ${a.name}`, input: { kind: 'vordering', description: a.name, amount, account: 'kas', bron: 'xaf' } }, amount);
      else if (amount < 0) warnings.push(`Negatief kassaldo op ${a.name} (${formatEuro(amount)}): dat kan niet, kijk het na in je vorige programma`);
    }

    // --- openstaande posten per klant/leverancier
    const openItems = (kind: 'klant' | 'leverancier', accs: XafAccount[]) => {
      const ids = new Set(accs.map((a) => a.id));
      const total = sum(accs);
      if (total === 0 && accs.length === 0) return;
      const sign = kind === 'klant' ? 1 : -1;
      type Group = { relationId: string | null; ref: string | null; amount: Cents; date: IsoDate | null; due: IsoDate | null };
      const groups = new Map<string, Group>();
      const addGroup = (relationId: string | null, ref: string | null, amount: Cents, d: IsoDate | null, due: IsoDate | null) => {
        const key = `${relationId ?? ''}|${ref ?? ''}`;
        const g = groups.get(key) ?? { relationId, ref, amount: 0, date: d, due };
        g.amount += amount;
        if (d && (!g.date || d < g.date)) g.date = d;
        if (due && !g.due) g.due = due;
        groups.set(key, g);
      };
      const itemsOnAccounts = xaf.opening.items.filter((i) => !i.accountId || ids.has(i.accountId));
      const openingOnAccounts = xaf.opening.lines.filter((l) => ids.has(l.accountId)).reduce((t, l) => t + l.amount, 0);
      const itemsTotal = itemsOnAccounts.reduce((t, i) => t + i.amount, 0);
      // openingsbalans per factuur als die aansluit, anders het totaal als één post zonder klant
      if (itemsOnAccounts.length > 0 && itemsTotal === openingOnAccounts) for (const i of itemsOnAccounts) addGroup(i.relationId, i.invoiceRef, i.amount, i.invoiceDate, i.dueDate);
      else if (openingOnAccounts !== 0 && (!xaf.opening.date || xaf.opening.date <= date)) addGroup(null, null, openingOnAccounts, xaf.opening.date, null);
      for (const l of lines.filter((x) => ids.has(x.accountId))) addGroup(l.relationId, l.invoiceRef, l.amount, l.date, null);

      let perInvoice = [...groups.values()].filter((g) => g.amount !== 0);
      // betalingen zonder factuurnummer: dan per klant het saldo
      if (perInvoice.some((g) => sign * g.amount < 0 || !g.ref)) {
        const perRel = new Map<string, Group>();
        for (const g of groups.values()) {
          const k = g.relationId ?? '';
          const r = perRel.get(k) ?? { relationId: g.relationId, ref: null, amount: 0, date: g.date, due: null };
          r.amount += g.amount;
          if (g.date && (!r.date || g.date < r.date)) r.date = g.date;
          perRel.set(k, r);
        }
        perInvoice = [...perRel.values()].filter((g) => g.amount !== 0);
        if (groups.size > 0) warnings.push(`${kind === 'klant' ? 'Debiteuren' : 'Crediteuren'}: niet elke betaling had een factuurnummer; de app neemt per ${kind} het openstaande saldo over`);
      }
      for (const g of perInvoice) {
        const name = (g.relationId && relName.get(g.relationId)) || (kind === 'klant' ? 'Onbekende klant' : 'Onbekende leverancier');
        const amount = sign * g.amount;
        const invoiceDate = g.date && g.date <= until ? g.date : until;
        const ref = g.ref ?? `SALDO-${g.relationId ?? 'onbekend'}`;
        if (amount > 0) {
          const input: OpeningInput =
            kind === 'klant'
              ? { kind, relationName: name, number: ref, invoiceDate, dueDate: g.due, amount, bron: 'xaf' }
              : { kind, relationName: name, reference: g.ref, invoiceDate, dueDate: g.due, amount, bron: 'xaf' };
          push({ key: `${kind}:${g.relationId ?? ''}:${ref}`, label: `${kind === 'klant' ? 'Factuur' : 'Rekening'} ${g.ref ?? '(saldo)'} ${name}`, input, note: g.ref ? null : 'openstaand saldo, geen factuurnummer' }, sign * amount);
        } else {
          // klant betaalde vooruit / je hebt tegoed bij een leverancier
          const other: OpeningInput = kind === 'klant' ? { kind: 'schuld', description: `Vooruit ontvangen van ${name}`, amount: -amount, bron: 'xaf' } : { kind: 'vordering', description: `Tegoed bij ${name}`, amount: -amount, bron: 'xaf' };
          push({ key: `${kind}-min:${g.relationId ?? ''}:${g.ref ?? ''}`, label: other.kind === 'schuld' ? other.description : `Tegoed bij ${name}`, input: other }, kind === 'klant' ? amount : -amount);
        }
      }
    };
    openItems('klant', of('debiteuren'));
    openItems('leverancier', of('crediteuren'));

    // --- bus en gereedschap: per groep (RGS-prefix of naam) de boekwaarde
    const assetGroups = new Map<string, { name: string; cost: Cents; depr: Cents; type: 'vervoer' | 'inventaris' }>();
    const groupKey = (a: XafAccount) => (a.rgs ? a.rgs.slice(0, 7) : a.name.toLowerCase().replace(/afschrijving(en)?|cumulatie(f|ve)|\(.*?\)/g, '').trim());
    for (const a of [...of('bezit'), ...of('afschrijving-cum')]) {
      const k = groupKey(a);
      const g = assetGroups.get(k) ?? { name: a.name, cost: 0, depr: 0, type: /Tev|Tra|Vvm|auto|bus|vervoer|wagen/i.test(`${a.rgs ?? ''} ${a.name}`) ? 'vervoer' : 'inventaris' };
      if (cls.get(a.id) === 'bezit') {
        g.cost += balance.get(a.id) ?? 0;
        g.name = a.name;
      } else g.depr += balance.get(a.id) ?? 0;
      assetGroups.set(k, g);
    }
    for (const [k, g] of assetGroups) {
      const value = g.cost + g.depr;
      if (value <= 0 && g.cost <= 0) continue;
      const cost = Math.max(g.cost, value);
      // 20% per jaar van de aanschaf: zoveel jaar is er nog over (minstens 1)
      const remainingYears = Math.max(1, Math.min(5, Math.round((value / Math.max(1, cost)) * 5)));
      push(
        {
          key: `bezit:${k}`,
          label: g.name,
          input: { kind: 'bezit', name: g.name, type: g.type, acquiredOn: `${Number(date.slice(0, 4)) - 1}-01-01`, cost, bookValue: Math.max(0, value), remainingYears, bron: 'xaf' },
          note: 'aankoopdatum en resterende jaren zijn geschat: kijk ze na',
        },
        Math.max(0, value),
      );
    }

    // --- btw-periode (instapdatum midden in een periode) en btw-saldo
    const vatAccs = of('btw');
    const vatTotal = sum(vatAccs);
    const split = !s.kor && periodFor(date, s.vatPeriod).start !== date ? periodFor(date, s.vatPeriod) : null;
    let splitVat = 0;
    if (split) {
      const inWindow = (l: XafLine) => l.date >= split.start && l.date <= until;
      const win = lines.filter(inWindow);
      const withVat = win.filter((l) => l.vat && l.vat.amount !== 0);
      let omzetHoog = 0, btwHoog = 0, omzetLaag = 0, btwLaag = 0, omzetNul = 0, voorbelasting = 0;
      const revenue = (l: XafLine) => cls.get(l.accountId) === 'omzet';
      if (withVat.length > 0) {
        for (const l of win.filter(revenue)) {
          const pct = l.vat?.percentage ?? 0;
          if (pct >= 20) omzetHoog -= l.amount;
          else if (pct > 0) omzetLaag -= l.amount;
          else omzetNul -= l.amount;
        }
        for (const l of withVat) {
          if (revenue(l)) {
            if ((l.vat!.percentage ?? 21) >= 20) btwHoog -= l.vat!.amount;
            else btwLaag -= l.vat!.amount;
          } else if (!isBalance(cls.get(l.accountId) ?? 'onbekend') || cls.get(l.accountId) === 'bezit') voorbelasting += l.vat!.amount;
        }
        // btw-bedragen staan soms positief op de regel: altijd als bedrag nemen
        btwHoog = Math.abs(btwHoog);
        btwLaag = Math.abs(btwLaag);
        voorbelasting = Math.abs(voorbelasting);
      } else {
        // geen btw per regel: uit de btw-rekeningen (let op: aangifteboekingen in deze dagen verstoren dit)
        for (const a of vatAccs) {
          const mov = win.filter((l) => l.accountId === a.id).reduce((t, l) => t + l.amount, 0);
          const k = vatKind(a);
          if (k === 'hoog') btwHoog -= mov;
          else if (k === 'laag') btwLaag -= mov;
          else if (k === 'voor') voorbelasting += mov;
        }
        const omzet = -win.filter(revenue).reduce((t, l) => t + l.amount, 0);
        omzetHoog = Math.max(0, Math.round(btwHoog / 0.21));
        omzetLaag = Math.max(0, Math.round(btwLaag / 0.09));
        omzetNul = Math.max(0, omzet - omzetHoog - omzetLaag);
      }
      const clamp = (v: number) => Math.max(0, v);
      const input: OpeningInput = { kind: 'btw-periode', omzetHoog: clamp(omzetHoog), btwHoog: clamp(btwHoog), omzetLaag: clamp(omzetLaag), btwLaag: clamp(btwLaag), omzetNul: clamp(omzetNul), voorbelasting: clamp(voorbelasting), bron: 'xaf' };
      splitVat = input.voorbelasting - input.btwHoog - input.btwLaag;
      push({ key: 'btw-periode', label: `Omzet en btw van ${formatDateNl(split.start)} tot ${formatDateNl(date)}`, input, note: withVat.length > 0 ? 'uit de btw op de boekingsregels: vergelijk met je btw-overzicht' : 'uit de btw-rekeningen berekend: vergelijk met je btw-overzicht' }, splitVat);
    }
    if (!s.kor) {
      // wat er op de btw-rekeningen staat, min het stuk dat hierboven apart geboekt wordt
      const rest = vatTotal - splitVat;
      const input: OpeningInput = rest === 0 ? { kind: 'btw', direction: 'betalen', amount: 0, bron: 'xaf' } : { kind: 'btw', direction: rest > 0 ? 'terug' : 'betalen', amount: Math.abs(rest), bron: 'xaf' };
      push({ key: 'btw', label: rest === 0 ? 'Btw: niets meer open' : rest > 0 ? 'Btw die je nog terugkrijgt' : 'Btw die je nog moet betalen', input }, rest);
    } else if (vatTotal !== 0) warnings.push(`Er staat ${formatEuro(vatTotal)} op btw-rekeningen, maar je gebruikt de KOR. Kijk het na met je boekhouder.`);

    // --- leningen, overige vorderingen en schulden: per rekening
    for (const c of ['lening', 'vordering', 'schuld'] as const) {
      for (const a of of(c)) {
        const amount = balance.get(a.id) ?? 0;
        if (amount === 0) continue;
        const kind = c === 'vordering' ? (amount > 0 ? 'vordering' : 'schuld') : amount < 0 ? c : 'vordering';
        push({ key: `${c}:${a.id}`, label: a.name, input: { kind, description: a.name, amount: Math.abs(amount), bron: 'xaf' } }, amount);
      }
    }

    // --- omzet en kosten tot de instapdatum
    if (!date.endsWith('-01-01')) {
      const omzet = -ytd(of('omzet'));
      const materiaal = ytd(of('materiaal'));
      const auto = ytd(of('auto'));
      const overig = ytd(of('kosten'));
      if (omzet < 0 || materiaal < 0 || auto < 0 || overig < 0) warnings.push('Een van de totalen van omzet of kosten tot nu toe is negatief; de app zet dat op 0. Kijk de bedragen na.');
      push(
        {
          key: 'resultaat',
          label: `Omzet en kosten van 1 januari tot ${formatDateNl(date)}`,
          input: { kind: 'resultaat', omzet: Math.max(0, omzet), materiaal: Math.max(0, materiaal), auto: Math.max(0, auto), overig: Math.max(0, overig), bron: 'xaf' },
          note: ytd(of('afschrijving')) !== 0 ? 'zonder afschrijving: die rekent de app voor het hele jaar' : null,
        },
        omzet - materiaal - auto - overig,
      );
    }

    // --- niet herkend: apart, standaard uit
    for (const a of of('onbekend')) {
      const amount = balance.get(a.id) ?? 0;
      if (amount === 0) continue;
      push({ key: `onbekend:${a.id}`, label: `${a.id} ${a.name}`, input: { kind: amount > 0 ? 'vordering' : 'schuld', description: a.name, amount: Math.abs(amount), bron: 'xaf' }, include: false, note: 'niet herkend: neem over als het iets is wat je had of nog moest betalen' }, amount);
    }

    const equity = xaf.accounts.filter((a) => isBalance(cls.get(a.id)!) && cls.get(a.id) !== 'eigen-vermogen').reduce((t, a) => t + (balance.get(a.id) ?? 0), 0);
    const known = new Set(this.relations.list({ includeArchived: true }).map((r) => r.name.toLowerCase()));
    return {
      meta: { software: xaf.software, version: xaf.version, fiscalYear: xaf.fiscalYear, startDate: xaf.startDate, endDate: xaf.endDate, company: xaf.company.name, accounts: xaf.accounts.length, lines: xaf.lines.length },
      date,
      suggestedDate,
      banks,
      proposals,
      relations: { total: xaf.relations.length, fresh: xaf.relations.filter((r) => !known.has(r.name.toLowerCase())).length },
      equity,
      accounts: xaf.accounts.map((a) => ({ id: a.id, name: a.name, rgs: a.rgs, class: cls.get(a.id)!, balance: balance.get(a.id) ?? 0 })).filter((a) => a.balance !== 0),
      warnings,
    };
  }

  /**
   * Overnemen wat de gebruiker aanvinkte. Eerder uit een auditfile overgenomen onderdelen worden
   * eerst weggehaald (niet als ze al betaald of afgeschreven zijn), zodat opnieuw inlezen niets dubbelt.
   */
  apply(xml: string, choices: XafApplyChoices): SwitchoverState {
    const s = this.settings.get();
    if (s.switchover.mode !== 'overstapper' || !s.switchover.date) throw new ValidationError('Kies eerst een instapdatum');
    const xaf = parseXaf(xml);
    const plan = this.plan(xaf, s.switchover.date);
    const include = new Set(choices.include);
    tx(this.db, () => {
      if (choices.relations) this.importRelations(xaf);
      for (const item of this.switchover.list()) {
        if ((item.data as { bron?: string }).bron === 'xaf' && !item.locked) this.switchover.remove(item.id);
      }
      for (const b of plan.banks) {
        const target = choices.banks[b.accountId];
        if (target === null || target === undefined) continue;
        const id = target === 'nieuw' ? this.bank.addAccount(b.name, b.iban && !this.bank.listAccounts().some((x) => x.iban === b.iban) ? b.iban : null).id : target;
        this.switchover.setBankOpening(id, b.amount);
      }
      // eerst de btw-periode: de omzet tot nu toe rekent daarmee
      const ordered = [...plan.proposals.filter((p) => p.input.kind === 'btw-periode'), ...plan.proposals.filter((p) => p.input.kind !== 'btw-periode')];
      for (const p of ordered) {
        if (!include.has(p.key)) continue;
        const existing = p.input.kind === 'btw' ? this.switchover.list().find((i) => i.kind === 'btw') : undefined;
        this.switchover.save(p.input, existing?.id);
      }
      this.switchover.setAccountantEquity(plan.equity);
    });
    return this.switchover.state();
  }

  /** Klanten en leveranciers overnemen die de app nog niet kent (op naam); lege velden aanvullen. */
  private importRelations(xaf: XafFile): void {
    const existing = this.relations.list({ includeArchived: true });
    for (const r of xaf.relations) {
      const type = r.type === 'S' ? 'leverancier' : r.type === 'B' ? 'beide' : 'klant';
      const match = existing.find((e) => e.name.toLowerCase() === r.name.toLowerCase() || (r.kvk && e.kvk_number === r.kvk) || (r.iban && e.iban === r.iban));
      const full = { name: r.name, type, email: r.email, phone: r.phone, address: r.address, postcode: r.postcode, city: r.city, country: r.country ?? 'NL', vat_number: r.vatNumber, kvk_number: r.kvk, iban: r.iban } as const;
      try {
        if (match) {
          const patch = Object.fromEntries(Object.entries(full).filter(([k, v]) => v && k !== 'name' && k !== 'type' && !(match as unknown as Record<string, unknown>)[k]));
          if (Object.keys(patch).length > 0) this.relations.update(match.id, patch);
        } else existing.push(this.relations.create(full));
      } catch {
        // een ongeldig btw-nummer of IBAN in de oude administratie: dan alleen de naam
        if (!match) existing.push(this.relations.create({ name: r.name, type }));
      }
    }
  }
}
