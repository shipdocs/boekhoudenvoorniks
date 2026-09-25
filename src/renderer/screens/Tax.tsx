import { useState } from 'react';
import { api } from '../api';
import { Button, ErrorBox, Euro, useAction, useApp, useLoad } from '../ui';
import { formatDateNl } from '../../shared/dates';
import { vatDeadline } from '../../inbox/inbox';

export function Tax({ periodKey }: { periodKey?: string }) {
  const { settings, meta, toast, go } = useApp();
  const { run, busy } = useAction();
  const [year, setYear] = useState(periodKey ? Number(periodKey.slice(0, 4)) : new Date().getFullYear());
  const periods = useLoad(() => api.vat.periods(year), [year]);
  const current = useLoad(() => api.vat.current());
  const [key, setKey] = useState<string | undefined>(periodKey);
  const selected = key ?? current.data?.key;
  const report = useLoad(async () => (selected ? api.vat.calculate(selected) : null), [selected]);
  const [details, setDetails] = useState(false);

  if (settings.kor) {
    return (
      <div className="page-narrow">
        <h1>Belasting</h1>
        <div className="card">
          <h3>Je gebruikt de kleineondernemersregeling (KOR)</h3>
          <p className="muted">Je rekent geen BTW en hoeft geen BTW-aangifte te doen. Houd je omzet in de gaten: boven € 20.000 per jaar vervalt de KOR.</p>
          <Button onClick={() => go({ screen: 'instellingen', extra: { tab: 'btw' } })}>BTW-instellingen</Button>
        </div>
      </div>
    );
  }

  const r = report.data;
  const copy = (value: number | null) => {
    if (value === null) return;
    void navigator.clipboard.writeText(String(value));
    toast(`${value} gekopieerd`);
  };
  const deadline = r ? vatDeadline(r.period.end, settings.vatPeriod) : null;

  return (
    <div className="page">
      <h1>Belasting</h1>
      <p className="sub">Wij rekenen je BTW uit. Jij hoeft alleen de bedragen over te nemen.</p>

      <div className="row" style={{ marginBottom: 16 }}>
        <select value={year} onChange={(e) => { setYear(Number(e.target.value)); setKey(undefined); }} aria-label="Jaar">
          {[0, 1, 2, 3].map((i) => new Date().getFullYear() - i).map((y) => <option key={y}>{y}</option>)}
        </select>
        <div className="chips">
          {(periods.data ?? []).map((p) => (
            <button key={p.period.key} className={selected === p.period.key ? 'selected' : ''} onClick={() => setKey(p.period.key)}>
              {settings.vatPeriod === 'kwartaal' ? p.period.key.slice(5) : p.period.label} {p.status === 'ingediend' ? '✓' : ''}
            </button>
          ))}
        </div>
      </div>
      <ErrorBox error={report.error} />

      {r && (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>BTW {r.period.label}</h2>
            <table className="sumtable">
              <tbody>
                <tr><td>Omzet</td><td><Euro cents={r.summary.omzet} /></td></tr>
                <tr><td>BTW die je hebt ontvangen</td><td><Euro cents={r.summary.btwOverOmzet} /></td></tr>
                <tr><td>BTW die je terugkrijgt (aankopen)</td><td><Euro cents={-r.summary.voorbelasting} /></td></tr>
                <tr className="total"><td>{r.summary.teBetalen >= 0 ? 'Te betalen' : 'Je krijgt terug'}</td><td><Euro cents={Math.abs(r.summary.teBetalen)} /></td></tr>
              </tbody>
            </table>
            {r.status === 'ingediend' ? (
              <div className="notice good">✓ Je hebt deze aangifte gedaan{r.submittedAt ? ` (${formatDateNl(r.submittedAt.slice(0, 10))})` : ''}.</div>
            ) : (
              deadline && r.summary.teBetalen > 0 && <p style={{ marginTop: 14 }}>Zorg dat uiterlijk <strong>{formatDateNl(deadline)}</strong> ongeveer <strong><Euro cents={r.summary.teBetalen} /></strong> beschikbaar is.</p>
            )}
            {r.warnings.map((w) => <div key={w} className="notice warn">{w}</div>)}
            <div className="row" style={{ marginTop: 14 }}>
              <Button onClick={() => setDetails((d) => !d)}>{details ? 'Verberg berekening' : 'Bekijk berekening'}</Button>
            </div>
          </div>

          {details && (
            <div className="card" style={{ marginTop: 14 }}>
              <h2 style={{ marginTop: 0 }}>BTW-aangifte {r.period.label}</h2>
              <p className="muted small">Neem deze bedragen over in Mijn Belastingdienst Zakelijk. Klik op een bedrag om het te kopiëren. Bedragen zijn in hele euro's, afgerond in jouw voordeel.</p>
              <div className="rubriek small muted"><span>Vak</span><span /><span className="num">Omzet</span><span className="num">Omzetbelasting</span></div>
              {r.rubrieken.filter((x) => x.code !== '5c').map((x) => (
                <div key={x.code} className="rubriek">
                  <strong>{x.code}</strong>
                  <span>{x.label}</span>
                  <span className="num">{x.omzetEuro !== null && <span className="copy" onClick={() => copy(x.omzetEuro)}>€ {x.omzetEuro.toLocaleString('nl-NL')}</span>}</span>
                  <span className="num">{x.btwEuro !== null && <span className="copy" onClick={() => copy(x.btwEuro)}>€ {x.btwEuro.toLocaleString('nl-NL')}</span>}</span>
                </div>
              ))}
              <div className="row" style={{ marginTop: 16 }}>
                <Button kind="primary" onClick={() => void run(() => api.app.openExternal(meta.vatPortalUrl))}>Open Mijn Belastingdienst Zakelijk</Button>
                {r.status !== 'ingediend' ? (
                  <Button disabled={busy} onClick={async () => {
                    if (!confirm(`Heb je de aangifte voor ${r.period.label} verstuurd? Daarna kun je in deze periode niets meer wijzigen.`)) return;
                    await run(() => api.vat.markSubmitted(r.period.key), 'Aangifte vastgelegd ✓');
                    await report.reload();
                    await periods.reload();
                  }}>Ik heb de aangifte gedaan</Button>
                ) : (
                  <Button disabled={busy} onClick={async () => {
                    if (!confirm('Periode heropenen? Doe dit alleen als de aangifte nog niet verstuurd is.')) return;
                    await run(() => api.vat.reopen(r.period.key));
                    await report.reload();
                    await periods.reload();
                  }}>Heropenen</Button>
                )}
                <span className="grow" />
                <Button small onClick={() => void run(() => api.vat.exportCsv(r.period.key), 'Opgeslagen')}>Overzicht voor boekhouder (CSV)</Button>
                {settings.advancedMode && <Button small title="Voorbereiding directe aangifte (SBR/Digipoort) — nog niet indienen" onClick={() => void run(() => api.vat.exportXbrl(r.period.key), 'XBRL opgeslagen')}>XBRL (test)</Button>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
