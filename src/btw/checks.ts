import type { Db } from '../db/database';
import type { Ledger } from '../core-ledger/ledger';
import { ACCOUNTS } from '../core-ledger/accounts';
import { formatEuro, type Cents } from '../shared/money';
import type { Period } from '../shared/dates';

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
  screen: 'bank' | 'aankopen' | 'werk' | 'expert' | 'belasting';
}

/** Kosten vanaf dit bedrag (incl. btw) horen een bewijsstuk te hebben. */
export const EVIDENCE_THRESHOLD: Cents = 10000;
/** Verschil met het vorige tijdvak dat we melden (signaal, geen blokkade). */
export const BIG_CHANGE_MIN: Cents = 50000;

export function skipKey(periodKey: string, checkKey: string): string {
  return `vat-check:${periodKey}:${checkKey}`;
}

export function runVatChecks(db: Db, ledger: Ledger, period: Period, payable: { current: Cents; previous: Cents | null }): VatCheck[] {
  const found: Omit<VatCheck, 'skipped' | 'skipReason'>[] = [];
  const { start, end } = period;

  const bank = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS s FROM bank_transactions WHERE status = 'nieuw' AND transaction_date BETWEEN ? AND ?`).get(start, end) as { n: number; s: number };
  if (bank.n > 0) {
    found.push({ key: 'bank-open', blocking: true, title: `${bank.n} betalingen moet je nog uitzoeken`, detail: 'Verwerk ze eerst, anders mis je mogelijk btw die je terug kunt krijgen.', count: bank.n, fingerprint: `${bank.n}:${bank.s}`, screen: 'bank' });
  }

  const noEvidencePurchases = db
    .prepare(`SELECT id, total FROM purchase_invoices WHERE invoice_date BETWEEN ? AND ? AND total >= ? AND attachment_path IS NULL AND document_id IS NULL`)
    .all(start, end, EVIDENCE_THRESHOLD) as { id: number; total: number }[];
  const noEvidenceBank = db
    .prepare(
      `SELECT b.id, b.amount FROM bank_transactions b
       WHERE b.status = 'gematcht' AND b.matched_invoice_id IS NULL AND b.matched_purchase_invoice_id IS NULL
         AND b.amount <= ? AND b.transaction_date BETWEEN ? AND ?
         AND EXISTS (SELECT 1 FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
                     WHERE l.journal_entry_id = b.matched_journal_entry_id AND a.category = 'kosten')
         AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.classification LIKE '%banktransactie #' || b.id || '"%')`,
    )
    .all(-EVIDENCE_THRESHOLD, start, end) as { id: number; amount: number }[];
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
    });
  }

  const dupDocs = db
    .prepare(`SELECT id FROM documents WHERE status = 'controle' AND issues LIKE '%"field":"duplicate"%' AND json_extract(result, '$.invoiceDate.value') BETWEEN ? AND ?`)
    .all(start, end) as { id: number }[];
  const dupPurchases = db
    .prepare(
      `SELECT a.id AS a, b.id AS b FROM purchase_invoices a JOIN purchase_invoices b
         ON a.id < b.id AND a.relation_id = b.relation_id AND a.total = b.total
        AND ABS(julianday(a.invoice_date) - julianday(b.invoice_date)) <= 3
        AND (a.supplier_reference IS NULL OR b.supplier_reference IS NULL OR a.supplier_reference = b.supplier_reference)
       WHERE b.invoice_date BETWEEN ? AND ?`,
    )
    .all(start, end) as { a: number; b: number }[];
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
    });
  }

  const reverseNoVat = db
    .prepare(
      `SELECT DISTINCT i.id, i.number FROM invoices i JOIN relations r ON r.id = i.relation_id
       WHERE i.status <> 'concept' AND i.invoice_date BETWEEN ? AND ? AND TRIM(COALESCE(r.vat_number, '')) = ''
         AND EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id AND l.vat_code IN ('verlegd', 'icp'))`,
    )
    .all(start, end) as { id: number; number: string | null }[];
  if (reverseNoVat.length > 0) {
    found.push({
      key: 'verlegd-btwnummer',
      blocking: true,
      title: `${reverseNoVat.length} ${reverseNoVat.length === 1 ? 'factuur' : 'facturen'} met btw verlegd zonder btw-nummer van de klant`,
      detail: `Btw verlegd betekent: jij rekent geen btw, je klant (een bedrijf) regelt die zelf. Daarom moet zijn btw-nummer op de factuur staan (${reverseNoVat.map((i) => i.number ?? '?').join(', ')}). Vul het in bij de klant.`,
      count: reverseNoVat.length,
      fingerprint: reverseNoVat.map((i) => i.id).join(','),
      screen: 'werk',
    });
  }

  const kas = ledger.balance(ACCOUNTS.kas);
  if (kas < 0) {
    found.push({ key: 'kas-negatief', blocking: true, title: `Je contante geld staat op ${formatEuro(kas)}`, detail: 'Je hebt meer contant uitgegeven dan er binnenkwam. Waarschijnlijk mist er contant ontvangen geld, of geld dat je van de bank opnam.', count: 1, fingerprint: String(kas), screen: 'aankopen' });
  }

  const vraag = ledger.balance(ACCOUNTS.vraagposten);
  if (vraag !== 0) {
    found.push({ key: 'vraagposten', blocking: true, title: `${formatEuro(Math.abs(vraag))} staat nog bij "weet ik nog niet"`, detail: 'Zoek uit waar deze betalingen bij horen: er kan btw in zitten die je terugkrijgt.', count: 1, fingerprint: String(vraag), screen: 'bank' });
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
