import { api } from '../api';
import { Button, DateNl, ErrorBox, Euro, Modal, useAction, useApp, useLoad } from '../ui';

const SOURCE: Record<string, string> = {
  factuur: 'factuur',
  inkoop: 'aankoop / bonnetje',
  bank: 'bankbetaling',
  handmatig: 'handmatige boeking',
  integratie: 'webshop / betaalprovider',
  opening: 'beginsaldo',
};

/**
 * "Oplossen" bij een controle over een saldo (bv. "weet ik nog niet", geld onderweg, contant geld):
 * welke boekingen vormen samen dit bedrag, en met één klik naar de betaling om hem goed in te delen.
 */
export function CheckLines({ account, upTo, title, hint, onClose }: { account: string; upTo?: string; title: string; hint?: string; onClose: () => void }) {
  const { go } = useApp();
  const { run } = useAction();
  const d = useLoad(() => api.vat.accountLines(account, upTo), [account, upTo]);
  const lines = d.data?.lines ?? [];
  const open = (l: (typeof lines)[number]) => {
    // een bon openen kan met dit venster nog open; naar een ander scherm gaan sluit het
    if (!(l.purchaseId && l.attachmentPath && !l.bankTransactionId && !l.invoiceId)) onClose();
    if (l.bankTransactionId) go({ screen: 'categorie', id: l.bankTransactionId });
    else if (l.invoiceId) go({ screen: 'factuur', id: l.invoiceId });
    // aankoop: de bon zelf openen als die er is; anders de lijst met aankopen
    else if (l.purchaseId && l.attachmentPath) void run(() => api.app.openAttachment(l.attachmentPath!));
    else if (l.purchaseId) go({ screen: 'aankopen' });
  };
  return (
    <Modal title={title} onClose={onClose} wide>
      {hint && <p className="small muted">{hint}</p>}
      <ErrorBox error={d.error} />
      {d.data && lines.length === 0 && <p className="muted">Hier staat niets (meer) op. ✓</p>}
      {lines.length > 0 && (
        <table className="list small">
          <thead>
            <tr><th>Datum</th><th>Wat</th><th>Waar vandaan</th><th className="num">Bedrag</th><th><span className="sr-only">Acties</span></th></tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.entryId}>
                <td><DateNl date={l.date} /></td>
                <td>{l.description}{l.counterparty && <div className="muted">{l.counterparty}</div>}</td>
                <td>{SOURCE[l.source] ?? l.source}</td>
                <td className="num"><Euro cents={l.amount ?? 0} /></td>
                <td>
                  {l.bankTransactionId ? <Button small kind="primary" onClick={() => open(l)}>Opnieuw indelen</Button>
                    : (l.invoiceId || l.purchaseId) ? <Button small onClick={() => open(l)}>Bekijken</Button> : null}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td /><td><strong>Samen</strong></td><td /><td className="num"><strong><Euro cents={d.data!.total} /></strong></td><td /></tr>
          </tfoot>
        </table>
      )}
    </Modal>
  );
}
