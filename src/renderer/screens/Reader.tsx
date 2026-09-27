import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, ErrorBox, useAction, useApp, useLoad } from '../ui';

type Choice = 'lokaal' | 'claude-code' | 'codex' | 'zelf';

const mb = (n: number) => (n >= 1_000_000_000 ? `${(n / 1_000_000_000).toLocaleString('nl-NL', { maximumFractionDigits: 1 })} GB` : `${Math.round(n / 1_000_000).toLocaleString('nl-NL')} MB`);

/**
 * Hoe mag de app bonnen lezen? Gevraagd bij de eerste foto van een bon, en te wijzigen in
 * Instellingen. Drie manieren, eerlijk uitgelegd: op deze computer (download, alles blijft hier),
 * met je eigen Claude Code of Codex (geen download, maar de foto gaat naar Anthropic/OpenAI), of zelf
 * invullen.
 */
export function ReaderChoice({ context, onDone }: { context: 'bon' | 'instellingen'; onDone?: () => void | Promise<void> }) {
  const { reloadSettings, toast } = useApp();
  const { run, busy } = useAction();
  const opts = useLoad(() => api.reader.options());
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const o = opts.data;
  const downloading = o?.local.state === 'downloaden';

  const readPending = async () => {
    setReading(true);
    setError(null);
    try {
      const r = await api.reader.rereadPending();
      if (r.total > 0) toast(r.read === r.total ? `${r.read === 1 ? 'Bon' : `${r.read} bonnen`} gelezen ✓` : `${r.read} van ${r.total} bonnen gelezen`);
      if (r.read < r.total) setError('Niet alle bonnen konden gelezen worden. Kijk bij de bon wat er misging, of vul hem zelf in.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
      await opts.reload();
      await onDone?.();
    }
  };

  // lokale herkenning: tijdens het downloaden de voortgang volgen; klaar = in gebruik nemen en lezen
  useEffect(() => {
    if (!downloading) return;
    let stop = false;
    const t = setInterval(async () => {
      if (stop) return;
      const st = await api.localOcr.status();
      if (st.state === 'geinstalleerd') {
        stop = true;
        await api.localOcr.use();
        await reloadSettings();
        toast('Bonnen lezen op deze computer is klaar ✓');
        await readPending();
      } else {
        await opts.reload();
      }
    }, 1000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [downloading]);

  if (!o) return <ErrorBox error={opts.error} />;

  const choose = async (c: Choice) => {
    const ok = await run(() => api.reader.choose(c));
    if (ok === undefined) return;
    await reloadSettings();
    await opts.reload();
    if (c === 'claude-code' || c === 'codex' || (c === 'lokaal' && o.local.state === 'geinstalleerd')) await readPending();
    else await onDone?.();
  };

  const current = o.current;
  const localBusy = downloading || o.local.state === 'starten';
  const options: { key: Choice; title: string; text: string; note?: string; disabled?: string | null }[] = [
    {
      key: 'lokaal',
      title: 'Op deze computer',
      text: `Eenmalig ± ${mb(o.local.downloadSize)} downloaden. Daarna werkt het zonder internet en blijven je bonnen op deze computer.`,
      note: o.local.requirements,
    },
    {
      key: 'claude-code',
      title: 'Met je eigen Claude Code (Anthropic)',
      text: 'Geen download: Claude Code op je computer leest de bon, met je eigen abonnement. Let op: de foto gaat daarvoor naar Anthropic. Claude krijgt alleen die ene foto en mag verder niets op je computer.',
      disabled: o.claudeCode ? null : 'Niet gevonden op deze computer. Net geïnstalleerd? Start de app dan opnieuw.',
    },
    {
      key: 'codex',
      title: 'Met je eigen Codex (OpenAI)',
      text: 'Geen download: Codex op je computer leest de bon, met je eigen abonnement. Let op: de foto gaat daarvoor naar OpenAI. Codex krijgt alleen die ene foto en mag verder niets op je computer. Leest alleen foto\'s, geen gescande PDF\'s.',
      disabled: o.codex ? null : 'Niet gevonden op deze computer. Net geïnstalleerd? Start de app dan opnieuw.',
    },
    {
      key: 'zelf',
      title: context === 'bon' ? 'Nee, ik vul bonnen zelf in' : 'Uit: ik vul bonnen zelf in',
      text: `PDF's met tekst en e-facturen leest de app altijd al zelf. Alleen foto's en scans vul je dan zelf in.${context === 'bon' ? ' Je kunt dit later nog aanzetten bij Instellingen → Automatisch & herkenning.' : ''}`,
    },
  ];
  const selected: Choice | null = current === 'ingebouwd' ? 'lokaal' : current === 'claude-code' || current === 'codex' ? current : o.asked ? 'zelf' : null;

  // bij een bon: al gekozen, maar deze bon is nog niet gelezen (bv. mislukt of net gekozen)
  if (context === 'bon' && o.asked && !localBusy) {
    if (selected === 'zelf') return null;
    return (
      <div className="notice">
        Deze bon is nog niet uitgelezen.{' '}
        <Button small disabled={busy || reading} onClick={() => void readPending()}>{reading ? 'Bezig met lezen…' : 'Nu lezen'}</Button>
        {error && <div className="small" style={{ marginTop: 6 }}>{error}</div>}
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: context === 'bon' ? 12 : 10 }}>
      <h3 style={{ marginTop: 0 }}>{context === 'bon' ? 'Zal de app je bonnen voortaan zelf lezen?' : 'Foto\'s van bonnen laten lezen'}</h3>
      <p className="small muted">
        De app leest dan winkel, datum, bedrag en btw van de foto. Jij kijkt het na en klikt op "Klopt": er wordt nooit iets geboekt zonder dat jij het ziet.
      </p>
      <div className="choice">
        {options.map((x) => (
          <button key={x.key} disabled={busy || reading || localBusy || Boolean(x.disabled)} className={selected === x.key ? 'selected' : ''} onClick={() => void choose(x.key)}>
            {x.title}
            <div className="hint">{x.disabled ?? x.text}</div>
            {!x.disabled && x.note && <div className="hint">{x.note}</div>}
          </button>
        ))}
      </div>
      {downloading && (
        <div style={{ marginTop: 10 }}>
          <p className="small">Bezig met downloaden… Je kunt gewoon doorwerken; bonnen die klaarliggen worden daarna vanzelf gelezen.</p>
          <LocalProgress />
        </div>
      )}
      {reading && <p className="small">Bezig met lezen… dit kan een halve minuut per bon duren.</p>}
      {error && <div className="notice warn small">{error}</div>}
      <p className="small muted" style={{ marginTop: 8 }}>
        Wat de app leest is een voorstel. Twijfel je over btw of belasting, laat het dan controleren door je boekhouder.
      </p>
    </div>
  );
}

function LocalProgress() {
  const st = useLoad(() => api.localOcr.status());
  useEffect(() => {
    const t = setInterval(() => void st.reload(), 1000);
    return () => clearInterval(t);
  }, []);
  const p = st.data?.progress;
  return (
    <>
      <progress max={p?.total || 1} value={p?.done ?? 0} style={{ width: '100%' }} />
      {p && <p className="small muted">{mb(p.done)} van {mb(p.total)}</p>}
    </>
  );
}
