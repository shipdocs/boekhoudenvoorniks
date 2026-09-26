import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { api } from '../api';
import { Button, ErrorBox, Euro, Field, MoneyInput, useAction, useApp, useLoad } from '../ui';
import { CategoryChoice, InvestmentHint, investmentSavedMessage } from './Purchases';
import type { Field as DocField } from '../../intake/types';
import type { PurchaseVatCode } from '../../shared/vat';
import { formatDateNl } from '../../shared/dates';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Box = [number, number, number, number];

/** Toont het document; tekent een markering rond het geselecteerde veld (bbox). */
function DocumentView({ id, mime, highlight, pageSize }: { id: number; mime: string; highlight: { bbox?: Box; page?: number } | null; pageSize?: { width: number; height: number } }) {
  const file = useLoad(() => api.documents.file(id), [id]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (!file.data || mime !== 'application/pdf' || !canvas.current) return;
    let cancelled = false;
    void (async () => {
      const bytes = Uint8Array.from(atob(file.data!.base64), (c) => c.charCodeAt(0));
      const doc = await pdfjs.getDocument({ data: bytes }).promise;
      const page = await doc.getPage(highlight?.page ?? 1);
      const viewport = page.getViewport({ scale: 2 });
      if (cancelled || !canvas.current) return;
      canvas.current.width = viewport.width;
      canvas.current.height = viewport.height;
      await page.render({ canvas: canvas.current, canvasContext: canvas.current.getContext('2d')!, viewport }).promise;
      setNatural({ width: viewport.width / 2, height: viewport.height / 2 });
    })();
    return () => {
      cancelled = true;
    };
  }, [file.data, mime, highlight?.page]);

  if (!file.data) return <div className="doc-view" style={{ minHeight: 300 }}><ErrorBox error={file.error} /></div>;
  if (mime === 'application/xml') return <div className="card flat">📄 E-factuur (XML) — alle gegevens komen rechtstreeks uit het bestand.</div>;
  const size = pageSize ?? natural;
  const box = highlight?.bbox && size ? highlight.bbox : null;
  return (
    <div className="doc-view">
      {mime === 'application/pdf' ? (
        <canvas ref={canvas} />
      ) : (
        <img src={`data:${mime};base64,${file.data.base64}`} alt="Document" onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} />
      )}
      {box && size && (
        <div className="bbox" style={{ left: `${(box[0] / size.width) * 100}%`, top: `${(box[1] / size.height) * 100}%`, width: `${((box[2] - box[0]) / size.width) * 100}%`, height: `${((box[3] - box[1]) / size.height) * 100}%` }} />
      )}
    </div>
  );
}

export function DocumentReview({ id }: { id: number }) {
  const { go, meta, settings } = useApp();
  const { run, busy } = useAction();
  const doc = useLoad(() => api.documents.get(id), [id]);
  const jobs = useLoad(() => api.jobs.list({ active: true }));
  const jobSuggestion = useLoad(() => api.jobs.suggestForDocument(id), [id]);
  const jobSuggested = useRef(false);
  const [active, setActive] = useState<string | null>(null);
  const [form, setForm] = useState<{ supplier: string; date: string; total: number | null; invoiceNumber: string; categoryKey: string; vatCode: PurchaseVatCode; business: boolean; paidWith: 'bank' | 'kas' | 'prive' | 'later'; jobId: number | null; splits: { categoryKey: string; gross: number; vatRate?: number }[] | null } | null>(null);

  const d = doc.data;
  useEffect(() => {
    if (!d || form) return;
    const r = d.result;
    setForm({
      supplier: r?.supplier?.value ?? '',
      date: r?.invoiceDate?.value ?? '',
      total: r?.total?.value ?? null,
      invoiceNumber: r?.invoiceNumber?.value ?? '',
      categoryKey: d.classification?.categoryKey ?? 'materiaal',
      vatCode: (d.classification?.vatCode ?? 'hoog') as PurchaseVatCode,
      business: d.classification?.business ?? true,
      paidWith: d.bank_match ? 'bank' : 'later',
      jobId: null,
      splits: null,
    });
  }, [d, form]);

  // Klus-voorstel (#32): bij één actieve klus of een locatiematch alvast invullen
  useEffect(() => {
    const [best, second] = jobSuggestion.data ?? [];
    if (jobSuggested.current || !form || !best || !d || d.status !== 'controle') return;
    jobSuggested.current = true;
    if (!second || best.score - second.score >= 40) setForm({ ...form, jobId: best.job.id });
  }, [jobSuggestion.data, form, d]);

  if (!d || !form) return <div className="page"><ErrorBox error={doc.error} /></div>;
  const r = d.result;
  const issueFor = (field: string) => d.issues.find((i) => i.field === field || i.field.startsWith(`${field}.`));
  const fields: { key: string; label: string; field: DocField<unknown> | null | undefined; show: string }[] = [
    { key: 'supplier', label: 'Winkel / leverancier', field: r?.supplier, show: form.supplier || '?' },
    { key: 'invoiceDate', label: 'Datum', field: r?.invoiceDate, show: form.date ? formatDateNl(form.date) : '?' },
    { key: 'invoiceNumber', label: 'Nummer', field: r?.invoiceNumber, show: form.invoiceNumber || '—' },
    { key: 'subtotal', label: 'Netto', field: r?.subtotal, show: r?.subtotal ? new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(r.subtotal.value / 100) : '—' },
    { key: 'vat', label: 'BTW', field: r?.vat, show: r?.vat.value.map((v) => `${v.rate}%: ${(v.amount / 100).toFixed(2).replace('.', ',')}`).join(' · ') || '—' },
    { key: 'total', label: 'Totaal', field: r?.total, show: form.total !== null ? new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(form.total / 100) : '?' },
  ];
  const activeField = fields.find((f) => f.key === active)?.field ?? (active?.startsWith('line-') ? r?.lines?.[Number(active.slice(5))] ?? null : null);
  const pageSize = r?.pageSizes?.[(activeField?.page ?? 1) - 1];

  return (
    <div className="page">
      <div className="row between">
        <div>
          <h1>{form.supplier || d.original_name}</h1>
          <p className="sub">{d.duplicate_of_document_id || (d.status === 'genegeerd' && d.issues.some((i) => i.field === 'duplicate')) ? 'Dubbel document — niet opnieuw geboekt' : d.status === 'verwerkt' ? '✓ Verwerkt' : d.confidence === 'LOW' ? 'We weten het niet zeker — kijk even mee.' : 'Klopt alles?'}</p>
        </div>
        <Button kind="ghost" onClick={() => go({ screen: 'aankopen' })}>← Aankopen</Button>
      </div>
      <div className="split">
        <DocumentView id={d.id} mime={d.mime_type} highlight={activeField} pageSize={pageSize} />
        <div>
          <div className="card" style={{ padding: 8 }}>
            {fields.map((f) => {
              const issue = issueFor(f.key);
              const decision = d.decisions?.find((x) => x.field === f.key);
              const doubt = d.status === 'controle' && decision && !decision.ok;
              return (
                <div key={f.key} className={`fieldcheck ${active === f.key ? 'active' : ''} ${doubt ? 'doubt' : ''}`} onClick={() => setActive(f.key)} title={f.field ? `bron: ${f.field.source}, zekerheid ${Math.round(f.field.confidence * 100)}%` : 'niet gevonden'}>
                  <span className="muted small" style={{ width: 130 }}>{f.label}</span>
                  <span className="grow">{f.show}</span>
                  {settings.advancedMode && decision && <span className="small muted mono">{Math.round(decision.confidence * 100)}%</span>}
                  {issue || doubt ? <span className="warn" title={issue?.message ?? 'Hier twijfelen we over'}>?</span> : f.field ? <span className="ok">✓</span> : <span className="muted">—</span>}
                </div>
              );
            })}
          </div>
          {d.issues.filter((i) => i.severity === 'fout' || i.field === 'duplicate').map((i) => (
            <div key={i.field + i.message} className="notice warn">
              {i.message}
              {i.field === 'duplicate' && d.status === 'controle' && (
                <div className="row" style={{ marginTop: 8 }}>
                  <Button small disabled={busy} onClick={async () => {
                    const done = await run(() => api.documents.markDuplicate(d.id, i.suggestion as { documentId: number | null; purchaseId: number | null }), 'Dubbel document weggelegd');
                    if (done) go({ screen: 'aankopen' });
                  }}>Ja, zelfde aankoop</Button>
                  <span className="small muted">Anders: controleer de gegevens hieronder en verwerk het gewoon.</span>
                </div>
              )}
            </div>
          ))}
          {d.status === 'controle' && (d.decisions ?? []).some((x) => !x.field && !x.ok) && (
            <div className="notice small">
              Hier twijfelen we nog over: {(d.decisions ?? []).filter((x) => !x.field && !x.ok).map((x) => `${x.label.toLowerCase()} (${x.value})`).join(', ')}. Kies hieronder wat klopt.
            </div>
          )}
          {d.status === 'controle' && d.issues.filter((i) => i.field === 'lines').map((i) => {
            const parts = i.suggestion as { categoryKey: string; gross: number; items: string[]; vatRate?: number }[];
            return (
              <div key="split" className="notice">
                {i.message}
                <div className="row" style={{ marginTop: 8 }}>
                  <Button small kind={form.splits ? 'primary' : undefined} onClick={() => setForm({ ...form, splits: form.splits ? null : parts.map((p) => ({ categoryKey: p.categoryKey, gross: p.gross, vatRate: p.vatRate })) })}>
                    {form.splits ? '✓ Wordt apart geboekt' : 'Ja, apart boeken'}
                  </Button>
                </div>
              </div>
            );
          })}
          {r?.lines && r.lines.length > 0 && (
            <details className="small" style={{ marginTop: 8 }}>
              <summary>{r.lines.length} regels op het document{r.linesBasis ? '' : ' (tellen niet op tot het totaal)'}</summary>
              <table className="list small">
                <tbody>
                  {r.lines.map((l, idx) => (
                    <tr key={idx} className={active === `line-${idx}` ? 'selected' : ''} onClick={() => setActive(`line-${idx}`)}>
                      <td>{l.value.quantity !== null ? `${l.value.quantity}×` : ''}</td>
                      <td>{l.value.description}</td>
                      <td className="num"><Euro cents={l.value.amount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          {d.bank_match && <div className="notice good">✓ Betaling gevonden op de bank: {formatDateNl(d.bank_match.transaction_date)} · <Euro cents={d.bank_match.amount} /></div>}
          {d.classification && <p className="small muted">{d.classification.reasons.join(' · ')}</p>}

          {d.status !== 'verwerkt' && (
            <div className="card grid" style={{ marginTop: 12 }}>
              <div className="grid cols-2">
                <Field label="Winkel / leverancier"><input value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })} /></Field>
                <Field label="Datum"><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
              </div>
              <Field label="Totaal (incl. BTW)"><MoneyInput value={form.total} onChange={(v) => setForm({ ...form, total: v })} /></Field>
              <Field label="Was dit zakelijk?">
                <div className="chips">
                  <button className={form.business ? 'selected' : ''} onClick={() => setForm({ ...form, business: true })}>Zakelijk</button>
                  <button className={!form.business ? 'selected' : ''} onClick={() => setForm({ ...form, business: false })}>Privé</button>
                </div>
              </Field>
              {form.business && (
                <>
                  <CategoryChoice value={form.categoryKey} onChange={(c) => setForm({ ...form, categoryKey: c })} />
                  {!form.splits && <InvestmentHint categoryKey={form.categoryKey} gross={form.total} vatCode={form.vatCode} onUse={() => setForm({ ...form, categoryKey: 'investering' })} />}
                  <Field label="BTW op de bon">
                    <select value={form.vatCode} onChange={(e) => setForm({ ...form, vatCode: e.target.value as PurchaseVatCode })}>
                      {meta.purchaseVat.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}
                    </select>
                  </Field>
                  <Field label="Hoe betaald?">
                    <div className="chips">
                      <button className={form.paidWith === 'bank' || form.paidWith === 'later' ? 'selected' : ''} onClick={() => setForm({ ...form, paidWith: d.bank_match ? 'bank' : 'later' })}>Zakelijke rekening</button>
                      <button className={form.paidWith === 'kas' ? 'selected' : ''} onClick={() => setForm({ ...form, paidWith: 'kas' })}>Contant</button>
                      <button className={form.paidWith === 'prive' ? 'selected' : ''} onClick={() => setForm({ ...form, paidWith: 'prive' })}>Met privégeld</button>
                    </div>
                  </Field>
                  {(jobs.data ?? []).length > 0 && (
                    <Field label="Voor een klus?" hint="optioneel">
                      <select value={form.jobId ?? ''} onChange={(e) => { jobSuggested.current = true; setForm({ ...form, jobId: Number(e.target.value) || null }); }}>
                        <option value="">Nee / algemeen</option>
                        {jobs.data!.map((j) => <option key={j.id} value={j.id}>{j.title} — {j.relation_name}</option>)}
                      </select>
                    </Field>
                  )}
                </>
              )}
              <div className="row end">
                <Button kind="ghost" onClick={async () => { await run(() => api.documents.ignore(d.id)); go({ screen: 'aankopen' }); }}>Negeren</Button>
                <Button kind="primary" disabled={busy || !form.supplier || !form.date || !form.total} onClick={async () => {
                  const res = await run(() => api.documents.confirm(d.id, { supplier: form.supplier, date: form.date, total: form.total!, invoiceNumber: form.invoiceNumber || null, categoryKey: form.categoryKey, vatCode: form.vatCode, business: form.business, paidWith: form.paidWith, jobId: form.jobId, splits: form.splits }), form.business && !form.splits && form.categoryKey === 'investering' ? investmentSavedMessage(form.total!, form.vatCode) : 'Verwerkt ✓');
                  if (res) go({ screen: 'aankopen' });
                }}>Klopt, verwerken</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
