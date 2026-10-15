import { useState } from 'react';
import { api } from '../api';
import { Button, ErrorBox, Field, Modal, useAction, useApp, useLoad } from '../ui';

/**
 * Meer dan één administratie op deze computer: bv. een bv en een eenmanszaak, of een boekhouder met
 * de kopieën van zijn klanten. Elke administratie heeft eigen gegevens, bijlagen en back-ups.
 */
export function AdministrationsSettings() {
  const { reloadSettings, reloadMeta } = useApp();
  const list = useLoad(() => api.administrations.list());
  const { run, busy } = useAction();
  const [name, setName] = useState('');
  // naam wijzigen (#444): welke rij, en de nieuwe naam
  const [renaming, setRenaming] = useState<{ key: string; name: string } | null>(null);
  // weghalen (#444): welke rij; bevestigen door de naam te typen
  const [removing, setRemoving] = useState<{ key: string; name: string } | null>(null);
  if (!list.data) return <ErrorBox error={list.error} />;
  const saveName = async () => {
    if (!renaming) return;
    const current = list.data!.find((a) => a.key === renaming.key)?.current;
    if ((await run(() => api.administrations.rename(renaming.key, renaming.name.trim()), 'Naam gewijzigd ✓')) === undefined) return;
    setRenaming(null);
    await list.reload();
    // de open administratie: de naam staat ook bovenaan het menu en bij Je bedrijf
    if (current) await Promise.all([reloadSettings(), reloadMeta()]);
  };
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
                {renaming?.key === a.key ? (
                  <form className="row" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); void saveName(); }}>
                    <input aria-label="Nieuwe naam" autoFocus value={renaming.name} onChange={(e) => setRenaming({ key: a.key, name: e.target.value })} />
                    <Button small kind="primary" type="submit" disabled={busy || !renaming.name.trim()}>Opslaan</Button>
                    <Button small kind="ghost" type="button" disabled={busy} onClick={() => setRenaming(null)}>Annuleren</Button>
                  </form>
                ) : (
                  <>
                    <strong>{a.name}</strong>
                    {a.officeCopy && <div className="muted">Kopie voor {a.officeCopy.office} · uitwisseling {a.officeCopy.exchange} · t/m {a.officeCopy.endDate}</div>}
                    {a.key === '' && list.data!.length > 1 && <div className="muted">De eerste administratie: staat in de gegevensmap zelf</div>}
                  </>
                )}
              </td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {a.current ? <span className="pill">Open</span> : <Button small disabled={busy} onClick={() => void run(() => api.administrations.open(a.key))}>Openen</Button>}
                {' '}
                <Button small kind="ghost" disabled={busy || renaming !== null} title="De bedrijfsnaam van deze administratie" onClick={() => setRenaming({ key: a.key, name: a.name })}>Naam wijzigen</Button>
                {' '}
                <Button small kind="ghost" disabled={busy} title="De map met de database, bijlagen en back-ups van deze administratie" onClick={() => void run(() => api.administrations.openFolder(a.key))}>Map openen</Button>
                {' '}
                {a.key !== '' && !a.current && <Button small kind="ghost" disabled={busy} onClick={() => setRemoving({ key: a.key, name: a.name })}>Weghalen…</Button>}
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
      {removing && <RemoveDialog target={removing} onClose={() => setRemoving(null)} onRemoved={async () => { setRemoving(null); await list.reload(); }} />}
    </div>
  );
}

/** Weghalen bevestigen (#444): de map gaat naar de prullenbak van de computer, dus hij is terug te halen. */
function RemoveDialog({ target, onClose, onRemoved }: { target: { key: string; name: string }; onClose: () => void; onRemoved: () => Promise<void> }) {
  const { run, busy } = useAction();
  const [typed, setTyped] = useState('');
  const matches = typed.trim().toLowerCase() === target.name.trim().toLowerCase();
  return (
    <Modal title={`${target.name} weghalen`} onClose={onClose}>
      <p>
        De hele map van deze administratie gaat naar de prullenbak van je computer: de boekhouding, de bijlagen en de back-ups.
        Daar kun je hem terughalen zolang je de prullenbak niet leegt. In de app is hij daarna weg.
      </p>
      <Field label="Typ de naam van de administratie om te bevestigen">
        <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={target.name} />
      </Field>
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        <Button kind="ghost" disabled={busy} onClick={onClose}>Annuleren</Button>
        <Button kind="danger" disabled={busy || !matches} onClick={async () => { if ((await run(() => api.administrations.remove(target.key), 'Naar de prullenbak verplaatst ✓')) !== undefined) await onRemoved(); }}>Naar de prullenbak</Button>
      </div>
    </Modal>
  );
}

/** Onder de naam van de app: welke administratie open is, als er meer dan één is. */
export function CurrentAdministration() {
  const list = useLoad(() => api.administrations.list());
  const current = list.data?.find((a) => a.current);
  if (!list.data || list.data.length < 2 || !current) return null;
  return <div className="small muted" style={{ padding: '0 10px 12px', marginTop: -10 }} title="Wisselen in Instellingen > Administraties">{current.name}</div>;
}

/** Balk bovenaan in de kopie van een klant bij de boekhouder: wat er gecorrigeerd is, en het antwoord. */
export { OfficeCopyAnswer as OfficeCopyBanner } from './Exchange';
