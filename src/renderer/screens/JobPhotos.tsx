import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Button, ErrorBox, Modal, useLoad } from '../ui';

type Foto = Awaited<ReturnType<typeof api.jobs.photos>>['fotos'][number];

/** Hoeveel voorbeelden hoogstens tegelijk worden opgehaald; een foto kan enkele megabytes zijn. */
const GELIJKTIJDIG = 3;
/** Hoe breed een voorbeeld wordt bewaard (in pixels); het volledige bestand wordt na het verkleinen losgelaten. */
const VOORBEELD_BREEDTE = 320;

/** Een eenvoudige wachtrij: hoogstens GELIJKTIJDIG taken tegelijk, in de volgorde van aanvragen. */
const wachtend: (() => void)[] = [];
let bezig = 0;
function inRij<T>(taak: () => Promise<T>): Promise<T> {
  return new Promise<T>((klaar, mislukt) => {
    const start = () => {
      bezig++;
      taak().then(klaar, mislukt).finally(() => {
        bezig--;
        wachtend.shift()?.();
      });
    };
    if (bezig < GELIJKTIJDIG) start();
    else wachtend.push(start);
  });
}

/** Verkleint een foto tot een voorbeeld, zodat honderden voorbeelden geen honderden grote afbeeldingen in het geheugen houden. */
function verklein(dataUrl: string): Promise<string> {
  return new Promise((klaar) => {
    const img = new Image();
    img.onload = () => {
      try {
        const schaal = Math.min(1, VOORBEELD_BREEDTE / Math.max(img.naturalWidth, 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * schaal));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * schaal));
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        klaar(canvas.toDataURL('image/jpeg', 0.8));
      } catch {
        klaar(dataUrl);
      }
    };
    img.onerror = () => klaar(dataUrl);
    img.src = dataUrl;
  });
}

const alt = (f: Foto) => f.notitie?.trim() || 'Foto van de telefoon';
const moment = (f: Foto) => new Date(f.tijd).toLocaleString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Het voorbeeld van één foto; wordt pas opgehaald als de tegel in beeld komt (en dan hoogstens enkele tegelijk). */
function Voorbeeld({ foto, onOpen, knopRef }: { foto: Foto; onOpen: () => void; knopRef: (el: HTMLButtonElement | null) => void }) {
  const knop = useRef<HTMLButtonElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [mislukt, setMislukt] = useState(false);
  const [zichtbaar, setZichtbaar] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (zichtbaar || !knop.current) return;
    const waarnemer = new IntersectionObserver((items) => {
      if (items.some((i) => i.isIntersecting)) {
        setZichtbaar(true);
        waarnemer.disconnect();
      }
    }, { rootMargin: '200px' });
    waarnemer.observe(knop.current);
    return () => waarnemer.disconnect();
  }, [zichtbaar]);
  useEffect(() => {
    if (!zichtbaar) return;
    let weg = false;
    void inRij(async () => {
      if (weg) return;
      try {
        const f = await api.jobs.photo(foto.id);
        const klein = await verklein(`data:${f.mimeType};base64,${f.base64}`);
        if (!weg) setSrc(klein);
      } catch {
        if (!weg) setMislukt(true);
      }
    });
    return () => {
      weg = true;
    };
  }, [zichtbaar, foto.id]);
  return (
    <button
      type="button"
      ref={(el) => {
        knop.current = el;
        knopRef(el);
      }}
      className="btn"
      aria-label={`Foto vergroten: ${alt(foto)}, ${moment(foto)}`}
      onClick={onOpen}
      style={{ display: 'block', padding: 6, textAlign: 'left', whiteSpace: 'normal', width: '100%' }}
    >
      <div style={{ aspectRatio: '4 / 3', background: 'var(--surface-2)', borderRadius: 6, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {src ? <img src={src} alt={alt(foto)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : <span className="muted small">{mislukt ? 'Niet te laden' : 'Laden…'}</span>}
      </div>
      <div className="small muted" style={{ marginTop: 4 }}>{moment(foto)}</div>
      {foto.notitie && <div className="small" style={{ overflowWrap: 'anywhere' }}>{foto.notitie}</div>}
    </button>
  );
}

/** De grote weergave van één foto in een dialoog (Escape en "Sluiten" sluiten hem; de focus staat op "Sluiten"). */
function GroteFoto({ foto, onClose }: { foto: Foto; onClose: () => void }) {
  const f = useLoad(() => api.jobs.photo(foto.id), [foto.id]);
  return (
    <Modal title="Foto van de telefoon" wide onClose={onClose}>
      <div role="status" aria-live="polite">
        {f.loading && !f.data && <p className="muted">Foto laden…</p>}
      </div>
      <ErrorBox error={f.error} />
      {f.data && <img src={`data:${f.data.mimeType};base64,${f.data.base64}`} alt={alt(foto)} style={{ display: 'block', maxWidth: '100%', maxHeight: '70vh', margin: '0 auto', borderRadius: 6 }} />}
      <p className="small muted" style={{ marginTop: 8 }}>{moment(foto)}{foto.notitie ? ` · ${foto.notitie}` : ''}</p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" autoFocus onClick={onClose}>Sluiten</button>
      </div>
    </Modal>
  );
}

/**
 * De foto's die de telefoon bij deze klus stuurde. Alleen kijken: foto's zijn onveranderlijk en hier is geen knop om er
 * een te wijzigen of weg te halen. Zonder foto's (of als het ophalen mislukt) verschijnt er niets.
 */
export function JobPhotosSection({ jobId }: { jobId: number }) {
  const eerste = useLoad(() => api.jobs.photos(jobId), [jobId]);
  const [extra, setExtra] = useState<Foto[]>([]);
  const [meerFout, setMeerFout] = useState<string | null>(null);
  const [meerBezig, setMeerBezig] = useState(false);
  const [open, setOpen] = useState<Foto | null>(null);
  const knoppen = useRef(new Map<number, HTMLButtonElement>());
  const laatsteOpen = useRef<number | null>(null);
  useEffect(() => setExtra([]), [jobId]);
  if (!eerste.data || eerste.data.totaal === 0) return null;
  const fotos = [...eerste.data.fotos, ...extra];
  const totaal = eerste.data.totaal;
  const sluit = () => {
    setOpen(null);
    const id = laatsteOpen.current;
    // de focus gaat terug naar de tegel waarmee de dialoog openging
    if (id !== null) setTimeout(() => knoppen.current.get(id)?.focus(), 0);
  };
  const meer = async () => {
    // geen tweede aanroep zolang de eerste loopt (een dubbelklik gaf dezelfde foto's twee keer)
    if (meerBezig) return;
    setMeerBezig(true);
    setMeerFout(null);
    try {
      const r = await api.jobs.photos(jobId, { offset: fotos.length });
      // alleen wat er nog niet staat: een foto die intussen binnenkwam kan de volgorde verschuiven
      setExtra((e) => {
        const bekend = new Set([...eerste.data!.fotos, ...e].map((f) => f.id));
        return [...e, ...r.fotos.filter((f) => !bekend.has(f.id))];
      });
    } catch (e) {
      setMeerFout((e as Error).message);
    } finally {
      setMeerBezig(false);
    }
  };
  return (
    <section aria-labelledby="job-fotos-kop">
      <h2 id="job-fotos-kop">Foto's van de telefoon</h2>
      <p className="small muted">{totaal === 1 ? '1 foto' : `${totaal} foto's`}. Klik op een foto om hem groter te zien.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
        {fotos.map((f) => (
          <Voorbeeld
            key={f.id}
            foto={f}
            knopRef={(el) => (el ? knoppen.current.set(f.id, el) : knoppen.current.delete(f.id))}
            onOpen={() => {
              laatsteOpen.current = f.id;
              setOpen(f);
            }}
          />
        ))}
      </div>
      {fotos.length < totaal && (
        <div style={{ marginTop: 10 }}>
          <Button disabled={meerBezig} onClick={() => void meer()}>Meer foto's tonen ({totaal - fotos.length} te gaan)</Button>
        </div>
      )}
      <ErrorBox error={meerFout} />
      {open && <GroteFoto foto={open} onClose={sluit} />}
    </section>
  );
}
