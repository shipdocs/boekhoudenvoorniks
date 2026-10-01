import type { Db } from '../db/database';
import type { Ledger } from '../core-ledger/ledger';
import { ACCOUNTS } from '../core-ledger/accounts';
import { formatEuro, type Cents } from '../shared/money';
import type { IsoDate, Period } from '../shared/dates';
import type { CarPrivateUse } from './car';
import { EU_B2C_THRESHOLD, EU_COUNTRIES, countryCode } from '../shared/vat';

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
): VatCheck[] {
  const found: Omit<VatCheck, 'skipped' | 'skipReason'>[] = [];
  const { start, end } = period;

  const bank = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM bank_transactions WHERE status = 'nieuw' AND transaction_date BETWEEN ? AND ?`).get(start, end) as { n: number; s: number };
  if (bank.n > 0) {
    const items = (db.prepare(`SELECT id, transaction_date AS date, COALESCE(counter_name, description) AS label, amount FROM bank_transactions WHERE status = 'nieuw' AND transaction_date BETWEEN ? AND ? ORDER BY transaction_date LIMIT 50`).all(start, end) as Omit<CheckItem, 'kind'>[]).map((i) => ({ ...i, kind: 'bank' as const }));
    found.push({ key: 'bank-open', blocking: true, title: `${bank.n} betalingen moet je nog uitzoeken`, detail: 'Verwerk ze eerst, anders mis je mogelijk btw die je terug kunt krijgen.', count: bank.n, fingerprint: `${bank.n}:${bank.s}`, screen: 'bank', items });
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
  const dupPurchases = db
    .prepare(
      `SELECT a.id AS a, b.id AS b, b.invoice_date AS date, b.total AS total, (SELECT name FROM relations WHERE id = b.relation_id) AS label FROM purchase_invoices a JOIN purchase_invoices b
         ON a.id < b.id AND a.relation_id = b.relation_id AND a.total = b.total
        AND ABS(julianday(a.invoice_date) - julianday(b.invoice_date)) <= 3
        AND (a.supplier_reference IS NULL OR b.supplier_reference IS NULL OR a.supplier_reference = b.supplier_reference)
       WHERE b.invoice_date BETWEEN ? AND ?`,
    )
    .all(start, end) as { a: number; b: number; date: IsoDate; total: number; label: string | null }[];
  const dups = dupDocs.length + dupPurchases.length;
  if (dups > 0) {
    found.push({
      key: 'dubbel',
      blocking: true,
      title: `${dups} mogelijk dubbele ${dups === 1 ? 'aankoop' : 'aankopen'}`,
      detail: 'Zelfde leverancier en bedrag rond dezelfde datum. Controleer of je niet twee keer btw terugvraagt.',
      count: dups,
      fingerprint: [...dupDocs.map((d) => `d${d.id}`), ...dupPurchases.map((p) => `p${p.a}-${p.b}`)].join(','),
      screen: 'aankopen',
      items: [
        ...dupDocs.map((d) => ({ kind: 'document' as const, id: d.id, date: d.date, label: `Bon ${d.label}`, amount: d.total === null ? null : -d.total })),
        ...dupPurchases.flatMap((p) => [p.a, p.b].map((id) => ({ kind: 'aankoop' as const, id, date: p.date, label: `${p.label ?? 'Aankoop'} (mogelijk dubbel)`, amount: -p.total }))),
      ],
    });
  }

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

  const vraag = ledger.balance(ACCOUNTS.vraagposten);
  if (vraag !== 0) {
    found.push({ key: 'vraagposten', blocking: true, title: `${formatEuro(Math.abs(vraag))} staat nog bij "weet ik nog niet"`, detail: 'Zoek uit waar deze betalingen of bonnen bij horen (of vraag het je boekhouder): er kan btw in zitten die je terugkrijgt. Een bon deel je hier meteen in met Indelen (of later bij Aankopen).', count: 1, fingerprint: String(vraag), screen: 'bank', account: { rgs: ACCOUNTS.vraagposten } });
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
      title: 'Rijd je ook privé in je auto van de zaak?',
      detail: 'Dan betaal je misschien in deze laatste aangifte van het jaar btw over dat privégebruik. Vul bij Instellingen → Btw en belasting in of je privé rijdt, of je btw hebt teruggekregen op de auto of de kosten, hoe je het privégebruik berekent, wat de cataloguswaarde is en sinds wanneer je hem gebruikt.',
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
        `${months < 12 ? `Je gebruikt de auto pas sinds dit jaar, dus over ${months} ${months === 1 ? 'maand' : 'maanden'}. ` : ''}Dit komt in vak 1d van deze aangifte.`,
      count: 1,
      fingerprint: `${car.year}:${amount}:${car.booked}`,
      screen: 'belasting',
      action: { id: 'auto-prive', label: car.booked ? 'Bedrag bijwerken' : 'Neem op in deze aangifte' },
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
