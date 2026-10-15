import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, ErrorBox, Field, Modal, useAction, useApp, useLoad } from '../ui';

const CATEGORY_LABEL: Record<string, string> = { activa: 'Balans (bezit)', passiva: 'Balans (vermogen en schulden)', omzet: 'Omzet', kosten: 'Winst en verlies', btw: 'Btw' };

/**
 * Boekhouding → Rekeningschema: alle grootboekrekeningen, eigen rekeningen toevoegen (met verplichte
 * officiële RGS-code, zodat balans, auditfile en pakket voor de boekhouder blijven kloppen) en hernoemen.
 */
export function ChartOfAccountsTab() {
  const { settings } = useApp();
  const { run } = useAction();
  const accounts = useLoad(() => api.ledger.accounts());
  const inUse = useLoad(() => api.ledger.accountsInUse());
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const used = new Set(inUse.data ?? []);
  const reload = async () => { await Promise.all([accounts.reload(), inUse.reload()]); };
  return (
    <>
      <div className="row between">
        <p className="muted" style={{ margin: 0 }}>Elke rekening heeft een officiële RGS-code. Daarmee kloppen de balans, de auditfile en het pakket voor je boekhouder ook met rekeningen die je zelf toevoegt.</p>
        <Button kind="primary" onClick={() => setAdding(true)}>+ Rekening toevoegen</Button>
      </div>
      {settings.legalForm !== 'bv' && <p className="small muted">Heb je een bv? Kies dan bij Instellingen → Je bedrijf de rechtsvorm bv; de rekeningen voor loon, loonheffing, rekening-courant, vennootschapsbelasting en aandelenkapitaal komen er dan vanzelf bij.</p>}
      <ErrorBox error={accounts.error ?? inUse.error} />
      <table className="list small" data-testid="rekeningschema">
        <thead><tr><th>Nummer</th><th>Naam</th><th>RGS-code</th><th>Soort</th><th><span className="sr-only">Acties</span></th></tr></thead>
        <tbody>
          {(accounts.data ?? []).map((a) => (
            <tr key={a.id}>
              <td>{a.code}</td>
              <td>{a.name}</td>
              <td>{a.rgs_ref ?? <span className="muted">—</span>}</td>
              <td>{CATEGORY_LABEL[a.category] ?? a.category}</td>
              <td className="right">
                <Button small kind="ghost" onClick={() => setRenaming({ id: a.id, name: a.name })}>Hernoemen</Button>
                {!a.is_system && !used.has(a.id) && (
                  <Button small kind="ghost" onClick={async () => {
                    if (!confirm(`Rekening ${a.code} ${a.name} weghalen? Er is nog niet op geboekt.`)) return;
                    if (await run(async () => { await api.ledger.archiveAccount(a.id); return true; }, 'Rekening weggehaald ✓')) await reload();
                  }}>Weghalen</Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {adding && <AddAccount onClose={() => setAdding(false)} onDone={async () => { setAdding(false); await reload(); }} />}
      {renaming && <RenameAccount account={renaming} onClose={() => setRenaming(null)} onDone={async () => { setRenaming(null); await reload(); }} />}
    </>
  );
}

function AddAccount({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const { run, busy } = useAction();
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [rgs, setRgs] = useState<{ code: string; label: string } | null>(null);
  const [code, setCode] = useState('');
  const [found, setFound] = useState<{ code: string; label: string }[]>([]);
  useEffect(() => {
    if (query.trim().length < 2) { setFound([]); return; }
    let live = true;
    api.ledger.searchRgs(query).then((r) => { if (live) setFound(r); }, () => { if (live) setFound([]); });
    return () => { live = false; };
  }, [query]);
  return (
    <Modal title="Rekening toevoegen" onClose={onClose}>
      <div className="grid">
        <Field label="Naam van de rekening"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="bv. Rekening-courant Jansen Holding" autoFocus /></Field>
        <Field label="RGS-code" hint="zoek op een woord of op de code, bv. rekening-courant of BSchBepLhe">
          <input value={query} onChange={(e) => { setQuery(e.target.value); setRgs(null); }} placeholder="zoeken in de officiële lijst" />
        </Field>
        {rgs ? (
          <p className="small" data-testid="gekozen-rgs"><strong>{rgs.code}</strong> {rgs.label} <Button small kind="ghost" onClick={() => setRgs(null)}>Andere kiezen</Button></p>
        ) : found.length > 0 ? (
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table className="list small">
              <tbody>
                {found.map((f) => (
                  <tr key={f.code}>
                    <td style={{ whiteSpace: 'nowrap' }}>{f.code}</td><td>{f.label}</td>
                    <td className="right"><Button small onClick={() => { setRgs(f); if (!name.trim()) setName(f.label.charAt(0).toUpperCase() + f.label.slice(1)); }}>Kiezen</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : query.trim().length >= 2 ? <p className="small muted">Niets gevonden. Omzet en btw staan er niet bij: die boek je met een factuur of bij de bank.</p> : null}
        <Field label="Rekeningnummer" hint="leeg laten: de app kiest het eerste vrije nummer"><input className="num" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} maxLength={6} /></Field>
      </div>
      <div className="row end" style={{ marginTop: 16 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={busy || !rgs || !name.trim()} onClick={async () => {
          const r = await run(() => api.ledger.addAccount({ name, rgsRef: rgs!.code, code: code || null }), 'Rekening toegevoegd ✓');
          if (r) await onDone();
        }}>Toevoegen</Button>
      </div>
    </Modal>
  );
}

function RenameAccount({ account, onClose, onDone }: { account: { id: number; name: string }; onClose: () => void; onDone: () => Promise<void> }) {
  const { run, busy } = useAction();
  const [name, setName] = useState(account.name);
  return (
    <Modal title="Rekening hernoemen" onClose={onClose}>
      <Field label="Naam"><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <p className="small muted">Alleen de naam verandert. Het nummer en de RGS-code blijven, net als alles wat er al op geboekt is.</p>
      <div className="row end" style={{ marginTop: 16 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={busy || !name.trim() || name.trim() === account.name} onClick={async () => {
          if (await run(async () => { await api.ledger.renameAccount(account.id, name); return true; }, 'Naam aangepast ✓')) await onDone();
        }}>Opslaan</Button>
      </div>
    </Modal>
  );
}
