import { useState } from 'react';
import { api } from '../api';
import { Button, DateNl, ErrorBox, Euro, Field, Modal, MoneyInput, useAction, useLoad } from '../ui';
import { today } from '../../shared/dates';

type Tab = 'grootboek' | 'journaal' | 'rapport' | 'export' | 'leveranciers' | 'controle';

/** Expert-/boekhoudersmodus: alles wat in de normale modus verborgen blijft. */
export function Expert() {
  const [tab, setTab] = useState<Tab>('grootboek');
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  return (
    <div className="page">
      <h1>Boekhouding</h1>
      <p className="sub">Voor de boekhouder: grootboek (RGS), journaalposten, rapportages en exports.</p>
      <div className="row" style={{ marginBottom: 16 }}>
        <div className="chips">
          {(['grootboek', 'journaal', 'rapport', 'export', 'leveranciers', 'controle'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'selected' : ''} onClick={() => setTab(t)}>{{ grootboek: 'Grootboek', journaal: 'Journaal', rapport: 'W&V en balans', export: 'Exports', leveranciers: 'Leveranciersregels', controle: 'Controle' }[t]}</button>
          ))}
        </div>
        <span className="grow" />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Van" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Tot" />
      </div>
      {tab === 'grootboek' && <Ledger from={from} to={to} />}
      {tab === 'journaal' && <Journal from={from} to={to} />}
      {tab === 'rapport' && <Reports from={from} to={to} />}
      {tab === 'export' && <Exports from={from} to={to} />}
      {tab === 'leveranciers' && <SupplierRules />}
      {tab === 'controle' && <Integrity />}
    </div>
  );
}

function Ledger({ from, to }: { from: string; to: string }) {
  const b = useLoad(() => api.ledger.balances(from, to), [from, to]);
  return (
    <>
      <ErrorBox error={b.error} />
      <table className="list small">
        <thead><tr><th>Nr</th><th>RGS</th><th>Rekening</th><th>Categorie</th><th className="num">Debet</th><th className="num">Credit</th><th className="num">Saldo</th></tr></thead>
        <tbody>
          {(b.data ?? []).filter((x) => x.debit || x.credit).map((x) => (
            <tr key={x.account_id}><td>{x.code}</td><td title={x.rgs_code}>{x.rgs_ref ?? '—'}</td><td>{x.name}</td><td>{x.category}</td><td className="num"><Euro cents={x.debit} /></td><td className="num"><Euro cents={x.credit} /></td><td className="num"><Euro cents={x.balance} /></td></tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Journal({ from, to }: { from: string; to: string }) {
  const { run } = useAction();
  const entries = useLoad(() => api.ledger.entries({ from, to, limit: 300 }), [from, to]);
  const [manual, setManual] = useState(false);
  return (
    <>
      <div className="row end" style={{ marginBottom: 10 }}><Button onClick={() => setManual(true)}>Correctieboeking</Button></div>
      <ErrorBox error={entries.error} />
      {(entries.data ?? []).map((e) => (
        <div key={e.id} className="card flat" style={{ marginBottom: 8, padding: '10px 14px', opacity: e.status === 'teruggedraaid' ? 0.6 : 1 }}>
          <div className="row between small">
            <span><strong>#{e.id}</strong> <DateNl date={e.entry_date} /> · {e.description} <span className="pill">{e.source}</span> {e.status === 'teruggedraaid' && <span className="pill warn">teruggedraaid</span>}{e.reverses_entry_id && <span className="pill">correctie op #{e.reverses_entry_id}</span>}</span>
            {e.status === 'definitief' && !e.reverses_entry_id && e.source === 'handmatig' && <Button small kind="ghost" onClick={async () => { if (confirm('Tegenboeking maken?')) { await run(() => api.ledger.reverse(e.id, today()), 'Tegenboeking gemaakt'); await entries.reload(); } }}>Terugdraaien</Button>}
          </div>
          <Origin entryId={e.id} />
          <table style={{ width: '100%' }} className="small">
            <tbody>
              {e.lines.map((l) => (
                <tr key={l.id}><td style={{ width: 70 }}>{l.account_code}</td><td>{l.account_name}{l.vat_code ? <span className="muted"> · btw {l.vat_code}</span> : ''}</td><td className="num" style={{ width: 110 }}>{l.debit ? <Euro cents={l.debit} /> : ''}</td><td className="num" style={{ width: 110 }}>{l.credit ? <Euro cents={l.credit} /> : ''}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {manual && <ManualEntry onClose={() => setManual(false)} onDone={async () => { setManual(false); await entries.reload(); }} />}
    </>
  );
}

function ManualEntry({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const accounts = useLoad(() => api.ledger.accounts());
  const { run, busy } = useAction();
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<{ account: string; debit: number | null; credit: number | null }[]>([{ account: '', debit: null, credit: null }, { account: '', debit: null, credit: null }]);
  const d = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const c = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  return (
    <Modal title="Correctieboeking (memoriaal)" wide onClose={onClose}>
      <div className="grid cols-2">
        <Field label="Datum"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Omschrijving"><input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      </div>
      <table style={{ width: '100%', marginTop: 12 }}>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td><select value={l.account} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, account: e.target.value } : x)))}><option value="">Rekening…</option>{(accounts.data ?? []).map((a) => <option key={a.id} value={a.rgs_code}>{a.code} {a.name}</option>)}</select></td>
              <td><MoneyInput value={l.debit} placeholder="debet" onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, debit: v } : x)))} /></td>
              <td><MoneyInput value={l.credit} placeholder="credit" onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, credit: v } : x)))} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row between" style={{ marginTop: 10 }}>
        <Button small onClick={() => setLines([...lines, { account: '', debit: null, credit: null }])}>+ Regel</Button>
        <span className={d === c ? 'pill good' : 'pill bad'}>Debet <Euro cents={d} /> · Credit <Euro cents={c} /></span>
      </div>
      <div className="row end" style={{ marginTop: 14 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={busy || d !== c || d === 0 || !description} onClick={async () => {
          const r = await run(() => api.ledger.manualEntry({ date, description, lines: lines.filter((l) => l.account && (l.debit || l.credit)).map((l) => ({ account: l.account, debit: l.debit ?? undefined, credit: l.credit ?? undefined })) }), 'Geboekt');
          if (r !== undefined) onDone();
        }}>Boeken</Button>
      </div>
    </Modal>
  );
}

function Reports({ from, to }: { from: string; to: string }) {
  const r = useLoad(() => api.dashboard.reports(from, to), [from, to]);
  if (!r.data) return <ErrorBox error={r.error} />;
  const x = r.data;
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>Winst- en verliesrekening</h3>
        <table className="sumtable small" style={{ maxWidth: 'none' }}>
          <tbody>
            {x.pnl.filter((b) => b.balance).map((b) => <tr key={b.account_id}><td>{b.name}</td><td><Euro cents={-b.balance} /></td></tr>)}
            <tr className="total"><td>Resultaat</td><td><Euro cents={x.profit} /></td></tr>
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>Balans per {to}</h3>
        <table className="sumtable small" style={{ maxWidth: 'none' }}>
          <tbody>
            {x.balance.filter((b) => b.balance).map((b) => <tr key={b.account_id}><td>{b.name} <span className="muted">({b.category})</span></td><td><Euro cents={b.balance} /></td></tr>)}
          </tbody>
        </table>
        <p className="small muted">Positief = debet (bezittingen), negatief = credit (schulden/eigen vermogen). Het resultaat van het lopende jaar staat nog op de W&V.</p>
      </div>
    </div>
  );
}

function Exports({ from, to }: { from: string; to: string }) {
  const { run, busy } = useAction();
  return (
    <div className="card grid">
      <p>Exports voor je boekhouder of accountant. Het grootboekschema volgt RGS, zodat elk boekhoudpakket het kan inlezen.</p>
      <div className="row">
        <Button disabled={busy} onClick={() => void run(() => api.exports.auditfile(from, to), 'Auditfile opgeslagen')}>Auditfile (XAF 3.2)</Button>
        <Button disabled={busy} onClick={() => void run(() => api.exports.journal(from, to), 'Opgeslagen')}>Journaal (CSV)</Button>
        <Button disabled={busy} onClick={() => void run(() => api.exports.trialBalance(from, to), 'Opgeslagen')}>Saldibalans (CSV)</Button>
      </div>
    </div>
  );
}

function SupplierRules() {
  const { run } = useAction();
  const rules = useLoad(() => api.documents.suppliers());
  const stats = useLoad(() => api.home.decisionStats());
  return (
    <>
      <p className="muted">Wat de app heeft geleerd van je bevestigingen. Na 3 gelijke bevestigingen vragen we of een leverancier voortaan automatisch mag. Alleen na jouw ja gebeurt dat.</p>
      <table className="list small">
        <thead><tr><th>Leverancier</th><th>Categorie</th><th>BTW</th><th>Zakelijk</th><th className="num">Bevestigd</th><th>Verwerking</th><th /></tr></thead>
        <tbody>
          {(rules.data ?? []).map((r) => (
            <tr key={r.supplier_key}><td>{r.display_name}</td><td>{r.category_key}</td><td>{r.vat_code}</td><td>{r.business ? 'ja' : 'privé'}</td><td className="num">{r.confirmations}×</td><td>{r.auto_approved === 1 ? 'automatisch' : r.auto_approved === -1 ? 'altijd vragen' : 'vragen'}</td><td>{r.auto_approved === 1 ? <Button small kind="ghost" onClick={async () => { await run(() => api.documents.setSupplierAutomatic(r.supplier_key, false)); await rules.reload(); }}>Weer vragen</Button> : null}<Button small kind="ghost" onClick={async () => { await run(() => api.documents.forgetSupplier(r.supplier_key)); await rules.reload(); }}>Vergeten</Button></td></tr>
          ))}
        </tbody>
      </table>
      <h3>Hoe vaak klopte het automatisch?</h3>
      <p className="muted small">Per soort beslissing: hoe vaak de app het zelf deed en hoe vaak jij "Klopt niet" koos. Basis om drempels bij te stellen.</p>
      <table className="list small">
        <thead><tr><th>Beslissing</th><th className="num">Automatisch</th><th className="num">Gecorrigeerd</th></tr></thead>
        <tbody>
          {(stats.data ?? []).map((x) => <tr key={x.kind}><td>{x.kind}</td><td className="num">{x.automatic}</td><td className="num">{x.corrected}</td></tr>)}
        </tbody>
      </table>
    </>
  );
}

function Integrity() {
  const r = useLoad(() => api.ledger.integrity());
  if (!r.data) return <ErrorBox error={r.error} />;
  return (
    <div className={`notice ${r.data.balanced ? 'good' : 'bad'}`}>
      {r.data.balanced ? '✓ Alle journaalposten zijn in balans.' : `Let op: ${r.data.unbalancedEntries.length} journaalposten zijn niet in balans.`} Totaal debet <Euro cents={r.data.totalDebit} />, credit <Euro cents={r.data.totalCredit} />.
    </div>
  );
}

const EVIDENCE_LABEL: Record<string, string> = { document: 'document', bank: 'banktransactie', factuur: 'factuur', inkoop: 'inkoop', antwoord: 'jouw antwoord', bron: 'bron' };

/** Herkomst van een post: de gebeurtenis, de regelversie en het bewijs (#19). */
function Origin({ entryId }: { entryId: number }) {
  const [open, setOpen] = useState(false);
  const origin = useLoad(async () => (open ? api.ledger.origin(entryId) : null), [open, entryId]);
  const o = origin.data;
  return (
    <div className="small">
      <button className="linklike" onClick={() => setOpen(!open)}>Herkomst</button>
      {open && o && (
        <div className="muted">
          Gebeurtenis #{o.id} ({o.type}{o.status === 'vervangen' ? ', vervangen' : ''}), regels {o.rules_version}
          {o.supersedes_event_id ? `, vervangt #${o.supersedes_event_id}` : ''} · bewijs:{' '}
          {o.evidence.length ? o.evidence.map((x) => `${EVIDENCE_LABEL[x.kind] ?? x.kind}${x.refId ? ` #${x.refId}` : ''}${x.note && x.kind === 'antwoord' ? ` ("${x.note}")` : ''}`).join(', ') : 'geen'}
        </div>
      )}
    </div>
  );
}
