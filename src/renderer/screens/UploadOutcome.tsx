import { api } from '../api';
import { Button, DateNl, Euro, Modal, useAction, useApp } from '../ui';
import type { UploadResult } from '../../intake/intake';
import type { TargetInfo } from '../../documents/evidence-links';
import { ALREADY_PRESENT, DOCUMENT_OUTCOME_LABEL, VIEW_EXISTING } from '../../shared/document-outcome';

/** Wat er met een net toegevoegd bestand gebeurd is, in één regel. */
export function uploadOutcomeText(r: UploadResult): string {
  if (r.already_present) return ALREADY_PRESENT;
  if (r.blocked) return 'Deze bon hoort al ergens anders bij. Er is niets gekoppeld.';
  return DOCUMENT_OUTCOME_LABEL[r.outcome];
}

/** Leverancier, datum, bedrag en kenmerk van een aankoop of betaling (ook als er geen ander document bij is). */
export function TargetDetails({ target }: { target: TargetInfo }) {
  return (
    <table className="list details"><tbody>
      <tr><th>{target.kind === 'aankoop' ? 'Aankoop bij' : 'Betaald aan'}</th><td>{target.supplier ?? 'onbekend'}</td></tr>
      <tr><th>Datum</th><td><DateNl date={target.date} /></td></tr>
      <tr><th>Bedrag</th><td><Euro cents={target.amount} /></td></tr>
      <tr><th>{target.kind === 'aankoop' ? 'Factuur- of bonnummer' : 'Omschrijving'}</th><td style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{target.reference ?? '—'}</td></tr>
    </tbody></table>
  );
}

/**
 * Na "Bon toevoegen": het bestand stond er al in, of dezelfde bon hoort al bij iets anders (#179). Er
 * is dan niets toegevoegd, gekoppeld of geboekt; je ziet waar het document nu staat en kunt het openen.
 */
export function UploadBlocked({ result, target, onClose, onChanged }: { result: UploadResult; target?: { kind: 'aankoop' | 'bank'; id: number }; onClose: () => void; onChanged?: () => void | Promise<void> }) {
  const { go } = useApp();
  const { run, busy } = useAction();
  const b = result.blocked;
  return (
    <Modal title={result.already_present ? 'Dit document stond er al in' : 'Deze bon hoort al ergens anders bij'} onClose={onClose}>
      <div className="grid">
        <p>
          <strong>{result.already_present ? ALREADY_PRESENT : 'Dezelfde bon of factuur staat al in de app.'}</strong>{' '}
          {result.already_present ? 'Er is niets toegevoegd, gekoppeld of geboekt.' : 'Het bestand is bewaard bij "Nog controleren". Er is niets gekoppeld of geboekt.'}
        </p>
        <p className="small muted">{result.original_name} · {DOCUMENT_OUTCOME_LABEL[result.outcome]}</p>
        {b && (
          <div className="grid cols-2">
            <div>
              <h3 style={{ marginTop: 0 }}>Hoort nu bij</h3>
              <TargetDetails target={b.existing} />
            </div>
            <div>
              <h3 style={{ marginTop: 0 }}>Je wilde koppelen aan</h3>
              <TargetDetails target={b.requested} />
            </div>
          </div>
        )}
        {b && (
          <p className="small">
            Hoort hij toch hier? Open het bestaande document en kies daar <em>Koppeling ongedaan maken</em>. De bon komt dan bij "Nog controleren" en je kunt hem opnieuw toevoegen. Aan je boekhouding verandert daarbij niets.
          </p>
        )}
        {result.linkable && target && (
          <p className="small">Dit document hoort nog nergens bij. Je kunt het hier als bewijs koppelen; er wordt dan niets geboekt.</p>
        )}
      </div>
      <div className="row end" style={{ marginTop: 16 }}>
        <Button onClick={onClose}>Sluiten</Button>
        {result.linkable && target && (
          <Button disabled={busy} onClick={async () => {
            const r = await run(() => api.documents.linkExisting(result.id, target.kind, target.id), 'Bewijs gekoppeld — niet opnieuw geboekt ✓');
            if (r) {
              await onChanged?.();
              onClose();
            }
          }}>Koppel het bestaande document hier als bewijs</Button>
        )}
        <Button kind="primary" onClick={() => { onClose(); go({ screen: 'document', id: result.id }); }}>{VIEW_EXISTING}</Button>
      </div>
    </Modal>
  );
}
