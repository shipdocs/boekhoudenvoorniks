import { useState } from 'react';
import { api } from '../api';
import { Button, DateNl, Empty, ErrorBox, Euro, Field, Modal, MoneyInput, useAction, useApp, useLoad } from '../ui';
import { today } from '../../shared/dates';

type Tab = 'overzicht' | 'bedrijfsmiddelen' | 'kilometers' | 'uren';
type AssetItem = Awaited<ReturnType<typeof api.assets.list>>[number];

/**
 * Inkomstenbelasting en aftrekposten: wat er bij de aangifte bij de winst komt (KIA, bijtellingen,
 * ondernemersaftrek), plus de bedrijfsmiddelen, kilometers en uren waar dat uit volgt.
 */
export function TaxYear() {
  const { route, go } = useApp();
  const [tab, setTab] = useState<Tab>((route.extra?.tab as Tab) ?? 'overzicht');
  const [year, setYear] = useState(new Date().getFullYear());
  return (
    <div className="page">
      <h1>Aangifte &amp; aftrekposten</h1>
      <p className="sub">Wat je bij je aangifte inkomstenbelasting nodig hebt, en welke aftrek je krijgt.</p>
      <div className="row between" style={{ marginBottom: 16 }}>
        <div className="chips">
          {([['overzicht', 'Voor je aangifte'], ['bedrijfsmiddelen', 'Bedrijfsmiddelen'], ['kilometers', 'Kilometers'], ['uren', 'Uren']] as const).map(([k, l]) => (
            <button key={k} className={tab === k ? 'selected' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        {tab !== 'bedrijfsmiddelen' && (
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Jaar">
            {[0, 1, 2, 3].map((i) => new Date().getFullYear() - i).map((y) => <option key={y}>{y}</option>)}
          </select>
        )}
      </div>
      {tab === 'overzicht' && <Overview year={year} />}
      {tab === 'bedrijfsmiddelen' && <Assets />}
      {tab === 'kilometers' && <Trips year={year} />}
      {tab === 'uren' && <Hours year={year} />}
      <p className="muted small" style={{ marginTop: 18 }}>
        <span className="clickable" onClick={() => go({ screen: 'instellingen', extra: { tab: 'btw' } })}>Auto, startjaar en urencriterium instellen</span>
      </p>
    </div>
  );
}

const euro = (cents: number) => `${cents < 0 ? '− ' : ''}€ ${(Math.abs(cents) / 100).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Overview({ year }: { year: number }) {
  const o = useLoad(() => api.incomeTax.overview(year), [year]);
  if (!o.data) return <ErrorBox error={o.error} />;
  const d = o.data;
  const b = d.breakdown;
  return (
    <>
      <div className="notice warn small">{d.disclaimer}</div>
      {d.running && <p className="muted small">{year} is nog bezig: de bedragen zijn tot en met vandaag.</p>}
      <div className="card">
        <table className="sumtable">
          <tbody>
            {d.items.filter((i) => i.amount !== null).map((i) => (
              <tr key={i.key} title={i.explain}>
                <td>
                  {i.label}
                  <div className="small muted">{i.explain}{i.where ? ` · In de aangifte: ${i.where}` : ''}</div>
                </td>
                <td className="num">{i.amount! > 0 && i.key !== 'winst' ? '+ ' : ''}{euro(i.amount!)}</td>
              </tr>
            ))}
            <tr className="total"><td>Belastbare winst uit onderneming (geschat)</td><td className="num">€ {b.taxableIncome.toLocaleString('nl-NL')}</td></tr>
          </tbody>
        </table>
      </div>
      {d.items.filter((i) => i.amount === null).map((i) => (
        <div key={i.key} className={`notice ${i.status === 'warn' ? 'warn' : ''}`}>
          <strong>{i.label}</strong>
          <div className="small">{i.explain}</div>
        </div>
      ))}
      <div className="hero" style={{ marginTop: 14 }}>
        <div className="card">
          <div className="value">{d.hours.total.toLocaleString('nl-NL')} uur</div>
          <div className="label">gewerkt{d.running ? `, op koers voor ± ${d.hours.projected.toLocaleString('nl-NL')}` : ''} · urencriterium {d.hours.target.toLocaleString('nl-NL')}</div>
        </div>
        <div className="card">
          <div className="value">{d.km.km.toLocaleString('nl-NL')} km</div>
          <div className="label">zakelijk met je privéauto · {euro(d.km.amount)} aftrek</div>
        </div>
        <div className="card">
          <div className="value">€ {b.total.toLocaleString('nl-NL')}</div>
          <div className="label">inkomstenbelasting + Zvw over deze winst (schatting)</div>
        </div>
      </div>
      <p className="muted small">
        Bedragen van {d.rulesYear}{d.rulesChecked ? '' : '; deze tabel is nog niet door een fiscalist gecontroleerd'}. Niet meegenomen: partner, andere inkomsten, willekeurige afschrijving en EIA/MIA/Vamil.
      </p>
    </>
  );
}

function Assets() {
  const { toast } = useApp();
  const list = useLoad(() => api.assets.list());
  const { run, busy } = useAction();
  const [editing, setEditing] = useState<AssetItem | null>(null);
  const [selling, setSelling] = useState<AssetItem | null>(null);
  if (!list.data) return <ErrorBox error={list.error} />;
  const bookDue = async () => {
    const r = await run(() => api.assets.bookDue());
    if (r) {
      toast(r.years.length ? `Afschrijving geboekt over ${r.years.join(', ')}` : 'Alles is al geboekt');
      await list.reload();
    }
  };
  return (
    <>
      <p className="muted">
        Alles vanaf € 450 (excl. btw) per stuk dat je jaren gebruikt, zoals een bus, steigers of een machine. De kosten verdeel je over de jaren (afschrijven, minstens 5 jaar).
        Na afloop van een jaar boekt de app de afschrijving zelf. Koop je via "Aankoop" iets als <em>groot gereedschap / machine</em>, dan komt het hier vanzelf bij.
      </p>
      {list.data.length === 0 ? (
        <Empty icon="🧰" title="Nog geen bedrijfsmiddelen">Kies bij een aankoop de categorie "Groot gereedschap / machine".</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr><th>Wat</th><th>Gekocht</th><th className="num">Aanschaf</th><th className="num">Per jaar</th><th className="num">Boekwaarde</th><th /></tr>
          </thead>
          <tbody>
            {list.data.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.name}
                  {a.status === 'verkocht' && <span className="pill"> verkocht <DateNl date={a.disposed_on} /></span>}
                  {a.kia_excluded ? <div className="small muted">telt niet mee voor de investeringsaftrek</div> : null}
                  {a.booked_elsewhere_until !== null && (
                    <div className="small muted">
                      Afschrijving t/m {a.booked_elsewhere_until} gaat ervan uit dat die buiten de app is gedaan (bv. door je boekhouder).{' '}
                      <span className="clickable" onClick={async () => { if (await run(() => api.assets.update(a.id, { bookInApp: true }), 'De app boekt ook de eerdere jaren') !== undefined) await list.reload(); }}>Toch in de app boeken</span>
                    </div>
                  )}
                  {a.belowThreshold && <div className="small muted">onder € 450: had ook direct als kosten gekund</div>}
                  {a.energyHint && <div className="small" style={{ color: 'var(--warn)' }}>Misschien EIA/MIA: meld bij RVO vóór <DateNl date={a.energyHint.deadline} /></div>}
                </td>
                <td><DateNl date={a.acquired_on} /></td>
                <td className="num"><Euro cents={a.cost} /></td>
                <td className="num">{a.status === 'actief' ? <Euro cents={a.perYear} /> : '—'}</td>
                <td className="num"><Euro cents={a.bookValue} /></td>
                <td>
                  {a.status === 'actief' && (
                    <div className="row end">
                      <Button small onClick={() => setEditing(a)}>Aanpassen</Button>
                      <Button small kind="ghost" onClick={() => setSelling(a)}>Verkocht…</Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <Button small disabled={busy} onClick={() => void bookDue()}>Afschrijving van vorige jaren boeken</Button>
      </div>
      {editing && <EditAsset asset={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void list.reload(); }} />}
      {selling && <SellAsset asset={selling} onClose={() => setSelling(null)} onSaved={() => { setSelling(null); void list.reload(); }} />}
    </>
  );
}

function EditAsset({ asset, onClose, onSaved }: { asset: AssetItem; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [name, setName] = useState(asset.name);
  const [years, setYears] = useState(String(asset.lifetime_months / 12));
  const [residual, setResidual] = useState<number | null>(asset.residual);
  const [car, setCar] = useState(!!asset.kia_excluded);
  const save = async () => {
    const r = await run(() => api.assets.update(asset.id, { name, lifetimeMonths: Math.round(Number(years.replace(',', '.')) * 12), residual: residual ?? 0, kiaExcluded: car }), 'Opgeslagen');
    if (r) onSaved();
  };
  return (
    <Modal title="Bedrijfsmiddel aanpassen" onClose={onClose}>
      <div className="grid">
        <Field label="Naam"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid cols-2">
          <Field label="Hoeveel jaar gebruik je het?" hint="minstens 5"><input value={years} onChange={(e) => setYears(e.target.value)} inputMode="decimal" /></Field>
          <Field label="Wat is het daarna nog waard?" hint="restwaarde, vaak € 0"><MoneyInput value={residual} onChange={setResidual} /></Field>
        </div>
        <label className="row small"><input type="checkbox" checked={car} onChange={(e) => setCar(e.target.checked)} /> Dit is een personenauto (telt niet mee voor de investeringsaftrek)</label>
        <p className="small muted">Afschrijving die al geboekt is, blijft staan; de wijziging geldt voor de rest van de looptijd.</p>
      </div>
      <div className="row end" style={{ marginTop: 14 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={busy} onClick={() => void save()}>Opslaan</Button>
      </div>
    </Modal>
  );
}

function SellAsset({ asset, onClose, onSaved }: { asset: AssetItem; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [date, setDate] = useState(today());
  const [price, setPrice] = useState<number | null>(0);
  const save = async () => {
    const r = await run(() => api.assets.dispose(asset.id, date, price ?? 0), 'Verwerkt');
    if (r) onSaved();
  };
  return (
    <Modal title={`${asset.name} verkocht of weggedaan`} onClose={onClose}>
      <div className="grid">
        <div className="grid cols-2">
          <Field label="Datum"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <Field label="Verkoopprijs excl. btw" hint="0 als je het weggooit"><MoneyInput value={price} onChange={setPrice} /></Field>
        </div>
        <p className="small muted">
          De app boekt de afschrijving tot de verkoop en haalt de boekwaarde van de balans. Heb je het verkocht? Maak dan ook een gewone factuur voor de koper (met btw): die zorgt voor de opbrengst.
          Verkoop je binnen 5 jaar na aankoop, dan kan een deel van de investeringsaftrek terug; dat staat dan bij "Voor je aangifte".
        </p>
      </div>
      <div className="row end" style={{ marginTop: 14 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={busy} onClick={() => void save()}>Verwerken</Button>
      </div>
    </Modal>
  );
}

function Trips({ year }: { year: number }) {
  const { settings } = useApp();
  const list = useLoad(() => api.mileage.list(year), [year]);
  const { run, busy } = useAction();
  const [date, setDate] = useState(today());
  const [km, setKm] = useState('');
  const [what, setWhat] = useState('');
  const add = async () => {
    const r = await run(() => api.mileage.add({ date, km: Number(km.replace(',', '.')), description: what }), 'Rit toegevoegd');
    if (r) {
      setKm('');
      setWhat('');
      await list.reload();
    }
  };
  const total = (list.data ?? []).reduce((t, x) => ({ km: t.km + x.km, amount: t.amount + x.amount }), { km: 0, amount: 0 });
  return (
    <>
      {settings.carUse === 'zakelijk' && <div className="notice warn small">Je hebt een bus of auto van de zaak ingesteld. Kilometers vul je hier alleen in voor ritten met een privévervoermiddel.</div>}
      <p className="muted">
        Rij je zakelijk met je privéauto (of motor, fiets)? Dan trek je per kilometer een vast bedrag af. Tanken, parkeren en verzekering zitten daar al in en zijn dan niet los aftrekbaar.
        Woon-werkverkeer telt voor ondernemers ook mee.
      </p>
      <div className="card row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <Field label="Datum"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Kilometers"><input value={km} onChange={(e) => setKm(e.target.value)} inputMode="decimal" style={{ width: 110 }} /></Field>
        <div style={{ flex: 1, minWidth: 200 }}><Field label="Waarheen / waarvoor"><input value={what} onChange={(e) => setWhat(e.target.value)} placeholder="bv. klant Jansen, Utrecht (heen en terug)" /></Field></div>
        <Button kind="primary" disabled={busy || !km || !what} onClick={() => void add()}>Toevoegen</Button>
      </div>
      {(list.data ?? []).length > 0 && (
        <table className="list" style={{ marginTop: 12 }}>
          <thead><tr><th>Datum</th><th>Rit</th><th className="num">Km</th><th className="num">Aftrek</th><th /></tr></thead>
          <tbody>
            {list.data!.map((t) => (
              <tr key={t.id}>
                <td><DateNl date={t.trip_date} /></td>
                <td>{t.description}</td>
                <td className="num">{t.km.toLocaleString('nl-NL')}</td>
                <td className="num"><Euro cents={t.amount} /></td>
                <td><Button small kind="ghost" onClick={async () => { if (await run(async () => { await api.mileage.remove(t.id); return true; })) await list.reload(); }}>Weghalen</Button></td>
              </tr>
            ))}
            <tr><td /><td><strong>Totaal {year}</strong></td><td className="num"><strong>{Math.round(total.km * 10) / 10}</strong></td><td className="num"><strong><Euro cents={total.amount} /></strong></td><td /></tr>
          </tbody>
        </table>
      )}
    </>
  );
}

function Hours({ year }: { year: number }) {
  const totals = useLoad(() => api.hours.totals(year), [year]);
  const list = useLoad(() => api.hours.list(year), [year]);
  const { run, busy } = useAction();
  const [date, setDate] = useState(today());
  const [hours, setHours] = useState('');
  const [what, setWhat] = useState('');
  const reload = async () => {
    await totals.reload();
    await list.reload();
  };
  const add = async () => {
    const r = await run(() => api.hours.add({ date, hours: Number(hours.replace(',', '.')), description: what }), 'Uren toegevoegd');
    if (r) {
      setHours('');
      setWhat('');
      await reload();
    }
  };
  const t = totals.data;
  return (
    <>
      <p className="muted">
        Voor de zelfstandigenaftrek (en startersaftrek) moet je minstens 1.225 uur per jaar aan je bedrijf werken. Uren op de werkbonnen van je klussen tellen vanzelf mee.
        Vul hier de rest in: offertes maken, administratie, inkopen, reistijd.
      </p>
      {t && (
        <div className="card">
          <strong>{t.total.toLocaleString('nl-NL')} uur</strong> in {year} · {t.workOrders.toLocaleString('nl-NL')} op werkbonnen, {t.other.toLocaleString('nl-NL')} apart
          <div className="progress" style={{ marginTop: 8, height: 8, background: 'var(--surface-2)', borderRadius: 99 }}>
            <div style={{ width: `${Math.min(100, (t.total / 1225) * 100)}%`, height: '100%', background: t.total >= 1225 ? 'var(--good)' : 'var(--primary)', borderRadius: 99 }} />
          </div>
        </div>
      )}
      <div className="card row" style={{ alignItems: 'flex-end', flexWrap: 'wrap', marginTop: 12 }}>
        <Field label="Datum"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Uren"><input value={hours} onChange={(e) => setHours(e.target.value)} inputMode="decimal" style={{ width: 90 }} /></Field>
        <div style={{ flex: 1, minWidth: 200 }}><Field label="Wat heb je gedaan?"><input value={what} onChange={(e) => setWhat(e.target.value)} placeholder="bv. offertes en administratie" /></Field></div>
        <Button kind="primary" disabled={busy || !hours || !what} onClick={() => void add()}>Toevoegen</Button>
      </div>
      {(list.data ?? []).length > 0 && (
        <table className="list" style={{ marginTop: 12 }}>
          <tbody>
            {list.data!.map((h) => (
              <tr key={h.id}>
                <td><DateNl date={h.entry_date} /></td>
                <td>{h.description}</td>
                <td className="num">{h.hours.toLocaleString('nl-NL')} uur</td>
                <td><Button small kind="ghost" onClick={async () => { if (await run(async () => { await api.hours.remove(h.id); return true; })) await reload(); }}>Weghalen</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
