import { Fragment, useEffect, useState } from 'react';
import { api } from '../api';
import { Button, DateNl, DropZone, Empty, ErrorBox, Euro, Field, Modal, MoneyInput, StatusPill, readAsText, useAction, useApp, useLoad } from '../ui';
import type { CsvMapping } from '../../import/csv';
import { saleVatText, type PurchaseVatCode, type SalesVatCode } from '../../shared/vat';
import { referenceIn } from '../../shared/references';
import { InvestmentHint, investmentInfo } from './Purchases';
import { CategoryChips } from './Categories';
import { PaymentDetails, PaymentEvidence } from './PaymentDetails';
import { diffDays, formatDateNl, toIsoDate, today } from '../../shared/dates';
import { formatEuro } from '../../shared/money';
import { formatForeign } from '../../shared/currency';
import { PontoCard } from './PontoDialog';

/** SQLite-tijdstip (UTC) → lokale datum en tijd, bv. "25 september 2026, 23:10". */
function formatDateTime(sqlite: string): string {
  const d = new Date(`${sqlite.replace(' ', 'T')}Z`);
  return `${formatDateNl(toIsoDate(d))}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function staleDays(date: string): number {
  return diffDays(date, today());
}

export type ImportResult = Awaited<ReturnType<typeof api.bank.importFile>>;

/** "12 stonden er al (uit je afschrift van 1 t/m 15 september)": uit welk eerder afschrift, als dat er één is. */
function knownFromText(known: { from: string; to: string }[]): string {
  if (known.length === 0) return '';
  return known.length === 1 ? ` (uit je afschrift van ${formatDateNl(known[0]!.from)} t/m ${formatDateNl(known[0]!.to)})` : ' (uit eerdere afschriften)';
}

type BatchDouble = Awaited<ReturnType<typeof api.bank.doubles>>[number];
type PaymentDouble = Awaited<ReturnType<typeof api.bank.sameDoubles>>[number];

export function Bank({ focus, skippedFor, imported, double, same, bankFeed, feedAccountId }: { /** vanaf Vandaag: dit dubbele bedrag meteen laten zien */ double?: { lineId: number; firstPartId: number }; /** vanaf Vandaag: deze twee regels die dezelfde betaling lijken meteen laten zien */ same?: { firstId: number; secondId: number }; focus?: number; /** rekening waarvan de overgeslagen regels meteen open moeten (vanaf Vandaag: het saldo klopt niet) */ skippedFor?: number; /** net ingelezen vanaf Vandaag (afschrift uit de downloadmap): de samenvatting tonen */ imported?: ImportResult; bankFeed?: 'credentials'; feedAccountId?: number }) {
  const { go, toast, settings, refreshBadge, meta } = useApp();
  const { run } = useAction();
  const [view, setView] = useState<'hulp' | 'alles'>('hulp');
  // zoeken in naam, omschrijving en rekeningnummer; vertraagd zodat niet elke toets een zoekopdracht is
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 200);
    return () => clearTimeout(t);
  }, [search]);
  const txs = useLoad(() => api.bank.transactions({ ...(view === 'hulp' ? { status: 'nieuw' as const } : {}), ...(query ? { search: query } : {}) }), [view, query]);
  const accounts = useLoad(() => api.bank.accounts());
  const status = useLoad(() => api.bank.importStatus());
  const overview = useLoad(() => api.bank.balanceOverview());
  // verzamelbetalingen die er twee keer in staan (één regel én losse deelposten)
  const doubles = useLoad(() => api.bank.doubles());
  const [showDouble, setShowDouble] = useState<{ lineId: number; firstPartId: number } | null>(double ?? null);
  const openDouble = showDouble ? (doubles.data ?? []).find((d) => d.lineId === showDouble.lineId && d.firstPartId === showDouble.firstPartId) : undefined;
  // twee losse regels die dezelfde betaling lijken, uit verschillende imports (#225)
  const sames = useLoad(() => api.bank.sameDoubles());
  const [showSame, setShowSame] = useState<{ firstId: number; secondId: number } | null>(same ?? null);
  const openSame = showSame ? (sames.data ?? []).find((d) => d.firstId === showSame.firstId && d.secondId === showSame.secondId) : undefined;
  const [mapping, setMapping] = useState<{ filename: string; content: string; headers: string[]; rows: Record<string, string>[]; suggested: CsvMapping | null } | null>(null);
  const [last, setLast] = useState<ImportResult | null>(imported ?? null);
  // de regels die zijn overgeslagen omdat de betaling er al stond: van één import of van één rekening
  const [review, setReview] = useState<{ batchId?: number; bankAccountId?: number } | null>(skippedFor ? { bankAccountId: skippedFor } : null);
  const [opening, setOpening] = useState<{ id: number; name: string } | null>(null);
  const [editing, setEditing] = useState<{ id: number; name: string; iban: string | null; isPot: boolean } | 'nieuw' | null>(null);

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
    await Promise.all([status.reload(), doubles.reload(), sames.reload()]);
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
          {last.imported === 0 ? 'Geen nieuwe betalingen' : last.imported === 1 ? '1 nieuwe betaling' : `${last.imported} nieuwe betalingen`}.{' '}
          {last.duplicates > 0 && <>{last.duplicates === 1 ? '1 stond er al' : `${last.duplicates} stonden er al`}{knownFromText(last.knownFrom)}.{' '}</>}
          {last.addedInKnownPeriod > 0 && <>{last.addedInKnownPeriod} toegevoegd in een periode die al was ingelezen.{' '}</>}
          {(last.skipped > 0 || last.addedInKnownPeriod > 0) && <><button className="linklike" onClick={() => setReview({ batchId: last.batchId })}>Bekijken</button>{' '}</>}
          {last.autoMatched} automatisch verwerkt.{' '}
          {help > 0 ? `Bij ${help} hebben we je hulp nodig.` : 'Alles is verwerkt ✓'}
        </div>
      )}

      {(doubles.data ?? []).map((d) => (
        <div key={`${d.lineId}-${d.firstPartId}`} className="notice warn row between" style={{ marginTop: 14 }}>
          <span>
            ⚠️ <strong><Euro cents={Math.abs(d.total)} /> staat er waarschijnlijk twee keer in</strong> ({d.accountName}): één keer als één regel op <DateNl date={d.line.date} /> en één keer als {d.parts.length} deelposten op <DateNl date={d.parts[0]!.date} />.
          </span>
          <Button small kind="primary" onClick={() => setShowDouble({ lineId: d.lineId, firstPartId: d.firstPartId })}>Bekijken en oplossen</Button>
        </div>
      ))}

      {(sames.data ?? []).map((d) => (
        <div key={`${d.firstId}-${d.secondId}`} className="notice warn row between" style={{ marginTop: 14 }} data-testid="zelfde-betaling">
          <span>
            ⚠️ <strong><Euro cents={Math.abs(d.amount)} /> staat er waarschijnlijk twee keer in</strong> ({d.accountName}): twee regels op <DateNl date={d.first.date} />{d.second.date !== d.first.date && <> en <DateNl date={d.second.date} /></>} die dezelfde betaling lijken, uit verschillende afschriften.
          </span>
          <Button small kind="primary" onClick={() => setShowSame({ firstId: d.firstId, secondId: d.secondId })}>Bekijken en oplossen</Button>
        </div>
      ))}

      <div className="row" style={{ margin: '20px 0 12px', gap: 12 }}>
        <div className="chips">
          <button className={view === 'hulp' ? 'selected' : ''} onClick={() => setView('hulp')}>Hulp nodig</button>
          <button className={view === 'alles' ? 'selected' : ''} onClick={() => setView('alles')}>Alle betalingen</button>
        </div>
        <input className="grow" type="search" aria-label="Zoek in betalingen" placeholder="Zoek op naam, omschrijving of rekeningnummer…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <ErrorBox error={txs.error} />
      {query && (txs.data ?? []).length > 0 && (
        <p className="small muted">
          {txs.data!.length === 1 ? '1 betaling' : `${txs.data!.length} betalingen`}{view === 'hulp' ? ' die nog verwerkt moeten worden' : ''}, samen <Euro cents={txs.data!.reduce((sum, t) => sum + t.amount, 0)} sign />
          {view === 'hulp' && <> · <button className="linklike" onClick={() => setView('alles')}>zoek in alle betalingen</button></>}
        </p>
      )}
      {(txs.data ?? []).length === 0 ? (
        query ? (
          <Empty icon="🔍" title={`Niets gevonden voor "${query}"`}>{view === 'hulp' ? <button className="linklike" onClick={() => setView('alles')}>Zoek in alle betalingen</button> : 'Probeer een ander woord.'}</Empty>
        ) : (
          <Empty icon="✓" title={view === 'hulp' ? 'Alle betalingen zijn verwerkt' : 'Nog geen betalingen ingelezen'} />
        )
      ) : (
        <table className="list">
          <thead><tr><th>Datum</th><th>Wie en wat</th>{(accounts.data ?? []).length > 1 && <th>Rekening</th>}<th>Geboekt als</th><th>Status</th><th className="num">Bedrag</th></tr></thead>
          <tbody>
            {txs.data!.map((t) => (
              <tr key={t.id} className="clickable" style={t.id === focus ? { outline: '2px solid var(--primary)' } : undefined} onClick={() => go({ screen: 'categorie', id: t.id })}>
                <td><DateNl date={t.transaction_date} /></td>
                <td>
                  {t.counter_name ?? '—'}
                  <div className="small muted" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.description}</div>
                </td>
                {(accounts.data ?? []).length > 1 && <td className="small">{t.account_name}</td>}
                <td className="small">
                  {t.booked_as ?? <span className="muted">—</span>}
                  {t.vat_period && <div className="muted">btw {t.vat_period.label}{t.vat_period.filed ? ' · aangegeven' : ''}</div>}
                </td>
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
              <td>
                {st.name}
                {settings.vatPotAccountId === st.bankAccountId && <> <span className="pill">btw-potje</span></>}
                {accounts.data?.find((a) => a.id === st.bankAccountId)?.is_pot ? <> <span className="pill">potje</span></> : null}
                <div className="small muted">{st.iban ?? 'IBAN nog onbekend'}</div>
              </td>
              <td>{st.lastImport ? <>{formatDateTime(st.lastImport.at)}<div className="small muted">{st.lastImport.filename ?? st.lastImport.source.toUpperCase()}</div></> : <span className="muted">nog nooit</span>}</td>
              <td>{st.lastImport ? <><DateNl date={st.lastImport.from} /> t/m <DateNl date={st.lastImport.to} /><div className="small muted">{st.lastImport.transactions} betalingen, {st.lastImport.imported} nieuw</div></> : '—'}
                {st.skipped > 0 && <div className="small"><button className="linklike" onClick={() => setReview({ bankAccountId: st.bankAccountId })}>{st.skipped === 1 ? '1 regel stond er al' : `${st.skipped} regels stonden er al`}: bekijken</button></div>}</td>
              <td>{st.completeTo ? <><DateNl date={st.completeTo} />{staleDays(st.completeTo) >= 14 && <div><span className="pill warn">{staleDays(st.completeTo)} dagen geleden</span></div>}</> : '—'}
                {st.gap && <div className="small muted">Van {formatDateNl(st.gap)} is alleen een afschrift van die dag zelf ingelezen. Lees een afschrift in waar die dag ook in staat en dat je daarna hebt gedownload.</div>}</td>
              <td className="num" style={{ whiteSpace: 'nowrap' }}>
                <Button small kind="ghost" onClick={() => setEditing({ id: st.bankAccountId, name: st.name, iban: st.iban, isPot: Boolean(accounts.data?.find((a) => a.id === st.bankAccountId)?.is_pot) })}>Wijzigen</Button>
                <Button small kind="ghost" onClick={() => setOpening({ id: st.bankAccountId, name: st.name })}>Beginsaldo</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">Een nieuwe rekening komt er ook vanzelf bij als je een afschrift inleest met een rekeningnummer dat de app nog niet kent.</p>

      {(overview.data ?? []).length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>Saldocontrole</h3>
          <p className="small muted">Per rekening naast elkaar: wat het grootboek zegt, wat je betalingen samen zijn en wat je laatste afschrift als eindsaldo noemt.</p>
          <table className="list">
            <thead><tr><th>Rekening</th><th className="num">Grootboek</th><th className="num">Betalingen</th><th className="num">Laatste afschrift</th><th><span className="sr-only">Uitkomst</span></th></tr></thead>
            <tbody>
              {(overview.data ?? []).map((o) => (
                <tr key={o.bankAccountId}>
                  <td>{o.name}</td>
                  <td className="num"><Euro cents={o.ledger} />{o.pending !== 0 && <div className="small muted">+ <Euro cents={o.pending} /> nog te verwerken</div>}{o.ignored !== 0 && <div className="small muted">+ <Euro cents={o.ignored} /> genegeerd</div>}</td>
                  <td className="num"><Euro cents={o.transactions} /></td>
                  <td className="num">{o.statement ? <><Euro cents={o.statement.bank} /><div className="small muted">op <DateNl date={o.statement.date} /></div></> : <span className="muted">geen eindsaldo</span>}</td>
                  <td>
                    {o.ledgerMatches ? <span className="pill good">grootboek klopt ✓</span> : <span className="pill warn">grootboek wijkt af</span>}{' '}
                    {o.statement && (o.statement.matches ? <span className="pill good">afschrift klopt ✓</span> : <span className="pill warn">afschrift wijkt af</span>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {meta.bankFeed && <PontoCard initialStep={bankFeed === 'credentials' ? 4 : undefined} focusAccountId={feedAccountId} />}

      <StatementFolderCard />

      {review && <ImportReview {...review} onClose={() => setReview(null)} onChanged={async () => { await Promise.all([txs.reload(), status.reload(), doubles.reload(), sames.reload()]); refreshBadge(); }} />}
      {openDouble && <DoubleDialog double={openDouble} onClose={() => setShowDouble(null)} onChanged={async () => { setShowDouble(null); await Promise.all([txs.reload(), status.reload(), doubles.reload()]); refreshBadge(); }} />}
      {openSame && <SameDialog double={openSame} onClose={() => setShowSame(null)} onChanged={async () => { setShowSame(null); await Promise.all([txs.reload(), status.reload(), sames.reload()]); refreshBadge(); }} />}
      {mapping && <CsvMappingDialog {...mapping} onClose={() => setMapping(null)} onConfirm={async (m) => { const x = mapping; setMapping(null); await doImport(x.filename, x.content, m); }} />}
      {opening && <OpeningBalance accountId={opening.id} name={opening.name} onClose={() => setOpening(null)} />}
      {editing && <AccountDialog account={editing === 'nieuw' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await Promise.all([status.reload(), accounts.reload()]); }} />}
    </div>
  );
}

/**
 * Afschriften vanzelf inlezen (#184): de app kijkt in een map (standaard Downloads) naar nieuwe
 * afschriften en vraagt op Vandaag "Inlezen?". Standaard uit; de gebruiker zet het zelf aan.
 */
function StatementFolderCard() {
  const { toast, refreshBadge } = useApp();
  const { run, busy } = useAction();
  const state = useLoad(() => api.bank.statementFolder());
  const st = state.data;
  if (!st?.available) return null;
  const set = async (enabled: boolean, path: string) => {
    const r = await run(() => api.bank.setStatementFolder(enabled, path));
    if (!r) return;
    await state.reload();
    refreshBadge();
    if (enabled) toast(r.found > 0 ? `${r.found === 1 ? '1 afschrift' : `${r.found} afschriften`} gevonden. De vraag "Inlezen?" staat op Vandaag.` : 'De app let nu op deze map.');
  };
  const choose = async () => {
    const path = await run(() => api.bank.chooseStatementFolder());
    if (path) await set(st.enabled, path);
  };
  return (
    <div className="card" style={{ marginTop: 24 }}>
      <h2 style={{ marginTop: 0 }}>Afschriften vanzelf inlezen</h2>
      <label className="row">
        <input type="checkbox" checked={st.enabled} disabled={busy} onChange={(e) => void set(e.target.checked, st.path)} /> Kijk in deze map naar nieuwe afschriften
      </label>
      <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        <code style={{ overflowWrap: 'anywhere' }}>{st.path}</code>
        <Button small disabled={busy} onClick={() => void choose()}>Andere map kiezen</Button>
      </div>
      <p className="small muted">
        Download je afschrift bij je bank zoals je gewend bent. Staat dit aan, dan ziet de app het bestand in deze map en vraagt op Vandaag: "Inlezen?". Er gaat niets vanzelf je boekhouding in.
        {!st.enabled && ' Bij het aanzetten kijkt de app ook naar afschriften van de afgelopen 14 dagen.'}
      </p>
      <p className="small muted">
        Alles gebeurt op je eigen computer; er gaat niets naar buiten. De app opent in deze map alleen bestanden die eindigen op .xml, .sta, .940, .txt of .csv, om te zien of het een afschrift van een van je rekeningen is. Van andere bestanden onthoudt hij alleen dat het geen afschrift is. De app verplaatst of verwijdert nooit iets in deze map.
      </p>
    </div>
  );
}

/**
 * Wat er bij het inlezen niet is toegevoegd omdat de betaling er al stond, met die betaling ernaast.
 * Waren het toch twee betalingen, dan komt de regel er met "Toch toevoegen" alsnog in. Er verdwijnt dus niets stil.
 */
function ImportReview({ batchId, bankAccountId, onClose, onChanged }: { batchId?: number; bankAccountId?: number; onClose: () => void; onChanged: () => Promise<void> }) {
  const { go } = useApp();
  const { run, busy } = useAction();
  const data = useLoad(() => api.bank.importReview({ batchId, bankAccountId }), [batchId, bankAccountId]);
  const skipped = data.data?.skipped ?? [];
  const added = data.data?.added ?? [];
  const removed = data.data?.removed ?? [];
  return (
    <Modal title="Betalingen die er al stonden" wide onClose={onClose}>
      <ErrorBox error={data.error} />
      {data.data && skipped.length === 0 && added.length === 0 && removed.length === 0 && <p className="muted">Er is niets overgeslagen.</p>}
      {skipped.length > 0 && (
        <>
          <p className="muted small">Deze regels uit je afschrift zijn niet toegevoegd, omdat dezelfde betaling er al stond uit een eerder afschrift. Waren het toch twee verschillende betalingen? Kies dan <strong>Toch toevoegen</strong>.</p>
          <table className="list">
            <thead><tr><th>Datum</th><th>Wie en wat</th><th className="num">Bedrag</th><th>Stond er al als</th><th><span className="sr-only">Acties</span></th></tr></thead>
            <tbody>
              {skipped.map((k) => (
                <tr key={k.id}>
                  <td><DateNl date={k.date} /></td>
                  <td>{k.counterName ?? '—'}<div className="small muted">{k.description}</div></td>
                  <td className="num"><Euro cents={k.amount} sign /></td>
                  <td>
                    <DateNl date={k.existing.date} /> · {k.existing.counterName ?? '—'}
                    <div className="small muted">{k.existing.description}</div>
                    {k.existing.filename && <div className="small muted">uit {k.existing.filename}</div>}
                    {k.batch?.kind === 'deelpost' && <div className="small muted">Deelpost van een verzamelbetaling van <Euro cents={Math.abs(k.batch.total)} />: dat bedrag stond er al als één regel.</div>}
                    {k.batch?.kind === 'totaal' && <div className="small muted">en {k.batch.parts - 1} andere {k.batch.parts - 1 === 1 ? 'deelpost' : 'deelposten'}: samen <Euro cents={Math.abs(k.batch.total)} />, hetzelfde bedrag als deze ene regel.</div>}
                  </td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    {k.added ? <span className="muted small">toegevoegd ✓</span> : (
                      <Button small disabled={busy} onClick={async () => {
                        if ((await run(() => api.bank.addSkipped(k.id), 'Betaling toegevoegd')) !== undefined) await Promise.all([data.reload(), onChanged()]);
                      }}>{k.batch?.kind === 'deelpost' && k.batch.parts > 1 ? `Toch toevoegen (alle ${k.batch.parts} deelposten)` : 'Toch toevoegen'}</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {added.length > 0 && (
        <>
          <h3>Nieuw in een periode die al was ingelezen</h3>
          <p className="muted small">Deze betalingen stonden niet in je eerdere afschrift en zijn toegevoegd. Staat er toch een dubbel in? Open hem en kies onderaan <strong>Negeren</strong>.</p>
          <table className="list">
            <tbody>
              {added.map((t) => (
                <tr key={t.id} className="clickable" onClick={() => go({ screen: 'categorie', id: t.id })}>
                  <td><DateNl date={t.transaction_date} /></td>
                  <td>{t.counter_name ?? '—'}<div className="small muted">{t.description}</div></td>
                  <td className="num"><Euro cents={t.amount} sign /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {removed.length > 0 && (
        <>
          <h3>Uit je boekhouding gehaald omdat het bedrag er dubbel in stond</h3>
          <p className="muted small">Deze betalingen tellen niet meer mee. Waren het toch twee verschillende betalingen? Kies dan <strong>Terugzetten</strong>; wat tegelijk is weggehaald, komt samen terug.</p>
          <table className="list">
            <thead><tr><th>Datum</th><th>Wie en wat</th><th className="num">Bedrag</th><th>Wat bleef</th><th><span className="sr-only">Acties</span></th></tr></thead>
            <tbody>
              {removed.map((t) => (
                <tr key={t.id}>
                  <td><DateNl date={t.date} /></td>
                  <td>{t.counterName ?? '—'}<div className="small muted">{t.description}</div></td>
                  <td className="num"><Euro cents={t.amount} sign /></td>
                  <td><DateNl date={t.kept.date} /> · {t.kept.counterName ?? '—'}<div className="small muted">{t.kept.description}</div></td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <Button small disabled={busy} onClick={async () => {
                      if ((await run(() => api.bank.restoreDuplicate(t.id), 'Teruggezet')) !== undefined) await Promise.all([data.reload(), onChanged()]);
                    }}>Terugzetten</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <div className="row end" style={{ marginTop: 14 }}><Button onClick={onClose}>Sluiten</Button></div>
    </Modal>
  );
}

const STATUS_TEXT = { nieuw: 'nog niet verwerkt', gematcht: 'al verwerkt', genegeerd: 'genegeerd' } as const;

/**
 * Een verzamelbetaling die er twee keer in staat: de ene regel (CSV, MT940) naast de deelposten (CAMT),
 * met hun som. Eén kant gaat uit de boekhouding; die blijft bewaard en is terug te zetten. Wat al verwerkt
 * is, haalt de app er niet zelf uit: dan de andere kant kiezen, of eerst de verwerking ongedaan maken.
 */
function DoubleDialog({ double: d, onClose, onChanged }: { double: BatchDouble; onClose: () => void; onChanged: () => Promise<void> }) {
  const { go } = useApp();
  const { run, busy } = useAction();
  const size = Math.abs(d.total);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    if ((await run(async () => { await fn(); return true; }, done)) !== undefined) await onChanged();
  };
  const side = (rows: BatchDouble['parts']) => (
    <table className="list small">
      <tbody>
        {rows.map((t) => (
          <tr key={t.id}>
            <td><DateNl date={t.date} /></td>
            <td>
              {t.counterName ?? '—'}
              <div className="muted">{t.description}</div>
              <div className="muted">{STATUS_TEXT[t.status]}{t.filename ? ` · uit ${t.filename}` : ''}{t.status === 'gematcht' && <> · <button className="linklike" onClick={() => go({ screen: 'categorie', id: t.id })}>openen</button></>}</div>
            </td>
            <td className="num"><Euro cents={t.amount} sign /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  // de kant die eruit kan; liefst de ene regel, want de deelposten zeggen per betaling aan wie het was
  const primary = d.canRemoveLine ? 'regel' : d.canRemoveParts ? 'deelposten' : null;
  return (
    <Modal title="Dit bedrag staat er waarschijnlijk twee keer in" wide onClose={onClose}>
      <p>
        Een verzamelbetaling staat in het ene soort afschrift als één regel en in het andere als losse deelposten. Beide staan nu in de app ({d.accountName}), dus <strong><Euro cents={size} /> telt dubbel</strong>. Kies welke kant blijft. De andere kant haalt de app uit je boekhouding; die blijft bewaard en kun je altijd terugzetten.
      </p>
      <div className="grid cols-2">
        <div>
          <h3>Eén regel</h3>
          {side([d.line])}
          <p className="small"><strong>Totaal <Euro cents={d.line.amount} sign /></strong></p>
        </div>
        <div>
          <h3>{d.parts.length} deelposten</h3>
          {side(d.parts)}
          <p className="small"><strong>Samen <Euro cents={d.parts.reduce((n, p) => n + p.amount, 0)} sign /></strong></p>
        </div>
      </div>
      {!d.canRemoveLine && <p className="small">De ene regel is al verwerkt. Die haalt de app er niet zomaar uit: {d.canRemoveParts ? 'haal de deelposten eruit, of' : ''} maak eerst die verwerking ongedaan (open de regel en kies <strong>Ongedaan maken</strong>).</p>}
      {!d.canRemoveParts && <p className="small">Een of meer deelposten zijn al verwerkt. Die haalt de app er niet zomaar uit: {d.canRemoveLine ? 'haal de ene regel eruit, of' : ''} maak eerst die verwerking ongedaan (open de deelpost en kies <strong>Ongedaan maken</strong>).</p>}
      <div className="row end" style={{ marginTop: 14, flexWrap: 'wrap' }}>
        <Button disabled={busy} onClick={() => void act(() => api.bank.dismissDouble(d.lineId, d.firstPartId), 'Goed, de app meldt dit niet meer')}>Nee, dit zijn twee verschillende betalingen</Button>
        <Button kind={primary === 'deelposten' ? 'primary' : undefined} disabled={busy || !d.canRemoveParts} onClick={() => void act(() => api.bank.resolveDouble(d.lineId, d.firstPartId, 'deelposten'), 'Opgelost: de deelposten zijn uit je boekhouding gehaald')}>De ene regel houden</Button>
        <Button kind={primary === 'regel' ? 'primary' : undefined} disabled={busy || !d.canRemoveLine} onClick={() => void act(() => api.bank.resolveDouble(d.lineId, d.firstPartId, 'regel'), 'Opgelost: de ene regel is uit je boekhouding gehaald')}>De deelposten houden</Button>
      </div>
    </Modal>
  );
}

/** Rekening toevoegen of wijzigen: naam, IBAN, of het je btw-potje is en (bij nieuw) het beginsaldo. */
/**
 * Twee losse regels die dezelfde betaling lijken (#225): naast elkaar, met uit welk afschrift ze komen. Eén
 * van de twee gaat uit de boekhouding; die blijft bewaard en is terug te zetten. Wat al verwerkt is, haalt de
 * app er niet zelf uit: dan de andere kiezen, of eerst de verwerking ongedaan maken.
 */
function SameDialog({ double: d, onClose, onChanged }: { double: PaymentDouble; onClose: () => void; onChanged: () => Promise<void> }) {
  const { go } = useApp();
  const { run, busy } = useAction();
  const act = async (fn: () => Promise<unknown>, done: string) => {
    if ((await run(async () => { await fn(); return true; }, done)) !== undefined) await onChanged();
  };
  const side = (t: PaymentDouble['first']) => (
    <table className="list small">
      <tbody>
        <tr>
          <td><DateNl date={t.date} /></td>
          <td>
            {t.counterName ?? '—'}
            <div className="muted">{t.description}</div>
            <div className="muted">{STATUS_TEXT[t.status]}{t.filename ? ` · uit ${t.filename}` : ''}{t.status === 'gematcht' && <> · <button className="linklike" onClick={() => go({ screen: 'categorie', id: t.id })}>openen</button></>}</div>
          </td>
          <td className="num"><Euro cents={t.amount} sign /></td>
        </tr>
      </tbody>
    </table>
  );
  const canRemoveFirst = d.first.status !== 'gematcht';
  const canRemoveSecond = d.second.status !== 'gematcht';
  // Is precies één van de twee genegeerd, dan gaat die eruit: de andere is de betaling die in je boekhouding hoort.
  // Anders liefst de regel die er later bij kwam; is die al verwerkt en de eerste niet, dan de eerste.
  const ignoredFirst = d.first.status === 'genegeerd';
  const ignoredSecond = d.second.status === 'genegeerd';
  const primary = ignoredFirst !== ignoredSecond ? (ignoredFirst ? 'eerste' : 'tweede') : canRemoveSecond ? 'tweede' : canRemoveFirst ? 'eerste' : null;
  return (
    <Modal title="Deze betaling staat er waarschijnlijk twee keer in" wide onClose={onClose}>
      <p>
        Dezelfde betaling kan in twee afschriften net anders staan, bijvoorbeeld de ene keer met “Card Payment:” voor de naam. Beide regels staan nu in de app ({d.accountName}), dus <strong><Euro cents={Math.abs(d.amount)} /> telt dubbel</strong>. Kies welke regel blijft. De andere haalt de app uit je boekhouding; die blijft bewaard en kun je altijd terugzetten.
      </p>
      <div className="grid cols-2">
        <div>
          <h3>Stond er al</h3>
          {side(d.first)}
        </div>
        <div>
          <h3>Kwam er later bij</h3>
          {side(d.second)}
        </div>
      </div>
      {!canRemoveFirst && !canRemoveSecond && <p className="small">Beide regels zijn al verwerkt. Die haalt de app er niet zomaar uit: open de regel die er dubbel in staat, kies <strong>Ongedaan maken</strong> en kom daarna hier terug.</p>}
      {(ignoredFirst || ignoredSecond) && <p className="small" data-testid="genegeerd-blijft">{ignoredFirst && ignoredSecond ? 'Beide regels zijn genegeerd' : ignoredFirst ? 'De regel die er al stond is genegeerd' : 'De regel die er later bij kwam is genegeerd'}. Houd je een genegeerde regel, dan komt die terug bij je nog te verwerken betalingen: anders staat deze betaling nergens in je boekhouding.</p>}
      {canRemoveFirst !== canRemoveSecond && <p className="small">{canRemoveFirst ? 'De regel die er later bij kwam' : 'De regel die er al stond'} is al verwerkt. Die haalt de app er niet zomaar uit: haal de andere eruit, of maak eerst die verwerking ongedaan (open de regel en kies <strong>Ongedaan maken</strong>).</p>}
      <div className="row end" style={{ marginTop: 14, flexWrap: 'wrap' }}>
        <Button disabled={busy} onClick={() => void act(() => api.bank.dismissSame(d.firstId, d.secondId), 'Goed, de app meldt dit niet meer')}>Nee, dit zijn twee verschillende betalingen</Button>
        <Button kind={primary === 'eerste' ? 'primary' : undefined} disabled={busy || !canRemoveFirst} onClick={() => void act(() => api.bank.resolveSame(d.secondId, d.firstId), 'Opgelost: de dubbele regel is uit je boekhouding gehaald')}>De regel die later kwam houden</Button>
        <Button kind={primary === 'tweede' ? 'primary' : undefined} disabled={busy || !canRemoveSecond} onClick={() => void act(() => api.bank.resolveSame(d.firstId, d.secondId), 'Opgelost: de dubbele regel is uit je boekhouding gehaald')}>De regel die er al stond houden</Button>
      </div>
    </Modal>
  );
}

function AccountDialog({ account, onClose, onSaved }: { account: { id: number; name: string; iban: string | null; isPot: boolean } | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { settings, reloadSettings } = useApp();
  const { run, busy } = useAction();
  const [name, setName] = useState(account?.name ?? '');
  const [iban, setIban] = useState(account?.iban ?? '');
  // zonder rekeningnummer: een potje binnen je bank, of een echte rekening waarvan je het nummer nog niet invulde
  const [isPot, setIsPot] = useState(account ? account.isPot : true);
  const removable = useLoad(async () => (account ? api.bank.removableAccount(account.id) : null), [account?.id]);
  const [pot, setPot] = useState(account ? settings.vatPotAccountId === account.id : false);
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(`${new Date().getFullYear()}-01-01`);
  const save = async () => {
    const ok = await run(async () => {
      const id = account ? (await api.bank.updateAccount(account.id, { name, iban: iban.trim() || null, pot: isPot }), account.id) : (await api.bank.addAccount(name, iban.trim() || null, { pot: isPot })).id;
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
      {!iban.trim() && (
        <>
          <label className="row" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={isPot} onChange={(e) => setIsPot(e.target.checked)} /> Dit is een potje binnen een andere rekening (zoals een Knab-potje)
          </label>
          <p className="small muted">
            {isPot
              ? 'Van een potje lees je geen afschrift in: bij een betaling naar of uit het potje kies je zelf "Naar potje" of "Uit potje".'
              : 'Een gewone rekening: vul het rekeningnummer in zodra je het weet, dan herkent de app de afschriften.'}
          </p>
        </>
      )}
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
      {account && removable.data && (
        <div className="card flat" style={{ marginTop: 14 }}>
          <strong>Rekening weghalen</strong>
          {removable.data.ok ? (
            <>
              <p className="small muted">Er staat niets op deze rekening. Is hij dubbel (bijvoorbeeld aangemaakt bij het inlezen van je vorige administratie) of gebruik je hem niet? Dan kun je hem weghalen.</p>
              <Button small disabled={busy} onClick={async () => { if ((await run(async () => { await api.bank.removeAccount(account.id); return true; }, 'Rekening weggehaald')) !== undefined) await onSaved(); }}>Rekening weghalen</Button>
            </>
          ) : (
            <p className="small muted">Kan niet: {removable.data.reason?.toLowerCase()}.</p>
          )}
        </div>
      )}
      <div className="row end" style={{ marginTop: 14 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={busy || !name.trim()} onClick={() => void save()}>Opslaan</Button>
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
export function CategoryPicker({ initial, onPick, incoming, amount, txId }: { initial?: string; onPick: (categoryKey: string, vatCode: string, businessPct: number) => void; incoming?: boolean; /** betaald bedrag (positief), voor de investeringshint */ amount?: number; /** de betaling: voor het zakelijke deel dat eerder voor deze tegenpartij is opgegeven */ txId?: number }) {
  const { meta } = useApp();
  const share = useLoad(() => (txId !== undefined && !incoming ? api.bank.businessShare(txId) : Promise.resolve(null)), [txId]);
  const [pctInput, setPctInput] = useState<string | null>(null);
  const pct = pctInput ?? String(share.data?.pct ?? 100);
  const pctNumber = Number(pct);
  const pctOk = Number.isInteger(pctNumber) && pctNumber >= 1 && pctNumber <= 100;
  const [cat, setCat] = useState(initial ?? 'materiaal');
  const [vat, setVat] = useState<PurchaseVatCode>(meta.expenseCategories.find((c) => c.key === (initial ?? 'materiaal'))?.defaultVat ?? 'hoog');
  return (
    <div className="grid">
      <Field label={incoming ? 'Waar was dit geld voor?' : 'Waar was deze betaling voor?'}>
        <CategoryChips value={cat} onChange={(key, defaultVat) => { setCat(key); setVat(defaultVat); }} />
      </Field>
      {!incoming && <InvestmentHint categoryKey={cat} gross={amount} vatCode={vat} onUse={() => { setCat('investering'); setVat('hoog'); }} />}
      <Field label="Stond er btw op?" hint="Kijk op de bon of factuur. Geen bon? Meestal 21%; verzekeringen, bankkosten en de overheid rekenen geen btw">
        <select value={vat} onChange={(e) => setVat(e.target.value as PurchaseVatCode)}>
          {meta.purchaseVat.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}
        </select>
      </Field>
      {txId !== undefined && !incoming && (
        <Field label="Hoeveel daarvan is zakelijk?" hint={pctNumber < 100 && pctOk ? `Het privédeel (${100 - pctNumber}%) telt niet als kosten en de btw erover trek je niet af. De app onthoudt dit voor ${share.data?.name ?? 'deze partij'}.` : 'Alles zakelijk? Laat 100 staan. Gebruik je dit ook privé, bijvoorbeeld opslag, telefoon of internet? Vul het zakelijke deel in.'}>
          <span className="row" style={{ gap: 6, alignItems: 'center' }}>
            <input type="number" min={1} max={100} step={1} style={{ width: 90 }} value={pct} onChange={(e) => setPctInput(e.target.value)} /> %
          </span>
        </Field>
      )}
      <div className="row end"><Button kind="primary" disabled={!pctOk} onClick={() => onPick(cat, vat, pctOk ? pctNumber : 100)}>Opslaan</Button></div>
    </div>
  );
}

/**
 * "Verkoop via een ander systeem": geld van een klant zonder factuur uit deze app (Mollie, webshop,
 * kassa, pin, contant). Kies de btw; de app stelt een tarief voor op basis van de klant of het land
 * van de rekening. Het systeem en het nummer komen in de omschrijving, en de app onthoudt de keuze
 * voor de volgende betaling van deze betaler.
 */
function SaleForm({ txId, amount, description, busy, onBook }: { txId: number; amount: number; description: string; busy: boolean; onBook: (input: { vatCode: SalesVatCode; relationId: number | null; channel: string; reference: string }) => void }) {
  const { meta, settings } = useApp();
  const hint = useLoad(() => api.bank.salesVatSuggestion(txId), [txId]);
  const channels = useLoad(() => api.bank.saleChannels());
  const [picked, setPicked] = useState<SalesVatCode | null>(null);
  const [channel, setChannel] = useState('');
  // een nummer uit de omschrijving van de bank, bv. I-MOL-2026-00344
  const [reference, setReference] = useState(() => referenceIn(description) ?? '');
  const suggested = picked ?? hint.data?.vatCode ?? 'hoog';
  const vat = settings.kor && (suggested === 'hoog' || suggested === 'laag') ? 'vrijgesteld' : suggested;
  const rate = meta.salesVat.find((v) => v.code === vat);
  const net = Math.round((amount * 100) / (100 + (rate?.percentage ?? 0)));
  return (
    <div className="card grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)', margin: 0 }}>
      <Field label="Via welk systeem? (mag leeg)" hint="bv. Mollie, je webshop of je kassa; de app onthoudt het voor de volgende keer">
        <input value={channel} maxLength={60} list="verkoop-systemen" placeholder="bv. Mollie" onChange={(e) => setChannel(e.target.value)} />
        <datalist id="verkoop-systemen">{(channels.data ?? []).map((c) => <option key={c} value={c} />)}</datalist>
      </Field>
      <Field label="Nummer van de factuur of bon, als je die hebt" hint="staat vaak al in de omschrijving van de bank; zo vindt je boekhouder hem terug">
        <input value={reference} maxLength={60} onChange={(e) => setReference(e.target.value)} />
      </Field>
      <Field label="Hoeveel btw rekende je?" hint="kijk op de factuur of bon die je klant kreeg">
        <select value={vat} onChange={(e) => setPicked(e.target.value as SalesVatCode)}>
          {meta.salesVat.filter(v => !settings.kor || v.percentage === 0).map((v) => <option key={v.code} value={v.code}>{v.pickLabel ?? v.label}</option>)}
        </select>
      </Field>
      {hint.error && !picked && <p className="small" style={{ margin: 0 }}>Er is geen voorstel. Kies zelf de btw die op de factuur staat.</p>}
      {hint.data?.reason && !picked && <p className="small muted" style={{ margin: 0 }}>Voorstel omdat {hint.data.reason}. Stond er op de factuur toch btw? Kies dan dat tarief.</p>}
      <p className="small" style={{ margin: 0 }}>Omzet <Euro cents={net} />{amount - net !== 0 && <> + btw <Euro cents={amount - net} /></>}</p>
      {vat !== 'hoog' && vat !== 'laag' && (
        <p className="small muted" style={{ margin: 0 }}>Geen Nederlandse btw? Laat je boekhouder even meekijken of dat klopt voor wat je levert.</p>
      )}
      <div className="row end">
        <Button kind="primary" disabled={busy || hint.loading || (Boolean(hint.error) && !picked)} onClick={() => onBook({ vatCode: vat, relationId: hint.data?.relationId ?? null, channel, reference })}>Verwerk als verkoop</Button>
      </div>
    </div>
  );
}

type PurchaseCandidate = NonNullable<Awaited<ReturnType<typeof api.bank.purchaseQuestion>>>['candidates'][number];

/** "Aankoop bij Printhuis van 3 september 2026, € 48,40, nog niet betaald": een aankoop die bij een betaling kan horen. */
function purchaseCandidateText(c: PurchaseCandidate): string {
  const amount = `${formatEuro(c.total)}${c.currency && c.foreignTotal !== null ? ` (${formatForeign(c.foreignTotal, c.currency)})` : ''}`;
  const paid = c.state === 'elders' ? (c.via === 'kas' ? 'contant betaald' : c.via === 'prive' ? 'betaald met privégeld' : 'betaald met privégeld of contant') : c.open !== c.total ? `nog ${formatEuro(c.open)} te betalen` : 'nog niet betaald';
  return `Aankoop ${c.supplier ? `bij ${c.supplier}` : `"${c.description}"`} van ${formatDateNl(c.date)}, ${amount}, ${paid}${c.question ? ', staat op "weet ik nog niet"' : ''}`;
}

export function CategorizeTransaction({ id }: { id: number }) {
  const { go, meta, showInvestmentSaved } = useApp();
  const { run, busy } = useAction();
  const txs = useLoad(() => api.bank.transactions({}), [id]);
  const suggestions = useLoad(() => api.bank.suggestions(id), [id]);
  const openInvoices = useLoad(() => api.invoices.list({ status: 'openstaand' }));
  const overdue = useLoad(() => api.invoices.list({ status: 'vervallen' }));
  const [recat, setRecat] = useState(false);
  const [sale, setSale] = useState(false);
  // geld terug van een leverancier (refund): onder welke kosten viel de aankoop?
  const [refund, setRefund] = useState(false);
  const own = useLoad(() => api.bank.ownTransfer(id), [id]);
  // potjes zonder eigen rekeningnummer (bv. Knab): daar komt geen afschrift van, dus hier kiezen
  const pots = useLoad(() => api.bank.accounts().then((list) => list.filter((a) => a.is_pot)));
  const previousSale = useLoad(() => api.bank.previousSale(id), [id]);
  // betaling aan je eigen bedrijf (#205): geen gewone aankoop, en de factuur ervan gaat in dezelfde keuze mee
  const ownCompany = useLoad(() => api.bank.ownCompany(id), [id]);
  // een aankoop die er al staat en bij deze afschrijving past (#221): eerst die vraag, anders tellen de kosten dubbel
  const purchaseQuestion = useLoad(() => api.bank.purchaseQuestion(id), [id]);
  // geld dat binnenkomt: de open creditnota's van leveranciers waar het bij kan horen (#227)
  const creditNotes = useLoad(() => api.bank.creditNotes(id), [id]);
  // geld van een betaaldienst terwijl er verkopen in de app op hun geld wachten (#227): de naam van die dienst
  const payout = useLoad(() => api.bank.awaitedPayout(id), [id]);
  // bij "Negeren": de betalingen waar deze regel een dubbel van kan zijn (#225); null = nog niet gevraagd
  const [doubleOf, setDoubleOf] = useState<Awaited<ReturnType<typeof api.bank.duplicateCandidates>> | null>(null);
  // waarschijnlijk dezelfde betaling als een regel die er al staat (#225): eerst die vraag, daarna pas indelen
  const sames = useLoad(() => api.bank.sameDoubles());
  const t = txs.data?.find((x) => x.id === id);
  if (!t) return <div className="page"><ErrorBox error={txs.error} /></div>;
  const held = t.status === 'nieuw' ? (sames.data ?? []).find((d) => (d.secondId === t.id && d.second.status === 'nieuw') || (d.firstId === t.id && d.second.status !== 'nieuw')) : undefined;
  /** de betalingen waar deze regel een dubbel van kan zijn; kiezen koppelt hem daaraan */
  const doubleChoices = (candidates: NonNullable<typeof doubleOf>) => candidates.map((c) => (
    <button key={c.id} disabled={busy} onClick={() => void done(api.bank.ignore(t.id, c.id))}>
      Ja, dubbel van <DateNl date={c.transaction_date} /> · {c.counter_name ?? 'Onbekend'}
      <div className="hint">{c.description.length > 90 ? `${c.description.slice(0, 90)}…` : c.description} · {STATUS_TEXT[c.status]}{c.status === 'genegeerd' ? ': die komt terug bij je nog te verwerken betalingen' : ''}</div>
    </button>
  ));
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
  const linked = t.status === 'nieuw' ? purchaseQuestion.data ?? null : null;
  const credits = t.status === 'nieuw' && t.amount > 0 ? creditNotes.data ?? [] : [];
  // een creditnota van een leverancier met dit bedrag: geld terug daarvan is geen omzet (#227)
  const strongCredits = credits.filter((c) => c.strong);
  // past er een aankoop of creditnota sterk bij, dan eerst "Ja" of "Nee, iets anders": tot dan geen andere keuzes
  const mustAnswer = Boolean(linked?.strong) || strongCredits.length > 0;
  // voorstellen die al in de kaart hierboven staan, niet nog een keer onder "Hoort dit hierbij?"
  const proposals = (suggestions.data ?? []).filter((s) => s.kind !== 'rekening' && !(s.kind === 'inkoop' && linked?.candidates.some((c) => c.purchaseId === s.purchaseId)));
  const creditText = (c: (typeof credits)[number]) => `Creditnota ${c.supplier ? `van ${c.supplier}` : `"${c.description}"`} van ${formatDateNl(c.date)}, nog ${formatEuro(c.open)} terug te krijgen`;
  return (
    <div className="page-narrow">
      <div className="row between">
        <h1><Euro cents={t.amount} sign /> {t.amount > 0 ? 'ontvangen' : 'betaald'}</h1>
        <Button kind="ghost" onClick={() => go({ screen: 'bank' })}>← Bank</Button>
      </div>
      <p className="sub">{t.counter_name ?? 'Onbekend'} · <DateNl date={t.transaction_date} /> · {t.description.length > 120 ? `${t.description.slice(0, 120)}…` : t.description}</p>
      <details className="small" style={{ marginBottom: 12 }}>
        <summary>Alle gegevens van deze betaling en eerdere betalingen {t.amount < 0 ? 'aan' : 'van'} {t.counter_name ?? 'deze partij'}</summary>
        <PaymentDetails txId={t.id} evidence={false} />
      </details>
      <PaymentEvidence txId={t.id} />

      {held && (
        <div className="notice warn row between" role="note" data-testid="vastgehouden-dubbel">
          <span>
            <strong>Deze regel staat er waarschijnlijk twee keer in.</strong> Op <DateNl date={(held.firstId === t.id ? held.second : held.first).date} /> staat dezelfde betaling uit een ander afschrift. Kies eerst of het dezelfde betaling is; daarna kun je hem indelen.
          </span>
          <Button small kind="primary" onClick={() => go({ screen: 'bank', extra: { same: { firstId: held.firstId, secondId: held.secondId } } })}>Bekijken en oplossen</Button>
        </div>
      )}
      {/* past er een andere aankoop sterk bij, dan eerst die vraag hieronder; daarna pas privé of "weet ik nog niet" */}
      {t.status === 'nieuw' && ownCompany.data && !mustAnswer && (
        <div className="notice warn" role="note" data-testid="eigen-bedrijf">
          <strong>Dit is een betaling aan je eigen bedrijf</strong>
          <div className="small" style={{ marginTop: 4 }}>
            De naam op het afschrift is je eigen bedrijfsnaam, maar het is geen overboeking naar een eigen rekening. Bijvoorbeeld een betaling voor je eigen dienst. Dat is geen gewone aankoop: geen kosten en geen btw-aftrek.{' '}
            {ownCompany.data.documentId || ownCompany.data.purchaseId ? 'De factuur van je eigen bedrijf met hetzelfde bedrag gaat in dezelfde keuze mee.' : 'Komt de factuur later binnen, dan hoort die hierbij.'}{' '}
            Meestal is dit privé: je betaalt jezelf. Bij "weet ik nog niet" blijft het open staan en houdt het je btw-aangifte tegen.
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <Button small kind="primary" disabled={busy} onClick={() => void done(api.bank.settleOwnCompany(t.id, 'prive'))}>Privé</Button>
            <Button small disabled={busy} onClick={() => void done(api.bank.settleOwnCompany(t.id, 'vraag'))}>Weet ik nog niet: vraag mijn boekhouder</Button>
            <span className="small muted">
              {ownCompany.data.documentId || ownCompany.data.purchaseId
                ? 'Kies je hieronder "Nee, dit was privé" of "Weet ik nog niet", dan gaat de factuur ook mee. Een soort kosten kan niet zolang die factuur erbij hoort.'
                : 'Was het toch iets anders? Kies dat dan hieronder.'}
            </span>
          </div>
        </div>
      )}
      {linked && (
        <div className="notice warn" role="note" data-testid="aankoop-bij-betaling">
          <strong>Hoort deze betaling bij een aankoop die er al staat?</strong>
          {linked.candidates.map((c) => (
            <div key={c.purchaseId} style={{ marginTop: 8 }}>
              <div className="small">{purchaseCandidateText(c)}</div>
              {c.amountFit === 'ongeveer' ? (
                <div className="small muted">Het bedrag is anders dan deze betaling (<Euro cents={-t.amount} />). Klopt het bedrag van de aankoop niet? Pas dat eerst aan bij Aankopen; daarna kun je hem hier koppelen.</div>
              ) : (
                <div className="row" style={{ marginTop: 4 }}>
                  {/* contant betaald staat niet op de bank: het kunnen net zo goed twee aankopen zijn, dus geen voorgestelde keuze */}
                  <Button small kind={linked.oneClick && !(c.state === 'elders' && c.via !== 'prive') ? 'primary' : undefined} disabled={busy} onClick={() => void done(api.bank.linkPurchase(t.id, c.purchaseId))}>Ja, dit is de betaling van die aankoop</Button>
                </div>
              )}
            </div>
          ))}
          <div className="small" style={{ marginTop: 8 }}>
            {linked.strong ? 'Kies je een soort kosten, dan tellen de kosten en de btw twee keer. ' : ''}
            {/* alleen als er een "Ja" te kiezen is: bij een bedrag dat net anders is, staat er geen knop */}
            {linked.candidates.some((c) => c.amountFit !== 'ongeveer') && 'Bij "Ja" wordt de betaling aan de aankoop gekoppeld; er komt geen tweede kostenpost bij.'}
            {linked.candidates.some((c) => c.state === 'elders' && c.amountFit !== 'ongeveer') ? ' De betaling met privégeld of contant die bij de aankoop stond, wordt teruggedraaid.' : ''}
            {linked.candidates.every((c) => c.amountFit === 'ongeveer') && 'Hoort de betaling er niet bij, kies dan "Nee, iets anders"; daarna deel je hem zelf in.'}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <Button small disabled={busy} onClick={async () => {
              // op deze pagina blijven: daarna deel je de betaling zelf in
              if ((await run(async () => { await api.bank.rejectPurchases(t.id); return true; })) !== undefined) await Promise.all([purchaseQuestion.reload(), suggestions.reload(), ownCompany.reload()]);
            }}>Nee, iets anders</Button>
          </div>
        </div>
      )}
      {strongCredits.length > 0 && (
        <div className="notice warn" role="note" data-testid="creditnota-bij-geld">
          <strong>Is dit het geld terug van een creditnota die er al staat?</strong>
          {strongCredits.map((c) => (
            <div key={c.purchaseId} style={{ marginTop: 8 }}>
              <div className="small">{creditText(c)}</div>
              <div className="row" style={{ marginTop: 4 }}>
                <Button small kind={strongCredits.length === 1 ? 'primary' : undefined} disabled={busy} onClick={() => void done(api.bank.matchPurchase(t.id, c.purchaseId))}>Ja, dit is het geld terug van die creditnota</Button>
              </div>
            </div>
          ))}
          <div className="small" style={{ marginTop: 8 }}>
            Geld terug van een leverancier is geen omzet. Bij "Ja" wordt het geld aan de creditnota gekoppeld; de kosten zijn bij de creditnota al verlaagd en gaan niet nog een keer omlaag.
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <Button small disabled={busy} onClick={async () => {
              // op deze pagina blijven: daarna deel je het geld zelf in
              if ((await run(async () => { await api.bank.rejectPurchases(t.id); return true; })) !== undefined) await Promise.all([creditNotes.reload(), suggestions.reload()]);
            }}>Nee, iets anders</Button>
          </div>
        </div>
      )}
      {t.status !== 'nieuw' ? (
        <div className="card">
          <StatusPill status={t.status} />
          <p className="muted small">Verkeerd verwerkt, of stond het bij "weet ik nog niet"? Maak het ongedaan; de app draait het netjes terug en je kiest hieronder meteen wat het wel was.</p>
          <div className="row">
            <Button disabled={busy} onClick={async () => {
              // op deze pagina blijven: daarna meteen opnieuw indelen
              if ((await run(async () => { await api.bank.unmatch(t.id); return true; }, 'Teruggedraaid. Kies nu wat het wel was.')) !== undefined) {
                setDoubleOf(null);
                await Promise.all([txs.reload(), suggestions.reload(), own.reload(), sames.reload(), creditNotes.reload(), payout.reload()]);
              }
            }}>Ongedaan maken</Button>
            {t.status === 'gematcht' && !t.matched_invoice_id && !t.matched_purchase_invoice_id && t.amount < 0 && (
              <Button onClick={() => setRecat(!recat)}>Andere categorie</Button>
            )}
            {/* eerder genegeerd zonder koppeling: alsnog zeggen van welke betaling dit een dubbele regel is (#225) */}
            {t.status === 'genegeerd' && !t.duplicate_of && (
              <Button disabled={busy} onClick={async () => {
                const found = await run(() => api.bank.duplicateCandidates(t.id));
                if (found !== undefined) setDoubleOf(found);
              }}>Dit is een dubbele regel van…</Button>
            )}
          </div>
          {t.status === 'genegeerd' && !t.duplicate_of && doubleOf && (
            <div className="notice" role="note" data-testid="genegeerd-dubbel" style={{ marginTop: 12 }}>
              {doubleOf.length === 0 ? (
                <span className="small">Er staat geen andere betaling van hetzelfde bedrag op deze rekening binnen een paar werkdagen.</span>
              ) : (
                <>
                  <strong>Van welke betaling is dit een dubbele regel?</strong>
                  <div className="small" style={{ marginTop: 4 }}>Een genegeerde regel telt nog mee in de saldocontrole. Koppel je hem aan de betaling waar hij een dubbel van is, dan telt hij daar niet meer in mee. Je kunt hem altijd terugzetten.</div>
                  <div className="choice" style={{ marginTop: 8 }}>{doubleChoices(doubleOf)}</div>
                </>
              )}
            </div>
          )}
          {recat && (
            <div style={{ marginTop: 12 }}>
              <CategoryPicker txId={t.id} amount={Math.abs(t.amount)} onPick={(categoryKey, vatCode, businessPct) => void done(api.bank.reclassify(t.id, categoryKey, vatCode, businessPct), inv(categoryKey, vatCode))} />
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
          {!mustAnswer && proposals.length > 0 && (
            <>
              <h2>Hoort dit hierbij?</h2>
              <div className="choice">
                {proposals.map((s) => (
                  <button key={s.label} disabled={busy} onClick={() => void done(s.kind === 'factuur' ? api.bank.matchInvoice(t.id, s.invoiceId) : s.kind === 'inkoop' ? api.bank.matchPurchase(t.id, s.purchaseId) : Promise.resolve())}>
                    {s.label}
                    <div className="hint">{s.reasons.join(' · ')}</div>
                  </button>
                ))}
              </div>
            </>
          )}

          {mustAnswer ? null : t.amount > 0 ? (
            <>
              {payout.data && (
                <div className="notice warn" role="note" data-testid="uitbetaling-betaaldienst">
                  <strong>Is dit de uitbetaling van {payout.data}?</strong>
                  <div className="small" style={{ marginTop: 4 }}>
                    Er staan verkopen in de app waarvan het geld nog niet binnen is. Is dit de uitbetaling daarvan, dan is het geen nieuwe verkoop: kies je "Verkoop via een ander systeem", dan telt de omzet twee keer.
                  </div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <Button small kind="primary" disabled={busy} onClick={() => void done(api.bank.bookPayout(t.id))}>Uitbetaling van {payout.data}: geen nieuwe verkoop</Button>
                  </div>
                </div>
              )}
              {previousSale.data && (
                <div className="card">
                  <strong>Weer een verkoop{previousSale.data.channel ? ` via ${previousSale.data.channel}` : ''}?</strong>
                  <p className="small muted">Net als vorige keer ({formatDateNl(previousSale.data.date)}): {saleVatText(previousSale.data.vatCode)}.</p>
                  <Button kind="primary" disabled={busy} onClick={() => void done(api.bank.repeatSale(t.id))}>Klopt, verwerk als verkoop</Button>
                </div>
              )}
              <h2>{previousSale.data ? 'Of was het iets anders?' : 'Waar is dit geld voor?'}</h2>
              {invoices.length > 0 && (
                <Field label="Betaling van een factuur">
                  <select defaultValue="" onChange={(e) => e.target.value && void done(api.bank.matchInvoice(t.id, Number(e.target.value)))}>
                    <option value="">Kies de factuur…</option>
                    {invoices.map((i) => <option key={i.id} value={i.id}>{i.number} — {i.relation_name} — {(i.open_amount / 100).toFixed(2).replace('.', ',')}</option>)}
                  </select>
                </Field>
              )}
              {credits.length > 0 && (
                <Field label="Geld terug bij een creditnota van een leverancier">
                  <select defaultValue="" onChange={(e) => e.target.value && void done(api.bank.matchPurchase(t.id, Number(e.target.value)))}>
                    <option value="">Kies de creditnota…</option>
                    {credits.map((c) => <option key={c.purchaseId} value={c.purchaseId}>{c.supplier ?? c.description} — {formatDateNl(c.date)} — {(c.open / 100).toFixed(2).replace('.', ',')}</option>)}
                  </select>
                </Field>
              )}
              <div className="choice" style={{ marginTop: 12 }}>
                {(pots.data ?? []).filter((p) => p.id !== t.bank_account_id).map((p) => (
                  <button key={`pot-${p.id}`} disabled={busy} onClick={() => void done(api.bank.book(t.id, { account: p.rgs_code, description: `Uit potje ${p.name}` }))}>
                    Uit potje {p.name}
                    <div className="hint">Geld terug van een potje binnen je eigen bank: geen omzet</div>
                  </button>
                ))}
                <button disabled={busy} className={refund ? 'selected' : ''} aria-expanded={refund} onClick={() => setRefund(!refund)}>
                  Geld terug van een aankoop (refund)
                  <div className="hint">Een leverancier of webshop betaalde je iets terug. Dat verlaagt je kosten (en de btw die je terugkreeg), het is geen omzet</div>
                </button>
                {refund && (
                  <div className="card flat">
                    {/* staat de creditnota er al, dan zijn de kosten daar al verlaagd: niet nog een keer */}
                    {credits.some((c) => c.sameAmount || c.sameSupplier) && (
                      <p className="small" role="note" data-testid="refund-creditnota">
                        <strong>Let op:</strong> er staat een open creditnota {credits.some((c) => c.sameAmount) ? 'met dit bedrag' : 'van deze leverancier'}. Hoort dit geld daarbij, kies hem dan hierboven bij "Geld terug bij een creditnota van een leverancier": de kosten zijn bij de creditnota al verlaagd.
                      </p>
                    )}
                    <CategoryPicker
                      incoming
                      amount={Math.abs(t.amount)}
                      onPick={(categoryKey, vatCode) => void done(api.home.act({ key: '', kind: 'bank-business', icon: '', title: '', question: '', actions: [], ref: { bankTransactionId: t.id } }, 'zakelijk', { categoryKey, vatCode }))}
                    />
                    <p className="small muted">Kies dezelfde categorie en btw als bij de oorspronkelijke aankoop.</p>
                    <Button small disabled={busy} onClick={() => void done(api.home.act({ key: '', kind: 'bank-business', icon: '', title: '', question: '', actions: [], ref: { bankTransactionId: t.id } }, 'prive'))}>
                      Het was een privé-aankoop
                    </Button>
                  </div>
                )}
                {['omzet', 'rente', 'prive-storting', 'btw', 'overboeking', 'onbekend'].map((key) => meta.otherDestinations.find((d) => d.key === key)!).map((d) => (
                  <Fragment key={d.key}>
                    <button disabled={busy} className={d.key === 'omzet' && sale ? 'selected' : ''} aria-expanded={d.key === 'omzet' ? sale : undefined} onClick={() => (d.key === 'omzet' ? setSale(!sale) : void done(api.bank.book(t.id, { account: d.account })))}>
                      {d.label}
                      {'hint' in d && d.hint && <div className="hint">{d.hint}</div>}
                    </button>
                    {/* direct onder de knop, niet onderaan na alle andere keuzes */}
                    {d.key === 'omzet' && sale && (
                      <SaleForm txId={t.id} amount={t.amount} description={t.description ?? ''} busy={busy} onBook={(input) => void done(api.bank.bookSale(t.id, input))} />
                    )}
                  </Fragment>
                ))}
              </div>
            </>
          ) : (
            <>
              <h2>Was dit zakelijk?</h2>
              {invoices.filter((i) => i.open_amount < 0).length > 0 && (
                <Field label="Terugbetaling van een creditfactuur">
                  <select defaultValue="" onChange={(e) => e.target.value && void done(api.bank.matchInvoice(t.id, Number(e.target.value)))}>
                    <option value="">Kies de creditfactuur…</option>
                    {invoices.filter((i) => i.open_amount < 0).map((i) => <option key={i.id} value={i.id}>{i.number} — {i.relation_name} — {(-i.open_amount / 100).toFixed(2).replace('.', ',')}</option>)}
                  </select>
                </Field>
              )}
              <div className="card">
                <CategoryPicker
                  txId={t.id}
                  amount={Math.abs(t.amount)}
                  key={String(suggestions.data?.length)}
                  initial={(() => {
                    const s = (suggestions.data ?? []).find((x) => x.kind === 'rekening');
                    return s && s.kind === 'rekening' ? (meta.expenseCategories.find((c) => c.account === s.account && !c.key.startsWith('eigen-')) ?? meta.expenseCategories.find((c) => c.account === s.account))?.key : undefined;
                  })()}
                  onPick={(categoryKey, vatCode, businessPct) => void done(api.home.act({ key: '', kind: 'bank-business', icon: '', title: '', question: '', actions: [], ref: { bankTransactionId: t.id } }, 'zakelijk', { categoryKey, vatCode, businessPct }), inv(categoryKey, vatCode))}
                />
              </div>
              <div className="choice" style={{ marginTop: 12 }}>
                <button disabled={busy} onClick={() => void done(api.home.act({ key: '', kind: 'bank-business', icon: '', title: '', question: '', actions: [], ref: { bankTransactionId: t.id } }, 'prive'))}>Nee, dit was privé</button>
                {(pots.data ?? []).filter((p) => p.id !== t.bank_account_id).map((p) => (
                  <button key={`pot-${p.id}`} disabled={busy} onClick={() => void done(api.bank.book(t.id, { account: p.rgs_code, description: `Naar potje ${p.name}` }))}>
                    Naar potje {p.name}
                    <div className="hint">Geld opzij gezet binnen je eigen bank: geen kosten</div>
                  </button>
                ))}
                {meta.otherDestinations.filter((d) => ['btw', 'overboeking', 'onbekend'].includes(d.key)).map((d) => (
                  <button key={d.key} disabled={busy} onClick={() => void done(api.bank.book(t.id, { account: d.account }))}>
                    {d.label}
                    {'hint' in d && d.hint && <div className="hint">{d.hint}</div>}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="row end" style={{ marginTop: 16 }}>
            <Button kind="ghost" disabled={busy} onClick={async () => {
              // staat er een betaling van hetzelfde bedrag rond dezelfde dag, dan eerst de vraag of dit daar een dubbel van is
              const found = await run(() => api.bank.duplicateCandidates(t.id));
              if (found === undefined) return;
              if (found.length === 0) return void done(api.bank.ignore(t.id));
              setDoubleOf(found);
            }} title="Bijvoorbeeld een dubbele regel">Negeren (dubbel of niet belangrijk)</Button>
          </div>
          {doubleOf && (
            <div className="notice" role="note" data-testid="negeren-dubbel" style={{ marginTop: 8 }}>
              <strong>Staat deze betaling er al in?</strong>
              <div className="small" style={{ marginTop: 4 }}>Is dit een dubbele regel, kies dan van welke betaling. De app koppelt hem daaraan: hij telt dan niet mee in je boekhouding en ook niet in de saldocontrole, en je kunt hem altijd terugzetten.</div>
              <div className="choice" style={{ marginTop: 8 }}>
                {doubleChoices(doubleOf)}
                <button disabled={busy} onClick={() => void done(api.bank.ignore(t.id))}>
                  Nee, alleen negeren
                  <div className="hint">Het geld ging wel van je rekening, maar hoort niet in je boekhouding</div>
                </button>
              </div>
            </div>
          )}
          <p className="small muted" style={{ textAlign: 'right', marginTop: 4 }}>Negeren telt niet mee in je boekhouding: alleen voor een dubbele regel. Twijfel je, kies dan "Weet ik nog niet".</p>
        </>
      )}
    </div>
  );
}
