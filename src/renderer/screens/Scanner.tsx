import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Button, Modal, useAction, useApp, useLoad } from '../ui';

type Status = NonNullable<Awaited<ReturnType<typeof api.scanner.status>>>;
type Pairing = Awaited<ReturnType<typeof api.scanner.pair>>;

/** "vandaag 14:02", "gisteren 09:15" of "28-9-2026 16:40" */
function when(iso: string | null): string {
  if (!iso) return 'nog niet';
  const d = new Date(iso);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  const time = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  return days === 0 ? `vandaag ${time}` : days === 1 ? `gisteren ${time}` : `${d.toLocaleDateString('nl-NL')} ${time}`;
}

/**
 * Instellingen → Telefoon & bonnenmap (#48): een telefoon koppelen met een QR-code, en een map
 * waaruit bonnen vanzelf de inbox in gaan. Beide staan standaard uit.
 */
export function ScannerSettings() {
  const status = useLoad(() => api.scanner.status());
  // gekoppeld, laatst gezien en de bonnenmap veranderen buiten dit scherm om: rustig bijhouden
  useEffect(() => {
    const t = setInterval(() => void status.reload(), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const st = status.data;
  if (status.error) return <div className="notice bad">{status.error}</div>;
  if (st === undefined) return null;
  if (st === null) return <div className="card">Een telefoon koppelen en de bonnenmap werken alleen in de app zelf.</div>;
  return (
    <>
      {st.blocked && <div className="notice warn">{st.blocked}</div>}
      <PhoneCard st={st} reload={status.reload} />
      <FolderCard st={st} reload={status.reload} />
    </>
  );
}

function PhoneCard({ st, reload }: { st: Status; reload: () => Promise<void> }) {
  const { run, busy } = useAction();
  const [firewall, setFirewall] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const paired = st.devices.filter((d) => !d.pending);

  const startPairing = async () => {
    const p = await run(() => api.scanner.pair());
    if (p) setPairing(p);
    await reload();
  };

  return (
    <div className="card grid">
      <h3 style={{ margin: 0 }}>Telefoon koppelen</h3>
      <p className="small muted" style={{ margin: 0 }}>
        Met de scanner-app op je Android-telefoon maak je onderweg een foto van een bon. Ben je thuis op de wifi, dan staat hij vanzelf bij Aankopen &amp; bonnetjes.
        De foto gaat versleuteld van je telefoon rechtstreeks naar deze computer: niet via internet en niet via een cloud.
      </p>
      <p className="small muted" style={{ margin: 0 }}>De scanner-app voor Android is nog in de maak. Tot die er is, kun je de bonnenmap hieronder gebruiken.</p>

      {paired.length > 0 && (
        <table className="list small">
          <thead>
            <tr><th>Telefoon</th><th>Gekoppeld</th><th>Laatst gezien</th><th></th></tr>
          </thead>
          <tbody>
            {paired.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.name}
                  {!d.usable && <div className="small muted">De sleutel van deze telefoon is niet meer te openen (bijvoorbeeld na een teruggezette back-up). Ontkoppel hem en koppel opnieuw.</div>}
                </td>
                <td>{when(d.pairedAt)}</td>
                <td>{when(d.lastSeenAt)}</td>
                <td className="right">
                  <Button small kind="danger" disabled={busy} onClick={async () => {
                    if (!confirm(`${d.name} ontkoppelen? De telefoon kan daarna geen bonnen meer sturen. Bonnen die al binnen zijn, blijven staan.`)) return;
                    await run(() => api.scanner.unpair(d.id), 'Ontkoppeld');
                    await reload();
                  }}>Ontkoppelen</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="small" style={{ margin: 0 }} role="status">
        {st.running
          ? `Ontvangen staat aan, alleen op je eigen netwerk (${st.addresses.join(', ')}, poort ${st.port}).`
          : paired.length > 0 && !st.blocked
            ? 'Ontvangen staat nu uit: deze computer zit niet op een thuis- of kantoornetwerk.'
            : 'Ontvangen staat uit: er is geen telefoon gekoppeld.'}
      </p>
      {st.failed.length > 0 && (
        <div className="notice warn small">
          {st.failed.length === 1 ? 'Eén bon van je telefoon kon' : `${st.failed.length} bonnen van je telefoon konden`} niet in de inbox gezet worden. Ze zijn bewaard in {st.failed[0]!.path.replace(/[\\/][^\\/]+$/, '')}; de app probeert het opnieuw als je hem de volgende keer start.
        </div>
      )}
      <div className="row">
        <Button kind="primary" disabled={busy || Boolean(st.blocked)} onClick={() => (st.firewallHint ? setFirewall(true) : void startPairing())}>Telefoon koppelen</Button>
      </div>

      {firewall && (
        <Modal title="Eerst even dit" onClose={() => setFirewall(false)}>
          <p>Om bonnen van je telefoon te ontvangen, moet deze computer bereikbaar zijn op je eigen netwerk. Windows vraagt daar zo toestemming voor.</p>
          <p><strong>Klik op "Toestaan" bij de melding van Windows.</strong> Laat het vinkje bij <em>Particuliere netwerken</em> (je thuisnetwerk) staan; <em>Openbare netwerken</em> hoeft niet.</p>
          <p className="small muted">Zie je geen melding, of klikte je op Annuleren? Dan kan je telefoon de computer niet vinden. Je past het later aan in Windows bij "Een app toelaten via Windows Firewall".</p>
          <div className="row end">
            <Button onClick={() => setFirewall(false)}>Annuleren</Button>
            <Button kind="primary" disabled={busy} onClick={async () => {
              await run(() => api.scanner.firewallSeen());
              setFirewall(false);
              await startPairing();
            }}>Verder</Button>
          </div>
        </Modal>
      )}
      {pairing && <PairingDialog pairing={pairing} onClose={async () => { setPairing(null); await reload(); }} onAgain={startPairing} />}
    </div>
  );
}

/** De QR-code, tot de telefoon zich meldt. Sluiten zonder scannen trekt de sleutel meteen weer in. */
function PairingDialog({ pairing, onClose, onAgain }: { pairing: Pairing; onClose: () => Promise<void>; onAgain: () => Promise<void> }) {
  const { toast } = useApp();
  const [expired, setExpired] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    done.current = false;
    setExpired(false);
    const t = setInterval(async () => {
      if (done.current) return;
      const st = await api.scanner.status().catch(() => null);
      if (!st || done.current) return;
      const device = st.devices.find((d) => d.id === pairing.deviceId);
      if (device && !device.pending) {
        done.current = true;
        toast(`${device.name} is gekoppeld ✓`);
        await onClose();
      } else if (!device) setExpired(true);
    }, 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairing.deviceId]);

  const close = async () => {
    if (!done.current) {
      done.current = true;
      await api.scanner.cancelPairing(pairing.deviceId).catch(() => undefined);
    }
    await onClose();
  };

  return (
    <Modal title="Telefoon koppelen" onClose={() => void close()}>
      {expired ? (
        <>
          <p>Deze code is verlopen. Maak een nieuwe en scan die binnen tien minuten.</p>
          <div className="row end">
            <Button onClick={() => void close()}>Sluiten</Button>
            <Button kind="primary" onClick={() => void onAgain()}>Nieuwe code</Button>
          </div>
        </>
      ) : (
        <div className="grid">
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            <li>Zorg dat je telefoon op dezelfde wifi zit als deze computer (niet het gastnetwerk).</li>
            <li>Open de scanner-app en kies <strong>Koppelen met pc</strong>.</li>
            <li>Scan deze code.</li>
          </ol>
          <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.svg)}`} alt="QR-code om je telefoon te koppelen" width={280} height={280} style={{ justifySelf: 'center', background: '#fff', borderRadius: 8 }} />
          <p className="small muted" style={{ margin: 0 }}>
            De code is voor één telefoon en werkt tien minuten. Laat hem aan niemand anders zien: wie de code heeft, kan bonnen naar je administratie sturen. Dit venster sluit vanzelf als je telefoon gekoppeld is.
          </p>
          <details>
            <summary className="small">Lukt het niet?</summary>
            <ul className="small">
              <li>Deze computer is op je netwerk te vinden op {pairing.addresses.join(' of ')} (poort {pairing.port}). Zit je telefoon op hetzelfde netwerk?</li>
              <li>Op een gastnetwerk kunnen apparaten elkaar meestal niet zien. Gebruik je gewone wifi.</li>
              <li>Windows: klikte je bij de melding van de firewall op Annuleren? Sta BoekhoudenVoorNiks dan toe bij "Een app toelaten via Windows Firewall" (particuliere netwerken).</li>
            </ul>
          </details>
          <div className="row end"><Button onClick={() => void close()}>Annuleren</Button></div>
        </div>
      )}
    </Modal>
  );
}

function FolderCard({ st, reload }: { st: Status; reload: () => Promise<void> }) {
  const { run, busy } = useAction();
  const f = st.folder;
  return (
    <div className="card grid" style={{ marginTop: 14 }}>
      <h3 style={{ margin: 0 }}>Bonnenmap</h3>
      <p className="small muted" style={{ margin: 0 }}>
        Kies een map op deze computer, bijvoorbeeld een map die Syncthing of Google Drive gelijk houdt met je telefoon. Nieuwe bestanden in die map (jpg, png, pdf en e-facturen in xml) komen vanzelf bij Aankopen &amp; bonnetjes en wachten daar op je controle.
        Daarna verplaatst de app ze naar de submap <strong>verwerkt</strong>. Er wordt nooit iets verwijderd, en er wordt niets vanzelf geboekt.
      </p>
      {f.folder ? (
        <>
          <p style={{ margin: 0 }}>Bonnenmap: <strong>{f.folder}</strong></p>
          {!f.reachable && !st.blocked && <div className="notice warn small">Deze map is nu niet bereikbaar (bijvoorbeeld een schijf die niet is aangesloten). Zodra hij er weer is, gaat de app vanzelf verder.</div>}
          {f.processed > 0 && (
            <p className="small muted" style={{ margin: 0 }}>
              {f.processed} {f.processed === 1 ? 'bestand' : 'bestanden'} opgehaald sinds de app open is. Laatste: {f.recent[0]?.name}{f.recent[0]?.duplicate ? ' (hadden we al)' : ''}.
            </p>
          )}
          {f.problems.length > 0 && (
            <div className="notice warn small">
              Blijven staan in de map:
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {f.problems.map((p) => <li key={p.name}>{p.name}: {p.reason}</li>)}
              </ul>
            </div>
          )}
        </>
      ) : (
        <p className="small" style={{ margin: 0 }}>Er is geen bonnenmap gekozen.</p>
      )}
      <div className="row">
        <Button kind={f.folder ? undefined : 'primary'} disabled={busy || Boolean(st.blocked)} onClick={async () => {
          const r = await run(() => api.scanner.chooseFolder());
          if (r) await reload();
        }}>{f.folder ? 'Andere map kiezen…' : 'Map kiezen…'}</Button>
        {f.folder && (
          <Button disabled={busy} onClick={async () => {
            await run(() => api.scanner.clearFolder(), 'De app kijkt niet meer in deze map');
            await reload();
          }}>Stoppen met deze map</Button>
        )}
      </div>
    </div>
  );
}
