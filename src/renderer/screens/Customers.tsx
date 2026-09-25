import { useState } from 'react';
import { api } from '../api';
import { Button, Empty, ErrorBox, Field, Modal, useAction, useApp, useLoad } from '../ui';
import type { Relation, RelationInput } from '../../relations/relations';

export function Customers() {
  const { go } = useApp();
  const [type, setType] = useState<'klant' | 'leverancier'>('klant');
  const [search, setSearch] = useState('');
  const list = useLoad(() => api.relations.list({ type, search: search || undefined }), [type, search]);
  return (
    <div className="page">
      <div className="row between">
        <div>
          <h1>Klanten</h1>
          <p className="sub">Voor wie je werkt — en bij wie je inkoopt.</p>
        </div>
        <Button kind="primary" onClick={() => go({ screen: 'klant' })}>+ Nieuwe klant</Button>
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="chips">
          <button className={type === 'klant' ? 'selected' : ''} onClick={() => setType('klant')}>Klanten</button>
          <button className={type === 'leverancier' ? 'selected' : ''} onClick={() => setType('leverancier')}>Leveranciers</button>
        </div>
        <input className="grow" placeholder="Zoeken…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <ErrorBox error={list.error} />
      {(list.data ?? []).length === 0 ? (
        <Empty icon="👤" title={type === 'klant' ? 'Nog geen klanten' : 'Nog geen leveranciers'}>{type === 'leverancier' ? 'Leveranciers worden automatisch aangemaakt als je bonnetjes invoert.' : 'Voeg je eerste klant toe.'}</Empty>
      ) : (
        <table className="list">
          <thead><tr><th>Naam</th><th>Plaats</th><th>E-mail</th><th>Telefoon</th></tr></thead>
          <tbody>
            {list.data!.map((r) => (
              <tr key={r.id} className="clickable" onClick={() => go({ screen: 'klant', id: r.id })}>
                <td>{r.name}</td><td>{r.city}</td><td>{r.email}</td><td>{r.phone}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const EMPTY: RelationInput = { name: '', type: 'klant', email: '', phone: '', address: '', postcode: '', city: '', vat_number: '', kvk_number: '', iban: '', contact_name: '', notes: '' };

export function CustomerDetail({ id }: { id?: number }) {
  const { go } = useApp();
  const { run, busy } = useAction();
  const existing = useLoad(async () => (id ? api.relations.get(id) : null), [id]);
  const invoices = useLoad(async () => (id ? api.invoices.list({ relationId: id }) : []), [id]);
  const [form, setForm] = useState<RelationInput | null>(null);
  const r: RelationInput = form ?? (existing.data ? (existing.data as RelationInput) : id ? EMPTY : EMPTY);
  if (id && !existing.data) return <div className="page"><ErrorBox error={existing.error} /></div>;
  const set = (patch: Partial<RelationInput>) => setForm({ ...r, ...patch });
  const open = (invoices.data ?? []).reduce((s, i) => s + (i.open_amount > 0 ? i.open_amount : 0), 0);
  return (
    <div className="page-narrow">
      <div className="row between">
        <h1>{id ? r.name : 'Nieuwe klant'}</h1>
        <Button kind="ghost" onClick={() => go({ screen: 'klanten' })}>← Klanten</Button>
      </div>
      {id && open > 0 && <div className="notice warn">Moet nog {new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(open / 100)} betalen.</div>}
      <div className="card grid">
        <div className="grid cols-2">
          <Field label="Naam"><input value={r.name} onChange={(e) => set({ name: e.target.value })} autoFocus={!id} /></Field>
          <Field label="Soort">
            <select value={r.type} onChange={(e) => set({ type: e.target.value as RelationInput['type'] })}>
              <option value="klant">Klant</option><option value="leverancier">Leverancier</option><option value="beide">Allebei</option>
            </select>
          </Field>
        </div>
        <Field label="Adres"><input value={r.address ?? ''} onChange={(e) => set({ address: e.target.value })} /></Field>
        <div className="grid cols-2">
          <Field label="Postcode"><input value={r.postcode ?? ''} onChange={(e) => set({ postcode: e.target.value })} /></Field>
          <Field label="Plaats"><input value={r.city ?? ''} onChange={(e) => set({ city: e.target.value })} /></Field>
        </div>
        <div className="grid cols-2">
          <Field label="E-mail"><input type="email" value={r.email ?? ''} onChange={(e) => set({ email: e.target.value })} /></Field>
          <Field label="Telefoon"><input value={r.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} /></Field>
        </div>
        <details>
          <summary className="muted">Zakelijke klant (btw-nummer, KvK, contactpersoon)</summary>
          <div className="grid cols-2" style={{ marginTop: 10 }}>
            <Field label="Contactpersoon"><input value={r.contact_name ?? ''} onChange={(e) => set({ contact_name: e.target.value })} /></Field>
            <Field label="Btw-nummer" hint="nodig bij BTW verlegd"><input value={r.vat_number ?? ''} onChange={(e) => set({ vat_number: e.target.value })} /></Field>
            <Field label="KvK-nummer"><input value={r.kvk_number ?? ''} onChange={(e) => set({ kvk_number: e.target.value })} /></Field>
            <Field label="IBAN"><input value={r.iban ?? ''} onChange={(e) => set({ iban: e.target.value })} /></Field>
            <Field label="Eigen betaaltermijn (dagen)"><input className="num" value={r.payment_term_days ?? ''} onChange={(e) => set({ payment_term_days: e.target.value ? Number(e.target.value) : null })} /></Field>
          </div>
        </details>
        <Field label="Notities"><textarea value={r.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} /></Field>
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        {id && <Button kind="danger" onClick={async () => { if (confirm('Klant archiveren?')) { await run(() => api.relations.archive(id)); go({ screen: 'klanten' }); } }}>Archiveren</Button>}
        <span className="grow" />
        {id && <Button onClick={() => go({ screen: 'offerte' })}>Offerte maken</Button>}
        <Button kind="primary" disabled={busy || !r.name} onClick={async () => {
          const saved = await run(() => (id ? api.relations.update(id, r) : api.relations.create(r)), 'Opgeslagen');
          if (saved && !id) go({ screen: 'klant', id: saved.id });
          else if (saved) { setForm(null); await existing.reload(); }
        }}>Opslaan</Button>
      </div>
    </div>
  );
}

/** Nieuwe klant in 3 velden: naam, adres, e-mail. */
export function QuickCustomer({ onClose, onCreated }: { onClose: () => void; onCreated: (r: Relation) => void }) {
  const { run, busy } = useAction();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [postcode, setPostcode] = useState('');
  const [city, setCity] = useState('');
  const [email, setEmail] = useState('');
  return (
    <Modal title="Nieuwe klant" onClose={onClose}>
      <div className="grid">
        <Field label="Naam"><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Adres"><input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Straat en huisnummer" /></Field>
        <div className="grid cols-2">
          <Field label="Postcode"><input value={postcode} onChange={(e) => setPostcode(e.target.value)} /></Field>
          <Field label="Plaats"><input value={city} onChange={(e) => setCity(e.target.value)} /></Field>
        </div>
        <Field label="E-mail"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      </div>
      <div className="row end" style={{ marginTop: 16 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={busy || !name} onClick={async () => { const r = await run(() => api.relations.create({ name, address, postcode, city, email, type: 'klant' })); if (r) onCreated(r); }}>Toevoegen</Button>
      </div>
    </Modal>
  );
}
