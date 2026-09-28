import { useRef } from 'react';
import { api } from '../api';
import { Button, Euro, readAsBytes, useAction, useApp } from '../ui';
import type { CheckItem } from '../../btw/checks';
import type { IntakeDocument } from '../../intake/intake';
import { diffDays, formatDateNl } from '../../shared/dates';
import { formatEuro } from '../../shared/money';

/**
 * Past de bon bij de betaling? Een andere maand of een ander bedrag betekent vaak de factuur van een
 * andere maand (bv. TransIP: jaar en maand staan in het factuurnummer). Geeft dan een waarschuwing.
 */
function mismatch(item: CheckItem, doc: IntakeDocument): string | null {
  const total = doc.result?.total?.value ?? null;
  const date = doc.result?.invoiceDate?.value ?? null;
  const amount = item.amount !== null ? Math.abs(item.amount) : null;
  const parts: string[] = [];
  if (date && item.date && Math.abs(diffDays(date, item.date)) > 45) parts.push(`is van ${formatDateNl(date)}`);
  // vreemde munt: dan wijkt het bedrag in euro's altijd wat af
  if (total !== null && amount !== null && !doc.result?.foreign && Math.abs(total - amount) > 1) parts.push(`is ${formatEuro(total)}`);
  if (!parts.length) return null;
  return `Let op: deze bon ${parts.join(' en ')}, de ${item.kind === 'bank' ? 'betaling' : 'aankoop'} is van ${item.date ? formatDateNl(item.date) : '?'}${amount !== null ? ` en ${formatEuro(amount)}` : ''}. Is dit de goede? Hij is wel gekoppeld; klopt hij niet, voeg dan de goede toe.`;
}

/**
 * Om welke betalingen, aankopen of facturen een controle gaat, met een knop om elk te openen. Bij
 * betalingen en aankopen zonder bon kun je de bon hier meteen toevoegen.
 */
export function CheckItems({ items, onOpen, onChanged }: { items: CheckItem[]; onOpen?: () => void; onChanged?: () => void | Promise<void> }) {
  const { go, toast } = useApp();
  const { run, busy } = useAction();
  const input = useRef<HTMLInputElement>(null);
  const target = useRef<CheckItem | null>(null);
  const open = (i: CheckItem) => {
    onOpen?.();
    if (i.kind === 'bank') go({ screen: 'categorie', id: i.id });
    else if (i.kind === 'document') go({ screen: 'document', id: i.id });
    else if (i.kind === 'factuur') go({ screen: 'factuur', id: i.id });
    else go({ screen: 'aankopen' });
  };
  const addEvidence = async (file: File) => {
    const item = target.current;
    if (!item) return;
    const bytes = await readAsBytes(file);
    const doc = await run(() => (item.kind === 'bank' ? api.documents.addEvidence(file.name, bytes, item.id) : api.documents.addPurchaseEvidence(file.name, bytes, item.id)));
    if (!doc) return;
    const warning = mismatch(item, doc);
    toast(warning ?? 'Bon gekoppeld ✓', warning ? 'error' : undefined);
    await onChanged?.();
  };
  return (
    <>
      <input ref={input} type="file" accept=".pdf,.xml,.jpg,.jpeg,.png,.webp,.heic" hidden onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) void addEvidence(f);
      }} />
      <table className="list"><tbody>
        {items.map((i) => (
          <tr key={`${i.kind}-${i.id}`}>
            <td>{i.date ? formatDateNl(i.date) : ''}</td>
            <td>
              {i.label}
              {i.hint && <div className="small muted">{i.hint}</div>}
            </td>
            <td style={{ textAlign: 'right' }}>{i.amount !== null ? <Euro cents={i.amount} /> : null}</td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              {(i.kind === 'bank' || i.kind === 'aankoop') && onChanged && (
                <Button small disabled={busy} onClick={() => { target.current = i; input.current?.click(); }}>Bon toevoegen</Button>
              )}
              <Button small kind="ghost" onClick={() => open(i)}>Openen</Button>
            </td>
          </tr>
        ))}
      </tbody></table>
    </>
  );
}
