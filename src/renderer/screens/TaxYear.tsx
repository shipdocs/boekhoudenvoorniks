import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, DateNl, Empty, ErrorBox, Euro, Field, Modal, MoneyInput, useAction, useApp, useLoad } from '../ui';
import { formatDateNl, isIsoDate, isoWeek, monthOf, today, weekOf } from '../../shared/dates';
import type { HoursPeriod } from '../../tax/mileage';
import { ACCOUNTANT_CHECK_REASONS, ACCOUNTANT_CHECK_TITLE } from '../../shared/legal';
import { kiaFor, rulesFor } from '../../tax/income-tax';

/** Vaste, niet weg te klikken melding bij elke berekening voor de inkomstenbelasting. */
export function AccountantNotice({ compact }: { compact?: boolean }) {
  return (
    <div className="notice warn" role="note">
      <strong>⚠️ {ACCOUNTANT_CHECK_TITLE}.</strong>
      {compact ? (
        <div className="small">De app rekent voor je, maar kan fouten maken en kent de nieuwste regels en je hele situatie niet.</div>
      ) : (
        <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {ACCOUNTANT_CHECK_REASONS.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
    </div>
  );
}

/** Eenmaal per jaar: uitleg waarom, en bevestigen voordat de berekeningen te zien zijn. */
function AccountantGate({ onAccepted }: { onAccepted: () => void }) {
  const { run, busy } = useAction();
  const [checked, setChecked] = useState(false);
  return (
    <div className="card grid" style={{ maxWidth: 720 }}>
      <h2 style={{ margin: 0 }}>Eerst even dit</h2>
      <p>
        De app rekent je aftrekposten en een schatting van je inkomstenbelasting uit. Dat scheelt werk, maar het blijft een hulpmiddel.{' '}
        <strong>Laat je aangifte altijd controleren door een boekhouder of accountant</strong>, ook als alles lijkt te kloppen. Waarom:
      </p>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {ACCOUNTANT_CHECK_REASONS.map((r) => <li key={r}>{r}</li>)}
      </ul>
      <p className="small muted">Tip: met de knop "Kopieer voor je boekhouder" geef je in één keer alle bedragen en de uitleg door.</p>
      <label className="row"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> Ik begrijp dat dit een hulpmiddel is en laat mijn aangifte controleren door een boekhouder of accountant.</label>
      <div className="row end">
        <Button kind="primary" disabled={!checked || busy} onClick={async () => {
          if (await run(async () => { await api.settings.update({ taxCheckAcknowledgedYear: new Date().getFullYear() }); return true; })) onAccepted();
        }}>Verder</Button>
      </div>
    </div>
  );
}

type Tab = 'overzicht' | 'bedrijfsmiddelen' | 'kilometers' | 'uren';
type AssetItem = Awaited<ReturnType<typeof api.assets.list>>[number];

/**
 * Inkomstenbelasting en aftrekposten: wat er bij de aangifte bij de winst komt (KIA, bijtellingen,
 * ondernemersaftrek), plus de bedrijfsmiddelen, kilometers en uren waar dat uit volgt.
 */
export function TaxYear() {
  const { route, go, settings, reloadSettings } = useApp();
  const [tab, setTab] = useState<Tab>((route.extra?.tab as Tab) ?? 'overzicht');
  const [year, setYear] = useState(new Date().getFullYear());
  return (
    <div className="page">
      <h1>Aftrek &amp; investeringen</h1>
      <p className="sub">Welke aftrek je krijgt, en wat je boekhouder nodig heeft voor je aangifte inkomstenbelasting.</p>
      {settings.taxCheckAcknowledgedYear !== new Date().getFullYear() ? (
        <AccountantGate onAccepted={() => void reloadSettings()} />
      ) : (
      <>
      <AccountantNotice compact />
      <div className="row between" style={{ marginBottom: 16 }}>
        <div className="chips">
          {([['overzicht', 'Voor je aangifte'], ['bedrijfsmiddelen', 'Investeringen'], ['kilometers', 'Kilometers'], ['uren', 'Uren']] as const).map(([k, l]) => (
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
      </>
      )}
      <p className="muted small" style={{ marginTop: 18 }}>
        <span className="clickable" onClick={() => go({ screen: 'instellingen', extra: { tab: 'btw' } })}>Auto, startjaar en je uren (norm: 1.225 per jaar) instellen</span>
      </p>
    </div>
  );
}

type OverviewData = Awaited<ReturnType<typeof api.incomeTax.overview>>;

/** Het overzicht als platte tekst, om te mailen naar je boekhouder: met alle vaktermen en notities. */
async function copyForAccountant(d: OverviewData): Promise<void> {
  const item = (i: OverviewData['items'][number]) => `- ${i.label}${i.amount !== null ? `: ${euro(i.amount)}` : ''}\n  ${i.explain}${i.note ? `\n  Voor de boekhouder: ${i.note}` : ''}`;
  const lines = [
    `Overzicht inkomstenbelasting ${d.year} uit BoekhoudenVoorNiks${d.running ? ` (tot en met ${d.asOf}, jaar nog bezig)` : ''}`,
    'Graag controleren: dit is berekend door software, niet door een deskundige.',
    '',
    'Bedragen:',
    ...d.items.filter((i) => i.amount !== null).map(item),
    `Belastbare winst uit onderneming (geschat): € ${d.breakdown.taxableProfit.toLocaleString('nl-NL')}${d.breakdown.taxableProfit < 0 ? ' (verlies)' : ''}`,
    '',
    'Aandachtspunten:',
    ...d.items.filter((i) => i.amount === null).map(item),
    '',
    `Uren: ${d.hours.total} (urencriterium ${d.hours.target}). Zakelijke km privéauto: ${d.km.km} km = ${euro(d.km.amount)}.`,
    `Bedragen/tarieven van ${d.rulesYear}${d.rulesChecked ? '' : ' (tabel in de app nog niet door een fiscalist gecontroleerd)'}.`,
    'Niet meegenomen: partner, andere inkomsten, box 2/3, willekeurige afschrijving, EIA/MIA/Vamil.',
  ];
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    alert('Gekopieerd. Plak het in een e-mail aan je boekhouder of accountant.');
  } catch {
    alert('Kopiëren lukte niet.');
  }
}

const euro = (cents: number) => `${cents < 0 ? '− ' : ''}€ ${(Math.abs(cents) / 100).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Overview({ year }: { year: number }) {
  const o = useLoad(() => api.incomeTax.overview(year), [year]);
  if (!o.data) return <ErrorBox error={o.error} />;
  const d = o.data;
  const b = d.breakdown;
  const shown = d.items.filter((i) => i.amount !== null && !i.forAccountant);
  const hiddenTotal = d.items.filter((i) => i.amount !== null && i.forAccountant).reduce((t, i) => t + i.amount!, 0);
  const notes = d.items.filter((i) => i.note || i.forAccountant);
  return (
    <>
      <div className="row between">
        <p className="muted small" style={{ margin: 0 }}>{d.disclaimer}</p>
        <Button small onClick={() => void copyForAccountant(d)}>📋 Kopieer voor je boekhouder</Button>
      </div>
      {d.running && <p className="muted small">{year} is nog niet voorbij: dit zijn de bedragen tot en met vandaag.</p>}
      <div className="card">
        <table className="sumtable">
          <tbody>
            {shown.map((i) => (
              <tr key={i.key}>
                <td>
                  {i.label}
                  <div className="small muted">{i.explain}</div>
                </td>
                <td className="num">{i.amount! > 0 && i.key !== 'winst' ? '+ ' : ''}{euro(i.amount!)}</td>
              </tr>
            ))}
            {hiddenTotal !== 0 && (
              <tr>
                <td>Overige correcties<div className="small muted">Staat in de notities voor je boekhouder.</div></td>
                <td className="num">{hiddenTotal > 0 ? '+ ' : ''}{euro(hiddenTotal)}</td>
              </tr>
            )}
            <tr className="total"><td>{b.taxableProfit < 0 ? 'Verlies (schatting)' : 'Winst waarover je belasting betaalt (schatting)'}</td><td className="num">{b.taxableProfit < 0 ? '− ' : ''}€ {Math.abs(b.taxableProfit).toLocaleString('nl-NL')}</td></tr>
          </tbody>
        </table>
      </div>
      {d.items.filter((i) => i.amount === null && !i.forAccountant).map((i) => (
        <div key={i.key} className={`notice ${i.status === 'warn' ? 'warn' : ''}`}>
          <strong>{i.label}</strong>
          <div className="small">{i.explain}</div>
        </div>
      ))}
      <details style={{ marginTop: 12 }}>
        <summary className="small">📎 Notities voor je boekhouder ({notes.length})</summary>
        <p className="small muted">Hier staan de vaktermen en details. Jij hoeft hier niets mee; ze gaan mee met "Kopieer voor je boekhouder".</p>
        <ul className="small">
          {notes.map((i) => <li key={i.key}><strong>{i.label}</strong>{i.amount !== null ? ` (${euro(i.amount)})` : ''}: {i.note ?? i.explain}</li>)}
        </ul>
      </details>
      <div className="hero" style={{ marginTop: 14 }}>
        <div className="card">
          <div className="value">{d.hours.total.toLocaleString('nl-NL')} uur</div>
          <div className="label">gewerkt{d.running ? `, op weg naar ± ${d.hours.projected.toLocaleString('nl-NL')}` : ''} · nodig voor de aftrek: {d.hours.target.toLocaleString('nl-NL')}</div>
        </div>
        <div className="card">
          <div className="value">{d.km.km.toLocaleString('nl-NL')} km</div>
          <div className="label">zakelijk met je eigen auto · {euro(d.km.amount)} aftrek</div>
        </div>
        <div className="card">
          <div className="value">€ {b.total.toLocaleString('nl-NL')}</div>
          <div className="label">inkomstenbelasting en zorgpremie (Zvw) over deze winst · schatting</div>
        </div>
      </div>
      <p className="muted small">
        Alleen je bedrijf telt mee. Je partner, je huis, ander inkomen en spaargeld niet: die neemt je boekhouder mee.
      </p>
    </>
  );
}

function Assets() {
  const { toast } = useApp();
  const list = useLoad(() => api.assets.list());
  const credits = useLoad(() => api.assets.unassignedCredits());
  const { run, busy } = useAction();
  const [editing, setEditing] = useState<AssetItem | null>(null);
  const [selling, setSelling] = useState<AssetItem | null>(null);
  if (!list.data) return <ErrorBox error={list.error} />;
  const bookDue = async () => {
    const r = await run(() => api.assets.bookDue());
    if (r) {
      toast(r.years.length ? `Kosten van je investeringen bijgewerkt voor ${r.years.join(', ')}` : 'Alles is al bijgewerkt');
      await list.reload();
    }
  };
  return (
    <>
      <p className="muted">
        Alles vanaf € 450 (zonder btw) dat je jaren gebruikt, zoals een bus, steigers, een machine of laptop. De kosten tellen verdeeld over minstens 5 jaar (dat heet afschrijven).
        Dat doet de app elk jaar zelf. Kies je bij een aankoop "Investering (vanaf € 450, gaat jaren mee)", dan komt het hier vanzelf bij.
      </p>
      <ErrorBox error={credits.error} />
      {(credits.data ?? []).map(c => <div className="card" key={c.lineId}>
        <strong>Bij welke investering hoort deze creditnota?</strong>
        <p>{c.name} · <DateNl date={c.date} /> · <Euro cents={c.amount} /></p>
        <p className="small muted">De credit staat al in je boekhouding. Kies het bedrijfsmiddel om ook de kostprijs en afschrijving bij te werken.</p>
        {c.candidates.length ? <div className="row">{c.candidates.map(a => <Button key={a.id} small disabled={busy} onClick={async () => {
          if (await run(async () => { await api.assets.allocateCredit(c.lineId, a.id); return true; }, 'Creditnota gekoppeld')) { await list.reload(); await credits.reload(); }
        }}>{a.name}</Button>)}</div> : <p>Er is geen passend bedrijfsmiddel. Controleer de categorie en leverancier van de creditnota bij Aankopen.</p>}
      </div>)}
      <KiaProgress assets={list.data} />
      {list.data.length === 0 ? (
        <Empty icon="🧰" title="Nog geen investeringen">Kies bij een aankoop "Investering (vanaf € 450, gaat jaren mee)".</Empty>
      ) : (
        <table className="list">
          <thead>
            <tr><th>Wat</th><th>Gekocht</th><th className="num">Kostte</th><th className="num">Kosten per jaar</th><th className="num" title="wat je betaalde, min wat al als kosten is geteld">Waarde nu</th><th><span className="sr-only">Acties</span></th></tr>
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
                      De jaren tot en met {a.booked_elsewhere_until} heeft je boekhouder al gedaan (niet in de app).{' '}
                      <span className="clickable" onClick={async () => { if (await run(() => api.assets.update(a.id, { bookInApp: true }), 'De app houdt ook de eerdere jaren bij') !== undefined) await list.reload(); }}>Toch in de app bijhouden</span>
                    </div>
                  )}
                  {a.belowThreshold && <div className="small muted">onder € 450: had ook direct als kosten gekund</div>}
                  {a.energyHint && <div className="small" style={{ color: 'var(--warn)' }}>Misschien extra aftrek voor zuinige of milieuvriendelijke apparaten. Vraag je boekhouder vóór <DateNl date={a.energyHint.deadline} /></div>}
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
        <Button small disabled={busy} onClick={() => void bookDue()}>Kosten van vorige jaren bijwerken</Button>
      </div>
      {editing && <EditAsset asset={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void list.reload(); }} />}
      {selling && <SellAsset asset={selling} onClose={() => setSelling(null)} onSaved={() => { setSelling(null); void list.reload(); }} />}
    </>
  );
}

/** Alleen informatie, nooit een aansporing om iets te kopen. */
function KiaProgress({ assets }: { assets: AssetItem[] }) {
  const year = new Date().getFullYear();
  const { rules } = rulesFor(year);
  const total = assets.filter((a) => a.acquired_on.startsWith(String(year)) && !a.kia_excluded && !a.belowThreshold).reduce((t, a) => t + a.cost, 0);
  if (total === 0) return null;
  const kia = kiaFor(total / 100, rules.kia);
  return (
    <div className="card small" style={{ marginBottom: 12 }}>
      <strong>Investeringen {year}: <Euro cents={total} /></strong>
      {kia > 0
        ? <> · extra aftrek (KIA) ± € {kia.toLocaleString('nl-NL')}</>
        : total / 100 > rules.kia.phaseOutUpTo
          ? <> · boven € {rules.kia.phaseOutUpTo.toLocaleString('nl-NL')} per jaar is er geen extra aftrek (KIA) meer.</>
          : <> · extra aftrek (KIA) krijg je vanaf € {rules.kia.min.toLocaleString('nl-NL')} per jaar; wat je dit jaar nog koopt, telt mee.</>}
    </div>
  );
}

function EditAsset({ asset, onClose, onSaved }: { asset: AssetItem; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [name, setName] = useState(asset.name);
  const [years, setYears] = useState(String(asset.lifetime_months / 12));
  const [residual, setResidual] = useState<number | null>(asset.residual);
  const [car, setCar] = useState(!!asset.kia_excluded);
  const [inUseOn, setInUseOn] = useState(asset.in_use_on ?? asset.acquired_on);
  const canMoveStart = asset.booked === 0;
  const save = async () => {
    const r = await run(
      () => api.assets.update(asset.id, { name, lifetimeMonths: Math.round(Number(years.replace(',', '.')) * 12), residual: residual ?? 0, kiaExcluded: car, ...(canMoveStart && inUseOn !== (asset.in_use_on ?? asset.acquired_on) ? { inUseOn } : {}) }),
      'Opgeslagen',
    );
    if (r) onSaved();
  };
  return (
    <Modal title="Investering aanpassen" onClose={onClose}>
      <div className="grid">
        <Field label="Naam"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid cols-2">
          <Field label="Hoeveel jaar gebruik je het?" hint="minstens 5"><input value={years} onChange={(e) => setYears(e.target.value)} inputMode="decimal" /></Field>
          <Field label="Wat is het daarna nog waard?" hint="meestal € 0"><MoneyInput value={residual} onChange={setResidual} /></Field>
        </div>
        {canMoveStart && (
          <Field label="Sinds wanneer gebruik je het?" hint="later dan de aankoop? Dan beginnen de kosten per jaar pas vanaf die datum">
            <input type="date" value={inUseOn} min={asset.acquired_on} onChange={(e) => setInUseOn(e.target.value)} />
          </Field>
        )}
        <label className="row small"><input type="checkbox" checked={car} onChange={(e) => setCar(e.target.checked)} /> Dit is een personenauto (daarvoor krijg je geen extra aftrek)</label>
        <p className="small muted">Wat al als kosten is geteld, blijft staan. De wijziging geldt voor de jaren die nog komen.</p>
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
  const [kind, setKind] = useState<'verkocht' | 'prive'>('verkocht');
  const save = async () => {
    const r = await run(() => api.assets.dispose(asset.id, date, price ?? 0, kind), 'Verwerkt');
    if (r) onSaved();
  };
  return (
    <Modal title={`${asset.name} verkocht of weggedaan`} onClose={onClose}>
      <div className="grid">
        <div className="chips">
          <button className={kind === 'verkocht' ? 'selected' : ''} onClick={() => setKind('verkocht')}>Verkocht of weggegooid</button>
          <button className={kind === 'prive' ? 'selected' : ''} onClick={() => setKind('prive')}>Ik gebruik het voortaan privé</button>
        </div>
        <div className="grid cols-2">
          <Field label="Datum"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          {kind === 'verkocht'
            ? <Field label="Verkoopprijs excl. btw" hint="0 als je het weggooit"><MoneyInput value={price} onChange={setPrice} /></Field>
            : <Field label="Wat is het nu waard?" hint="wat je er bij verkoop voor zou krijgen"><MoneyInput value={price} onChange={setPrice} /></Field>}
        </div>
        <p className="small muted">
          {kind === 'verkocht'
            ? 'De app telt de kosten tot de verkoopdatum en haalt het uit je lijst. Heb je het verkocht? Maak dan ook een gewone factuur voor de koper (met btw): die zorgt voor de opbrengst.'
            : 'Neem je het mee naar privé, dan telt dat voor de belasting als verkoop tegen wat het nu waard is. Heb je bij aankoop btw teruggekregen? Dan moet je over de waarde misschien btw betalen: vraag je boekhouder.'}{' '}
          Binnen 5 jaar na aankoop moet je misschien een deel van de extra aftrek terugbetalen. De app rekent dat uit en zet het in de notities voor je boekhouder.
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
          <thead><tr><th>Datum</th><th>Rit</th><th className="num">Km</th><th className="num">Aftrek</th><th><span className="sr-only">Acties</span></th></tr></thead>
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

const PERIOD_LABEL = { dag: 'Dag', week: 'Week', maand: 'Maand' } as const;

/** "Week 41 (5–11 okt)", "oktober 2026" of de dag zelf. */
function periodText(start: string, end: string | null): string {
  if (!end || end === start) return formatDateNl(start);
  const first = Number(start.slice(8));
  const month = (d: string) => formatDateNl(d).split(' ')[1];
  if (start.slice(8) === '01' && end === monthOf(start).end) return `${month(start)} ${start.slice(0, 4)}`;
  return `Week ${isoWeek(start)} (${first} ${start.slice(5, 7) === end.slice(5, 7) ? '' : `${month(start)} `}–${Number(end.slice(8))} ${month(end)})`;
}

function Hours({ year }: { year: number }) {
  const totals = useLoad(() => api.hours.totals(year), [year]);
  const list = useLoad(() => api.hours.list(year), [year]);
  const forecast = useLoad(() => api.hours.forecast(year), [year]);
  const { run, busy } = useAction();
  const [period, setPeriod] = useState<HoursPeriod>('dag');
  const [date, setDate] = useState(today());
  const [hours, setHours] = useState('');
  const [what, setWhat] = useState('');
  const [repeat, setRepeat] = useState(false);
  const [until, setUntil] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [info, setInfo] = useState('');
  const n = Number(hours.replace(',', '.'));
  const input = { date, hours: n, description: what, period, ...(repeat && until ? { repeatUntil: until } : {}) };
  useEffect(() => {
    setWarnings([]);
    setInfo('');
    if (!(n > 0) || !isIsoDate(date)) return;
    let stale = false;
    api.hours.check(input).then(
      (r) => { if (!stale) { setWarnings(r.warnings); setInfo(r.regels > 1 ? `Dit maakt ${r.regels} regels.` : ''); } },
      (e: unknown) => { if (!stale) setInfo(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') : ''); },
    );
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, date, hours, repeat, until]);
  const reload = async () => {
    await totals.reload();
    await list.reload();
    await forecast.reload();
  };
  const add = async () => {
    const r = await run(() => api.hours.add(input), 'Uren toegevoegd');
    if (r) {
      setHours('');
      setWhat('');
      await reload();
    }
  };
  const t = totals.data;
  const f = forecast.data;
  const range = !isIsoDate(date) ? null : period === 'week' ? weekOf(date) : period === 'maand' ? monthOf(date) : null;
  const hint = {
    dag: 'Wat je op die dag werkte.',
    week: 'Het totaal over de hele week (maandag t/m zondag).',
    maand: 'Het totaal over de hele maand.',
  }[period];
  return (
    <>
      <p className="muted">
        Voor de zelfstandigenaftrek (en startersaftrek) moet je minstens 1.225 uur per jaar aan je bedrijf werken. Uren op de werkbonnen van je klussen tellen vanzelf mee.
        Vul hier de rest in: offertes maken, administratie, inkopen, reistijd, of gewoon al je werk, per dag, per week of per maand.
      </p>
      {t && (
        <div className="card">
          <strong>{t.total.toLocaleString('nl-NL')} uur</strong> in {year} · {t.workOrders.toLocaleString('nl-NL')} op werkbonnen, {t.other.toLocaleString('nl-NL')} apart
          <div className="progress" style={{ marginTop: 8, height: 8, background: 'var(--surface-2)', borderRadius: 99 }}>
            <div style={{ width: `${Math.min(100, (t.total / 1225) * 100)}%`, height: '100%', background: t.total >= 1225 ? 'var(--good)' : 'var(--primary)', borderRadius: 99 }} />
          </div>
          {f && (
            <p className="muted" style={{ margin: '8px 0 0' }}>
              {f.remaining === 0
                ? `Je hebt de ${f.target.toLocaleString('nl-NL')} uur gehaald.`
                : `Nog ${f.remaining.toLocaleString('nl-NL')} uur voor de ${f.target.toLocaleString('nl-NL')}: dat is ${f.perWeekNeeded.toLocaleString('nl-NL')} uur per week tot 31 december.` +
                  (f.planned > 0 ? ` Daarnaast staat er ${f.planned.toLocaleString('nl-NL')} uur gepland.` : '') +
                  (f.reachDate ? ` Op je tempo tot nu toe (${f.perWeekNow.toLocaleString('nl-NL')} uur per week) haal je het op ${formatDateNl(f.reachDate)}.` : f.perWeekNow > 0 ? ` Op je tempo tot nu toe (${f.perWeekNow.toLocaleString('nl-NL')} uur per week) haal je het dit jaar niet.` : '')}
            </p>
          )}
        </div>
      )}
      <div className="card" style={{ marginTop: 12 }}>
        <div className="chips" style={{ marginBottom: 12 }} role="group" aria-label="Periode">
          {(Object.keys(PERIOD_LABEL) as HoursPeriod[]).map((p) => (
            <button key={p} className={period === p ? 'selected' : ''} onClick={() => setPeriod(p)}>Per {PERIOD_LABEL[p].toLowerCase()}</button>
          ))}
        </div>
        <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {period === 'maand' ? (
            <Field label="Maand"><input type="month" value={date.slice(0, 7)} onChange={(e) => e.target.value && setDate(`${e.target.value}-01`)} /></Field>
          ) : (
            <Field label={period === 'week' ? 'Een dag in de week' : 'Datum'}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          )}
          <Field label={period === 'dag' ? 'Uren' : 'Uren in totaal'}><input value={hours} onChange={(e) => setHours(e.target.value)} inputMode="decimal" style={{ width: 110 }} /></Field>
          <div style={{ flex: 1, minWidth: 200 }}><Field label="Wat heb je gedaan?"><input value={what} onChange={(e) => setWhat(e.target.value)} placeholder={period === 'dag' ? 'bv. offertes en administratie' : 'bv. ontwikkeling van mijn producten, offertes, administratie'} /></Field></div>
          <Button kind="primary" disabled={busy || !hours || !what || (repeat && !until)} onClick={() => void add()}>Toevoegen</Button>
        </div>
        <p className="muted" style={{ margin: '8px 0 0' }}>
          {hint}
          {range && <> Je kiest: {periodText(range.start, range.end)}.</>}
          {period !== 'dag' && ' Een globale omschrijving is genoeg; schrijf op waar je tijd naartoe ging.'}
        </p>
        <label className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
          <span>Herhaal {period === 'dag' ? 'op elke werkdag' : period === 'week' ? 'elke week' : 'elke maand'} tot en met</span>
          <input type="date" value={until} disabled={!repeat} onChange={(e) => setUntil(e.target.value)} aria-label="Herhalen tot en met" />
        </label>
        {info && <p className="muted" style={{ margin: '8px 0 0' }}>{info}</p>}
        {warnings.map((w) => <p key={w} style={{ margin: '8px 0 0', color: 'var(--warn, #b45309)' }}>⚠️ {w}</p>)}
      </div>
      {(list.data ?? []).length > 0 && (
        <table className="list" style={{ marginTop: 12 }}>
          <tbody>
            {list.data!.map((h) => (
              <tr key={h.id}>
                <td>{periodText(h.entry_date, h.period_end)}</td>
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
