import { useState } from 'react';
import { api } from '../api';
import { Button, DateNl, DropZone, Empty, ErrorBox, Euro, Field, Modal, MoneyInput, StatusPill, readAsText, useAction, useApp, useLoad } from '../ui';
import type { CsvMapping } from '../../import/csv';
import type { PurchaseVatCode } from '../../shared/vat';
import { InvestmentHint, investmentInfo } from './Purchases';
import { CategoryChips } from './Categories';
import { diffDays, formatDateNl, toIsoDate, today } from '../../shared/dates';

/** SQLite-tijdstip (UTC) → lokale datum en tijd, bv. "25 september 2026, 23:10". */
function formatDateTime(sqlite: string): string {
  const d = new Date(`${sqlite.replace(' ', 'T')}Z`);
  return `${formatDateNl(toIsoDate(d))}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function staleDays(date: string): number {
  return diffDays(date, today());
}

export function Bank({ focus }: { focus?: number }) {
  const { go, toast, settings } = useApp();
  const { run } = useAction();
  const [view, setView] = useState<'hulp' | 'alles'>('hulp');
  const txs = useLoad(() => api.bank.transactions(view === 'hulp' ? { status: 'nieuw' } : {}), [view]);
  const accounts = useLoad(() => api.bank.accounts());
  const status = useLoad(() => api.bank.importStatus());
  const [mapping, setMapping] = useState<{ filename: string; content: string; headers: string[]; rows: Record<string, string>[]; suggested: CsvMapping | null } | null>(null);
  const [last, setLast] = useState<{ imported: number; duplicates: number; autoMatched: number; periods: { from: string; to: string }[] } | null>(null);
  const [opening, setOpening] = useState<{ id: number; name: string } | null>(null);
  const [editing, setEditing] = useState<{ id: number; name: string; iban: string | null } | 'nieuw' | null>(null);

  const importFile = async (file: File) => {
    const content = await readAsText(file);
    const preview = await run(() => api.bank.previewFile(file.name, content));
    if (!preview) return;
    if (preview.format === 'onbekend') return toast('Dit bestand herkennen we niet. Download bij je bank een afschrift als CSV-, MT940- of CAMT-bestand (in je internetbankieren bij \'downloaden\' of \'exporteren\').', 'error');
    if (preview.format === 'csv' && !preview.csv?.detectedBank && !preview.savedMapping) {
      return setMapping({ filename: file.name, content, headers: preview.csv!.headers, rows: preview.csv!.rows, suggested: preview.csv!.suggestedMapping });
    }
    await doImport(file.name, content, preview.savedMapping ?? undefined);
  };

  const doImport = async (filename: string, content: string, m?: CsvMapping) => {
    const r = await run(() => api.bank.importFile(filename, content, m));
    if (!r) return;
    setLast(r);
    await status.reload();
    if (r.warnings.length) toast(`${r.warnings.length} ${r.warnings.length === 1 ? 'regel kon' : 'regels konden'} we niet lezen (bv. ${r.warnings[0]!.charAt(0).toLowerCase()}${r.warnings[0]!.slice(1)})`, 'error');
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
          <Button onClick={() => void run(async () => { const r = await api.home.autoProcess(); toast(`${r.matched + r.booked} betalingen automatisch verwerkt`); await txs.reload(); })}>Opnieuw automatisch uitzoeken</Button>
        </div>
      </div>

      <DropZone accept=".csv,.txt,.sta,.940,.mt940,.xml" onFile={(f) => void importFile(f)}>
        <div style={{ fontSize: 30 }}>🏦</div>
        <strong>Sleep je bankafschrift hierheen</strong>
        <div className="small">Download het bij je bank: internetbankieren → afschrift downloaden (CSV, MT940 of CAMT)</div>
      </DropZone>

      {last && (
        <div className="notice good" style={{ marginTop: 14 }}>
          {last.periods.length > 0 && <>Afschrift van <DateNl date={last.periods.map((p) => p.from).sort()[0]} /> t/m <DateNl date={last.periods.map((p) => p.to).sort().at(-1)} />: </>}
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

      <div className="row between" style={{ marginTop: 24 }}>
        <h2 style={{ margin: 0 }}>Rekeningen</h2>
        <Button small onClick={() => setEditing('nieuw')}>+ Rekening toevoegen</Button>
      </div>
      <p className="small muted">Heb je een spaarrekening of een potje voor de btw? Voeg hem toe. Geld dat je tussen je eigen rekeningen verplaatst, telt dan niet als omzet of kosten.</p>
      <ErrorBox error={status.error} />
      <table className="list">
        <thead><tr><th>Rekening</th><th>Laatst ingelezen</th><th>Dat afschrift bevatte</th><th>Bijgewerkt t/m</th><th><span className="sr-only">Acties</span></th></tr></thead>
        <tbody>
          {(status.data ?? []).map((st) => (
            <tr key={st.bankAccountId}>
              <td>{st.name}{settings.vatPotAccountId === st.bankAccountId && <> <span className="pill">btw-potje</span></>}<div className="small muted">{st.iban ?? 'IBAN nog onbekend'}</div></td>
              <td>{st.lastImport ? <>{formatDateTime(st.lastImport.at)}<div className="small muted">{st.lastImport.filename ?? st.lastImport.source.toUpperCase()}</div></> : <span className="muted">nog nooit</span>}</td>
              <td>{st.lastImport ? <><DateNl date={st.lastImport.from} /> t/m <DateNl date={st.lastImport.to} /><div className="small muted">{st.lastImport.transactions} betalingen, {st.lastImport.imported} nieuw</div></> : '—'}</td>
              <td>{st.coverageTo ? <><DateNl date={st.coverageTo} />{staleDays(st.coverageTo) >= 14 && <div><span className="pill warn">{staleDays(st.coverageTo)} dagen geleden</span></div>}</> : '—'}</td>
              <td className="num" style={{ whiteSpace: 'nowrap' }}>
                <Button small kind="ghost" onClick={() => setEditing({ id: st.bankAccountId, name: st.name, iban: st.iban })}>Wijzigen</Button>
                <Button small kind="ghost" onClick={() => setOpening({ id: st.bankAccountId, name: st.name })}>Beginsaldo</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">Een nieuwe rekening komt er ook vanzelf bij als je een afschrift inleest met een rekeningnummer dat de app nog niet kent. Automatisch ophalen bij je bank komt later.</p>

      {mapping && <CsvMappingDialog {...mapping} onClose={() => setMapping(null)} onConfirm={async (m) => { const x = mapping; setMapping(null); await doImport(x.filename, x.content, m); }} />}
      {opening && <OpeningBalance accountId={opening.id} name={opening.name} onClose={() => setOpening(null)} />}
      {editing && <AccountDialog account={editing === 'nieuw' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await Promise.all([status.reload(), accounts.reload()]); }} />}
    </div>
  );
}

/** Rekening toevoegen of wijzigen: naam, IBAN, of het je btw-potje is en (bij nieuw) het beginsaldo. */
function AccountDialog({ account, onClose, onSaved }: { account: { id: number; name: string; iban: string | null } | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { settings, reloadSettings } = useApp();
  const { run, busy } = useAction();
  const [name, setName] = useState(account?.name ?? '');
  const [iban, setIban] = useState(account?.iban ?? '');
  const [pot, setPot] = useState(account ? settings.vatPotAccountId === account.id : false);
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(`${new Date().getFullYear()}-01-01`);
  const save = async () => {
    const ok = await run(async () => {
      const id = account ? (await api.bank.updateAccount(account.id, { name, iban: iban.trim() || null }), account.id) : (await api.bank.addAccount(name, iban)).id;
      if (!account && amount) await api.bank.openingBalance(id, amount, date);
      const potId = pot ? id : settings.vatPotAccountId === id ? null : settings.vatPotAccountId;
      if (potId !== settings.vatPotAccountId) {
        await api.settings.update({ vatPotAccountId: potId });
        await reloadSettings();
      }
      return true;
    }, account ? 'Rekening opgeslagen' : 'Rekening toegevoegd');
    if (ok) await onSaved();
  };
  return (
    <Modal title={account ? 'Rekening wijzigen' : 'Rekening toevoegen'} onClose={onClose}>
      <div className="grid cols-2">
        <Field label="Naam" hint="zoals jij hem noemt"><input value={name} placeholder="bv. Spaarrekening" onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Rekeningnummer (IBAN)" hint="zo herkent de app betalingen van en naar deze rekening"><input value={iban} placeholder="NL00 BANK 0123 4567 89" onChange={(e) => setIban(e.target.value)} /></Field>
      </div>
      {!settings.kor && (
        <label className="row" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={pot} onChange={(e) => setPot(e.target.checked)} /> Hier zet ik geld opzij voor de btw (btw-potje)
        </label>
      )}
      {pot && <p className="small muted">Op Vandaag zie je dan hoeveel je al opzij hebt gezet en hoeveel er nog bij moet.</p>}
      {!account && (
        <>
          <h3>Staat er al geld op?</h3>
          <p className="small muted">Vul in wat erop stond op de dag dat je met deze administratie begint. Leeg laten mag ook.</p>
          <div className="grid cols-2">
            <Field label="Datum"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Saldo"><MoneyInput value={amount} onChange={setAmount} /></Field>
          </div>
        </>
      )}
      <div className="row end" style={{ marginTop: 14 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={busy || !name.trim() || (!account && !iban.trim())} onClick={() => void save()}>Opslaan</Button>
      </div>
    </Modal>
  );
}

function OpeningBalance({ accountId, name, onClose }: { accountId: number; name: string; onClose: () => void }) {
  const { run, busy } = useAction();
  const current = useLoad(() => api.bank.getOpeningBalance(accountId), [accountId]);
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(`${new Date().getFullYear()}-01-01`);
  return (
    <Modal title={`Beginsaldo ${name}`} onClose={onClose}>
      <p className="muted small">Hoeveel stond er op deze rekening op de dag dat je met deze administratie begint?</p>
      {current.data?.date && (
        <p className="small">Nu ingevuld: <Euro cents={current.data.amount} /> op <DateNl date={current.data.date} />. Een nieuw bedrag vervangt dit.</p>
      )}
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
            {([['DD-MM-YYYY', '31-12-2026'], ['YYYY-MM-DD', '2026-12-31'], ['YYYYMMDD', '20261231'], ['DD/MM/YYYY', '31/12/2026'], ['D-M-YYYY', '1-2-2026']] as const).map(([f, ex]) => <option key={f} value={f}>bv. {ex}</option>)}
          </select>
        </Field>
        {col('amount', 'Bedrag')}
        {col('debitCredit', 'Kolom met "Af" of "Bij" (alleen als bedragen geen min-teken hebben)')}
        {col('counterName', 'Naam (van of aan wie)')}
        {col('counterIban', 'Rekeningnummer (van of aan wie)')}
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
export function CategoryPicker({ initial, onPick, incoming, amount }: { initial?: string; onPick: (categoryKey: string, vatCode: string) => void; incoming?: boolean; /** betaald bedrag (positief), voor de investeringshint */ amount?: number }) {
  const { meta } = useApp();
  const [cat, setCat] = useState(initial ?? 'materiaal');
  const [vat, setVat] = useState<PurchaseVatCode>(meta.expenseCategories.find((c) => c.key === (initial ?? 'materiaal'))?.defaultVat ?? 'hoog');
  return (
    <div className="grid">
      <Field label={incoming ? 'Waar was dit geld voor?' : 'Waar was deze betaling voor?'}>
        <CategoryChips value={cat} onChange={(key, defaultVat) => { setCat(key); setVat(defaultVat); }} />
      </Field>
      {!incoming && <InvestmentHint categoryKey={cat} gross={amount} vatCode={vat} onUse={() => { setCat('investering'); setVat('hoog'); }} />}
      <Field label="Stond er btw op?">
        <select value={vat} onChange={(e) => setVat(e.target.value as PurchaseVatCode)}>
          {meta.purchaseVat.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}
        </select>
      </Field>
      <div className="row end"><Button kind="primary" onClick={() => onPick(cat, vat)}>Opslaan</Button></div>
    </div>
  );
}

export function CategorizeTransaction({ id }: { id: number }) {
  const { go, meta, showInvestmentSaved } = useApp();
  const { run, busy } = useAction();
  const txs = useLoad(() => api.bank.transactions({}), [id]);
  const suggestions = useLoad(() => api.bank.suggestions(id), [id]);
  const openInvoices = useLoad(() => api.invoices.list({ status: 'openstaand' }));
  const overdue = useLoad(() => api.invoices.list({ status: 'vervallen' }));
  const [recat, setRecat] = useState(false);
  const own = useLoad(() => api.bank.ownTransfer(id), [id]);
  const t = txs.data?.find((x) => x.id === id);
  if (!t) return <div className="page"><ErrorBox error={txs.error} /></div>;
  const done = async (p: Promise<unknown>, investment?: string) => {
    // ook acties die niets teruggeven (bv. ongedaan maken) tellen als gelukt als ze niet falen
    if ((await run(async () => { await p; return true; }, investment ? undefined : 'Verwerkt ✓')) !== undefined) {
      go({ screen: 'bank' });
      if (investment) showInvestmentSaved(investmentInfo(Math.abs(t.amount), investment));
    }
  };
  /** categorie gekozen: bij een investering daarna uitleg tonen (met de gekozen btw) */
  const inv = (categoryKey: string, vatCode: string) => (categoryKey === 'investering' ? vatCode : undefined);
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
          <p className="muted small">Verkeerd verwerkt? Maak het ongedaan; de app draait het netjes terug.</p>
          <div className="row">
            <Button onClick={() => void done(api.bank.unmatch(t.id))}>Ongedaan maken</Button>
            {t.status === 'gematcht' && !t.matched_invoice_id && !t.matched_purchase_invoice_id && t.amount < 0 && (
              <Button onClick={() => setRecat(!recat)}>Andere categorie</Button>
            )}
          </div>
          {recat && (
            <div style={{ marginTop: 12 }}>
              <CategoryPicker amount={Math.abs(t.amount)} onPick={(categoryKey, vatCode) => void done(api.bank.reclassify(t.id, categoryKey, vatCode), inv(categoryKey, vatCode))} />
              <p className="small muted">De app draait de oude keuze terug en verwerkt de nieuwe. Had je de btw-aangifte al gedaan? Dan komt het verschil vanzelf in je volgende aangifte.</p>
            </div>
          )}
        </div>
      ) : (
        <>
          {own.data && (
            <div className="card">
              <strong>{t.amount < 0 ? 'Naar' : 'Van'} je eigen rekening {own.data.name}</strong>
              <p className="small muted">Je hebt geld verplaatst tussen je eigen rekeningen. Dit is geen omzet en geen kosten. Lees je ook het afschrift van die andere rekening in, dan koppelt de app die kant er vanzelf aan.</p>
              <Button kind="primary" disabled={busy} onClick={() => void done(api.bank.bookOwnTransfer(t.id))}>Klopt, verwerk als overboeking</Button>
            </div>
          )}
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
                  amount={Math.abs(t.amount)}
                  key={String(suggestions.data?.length)}
                  initial={(() => {
                    const s = (suggestions.data ?? []).find((x) => x.kind === 'rekening');
                    return s && s.kind === 'rekening' ? (meta.expenseCategories.find((c) => c.account === s.account && !c.key.startsWith('eigen-')) ?? meta.expenseCategories.find((c) => c.account === s.account))?.key : undefined;
                  })()}
                  onPick={(categoryKey, vatCode) => void done(api.home.act({ key: '', kind: 'bank-business', icon: '', title: '', question: '', actions: [], ref: { bankTransactionId: t.id } }, 'zakelijk', { categoryKey, vatCode }), inv(categoryKey, vatCode))}
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
            <Button kind="ghost" onClick={() => void done(api.bank.ignore(t.id))} title="Bijvoorbeeld een dubbele regel">Negeren (dubbel of niet belangrijk)</Button>
          </div>
        </>
      )}
    </div>
  );
}
