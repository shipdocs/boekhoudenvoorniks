import { useState } from 'react';
import { api } from '../api';
import { Button, Modal, useAction, useApp, useLoad } from '../ui';

const CONFIRM_WORD = 'WISSEN';

/** Wissen en opnieuw laden: alle schermen beginnen dan schoon, met de onboarding. */
function useClear() {
  const { run, busy } = useAction();
  const clear = async () => {
    const r = await run(() => api.app.clearData());
    if (!r) return;
    if (r.backup) alert(`Er is eerst een kopie van je administratie gemaakt:\n${r.backup}`);
    window.location.reload();
  };
  return { clear, busy };
}

/** Balk bovenaan zolang de demo draait. */
export function DemoBanner() {
  const [asking, setAsking] = useState(false);
  const { clear, busy } = useClear();
  return (
    <>
      <div className="notice warn row between" role="status" style={{ margin: '0 0 16px' }}>
        <span>🧪 <strong>Je bekijkt de demo.</strong> Probeer gerust alles uit; er gaat niets naar buiten (geen e-mail).</span>
        <Button small kind="primary" onClick={() => setAsking(true)}>Wis demo en begin echt</Button>
      </div>
      {asking && (
        <Modal title="Demo wissen?" onClose={() => setAsking(false)}>
          <p>Alle voorbeeldgegevens worden verwijderd. Daarna stel je de app in voor je eigen bedrijf.</p>
          <div className="row end">
            <Button onClick={() => setAsking(false)}>Nog even kijken</Button>
            <Button kind="primary" disabled={busy} onClick={() => void clear()}>Wis demo en begin echt</Button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Instellingen → Back-up: demo bekijken of de administratie helemaal leegmaken. */
export function ResetCard() {
  const { settings } = useApp();
  const status = useLoad(() => api.app.dataStatus());
  const { run, busy: demoBusy } = useAction();
  const { clear, busy } = useClear();
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState('');
  const hasData = status.data?.hasData ?? true;

  const startDemo = async () => {
    const ok = await run(() => api.app.startDemo());
    if (ok) window.location.reload();
  };

  return (
    <div className="card grid" style={{ marginTop: 14 }}>
      <h3 style={{ margin: 0 }}>Demo en opnieuw beginnen</h3>
      {settings.demoMode ? (
        <p className="small muted">Je gebruikt nu de demo. Wis hem om met je eigen administratie te beginnen.</p>
      ) : (
        <p className="small muted">
          Met de demo bekijk je de app met een voorbeeldbedrijf. {hasData ? 'Dat kan alleen in een lege administratie; je huidige gegevens moet je daarvoor eerst wissen.' : 'Je administratie is nog leeg, dus dat kan meteen.'}
        </p>
      )}
      <div className="row">
        {!settings.demoMode && <Button disabled={demoBusy || hasData} onClick={() => void startDemo()}>🧪 Demo bekijken</Button>}
        <Button kind="danger" onClick={() => { setTyped(''); setAsking(true); }}>{settings.demoMode ? 'Wis demo en begin echt' : 'Alles wissen en opnieuw beginnen…'}</Button>
      </div>
      {asking && (
        <Modal title={settings.demoMode ? 'Demo wissen?' : 'Alles wissen?'} onClose={() => setAsking(false)}>
          {settings.demoMode || !hasData ? (
            <p>Alle gegevens worden verwijderd en je begint opnieuw met de onboarding.</p>
          ) : (
            <>
              <p>
                <strong>Al je facturen, klanten, bonnetjes, bankgegevens en instellingen worden verwijderd.</strong> Er wordt eerst automatisch een kopie gemaakt in de map met back-ups,
                zodat je hem via "Back-up terugzetten" terug kunt halen.
              </p>
              <p className="small muted">Let op: je bent wettelijk verplicht je administratie 7 jaar te bewaren. Maak voor de zekerheid ook zelf een back-up.</p>
              <label className="grid small">
                Typ {CONFIRM_WORD} om te bevestigen
                <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
              </label>
            </>
          )}
          <div className="row end" style={{ marginTop: 14 }}>
            <Button onClick={() => setAsking(false)}>Annuleren</Button>
            <Button kind="danger" disabled={busy || (!settings.demoMode && hasData && typed.trim().toUpperCase() !== CONFIRM_WORD)} onClick={() => void clear()}>
              Wissen
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
