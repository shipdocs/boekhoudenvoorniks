import { api } from '../api';
import { Button, ErrorBox, Euro, useApp, useLoad } from '../ui';
import { formatDateNl } from '../../shared/dates';

/**
 * Alles wat de bank over een betaling gaf, plus eerdere betalingen aan of van dezelfde partij en hoe je
 * die verwerkte. Zo kun je een vraag van de app ("zakelijk of privé?", "waar is dit geld voor?") beantwoorden.
 */
export function PaymentDetails({ txId, proposal }: { txId: number; proposal?: { invoiceId?: number; purchaseId?: number } }) {
  const { data, error } = useLoad(() => api.bank.details(txId), [txId]);
  const { go } = useApp();
  // de bonnen die als bewijs bij deze betaling horen (#179): het hoofdbewijsstuk eerst
  const evidence = useLoad(() => api.documents.forTarget('bank', txId), [txId]);
  const linked = useLoad(async () => (proposal && (proposal.invoiceId || proposal.purchaseId) ? api.bank.proposal(proposal) : null), [proposal?.invoiceId, proposal?.purchaseId]);
  const t = data?.transaction;
  if (!t || !data) return <ErrorBox error={error} />;
  const p = linked.data;
  return (
    <div className="payment-details">
      <table className="list details"><tbody>
        <tr><th>Datum</th><td>{formatDateNl(t.transaction_date)}</td></tr>
        <tr><th>Bedrag</th><td><Euro cents={t.amount} /> {t.amount < 0 ? '(afgeschreven)' : '(bijgeschreven)'}</td></tr>
        <tr><th>{t.amount < 0 ? 'Aan' : 'Van'}</th><td>{t.counter_name ?? <span className="muted">onbekend</span>}</td></tr>
        <tr><th>Rekeningnummer</th><td>{t.counter_iban ?? <span className="muted">niet meegegeven door de bank</span>}</td></tr>
        <tr><th>Omschrijving</th><td style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{t.description || <span className="muted">geen</span>}</td></tr>
        {t.reference && <tr><th>Kenmerk</th><td>{t.reference}</td></tr>}
        <tr><th>Rekening</th><td>{data.account.name}{data.account.iban ? ` · ${data.account.iban}` : ''}</td></tr>
      </tbody></table>

      {p && (
        <>
          <h3>{p.kind === 'factuur' ? 'De factuur die de app voorstelt' : 'De aankoop die de app voorstelt'}</h3>
          <table className="list details"><tbody>
            <tr><th>{p.kind === 'factuur' ? 'Factuur' : 'Rekening'}</th><td>{p.number ?? '(zonder nummer)'} · {p.relation ?? 'onbekend'}</td></tr>
            <tr><th>Datum</th><td>{formatDateNl(p.date)}{p.dueDate ? <span className="muted"> · te betalen vóór {formatDateNl(p.dueDate)}</span> : null}</td></tr>
            <tr><th>Totaal</th><td><Euro cents={p.total} />{p.open !== p.total ? <span className="muted"> · nog open <Euro cents={p.open} /></span> : null}</td></tr>
            {Math.abs(t.amount) !== Math.abs(p.open) && (
              <tr><th>Verschil</th><td><strong><Euro cents={Math.abs(t.amount) - Math.abs(p.open)} /></strong> <span className="muted">tussen deze betaling en wat nog open staat</span></td></tr>
            )}
          </tbody></table>
          {p.attachmentPath && <Button small onClick={() => void api.app.openAttachment(p.attachmentPath!)}>Bon of factuur openen</Button>}
        </>
      )}

      {(evidence.data ?? []).length > 0 && (
        <>
          <h3>Bon of factuur bij deze betaling</h3>
          <table className="list"><tbody>
            {evidence.data!.map((f) => (
              <tr key={f.document_id}>
                <td>{f.original_name}{evidence.data!.length > 1 && f.is_primary ? <span className="muted"> · hoofdbewijsstuk</span> : null}</td>
                <td style={{ textAlign: 'right' }}><Button small onClick={() => go({ screen: 'document', id: f.document_id })}>Bon bekijken</Button></td>
              </tr>
            ))}
          </tbody></table>
        </>
      )}

      <h3>Eerder {t.amount < 0 ? 'aan' : 'van'} {t.counter_name ?? 'deze partij'}</h3>
      {data.history.length === 0 ? (
        <p className="muted small">Geen eerdere betalingen gevonden.</p>
      ) : (
        <table className="list"><tbody>
          {data.history.map((h) => (
            <tr key={h.id}>
              <td>{formatDateNl(h.date)}</td>
              <td style={{ textAlign: 'right' }}><Euro cents={h.amount} /></td>
              <td>{h.how}<div className="small muted">{h.description.length > 90 ? `${h.description.slice(0, 90)}…` : h.description}</div></td>
            </tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}
