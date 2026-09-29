import { useState } from 'react';
import { api } from '../api';
import { Button, ErrorBox, Field, useAction, useLoad } from '../ui';

/**
 * Meer dan één administratie op deze computer: bv. een bv en een eenmanszaak, of een boekhouder met
 * de kopieën van zijn klanten. Elke administratie heeft eigen gegevens, bijlagen en back-ups.
 */
export function AdministrationsSettings() {
  const list = useLoad(() => api.administrations.list());
  const { run, busy } = useAction();
  const [name, setName] = useState('');
  if (!list.data) return <ErrorBox error={list.error} />;
  return (
    <div className="card grid">
      <h3 style={{ margin: 0 }}>Administraties op deze computer</h3>
      <p className="small muted" style={{ margin: 0 }}>
        Heb je meer dan één bedrijf? Maak voor elk een eigen administratie. Ze staan helemaal los van elkaar: eigen klanten, facturen, bank, btw, bijlagen en back-ups.
        Alleen de administratie die open is, haalt mail op, verstuurt herinneringen en maakt de dagelijkse back-up.
      </p>
      <table className="sumtable small" style={{ maxWidth: 'none' }}>
        <tbody>
          {list.data.map((a) => (
            <tr key={a.key || 'hoofd'}>
              <td>
                <strong>{a.name}</strong>
                {a.officeCopy && <div className="muted">Kopie voor {a.officeCopy.office} · uitwisseling {a.officeCopy.exchange} · t/m {a.officeCopy.endDate}</div>}
              </td>
              <td style={{ textAlign: 'right' }}>
                {a.current ? <span className="pill">Open</span> : <Button small disabled={busy} onClick={() => void run(() => api.administrations.open(a.key))}>Openen</Button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ alignItems: 'flex-end', gap: 10 }}>
        <Field label="Nieuwe administratie" hint="de naam van het bedrijf">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="bv. Bakker Bouw B.V." />
        </Field>
        <Button kind="primary" disabled={busy || !name.trim()} onClick={() => void run(() => api.administrations.create(name.trim()))}>Aanmaken en openen</Button>
      </div>
    </div>
  );
}

/** Onder de naam van de app: welke administratie open is, als er meer dan één is. */
export function CurrentAdministration() {
  const list = useLoad(() => api.administrations.list());
  const current = list.data?.find((a) => a.current);
  if (!list.data || list.data.length < 2 || !current) return null;
  return <div className="small muted" style={{ padding: '0 10px 12px', marginTop: -10 }} title="Wisselen in Instellingen > Administraties">{current.name}</div>;
}

/** Balk bovenaan in de kopie van een klant bij de boekhouder. */
export function OfficeCopyBanner() {
  const copy = useLoad(() => api.app.officeCopy());
  if (!copy.data) return null;
  return (
    <div className="notice warn" role="status" style={{ margin: '0 0 16px' }}>
      🗂️ <strong>Kopie voor {copy.data.office}</strong> (uitwisseling {copy.data.exchange}, t/m {copy.data.endDate}). Er gaat niets naar buiten: geen e-mail, geen post ophalen, geen koppelingen, en de app boekt niets zelf.
    </div>
  );
}
