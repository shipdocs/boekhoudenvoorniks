import { useState } from 'react';
import { api } from '../api';
import { Button, DateNl, Empty, ErrorBox, Euro, StatusPill, useApp, useLoad } from '../ui';

export function Work() {
  const { go, route } = useApp();
  const [tab, setTab] = useState<'facturen' | 'offertes'>((route.extra?.tab as 'facturen' | 'offertes') ?? 'facturen');
  const [filter, setFilter] = useState<string>((route.extra?.filter as string) ?? '');
  const [search, setSearch] = useState('');
  const invoices = useLoad(() => api.invoices.list({ search: search || undefined }), [search]);
  const quotes = useLoad(() => api.quotes.list({ search: search || undefined }), [search]);

  const invList = (invoices.data ?? []).filter((i) =>
    filter === 'open' ? ['openstaand', 'vervallen'].includes(i.display_status) : filter ? i.display_status === filter : true,
  );

  return (
    <div className="page">
      <div className="row between">
        <div>
          <h1>Werk & facturen</h1>
          <p className="sub">Offertes, facturen en wie er nog moet betalen.</p>
        </div>
        <div className="row">
          <Button onClick={() => go({ screen: 'offerte' })}>+ Nieuwe offerte</Button>
          <Button kind="primary" onClick={() => go({ screen: 'factuur' })}>+ Nieuwe factuur</Button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 14 }}>
        <div className="chips">
          <button className={tab === 'facturen' ? 'selected' : ''} onClick={() => setTab('facturen')}>Facturen</button>
          <button className={tab === 'offertes' ? 'selected' : ''} onClick={() => setTab('offertes')}>Offertes</button>
        </div>
        {tab === 'facturen' && (
          <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter">
            <option value="">Alle facturen</option>
            <option value="open">Nog te ontvangen</option>
            <option value="vervallen">Te laat</option>
            <option value="concept">Nog niet verstuurd</option>
            <option value="betaald">Betaald</option>
          </select>
        )}
        <input className="grow" placeholder="Zoek op klant of nummer…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {tab === 'facturen' ? (
        <>
          <ErrorBox error={invoices.error} />
          {invList.length === 0 ? (
            <Empty icon="💰" title="Nog geen facturen">Maak je eerste factuur, of maak er een van een offerte waar de klant ja op zei.</Empty>
          ) : (
            <table className="list">
              <thead><tr><th>Nummer</th><th>Klant</th><th>Datum</th><th>Status</th><th className="num">Bedrag</th><th className="num">Nog open</th></tr></thead>
              <tbody>
                {invList.map((i) => (
                  <tr key={i.id} className="clickable" onClick={() => go({ screen: 'factuur', id: i.id })}>
                    <td>{i.number ?? <span className="muted">concept</span>}</td>
                    <td>{i.relation_name}</td>
                    <td><DateNl date={i.invoice_date} /></td>
                    <td><StatusPill status={i.display_status} /></td>
                    <td className="num"><Euro cents={i.total} /></td>
                    <td className="num">{i.open_amount ? <Euro cents={i.open_amount} /> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : (
        <>
          <ErrorBox error={quotes.error} />
          {(quotes.data ?? []).length === 0 ? (
            <Empty icon="📄" title="Nog geen offertes">Een offerte wordt na akkoord een klus, en daarna met één klik een factuur.</Empty>
          ) : (
            <table className="list">
              <thead><tr><th>Nummer</th><th>Klant</th><th>Datum</th><th>Geldig tot</th><th>Status</th><th className="num">Bedrag</th></tr></thead>
              <tbody>
                {(quotes.data ?? []).map((q) => (
                  <tr key={q.id} className="clickable" onClick={() => go({ screen: 'offerte', id: q.id })}>
                    <td>{q.number}</td>
                    <td>{q.relation_name}</td>
                    <td><DateNl date={q.quote_date} /></td>
                    <td><DateNl date={q.valid_until} /> {q.expired && <span className="pill warn">verlopen</span>}</td>
                    <td><StatusPill status={q.status} /></td>
                    <td className="num"><Euro cents={q.total} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
