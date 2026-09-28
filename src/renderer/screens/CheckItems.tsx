import { Button, Euro, useApp } from '../ui';
import type { CheckItem } from '../../btw/checks';
import { formatDateNl } from '../../shared/dates';

/** Om welke betalingen, aankopen of facturen een controle gaat, met een knop om elk te openen. */
export function CheckItems({ items, onOpen }: { items: CheckItem[]; onOpen?: () => void }) {
  const { go } = useApp();
  const open = (i: CheckItem) => {
    onOpen?.();
    if (i.kind === 'bank') go({ screen: 'categorie', id: i.id });
    else if (i.kind === 'document') go({ screen: 'document', id: i.id });
    else if (i.kind === 'factuur') go({ screen: 'factuur', id: i.id });
    else go({ screen: 'aankopen' });
  };
  return (
    <table className="list"><tbody>
      {items.map((i) => (
        <tr key={`${i.kind}-${i.id}`}>
          <td>{i.date ? formatDateNl(i.date) : ''}</td>
          <td>{i.label}</td>
          <td style={{ textAlign: 'right' }}>{i.amount !== null ? <Euro cents={i.amount} /> : null}</td>
          <td style={{ textAlign: 'right' }}><Button small kind="ghost" onClick={() => open(i)}>Openen</Button></td>
        </tr>
      ))}
    </tbody></table>
  );
}
