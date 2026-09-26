import { useState } from 'react';
import { api } from '../api';
import { Button, DateNl, DropZone, Empty, ErrorBox, Euro, Field, Modal, MoneyInput, StatusPill, readAsBytes, useAction, useApp, useLoad, type InvestmentSavedInfo } from '../ui';
import { today } from '../../shared/dates';
import type { PurchaseVatCode } from '../../shared/vat';
import { mightBeInvestment, netAmount } from '../../shared/investment';

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
                <td>
                  {p.description} {p.attachment_path && <span title="Bewijsstuk aanwezig">📎</span>}
                  {p.warranty_months ? <div className="small muted">🛡️ {warrantyText(p.invoice_date, p.warranty_months)}</div> : null}
                </td>
                <td><StatusPill status={p.status} /></td>
                <td className="num"><Euro cents={p.vat_total} /></td>
                <td className="num"><Euro cents={p.total} /></td>
                <td onClick={(e) => e.stopPropagation()}>
                  <span className="row">
                    {p.status === 'open' && p.open_amount > 0 && <Button small onClick={() => setPay(p.id)}>Betaal</Button>}
                    <Button small kind="ghost" title="Garantietermijn vastleggen" onClick={async () => {
                      const v = prompt('Hoeveel maanden garantie? (leeg = geen)', p.warranty_months ? String(p.warranty_months) : '24');
                      if (v === null) return;
                      const months = v.trim() ? Number(v.trim().replace(',', '.')) : null;
                      if (months !== null && !Number.isFinite(months)) return toast('Vul een aantal maanden in, bv. 24', 'error');
                      await run(() => api.search.setWarranty(p.id, months));
                      await purchases.reload();
                    }}>🛡️ Garantie</Button>
                  </span>
                </td>
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
  const { meta, showInvestmentSaved } = useApp();
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
        <InvestmentHint categoryKey={category} gross={amount} vatCode={vat} onUse={() => setCategory('investering')} />
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
          const r = await run(() => api.purchases.recordExpense({ date, supplierName: supplier || null, description: meta.expenseCategories.find((c) => c.key === category)!.label, categoryKey: category, grossAmount: amount!, vatCode: vat, paidWith, jobId }), category === 'investering' ? undefined : 'Aankoop verwerkt ✓');
          if (r) {
            onDone();
            if (category === 'investering') showInvestmentSaved(investmentInfo(amount!, vat));
          }
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

const eur = (cents: number) => `€ ${(cents / 100).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * "Gaat dit langer dan een jaar mee?" — bij € 450+ excl. btw in een categorie waar dat vaak een
 * investering is. Legt in gewone taal uit wat er gebeurt als je ja zegt, en dat je verder niets hoeft
 * te doen. De gebruiker beslist; "Nee" verbergt de vraag (de app vraagt het later nog eens op Vandaag).
 */
export function InvestmentHint({ categoryKey, gross, vatCode, onUse }: { categoryKey: string; gross: number | null | undefined; vatCode: string; onUse: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || !mightBeInvestment(categoryKey, gross, vatCode)) return null;
  const net = netAmount(gross!, vatCode);
  const vat = gross! - net;
  return (
    <div className="notice" role="note">
      <strong>{eur(net)} excl. btw — gaat dit langer dan een jaar mee?</strong>
      <div className="small" style={{ marginTop: 4 }}>
        Denk aan een machine, laptop, telefoon of steiger. Dan is het een <em>investering</em>: iets dat je jaren gebruikt. Kies je daarvoor, dan:
      </div>
      <ul className="small" style={{ margin: '6px 0', paddingLeft: 18 }}>
        {vat > 0 && <li><strong>btw:</strong> die {eur(vat)} krijg je gewoon in één keer terug bij je volgende btw-aangifte. Daar verandert niets aan.</li>}
        <li><strong>kosten:</strong> je trekt het niet in één keer af, maar verdeeld over 5 jaar (± {eur(Math.round(net / 5))} per jaar). Dat boekt de app elk jaar vanzelf.</li>
        <li><strong>extra aftrek:</strong> het telt mee voor de investeringsaftrek (KIA). Investeer je dit jaar in totaal meer dan € 2.900, dan mag je 28% extra aftrekken.</li>
      </ul>
      <div className="small">Jij hoeft daarvoor niets extra te doen. Twijfel je? Kies dan "Nee": de app vraagt het later nog één keer op Vandaag.</div>
      <div className="row" style={{ marginTop: 8 }}>
        <Button small kind="primary" onClick={onUse}>Ja, het is een investering</Button>
        <Button small onClick={() => setDismissed(true)}>Nee, gewone kosten</Button>
      </div>
    </div>
  );
}

/** Na het opslaan: wat de app nu voor je doet, en wat jij (nog) moet doen. */
export function InvestmentSaved({ info, onClose }: { info: InvestmentSavedInfo; onClose: () => void }) {
  const { go } = useApp();
  return (
    <Modal title="Opgeslagen als investering ✓" onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>Dit doet de app voor je</h3>
      <ul style={{ marginTop: 0, paddingLeft: 18 }}>
        {info.vat > 0 && <li>De btw ({eur(info.vat)}) krijg je terug bij je volgende btw-aangifte; die staat daar al in.</li>}
        <li>Elk jaar telt de app ± {eur(Math.round(info.net / 5))} als kosten, 5 jaar lang (dat heet afschrijven). Dat verlaagt je winst, en dus je inkomstenbelasting.</li>
        <li>Het telt mee voor de investeringsaftrek (KIA). Dat zie je terug bij Belasting → Aftrek → Voor je aangifte.</li>
      </ul>
      <h3>Wat jij moet doen</h3>
      <ul style={{ marginTop: 0, paddingLeft: 18 }}>
        <li>{info.hasAttachment ? 'Niets voor de bon: die is al in de app bewaard.' : 'Bewaar de bon of factuur. Dat moet 7 jaar; voeg hem het liefst toe in de app.'}</li>
        <li>Verkoop je het, of gooi je het weg? Zet dat dan bij Belasting → Aftrek → Investeringen (knop "Verkocht…"). De app rekent de rest uit.</li>
        <li>Laat bij je aangifte je boekhouder of accountant meekijken, zoals altijd.</li>
      </ul>
      <p className="small muted">Toch geen investering? Kies bij de aankoop een andere soort kosten; de app past het dan vanzelf aan.</p>
      <div className="row end">
        <Button onClick={() => { onClose(); go({ screen: 'aangifte', extra: { tab: 'bedrijfsmiddelen' } }); }}>Bekijk je investeringen</Button>
        <Button kind="primary" onClick={onClose}>Oké</Button>
      </div>
    </Modal>
  );
}

/** Info voor de bevestiging uit een bedrag zoals op de bon. */
export function investmentInfo(gross: number, vatCode: string, hasAttachment = false): InvestmentSavedInfo {
  const net = netAmount(gross, vatCode);
  return { net, vat: ['hoog', 'laag'].includes(vatCode) ? gross - net : 0, hasAttachment };
}

/** "nog 14 maanden garantie" / "garantie verlopen". */
function warrantyText(from: string, months: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  const left = (d.getTime() - Date.now()) / 86400000;
  if (left < 0) return `garantie verlopen op ${d.toISOString().slice(0, 10)}`;
  const m = Math.floor(left / 30.44);
  return m >= 1 ? `nog ${m} ${m === 1 ? 'maand' : 'maanden'} garantie` : `nog ${Math.ceil(left)} dagen garantie`;
}
