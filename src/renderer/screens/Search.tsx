import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Euro, DateNl, Empty, useApp, type Route } from '../ui';
import type { SearchGroup } from '../../search/search';

const KIND_LABEL: Record<string, string> = { document: '📷 Document', factuur: '💰 Factuur', offerte: '📄 Offerte', relatie: '👤 Klant/leverancier', bank: '🏦 Betaling', klus: '🔨 Klus', inkoop: '🧾 Aankoop', boeking: '📚 Boeking' };

/** Snippet met [[treffer]] → gemarkeerde tekst, zonder HTML te injecteren. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[\[.*?\]\])/g);
  return <>{parts.map((p, i) => (p.startsWith('[[') ? <mark key={i}>{p.slice(2, -2)}</mark> : <span key={i}>{p}</span>))}</>;
}

/** Waar een zoekresultaat heen gaat als je erop klikt. */
function routeFor(kind: string, id: number): Route {
  const target: Record<string, [string, number | undefined]> = {
    document: ['document', id],
    factuur: ['factuur', id],
    offerte: ['offerte', id],
    relatie: ['klant', id],
    bank: ['categorie', id],
    klus: ['klus', id],
    inkoop: ['aankopen', undefined],
    boeking: ['expert', undefined],
  };
  const [screen, rid] = target[kind] ?? ['home', undefined];
  return { screen: screen as never, id: rid };
}

/** Zoekt terwijl je typt; een oudere, tragere zoekopdracht overschrijft de resultaten van een nieuwere niet. */
function useSearch(q: string, limit: number): { results: SearchGroup[]; error: string | null; busy: boolean } {
  const [results, setResults] = useState<SearchGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = q.trim() ? await api.search.query(q, undefined, limit) : [];
        if (!current) return;
        setResults(r);
        setError(null);
      } catch (e) {
        if (current) setError((e as Error).message);
      } finally {
        if (current) setBusy(false);
      }
    }, 150);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [q, limit]);
  return { results, error, busy };
}

/** Wat eraan vastzit, zonder het resultaat zelf ("Betaling: betaling" bij een betaling). */
function otherLinks(g: SearchGroup, advanced: boolean): SearchGroup['links'] {
  const self = g.hits[0]!;
  return g.links.filter((l) => !(l.kind === self.kind && l.id === self.id) && (l.kind !== 'boeking' || advanced));
}

/** Kort: hoe het ervoor staat en waar het geboekt is ("Verwerkt · Revolut · Software & abonnementen"). */
function infoLine(g: SearchGroup): string {
  const i = g.info;
  if (!i) return '';
  return [i.status, i.paidVia, i.booking?.summary].filter(Boolean).join(' · ');
}

/** de laatste zoekopdracht in het zoekscherm, zodat je na "Bekijken" en terug verder kunt */
let lastQuery = '';

/** Eén zoekbalk over alles (#26). Ctrl+K. Tip: "> 400", "2026-09". Het hele overzicht staat in het zoekscherm. */
export function SearchOverlay({ onClose }: { onClose: () => void }) {
  const { go, settings } = useApp();
  const [q, setQ] = useState('');
  const { results, error } = useSearch(q, 50);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const open = (kind: string, id: number) => {
    onClose();
    go(routeFor(kind, id));
  };
  const openAll = () => {
    onClose();
    lastQuery = q;
    go({ screen: 'zoeken' });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal search-modal" role="dialog" aria-label="Zoeken" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="search-input"
          placeholder="Zoek in bonnen, facturen, betalingen, klanten… (bv. 'boormachine', 'Jansen > 400', '2026-09')"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter' && e.shiftKey) openAll();
            else if (e.key === 'Enter' && results[0]) open(results[0].hits[0]!.kind, results[0].hits[0]!.id);
          }}
        />
        {error && <div className="notice warn small">{error}</div>}
        <div className="search-results">
          {q.trim() && results.length === 0 && !error && <p className="muted small">Niets gevonden.</p>}
          {results.map((g) => (
            <div key={g.key} className="search-group">
              <button className="search-main" onClick={() => open(g.hits[0]!.kind, g.hits[0]!.id)}>
                <span className="small muted">{KIND_LABEL[g.hits[0]!.kind]}</span>
                <strong>{g.title}</strong>
                <span className="grow" />
                {g.date && <span className="small muted"><DateNl date={g.date} /></span>}
                {g.amount !== null && <span className="small"><Euro cents={g.amount} /></span>}
              </button>
              <div className="small muted"><Snippet text={g.hits[0]!.snippet} /></div>
              {infoLine(g) && <div className="small">{infoLine(g)}</div>}
              {g.warranty && <div className="small">🛡️ {g.warranty}</div>}
              {otherLinks(g, settings.advancedMode).length > 0 && (
                <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {otherLinks(g, settings.advancedMode).map((l) => (
                    <button key={`${l.kind}${l.id}`} className="chip-link" onClick={() => open(l.kind, l.id)}>{KIND_LABEL[l.kind]}: {l.label}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        {q.trim() && results.length > 0 && (
          <div className="row between small" style={{ paddingTop: 8 }}>
            <span className="muted">Enter: open het eerste · Shift+Enter: alles in het zoekscherm</span>
            <button className="linklike" onClick={openAll}>Alle resultaten bekijken →</button>
          </div>
        )}
      </div>
    </div>
  );
}

const KINDS: { key: string; label: string }[] = [
  { key: 'bank', label: 'Betalingen' },
  { key: 'inkoop', label: 'Aankopen' },
  { key: 'factuur', label: 'Facturen' },
  { key: 'document', label: 'Bonnen' },
  { key: 'relatie', label: 'Klanten en leveranciers' },
  { key: 'klus', label: 'Klussen' },
  { key: 'offerte', label: 'Offertes' },
];

/**
 * Zoekscherm: dezelfde zoekopdracht als Ctrl+K, maar met alles erbij wat je wilt weten: van welke
 * rekening, waar het op geboekt is, in welke btw-aangifte, of er een bon is, en of het nog aandacht nodig heeft.
 */
export function SearchScreen() {
  const { go, settings } = useApp();
  const [q, setQ] = useState(lastQuery);
  const [kind, setKind] = useState<string | null>(null);
  const [attention, setAttention] = useState(false);
  const { results, error, busy } = useSearch(q, 300);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    lastQuery = q;
  }, [q]);
  const kindOf = (g: SearchGroup) => g.key.split(':')[0]!;
  const counts = new Map<string, number>();
  for (const g of results) counts.set(kindOf(g), (counts.get(kindOf(g)) ?? 0) + 1);
  const shown = results.filter((g) => (!kind || kindOf(g) === kind) && (!attention || g.info?.attention));
  const total = shown.reduce((sum, g) => sum + (g.amount ?? 0), 0);
  const withAmount = shown.filter((g) => g.amount !== null).length;

  return (
    <div className="page">
      <h1>Zoeken</h1>
      <p className="sub">In betalingen, aankopen, bonnen, facturen, klanten en klussen. Tip: "Preply", "Jansen &gt; 400", "Revolut 2026-07".</p>
      <input
        ref={input}
        className="search-input"
        type="search"
        aria-label="Zoeken"
        placeholder="Waar zoek je naar?"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {error && <div className="notice warn small">{error}</div>}
      {results.length > 0 && (
        <div className="row" style={{ margin: '12px 0', gap: 12, flexWrap: 'wrap' }}>
          <div className="chips">
            <button className={kind === null ? 'selected' : ''} onClick={() => setKind(null)}>Alles ({results.length})</button>
            {KINDS.filter((k) => counts.get(k.key)).map((k) => (
              <button key={k.key} className={kind === k.key ? 'selected' : ''} onClick={() => setKind(k.key)}>{k.label} ({counts.get(k.key)})</button>
            ))}
          </div>
          <label className="row small"><input type="checkbox" checked={attention} onChange={(e) => setAttention(e.target.checked)} /> Alleen wat nog aandacht nodig heeft</label>
        </div>
      )}
      {q.trim() && !busy && results.length === 0 && !error && <Empty icon="🔍" title={`Niets gevonden voor "${q.trim()}"`}>Probeer een ander woord, een deel van een naam, of een bedrag als "&gt; 100".</Empty>}
      {shown.length > 0 && (
        <>
          <p className="small muted">
            {shown.length === 1 ? '1 resultaat' : `${shown.length} resultaten`}
            {withAmount > 1 && <>, samen <Euro cents={total} sign /></>}
            {results.length >= 300 && ' (de eerste 300; maak je zoekopdracht preciezer)'}
          </p>
          <table className="list">
            <thead><tr><th>Datum</th><th>Wat</th><th>Rekening</th><th>Geboekt als</th><th>Status</th><th className="num">Bedrag</th></tr></thead>
            <tbody>
              {shown.map((g) => {
                const hit = g.hits[0]!;
                const i = g.info;
                return (
                  <tr key={g.key} className="clickable" onClick={() => go(routeFor(hit.kind, hit.id))}>
                    <td>{g.date ? <DateNl date={g.date} /> : '—'}</td>
                    <td>
                      <span className="small muted">{KIND_LABEL[kindOf(g)] ?? KIND_LABEL[hit.kind]}</span> <strong>{g.title}</strong>
                      {i?.counterparty && i.counterparty !== g.title && <span className="muted"> · {i.counterparty}</span>}
                      <div className="small muted"><Snippet text={hit.snippet} /></div>
                      {g.warranty && <div className="small">🛡️ {g.warranty}</div>}
                      {otherLinks(g, settings.advancedMode).length > 0 && (
                        <div className="row small" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
                          {otherLinks(g, settings.advancedMode).map((l) => (
                            <button key={`${l.kind}${l.id}`} className="chip-link" onClick={() => go(routeFor(l.kind, l.id))}>{KIND_LABEL[l.kind]}: {l.label}</button>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="small">{i?.paidVia ?? <span className="muted">—</span>}</td>
                    <td className="small">
                      {i?.booking?.summary || <span className="muted">—</span>}
                      {i?.booking && i.booking.lines.length > 1 && (
                        <div className="muted">{i.booking.lines.map((l) => `${l.account} ${formatCents(l.amount)}${l.vat ? ` (${l.vat})` : ''}`).join(' · ')}</div>
                      )}
                      {i?.booking?.vatPeriod && <div className="muted">btw {i.booking.vatPeriod.label}{i.booking.vatPeriod.filed ? ' · aangegeven' : ''}</div>}
                      {i?.booking?.reversed && <div className="muted">teruggedraaid</div>}
                    </td>
                    <td className="small">
                      {i?.status && <span className={i.attention ? 'pill warn' : 'pill'}>{i.status}</span>}
                      {i?.automatic && <div className="muted">automatisch verwerkt</div>}
                      {i?.evidence === false && <div className="muted">geen bon</div>}
                      {i?.evidence === true && kindOf(g) !== 'document' && <div className="muted">📎 bon</div>}
                    </td>
                    <td className="num">{g.amount !== null ? <Euro cents={g.amount} sign /> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function formatCents(c: number): string {
  return (Math.abs(c) / 100).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' });
}
