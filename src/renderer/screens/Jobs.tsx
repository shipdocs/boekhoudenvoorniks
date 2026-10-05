import { useState } from 'react';
import { api } from '../api';
import { Button, DateNl, Empty, ErrorBox, Euro, Field, Modal, MoneyInput, StatusPill, useAction, useApp, useLoad } from '../ui';
import type { JobCostItem, WorkItem } from '../../jobs/jobs';

export function Jobs() {
  const { go } = useApp();
  const [all, setAll] = useState(false);
  const jobs = useLoad(() => api.jobs.list(all ? {} : { active: true }), [all]);
  const [search, setSearch] = useState('');
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = (jobs.data ?? []).filter((j) => words.every((w) => [j.title, j.relation_name].join(' ').toLowerCase().includes(w)));
  const [creating, setCreating] = useState(false);
  return (
    <div className="page">
      <div className="row between">
        <div>
          <h1>Klussen</h1>
          <p className="sub">Van offerte tot factuur. Is het werk klaar? Dan maak je met één klik de factuur.</p>
        </div>
        <Button kind="primary" onClick={() => setCreating(true)}>+ Nieuwe klus</Button>
      </div>
      <div className="row" style={{ marginBottom: 12, gap: 12 }}>
        <input className="grow" type="search" aria-label="Zoek in klussen" placeholder="Zoek op klus of klant…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="row small muted">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Ook afgeronde klussen tonen
        </label>
      </div>
      <ErrorBox error={jobs.error} />
      {shown.length === 0 ? (
        words.length ? <Empty icon="🔍" title={`Geen klussen gevonden voor "${search.trim()}"`}>{all ? 'Probeer een ander woord.' : 'Zet "Ook afgeronde klussen tonen" aan om verder te zoeken.'}</Empty>
          : <Empty icon="🔨" title="Geen lopende klussen">Zodra een klant akkoord geeft op een offerte, verschijnt hier de klus.</Empty>
      ) : (
        <div className="grid cols-2">
          {shown.map((j) => (
            <div key={j.id} className="card clickable" onClick={() => go({ screen: 'klus', id: j.id })}>
              <div className="row between"><strong>{j.title}</strong><StatusPill status={j.status} /></div>
              <div className="muted">{j.relation_name}{j.address ? ` · ${j.address}` : ''}</div>
              <div className="row small" style={{ marginTop: 8 }}>
                {j.quoted > 0 && <span>Offerte <Euro cents={j.quoted} /></span>}
                {j.costs > 0 && <span className="muted">· materiaal <Euro cents={j.costs} /></span>}
              </div>
            </div>
          ))}
        </div>
      )}
      <EarningsPerJob />
      {creating && <NewJob onClose={() => setCreating(false)} onCreated={(id) => go({ screen: 'klus', id })} />}
    </div>
  );
}

/** "Wat verdien ik per klus?" (#32); met relationId als dossier per klant. */
export function EarningsPerJob({ relationId }: { relationId?: number } = {}) {
  const { go } = useApp();
  const results = useLoad(() => api.jobs.results(relationId ? { relationId } : {}), [relationId]);
  const rows = (results.data ?? []).filter((r) => r.invoiced > 0 || r.totalCosts > 0);
  if (rows.length === 0) return null;
  return (
    <>
      <h2>{relationId ? 'Klussen voor deze klant' : 'Wat verdien ik per klus?'}</h2>
      <table className="list">
        <thead><tr><th>Klus</th>{!relationId && <th>Klant</th>}<th className="num">Gefactureerd</th><th className="num">Kosten</th><th className="num">Verdiend</th><th className="num">% verdiend</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.jobId} className="clickable" onClick={() => go({ screen: 'klus', id: r.jobId })}>
              <td>{r.title}</td>
              {!relationId && <td>{r.relationName}</td>}
              <td className="num"><Euro cents={r.invoiced} /></td>
              <td className="num"><Euro cents={r.totalCosts} /></td>
              <td className="num"><strong><Euro cents={r.margin} /></strong></td>
              <td className="num">{r.marginPct !== null ? `${String(r.marginPct).replace('.', ',')}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** Kies bij welke klus een kostenpost hoort: algemeen, een lopende klus, een afgeronde klus, of zoek in alle. */
export function LinkJobModal({ title, current, onPick, onClose }: { title: string; current: number | null; onPick: (jobId: number | null) => void | Promise<void>; onClose: () => void }) {
  const jobs = useLoad(() => api.jobs.list());
  const [search, setSearch] = useState('');
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  const matching = (jobs.data ?? []).filter((j) => j.status !== 'geannuleerd' && words.every((w) => [j.title, j.relation_name].join(' ').toLowerCase().includes(w)));
  const running = matching.filter((j) => ['gepland', 'bezig', 'klaar'].includes(j.status));
  const done = matching.filter((j) => j.status === 'gefactureerd');
  const choose = (jobId: number | null) => { void onPick(jobId); };
  const button = (j: { id: number; title: string; relation_name: string }) => (
    <button key={j.id} disabled={j.id === current} onClick={() => choose(j.id)}>{j.relation_name} · {j.title}{j.id === current ? ' (nu)' : ''}</button>
  );
  return (
    <Modal title="Hoort bij klus" onClose={onClose}>
      <p className="muted">{title}</p>
      <input type="search" aria-label="Zoek een klus" placeholder="Zoek op klant of klus…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: '100%' }} />
      <div className="choice" style={{ marginTop: 10 }}>
        <button disabled={current === null} onClick={() => choose(null)}>Algemene bedrijfskosten{current === null ? ' (nu)' : ''}</button>
        {running.map(button)}
        {done.length > 0 && <div className="muted small" style={{ marginTop: 6 }}>Afgerond en gefactureerd</div>}
        {done.map(button)}
        {words.length > 0 && matching.length === 0 && <p className="muted small">Geen klus gevonden.</p>}
      </div>
    </Modal>
  );
}

/** Kosten aan deze klus (bonnen, inkoopfacturen, directe bankkosten), elk te verplaatsen of algemeen te maken. */
function JobCosts({ jobId, onChanged }: { jobId: number; onChanged: () => void }) {
  const { go } = useApp();
  const { run, busy } = useAction();
  const items = useLoad(() => api.jobs.costItems(jobId), [jobId]);
  const [moving, setMoving] = useState<JobCostItem | null>(null);
  const list = items.data ?? [];
  const link = async (item: JobCostItem, to: number | null) => {
    const ok = await run(async () => {
      if (item.purchaseId !== null) await api.jobs.linkPurchase(item.purchaseId, to);
      else if (item.bankTransactionId !== null) await api.jobs.linkBankTransaction(item.bankTransactionId, to);
      return true;
    }, to === null ? 'Kosten zijn nu algemeen ✓' : 'Kosten verplaatst ✓');
    if (ok) { setMoving(null); await items.reload(); onChanged(); }
  };
  if (list.length === 0) return null;
  return (
    <>
      <h2>Kosten aan deze klus</h2>
      <table className="list small">
        <tbody>
          {list.map((c, i) => (
            <tr key={`${c.kind}-${c.purchaseId ?? c.bankTransactionId ?? i}-${i}`}>
              <td><DateNl date={c.date} /></td>
              <td>{c.label}<div className="muted small">{c.kind === 'aankoop' ? 'Bon of inkoopfactuur' : c.kind === 'bank' ? 'Betaling van je bank' : 'Overig'}</div></td>
              <td className="num"><Euro cents={c.amount} /><div className="muted small">excl. btw</div></td>
              <td>
                <span className="row">
                  {c.kind === 'aankoop' && <Button small kind="ghost" onClick={() => go({ screen: 'aankopen' })}>Bekijken</Button>}
                  {c.kind !== 'overig' && <Button small kind="ghost" disabled={busy} onClick={() => setMoving(c)}>Naar andere klus</Button>}
                  {c.kind !== 'overig' && <Button small kind="ghost" disabled={busy} onClick={() => void link(c, null)}>Algemeen maken</Button>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {moving && <LinkJobModal title={`${moving.label}, ${'€ ' + (moving.amount / 100).toLocaleString('nl-NL', { minimumFractionDigits: 2 })} excl. btw`} current={jobId} onClose={() => setMoving(null)} onPick={(to) => link(moving, to)} />}
    </>
  );
}

function NewJob({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const relations = useLoad(() => api.relations.list({ type: 'klant' }));
  const { run, busy } = useAction();
  const [relationId, setRelationId] = useState<number>();
  const [title, setTitle] = useState('');
  return (
    <Modal title="Nieuwe klus" onClose={onClose}>
      <div className="grid">
        <Field label="Klant">
          <select value={relationId ?? ''} onChange={(e) => setRelationId(Number(e.target.value) || undefined)}>
            <option value="">Kies…</option>
            {(relations.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        <Field label="Wat ga je doen?"><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="bv. Badkamer stucen" /></Field>
      </div>
      <div className="row end" style={{ marginTop: 16 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={busy || !relationId || !title} onClick={async () => { const j = await run(() => api.jobs.create({ relationId: relationId!, title })); if (j) onCreated(j.id); }}>Aanmaken</Button>
      </div>
    </Modal>
  );
}

export function JobDetail({ id }: { id: number }) {
  const { go, settings } = useApp();
  const { run, busy } = useAction();
  const job = useLoad(() => api.jobs.get(id), [id]);
  const work = useLoad(() => api.jobs.workItems(id), [id]);
  const j = job.data;
  if (!j) return <div className="page"><ErrorBox error={job.error} /></div>;
  const openWork = (work.data ?? []).filter((w) => !w.invoice_id);
  const setStatus = async (s: 'gepland' | 'bezig' | 'klaar' | 'geannuleerd') => {
    await run(() => api.jobs.setStatus(id, s));
    await job.reload();
  };
  return (
    <div className="page-narrow">
      <div className="row between">
        <div>
          <h1>{j.title}</h1>
          <p className="sub">{j.relation_name}{j.address ? ` · ${j.address}` : ''} · <StatusPill status={j.status} /></p>
        </div>
        <Button kind="ghost" onClick={() => go({ screen: 'klussen' })}>← Klussen</Button>
      </div>

      {['gepland', 'bezig'].includes(j.status) && (
        <div className="card">
          <h3>Werk afgerond?</h3>
          <div className="row">
            {j.status === 'gepland' && <Button disabled={busy} onClick={() => void setStatus('bezig')}>Ik ben begonnen</Button>}
            <Button kind="primary" disabled={busy} onClick={() => void setStatus('klaar')}>✓ Werk is klaar</Button>
          </div>
        </div>
      )}
      {j.status === 'klaar' && (
        <div className="card">
          <h3>Het werk is klaar 🎉</h3>
          <p className="muted">{openWork.length ? 'De factuur wordt opgebouwd uit de werkbon. Je kunt hem nog aanpassen voor je hem verstuurt.' : j.quote_id ? 'De factuur wordt opgebouwd uit de offerte. Je kunt hem nog aanpassen voor je hem verstuurt.' : 'We maken een factuur voor deze klant.'}</p>
          <Button kind="primary" disabled={busy} onClick={async () => {
            // zonder offerte of werkbon: een concept met de klus als regel, zodat de factuur wél aan de klus hangt
            const inv = await run(() => (j.quote_id || openWork.length ? api.jobs.makeInvoice(id) : api.jobs.makeInvoice(id, [{ description: j.title, quantity: 1, unitPrice: 0, vatCode: settings.defaultVatCode }])));
            if (inv) go({ screen: 'factuur', id: inv.id });
          }}>Factuur maken</Button>
        </div>
      )}

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="card flat"><div className="muted small">Offerte</div><div className="big-number" style={{ fontSize: 22 }}><Euro cents={j.quoted} /></div>{j.quote_number && <a href="#" onClick={(e) => { e.preventDefault(); go({ screen: 'offerte', id: j.quote_id! }); }}>{j.quote_number}</a>}</div>
        <JobResultCard id={id} />
      </div>

      <WorkOrder jobId={id} items={work.data ?? []} onChanged={() => void work.reload()} readOnly={j.status === 'gefactureerd' || j.status === 'geannuleerd'} />

      <JobCosts jobId={id} onChanged={() => void job.reload()} />

      {j.invoices.length > 0 && (
        <>
          <h2>Facturen</h2>
          <table className="list">
            <tbody>
              {j.invoices.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => go({ screen: 'factuur', id: i.id })}>
                  <td>{i.number ?? 'concept'}</td>
                  <td><StatusPill status={i.status} /></td>
                  <td className="num"><Euro cents={i.total} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="small muted" style={{ marginTop: 18 }}>
        Bonnetjes en betalingen voor materiaal koppelen we aan de klus die loopt; je krijgt de vraag op Vandaag. Klopt een koppeling niet, dan verplaats je hem hierboven, of bij Aankopen. {j.start_date && <>Gestart <DateNl date={j.start_date} />.</>}
      </p>
      {j.status !== 'geannuleerd' && j.status !== 'gefactureerd' && <Button kind="ghost" small onClick={() => void setStatus('geannuleerd')}>Klus annuleren</Button>}
    </div>
  );
}

/** Klusresultaat in gewone taal (#32): gefactureerd, kosten per soort, verdiend. */
export function JobResultCard({ id }: { id: number }) {
  const r = useLoad(() => api.jobs.result(id), [id]).data;
  if (!r) return <div className="card flat" />;
  return (
    <div className="card flat">
      <table className="sumtable small">
        <tbody>
          <tr><td>Gefactureerd</td><td><Euro cents={r.invoiced} /></td></tr>
          {r.costs.map((c) => <tr key={c.label}><td>{c.label}</td><td>− <Euro cents={c.amount} /></td></tr>)}
          <tr className="total"><td>Verdiend</td><td><Euro cents={r.margin} />{r.marginPct !== null && <span className="muted"> ({String(r.marginPct).replace('.', ',')}%)</span>}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

/** Werkbon: uren en materiaal op de klus, die straks de factuurregels worden. */
function WorkOrder({ jobId, items, onChanged, readOnly = false }: { jobId: number; items: WorkItem[]; onChanged: () => void; readOnly?: boolean }) {
  const { run, busy } = useAction();
  const [desc, setDesc] = useState('');
  const [qty, setQty] = useState('1');
  const [unit, setUnit] = useState('uur');
  const [price, setPrice] = useState<number | null>(null);
  const [vat, setVat] = useState<'hoog' | 'laag'>('hoog');
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <h3 style={{ marginTop: 0 }}>Werkbon</h3>
      <p className="muted small">Houd hier je uren en materiaal bij. Bij "Factuur maken" worden dit de factuurregels.</p>
      {items.length > 0 && (
        <table className="list small">
          <tbody>
            {items.map((w) => (
              <tr key={w.id}>
                <td><DateNl date={w.work_date} /></td>
                <td>{w.description}</td>
                <td className="num">{w.quantity} {w.unit ?? ''}</td>
                <td className="num"><Euro cents={Math.round(w.quantity * w.unit_price)} /></td>
                <td>{w.invoice_id ? <span className="pill">gefactureerd</span> : readOnly ? null : <Button small kind="ghost" onClick={async () => { await run(() => api.jobs.removeWorkItem(w.id)); onChanged(); }}>✕</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!readOnly && <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
        <input placeholder="Wat? (bv. stucwerk plafond)" value={desc} onChange={(e) => setDesc(e.target.value)} style={{ flex: 2, minWidth: 180 }} />
        <input className="num" style={{ width: 70 }} value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Aantal" />
        <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Eenheid"><option>uur</option><option>m²</option><option>m</option><option>stuk</option></select>
        <div style={{ width: 120 }}><MoneyInput value={price} onChange={setPrice} /></div>
        <select value={vat} onChange={(e) => setVat(e.target.value as 'hoog' | 'laag')} aria-label="Btw"><option value="hoog">21%</option><option value="laag">9%</option></select>
        <Button disabled={busy || !desc.trim() || price === null || price < 0} onClick={async () => {
          const r = await run(() => api.jobs.addWorkItem(jobId, { date: new Date().toISOString().slice(0, 10), description: desc, quantity: Number(qty.replace(',', '.')), unit, unitPrice: price!, vatCode: vat }));
          if (r) { setDesc(''); setPrice(null); onChanged(); }
        }}>Toevoegen</Button>
      </div>}
    </div>
  );
}
