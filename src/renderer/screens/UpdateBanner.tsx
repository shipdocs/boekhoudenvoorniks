import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, Modal, useAction } from '../ui';

type UpdateStatus = Awaited<ReturnType<typeof api.app.updateStatus>>;

/**
 * "Versie X staat klaar": de update is gedownload en wordt geïnstalleerd als je de app sluit.
 * Nooit vanzelf herstarten midden in je werk; "Nu herstarten" mag, als jij dat kiest.
 */
export function UpdateBanner() {
  const { run, busy } = useAction();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [showNotes, setShowNotes] = useState(false);
  useEffect(() => {
    void api.app.updateStatus().then(setStatus).catch(() => undefined);
    return window.bridge.onEvent((event, payload) => {
      if (event === 'update') setStatus(payload as UpdateStatus);
    });
  }, []);
  if (status?.state === 'downloaden') {
    return (
      <div className="notice row between" role="status" style={{ margin: '0 0 16px', alignItems: 'center' }}>
        <span className="row" style={{ gap: 10, flex: 1 }}>
          <span>⬇️ Versie {status.version ?? ''} wordt gedownload…</span>
          <progress max={100} value={status.percent ?? 0} style={{ flex: 1, maxWidth: 200 }} />
          <span className="muted small">{status.percent ?? 0}%</span>
        </span>
        <span className="muted small">Je kunt gewoon doorwerken</span>
      </div>
    );
  }
  if (status?.state !== 'klaar') return null;
  return (
    <>
      <div className="notice good row between" role="status" style={{ margin: '0 0 16px' }}>
        <span>✨ <strong>Versie {status.version} staat klaar.</strong> Die wordt geïnstalleerd als je de app sluit; je administratie blijft gewoon staan.</span>
        <span className="row" style={{ gap: 8 }}>
          {status.notes && <Button small onClick={() => setShowNotes(true)}>Wat is er nieuw?</Button>}
          <Button small kind="primary" disabled={busy} onClick={() => void run(async () => { await api.app.installUpdate(); return true; })}>Nu herstarten</Button>
        </span>
      </div>
      {showNotes && (
        <Modal title={`Nieuw in versie ${status.version}`} onClose={() => setShowNotes(false)} wide>
          <div style={{ whiteSpace: 'pre-wrap' }}>{status.notes}</div>
          <div className="row end" style={{ marginTop: 14 }}>
            <Button onClick={() => setShowNotes(false)}>Later</Button>
            <Button kind="primary" disabled={busy} onClick={() => void run(async () => { await api.app.installUpdate(); return true; })}>Nu herstarten</Button>
          </div>
        </Modal>
      )}
    </>
  );
}
