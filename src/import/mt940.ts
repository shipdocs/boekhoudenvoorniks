import { read } from 'mt940-js';
import { normalizeIban } from '../shared/validation';
import type { NormalizedTransaction, ParseResult } from './types';

/**
 * MT940 via de open-source library mt940-js. Nederlandse banken zetten tegenrekening,
 * naam en omschrijving gestructureerd in veld :86: (bv. /CNTP/IBAN/BIC/NAAM/…/REMI/…/EREF/…);
 * dat deel parsen we zelf.
 */
export function parseField86(raw: string): { counterIban: string | null; counterName: string | null; description: string; reference: string | null } {
  const text = raw.replace(/\r?\n/g, '');
  if (text.includes('/')) {
    const tags = ['CNTP', 'REMI', 'EREF', 'NAME', 'IBAN', 'BIC', 'ADDR', 'MARF', 'CSID', 'PREF', 'RTRN', 'ORDP', 'BENM', 'ULTC', 'ULTD', 'PURP', 'TRCD', 'IREF', 'OCMT'];
    const re = new RegExp(`/(${tags.join('|')})/`, 'g');
    const parts: Record<string, string> = {};
    const positions: { tag: string; start: number; end: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) positions.push({ tag: m[1]!, start: m.index, end: re.lastIndex });
    positions.forEach((p, i) => {
      const next = positions[i + 1];
      parts[p.tag] = text.slice(p.end, next ? next.start : undefined).replace(/\/$/, '');
    });
    if (positions.length > 0) {
      let counterIban: string | null = parts.IBAN ?? null;
      let counterName: string | null = parts.NAME ?? null;
      if (parts.CNTP) {
        const [iban, _bic, name] = parts.CNTP.split('/');
        counterIban = iban || counterIban;
        counterName = name || counterName;
      }
      let description = parts.REMI ?? '';
      // Rabobank: /REMI/USTD//tekst of /REMI/STRD/CUR/kenmerk
      description = description.replace(/^USTD\/\//, '').replace(/^STRD\/CUR\//, '');
      const reference = parts.EREF && parts.EREF !== 'NOTPROVIDED' ? parts.EREF : null;
      return {
        counterIban: counterIban ? normalizeIban(counterIban) : null,
        counterName: counterName?.trim() || null,
        description: description.trim() || (counterName ?? '').trim(),
        reference,
      };
    }
  }
  return { counterIban: null, counterName: null, description: text.trim(), reference: null };
}

export async function parseMt940(data: Buffer | ArrayBuffer): Promise<ParseResult> {
  const statements = await read(data instanceof ArrayBuffer ? data : Buffer.from(data));
  const transactions: NormalizedTransaction[] = [];
  for (const st of statements) {
    const ownIban = st.accountId ? normalizeIban(st.accountId.split(/\s/)[0] ?? '') : null;
    for (const t of st.transactions) {
      const info = parseField86(t.description ?? '');
      const cents = Math.round(t.amount * 100);
      transactions.push({
        date: toIso(t.valueDate || t.entryDate),
        amount: t.isCredit ? cents : -cents,
        counterIban: info.counterIban,
        counterName: info.counterName,
        description: info.description,
        reference: info.reference ?? (t.customerReference && t.customerReference !== 'NONREF' ? t.customerReference : null),
        ownIban: ownIban && /^[A-Z]{2}\d{2}/.test(ownIban) ? ownIban : null,
        bankId: t.bankReference || null,
      });
    }
  }
  return { source: 'mt940', transactions, warnings: [] };
}

function toIso(date: string): string {
  // mt940-js levert 'YYYY-MM-DD'
  return date.slice(0, 10);
}
