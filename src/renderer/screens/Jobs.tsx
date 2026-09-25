import { useState } from 'react';
import { api } from '../api';
import { Button, DateNl, Empty, ErrorBox, Euro, Field, Modal, StatusPill, useAction, useApp, useLoad } from '../ui';

export function Jobs() {
  const { go } = useApp();
  const [all, setAll] = useState(false);
  const jobs = useLoad(() => api.jobs.list(all ? {} : { active: true }), [all]);
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
      <label className="row small muted" style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Ook afgeronde klussen tonen
      </label>
      <ErrorBox error={jobs.error} />
      {(jobs.data ?? []).length === 0 ? (
        <Empty icon="🔨" title="Geen lopende klussen">Zodra een klant akkoord geeft op een offerte, verschijnt hier de klus.</Empty>
      ) : (
        <div className="grid cols-2">
          {jobs.data!.map((j) => (
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
      {creating && <NewJob onClose={() => setCreating(false)} onCreated={(id) => go({ screen: 'klus', id })} />}
    </div>
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
  const { go } = useApp();
  const { run, busy } = useAction();
  const job = useLoad(() => api.jobs.get(id), [id]);
  const j = job.data;
  if (!j) return <div className="page"><ErrorBox error={job.error} /></div>;
  const margin = j.invoiced - j.costs;
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
          <p className="muted">{j.quote_id ? 'De factuur wordt opgebouwd uit de offerte. Je kunt hem nog aanpassen voor je hem verstuurt.' : 'We maken een factuur voor deze klant.'}</p>
          <Button kind="primary" disabled={busy} onClick={async () => {
            if (j.quote_id) {
              const inv = await run(() => api.jobs.makeInvoice(id));
              if (inv) go({ screen: 'factuur', id: inv.id });
            } else go({ screen: 'factuur' });
          }}>Factuur maken</Button>
        </div>
      )}

      <div className="grid cols-3" style={{ marginTop: 14 }}>
        <div className="card flat"><div className="muted small">Offerte</div><div className="big-number" style={{ fontSize: 22 }}><Euro cents={j.quoted} /></div>{j.quote_number && <a href="#" onClick={(e) => { e.preventDefault(); go({ screen: 'offerte', id: j.quote_id! }); }}>{j.quote_number}</a>}</div>
        <div className="card flat"><div className="muted small">Materiaal & kosten</div><div className="big-number" style={{ fontSize: 22 }}><Euro cents={j.costs} /></div></div>
        <div className="card flat"><div className="muted small">Verdiend (gefactureerd − kosten)</div><div className="big-number" style={{ fontSize: 22 }}><Euro cents={j.invoiced ? margin : null} /></div></div>
      </div>

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
        Tip: koppel bonnetjes aan deze klus bij het invoeren van een aankoop, dan zie je wat je aan de klus verdient. {j.start_date && <>Gestart <DateNl date={j.start_date} />.</>}
      </p>
      {j.status !== 'geannuleerd' && j.status !== 'gefactureerd' && <Button kind="ghost" small onClick={() => void setStatus('geannuleerd')}>Klus annuleren</Button>}
    </div>
  );
}
