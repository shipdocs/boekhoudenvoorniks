import { useState } from 'react';
import { api } from '../api';
import { Button, DateNl, ErrorBox, Euro, Modal, useAction, useApp, useLoad } from '../ui';
import { formatDateNl, vatDeadline } from '../../shared/dates';
import { VAT_DISCLAIMER } from '../../shared/legal';
import { AccountantNotice } from './TaxYear';

/** Eén regel uitleg per vak van de btw-aangifte (de officiële naam staat ervoor). */
const RUBRIEK_UITLEG: Record<string, string> = {
  '1a': 'je omzet met 21% btw',
  '1b': 'je omzet met 9% btw',
  '1d': 'btw over privégebruik van je auto van de zaak',
  '1e': 'omzet met 0% of btw verlegd',
  '2a': 'btw die een onderaannemer naar jou verlegde',
  '3a': 'verkoop aan klanten buiten de EU',
  '3b': 'verkoop aan bedrijven in andere EU-landen',
  '4a': 'aankopen van buiten de EU zonder btw',
  '4b': 'aankopen uit andere EU-landen zonder btw (bv. Google, Meta)',
  '5a': 'alle btw die je moet betalen',
  '5b': 'btw die je terugkrijgt over je aankopen',
  '5g': 'wat je betaalt of terugkrijgt',
};

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
  const [detail, setDetail] = useState<{ code: string; title: string } | null>(null);

  if (settings.kor) {
    return (
      <div className="page-narrow">
        <h1>Belasting</h1>
        <div className="card">
          <h3>Je gebruikt de kleineondernemersregeling (KOR): je rekent geen btw omdat je weinig omzet hebt</h3>
          <p className="muted">Je rekent geen btw en hoeft geen btw-aangifte te doen. Houd je omzet in de gaten: boven € 20.000 per jaar vervalt de KOR.</p>
          <Button onClick={() => go({ screen: 'instellingen', extra: { tab: 'btw' } })}>Btw-instellingen</Button>
        </div>
        <IncomeTaxCard />
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
      <p className="sub">Wij rekenen je btw uit. Jij hoeft alleen de bedragen over te nemen.</p>

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
            <h2 style={{ marginTop: 0 }}>Btw {r.period.label}</h2>
            <table className="sumtable">
              <tbody>
                <tr className="clickable" title="Klik om te zien waar dit bedrag vandaan komt" onClick={() => setDetail({ code: 'omzet', title: 'Omzet' })}><td>Omzet <span className="muted small">🔍</span></td><td><Euro cents={r.summary.omzet} /></td></tr>
                <tr className="clickable" title="Klik om te zien waar dit bedrag vandaan komt" onClick={() => setDetail({ code: 'btw-omzet', title: 'Btw die je hebt ontvangen' })}><td>Btw die je hebt ontvangen <span className="muted small">🔍</span></td><td><Euro cents={r.summary.btwOverOmzet} /></td></tr>
                {r.summary.btwPrive !== 0 && <tr><td>Btw over privégebruik van je auto</td><td><Euro cents={r.summary.btwPrive} /></td></tr>}
                {r.summary.btwVerlegd !== 0 && <tr><td>Btw die naar jou is verlegd (door een onderaannemer of een buitenlandse leverancier; je betaalt hem en krijgt hem tegelijk terug: kost je niets)</td><td><Euro cents={r.summary.btwVerlegd} /></td></tr>}
                <tr className="clickable" title="Klik om te zien waar dit bedrag vandaan komt" onClick={() => setDetail({ code: '5b', title: 'Btw die je terugkrijgt (aankopen)' })}><td>Min: btw die je terugkrijgt (aankopen) <span className="muted small">🔍</span></td><td><Euro cents={r.summary.voorbelasting} /></td></tr>
                <tr className="total"><td>{r.summary.teBetalen >= 0 ? 'Te betalen' : 'Je krijgt terug'}</td><td><Euro cents={Math.abs(r.summary.teBetalen)} /></td></tr>
                {r.corrections.filter((c) => !c.suppletie).map((c) => (
                  <tr key={c.periodKey} className="muted small"><td>Waarvan verbetering van {c.label}</td><td><Euro cents={c.btw} /></td></tr>
                ))}
              </tbody>
            </table>
            {r.corrections.some((c) => !c.suppletie) && (
              <p className="muted small">Iets geboekt in een periode die je al had aangegeven? Dan telt het hier mee. Tot € 1.000 mag dat in de volgende aangifte.</p>
            )}
            {r.corrections.filter((c) => c.suppletie).map((c) => (
              <div key={c.periodKey} className="notice warn">
                <strong>Oude aangifte verbeteren ({c.label}):</strong> er is achteraf <Euro cents={Math.abs(c.btw)} /> btw {c.btw >= 0 ? 'bijgekomen' : 'afgegaan'}. Dat is meer dan € 1.000, dus dat verbeter je apart in Mijn Belastingdienst Zakelijk (dat heet een "suppletie"). Het zit niet in de bedragen hierboven.
                <div className="row" style={{ marginTop: 8 }}>
                  <Button small onClick={() => void run(() => api.app.openExternal(meta.vatSuppletieUrl))}>Hoe verbeter ik een aangifte?</Button>
                  <Button small disabled={busy} onClick={async () => {
                    if (!confirm(`Heb je de verbetering voor ${c.label} verstuurd?`)) return;
                    await run(() => api.vat.markSuppletieSubmitted(c.periodKey), 'Verbetering vastgelegd ✓');
                    await report.reload();
                  }}>Verbetering is verstuurd</Button>
                </div>
              </div>
            ))}
            {r.status === 'ingediend' ? (
              <div className="notice good">✓ Je hebt deze aangifte gedaan{r.submittedAt ? ` (${formatDateNl(r.submittedAt.slice(0, 10))})` : ''}.</div>
            ) : (
              deadline && r.summary.teBetalen > 0 && <p style={{ marginTop: 14 }}>Zorg dat uiterlijk <strong>{formatDateNl(deadline)}</strong> ongeveer <strong><Euro cents={r.summary.teBetalen} /></strong> beschikbaar is.</p>
            )}
            {r.warnings.filter((w) => !/suppletie/.test(w)).map((w) => <div key={w} className="notice warn">{w}</div>)}
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
                          {c.action ? (
                            <Button small kind="primary" disabled={busy} onClick={async () => {
                              if ((await run(async () => { await api.vat.bookCarPrivateUse(r.period.key); return true; }, 'Opgenomen in deze aangifte (vak 1d)')) !== undefined) {
                                await Promise.all([checks.reload(), report.reload()]);
                              }
                            }}>{c.action.label}</Button>
                          ) : (
                            <Button small onClick={() => (c.screen === 'belasting' ? setDetails(true) : go({ screen: c.screen as never, extra: c.screen === 'instellingen' ? { tab: 'btw' } : undefined }))}>{c.screen === 'belasting' ? 'Bekijk berekening' : 'Oplossen'}</Button>
                          )}
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
              <h2 style={{ marginTop: 0 }}>Btw-aangifte {r.period.label}</h2>
              <p className="muted small">Neem deze bedragen over in Mijn Belastingdienst Zakelijk. Klik op een bedrag om het te kopiëren, of op 🔍 om te zien welke boekingen erin zitten. Bedragen zijn in hele euro's, afgerond in jouw voordeel.</p>
              <div className="notice small">{VAT_DISCLAIMER}</div>
              <div className="rubriek small muted"><span>Vak</span><span /><span className="num">Omzet</span><span className="num">Btw</span></div>
              {r.rubrieken.filter((x) => x.code !== '5c' && !(/^[34]/.test(x.code) && !x.omzet && !x.btw)).map((x) => (
                <div key={x.code} className="rubriek">
                  <strong>{x.code}</strong>
                  <span>
                    {x.label}{RUBRIEK_UITLEG[x.code] && <span className="small muted"> · {RUBRIEK_UITLEG[x.code]}</span>}
                    {x.code !== '5g' && (x.omzet || x.btw) ? <> <button className="linklike small" title="Welke boekingen zitten hierin?" onClick={() => setDetail({ code: x.code, title: `Vak ${x.code}: ${RUBRIEK_UITLEG[x.code] ?? x.label}` })}>🔍 details</button></> : null}
                  </span>
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
          {detail && <VatDetails periodKey={r.period.key} code={detail.code} title={detail.title} onClose={() => setDetail(null)} />}
        </>
      )}
      <IncomeTaxCard />
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  factuur: 'factuur',
  inkoop: 'aankoop / bonnetje',
  bank: 'bankbetaling',
  handmatig: 'handmatige boeking',
  integratie: 'webshop / betaalprovider',
  opening: 'beginbalans',
};

/**
 * "Waar komt dit bedrag vandaan?": de boekingen achter een regel van de btw-berekening, met een
 * knop naar de factuur, bon of betaling. Zo zie je meteen of er iets verkeerd geboekt is.
 */
function VatDetails({ periodKey, code, title, onClose }: { periodKey: string; code: string; title: string; onClose: () => void }) {
  const { go } = useApp();
  const d = useLoad(() => api.vat.details(periodKey, code), [periodKey, code]);
  const lines = d.data?.lines ?? [];
  const showOmzet = lines.some((l) => l.omzet !== 0);
  const showBtw = lines.some((l) => l.btw !== 0);
  const fromBankAsIncome = lines.some((l) => l.source === 'bank' && l.omzet > 0 && !l.invoiceId);
  const open = (l: (typeof lines)[number]) => {
    onClose();
    if (l.invoiceId) go({ screen: 'factuur', id: l.invoiceId });
    else if (l.bankTransactionId) go({ screen: 'categorie', id: l.bankTransactionId });
    else if (l.purchaseId) go({ screen: 'aankopen' });
  };
  return (
    <Modal title={title} onClose={onClose} wide>
      <ErrorBox error={d.error} />
      {d.data && lines.length === 0 && <p className="muted">Er zitten geen boekingen in.</p>}
      {fromBankAsIncome && (
        <div className="notice small">
          Een deel komt van <strong>geld dat binnenkwam op de bank</strong> en als "omzet zonder factuur" is geboekt. Was dat geen omzet (bijvoorbeeld geld van
          jezelf, een terugbetaling of een lening)? Klik op <strong>Bekijken</strong> en kies daar wat het wel was.
        </div>
      )}
      {lines.length > 0 && (
        <table className="list small">
          <thead>
            <tr><th>Datum</th><th>Wat</th><th>Waar vandaan</th>{showOmzet && <th className="num">Omzet</th>}{showBtw && <th className="num">Btw</th>}<th /></tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.entryId} className={l.reversed || l.reversal ? 'muted' : ''}>
                <td><DateNl date={l.date} /></td>
                <td>
                  {l.description}
                  {l.counterparty && <div className="muted">{l.counterparty}</div>}
                  {l.reversed && <div className="muted">later teruggedraaid</div>}
                  {l.reversal && <div className="muted">tegenboeking (draait een eerdere boeking terug)</div>}
                </td>
                <td>{SOURCE_LABEL[l.source] ?? l.source}</td>
                {showOmzet && <td className="num"><Euro cents={l.omzet} /></td>}
                {showBtw && <td className="num"><Euro cents={l.btw} /></td>}
                <td>{(l.invoiceId || l.bankTransactionId || l.purchaseId) && <Button small onClick={() => open(l)}>Bekijken</Button>}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td /><td><strong>Totaal</strong></td><td />{showOmzet && <td className="num"><strong><Euro cents={d.data!.omzet} /></strong></td>}{showBtw && <td className="num"><strong><Euro cents={d.data!.btw} /></strong></td>}<td /></tr>
          </tfoot>
        </table>
      )}
    </Modal>
  );
}

/** Opgaaf intracommunautaire prestaties (#16): alleen zichtbaar als er in deze periode aan EU-bedrijven verkocht is. */
function IcpCard({ periodKey }: { periodKey: string }) {
  const { run } = useAction();
  const icp = useLoad(() => api.vat.icp(periodKey), [periodKey]);
  if (!icp.data || icp.data.lines.length === 0) return null;
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h2 style={{ marginTop: 0 }}>Verkopen aan EU-bedrijven {icp.data.period.label} (ICP-opgaaf)</h2>
      <p className="muted small">Deze verkopen geef je apart op in Mijn Belastingdienst Zakelijk, per klant. Kies daar per regel "goederen" of "diensten".</p>
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

const BUITENLAND_TEXT = 'Nog niet door een belastingexpert nagekeken. Controleer de btw-nummers op de EU-site "VIES" voordat je de opgaaf doet, of laat je boekhouder meekijken.';

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
      <AccountantNotice compact />
      <p>
        Winst tot nu: <strong><Euro cents={e.profitToDate} /></strong>. Doorgetrokken naar het hele jaar: <Euro cents={e.profitYear} />.<br />
        Geschatte inkomstenbelasting + zorgpremie (Zvw) over {e.year}: <strong>± <Euro cents={e.taxYear} /></strong>.<br />
        Zet daarvan nu ongeveer <strong>± <Euro cents={e.reserveToDate} /></strong> opzij (voor het deel van het jaar dat al voorbij is).<br />
        <span className="small muted">Vuistregel: zet elke maand 30 à 40% van je winst apart voor inkomstenbelasting en Zvw. Kies liever 40%: de aftrek voor zzp'ers wordt elk jaar kleiner.</span>
      </p>
      <Button small onClick={() => setOpen((o) => !o)}>{open ? 'Verberg berekening' : 'Hoe is dit berekend?'}</Button>
      {open && (
        <div className="small" style={{ marginTop: 10 }}>
          <table>
            <tbody>
              <tr><td>Winst (heel jaar, geschat)</td><td className="num">{euro(b.profit)}</td></tr>
              {b.bijtellingen > 0 && <tr><td>+ Niet (helemaal) aftrekbaar (etentjes, privédeel telefoon, verkochte investering)</td><td className="num">{euro(b.bijtellingen)}</td></tr>}
              {b.kia > 0 && <tr><td>− Extra aftrek voor investeringen (KIA)</td><td className="num">{euro(b.kia)}</td></tr>}
              <tr><td>− Aftrek voor zelfstandigen</td><td className="num">{euro(b.zelfstandigenaftrek)}</td></tr>
              {b.startersaftrek > 0 && <tr><td>− Extra aftrek voor starters</td><td className="num">{euro(b.startersaftrek)}</td></tr>}
              <tr><td>− Korting voor kleine bedrijven <span className="muted">(vast deel van je winst is onbelast)</span></td><td className="num">{euro(b.mkbWinstvrijstelling)}</td></tr>
              <tr><td>= Hierover betaal je belasting</td><td className="num">{euro(b.taxableIncome)}</td></tr>
              <tr><td>Inkomstenbelasting</td><td className="num">{euro(b.box1)}</td></tr>
              <tr><td>− Kortingen die iedereen krijgt (heffingskortingen)</td><td className="num">{euro(b.heffingskortingen)}</td></tr>
              <tr><td>+ Zorgpremie (Zvw)</td><td className="num">{euro(b.zvw)}</td></tr>
              <tr><td><strong>Totaal</strong></td><td className="num"><strong>{euro(b.total)}</strong></td></tr>
            </tbody>
          </table>
          <p className="muted">Tarieven van {e.rulesYear}{e.rulesYear !== e.year ? ` (voor ${e.year} nog niet bekend in de app)` : ''}{e.rulesChecked ? '' : '; deze bedragen zijn nog niet door een belastingexpert nagekeken'}.</p>
          <p className="muted">Niet meegenomen: {e.notIncluded.join('; ')}.</p>
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <Button small kind="primary" onClick={() => go({ screen: 'aangifte' })}>Aftrek, investeringen en kilometers</Button>
      </div>
      <p className="muted small" style={{ marginTop: 10 }}>
        <span className="clickable" onClick={() => go({ screen: 'instellingen', extra: { tab: 'btw' } })}>Werk je 1.225 uur per jaar aan je bedrijf? Aanpassen, of de schatting uitzetten</span>
      </p>
    </div>
  );
}
