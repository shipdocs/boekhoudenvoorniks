import { AssetService } from '../tax/assets';
import { accountOpenItems } from '../core-ledger/open-items';
import type { Db } from '../db/database';
import type { Ledger } from '../core-ledger/ledger';
import { ACCOUNTS } from '../core-ledger/accounts';
import { formatEuro, type Cents } from '../shared/money';
import { addDays, periodFor, type IsoDate, type Period } from '../shared/dates';
import type { CarPrivateUse } from './car';
import { EU_B2C_THRESHOLD, EU_COUNTRIES, countryCode } from '../shared/vat';
import { BankPurchaseMatcher, purchaseSupplierName, type PurchaseProbe } from '../documents/bank-purchase-match';

/**
 * Controles vóór de btw-aangifte (#20): alles wat de aangifte fout kan maken. Blokkerende
 * controles moeten opgelost of bewust overgeslagen zijn voordat de aangifte als ingediend
 * gemarkeerd kan worden. Een overgeslagen controle komt terug als de situatie verandert.
 */
export interface VatCheck {
  /** stabiel binnen een periode, bv. "bank-open" */
  key: string;
  blocking: boolean;
  title: string;
  detail: string;
  count: number;
  /** verandert als de onderliggende situatie verandert */
  fingerprint: string;
  skipped: boolean;
  skipReason: string | null;
  /** scherm om het op te lossen */
  screen: 'bank' | 'aankopen' | 'werk' | 'expert' | 'belasting' | 'instellingen';
  /** het gaat om het saldo van deze rekening: "Oplossen" toont de boekingen die erop staan */
  account?: { rgs: string; upTo?: IsoDate };
  /** oplossen met één knop in plaats van naar een scherm te gaan */
  action?: { id: 'auto-prive'; label: string };
  /** om welke betalingen, aankopen of facturen het gaat, zodat je ze kunt openen */
  items?: CheckItem[];
}

export interface CheckItem {
  kind: 'bank' | 'aankoop' | 'document' | 'factuur';
  id: number;
  date: IsoDate | null;
  label: string;
  amount: Cents | null;
  /** bv. de omschrijving van de betaling ("FACTUUR F0000.2607.0000.1394"): helpt de goede bon te vinden */
  hint?: string | null;
}

/** Kosten vanaf dit bedrag (incl. btw) horen een bewijsstuk te hebben. */
export const EVIDENCE_THRESHOLD: Cents = 10000;
/** Verschil met het vorige tijdvak dat we melden (signaal, geen blokkade). */
export const BIG_CHANGE_MIN: Cents = 50000;

/**
 * ICP-opgaaf voor goederen: alleen per kwartaal als de leveringen in dat kwartaal én in elk van de vier
 * kwartalen ervoor niet boven dit bedrag kwamen (ICP-toelichting Belastingdienst; geldt niet voor diensten).
 * Precies € 50.000 is dus nog geen overschrijding.
 */
export const ICP_MONTHLY_GOODS_LIMIT: Cents = 5000000;
/** Een afwijking tussen btw en omzet tot dit bedrag is afronding, geen fout. */
export const RATE_TOLERANCE: Cents = 100;

function icpGoodsBetween(db: Db, from: IsoDate, to: IsoDate): Cents {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS s FROM journal_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
       WHERE a.rgs_code = ? AND COALESCE(e.vat_date, e.entry_date) BETWEEN ? AND ? AND e.source NOT IN ('btw', 'opening')`,
    )
    .get(ACCOUNTS.omzetIcp, from, to) as { s: number };
  return r.s;
}

/** Het kwartaal waarin `periodEnd` valt en de vier ervoor, met de ICP-goederen per kwartaal (nieuwste eerst). */
export function icpGoodsByQuarter(db: Db, periodEnd: IsoDate): { period: Period; amount: Cents }[] {
  const out: { period: Period; amount: Cents }[] = [];
  let q = periodFor(periodEnd, 'kwartaal');
  for (let i = 0; i < 5; i++) {
    out.push({ period: q, amount: icpGoodsBetween(db, q.start, q.end) });
    q = periodFor(addDays(q.start, -1), 'kwartaal');
  }
  return out;
}

/** Verkoopboekingen waarvan de btw niet past bij het tarief van de omzetrekening (21% of 9%). */
export function rateMismatches(db: Db, start: IsoDate, end: IsoDate): { entryId: number; date: IsoDate; description: string; pct: number; base: Cents; vat: Cents; expected: Cents }[] {
  const out: ReturnType<typeof rateMismatches> = [];
  for (const [pct, revenue, vatAccount] of [
    [21, ACCOUNTS.omzetHoog, ACCOUNTS.btwAfdragenHoog],
    [9, ACCOUNTS.omzetLaag, ACCOUNTS.btwAfdragenLaag],
  ] as const) {
    const rows = db
      .prepare(
        `SELECT e.id AS entryId, e.entry_date AS date, e.description,
           SUM(CASE WHEN a.rgs_code = ? THEN l.credit - l.debit ELSE 0 END) AS base,
           SUM(CASE WHEN a.rgs_code = ? THEN l.credit - l.debit ELSE 0 END) AS vat
         FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
         WHERE a.rgs_code IN (?, ?) AND COALESCE(e.vat_date, e.entry_date) BETWEEN ? AND ? AND e.source NOT IN ('btw', 'opening')
         GROUP BY e.id HAVING base <> 0 OR vat <> 0 ORDER BY e.entry_date, e.id`,
      )
      .all(revenue, vatAccount, revenue, vatAccount, start, end) as { entryId: number; date: IsoDate; description: string; base: number; vat: number }[];
    for (const r of rows) {
      const expected = Math.round((r.base * pct) / 100);
      if (Math.abs(r.vat - expected) > RATE_TOLERANCE) out.push({ ...r, pct, expected });
    }
  }
  return out;
}

export function skipKey(periodKey: string, checkKey: string): string {
  return `vat-check:${periodKey}:${checkKey}`;
}

export function runVatChecks(
  db: Db,
  ledger: Ledger,
  period: Period,
  payable: { current: Cents; previous: Cents | null },
  /** alleen in de laatste aangifte van het jaar */
  car: { year: number; due: CarPrivateUse; booked: Cents } | null = null,
  /** alleen in de laatste aangifte van het jaar: omzet volgens alle aangiftes tegenover de omzet in het grootboek */
  turnover: { year: number; aangifte: Cents; grootboek: Cents } | null = null,
): VatCheck[] {
  const found: Omit<VatCheck, 'skipped' | 'skipReason'>[] = [];
  const { start, end } = period;

  const bank = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM bank_transactions WHERE status = 'nieuw' AND transaction_date BETWEEN ? AND ?`).get(start, end) as { n: number; s: number };
  if (bank.n > 0) {
    const items = (db.prepare(`SELECT id, transaction_date AS date, COALESCE(counter_name, description) AS label, amount FROM bank_transactions WHERE status = 'nieuw' AND transaction_date BETWEEN ? AND ? ORDER BY transaction_date LIMIT 50`).all(start, end) as Omit<CheckItem, 'kind'>[]).map((i) => ({ ...i, kind: 'bank' as const }));
    found.push({ key: 'bank-open', blocking: true, title: `${bank.n} betalingen moet je nog uitzoeken`, detail: 'Verwerk ze eerst, anders mis je mogelijk btw die je terug kunt krijgen.', count: bank.n, fingerprint: JSON.stringify(db.prepare(`SELECT id, amount FROM bank_transactions WHERE status = 'nieuw' AND transaction_date BETWEEN ? AND ? ORDER BY id`).all(start, end)), screen: 'bank', items });
  }

  const noEvidencePurchases = db
    .prepare(
      `SELECT p.id, p.total, p.invoice_date AS date, COALESCE(r.name, p.description) AS label FROM purchase_invoices p LEFT JOIN relations r ON r.id = p.relation_id
       WHERE p.invoice_date BETWEEN ? AND ? AND p.total >= ? AND p.attachment_path IS NULL AND p.document_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM document_links k WHERE k.purchase_invoice_id = p.id)`,
    )
    .all(start, end, EVIDENCE_THRESHOLD) as { id: number; total: number; date: IsoDate; label: string }[];
  const noEvidenceBank = db
    .prepare(
      `SELECT b.id, b.amount, b.transaction_date AS date, COALESCE(b.counter_name, b.description) AS label, b.description AS hint FROM bank_transactions b
       WHERE b.status = 'gematcht' AND b.matched_invoice_id IS NULL AND b.matched_purchase_invoice_id IS NULL
         AND b.amount <= ? AND b.transaction_date BETWEEN ? AND ?
         AND EXISTS (SELECT 1 FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
                     WHERE l.journal_entry_id = b.matched_journal_entry_id AND a.category = 'kosten')
         AND NOT EXISTS (SELECT 1 FROM document_links k WHERE k.bank_transaction_id = b.id)`,
    )
    .all(-EVIDENCE_THRESHOLD, start, end) as { id: number; amount: number; date: IsoDate; label: string; hint: string | null }[];
  const missing = noEvidencePurchases.length + noEvidenceBank.length;
  if (missing > 0) {
    found.push({
      key: 'bewijs',
      blocking: true,
      title: `${missing} ${missing === 1 ? 'uitgave' : 'uitgaven'} vanaf ${formatEuro(EVIDENCE_THRESHOLD)} zonder bonnetje of factuur`,
      detail: 'Zonder bon of factuur kan de Belastingdienst de btw terugvragen. Voeg een foto of PDF toe, of sla over als je het echt niet hebt.',
      count: missing,
      fingerprint: [...noEvidencePurchases.map((p) => `p${p.id}`), ...noEvidenceBank.map((b) => `b${b.id}`)].join(','),
      screen: 'aankopen',
      items: [
        ...noEvidencePurchases.map((p) => ({ kind: 'aankoop' as const, id: p.id, date: p.date, label: p.label, amount: -p.total })),
        ...noEvidenceBank.map((b) => ({ kind: 'bank' as const, id: b.id, date: b.date, label: b.label, amount: b.amount, hint: b.hint && b.hint !== b.label ? b.hint : null })),
      ],
    });
  }

  const dupDocs = db
    .prepare(
      `SELECT id, json_extract(result, '$.invoiceDate.value') AS date, COALESCE(json_extract(result, '$.supplier.value'), original_name) AS label, json_extract(result, '$.total.value') AS total
       FROM documents WHERE status = 'controle' AND issues LIKE '%"field":"duplicate"%' AND json_extract(result, '$.invoiceDate.value') BETWEEN ? AND ?`,
    )
    .all(start, end) as { id: number; date: IsoDate; label: string; total: number | null }[];
  // twee aankopen die dezelfde lijken, en een aankoop waarvan de betaling ook los op de bank geboekt is (#221)
  const doubles = new BankPurchaseMatcher(db).doubles(start, end);
  const dups = dupDocs.length + doubles.purchases.length + doubles.bank.length;
  if (dups > 0) {
    const supplier = (p: PurchaseProbe) => purchaseSupplierName(p) ?? 'Aankoop';
    found.push({
      key: 'dubbel',
      blocking: true,
      title: `${dups} mogelijk dubbele ${dups === 1 ? 'aankoop' : 'aankopen'}`,
      detail:
        'Zelfde leverancier en bedrag rond dezelfde datum, of een betaling die ook los als kosten of op "weet ik nog niet" staat. Controleer of je kosten en btw niet twee keer telt.' +
        (doubles.bank.length > 0 ? ' Op Vandaag staat bij zo\'n betaling de vraag "staat deze aankoop dubbel?"; daar kies je ja of nee.' : ''),
      count: dups,
      fingerprint: [...dupDocs.map((d) => `d${d.id}`), ...doubles.purchases.map((p) => `p${p.a.id}-${p.b.id}`), ...doubles.bank.map((x) => `b${x.transaction.id}-p${x.purchase.id}`)].join(','),
      screen: 'aankopen',
      items: [
        ...dupDocs.map((d) => ({ kind: 'document' as const, id: d.id, date: d.date, label: `Bon ${d.label}`, amount: d.total === null ? null : -d.total })),
        ...doubles.purchases.flatMap(({ a, b }) => [a, b].map((p) => ({ kind: 'aankoop' as const, id: p.id, date: p.invoice_date, label: `${supplier(p)} (mogelijk dubbel)`, amount: -p.total }))),
        ...doubles.bank.flatMap(({ purchase: p, transaction: t }) => [
          { kind: 'bank' as const, id: t.id, date: t.transaction_date, label: `${t.counter_name ?? t.description} (betaling, los geboekt)`, amount: t.amount },
          { kind: 'aankoop' as const, id: p.id, date: p.invoice_date, label: `${supplier(p)} (mogelijk dezelfde betaling)`, amount: -p.total },
        ]),
      ],
    });
  }

  const assetCredits = new AssetService(db, ledger).pendingCredits().filter(c => c.date <= end);
  if (assetCredits.length) found.push({ key: 'investering-credit', blocking: true, title: `${assetCredits.length} creditnota's moeten nog aan een investering worden gekoppeld`, detail: 'Kies bij Belasting → Voor je aangifte → Investeringen het bedrijfsmiddel. De kostprijs, afschrijving en investeringsaftrek kunnen anders afwijken van je boekhouding.', count: assetCredits.length, fingerprint: JSON.stringify(assetCredits.map(c => [c.lineId, c.amount])), screen: 'belasting' });

  const reverseNoVat = db
    .prepare(
      `SELECT DISTINCT i.id, i.number, i.invoice_date AS date, r.name AS relation FROM invoices i JOIN relations r ON r.id = i.relation_id
       WHERE i.status <> 'concept' AND i.invoice_date BETWEEN ? AND ? AND TRIM(COALESCE(r.vat_number, '')) = ''
         AND EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id AND l.vat_code IN ('verlegd', 'icp', 'icp-dienst'))`,
    )
    .all(start, end) as { id: number; number: string | null; date: IsoDate; relation: string }[];
  if (reverseNoVat.length > 0) {
    found.push({
      key: 'verlegd-btwnummer',
      blocking: true,
      title: `${reverseNoVat.length} ${reverseNoVat.length === 1 ? 'factuur' : 'facturen'} met btw verlegd zonder btw-nummer van de klant`,
      detail: `Btw verlegd betekent: jij rekent geen btw, je klant (een bedrijf) regelt die zelf. Daarom moet zijn btw-nummer op de factuur staan (${reverseNoVat.map((i) => i.number ?? '?').join(', ')}). Vul het in bij de klant.`,
      count: reverseNoVat.length,
      fingerprint: reverseNoVat.map((i) => i.id).join(','),
      screen: 'werk',
      items: reverseNoVat.map((i) => ({ kind: 'factuur' as const, id: i.id, date: i.date, label: `Factuur ${i.number ?? '?'} · ${i.relation}`, amount: null })),
    });
  }

  const kas = ledger.balance(ACCOUNTS.kas);
  if (kas < 0) {
    found.push({ key: 'kas-negatief', blocking: true, title: `Je contante geld staat op ${formatEuro(kas)}`, detail: 'Je hebt meer contant uitgegeven dan er binnenkwam. Waarschijnlijk mist er contant ontvangen geld, of geld dat je van de bank opnam.', count: 1, fingerprint: String(kas), screen: 'aankopen', account: { rgs: ACCOUNTS.kas } });
  }

  const questionItems = accountOpenItems(db, ACCOUNTS.vraagposten, end);
  if (questionItems.length > 0) {
    const gross = questionItems.reduce((s, i) => s + Math.abs(i.net), 0);
    found.push({ key: 'vraagposten', blocking: true, title: `${questionItems.length} boekingen (${formatEuro(gross)}) staan nog bij "weet ik nog niet"`, detail: 'Zoek elke betaling of bon uit. Ontvangsten en uitgaven die elkaar opheffen blijven afzonderlijk zichtbaar; er kan btw in zitten.', count: questionItems.length, fingerprint: JSON.stringify(questionItems.map(i => [i.id, i.net])), screen: 'bank', account: { rgs: ACCOUNTS.vraagposten, upTo: end } });
  }

  // Geld "onderweg" tussen eigen rekeningen of van een betaalprovider: dan mist er meestal een afschrift
  const onderweg = ledger.balance(ACCOUNTS.kruisposten, { to: end });
  if (onderweg !== 0) {
    found.push({
      key: 'onderweg',
      blocking: false,
      title: `${formatEuro(Math.abs(onderweg))} staat nog "onderweg" tussen je eigen rekeningen`,
      detail: 'Er is geld overgemaakt tussen je eigen rekeningen, maar de andere kant staat er nog niet in. Lees het afschrift van die andere rekening in. Kwam het pas na deze periode binnen? Dan klopt het. Ging het naar een potje zonder eigen rekeningnummer (zoals een Knab-potje)? Voeg het potje toe bij Bank → Rekening toevoegen (rekeningnummer leeg laten), maak de betaling ongedaan en kies "Naar potje".',
      count: 1,
      fingerprint: String(onderweg),
      screen: 'bank',
      account: { rgs: ACCOUNTS.kruisposten, upTo: end },
    });
  }
  const psp = ledger.balance(ACCOUNTS.tussenrekeningPsp, { to: end });
  if (psp !== 0) {
    found.push({
      key: 'psp',
      blocking: false,
      title: `${formatEuro(Math.abs(psp))} van je betaalprovider is nog niet op je bank binnen`,
      detail: 'Betalingen via bijvoorbeeld Mollie of Stripe horen na een paar dagen op je bankrekening te staan. Lees je nieuwste bankafschrift in. Kwam de uitbetaling pas na deze periode? Dan klopt het.',
      count: 1,
      fingerprint: String(psp),
      screen: 'bank',
      account: { rgs: ACCOUNTS.tussenrekeningPsp, upTo: end },
    });
  }
  // Een spaarrekening of potje kan niet negatief staan (de eerste, gewone rekening mag wel rood staan)
  const extra = db.prepare('SELECT b.id, b.name, a.rgs_code FROM bank_accounts b JOIN chart_of_accounts a ON a.id = b.account_id ORDER BY b.id').all() as { id: number; name: string; rgs_code: string }[];
  for (const acc of extra.slice(1)) {
    const saldo = ledger.balance(acc.rgs_code, { to: end });
    if (saldo < 0) {
      found.push({
        key: `rekening-negatief-${acc.id}`,
        blocking: false,
        title: `Je rekening ${acc.name} staat op ${formatEuro(saldo)}`,
        detail: 'Een spaarrekening of potje kan niet negatief staan. Waarschijnlijk mist er een afschrift van die rekening, of het beginsaldo (Bank → Rekeningen → Beginsaldo).',
        count: 1,
        fingerprint: String(saldo),
        screen: 'bank',
        account: { rgs: acc.rgs_code, upTo: end },
      });
    }
  }

  // Buitenlandse klanten: btw-keuze op de factuur
  const invoices = db
    .prepare(
      `SELECT i.id, i.number, r.name, r.country, r.vat_number, GROUP_CONCAT(DISTINCT l.vat_code) AS codes
       FROM invoices i JOIN relations r ON r.id = i.relation_id JOIN invoice_lines l ON l.invoice_id = i.id
       WHERE i.number IS NOT NULL AND i.invoice_date BETWEEN ? AND ? AND UPPER(COALESCE(r.country, 'NL')) <> 'NL'
       GROUP BY i.id ORDER BY i.number`,
    )
    .all(start, end) as { id: number; number: string; name: string; country: string; vat_number: string | null; codes: string }[];
  const euBusinessWithVat = invoices.filter((i) => {
    const c = countryCode(i.country);
    return c && EU_COUNTRIES.has(c) && i.vat_number && i.codes.split(',').some((x) => x === 'hoog' || x === 'laag');
  });
  if (euBusinessWithVat.length > 0) {
    const first = euBusinessWithVat[0]!;
    found.push({
      key: 'eu-bedrijf-met-btw',
      blocking: false,
      title: `${euBusinessWithVat.length === 1 ? `Factuur ${first.number}` : `${euBusinessWithVat.length} facturen`} aan een bedrijf in een ander EU-land met Nederlandse btw`,
      detail: `Bij een bedrijf in een ander EU-land (zoals ${first.name}) verleg je de btw meestal: kies "Dienst aan een bedrijf in een ander EU-land" (of "Goederen …" als je spullen levert). Alleen bij werk aan een gebouw of grond in Nederland reken je Nederlandse btw. Klopt het niet? Maak een creditfactuur en een nieuwe factuur. Twijfel je? Vraag je boekhouder.`,
      count: euBusinessWithVat.length,
      fingerprint: euBusinessWithVat.map((i) => i.id).join(','),
      screen: 'werk',
    });
  }
  // Particulieren in andere EU-landen. De drempel van € 10.000 geldt alleen voor afstandsverkopen van
  // goederen en voor digitale diensten (telecom, omroep, elektronisch). Voor andere diensten hangt de
  // plaats van heffing af van het soort dienst (bv. werk aan een gebouw: altijd in dat land). De app
  // kent het soort prestatie niet, dus: waarschuwen dat het gecontroleerd moet worden.
  const year = end.slice(0, 4);
  const euConsumers = (
    db
      .prepare(
        `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS s FROM journal_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN chart_of_accounts a ON a.id = l.account_id
         JOIN relations r ON r.id = l.relation_id
         WHERE a.rgs_code IN (?, ?) AND e.entry_date BETWEEN ? AND ? AND e.source = 'factuur'
           AND UPPER(COALESCE(r.country, 'NL')) IN (${[...EU_COUNTRIES].filter((c) => c !== 'NL').map(() => '?').join(',')})
           AND COALESCE(r.vat_number, '') = ''`,
      )
      .get(ACCOUNTS.omzetHoog, ACCOUNTS.omzetLaag, `${year}-01-01`, end, ...[...EU_COUNTRIES].filter((c) => c !== 'NL')) as { s: number }
  ).s;
  if (euConsumers > 0) {
    const above = euConsumers > EU_B2C_THRESHOLD;
    found.push({
      key: above ? 'oss-drempel' : 'eu-particulier',
      blocking: false,
      title: above ? `Meer dan ${formatEuro(EU_B2C_THRESHOLD)} verkocht aan particulieren in andere EU-landen` : 'Verkocht aan particulieren in andere EU-landen: controleer de btw',
      detail: `Dit jaar ${formatEuro(euConsumers)} met Nederlandse btw. ${
        above
          ? `Stuur je spullen op of lever je digitale diensten, dan reken je boven ${formatEuro(EU_B2C_THRESHOLD)} per jaar de btw van het land van de klant (via de "OSS-regeling").`
          : `Voor spullen die je opstuurt en digitale diensten mag dat tot ${formatEuro(EU_B2C_THRESHOLD)} per jaar.`
      } Voor andere diensten hangt het af van wat je doet: werk aan een huis of gebouw in dat land is bijvoorbeeld altijd belast in dat land. Dat regelt de app niet: laat je boekhouder controleren welke btw geldt.`,
      count: 1,
      fingerprint: `${year}:${above ? 'boven' : 'onder'}`,
      screen: 'belasting',
    });
  }

  if (car && car.due.state === 'onbekend') {
    found.push({
      key: 'auto-prive',
      blocking: true,
      title: 'Vul de btw-gegevens voor privégebruik van je auto aan',
      detail: 'Dan betaal je misschien in deze laatste aangifte van het jaar btw over dat privégebruik. Vul de aanschaf-btw en afgetrokken btw op autokosten in bij Instellingen → Btw en belasting in of je privé rijdt, of je btw hebt teruggekregen op de auto of de kosten, hoe je het privégebruik berekent, wat de cataloguswaarde is en sinds wanneer je hem gebruikt.',
      count: 1,
      fingerprint: `onbekend:${car.year}`,
      screen: 'instellingen',
    });
  } else if (car && car.due.state === 'werkelijk') {
    found.push({
      key: 'auto-prive',
      blocking: false,
      title: 'Btw over privégebruik van je auto: laat je boekhouder het bedrag uitrekenen',
      detail: 'Je rekent met je werkelijke privégebruik (rittenadministratie). Dat bedrag rekent de app niet uit: laat je boekhouder het berekenen en boek het in vak 1d van deze aangifte.',
      count: 1,
      fingerprint: `werkelijk:${car.year}`,
      screen: 'belasting',
    });
  } else if (car && car.due.state === 'bekend' && car.due.amount !== car.booked) {
    const { amount, pct, catalogValue, months } = car.due;
    found.push({
      key: 'auto-prive',
      blocking: true,
      title: `Btw over privégebruik van je auto: ${formatEuro(amount)}`,
      detail:
        `Je rijdt ook privé in je auto van de zaak. Daarover betaal je één keer per jaar btw: ${(pct * 100).toLocaleString('nl-NL')}% van de cataloguswaarde (${formatEuro(catalogValue)}). ` +
        `${months < 12 ? `Je gebruikt de auto pas sinds dit jaar, dus over ${months} ${months === 1 ? 'maand' : 'maanden'}. ` : ''}De correctie is begrensd op de afgetrokken autokosten-btw, plus waar van toepassing een vijfde van de aanschaf-btw. Dit komt in vak 1d van deze aangifte.`,
      count: 1,
      fingerprint: `${car.year}:${amount}:${car.booked}`,
      screen: 'belasting',
      action: { id: 'auto-prive', label: car.booked ? 'Bedrag bijwerken' : 'Neem op in deze aangifte' },
    });
  }

  // ICP-goederen boven € 50.000 per kwartaal: de opgaaf moet dan per maand
  const quarters = icpGoodsByQuarter(db, end);
  const overLimit = quarters.filter((q) => q.amount > ICP_MONTHLY_GOODS_LIMIT);
  if (quarters[0]!.amount !== 0 && overLimit.length > 0) {
    const months: string[] = [];
    for (let m = quarters[0]!.period.start; m <= quarters[0]!.period.end; m = addDays(periodFor(m, 'maand').end, 1)) {
      const mp = periodFor(m, 'maand');
      months.push(`${mp.label}: ${formatEuro(icpGoodsBetween(db, mp.start, mp.end))}`);
    }
    found.push({
      key: 'icp-maandelijks',
      blocking: false,
      title: `Je ICP-opgaaf voor goederen moet per maand, niet per kwartaal`,
      detail:
        `Je leverde in ${overLimit.map((q) => `${q.period.label} (${formatEuro(q.amount)})`).join(' en ')} meer dan ${formatEuro(ICP_MONTHLY_GOODS_LIMIT)} aan goederen aan bedrijven in andere EU-landen. ` +
        `Dan doe je de opgaaf intracommunautaire prestaties (ICP) voor goederen per maand, binnen een maand na afloop van elke maand, totdat je vijf kwartalen op rij onder die grens blijft. Voor diensten blijft per kwartaal genoeg. ` +
        `Goederen per maand: ${months.join('; ')}. Het overzicht per maand zie je bij ICP met de periode van die maand.`,
      count: 1,
      fingerprint: quarters.map((q) => `${q.period.key}:${q.amount}`).join(','),
      screen: 'belasting',
    });
  }

  // Past de btw bij het tarief? Een verkeerde btw-code of een handmatig btw-bedrag valt zo op.
  const wrongRate = rateMismatches(db, start, end);
  if (wrongRate.length > 0) {
    const sample = wrongRate.slice(0, 5).map((r) => `${r.description || `boeking ${r.entryId}`}: btw ${formatEuro(r.vat)}, bij ${r.pct}% over ${formatEuro(r.base)} verwacht je ${formatEuro(r.expected)}`);
    found.push({
      key: 'tarief-plausibel',
      blocking: false,
      title: `${wrongRate.length} ${wrongRate.length === 1 ? 'verkoop' : 'verkopen'} waarvan de btw niet bij het tarief past`,
      detail: `Op omzet tegen 21% of 9% hoort ongeveer dat percentage aan btw te staan. ${sample.join('; ')}${wrongRate.length > sample.length ? '; …' : ''}. Waarschijnlijk is een verkeerde btw-keuze of een verkeerd btw-bedrag ingevuld. Klopt het wel (bijvoorbeeld een gemengde boeking)? Sla deze controle dan over.`,
      count: wrongRate.length,
      fingerprint: wrongRate.map((r) => `${r.entryId}:${r.base}:${r.vat}`).join(','),
      screen: 'expert',
    });
  }

  // Rekening-courant met de Belastingdienst: na elke aangifte en betaling hoort die op nul te staan
  // (of op het bedrag van de vorige aangifte als dat nog betaald moet worden).
  // Saldo tot het eind van deze periode, zonder de boeking van deze aangifte zelf: de betaling van de vorige
  // aangifte valt meestal in deze periode. Verwacht: nul (betaald) of precies de vorige aangifte (nog te betalen).
  const afrekening = (
    db
      .prepare(
        `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS s FROM journal_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
         WHERE a.rgs_code = ? AND e.entry_date <= ? AND COALESCE(e.source_ref, '') <> ?`,
      )
      .get(ACCOUNTS.btwAfrekening, end, `vat:${period.key}`) as { s: number }
  ).s;
  const verwacht = -(payable.previous ?? 0);
  if (afrekening !== 0 && afrekening !== verwacht) {
    found.push({
      key: 'btw-afrekening',
      blocking: false,
      title: `De rekening met de Belastingdienst staat op ${formatEuro(Math.abs(afrekening))} ${afrekening < 0 ? 'te betalen' : 'te ontvangen'}`,
      detail: `Voor deze aangifte hoort die rekening op nul te staan, of op het bedrag van de vorige aangifte (${formatEuro(Math.abs(payable.previous ?? 0))}) als je dat nog moet betalen. Dit verschil betekent meestal dat een betaling aan of teruggave van de Belastingdienst niet (of voor een ander bedrag) is gekoppeld, of dat een suppletie nog niet is betaald. Bekijk de boekingen en koppel de betaling.`,
      count: 1,
      fingerprint: String(afrekening),
      screen: 'bank',
      account: { rgs: ACCOUNTS.btwAfrekening, upTo: end },
    });
  }

  if (turnover && Math.abs(turnover.aangifte - turnover.grootboek) >= RATE_TOLERANCE) {
    const diff = turnover.grootboek - turnover.aangifte;
    found.push({
      key: 'omzet-afstemming',
      blocking: false,
      title: `De omzet in je btw-aangiftes van ${turnover.year} wijkt ${formatEuro(Math.abs(diff))} af van je omzet in de boekhouding`,
      detail: `Aangiftes: ${formatEuro(turnover.aangifte)}, boekhouding: ${formatEuro(turnover.grootboek)}. Een boekhouder zoekt dit altijd uit, want de Belastingdienst vergelijkt de omzet in de btw-aangifte met die in de inkomstenbelasting. Meestal komt het door facturen die aan het eind van het jaar zijn gecorrigeerd en pas in het volgende jaar in de aangifte komen, of door een correctie die via een suppletie loopt.`,
      count: 1,
      fingerprint: `${turnover.year}:${turnover.aangifte}:${turnover.grootboek}`,
      screen: 'belasting',
    });
  }

  if (payable.previous !== null && payable.previous !== 0) {
    const diff = payable.current - payable.previous;
    if (Math.abs(diff) >= BIG_CHANGE_MIN && Math.abs(diff) >= Math.abs(payable.previous) / 2) {
      found.push({
        key: 'groot-verschil',
        blocking: false,
        title: `Veel ${diff > 0 ? 'meer' : 'minder'} btw dan vorige keer`,
        detail: `Nu ${formatEuro(payable.current)}, vorige keer ${formatEuro(payable.previous)}. Klopt dat? Dit is alleen een signaal.`,
        count: 1,
        fingerprint: `${payable.current}:${payable.previous}`,
        screen: 'belasting',
      });
    }
  }

  const skips = db.prepare(`SELECT task_key, fingerprint, reason FROM task_skips WHERE task_key LIKE ?`).all(`vat-check:${period.key}:%`) as { task_key: string; fingerprint: string; reason: string }[];
  return found.map((c) => {
    const skip = skips.find((s) => s.task_key === skipKey(period.key, c.key) && s.fingerprint === c.fingerprint);
    return { ...c, skipped: !!skip, skipReason: skip?.reason ?? null };
  });
}
