import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Euro, DateNl, useApp } from '../ui';
import type { SearchGroup } from '../../search/search';

const KIND_LABEL: Record<string, string> = { document: '📷 Document', factuur: '💰 Factuur', offerte: '📄 Offerte', relatie: '👤 Relatie', bank: '🏦 Betaling', klus: '🔨 Klus', inkoop: '🧾 Aankoop', boeking: '📚 Boeking' };

/** Snippet met [[treffer]] → gemarkeerde tekst, zonder HTML te injecteren. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[\[.*?\]\])/g);
  return <>{parts.map((p, i) => (p.startsWith('[[') ? <mark key={i}>{p.slice(2, -2)}</mark> : <span key={i}>{p}</span>))}</>;
}

/** Eén zoekbalk over alles (#26). Ctrl+K of de knop in het menu. Tip: "> 400", "2026-09". */
export function SearchOverlay({ onClose }: { onClose: () => void }) {
  const { go, settings } = useApp();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        setResults(q.trim() ? await api.search.query(q) : []);
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [q]);

  const open = (kind: string, id: number) => {
    onClose();
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
    go({ screen: screen as never, id: rid });
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
            if (e.key === 'Enter' && results[0]) open(results[0].hits[0]!.kind, results[0].hits[0]!.id);
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
              {g.warranty && <div className="small">🛡️ {g.warranty}</div>}
              {g.links.length > 1 && (
                <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {g.links.filter((l) => l.kind !== 'boeking' || settings.advancedMode).map((l) => (
                    <button key={`${l.kind}${l.id}`} className="chip-link" onClick={() => open(l.kind, l.id)}>{KIND_LABEL[l.kind]}: {l.label}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
