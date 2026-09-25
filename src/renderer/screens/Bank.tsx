import { useState } from 'react';
import { api } from '../api';
import { Button, DateNl, DropZone, Empty, ErrorBox, Euro, Field, Modal, MoneyInput, StatusPill, readAsText, useAction, useApp, useLoad } from '../ui';
import type { CsvMapping } from '../../import/csv';
import type { PurchaseVatCode } from '../../shared/vat';

export function Bank({ focus }: { focus?: number }) {
  const { go, toast } = useApp();
  const { run } = useAction();
  const [view, setView] = useState<'hulp' | 'alles'>('hulp');
  const txs = useLoad(() => api.bank.transactions(view === 'hulp' ? { status: 'nieuw' } : {}), [view]);
  const accounts = useLoad(() => api.bank.accounts());
  const [mapping, setMapping] = useState<{ filename: string; content: string; headers: string[]; rows: Record<string, string>[]; suggested: CsvMapping | null } | null>(null);
  const [last, setLast] = useState<{ imported: number; duplicates: number; autoMatched: number } | null>(null);
  const [opening, setOpening] = useState(false);

  const importFile = async (file: File) => {
    const content = await readAsText(file);
    const preview = await run(() => api.bank.previewFile(file.name, content));
    if (!preview) return;
    if (preview.format === 'onbekend') return toast('Dit bestand herkennen we niet. Gebruik CSV, MT940 of CAMT.053.', 'error');
    if (preview.format === 'csv' && !preview.csv?.detectedBank && !preview.savedMapping) {
      return setMapping({ filename: file.name, content, headers: preview.csv!.headers, rows: preview.csv!.rows, suggested: preview.csv!.suggestedMapping });
    }
    await doImport(file.name, content, preview.savedMapping ?? undefined);
  };

  const doImport = async (filename: string, content: string, m?: CsvMapping) => {
    const r = await run(() => api.bank.importFile(filename, content, m));
    if (!r) return;
    setLast(r);
    if (r.warnings.length) toast(`${r.warnings.length} regels overgeslagen: ${r.warnings[0]}`, 'error');
    await txs.reload();
  };

  const help = (txs.data ?? []).filter((t) => t.status === 'nieuw').length;

  return (
    <div className="page">
      <div className="row between">
        <div>
          <h1>Bank</h1>
          <p className="sub">Lees je bankafschrift in; wij koppelen betalingen aan facturen en bonnetjes.</p>
        </div>
        <div className="row">
          <Button onClick={() => void run(async () => { const r = await api.home.autoProcess(); toast(`${r.matched + r.booked} betalingen automatisch verwerkt`); await txs.reload(); })}>Opnieuw controleren</Button>
        </div>
      </div>

      <DropZone accept=".csv,.txt,.sta,.940,.mt940,.xml" onFile={(f) => void importFile(f)}>
        <div style={{ fontSize: 30 }}>🏦</div>
        <strong>Sleep je bankafschrift hierheen</strong>
        <div className="small">CSV, MT940 of CAMT.053 — te downloaden in je internetbankieren</div>
      </DropZone>

      {last && (
        <div className="notice good" style={{ marginTop: 14 }}>
          {last.imported + last.duplicates} betalingen gecontroleerd{last.duplicates ? ` (${last.duplicates} hadden we al)` : ''}. {last.autoMatched} automatisch verwerkt.{' '}
          {help > 0 ? `Bij ${help} hebben we je hulp nodig.` : 'Alles is verwerkt ✓'}
        </div>
      )}

      <div className="row" style={{ margin: '20px 0 12px' }}>
        <div className="chips">
          <button className={view === 'hulp' ? 'selected' : ''} onClick={() => setView('hulp')}>Hulp nodig</button>
          <button className={view === 'alles' ? 'selected' : ''} onClick={() => setView('alles')}>Alle betalingen</button>
        </div>
      </div>
      <ErrorBox error={txs.error} />
      {(txs.data ?? []).length === 0 ? (
        <Empty icon="✓" title={view === 'hulp' ? 'Alle betalingen zijn verwerkt' : 'Nog geen betalingen ingelezen'} />
      ) : (
        <table className="list">
          <thead><tr><th>Datum</th><th>Wie</th><th>Omschrijving</th><th>Status</th><th className="num">Bedrag</th></tr></thead>
          <tbody>
            {txs.data!.map((t) => (
              <tr key={t.id} className="clickable" style={t.id === focus ? { outline: '2px solid var(--primary)' } : undefined} onClick={() => go({ screen: 'categorie', id: t.id })}>
                <td><DateNl date={t.transaction_date} /></td>
                <td>{t.counter_name ?? '—'}</td>
                <td className="small muted" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description}</td>
                <td><StatusPill status={t.status} /></td>
                <td className="num" style={{ color: t.amount > 0 ? 'var(--good)' : undefined }}><Euro cents={t.amount} sign /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Rekeningen</h2>
      <table className="list">
        <tbody>
          {(accounts.data ?? []).map((a) => (
            <tr key={a.id}><td>{a.name}</td><td>{a.iban ?? <span className="muted">nog onbekend</span>}</td></tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 10 }}>
        <Button small onClick={() => setOpening(true)}>Beginsaldo invoeren</Button>
        <span className="small muted">Een directe bankkoppeling (live) volgt in een latere versie.</span>
      </div>

      {mapping && <CsvMappingDialog {...mapping} onClose={() => setMapping(null)} onConfirm={async (m) => { const x = mapping; setMapping(null); await doImport(x.filename, x.content, m); }} />}
      {opening && accounts.data?.[0] && <OpeningBalance accountId={accounts.data[0].id} onClose={() => setOpening(false)} />}
    </div>
  );
}

function OpeningBalance({ accountId, onClose }: { accountId: number; onClose: () => void }) {
  const { run, busy } = useAction();
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(`${new Date().getFullYear()}-01-01`);
  return (
    <Modal title="Beginsaldo" onClose={onClose}>
      <p className="muted small">Hoeveel stond er op je zakelijke rekening op de dag dat je met deze administratie begint?</p>
      <div className="grid cols-2">
        <Field label="Datum"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Saldo"><MoneyInput value={amount} onChange={setAmount} /></Field>
      </div>
      <div className="row end" style={{ marginTop: 14 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={busy || amount === null} onClick={async () => { if ((await run(() => api.bank.openingBalance(accountId, amount!, date), 'Beginsaldo opgeslagen')) !== undefined) onClose(); }}>Opslaan</Button>
      </div>
    </Modal>
  );
}

function CsvMappingDialog({ headers, rows, suggested, onClose, onConfirm }: { headers: string[]; rows: Record<string, string>[]; suggested: CsvMapping | null; onClose: () => void; onConfirm: (m: CsvMapping) => void }) {
  const [m, setM] = useState<CsvMapping>(suggested ?? { date: headers[0] ?? '', amount: headers[1] ?? '', dateFormat: 'DD-MM-YYYY', description: [] });
  const col = (key: keyof CsvMapping, label: string, optional = true) => (
    <Field label={label}>
      <select value={(m[key] as string) ?? ''} onChange={(e) => setM({ ...m, [key]: e.target.value || undefined })}>
        {optional && <option value="">—</option>}
        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
    </Field>
  );
  return (
    <Modal title="Welke kolom is wat?" wide onClose={onClose}>
      <p className="muted small">We kennen dit bestand nog niet. Wijs één keer de kolommen aan; daarna onthouden we het.</p>
      <div className="grid cols-3">
        {col('date', 'Datum', false)}
        <Field label="Datumformaat">
          <select value={m.dateFormat} onChange={(e) => setM({ ...m, dateFormat: e.target.value })}>
            {['DD-MM-YYYY', 'YYYY-MM-DD', 'YYYYMMDD', 'DD/MM/YYYY', 'D-M-YYYY'].map((f) => <option key={f}>{f}</option>)}
          </select>
        </Field>
        {col('amount', 'Bedrag')}
        {col('debitCredit', 'Af/Bij-kolom (als het bedrag geen min-teken heeft)')}
        {col('counterName', 'Naam tegenpartij')}
        {col('counterIban', 'Rekening tegenpartij')}
        {col('reference', 'Betalingskenmerk')}
        <Field label="Omschrijving">
          <select value={m.description?.[0] ?? ''} onChange={(e) => setM({ ...m, description: e.target.value ? [e.target.value] : [] })}>
            <option value="">—</option>
            {headers.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        </Field>
      </div>
      <h3 style={{ marginTop: 16 }}>Voorbeeld</h3>
      <div style={{ overflowX: 'auto' }}>
        <table className="list small">
          <thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{rows.slice(0, 4).map((r, i) => <tr key={i}>{headers.map((h) => <td key={h}>{r[h]}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <div className="row end" style={{ marginTop: 14 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={!m.date || !(m.amount || m.amountDebit)} onClick={() => onConfirm(m)}>Inlezen</Button>
      </div>
    </Modal>
  );
}

/** Categoriekeuze in mensentaal (kosten + overige bestemmingen). */
export function CategoryPicker({ initial, onPick, incoming }: { initial?: string; onPick: (categoryKey: string, vatCode: string) => void; incoming?: boolean }) {
  const { meta } = useApp();
  const [cat, setCat] = useState(initial ?? 'materiaal');
  const [vat, setVat] = useState<PurchaseVatCode>(meta.expenseCategories.find((c) => c.key === (initial ?? 'materiaal'))?.defaultVat ?? 'hoog');
  return (
    <div className="grid">
      <Field label={incoming ? 'Waar was dit geld voor?' : 'Waar was deze betaling voor?'}>
        <div className="chips">
          {meta.expenseCategories.map((c) => (
            <button key={c.key} className={cat === c.key ? 'selected' : ''} title={c.hint} onClick={() => { setCat(c.key); setVat(c.defaultVat); }}>{c.label}</button>
          ))}
        </div>
      </Field>
      <Field label="Stond er BTW op?">
        <select value={vat} onChange={(e) => setVat(e.target.value as PurchaseVatCode)}>
          {meta.purchaseVat.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}
        </select>
      </Field>
      <div className="row end"><Button kind="primary" onClick={() => onPick(cat, vat)}>Opslaan</Button></div>
    </div>
  );
}

export function CategorizeTransaction({ id }: { id: number }) {
  const { go, meta } = useApp();
  const { run, busy } = useAction();
  const txs = useLoad(() => api.bank.transactions({}), [id]);
  const suggestions = useLoad(() => api.bank.suggestions(id), [id]);
  const openInvoices = useLoad(() => api.invoices.list({ status: 'openstaand' }));
  const overdue = useLoad(() => api.invoices.list({ status: 'vervallen' }));
  const t = txs.data?.find((x) => x.id === id);
  if (!t) return <div className="page"><ErrorBox error={txs.error} /></div>;
  const done = async (p: Promise<unknown>) => {
    if ((await run(() => p, 'Verwerkt ✓')) !== undefined) go({ screen: 'bank' });
  };
  const invoices = [...(overdue.data ?? []), ...(openInvoices.data ?? [])];
  return (
    <div className="page-narrow">
      <div className="row between">
        <h1><Euro cents={t.amount} sign /> {t.amount > 0 ? 'ontvangen' : 'betaald'}</h1>
        <Button kind="ghost" onClick={() => go({ screen: 'bank' })}>← Bank</Button>
      </div>
      <p className="sub">{t.counter_name ?? 'Onbekend'} · <DateNl date={t.transaction_date} /> · {t.description}</p>

      {t.status !== 'nieuw' ? (
        <div className="card">
          <StatusPill status={t.status} />
          <p className="muted small">Verkeerd verwerkt? Maak het ongedaan; er wordt netjes een correctie geboekt.</p>
          <Button onClick={() => void done(api.bank.unmatch(t.id))}>Ongedaan maken</Button>
        </div>
      ) : (
        <>
          {(suggestions.data ?? []).filter((s) => s.kind !== 'rekening').length > 0 && (
            <>
              <h2>Hoort dit hierbij?</h2>
              <div className="choice">
                {suggestions.data!.filter((s) => s.kind !== 'rekening').map((s) => (
                  <button key={s.label} disabled={busy} onClick={() => void done(s.kind === 'factuur' ? api.bank.matchInvoice(t.id, s.invoiceId) : s.kind === 'inkoop' ? api.bank.matchPurchase(t.id, s.purchaseId) : Promise.resolve())}>
                    {s.label}
                    <div className="hint">{s.reasons.join(' · ')}</div>
                  </button>
                ))}
              </div>
            </>
          )}

          {t.amount > 0 ? (
            <>
              <h2>Waar is dit geld voor?</h2>
              {invoices.length > 0 && (
                <Field label="Betaling van een factuur">
                  <select defaultValue="" onChange={(e) => e.target.value && void done(api.bank.matchInvoice(t.id, Number(e.target.value)))}>
                    <option value="">Kies de factuur…</option>
                    {invoices.map((i) => <option key={i.id} value={i.id}>{i.number} — {i.relation_name} — {(i.open_amount / 100).toFixed(2).replace('.', ',')}</option>)}
                  </select>
                </Field>
              )}
              <div className="choice" style={{ marginTop: 12 }}>
                {meta.otherDestinations.filter((d) => ['prive-storting', 'omzet', 'btw', 'overboeking', 'onbekend'].includes(d.key)).map((d) => (
                  <button key={d.key} disabled={busy} onClick={() => void done(api.bank.book(t.id, { account: d.account, vatCode: d.key === 'omzet' ? 'hoog' : undefined }))}>{d.label}</button>
                ))}
              </div>
            </>
          ) : (
            <>
              <h2>Was dit zakelijk?</h2>
              <div className="card">
                <CategoryPicker
                  key={String(suggestions.data?.length)}
                  initial={(() => {
                    const s = (suggestions.data ?? []).find((x) => x.kind === 'rekening');
                    return s && s.kind === 'rekening' ? meta.expenseCategories.find((c) => c.account === s.account)?.key : undefined;
                  })()}
                  onPick={(categoryKey, vatCode) => void done(api.home.act({ key: '', kind: 'bank-business', icon: '', title: '', question: '', actions: [], ref: { bankTransactionId: t.id } }, 'zakelijk', { categoryKey, vatCode }))}
                />
              </div>
              <div className="choice" style={{ marginTop: 12 }}>
                <button disabled={busy} onClick={() => void done(api.home.act({ key: '', kind: 'bank-business', icon: '', title: '', question: '', actions: [], ref: { bankTransactionId: t.id } }, 'prive'))}>Nee, dit was privé</button>
                {meta.otherDestinations.filter((d) => ['btw', 'overboeking', 'onbekend'].includes(d.key)).map((d) => (
                  <button key={d.key} disabled={busy} onClick={() => void done(api.bank.book(t.id, { account: d.account }))}>{d.label}</button>
                ))}
              </div>
            </>
          )}
          <div className="row end" style={{ marginTop: 16 }}>
            <Button kind="ghost" onClick={() => void done(api.bank.ignore(t.id))} title="Bijvoorbeeld een dubbele regel">Negeren</Button>
          </div>
        </>
      )}
    </div>
  );
}
