import { useState } from 'react';
import { api } from '../api';
import { Button, DateNl, DropZone, Empty, ErrorBox, Euro, Field, Modal, MoneyInput, StatusPill, readAsBytes, useAction, useApp, useLoad } from '../ui';
import { today } from '../../shared/dates';
import type { PurchaseVatCode } from '../../shared/vat';

export function Purchases({ pay: payInitial }: { pay?: number } = {}) {
  const { go, toast } = useApp();
  const { run } = useAction();
  const docs = useLoad(() => api.documents.list('controle'));
  const purchases = useLoad(() => api.purchases.list());
  const [manual, setManual] = useState(false);
  const [pay, setPay] = useState<number | null>(payInitial ?? null);
  const [uploading, setUploading] = useState(0);

  const upload = async (file: File) => {
    setUploading((n) => n + 1);
    const bytes = await readAsBytes(file);
    const d = await run(() => api.documents.add(file.name, bytes));
    setUploading((n) => n - 1);
    if (!d) return;
    if (d.status === 'verwerkt') toast(`${d.result?.supplier?.value ?? file.name} ✓ automatisch verwerkt`);
    else if (d.status === 'genegeerd') toast('Dit document hadden we al');
    await docs.reload();
    await purchases.reload();
  };

  return (
    <div className="page">
      <div className="row between">
        <div>
          <h1>Aankopen & bonnetjes</h1>
          <p className="sub">Foto of PDF erin, wij doen de rest. We vragen alleen iets als we het niet zeker weten.</p>
        </div>
        <Button onClick={() => setManual(true)}>Bonnetje zonder foto</Button>
      </div>

      <DropZone accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.xml" multiple onFile={(f) => void upload(f)}>
        <div style={{ fontSize: 34 }}>📸</div>
        <strong>Sleep bonnetjes of facturen hierheen</strong>
        <div className="small">Foto, PDF of e-factuur (XML) — of klik om te kiezen</div>
        {uploading > 0 && <div className="small" style={{ marginTop: 8 }}>Bezig met lezen… ({uploading})</div>}
      </DropZone>

      {(docs.data ?? []).length > 0 && (
        <>
          <h2>Even controleren</h2>
          <div className="card" style={{ padding: 0 }}>
            {docs.data!.map((d) => (
              <div className="task" key={d.id}>
                <div className="icon">📷</div>
                <div className="grow">
                  <div className="title">{d.result?.supplier?.value ?? d.original_name} {d.result?.total && <Euro cents={d.result.total.value} />}</div>
                  <div className="q">{d.issues.find((i) => i.severity === 'fout')?.message ?? 'Klopt alles?'}</div>
                </div>
                <Button kind="primary" small onClick={() => go({ screen: 'document', id: d.id })}>Bekijken</Button>
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Aankopen</h2>
      {(purchases.data ?? []).length === 0 ? (
        <Empty icon="🧾" title="Nog geen aankopen">Bonnetjes die je hier toevoegt worden automatisch verwerkt, inclusief BTW die je terugkrijgt.</Empty>
      ) : (
        <table className="list">
          <thead><tr><th>Datum</th><th>Waar</th><th>Wat</th><th>Status</th><th className="num">BTW terug</th><th className="num">Bedrag</th><th /></tr></thead>
          <tbody>
            {purchases.data!.map((p) => (
              <tr key={p.id} className={p.attachment_path ? 'clickable' : ''} onClick={() => p.attachment_path && void run(() => api.app.openAttachment(p.attachment_path!))}>
                <td><DateNl date={p.invoice_date} /></td>
                <td>{p.relation_name ?? '—'}</td>
                <td>{p.description} {p.attachment_path && <span title="Bewijsstuk aanwezig">📎</span>}</td>
                <td><StatusPill status={p.status} /></td>
                <td className="num"><Euro cents={p.vat_total} /></td>
                <td className="num"><Euro cents={p.total} /></td>
                <td onClick={(e) => e.stopPropagation()}>{p.status === 'open' && p.open_amount > 0 && <Button small onClick={() => setPay(p.id)}>Betaal</Button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {manual && <ManualExpense onClose={() => setManual(false)} onDone={async () => { setManual(false); await purchases.reload(); }} />}
      {pay !== null && <PayModal id={pay} onClose={() => setPay(null)} />}
    </div>
  );
}

/** Betalen met de bank-app: scan de QR-code (#25). Bij een nieuw IBAN eerst een waarschuwing. */
function PayModal({ id, onClose }: { id: number; onClose: () => void }) {
  const [confirmNew, setConfirmNew] = useState(false);
  const qr = useLoad(() => api.purchases.paymentQr(id, confirmNew), [id, confirmNew]);
  const q = qr.data;
  return (
    <Modal title="Rekening betalen" onClose={onClose}>
      <ErrorBox error={qr.error} />
      {q && (
        <div className="grid">
          <p>
            <strong><Euro cents={q.amount} /></strong> aan <strong>{q.name}</strong>
            {q.dueDate && <> · vóór <DateNl date={q.dueDate} /></>}
            <br /><span className="small muted">{q.iban}</span>
          </p>
          {q.needsConfirm ? (
            <>
              <div className="notice warn">{q.warning}</div>
              <div className="row">
                <Button kind="primary" onClick={() => setConfirmNew(true)}>Ik heb het gecontroleerd, toon de QR-code</Button>
                <Button onClick={onClose}>Nu niet</Button>
              </div>
            </>
          ) : (
            <>
              {q.warning && <div className="notice small">{q.warning}</div>}
              <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(q.svg)}`} alt="Betaal-QR-code" width={240} height={240} style={{ justifySelf: 'center', background: '#fff', borderRadius: 8 }} />
              <p className="small muted">Scan met je bank-app (“betalen met QR”). Zodra de betaling op je bankafschrift staat, zetten we de rekening op betaald.</p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

/** "Bonnetje zonder foto": in mensentaal, BTW wordt automatisch berekend. */
function ManualExpense({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { meta } = useApp();
  const { run, busy } = useAction();
  const jobs = useLoad(() => api.jobs.list({ active: true }));
  const [supplier, setSupplier] = useState('');
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState<number | null>(null);
  const [category, setCategory] = useState('materiaal');
  const [vat, setVat] = useState<PurchaseVatCode>('hoog');
  const [paidWith, setPaidWith] = useState<'bank' | 'kas' | 'prive'>('bank');
  const [jobId, setJobId] = useState<number | null>(null);
  return (
    <Modal title="Aankoop toevoegen" onClose={onClose}>
      <div className="grid">
        <div className="grid cols-2">
          <Field label="Waar gekocht?"><input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="bv. Gamma" autoFocus /></Field>
          <Field label="Wanneer?"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <Field label="Bedrag op de bon" hint="inclusief BTW"><MoneyInput value={amount} onChange={setAmount} /></Field>
        <CategoryChoice value={category} onChange={(c) => { setCategory(c); setVat(meta.expenseCategories.find((x) => x.key === c)?.defaultVat ?? 'hoog'); }} />
        <Field label="Stond er BTW op de bon?">
          <select value={vat} onChange={(e) => setVat(e.target.value as PurchaseVatCode)}>
            {meta.purchaseVat.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="Hoe betaald?">
          <div className="chips">
            <button className={paidWith === 'bank' ? 'selected' : ''} onClick={() => setPaidWith('bank')}>Zakelijke rekening</button>
            <button className={paidWith === 'kas' ? 'selected' : ''} onClick={() => setPaidWith('kas')}>Contant</button>
            <button className={paidWith === 'prive' ? 'selected' : ''} onClick={() => setPaidWith('prive')}>Met privégeld</button>
          </div>
        </Field>
        {(jobs.data ?? []).length > 0 && (
          <Field label="Voor een klus?" hint="optioneel">
            <select value={jobId ?? ''} onChange={(e) => setJobId(Number(e.target.value) || null)}>
              <option value="">Nee / algemeen</option>
              {jobs.data!.map((j) => <option key={j.id} value={j.id}>{j.title} — {j.relation_name}</option>)}
            </select>
          </Field>
        )}
      </div>
      <div className="row end" style={{ marginTop: 16 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={busy || !amount} onClick={async () => {
          const r = await run(() => api.purchases.recordExpense({ date, supplierName: supplier || null, description: meta.expenseCategories.find((c) => c.key === category)!.label, categoryKey: category, grossAmount: amount!, vatCode: vat, paidWith, jobId }), 'Aankoop verwerkt ✓');
          if (r) onDone();
        }}>Opslaan</Button>
      </div>
    </Modal>
  );
}

/** "Waar was deze aankoop voor?" — categorieën in mensentaal. */
export function CategoryChoice({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  const { meta } = useApp();
  return (
    <Field label="Waar was deze aankoop voor?">
      <div className="chips">
        {meta.expenseCategories.map((c) => (
          <button key={c.key} className={value === c.key ? 'selected' : ''} title={c.hint} onClick={() => onChange(c.key)}>{c.label}</button>
        ))}
      </div>
    </Field>
  );
}
