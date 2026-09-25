import { useState } from 'react';
import { api } from '../api';
import { Button } from '../ui';
import { PRIVACY_URL, TERMS_SUMMARY, TERMS_URL, TERMS_VERSION } from '../../shared/legal';

/** Samenvatting van de voorwaarden met links naar de volledige teksten en een akkoord-vinkje. */
export function TermsBlock({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="card flat grid" style={{ gap: 8 }}>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {TERMS_SUMMARY.map((t) => <li key={t} className="small">{t}</li>)}
      </ul>
      <div className="small">
        Lees de volledige{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); void api.app.openExternal(TERMS_URL); }}>gebruiksvoorwaarden</a> en de{' '}
        <a href="#" onClick={(e) => { e.preventDefault(); void api.app.openExternal(PRIVACY_URL); }}>privacyverklaring</a>.
      </div>
      <label className="row small"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> Ik ga akkoord met de gebruiksvoorwaarden</label>
    </div>
  );
}

/** Voor bestaande gebruikers of na een wijziging van de voorwaarden: eenmalig akkoord vragen. */
export function TermsGate({ onAccepted }: { onAccepted: () => void }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-label="Gebruiksvoorwaarden">
        <h2 style={{ marginTop: 0 }}>Even iets belangrijks</h2>
        <p className="muted">Voordat je verdergaat: dit zijn de afspraken over het gebruik van Gratis Boekhouden.</p>
        <TermsBlock checked={checked} onChange={setChecked} />
        <div className="row end" style={{ marginTop: 16 }}>
          <Button kind="primary" disabled={!checked || busy} onClick={async () => {
            setBusy(true);
            try {
              await api.settings.update({ termsAcceptedVersion: TERMS_VERSION });
              onAccepted();
            } catch (e) {
              alert(`Opslaan lukte niet: ${e instanceof Error ? e.message : String(e)}`);
            } finally {
              setBusy(false);
            }
          }}>Akkoord</Button>
        </div>
      </div>
    </div>
  );
}
