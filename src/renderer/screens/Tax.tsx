import { useState } from 'react';
import { api } from '../api';
import { Button, ErrorBox, Euro, useAction, useApp, useLoad } from '../ui';
import { formatDateNl, vatDeadline } from '../../shared/dates';
import { VAT_DISCLAIMER } from '../../shared/legal';

export function Tax({ periodKey }: { periodKey?: string }) {
  const { settings, meta, toast, go } = useApp();
  const { run, busy } = useAction();
  const [year, setYear] = useState(periodKey ? Number(periodKey.slice(0, 4)) : new Date().getFullYear());
  const periods = useLoad(() => api.vat.periods(year), [year]);
  const current = useLoad(() => api.vat.current());
  const [key, setKey] = useState<string | undefined>(periodKey);
  const selected = key ?? current.data?.key;
  const report = useLoad(async () => (selected ? api.vat.calculate(selected) : null), [selected]);
  // controles horen bij één periode; tijdens het laden na een wissel nooit die van de vorige tonen
  const checksLoad = useLoad(async () => ({ key: selected, list: selected ? await api.vat.checks(selected) : [] }), [selected]);
  const checks = { data: checksLoad.data && checksLoad.data.key === selected ? checksLoad.data.list : undefined, reload: checksLoad.reload };
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
                {r.corrections.filter((c) => !c.suppletie).map((c) => (
                  <tr key={c.periodKey} className="muted small"><td>Waarvan correctie op {c.label}</td><td><Euro cents={c.btw} /></td></tr>
                ))}
              </tbody>
            </table>
            {r.corrections.some((c) => !c.suppletie) && (
              <p className="muted small">Iets geboekt in een periode die je al had aangegeven? Dan telt het hier mee. Tot € 1.000 mag dat in de volgende aangifte.</p>
            )}
            {r.corrections.filter((c) => c.suppletie).map((c) => (
              <div key={c.periodKey} className="notice warn">
                <strong>Suppletie nodig voor {c.label}:</strong> er is achteraf <Euro cents={Math.abs(c.btw)} /> btw {c.btw >= 0 ? 'bijgekomen' : 'afgegaan'}. Dat is meer dan € 1.000, dus dat verbeter je apart in Mijn Belastingdienst Zakelijk. Het zit niet in de bedragen hierboven.
                <div className="row" style={{ marginTop: 8 }}>
                  <Button small onClick={() => void run(() => api.app.openExternal(meta.vatSuppletieUrl))}>Hoe werkt een suppletie?</Button>
                  <Button small disabled={busy} onClick={async () => {
                    if (!confirm(`Heb je de suppletie voor ${c.label} verstuurd?`)) return;
                    await run(() => api.vat.markSuppletieSubmitted(c.periodKey), 'Suppletie vastgelegd ✓');
                    await report.reload();
                  }}>Suppletie is gedaan</Button>
                </div>
              </div>
            ))}
            {r.status === 'ingediend' ? (
              <div className="notice good">✓ Je hebt deze aangifte gedaan{r.submittedAt ? ` (${formatDateNl(r.submittedAt.slice(0, 10))})` : ''}.</div>
            ) : (
              deadline && r.summary.teBetalen > 0 && <p style={{ marginTop: 14 }}>Zorg dat uiterlijk <strong>{formatDateNl(deadline)}</strong> ongeveer <strong><Euro cents={r.summary.teBetalen} /></strong> beschikbaar is.</p>
            )}
            {r.warnings.filter((w) => !/suppletie-aangifte/.test(w)).map((w) => <div key={w} className="notice warn">{w}</div>)}
            {r.status !== 'ingediend' && (checks.data ?? []).length > 0 && (
              <div style={{ marginTop: 14 }}>
                <strong>Even controleren vóór je aangifte doet</strong>
                <ul className="checks">
                  {(checks.data ?? []).map((c) => (
                    <li key={c.key}>
                      <span aria-hidden>{c.skipped ? '➖' : c.blocking ? '⚠️' : '💡'}</span>
                      <div className="grow">
                        <div className={c.skipped ? 'muted' : ''}>{c.title}{c.skipped ? ' (bewust overgeslagen)' : ''}</div>
                        {!c.skipped && <div className="small muted">{c.detail}</div>}
                      </div>
                      {!c.skipped && (
                        <span className="row">
                          <Button small onClick={() => (c.screen === 'belasting' ? setDetails(true) : go({ screen: c.screen as never }))}>{c.screen === 'belasting' ? 'Bekijk berekening' : 'Oplossen'}</Button>
                          <Button small kind="ghost" disabled={busy} onClick={async () => {
                            const reason = c.blocking ? prompt('Waarom sla je dit over? (bv. "bon kwijt, bedrag klopt wel")') : '';
                            if (reason === null) return;
                            await run(() => api.vat.skipCheck(r.period.key, c.key, reason));
                            await checks.reload();
                          }}>{c.blocking ? 'Bewust overslaan' : 'Klopt'}</Button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="row" style={{ marginTop: 14 }}>
              <Button onClick={() => setDetails((d) => !d)}>{details ? 'Verberg berekening' : 'Bekijk berekening'}</Button>
            </div>
          </div>

          {details && (
            <div className="card" style={{ marginTop: 14 }}>
              <h2 style={{ marginTop: 0 }}>BTW-aangifte {r.period.label}</h2>
              <p className="muted small">Neem deze bedragen over in Mijn Belastingdienst Zakelijk. Klik op een bedrag om het te kopiëren. Bedragen zijn in hele euro's, afgerond in jouw voordeel.</p>
              <div className="notice small">{VAT_DISCLAIMER}</div>
              <div className="rubriek small muted"><span>Vak</span><span /><span className="num">Omzet</span><span className="num">Omzetbelasting</span></div>
              {r.rubrieken.filter((x) => x.code !== '5c' && !(/^[34]/.test(x.code) && !x.omzet && !x.btw)).map((x) => (
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
                  <Button disabled={busy || !checks.data || checks.data.some((c) => c.blocking && !c.skipped)} title={(checks.data ?? []).some((c) => c.blocking && !c.skipped) ? 'Los eerst de controles hierboven op, of sla ze bewust over' : undefined} onClick={async () => {
                    if (!confirm(`Heb je de aangifte voor ${r.period.label} verstuurd? Wat je daarna nog in deze periode boekt, telt mee in je volgende aangifte.`)) return;
                    await run(() => api.vat.markSubmitted(r.period.key), 'Aangifte vastgelegd ✓');
                    await report.reload();
                    await checks.reload();
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
          <IcpCard periodKey={r.period.key} />
        </>
      )}
      <IncomeTaxCard />
    </div>
  );
}

/** Opgaaf intracommunautaire prestaties (#16): alleen zichtbaar als er in deze periode aan EU-bedrijven verkocht is. */
function IcpCard({ periodKey }: { periodKey: string }) {
  const { run } = useAction();
  const icp = useLoad(() => api.vat.icp(periodKey), [periodKey]);
  if (!icp.data || icp.data.lines.length === 0) return null;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2 style={{ marginTop: 0 }}>Opgaaf ICP {icp.data.period.label}</h2>
      <p className="muted small">Verkopen aan bedrijven in andere EU-landen (rubriek 3b). Geef deze per klant op in Mijn Belastingdienst Zakelijk (opgaaf intracommunautaire prestaties) en kies daar per regel goederen of diensten.</p>
      <table>
        <thead><tr><th>Land</th><th>Btw-nummer</th><th>Klant</th><th className="num">Bedrag</th></tr></thead>
        <tbody>
          {icp.data.lines.map((l) => (
            <tr key={`${l.relationId}`}>
              <td>{l.country}</td>
              <td>{l.vatNumber || '—'}{l.problems.length > 0 && <div className="small" style={{ color: 'var(--danger, #b42318)' }}>⚠️ {l.problems.join(', ')}</div>}</td>
              <td>{l.name}</td>
              <td className="num">€ {l.amountEuro.toLocaleString('nl-NL')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="notice small" style={{ marginTop: 10 }}>{BUITENLAND_TEXT}</div>
      <div className="row" style={{ marginTop: 10 }}>
        <Button small onClick={() => void run(() => api.vat.exportIcpCsv(periodKey), 'Opgeslagen')}>ICP-overzicht (CSV)</Button>
      </div>
    </div>
  );
}

const BUITENLAND_TEXT = 'Nog niet door een fiscalist gecontroleerd. Controleer de bedragen en btw-nummers (bv. via VIES) voordat je de opgaaf doet.';

/** Schatting inkomstenbelasting (#33 fase 2). Altijd als schatting gemarkeerd; uit te zetten in Instellingen. */
function IncomeTaxCard() {
  const { go } = useApp();
  const est = useLoad(() => api.incomeTax.estimate());
  const [open, setOpen] = useState(false);
  const e = est.data;
  if (!e) return null;
  const b = e.breakdown;
  const euro = (n: number) => `€ ${n.toLocaleString('nl-NL')}`;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2 style={{ marginTop: 0 }}>Inkomstenbelasting {e.year} <span className="muted small">(schatting)</span></h2>
      <div className="notice warn small">{e.disclaimer}</div>
      <p>
        Winst tot nu: <strong><Euro cents={e.profitToDate} /></strong>. Doorgetrokken naar het hele jaar: <Euro cents={e.profitYear} />.<br />
        Geschatte inkomstenbelasting + Zvw-bijdrage over {e.year}: <strong>± <Euro cents={e.taxYear} /></strong>.<br />
        Zet daarvan nu ongeveer <strong>± <Euro cents={e.reserveToDate} /></strong> opzij (naar rato van het jaar tot nu).
      </p>
      <Button small onClick={() => setOpen((o) => !o)}>{open ? 'Verberg berekening' : 'Hoe is dit berekend?'}</Button>
      {open && (
        <div className="small" style={{ marginTop: 10 }}>
          <table>
            <tbody>
              <tr><td>Winst (heel jaar, geschat)</td><td className="num">{euro(b.profit)}</td></tr>
              <tr><td>− Zelfstandigenaftrek</td><td className="num">{euro(b.zelfstandigenaftrek)}</td></tr>
              <tr><td>− MKB-winstvrijstelling</td><td className="num">{euro(b.mkbWinstvrijstelling)}</td></tr>
              <tr><td>= Belastbaar inkomen</td><td className="num">{euro(b.taxableIncome)}</td></tr>
              <tr><td>Belasting box 1</td><td className="num">{euro(b.box1)}</td></tr>
              <tr><td>− Heffingskortingen (algemeen + arbeid)</td><td className="num">{euro(b.heffingskortingen)}</td></tr>
              <tr><td>+ Bijdrage Zvw</td><td className="num">{euro(b.zvw)}</td></tr>
              <tr><td><strong>Totaal</strong></td><td className="num"><strong>{euro(b.total)}</strong></td></tr>
            </tbody>
          </table>
          <p className="muted">Tarieven van {e.rulesYear}{e.rulesYear !== e.year ? ` (voor ${e.year} nog niet bekend in de app)` : ''}{e.rulesChecked ? '' : '; deze tabel is nog niet door een fiscalist gecontroleerd'}.</p>
          <p className="muted">Niet meegenomen: {e.notIncluded.join('; ')}.</p>
        </div>
      )}
      <p className="muted small" style={{ marginTop: 10 }}>
        <span className="clickable" onClick={() => go({ screen: 'instellingen', extra: { tab: 'btw' } })}>Urencriterium aanpassen of de schatting uitzetten</span>
      </p>
    </div>
  );
}
