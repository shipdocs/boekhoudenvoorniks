import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Button, DateNl, ErrorBox, Euro, Field, Modal, MoneyInput, StatusPill, useAction, useApp, useLoad } from '../ui';
import { computeTotals, type LineInput } from '../../documents/totals';
import { addDays, today } from '../../shared/dates';
import type { SalesVatCode } from '../../shared/vat';
import { QuickCustomer } from './Customers';

interface EditLine {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: number | null;
  vatCode: SalesVatCode;
}

const toNumber = (s: string) => Number(s.replace(',', '.'));

export function DocumentEditor({ kind, id }: { kind: 'factuur' | 'offerte'; id?: number }) {
  const { go, meta, settings, toast } = useApp();
  const { run, busy } = useAction();
  const isInvoice = kind === 'factuur';
  const relations = useLoad(() => api.relations.list({ type: 'klant' }));
  const templates = useLoad(() => api.templates.list(kind));
  const doc = useLoad(async () => (id ? (isInvoice ? await api.invoices.get(id) : await api.quotes.get(id)) : null), [id]);
  const [newCustomer, setNewCustomer] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [payment, setPayment] = useState(false);
  const [sending, setSending] = useState(false);

  const defaultVat: SalesVatCode = settings.kor ? 'vrijgesteld' : settings.defaultVatCode;
  const trade = meta.trades.find((t) => t.key === settings.profile.trade);
  const [relationId, setRelationId] = useState<number | null>(null);
  const [date, setDate] = useState(today());
  const [secondDate, setSecondDate] = useState('');
  const [reference, setReference] = useState('');
  const [intro, setIntro] = useState('');
  const [notes, setNotes] = useState('');
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [lines, setLines] = useState<EditLine[]>([{ description: '', quantity: '1', unit: '', unitPrice: null, vatCode: defaultVat }]);

  useEffect(() => {
    const d = doc.data;
    if (!d) return;
    setRelationId(d.relation_id);
    setDate('invoice_date' in d ? d.invoice_date : d.quote_date);
    setSecondDate('due_date' in d ? d.due_date : d.valid_until);
    setReference(d.reference ?? '');
    setIntro(d.intro ?? '');
    setNotes(d.notes ?? '');
    setTemplateId(d.template_id);
    setLines(d.lines.map((l) => ({ description: l.description, quantity: String(l.quantity).replace('.', ','), unit: l.unit ?? '', unitPrice: l.unit_price, vatCode: l.vat_code as SalesVatCode })));
  }, [doc.data]);

  const editable = !doc.data || (isInvoice ? doc.data.status === 'concept' : ['concept', 'verzonden'].includes(doc.data.status));
  const lineInputs: LineInput[] = lines
    .filter((l) => l.description.trim() && l.unitPrice !== null && Number.isFinite(toNumber(l.quantity)) && toNumber(l.quantity) !== 0)
    .map((l) => ({ description: l.description, quantity: toNumber(l.quantity), unit: l.unit || null, unitPrice: l.unitPrice!, vatCode: l.vatCode }));
  const totals = useMemo(() => computeTotals(lineInputs.length ? lineInputs : []), [JSON.stringify(lineInputs)]); // eslint-disable-line react-hooks/exhaustive-deps

  const setLine = (i: number, patch: Partial<EditLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const save = async (): Promise<number | undefined> => {
    if (!relationId) {
      toast('Kies eerst een klant', 'error');
      return;
    }
    const payload = {
      relationId,
      reference: reference || null,
      intro: intro || null,
      notes: notes || null,
      templateId,
      lines: lineInputs,
    };
    const r = await run(async () => {
      if (isInvoice) {
        const p = { ...payload, invoiceDate: date, dueDate: secondDate || undefined };
        return id ? api.invoices.updateDraft(id, p) : api.invoices.createDraft(p);
      }
      const p = { ...payload, quoteDate: date, validUntil: secondDate || undefined };
      return id ? api.quotes.update(id, p) : api.quotes.create(p);
    }, 'Opgeslagen');
    if (r && !id) go({ screen: kind, id: r.id });
    else await doc.reload();
    return r?.id;
  };

  const showPreview = async () => {
    const docId = editable ? await save() : id;
    if (!docId) return;
    const html = await run(() => (isInvoice ? api.invoices.html(docId) : api.quotes.html(docId)));
    if (html) setPreview(html);
  };

  const d = doc.data;
  const invoice = d && 'invoice_date' in d ? d : null;
  const quote = d && 'quote_date' in d ? d : null;

  return (
    <div className="page">
      <div className="row between">
        <div>
          <h1>
            {isInvoice ? (invoice?.totals.total ?? 0) < 0 ? 'Creditfactuur' : 'Factuur' : 'Offerte'} {d && 'number' in d && d.number ? d.number : id ? '(concept)' : ''}
          </h1>
          <p className="sub">
            {invoice && <StatusPill status={invoice.display_status} />} {quote && <StatusPill status={quote.status} />}{' '}
            {invoice && invoice.status !== 'concept' && invoice.open_amount > 0 && <>Nog open: <Euro cents={invoice.open_amount} /></>}
          </p>
        </div>
        <Button kind="ghost" onClick={() => go({ screen: 'werk', extra: { tab: isInvoice ? 'facturen' : 'offertes' } })}>← Terug</Button>
      </div>
      <ErrorBox error={doc.error} />

      <div className="card">
        <div className="grid cols-3">
          <Field label="Klant">
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <select className="grow" value={relationId ?? ''} disabled={!editable} onChange={(e) => setRelationId(Number(e.target.value) || null)}>
                <option value="">Kies een klant…</option>
                {(relations.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              {editable && <Button small onClick={() => setNewCustomer(true)}>+ Nieuw</Button>}
            </div>
          </Field>
          <Field label={isInvoice ? 'Factuurdatum' : 'Datum'}>
            <input type="date" value={date} disabled={!editable} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label={isInvoice ? 'Betalen vóór' : 'Geldig tot'} hint={isInvoice ? `standaard ${settings.paymentTermDays} dagen` : undefined}>
            <input type="date" value={secondDate || addDays(date, isInvoice ? settings.paymentTermDays : settings.quoteValidityDays)} disabled={!editable} onChange={(e) => setSecondDate(e.target.value)} />
          </Field>
        </div>
        <div className="grid cols-2" style={{ marginTop: 12 }}>
          <Field label="Omschrijving / klus" hint="bv. Woonkamer stucen">
            <input value={reference} disabled={!editable} onChange={(e) => setReference(e.target.value)} />
          </Field>
          <Field label="Opmaak">
            <select value={templateId ?? ''} disabled={!editable} onChange={(e) => setTemplateId(Number(e.target.value) || null)}>
              <option value="">Standaard</option>
              {(templates.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        </div>

        <h2>Wat heb je gedaan?</h2>
        <table className="lines-table" style={{ width: '100%' }}>
          <thead>
            <tr className="small muted"><td>Omschrijving</td><td style={{ width: 80 }}>Aantal</td><td style={{ width: 80 }}>Eenheid</td><td style={{ width: 120 }}>Prijs</td><td style={{ width: 150 }}>BTW</td><td style={{ width: 110 }} className="num">Totaal</td><td style={{ width: 36 }} /></tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const q = toNumber(l.quantity);
              const lineTotal = l.unitPrice !== null && Number.isFinite(q) ? Math.round(q * l.unitPrice) : null;
              return (
                <tr key={i}>
                  <td><input value={l.description} disabled={!editable} onChange={(e) => setLine(i, { description: e.target.value })} placeholder="bv. Stucwerk wanden" /></td>
                  <td><input className="num" value={l.quantity} disabled={!editable} onChange={(e) => setLine(i, { quantity: e.target.value })} /></td>
                  <td><input value={l.unit} disabled={!editable} onChange={(e) => setLine(i, { unit: e.target.value })} placeholder="m²" /></td>
                  <td>{editable ? <MoneyInput value={l.unitPrice} onChange={(v) => setLine(i, { unitPrice: v })} /> : <Euro cents={l.unitPrice} />}</td>
                  <td>
                    <select value={l.vatCode} disabled={!editable || settings.kor} onChange={(e) => setLine(i, { vatCode: e.target.value as SalesVatCode })}>
                      {meta.salesVat.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}
                    </select>
                  </td>
                  <td className="num"><Euro cents={lineTotal} /></td>
                  <td>{editable && lines.length > 1 && <Button kind="ghost" small title="Regel verwijderen" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</Button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {editable && (
          <div className="row" style={{ marginTop: 8 }}>
            <Button small onClick={() => setLines((ls) => [...ls, { description: '', quantity: '1', unit: '', unitPrice: null, vatCode: defaultVat }])}>+ Regel</Button>
            {trade?.items.map((it) => (
              <Button key={it.description} small kind="ghost" title={it.note} onClick={() => setLines((ls) => [...ls.filter((l) => l.description || l.unitPrice), { description: it.description, quantity: '1', unit: it.unit, unitPrice: null, vatCode: settings.kor ? 'vrijgesteld' : it.vatCode }])}>
                + {it.description}
              </Button>
            ))}
          </div>
        )}
        {lines.some((l) => l.vatCode === 'laag') && trade?.items.find((i) => i.note) && <p className="small muted">ℹ️ {trade.items.find((i) => i.note)!.note}</p>}
        {lines.some((l) => l.vatCode === 'verlegd') && <p className="small muted">ℹ️ Bij BTW verlegd moet het btw-nummer van je klant bekend zijn.</p>}

        <div className="row end" style={{ marginTop: 16 }}>
          <table className="sumtable">
            <tbody>
              <tr><td>Subtotaal</td><td><Euro cents={totals.subtotal} /></td></tr>
              {totals.groups.filter((g) => g.percentage > 0).map((g) => <tr key={g.vatCode}><td>BTW {g.percentage}%</td><td><Euro cents={g.vat} /></td></tr>)}
              <tr className="total"><td>Totaal</td><td><Euro cents={totals.total} /></td></tr>
            </tbody>
          </table>
        </div>

        <div className="grid cols-2" style={{ marginTop: 12 }}>
          <Field label="Tekst boven de regels" hint="optioneel"><textarea value={intro} disabled={!editable} onChange={(e) => setIntro(e.target.value)} /></Field>
          <Field label="Opmerking onderaan" hint="optioneel"><textarea value={notes} disabled={!editable} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        {editable && <Button kind={id ? undefined : 'primary'} disabled={busy} onClick={() => void save()}>Opslaan</Button>}
        <Button disabled={busy} onClick={() => void showPreview()}>Voorbeeld</Button>
        {id && <Button disabled={busy} onClick={() => void run(() => (isInvoice ? api.invoices.savePdf(id) : api.quotes.savePdf(id)), 'PDF opgeslagen')}>PDF opslaan</Button>}
        <span className="grow" />
        {isInvoice && invoice?.status === 'concept' && (
          <>
            <Button kind="danger" disabled={busy} onClick={async () => { if (confirm('Concept verwijderen?') && (await run(() => api.invoices.deleteDraft(invoice.id), 'Verwijderd')) !== undefined) go({ screen: 'werk' }); }}>Verwijderen</Button>
            <Button disabled={busy} onClick={async () => { if (confirm('Definitief maken zonder te mailen? Je kunt de factuur daarna niet meer wijzigen.')) { await run(() => api.invoices.finalize(invoice.id), 'Factuur is definitief'); await doc.reload(); } }}>Definitief maken</Button>
            <Button kind="primary" disabled={busy} onClick={async () => { const docId = await save(); if (docId) setSending(true); }}>Versturen</Button>
          </>
        )}
        {isInvoice && invoice && invoice.status !== 'concept' && (
          <>
            {!invoice.credit_of_invoice_id && invoice.total! > 0 && <Button disabled={busy} onClick={async () => { const c = await run(() => api.invoices.creditNote(invoice.id)); if (c) go({ screen: 'factuur', id: c.id }); }}>Crediteren</Button>}
            {invoice.status === 'verzonden' && invoice.open_amount > 0 && Math.abs(invoice.open_amount) <= 500 && invoice.amount_paid > 0 && <Button disabled={busy} onClick={async () => { await run(() => api.invoices.writeOff(invoice.id), 'Restbedrag afgeboekt'); await doc.reload(); }}>Restje afboeken</Button>}
            {invoice.display_status === 'vervallen' && <Button disabled={busy} onClick={async () => { await run(() => api.invoices.sendReminder(invoice.id), 'Herinnering verstuurd'); await doc.reload(); }}>Herinnering sturen</Button>}
            {invoice.status === 'verzonden' && <Button disabled={busy} onClick={() => setPayment(true)}>Betaling ontvangen</Button>}
            <Button kind="primary" disabled={busy} onClick={() => setSending(true)}>{invoice.sent_at ? 'Opnieuw versturen' : 'Versturen'}</Button>
          </>
        )}
        {quote && (
          <>
            {quote.status !== 'gefactureerd' && <Button kind="danger" disabled={busy} onClick={async () => { if (confirm('Offerte verwijderen?') && (await run(() => api.quotes.delete(quote.id), 'Verwijderd')) !== undefined) go({ screen: 'werk', extra: { tab: 'offertes' } }); }}>Verwijderen</Button>}
            {['concept', 'verzonden'].includes(quote.status) && <Button disabled={busy} onClick={async () => { await run(() => api.quotes.setStatus(quote.id, 'afgewezen')); await doc.reload(); }}>Afgewezen</Button>}
            {['concept', 'verzonden'].includes(quote.status) && <Button disabled={busy} onClick={async () => { const j = await run(() => api.jobs.acceptQuote(quote.id), 'Klant is akkoord — er staat een klus klaar'); if (j) go({ screen: 'klus', id: j.id }); }}>Klant is akkoord</Button>}
            {quote.status === 'geaccepteerd' && <Button disabled={busy} onClick={async () => { const inv = await run(() => api.quotes.convertToInvoice(quote.id)); if (inv) go({ screen: 'factuur', id: inv.id }); }}>Omzetten naar factuur</Button>}
            {quote.invoice_id && <Button onClick={() => go({ screen: 'factuur', id: quote.invoice_id! })}>Naar factuur</Button>}
            {['concept', 'verzonden'].includes(quote.status) && <Button kind="primary" disabled={busy} onClick={async () => { const docId = await save(); if (docId) setSending(true); }}>Versturen</Button>}
          </>
        )}
      </div>

      {invoice && invoice.status !== 'concept' && <EmailLog id={invoice.id} />}

      {newCustomer && (
        <QuickCustomer
          onClose={() => setNewCustomer(false)}
          onCreated={async (r) => {
            setNewCustomer(false);
            await relations.reload();
            setRelationId(r.id);
          }}
        />
      )}
      {preview && (
        <Modal title="Voorbeeld" wide onClose={() => setPreview(null)}>
          <iframe className="preview-frame" sandbox="" srcDoc={preview} title="Voorbeeld" />
        </Modal>
      )}
      {sending && id && (
        <SendDialog
          kind={kind}
          id={id}
          defaultTo={d?.relation_email ?? ''}
          onClose={() => setSending(false)}
          onSent={async () => {
            setSending(false);
            await doc.reload();
          }}
        />
      )}
      {payment && invoice && (
        <PaymentDialog
          invoiceId={invoice.id}
          open={invoice.open_amount}
          onClose={() => setPayment(false)}
          onDone={async () => {
            setPayment(false);
            await doc.reload();
          }}
        />
      )}
    </div>
  );
}

function SendDialog({ kind, id, defaultTo, onClose, onSent }: { kind: 'factuur' | 'offerte'; id: number; defaultTo: string; onClose: () => void; onSent: () => void }) {
  const { settings, go } = useApp();
  const { run, busy } = useAction();
  const [to, setTo] = useState(defaultTo);
  const smtpReady = !!settings.smtp.host && !!settings.smtp.fromEmail;
  return (
    <Modal title={kind === 'factuur' ? 'Factuur versturen' : 'Offerte versturen'} onClose={onClose}>
      {!smtpReady ? (
        <>
          <div className="notice warn">Stel eerst in via welk e-mailadres je verstuurt.</div>
          <div className="row end"><Button kind="primary" onClick={() => go({ screen: 'instellingen', extra: { tab: 'email' } })}>Naar e-mailinstellingen</Button></div>
        </>
      ) : (
        <>
          <Field label="Naar"><input type="email" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <p className="small muted">De {kind} gaat als PDF mee. {kind === 'factuur' && 'Na versturen is de factuur definitief en wordt hij automatisch in je boekhouding verwerkt.'}</p>
          <div className="row end">
            <Button onClick={onClose}>Annuleren</Button>
            <Button kind="primary" disabled={busy || !to} onClick={async () => {
              const r = await run<unknown>(() => (kind === 'factuur' ? api.invoices.send(id, { to }) : api.quotes.send(id, { to })), 'Verstuurd ✓');
              if (r) onSent();
            }}>{busy ? 'Bezig…' : 'Versturen'}</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

function PaymentDialog({ invoiceId, open, onClose, onDone }: { invoiceId: number; open: number; onClose: () => void; onDone: () => void }) {
  const { run, busy } = useAction();
  const [amount, setAmount] = useState<number | null>(open);
  const [date, setDate] = useState(today());
  const [how, setHow] = useState<'kas' | 'bank'>('kas');
  return (
    <Modal title="Betaling ontvangen" onClose={onClose}>
      <p className="muted small">Betaald via de bank? Dan hoef je niets te doen: als je je bankafschrift inleest, koppelen we de betaling automatisch.</p>
      <div className="grid cols-2">
        <Field label="Bedrag"><MoneyInput value={amount} onChange={setAmount} /></Field>
        <Field label="Datum"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <div className="chips" style={{ margin: '12px 0' }}>
        <button className={how === 'kas' ? 'selected' : ''} onClick={() => setHow('kas')}>Contant / pin bij mij</button>
        <button className={how === 'bank' ? 'selected' : ''} onClick={() => setHow('bank')}>Op de bank</button>
      </div>
      <div className="row end">
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={busy || !amount} onClick={async () => {
          const r = await run(() => (how === 'kas' ? api.invoices.paidCash(invoiceId, amount!, date) : api.invoices.registerPayment(invoiceId, { amount: amount!, date })), 'Betaling verwerkt');
          if (r) onDone();
        }}>Opslaan</Button>
      </div>
    </Modal>
  );
}

function EmailLog({ id }: { id: number }) {
  const log = useLoad(() => api.invoices.emailLog(id), [id]);
  if (!log.data?.length) return null;
  return (
    <>
      <h2>Verstuurd</h2>
      <table className="list">
        <tbody>
          {log.data.map((l) => (
            <tr key={l.id}>
              <td>{l.document_type === 'herinnering' ? 'Herinnering' : 'Factuur'}</td>
              <td>{l.recipient}</td>
              <td><DateNl date={l.sent_at.slice(0, 10)} /></td>
              <td>{l.status === 'verzonden' ? <span className="pill good">verstuurd</span> : <span className="pill bad" title={l.error ?? ''}>mislukt</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
