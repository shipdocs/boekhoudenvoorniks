import { useEffect, useRef, useState } from 'react';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { api } from '../api';
import { Button, ErrorBox, Euro, Field, MoneyInput, useAction, useApp, useLoad } from '../ui';
import { BusinessShareField, CategoryChoice, InvestmentHint, SupplierInput, investmentInfo } from './Purchases';
import type { Field as DocField } from '../../intake/types';
import type { PurchaseVatCode } from '../../shared/vat';
import { ReaderChoice } from './Reader';
import { CURRENCY_NAMES, formatForeign } from '../../shared/currency';
import type { DocumentResult } from '../../intake/types';
import { formatDateNl } from '../../shared/dates';
import type { IntakeDocument, PendingProposal } from '../../intake/intake';
import { DOCUMENT_OUTCOME_LABEL } from '../../shared/document-outcome';
import { TargetDetails } from './UploadOutcome';
import { paidWithNote, proposedPaidWith } from '../../shared/paid-with';
import { futureDateIssue } from '../../intake/validation';

// pdf.js gebruikt Map.getOrInsertComputed, dat oudere Chromium-versies (bv. die van de e2e-tests) nog niet kennen
for (const proto of [Map.prototype, WeakMap.prototype] as unknown as Record<string, unknown>[]) {
  if (!proto.getOrInsertComputed) {
    Object.defineProperty(proto, 'getOrInsertComputed', {
      configurable: true,
      writable: true,
      value(this: Map<unknown, unknown>, key: unknown, make: (key: unknown) => unknown) {
        if (!this.has(key)) this.set(key, make(key));
        return this.get(key);
      },
    });
  }
}
type Box = [number, number, number, number];

/** Zoveel PDF-pagina's laten we hooguit zien (een bon of factuur is zelden langer). */
const MAX_PAGES = 20;

/** Eén PDF-pagina op een canvas. */
function PdfPage({ doc, number, onSize }: { doc: PDFDocumentProxy; number: number; onSize: (size: { width: number; height: number }) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    let render: RenderTask | null = null;
    void (async () => {
      const page = await doc.getPage(number);
      const viewport = page.getViewport({ scale: 2 });
      if (cancelled || !canvas.current) return;
      canvas.current.width = viewport.width;
      canvas.current.height = viewport.height;
      render = page.render({ canvas: canvas.current, canvasContext: canvas.current.getContext('2d')!, viewport });
      await render.promise;
      if (!cancelled) onSize({ width: viewport.width / 2, height: viewport.height / 2 });
    })().catch(() => {
      // afgebroken (ander document) of een kapotte pagina: die blijft leeg, de rest werkt
    });
    return () => {
      cancelled = true;
      render?.cancel();
    };
    // alleen opnieuw tekenen bij een ander document of een andere pagina (onSize is elke render nieuw)
  }, [doc, number]);
  return <canvas ref={canvas} aria-label={`Pagina ${number}`} />;
}

/** Toont het document (alle pagina's onder elkaar); tekent een markering rond het geselecteerde veld (bbox). */
function DocumentView({ id, mime, highlight, pageSizes }: { id: number; mime: string; highlight: { bbox?: Box; page?: number } | null; pageSizes?: { width: number; height: number }[] }) {
  const file = useLoad(() => api.documents.file(id), [id]);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [natural, setNatural] = useState<Record<number, { width: number; height: number }>>({});
  const [broken, setBroken] = useState(false);
  const pages = useRef<Record<number, HTMLDivElement | null>>({});

  useEffect(() => {
    if (!file.data || mime !== 'application/pdf') return;
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    void (async () => {
      const pdfjs = await import('pdfjs-dist');
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      task = pdfjs.getDocument({ data: Uint8Array.from(atob(file.data!.base64), (c) => c.charCodeAt(0)) });
      const doc = await task.promise;
      if (!cancelled) setPdf(doc);
    })().catch(() => {
      if (!cancelled) setBroken(true);
    });
    return () => {
      cancelled = true;
      setPdf(null);
      setNatural({});
      setBroken(false);
      void task?.destroy();
    };
  }, [file.data, mime]);

  // markering op een andere pagina: daarheen scrollen
  const highlightPage = highlight?.bbox ? highlight.page ?? 1 : null;
  useEffect(() => {
    if (highlightPage && highlightPage > 1) pages.current[highlightPage]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [highlightPage, pdf]);

  if (!file.data) return <div className="doc-view" style={{ minHeight: 300 }}><ErrorBox error={file.error} /></div>;
  if (mime === 'application/xml') return <div className="card flat">📄 E-factuur (XML) — alle gegevens komen rechtstreeks uit het bestand.</div>;

  const marker = (page: number) => {
    const size = pageSizes?.[page - 1] ?? natural[page];
    const box = highlight?.bbox && (highlight.page ?? 1) === page && size ? highlight.bbox : null;
    if (!box || !size) return null;
    return <div className="bbox" style={{ left: `${(box[0] / size.width) * 100}%`, top: `${(box[1] / size.height) * 100}%`, width: `${((box[2] - box[0]) / size.width) * 100}%`, height: `${((box[3] - box[1]) / size.height) * 100}%` }} />;
  };

  if (mime !== 'application/pdf') {
    return (
      <div className="doc-view">
        <div className="doc-page">
          <img src={`data:${mime};base64,${file.data.base64}`} alt="Document" onLoad={(e) => setNatural({ 1: { width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight } })} />
          {marker(1)}
        </div>
      </div>
    );
  }
  if (broken) return <div className="card flat">Dit PDF-bestand kunnen we hier niet laten zien. Het staat wel bewaard; je kunt de gegevens gewoon zelf invullen.</div>;
  const count = pdf ? Math.min(pdf.numPages, MAX_PAGES) : 0;
  return (
    <div className="doc-view" style={pdf ? undefined : { minHeight: 300 }}>
      {pdf &&
        Array.from({ length: count }, (_, i) => i + 1).map((n) => (
          <div className="doc-page" key={n} ref={(el) => void (pages.current[n] = el)}>
            <PdfPage doc={pdf} number={n} onSize={(size) => setNatural((prev) => (prev[n]?.width === size.width && prev[n]?.height === size.height ? prev : { ...prev, [n]: size }))} />
            {marker(n)}
          </div>
        ))}
      {pdf && pdf.numPages > MAX_PAGES && <p className="sub" style={{ padding: 12, margin: 0 }}>Nog {pdf.numPages - MAX_PAGES} pagina's die we hier niet laten zien.</p>}
    </div>
  );
}

/** Waar de gegevens vandaan komen, om te kunnen controleren of Claude Code (en niet de lokale herkenning) het gelezen heeft. */
function extractionSourceLabel(source: string | null): string {
  if (source === 'ubl') return 'Gelezen uit e-factuur (UBL)';
  if (source === 'pdf-text') return 'Gelezen uit de tekst in de PDF';
  if (source === 'geen') return 'Nog niet uitgelezen';
  if (source === 'ocr:claude-code') return 'Gelezen door Claude Code (Anthropic)';
  if (source === 'ocr:codex') return 'Gelezen door Codex (OpenAI)';
  if (source?.startsWith('ocr:')) return `Gelezen door ${source.slice(4)}`;
  return '';
}

export function DocumentReview({ id }: { id: number }) {
  const { go, meta, settings, showInvestmentSaved } = useApp();
  const { run, busy } = useAction();
  // openen kan de bon opnieuw beoordelen (koers, oude tekstkoppeling): daarna pas kijken welke vraag er openstaat (#179)
  const view = useLoad(async () => {
    const opened = await api.documents.open(id);
    return { doc: opened, pending: await api.documents.pending(id) };
  }, [id]);
  const doc = { data: view.data?.doc, error: view.error, reload: view.reload };
  const jobs = useLoad(() => api.jobs.list({ active: true }));
  const jobSuggestion = useLoad(() => api.jobs.suggestForDocument(id), [id]);
  const jobSuggested = useRef(false);
  const [active, setActive] = useState<string | null>(null);
  const [form, setForm] = useState<{ supplier: string; date: string; total: number | null; invoiceNumber: string; vatAmount: number | null; categoryKey: string; vatCode: PurchaseVatCode; business: boolean; businessPct: number | null; paidWith: 'bank' | 'kas' | 'prive' | 'later'; jobId: number | null; splits: { categoryKey: string; gross: number; vatRate?: number }[] | null } | null>(null);
  // de verbeterde gegevens lijken op een aankoop of bon die er al staat (#224): eerst de vraag, pas na "Toch boeken" verwerken
  const [duplicate, setDuplicate] = useState<{ entry: string; lead: string } | null>(null);

  const d = doc.data;
  useEffect(() => {
    if (!d || form) return;
    const r = d.result;
    setForm({
      supplier: r?.supplier?.value ?? '',
      date: r?.invoiceDate?.value ?? '',
      total: r?.total?.value ?? null,
      invoiceNumber: r?.invoiceNumber?.value ?? '',
      vatAmount: null,
      categoryKey: d.classification?.categoryKey ?? 'materiaal',
      vatCode: (d.classification?.vatCode ?? 'hoog') as PurchaseVatCode,
      business: d.classification?.business ?? true,
      businessPct: null,
      // de betaalwijze die op de telefoon is gekozen (bonnenscanner) is het voorstel
      paidWith: proposedPaidWith(d),
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
  const unread = d.extraction_source === 'geen' && (d.status === 'nieuw' || d.status === 'controle');
  const issueFor = (field: string) => d.issues.find((i) => i.field === field || i.field.startsWith(`${field}.`));
  const fields: { key: string; label: string; field: DocField<unknown> | null | undefined; show: string }[] = [
    { key: 'supplier', label: 'Winkel / leverancier', field: r?.supplier, show: form.supplier || '?' },
    { key: 'invoiceDate', label: 'Datum', field: r?.invoiceDate, show: form.date ? formatDateNl(form.date) : '?' },
    { key: 'invoiceNumber', label: 'Factuurnummer', field: r?.invoiceNumber, show: form.invoiceNumber || '—' },
    { key: 'subtotal', label: 'Zonder btw', field: r?.subtotal, show: r?.subtotal ? new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(r.subtotal.value / 100) : '—' },
    { key: 'vat', label: 'Btw', field: r?.vat, show: r?.vat.value.map((v) => `${v.rate}%: ${(v.amount / 100).toFixed(2).replace('.', ',')}`).join(' · ') || '—' },
    { key: 'total', label: 'Totaal', field: r?.total, show: form.total !== null ? new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(form.total / 100) : '?' },
  ];
  // btw-bedrag zoals gelezen (één tarief), anders uitgerekend uit het totaal
  const rate = form.vatCode === 'hoog' ? 21 : form.vatCode === 'laag' ? 9 : 0;
  const docVat = r?.vat.value.length === 1 && r.vat.value[0]!.rate === rate ? r.vat.value[0]!.amount : null;
  const defaultVat = form.total === null ? null : docVat ?? Math.round((form.total * rate) / (100 + rate));
  // wat je in het veld ziet, is wat er geboekt wordt
  const showVat = form.business && !form.splits && (form.vatCode === 'hoog' || form.vatCode === 'laag');
  const activeField = fields.find((f) => f.key === active)?.field ?? (active?.startsWith('line-') ? r?.lines?.[Number(active.slice(5))] ?? null : null);
  // de vraag die eerst een antwoord nodig heeft: "dezelfde aankoop?" of "alleen als bewijs koppelen?"
  const proposal = d.status === 'controle' ? view.data?.pending ?? null : null;
  // na een keuze opnieuw laden: het formulier begint dan weer met wat de app nu voorstelt
  // factuur van je eigen bedrijf (#205): alleen privé of "weet ik nog niet"; bij twijfel eerst de vraag
  const ownIssue = !proposal && d.status === 'controle' ? d.issues.find((i) => i.field === 'own-company') : undefined;
  const own = ownIssue ? (ownIssue.suggestion as { level: 'zeker' | 'waarschijnlijk'; signals: string[] }) : null;
  // de datum is in de toekomst gelezen (#224): de waarschuwing blijft staan tot de datum is aangepast
  const futureIssue = d.status === 'controle' ? futureDateIssue(d.issues) : null;
  const futureDate = futureIssue && form.date === (r?.invoiceDate?.value ?? '') ? futureIssue : null;
  const refresh = async () => {
    setForm(null);
    await view.reload();
  };
  // de vraag geldt voor de gegevens zoals ze er toen stonden; verandert de gebruiker iets, dan kijkt de app opnieuw
  const entry = `${form.supplier.trim()}|${form.date}|${form.total}|${form.invoiceNumber.trim()}|${form.business}`;
  const shownDuplicate = duplicate?.entry === entry ? duplicate : null;

  return (
    <div className="page">
      <div className="row between">
        <div>
          <h1>{form.supplier || d.original_name}</h1>
          <p className="sub" data-testid="uitkomst">{d.outcome !== 'controle' ? DOCUMENT_OUTCOME_LABEL[d.outcome] : proposal ? 'Nog controleren' : d.confidence === 'LOW' ? 'We weten het niet zeker — kijk even mee.' : 'Klopt alles?'}</p>
          <p className="small muted">{extractionSourceLabel(d.extraction_source)}</p>
        </div>
        <Button kind="ghost" onClick={() => go({ screen: 'aankopen' })}>← Aankopen</Button>
      </div>
      <div className="split">
        <DocumentView id={d.id} mime={d.mime_type} highlight={activeField} pageSizes={r?.pageSizes} />
        <div>
          <div className="card" style={{ padding: 8 }}>
            {fields.map((f) => {
              const issue = issueFor(f.key);
              const decision = d.decisions?.find((x) => x.field === f.key);
              const doubt = d.status === 'controle' && decision && !decision.ok;
              return (
                <div key={f.key} className={`fieldcheck ${active === f.key ? 'active' : ''} ${doubt ? 'doubt' : ''}`} onClick={() => setActive(f.key)} title={f.field ? `Gelezen van de bon, ${Math.round(f.field.confidence * 100)}% zeker` : 'Niet gevonden: vul het zelf in'}>
                  <span className="muted small" style={{ width: 130 }}>{f.label}</span>
                  <span className="grow">{f.show}</span>
                  {settings.advancedMode && decision && <span className="small muted mono">{Math.round(decision.confidence * 100)}%</span>}
                  {issue || doubt ? <span className="warn" title={issue?.message ?? 'Hier twijfelen we over'}>?</span> : f.field ? <span className="ok">✓</span> : <span className="muted">—</span>}
                </div>
              );
            })}
          </div>
          {d.note && <div className="notice small" style={{ whiteSpace: 'pre-wrap' }}><strong>Notitie van je telefoon:</strong> {d.note}</div>}
          {r?.foreign && <ForeignNotice foreign={r.foreign} euro={form.total ?? r.total?.value ?? null} />}
          {/* nog niet uitgelezen (geen herkenning): hier kiezen hoe de app bonnen mag lezen */}
          {unread && <ReaderChoice context="bon" onDone={async () => { setForm(null); await doc.reload(); }} />}
          {d.issues.filter((i) => (i.severity === 'fout' || i.field === 'duplicate') && !(unread && i.field === 'document') && !(proposal && i.field === proposal.kind) && !(own && i.field === 'own-company')).map((i) => (
            <div key={i.field + i.message} className="notice warn">{i.message}</div>
          ))}
          {futureDate && <div className="notice warn" data-testid="datum-toekomst">{futureDate.message}</div>}
          {proposal && <ProposalChoice doc={d} proposal={proposal} question={d.issues.find((i) => i.field === proposal.kind)?.message ?? ''} onDone={refresh} />}
          <LinkedTo doc={d} onChanged={refresh} />
          {own && (
            <div className="notice warn" role="note" data-testid="eigen-bedrijf">
              <strong>{own.level === 'zeker' ? 'Dit is een factuur van je eigen bedrijf' : 'Is dit een factuur van je eigen bedrijf?'}</strong>
              <div className="small" style={{ marginTop: 4 }}>
                {own.level === 'zeker'
                  ? 'Verkoper en koper zijn hetzelfde bedrijf, bijvoorbeeld bij een abonnement op je eigen dienst. Dat is geen gewone aankoop: de app boekt hem niet als kosten en trekt de btw niet af. Kies hieronder Privé of Weet ik nog niet.'
                  : 'Verkoper en koper lijken hetzelfde bedrijf. Een factuur van jezelf is geen gewone aankoop: die boek je niet als kosten met btw-aftrek.'}
              </div>
              <div className="small muted" style={{ marginTop: 4 }}>Waarom? Omdat {own.signals.join(', ')}.</div>
              {own.level === 'waarschijnlijk' && (
                <div className="row" style={{ marginTop: 8 }}>
                  <Button small kind="primary" disabled={busy} onClick={async () => { if (await run(() => api.documents.decideOwn(d.id, 'ja'))) await refresh(); }}>Ja, van mijn eigen bedrijf</Button>
                  <Button small disabled={busy} onClick={async () => { if (await run(() => api.documents.decideOwn(d.id, 'nee'))) await refresh(); }}>Nee, een gewone aankoop</Button>
                </div>
              )}
            </div>
          )}
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
                    {form.splits ? '✓ Wordt apart verwerkt' : 'Ja, apart verwerken'}
                  </Button>
                </div>
              </div>
            );
          })}
          {r?.lines && r.lines.length > 0 && (
            <details className="small" style={{ marginTop: 8 }}>
              <summary>{r.lines.length} regels op het document{r.linesBasis ? '' : ' (samen niet precies het totaal)'}</summary>
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
          {d.classification && <p className="small muted">{d.classification.reasons.map((x) => x.replace(/bewijsstuk bij banktransactie #\d+/, 'bon bij een betaling')).join(' · ')}</p>}

          {d.status !== 'verwerkt' && !d.link && d.outcome !== 'dubbel' && !proposal && own?.level !== 'waarschijnlijk' && (
            // minmax: het formulier blijft binnen de kaart, hoe breed de keuzeknoppen of het datumveld ook zijn
            <div className="card grid" style={{ marginTop: 12, gridTemplateColumns: 'minmax(0, 1fr)' }}>
              <div className="grid cols-2">
                <Field label="Winkel / leverancier"><SupplierInput value={form.supplier} onChange={(v) => setForm({ ...form, supplier: v })} /></Field>
                <Field label="Datum"><input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
              </div>
              <div className="grid cols-2">
                <Field label={r?.foreign ? "Totaal in euro's (incl. btw)" : 'Totaal (incl. btw)'}><MoneyInput value={form.total} onChange={(v) => setForm({ ...form, total: v })} /></Field>
                <Field label="Factuur- of bonnummer" hint="mag leeg"><input value={form.invoiceNumber} maxLength={60} onChange={(e) => setForm({ ...form, invoiceNumber: e.target.value })} /></Field>
              </div>
              {own ? (
                <>
                  <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                    <li><strong>Privé:</strong> komt niet in je boekhouding als kosten{d.bank_match ? '; de betaling op de bank telt als privé-opname' : ''}.</li>
                    <li><strong>Weet ik nog niet:</strong> staat apart op vraagposten, zonder btw-aftrek{d.bank_match ? ', met de betaling eraan gekoppeld' : ''}. Je boekhouder zoekt het uit.</li>
                  </ul>
                  <div className="row end">
                    <Button kind="ghost" onClick={async () => { await run(() => api.documents.ignore(d.id)); go({ screen: 'aankopen' }); }}>Negeren</Button>
                    {(['prive', 'vraag'] as const).map((choice) => (
                      <Button key={choice} disabled={busy || !form.supplier || !form.date || !form.total} onClick={async () => {
                        const res = await run(
                          () => api.documents.confirm(d.id, { supplier: form.supplier, date: form.date, total: form.total!, invoiceNumber: form.invoiceNumber || null, categoryKey: choice === 'vraag' ? 'onbekend' : 'overig', vatCode: 'geen', business: choice === 'vraag', paidWith: d.bank_match ? 'bank' : 'later' }),
                          choice === 'vraag' ? 'Apart gezet op "weet ik nog niet" ✓' : 'Privé — niet geboekt ✓',
                        );
                        if (res) go({ screen: 'aankopen' });
                      }}>{choice === 'vraag' ? 'Weet ik nog niet: vraag mijn boekhouder' : 'Privé'}</Button>
                    ))}
                  </div>
                  <p className="small muted" style={{ margin: 0, textAlign: 'right' }}>
                    Geen factuur van je eigen bedrijf?{' '}
                    <button className="linklike small" disabled={busy} onClick={async () => {
                      if (!confirm('Is dit echt een gewone aankoop bij een ander bedrijf? Dan controleer je hem daarna zoals elke bon, met kosten en btw.')) return;
                      if (await run(() => api.documents.decideOwn(d.id, 'nee'))) await refresh();
                    }}>Toch een gewone aankoop</button>
                  </p>
                </>
              ) : (
              <>
              <Field label="Was dit zakelijk?">
                <div className="chips">
                  <button className={form.business ? 'selected' : ''} onClick={() => setForm({ ...form, business: true })}>Zakelijk</button>
                  <button className={!form.business ? 'selected' : ''} onClick={() => setForm({ ...form, business: false })}>Privé</button>
                </div>
              </Field>
              {form.business && (
                <>
                  {form.categoryKey !== 'onbekend' && <CategoryChoice value={form.categoryKey} onChange={(c) => setForm({ ...form, categoryKey: c })} />}
                  {form.categoryKey === 'onbekend' ? (
                    <div className="notice" role="note" data-testid="vraagpost">
                      <strong>Weet ik nog niet: vraag mijn boekhouder.</strong>
                      <div className="small" style={{ marginTop: 4 }}>
                        De bon wordt apart gezet op <em>vraagposten</em>, zonder btw-aftrek. Hij komt terug als controle vóór je btw-aangifte en staat in het pakket voor je boekhouder. Weet je het later wel, dan deel je hem in bij Aankopen (knop <em>Indelen</em>); dan krijg je ook de btw terug.
                      </div>
                      <Button small kind="ghost" onClick={() => setForm({ ...form, categoryKey: d.classification?.categoryKey && d.classification.categoryKey !== 'onbekend' ? d.classification.categoryKey : 'overig', vatCode: d.classification?.vatCode ?? 'hoog' })}>Toch een categorie kiezen</Button>
                    </div>
                  ) : (
                    <p className="small" style={{ margin: '-4px 0 8px' }}>
                      <Button small kind="ghost" onClick={() => setForm({ ...form, categoryKey: 'onbekend', vatCode: 'geen', vatAmount: null, splits: null, businessPct: null })}>❓ Weet ik nog niet: vraag mijn boekhouder</Button>
                    </p>
                  )}
                  {!form.splits && form.categoryKey !== 'onbekend' && <InvestmentHint categoryKey={form.categoryKey} gross={form.total} vatCode={form.vatCode} onUse={() => setForm({ ...form, categoryKey: 'investering' })} />}
                  {form.categoryKey !== 'onbekend' && <div className="grid cols-2">
                    <Field label="Btw op de bon">
                      <select value={form.vatCode} onChange={(e) => setForm({ ...form, vatCode: e.target.value as PurchaseVatCode, vatAmount: null })}>
                        {meta.purchaseVat.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}
                      </select>
                    </Field>
                    {showVat && (
                      <Field label="Btw-bedrag" hint="zoals op de bon; pas aan als het anders is">
                        <MoneyInput value={form.vatAmount ?? defaultVat} onChange={(v) => setForm({ ...form, vatAmount: v })} />
                      </Field>
                    )}
                  </div>}
                  {!form.splits && form.categoryKey !== 'onbekend' && <BusinessShareField supplier={form.supplier} value={form.businessPct} onChange={(v) => setForm({ ...form, businessPct: v })} />}
                  <Field label="Hoe betaald?">
                    <div className="chips">
                      {/* "later" naast een gevonden betaling (de telefoon zei contant of privé, #222): nog niets gekozen, de aankoop blijft open */}
                      <button className={form.paidWith === 'bank' || (form.paidWith === 'later' && !d.bank_match) ? 'selected' : ''} onClick={() => setForm({ ...form, paidWith: d.bank_match ? 'bank' : 'later' })}>Zakelijke rekening</button>
                      <button className={form.paidWith === 'kas' ? 'selected' : ''} onClick={() => setForm({ ...form, paidWith: 'kas' })}>Contant</button>
                      <button className={form.paidWith === 'prive' ? 'selected' : ''} onClick={() => setForm({ ...form, paidWith: 'prive' })}>Met privégeld</button>
                    </div>
                    {form.paidWith === 'later' && d.bank_match && paidWithNote(d) && (
                      <div className="small muted">{paidWithNote(d).trim()} Weet je het zeker? Kies dan hierboven zelf hoe je betaalde.</div>
                    )}
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
              {shownDuplicate && (
                <div className="notice warn" role="alert" data-testid="mogelijk-dubbel" style={{ marginBottom: 12 }}>
                  <strong>Staat deze aankoop er al in?</strong>
                  <div className="small" style={{ marginTop: 4 }}>{shownDuplicate.lead} Kijk het eerst na bij Aankopen & bonnetjes. Is dit een andere aankoop, kies dan “Toch boeken”. Is het dezelfde, kies dan “Negeren”.</div>
                </div>
              )}
              <div className="row end">
                <Button kind="ghost" onClick={async () => { await run(() => api.documents.ignore(d.id)); go({ screen: 'aankopen' }); }}>Negeren</Button>
                <Button kind="primary" disabled={busy || !form.supplier || !form.date || !form.total} onClick={async () => {
                  if (!shownDuplicate) {
                    const found = await run(() => api.documents.duplicateOf(d.id, { supplier: form.supplier, date: form.date, total: form.total!, invoiceNumber: form.invoiceNumber || null, business: form.business }));
                    if (found === undefined) return;
                    if (found) return setDuplicate({ entry, lead: `Lijkt op ${found.label}.${found.detail ? ` ${found.detail}` : ''}` });
                  }
                  const isInvestment = form.business && !form.splits && form.categoryKey === 'investering';
                  const res = await run(() => api.documents.confirm(d.id, { supplier: form.supplier, date: form.date, total: form.total!, invoiceNumber: form.invoiceNumber || null, vatAmount: form.vatAmount ?? (showVat ? defaultVat : null), categoryKey: form.categoryKey, vatCode: form.vatCode, business: form.business, paidWith: form.paidWith, jobId: form.jobId, splits: form.splits, allowDuplicate: !!shownDuplicate, ...(form.businessPct !== null && !form.splits ? { businessPct: form.businessPct } : {}) }), isInvestment ? undefined : form.business ? 'Nieuwe aankoop geboekt ✓' : 'Privé — niet geboekt ✓');
                  if (res) {
                    go({ screen: 'aankopen' });
                    if (isInvestment) showInvestmentSaved(investmentInfo(form.total!, form.vatCode, true));
                  }
                }}>{shownDuplicate ? 'Toch boeken' : 'Klopt, verwerken'}</Button>
              </div>
              </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Bon in een andere munt (#74): wat er stond, welk bedrag in euro's telt en waarom. */
function ForeignNotice({ foreign, euro }: { foreign: NonNullable<DocumentResult['foreign']>; euro: number | null }) {
  const name = CURRENCY_NAMES[foreign.currency]?.name ?? foreign.currency;
  const eur = euro === null ? null : new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(euro / 100);
  const rate = foreign.rate ? `1 euro = ${foreign.rate.toLocaleString('nl-NL', { maximumFractionDigits: 4 })} ${name}` : null;
  return (
    <div className="notice small">
      Deze bon is in <strong>{name}</strong>: {formatForeign(foreign.total, foreign.currency)}.{' '}
      {foreign.source === 'bank' && eur && <>Van je rekening is <strong>{eur}</strong> afgeschreven ({rate}). Dat bedrag komt in de boekhouding.</>}
      {foreign.source === 'ecb' && eur && (
        <>Omgerekend met de koers van de Europese Centrale Bank{foreign.rateDate ? ` van ${formatDateNl(foreign.rateDate)}` : ''}: <strong>{eur}</strong> ({rate}). Komt de betaling later op de bank, dan koppelt de app hem en boekt hij een klein verschil als koersverschil.</>
      )}
      {!foreign.source && <>De koers kon niet opgehaald worden. Vul hieronder het bedrag in euro's in, zoals het van je rekening is afgeschreven.</>}
    </div>
  );
}

/**
 * De vraag die eerst een antwoord nodig heeft (#179), met wat er al staat ernaast: het andere document,
 * of (als daar geen document bij is) de aankoop of betaling zelf. Ja: de bon komt erbij als bewijs of
 * kopie en er wordt niets geboekt. Nee: het voorstel vervalt en je controleert de bon als nieuwe
 * aankoop. Later: er verandert niets.
 */
function ProposalChoice({ doc: d, proposal, question, onDone }: { doc: IntakeDocument; proposal: PendingProposal; question: string; onDone: () => Promise<void> }) {
  const { go } = useApp();
  const { run, busy } = useAction();
  const evidence = proposal.kind === 'evidence';
  const r = d.result;
  return (
    <div className="card" style={{ marginTop: 12 }} data-testid="voorstel">
      <strong>{question}</strong>
      <p className="small" style={{ margin: '6px 0 10px' }}>
        {evidence
          ? 'De kosten en de btw van deze betaling staan al in je boekhouding. Kies je "Ja", dan wordt de bon alleen bij die betaling bewaard: er komt geen nieuwe kosten- of btw-boeking bij.'
          : 'Kies je "Ja", dan blijven beide bestanden bewaard en wordt het best leesbare het bewijs. Er wordt niets opnieuw geboekt.'}
      </p>
      <div className="grid cols-2">
        <div>
          <h3 style={{ marginTop: 0 }}>Deze bon</h3>
          <table className="list details"><tbody>
            <tr><th>Winkel / leverancier</th><td>{r?.supplier?.value ?? d.original_name}</td></tr>
            <tr><th>Datum</th><td>{r?.invoiceDate?.value ? formatDateNl(r.invoiceDate.value) : '?'}</td></tr>
            <tr><th>Bedrag</th><td>{r?.total ? <Euro cents={r.total.value} /> : '?'}</td></tr>
            <tr><th>Factuur- of bonnummer</th><td>{r?.invoiceNumber?.value ?? '—'}</td></tr>
          </tbody></table>
        </div>
        <div>
          <h3 style={{ marginTop: 0 }}>{evidence ? 'De betaling die al geboekt is' : 'Wat er al staat'}</h3>
          {proposal.target && <TargetDetails target={proposal.target} />}
          {proposal.documentId && <OtherDocument id={proposal.documentId} compact={!!proposal.target} />}
        </div>
      </div>
      <div className="row end" style={{ marginTop: 12 }}>
        <Button disabled={busy} onClick={() => go({ screen: 'aankopen' })}>Later</Button>
        <Button disabled={busy} onClick={async () => {
          if (await run(() => api.documents.decide(d.id, 'nee', proposal.candidate), 'Dit voorstel is weg. Controleer de bon hieronder.')) await onDone();
        }}>Nee, andere aankoop</Button>
        <Button kind="primary" disabled={busy} onClick={async () => {
          if (await run(() => api.documents.decide(d.id, 'ja', proposal.candidate), evidence ? 'Bewijs gekoppeld — niet opnieuw geboekt ✓' : 'Dubbel document — niet geboekt ✓')) await onDone();
        }}>{evidence ? 'Ja, alleen als bewijs' : 'Ja, dezelfde aankoop'}</Button>
      </div>
    </div>
  );
}

/**
 * Waar deze bon bij hoort (een aankoop of een bankbetaling), welke bestanden daar nog meer bij horen
 * en welke het hoofdbewijsstuk is. "Koppeling ongedaan maken" zet de bon terug naar "Nog controleren";
 * de aankoop of betaling zelf blijft precies zoals hij is.
 */
function LinkedTo({ doc: d, onChanged }: { doc: IntakeDocument; onChanged: () => Promise<void> }) {
  const { go } = useApp();
  const { run, busy } = useAction();
  const linked = useLoad(() => api.documents.linked(d.id), [d.id, d.link?.id]);
  const l = linked.data;
  if (!d.link && d.outcome === 'dubbel' && d.duplicate_of_document_id !== null) {
    // kopie van een document dat zelf nog niet geboekt is
    return (
      <div className="card" style={{ marginTop: 12 }} data-testid="koppeling">
        <strong>Dit is een kopie van een bon die er al in staat</strong>
        <p className="small" style={{ margin: '6px 0' }}>Beide bestanden zijn bewaard. Deze kopie wordt niet geboekt; de andere bon controleer je zoals altijd.</p>
        <div className="row" style={{ marginTop: 8 }}>
          <Button small onClick={() => go({ screen: 'document', id: d.duplicate_of_document_id! })}>Bekijk de andere bon</Button>
          <Button small kind="ghost" disabled={busy} onClick={async () => {
            if (await run(() => api.documents.unlink(d.id), 'De bon staat weer bij "Nog controleren".')) await onChanged();
          }}>Toch geen kopie</Button>
        </div>
      </div>
    );
  }
  if (!d.link || !l?.target) return null;
  const others = l.files.filter((f) => f.document_id !== d.id);
  return (
    <div className="card" style={{ marginTop: 12 }} data-testid="koppeling">
      <strong>Hoort bij {l.target.label}</strong>
      <p className="small" style={{ margin: '6px 0' }}>
        {d.link.is_primary ? 'Dit bestand is het hoofdbewijsstuk: het gaat mee in het pakket voor je boekhouder.' : 'Dit bestand is bewaard als extra bewijs. Een ander bestand is het hoofdbewijsstuk.'}
      </p>
      {others.length > 0 && (
        <table className="list small"><tbody>
          {others.map((f) => (
            <tr key={f.document_id}>
              <td>{f.original_name}{f.is_primary ? ' · hoofdbewijsstuk' : ''}</td>
              <td style={{ textAlign: 'right' }}><Button small kind="ghost" onClick={() => go({ screen: 'document', id: f.document_id })}>Bekijken</Button></td>
            </tr>
          ))}
        </tbody></table>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <Button small onClick={() => go(l.target!.kind === 'aankoop' ? { screen: 'aankopen' } : { screen: 'categorie', id: l.target!.id })}>{l.target.kind === 'aankoop' ? 'Naar de aankoop' : 'Naar de betaling'}</Button>
        {d.link.origin === 'geboekt' ? (
          <span className="small muted">De aankoop is uit deze bon geboekt. Klopt hij niet? Haal de aankoop dan weg bij Aankopen.</span>
        ) : (
          <Button small kind="ghost" disabled={busy} onClick={async () => {
            if (!confirm('Koppeling ongedaan maken? De bon gaat terug naar "Nog controleren". Aan de aankoop of betaling zelf verandert niets: de kosten, de btw en de boeking blijven staan.')) return;
            if (await run(() => api.documents.unlink(d.id), 'Koppeling ongedaan gemaakt. De bon staat bij "Nog controleren".')) await onChanged();
          }}>Koppeling ongedaan maken</Button>
        )}
      </div>
    </div>
  );
}

/**
 * Een bon of factuur bekijken vanaf Vandaag, voordat je "Ja, klopt" of "Ja, dezelfde aankoop" kiest. Bij
 * een voorstel staat ernaast wat er al is: het andere document, of de aankoop of betaling.
 */
export function DocumentPreview({ id }: { id: number }) {
  const { meta } = useApp();
  const doc = useLoad(() => api.documents.get(id), [id]);
  const pending = useLoad(() => api.documents.pending(id), [id]);
  const d = doc.data;
  if (!d) return <ErrorBox error={doc.error} />;
  const r = d.result;
  const dup = pending.data ?? null;
  const category = d.classification ? meta.expenseCategories.find((c) => c.key === d.classification!.categoryKey)?.label : null;
  return (
    <div className="grid" style={{ gridTemplateColumns: dup ? '1fr 1fr' : '1fr', gap: 12 }}>
      <div>
        {dup && <h3 style={{ marginTop: 0 }}>Deze</h3>}
        <table className="list details"><tbody>
          <tr><th>Winkel / leverancier</th><td>{r?.supplier?.value ?? d.original_name}</td></tr>
          <tr><th>Datum</th><td>{r?.invoiceDate?.value ? formatDateNl(r.invoiceDate.value) : '?'}</td></tr>
          <tr><th>Bedrag</th><td>{r?.total ? <Euro cents={r.total.value} /> : '?'}</td></tr>
          {r?.invoiceNumber?.value && <tr><th>Factuurnummer</th><td>{r.invoiceNumber.value}</td></tr>}
          {category && <tr><th>Voorstel</th><td>{category}{d.classification?.business === false ? ' (privé)' : ''}</td></tr>}
          <tr><th>Bestand</th><td>{d.original_name}</td></tr>
        </tbody></table>
        <div style={{ maxHeight: 420, overflow: 'auto', marginTop: 8 }}>
          <DocumentView id={d.id} mime={d.mime_type} highlight={null} pageSizes={r?.pageSizes} />
        </div>
      </div>
      {dup && (
        <div>
          <h3 style={{ marginTop: 0 }}>{dup.kind === 'evidence' ? 'De betaling die al geboekt is' : 'Lijkt op'}</h3>
          {dup.target && <TargetDetails target={dup.target} />}
          {dup.documentId && <OtherDocument id={dup.documentId} compact={!!dup.target} />}
        </div>
      )}
    </div>
  );
}

/** Het document dat er al is; `compact`: de gegevens van de aankoop of betaling staan er al boven. */
function OtherDocument({ id, compact }: { id: number; compact?: boolean }) {
  const doc = useLoad(() => api.documents.get(id), [id]);
  const d = doc.data;
  if (!d) return <ErrorBox error={doc.error} />;
  const r = d.result;
  return (
    <>
      <table className="list details"><tbody>
        {!compact && <tr><th>Winkel / leverancier</th><td>{r?.supplier?.value ?? d.original_name}</td></tr>}
        {!compact && <tr><th>Datum</th><td>{r?.invoiceDate?.value ? formatDateNl(r.invoiceDate.value) : '?'}</td></tr>}
        {!compact && <tr><th>Bedrag</th><td>{r?.total ? <Euro cents={r.total.value} /> : '?'}</td></tr>}
        <tr><th>Bestand</th><td>{d.original_name}</td></tr>
      </tbody></table>
      <div style={{ maxHeight: 420, overflow: 'auto', marginTop: 8 }}>
        <DocumentView id={d.id} mime={d.mime_type} highlight={null} pageSizes={r?.pageSizes} />
      </div>
    </>
  );
}
