import { XMLParser } from 'fast-xml-parser';
import { parseEuro } from '../shared/money';
import { normalizeIban } from '../shared/validation';
import type { NormalizedTransaction, ParseResult, StatementBalance } from './types';

/**
 * CAMT.053 (ISO 20022 bank-to-customer statement), XML geparsed met fast-xml-parser.
 * Ondersteunt camt.053.001.02 t/m .08 (namespace wordt genegeerd).
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (name) => ['Stmt', 'Ntry', 'NtryDtls', 'TxDtls', 'Ustrd', 'Bal'].includes(name),
});

type X = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function text(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') return String((v as X)['#text'] ?? '');
  return String(v);
}

export function parseCamt053(xml: string): ParseResult {
  const doc = parser.parse(xml) as X;
  const root = doc.Document?.BkToCstmrStmt;
  if (!root) throw new Error('Dit bankbestand kunnen we niet lezen. Download het afschrift opnieuw bij je bank.');
  const transactions: NormalizedTransaction[] = [];
  const warnings: string[] = [];
  const balances: StatementBalance[] = [];
  for (const stmt of (root.Stmt ?? []) as X[]) {
    const ownIban = text(stmt.Acct?.Id?.IBAN) || null;
    // eindsaldo (CLBD): het saldo aan het eind van die dag
    for (const bal of (stmt.Bal ?? []) as X[]) {
      if (text(bal.Tp?.CdOrPrtry?.Cd) !== 'CLBD') continue;
      const date = text(bal.Dt?.Dt ?? bal.Dt?.DtTm).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const amount = Math.abs(parseEuro(text(bal.Amt)));
      const currency = typeof bal.Amt === 'object' && bal.Amt ? text((bal.Amt as X)['@Ccy']).toUpperCase() : '';
      balances.push({ ownIban: ownIban ? normalizeIban(ownIban) : null, date, amount: text(bal.CdtDbtInd) === 'DBIT' ? -amount : amount, ...(currency && currency !== 'EUR' ? { currency } : {}) });
    }
    for (const entry of (stmt.Ntry ?? []) as X[]) {
      const status = text(entry.Sts?.Cd ?? entry.Sts);
      if (status && status !== 'BOOK') continue; // alleen geboekte posten
      const isDebit = text(entry.CdtDbtInd) === 'DBIT';
      const date = text(entry.BookgDt?.Dt ?? entry.BookgDt?.DtTm ?? entry.ValDt?.Dt).slice(0, 10);
      const details: X[] = ((entry.NtryDtls ?? []) as X[]).flatMap((d) => (d.TxDtls ?? []) as X[]);
      const entryAmount = parseEuro(text(entry.Amt));
      // Batchboekingen (meerdere TxDtls) splitsen we op als elke deelpost een eigen bedrag heeft.
      const splits = details.length > 1 && details.every((d) => d.Amt || d.AmtDtls) ? details : [details[0] ?? {}];
      const entryRef = text(entry.AcctSvcrRef);
      // de id's van de deelposten van deze boeking: elke deelpost een eigen, anders komt alleen de eerste erin
      const used = new Set<string>();
      for (const [i, tx] of splits.entries()) {
        const amount = splits.length > 1 ? parseEuro(text(tx.Amt ?? tx.AmtDtls?.TxAmt?.Amt)) : entryAmount;
        const party = isDebit ? tx.RltdPties?.Cdtr : tx.RltdPties?.Dbtr;
        const partyAcct = isDebit ? tx.RltdPties?.CdtrAcct : tx.RltdPties?.DbtrAcct;
        const unstructured = ((tx.RmtInf?.Ustrd ?? []) as unknown[]).map(text).join(' ');
        const structured = text(tx.RmtInf?.Strd?.CdtrRefInf?.Ref);
        const e2e = text(tx.Refs?.EndToEndId);
        const counterIban = text(partyAcct?.Id?.IBAN);
        if (!date) {
          warnings.push('Post zonder boekdatum overgeslagen');
          continue;
        }
        const ownRef = text(tx.Refs?.AcctSvcrRef);
        // De eerste deelpost houdt de id die hij altijd had (die van de boeking), zodat een eerder ingelezen
        // afschrift niet dubbel wordt. Vanaf de tweede: de eigen id van de deelpost als die er is en nog
        // niet gebruikt is, anders die van de boeking met een volgnummer (REF#2, REF#3, …).
        let bankId: string | null = entryRef || ownRef || null;
        if (i > 0) {
          const first = entryRef || [...used][0] || '';
          bankId = ownRef && ownRef !== entryRef && !used.has(ownRef) ? ownRef : first ? `${first}#${i + 1}` : null;
        }
        if (bankId) used.add(bankId);
        transactions.push({
          date,
          amount: isDebit ? -Math.abs(amount) : Math.abs(amount),
          counterIban: counterIban ? normalizeIban(counterIban) : null,
          counterName: text(party?.Nm ?? party?.Pty?.Nm) || null,
          description: (unstructured || text(entry.AddtlNtryInf)).replace(/\s+/g, ' ').trim(),
          reference: structured || (e2e && e2e !== 'NOTPROVIDED' ? e2e : null),
          ownIban: ownIban ? normalizeIban(ownIban) : null,
          bankId,
        });
      }
    }
  }
  return { source: 'camt', transactions, warnings, balances };
}
