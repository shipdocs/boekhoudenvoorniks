import { XMLParser } from 'fast-xml-parser';
import { parseEuro } from '../shared/money';
import { normalizeIban } from '../shared/validation';
import type { NormalizedTransaction, ParseResult } from './types';

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
  if (!root) throw new Error('Geen geldig CAMT.053-bestand (BkToCstmrStmt ontbreekt)');
  const transactions: NormalizedTransaction[] = [];
  const warnings: string[] = [];
  for (const stmt of (root.Stmt ?? []) as X[]) {
    const ownIban = text(stmt.Acct?.Id?.IBAN) || null;
    for (const entry of (stmt.Ntry ?? []) as X[]) {
      const status = text(entry.Sts?.Cd ?? entry.Sts);
      if (status && status !== 'BOOK') continue; // alleen geboekte posten
      const isDebit = text(entry.CdtDbtInd) === 'DBIT';
      const date = text(entry.BookgDt?.Dt ?? entry.BookgDt?.DtTm ?? entry.ValDt?.Dt).slice(0, 10);
      const details: X[] = ((entry.NtryDtls ?? []) as X[]).flatMap((d) => (d.TxDtls ?? []) as X[]);
      const entryAmount = parseEuro(text(entry.Amt));
      // Batchboekingen (meerdere TxDtls) splitsen we op als elke deelpost een eigen bedrag heeft.
      const splits = details.length > 1 && details.every((d) => d.Amt || d.AmtDtls) ? details : [details[0] ?? {}];
      for (const tx of splits) {
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
        transactions.push({
          date,
          amount: isDebit ? -Math.abs(amount) : Math.abs(amount),
          counterIban: counterIban ? normalizeIban(counterIban) : null,
          counterName: text(party?.Nm ?? party?.Pty?.Nm) || null,
          description: (unstructured || text(entry.AddtlNtryInf)).replace(/\s+/g, ' ').trim(),
          reference: structured || (e2e && e2e !== 'NOTPROVIDED' ? e2e : null),
          ownIban: ownIban ? normalizeIban(ownIban) : null,
          bankId: text(entry.AcctSvcrRef) || text(tx.Refs?.AcctSvcrRef) || null,
        });
      }
    }
  }
  return { source: 'camt', transactions, warnings };
}
