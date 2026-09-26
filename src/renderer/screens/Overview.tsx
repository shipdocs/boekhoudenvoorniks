import { useState } from 'react';
import { api } from '../api';
import { Button, DateNl, ErrorBox, Euro, useAction, useLoad } from '../ui';
import { formatEuro } from '../../shared/money';

/** Eén serie (omzet per maand): staafdiagram in één kleur, tooltip per staaf, tabelweergave als alternatief. */
function RevenueChart({ data }: { data: { month: string; label: string; revenue: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const W = 720;
  const H = 220;
  const pad = { l: 8, r: 8, t: 16, b: 26 };
  const max = Math.max(1, ...data.map((d) => d.revenue));
  const bw = (W - pad.l - pad.r) / data.length;
  const barW = Math.max(4, bw - 2 - 10);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - Math.max(0, v) / max);
  if (table) {
    return (
      <>
        <button className="btn small ghost" onClick={() => setTable(false)}>Toon grafiek</button>
        <table className="list small"><tbody>{data.map((d) => <tr key={d.month}><td>{d.label}</td><td className="num">{formatEuro(d.revenue)}</td></tr>)}</tbody></table>
      </>
    );
  }
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn small ghost" style={{ position: 'absolute', right: 0, top: -36 }} onClick={() => setTable(true)}>Toon als tabel</button>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Omzet per maand, laatste 12 maanden">
        <line className="chart-axis" x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} strokeWidth={1} />
        {data.map((d, i) => {
          const x = pad.l + i * bw + (bw - barW) / 2;
          const top = y(d.revenue);
          const h = H - pad.b - top;
          const r = Math.min(4, h / 2, barW / 2);
          return (
            <g key={d.month} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              {h > 0 && <path className="chart-bar" d={`M${x},${H - pad.b} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${H - pad.b} Z`} opacity={hover === null || hover === i ? 1 : 0.55} />}
              <text className="chart-label" x={x + barW / 2} y={H - 8} textAnchor="middle">{d.label}</text>
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: `${((pad.l + hover * bw + bw / 2) / W) * 100}%`, top: `${(y(data[hover]!.revenue) / H) * 100}%` }}>
          {data[hover]!.label}: {formatEuro(data[hover]!.revenue)}
        </div>
      )}
    </div>
  );
}

export function Overview() {
  const d = useLoad(() => api.dashboard.get());
  if (!d.data) return <div className="page"><ErrorBox error={d.error} /></div>;
  const x = d.data;
  return (
    <div className="page">
      <h1>Hoe gaat het?</h1>
      <p className="sub">Wat heb je verdiend, en wie moet je nog betalen.</p>
      <div className="grid cols-3">
        <div className="card"><div className="muted small">Omzet deze maand</div><div className="big-number"><Euro cents={x.revenueThisMonth} /></div></div>
        <div className="card"><div className="muted small">Omzet dit jaar</div><div className="big-number"><Euro cents={x.revenueThisYear} /></div></div>
        <div className="card"><div className="muted small">Winst dit jaar (voor belasting)</div><div className="big-number"><Euro cents={x.profitThisYear} /></div></div>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h2 style={{ marginTop: 0 }}>Omzet per maand</h2>
        <RevenueChart data={x.revenueByMonth} />
      </div>
      <h2>Wie moet nog betalen?</h2>
      {x.openInvoices.items.length === 0 ? (
        <p className="muted">Niemand — alles is betaald ✓</p>
      ) : (
        <table className="list">
          <tbody>
            {x.openInvoices.items.map((i) => (
              <tr key={i.id}>
                <td>{i.relation}</td><td>{i.number}</td>
                <td>{i.overdue ? <span className="pill bad">te laat</span> : <span className="pill info">op tijd</span>}</td>
                <td className="num"><Euro cents={i.open} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <FixedCosts />
    </div>
  );
}

/** Vaste lasten per maand (#30), met prijsverschil t.o.v. vorig jaar. */
function FixedCosts() {
  const { run } = useAction();
  const list = useLoad(() => api.recurring.list());
  const items = list.data ?? [];
  if (items.length === 0) return null;
  const total = items.reduce((s, x) => s + x.monthly, 0);
  return (
    <div className="card" style={{ marginTop: 18 }}>
      <h2 style={{ marginTop: 0 }}>Vaste lasten: <Euro cents={total} /> per maand</h2>
      <table className="list small">
        <thead><tr><th>Wat</th><th>Hoe vaak</th><th className="num">Bedrag</th><th className="num">Per maand</th><th>Laatst</th><th /></tr></thead>
        <tbody>
          {items.map((x) => (
            <tr key={x.id}>
              <td>{x.counter_name}{x.priceChangePct !== null && Math.abs(x.priceChangePct) >= 5 && <span className={`pill ${x.priceChangePct > 0 ? 'warn' : ''}`}>{x.priceChangePct > 0 ? `${x.priceChangePct}% duurder` : `${-x.priceChangePct}% goedkoper`} dan vorig jaar</span>}</td>
              <td>per {x.interval}</td>
              <td className="num"><Euro cents={x.amount} /></td>
              <td className="num"><Euro cents={x.monthly} /></td>
              <td>{x.lastSeen ? <DateNl date={x.lastSeen} /> : '—'}</td>
              <td><Button small kind="ghost" onClick={async () => { if (confirm(`${x.counter_name} is gestopt?`)) { await run(() => api.recurring.stop(x.id)); await list.reload(); } }}>Gestopt</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
