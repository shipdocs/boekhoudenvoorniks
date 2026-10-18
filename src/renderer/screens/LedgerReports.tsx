import { useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Button, DateNl, ErrorBox, Euro, useApp, useLoad } from '../ui';

/** Rapporten voor de boekhouder: kolommenbalans, grootboekkaarten, relatiekaarten en periodebalans. */

const SOURCE: Record<string, string> = { factuur: 'factuur', inkoop: 'inkoop', bank: 'bank', handmatig: 'handmatig', btw: 'btw', opening: 'beginbalans', integratie: 'koppeling' };

function Toolbar({ children }: { children?: ReactNode }) {
  return (
    <div className="row" style={{ gap: 8, margin: '8px 0', flexWrap: 'wrap', alignItems: 'center' }}>
      {children}
    </div>
  );
}

/** Bedrag met teken: debet positief, credit negatief; 0 als streepje. */
const Amount = ({ cents }: { cents: number }) => (cents === 0 ? <span className="muted">–</span> : <Euro cents={cents} />);

export function TrialBalanceTab({ from, to, onOpenCard }: { from: string; to: string; onOpenCard: (accountId: number) => void }) {
  const data = useLoad(() => api.reports.trialBalance(from, to), [from, to]);
  const [kind, setKind] = useState<'alles' | 'balans' | 'resultaat'>('alles');
  const [q, setQ] = useState('');
  const rows = useMemo(
    () => (data.data?.rows ?? []).filter((r) => (kind === 'alles' || r.kind === kind) && (!q.trim() || `${r.code} ${r.name} ${r.rgsRef ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))),
    [data.data, kind, q],
  );
  const t = data.data?.totals;
  return (
    <>
      <ErrorBox error={data.error} />
      <Toolbar>
        <div className="chips">
          {(['alles', 'balans', 'resultaat'] as const).map((k) => (
            <button key={k} className={kind === k ? 'selected' : ''} onClick={() => setKind(k)}>{{ alles: 'Alles', balans: 'Balans', resultaat: 'Winst en verlies' }[k]}</button>
          ))}
        </div>
        <input type="search" placeholder="Zoek rekening…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Zoek rekening" />
        {data.data && <span className={`pill ${data.data.balanced ? '' : 'warn'}`}>{data.data.balanced ? 'Debet = credit ✓' : 'Debet en credit zijn niet gelijk'}</span>}
      </Toolbar>
      <table className="list small">
        <thead><tr><th>Code</th><th>Omschrijving</th><th>RGS</th><th>Soort</th><th className="num">Beginbalans</th><th className="num">Mut. debet</th><th className="num">Mut. credit</th><th className="num">Eindsaldo</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.accountId} className="clickable" onClick={() => onOpenCard(r.accountId)} title="Open de grootboekkaart">
              <td>{r.code}</td><td>{r.name}</td><td className="muted">{r.rgsRef ?? '—'}</td>
              <td><span className="pill">{r.kind === 'balans' ? 'balans' : 'w&v'}</span></td>
              <td className="num"><Amount cents={r.opening} /></td><td className="num"><Amount cents={r.debit} /></td><td className="num"><Amount cents={r.credit} /></td><td className="num"><Amount cents={r.closing} /></td>
            </tr>
          ))}
          {t && kind === 'alles' && !q.trim() && (
            <tr style={{ fontWeight: 600 }}>
              <td></td><td>Totaal</td><td></td><td></td>
              <td className="num"><Amount cents={t.opening} /></td><td className="num"><Amount cents={t.debit} /></td><td className="num"><Amount cents={t.credit} /></td><td className="num"><Amount cents={t.closing} /></td>
            </tr>
          )}
        </tbody>
      </table>
      {data.data && rows.length === 0 && <p className="muted">Geen boekingen in deze periode.</p>}
      <p className="small muted">Positief is debet, negatief is credit. De beginbalans is de stand aan het begin van de periode; rekeningen voor winst en verlies beginnen op nul. Klik op een rekening voor de kaart.</p>
    </>
  );
}

/** De regels van een kaart, met knoppen om de bron te openen. */
function CardTable({ lines, opening, showAccount }: { lines: { entryId: number; date: string; description: string; source: string; status: string; reversal: boolean; debit: number; credit: number; balance: number; counterparty: string | null; invoiceId: number | null; purchaseId: number | null; bankTransactionId: number | null; account?: string }[]; opening: number; showAccount?: boolean }) {
  const { go } = useApp();
  return (
    <table className="list small">
      <thead><tr><th>Datum</th><th>Omschrijving</th>{showAccount && <th>Rekening</th>}<th>Bron</th><th className="num">Debet</th><th className="num">Credit</th><th className="num">Saldo</th><th></th></tr></thead>
      <tbody>
        <tr className="muted"><td></td><td>Beginsaldo</td>{showAccount && <td></td>}<td></td><td></td><td></td><td className="num"><Amount cents={opening} /></td><td></td></tr>
        {lines.map((l, i) => (
          <tr key={`${l.entryId}-${i}`} style={l.status === 'teruggedraaid' || l.reversal ? { opacity: 0.6 } : undefined}>
            <td><DateNl date={l.date} /></td>
            <td>{l.description}{l.counterparty && <div className="muted">{l.counterparty}</div>}{l.reversal && <span className="pill">tegenboeking</span>}{l.status === 'teruggedraaid' && <span className="pill warn">teruggedraaid</span>}</td>
            {showAccount && <td>{l.account}</td>}
            <td><span className="pill">{SOURCE[l.source] ?? l.source}</span> <span className="muted">#{l.entryId}</span></td>
            <td className="num"><Amount cents={l.debit} /></td><td className="num"><Amount cents={l.credit} /></td><td className="num"><Amount cents={l.balance} /></td>
            <td className="right">
              {l.invoiceId && <Button small kind="ghost" onClick={() => go({ screen: 'factuur', id: l.invoiceId! })}>Factuur</Button>}
              {l.purchaseId && <Button small kind="ghost" onClick={() => go({ screen: 'aankopen', id: undefined })}>Aankopen</Button>}
              {l.bankTransactionId && <Button small kind="ghost" onClick={() => go({ screen: 'categorie', id: l.bankTransactionId! })}>Betaling</Button>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const splitLayout = { display: 'grid', gridTemplateColumns: 'minmax(220px, 300px) minmax(0, 1fr)', gap: 16, alignItems: 'start' } as const;
const listBox = { maxHeight: '65vh', overflowY: 'auto', border: '1px solid var(--border, #e3e6ea)', borderRadius: 8 } as const;

export function LedgerCardsTab({ from, to, selected, onSelect }: { from: string; to: string; selected: number | null; onSelect: (id: number) => void }) {
  const list = useLoad(() => api.reports.trialBalance(from, to), [from, to]);
  const card = useLoad(() => (selected ? api.reports.ledgerCard(selected, from, to) : Promise.resolve(null)), [selected, from, to]);
  const [q, setQ] = useState('');
  const rows = (list.data?.rows ?? []).filter((r) => !q.trim() || `${r.code} ${r.name}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div style={splitLayout}>
      <div>
        <input type="search" placeholder="Zoek rekening…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', marginBottom: 6 }} aria-label="Zoek rekening" />
        <div style={listBox}>
          {rows.map((r) => (
            <button key={r.accountId} className={`list-item${selected === r.accountId ? ' selected' : ''}`} style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 8, textAlign: 'left', padding: '8px 10px', border: 0, background: selected === r.accountId ? 'var(--accent-soft, #e8f0fb)' : 'transparent', cursor: 'pointer' }} onClick={() => onSelect(r.accountId)}>
              <span><strong>{r.code}</strong> {r.name}</span><span><Amount cents={r.closing} /></span>
            </button>
          ))}
          {list.data && rows.length === 0 && <p className="muted" style={{ padding: 10 }}>Geen rekeningen met boekingen.</p>}
        </div>
      </div>
      <div>
        <ErrorBox error={card.error} />
        {!selected && <p className="muted">Kies links een rekening om de boekingen te zien.</p>}
        {card.data && (
          <>
            <Toolbar>
              <h3 style={{ margin: 0 }}>{card.data.code} {card.data.name}</h3>
            </Toolbar>
            <CardTable lines={card.data.lines} opening={card.data.opening} />
            <p style={{ fontWeight: 600 }}>Debet <Euro cents={card.data.debit} /> · Credit <Euro cents={card.data.credit} /> · Eindsaldo <Euro cents={card.data.closing} /></p>
            {card.data.lines.length === 0 && <p className="muted">Geen boekingen in deze periode.</p>}
          </>
        )}
      </div>
    </div>
  );
}

export function RelationCardsTab({ from, to }: { from: string; to: string }) {
  const list = useLoad(() => api.reports.relations(to), [to]);
  const [selected, setSelected] = useState<number | null>(null);
  const [type, setType] = useState<'alle' | 'klant' | 'leverancier'>('alle');
  const [q, setQ] = useState('');
  const card = useLoad(() => (selected ? api.reports.relationCard(selected, from, to) : Promise.resolve(null)), [selected, from, to]);
  const rows = (list.data ?? []).filter((r) => (type === 'alle' || r.type === type || r.type === 'beide') && (!q.trim() || r.name.toLowerCase().includes(q.trim().toLowerCase())));
  return (
    <div style={splitLayout}>
      <div>
        <div className="chips" style={{ marginBottom: 6 }}>
          {(['alle', 'klant', 'leverancier'] as const).map((k) => <button key={k} className={type === k ? 'selected' : ''} onClick={() => setType(k)}>{{ alle: 'Alle', klant: 'Klanten', leverancier: 'Leveranciers' }[k]}</button>)}
        </div>
        <input type="search" placeholder="Zoek relatie…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%', marginBottom: 6 }} aria-label="Zoek relatie" />
        <div style={listBox}>
          {rows.map((r) => (
            <button key={r.relationId} style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 8, textAlign: 'left', padding: '8px 10px', border: 0, background: selected === r.relationId ? 'var(--accent-soft, #e8f0fb)' : 'transparent', cursor: 'pointer' }} onClick={() => setSelected(r.relationId)}>
              <span>{r.name}<div className="small muted">{r.entries} boekingen</div></span><span><Amount cents={r.balance} /></span>
            </button>
          ))}
          {list.data && rows.length === 0 && <p className="muted" style={{ padding: 10 }}>Geen klanten of leveranciers met boekingen.</p>}
        </div>
      </div>
      <div>
        <ErrorBox error={card.error || list.error} />
        {!selected && <p className="muted">Kies links een klant of leverancier. Positief is te ontvangen van de klant, negatief is nog te betalen aan de leverancier.</p>}
        {card.data && (
          <>
            <Toolbar>
              <h3 style={{ margin: 0 }}>{card.data.relation.name}</h3>
            </Toolbar>
            <CardTable lines={card.data.lines} opening={card.data.opening} showAccount />
            <p style={{ fontWeight: 600 }}>Openstaand op <DateNl date={to} />: <Euro cents={card.data.relation.balance} /></p>
          </>
        )}
      </div>
    </div>
  );
}

export function PeriodBalanceTab({ year }: { year: number }) {
  const [gran, setGran] = useState<'maand' | 'kwartaal'>('maand');
  const data = useLoad(() => api.reports.periodBalance(year, gran), [year, gran]);
  const [q, setQ] = useState('');
  const rows = (data.data?.rows ?? []).filter((r) => !q.trim() || `${r.code} ${r.name}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <ErrorBox error={data.error} />
      <Toolbar>
        <div className="chips">
          {(['maand', 'kwartaal'] as const).map((g) => <button key={g} className={gran === g ? 'selected' : ''} onClick={() => setGran(g)}>{{ maand: 'Per maand', kwartaal: 'Per kwartaal' }[g]}</button>)}
        </div>
        <input type="search" placeholder="Zoek rekening…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Zoek rekening" />
        <span className="muted small">Jaar {year} (volgt de datum bij Van)</span>
      </Toolbar>
      <div style={{ overflowX: 'auto' }}>
        <table className="list small">
          <thead><tr><th>Code</th><th>Omschrijving</th><th className="num">Beginbalans</th>{(data.data?.labels ?? []).map((l) => <th key={l} className="num">{l}</th>)}<th className="num">Eindstand</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.accountId}>
                <td>{r.code}</td><td>{r.name}</td><td className="num"><Amount cents={r.opening} /></td>
                {r.periods.map((p, i) => <td key={i} className="num"><Amount cents={p} /></td>)}
                <td className="num"><Amount cents={r.closing} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.data && rows.length === 0 && <p className="muted">Geen boekingen in {year}.</p>}
      <p className="small muted">Mutaties per periode (debet minus credit). Positief is debet, negatief is credit.</p>
    </>
  );
}
