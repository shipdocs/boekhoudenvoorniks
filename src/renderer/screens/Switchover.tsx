import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { Button, DateNl, DropZone, Euro, Field, Modal, MoneyInput, readAsBytes, readAsText, useAction, useApp, useLoad } from '../ui';
import { addDays, isIsoDate, today } from '../../shared/dates';
import { defaultBookValue, startDateConsequences, startDateOptions } from '../../shared/switchover';
import type { OpeningInput, OpeningItem, OpeningKind, OpeningSuggestion, SectionKey, SwitchoverState } from '../../onboarding/switchover';
import type { XafPlan } from '../../onboarding/xaf-import';

/**
 * Overstap-hulp: een lopende administratie overzetten. Hoofdstukken in gewone taal; de app boekt
 * alles als startbalans op de instapdatum en rekent zelf uit wat er van jou in de zaak zit.
 * Tussendoor stoppen mag: alles wat je invult, is meteen bewaard.
 */
export function Switchover() {
  const { route, go } = useApp();
  const { data: state, reload, error } = useLoad(() => api.switchover.state());
  const suggestions = useLoad(() => api.switchover.suggestions());
  const [section, setSection] = useState<SectionKey>((route.extra?.section as SectionKey) ?? 'papieren');
  // na elke wijziging: toestand en voorstellen opnieuw ophalen (een koppeling kan een voorstel laten verdwijnen)
  const refresh = async () => {
    await reload();
    await suggestions.reload();
  };

  if (error) return <div className="page"><div className="notice bad">{error}</div></div>;
  if (!state) return <div className="page">Laden…</div>;
  if (state.settings.mode !== 'overstapper' || !state.settings.date) return <StartChoice state={state} onDone={refresh} />;

  const sections = state.sections.filter((s) => s.needed);
  const index = sections.findIndex((s) => s.key === section);
  const next = sections[index + 1];
  const nextButton = next && (
    <div className="row end" style={{ marginTop: 24 }}>
      <Button kind="primary" onClick={() => { setSection(next.key); window.scrollTo(0, 0); }}>Verder: {next.title.toLowerCase()}</Button>
    </div>
  );
  const props = { state, suggestions: suggestions.data ?? [], refresh, nextButton };

  return (
    <div className="page">
      <div className="row between">
        <div>
          <h1>Overstappen</h1>
          <p className="sub">
            De app houdt je administratie bij vanaf <strong><DateNl date={state.settings.date} /></strong>. Hier zet je erin wat er toen al was.
            Stoppen mag: alles wat je invult, is meteen bewaard.
          </p>
        </div>
        <Button small onClick={() => go({ screen: 'home' })}>Later verder</Button>
      </div>
      <div className="steps">{sections.map((s, i) => <span key={s.key} className={i <= index ? 'on' : ''} />)}</div>
      <div className="chips" style={{ marginBottom: 22 }}>
        {sections.map((s) => (
          <button key={s.key} className={s.key === section ? 'selected' : ''} onClick={() => setSection(s.key)}>
            {s.done ? '✓ ' : ''}{s.title}
          </button>
        ))}
      </div>
      {section === 'papieren' && <Papers {...props} />}
      {section === 'import' && <XafImport {...props} />}
      {section === 'bank' && <Banks {...props} />}
      {section === 'klanten' && <OpenItems kind="klant" {...props} />}
      {section === 'leveranciers' && <OpenItems kind="leverancier" {...props} />}
      {section === 'bezit' && <Assets {...props} />}
      {section === 'btw' && <Vat {...props} />}
      {section === 'resultaat' && <Result {...props} />}
      {section === 'overig' && <Other {...props} />}
      {section === 'klaar' && <Position {...props} onSection={setSection} />}
    </div>
  );
}

interface SectionProps {
  state: SwitchoverState;
  suggestions: OpeningSuggestion[];
  refresh: (next?: unknown) => Promise<void>;
  nextButton: ReactNode;
}

/** Nog geen instapdatum (bv. via Instellingen hierheen): eerst die vraag. */
function StartChoice({ state, onDone }: { state: SwitchoverState; onDone: () => Promise<void> }) {
  const { settings } = useApp();
  const { run, busy } = useAction();
  const [date, setDate] = useState(`${new Date().getFullYear()}-01-01`);
  const valid = isIsoDate(date) && date <= today();
  return (
    <div className="page-narrow">
      <h1>Overstappen met een lopende administratie</h1>
      <p className="sub">Had je al een administratie, in een ander programma, in Excel of bij je boekhouder? Dan zetten we die erin.</p>
      <h2>Vanaf wanneer houdt de app je administratie bij?</h2>
      <div className="choice">
        {startDateOptions(today(), settings.vatPeriod, state.kor).map((o) => (
          <button key={o.key} className={date === o.date ? 'selected' : ''} onClick={() => setDate(o.date)}>
            {o.label}{o.recommended ? ' (aangeraden)' : ''}
            <div className="hint">{o.hint}</div>
          </button>
        ))}
      </div>
      <Field label="Of kies een andere datum"><input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></Field>
      {valid && (
        <div className="notice">
          <ul style={{ margin: 0, paddingLeft: 18 }}>{startDateConsequences(date, settings.vatPeriod, state.kor).map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
      )}
      <div className="row end" style={{ marginTop: 20 }}>
        <Button kind="primary" disabled={busy || !valid} onClick={async () => { if ((await run(() => api.switchover.setMode('overstapper', date))) !== undefined) await onDone(); }}>Beginnen</Button>
      </div>
    </div>
  );
}

// ---------- 1. papieren en instapdatum ----------

function Papers({ state, refresh, nextButton }: SectionProps) {
  const { settings } = useApp();
  const { run, busy } = useAction();
  const [changing, setChanging] = useState(false);
  const [date, setDate] = useState(state.settings.date!);
  return (
    <>
      <h2>Wat heb je nodig?</h2>
      <p className="muted">Leg dit klaar. Heb je iets (nog) niet? Ga gewoon verder en vul het later aan.</p>
      <div className="card flat">
        <ul className="checklist" style={{ display: 'block' }}>
          {state.requirements.map((r) => (
            <li key={r.key} className="no" style={{ marginBottom: 10 }}>
              <strong>{r.label}</strong>{r.optional && <span className="pill" style={{ marginLeft: 8 }}>als je het hebt</span>}
              <div className="small muted">{r.hint}</div>
            </li>
          ))}
        </ul>
        <div className="row end"><Button small onClick={() => window.print()}>🖨️ Lijstje afdrukken</Button></div>
      </div>
      <h3 style={{ marginTop: 24 }}>Instapdatum: <DateNl date={state.settings.date} /></h3>
      {!changing ? (
        <Button small onClick={() => setChanging(true)}>Andere datum kiezen</Button>
      ) : (
        <div className="card flat">
          <div className="grid cols-2">
            <Field label="Nieuwe instapdatum"><input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></Field>
          </div>
          {isIsoDate(date) && <ul className="small">{startDateConsequences(date, settings.vatPeriod, state.kor).map((c) => <li key={c}>{c}</li>)}</ul>}
          <p className="small muted">Wat je al hebt ingevuld, zet de app op de nieuwe datum. Kijk het daarna even na.</p>
          <div className="row end">
            <Button onClick={() => setChanging(false)}>Annuleren</Button>
            <Button kind="primary" disabled={busy || !isIsoDate(date)} onClick={async () => { const r = await run(() => api.switchover.setMode('overstapper', date), 'Instapdatum aangepast'); if (r) { setChanging(false); await refresh(r); } }}>Opslaan</Button>
          </div>
        </div>
      )}
      {nextButton}
    </>
  );
}

// ---------- 2. auditfile uit het vorige programma ----------

const EXPORT_HOWTO: [string, string][] = [
  ['SnelStart', 'menu Administratie → Auditfile exporteren (vanaf versie 12)'],
  ['e-Boekhouden.nl', 'menu Rapporten → Auditfile (XAF)'],
  ['Jortt', 'Boekhoudbot → "Maak voor mij een auditfile"'],
  ['DigiBoox', 'de auditfile vraag je aan bij hun support. Direct kan: de kolommenbalans als Excel (.xlsx) exporteren en die hier neerzetten'],
  ['Moneybird, Exact, Twinfield, Yuki, AFAS, …', 'zoek in de help van je programma op "auditfile" of "XAF"'],
];

function XafImport({ state, refresh, nextButton }: SectionProps) {
  const { run, busy } = useAction();
  const { toast } = useApp();
  const [file, setFile] = useState<{ name: string; data: string | Uint8Array } | null>(null);
  const [plan, setPlan] = useState<XafPlan | null>(null);
  const [include, setInclude] = useState<Set<string>>(new Set());
  const [banks, setBanks] = useState<Record<string, number | 'nieuw' | null>>({});
  const [relations, setRelations] = useState(true);
  const accounts = useLoad(() => api.bank.accounts());
  const date = state.settings.date!;
  const imported = state.items.filter((i) => i.data.bron === 'xaf').length;

  const load = async (f: File) => {
    // auditfile is tekst (XML); een kolommenbalans uit Excel gaat als bytes
    const data = /\.xlsx$/i.test(f.name) ? await readAsBytes(f) : await readAsText(f);
    const p = await run(() => api.switchover.analyzeXaf(data));
    if (!p) return;
    setFile({ name: f.name, data });
    setPlan(p);
    setInclude(new Set(p.proposals.filter((x) => x.include).map((x) => x.key)));
    setBanks(Object.fromEntries(p.banks.map((b) => [b.accountId, b.bankAccountId ?? 'nieuw'])));
  };
  const toggle = (key: string) => setInclude((cur) => {
    const next = new Set(cur);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  return (
    <>
      <h2>Uit je vorige programma</h2>
      <p className="muted">
        Gebruikte je een boekhoudprogramma? Exporteer daar een <strong>auditfile</strong> (een .xaf-bestand) tot en met <DateNl date={addDays(date, -1)} />.
        De app rekent dan zelf uit wat er op je rekeningen stond, welke facturen nog open stonden en wat je bus nog waard is. Jij kijkt het na en vinkt aan wat klopt.
      </p>
      <details className="small" style={{ marginBottom: 12 }}>
        <summary>Waar vind ik de auditfile?</summary>
        <ul>{EXPORT_HOWTO.map(([pkg, how]) => <li key={pkg}><strong>{pkg}</strong>: {how}</li>)}</ul>
        <p className="muted">
          Geen auditfile? Een <strong>kolommenbalans</strong> (proef- en saldibalans) als Excel werkt ook: daar staan de saldi per rekening in, maar geen losse facturen.
          Daarmee stap je in op 1 januari (met de beginbalans) of na de dag van de export. Heb je geen van beide, sla dit dan over en vul de hoofdstukken hierna zelf in.
        </p>
      </details>
      {imported > 0 && !plan && <div className="notice good">✓ {imported} onderdelen overgenomen uit een auditfile. Opnieuw inlezen vervangt ze.</div>}
      <DropZone accept=".xaf,.xml,.xlsx" onFile={(f) => void load(f)}>
        <div style={{ fontSize: 26 }}>📂</div>
        <strong>Sleep je auditfile (.xaf) hierheen</strong>
        <div className="small">of een kolommenbalans als Excel-bestand (.xlsx)</div>
      </DropZone>

      {plan && file && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="small muted">
            {file.name} · {plan.meta.software || 'onbekend programma'} · <DateNl date={plan.meta.startDate} /> t/m <DateNl date={plan.meta.endDate} /> · {plan.meta.accounts} rekeningen{plan.meta.version === 'kolommenbalans' ? ' (alleen saldi)' : `, ${plan.meta.lines} boekingsregels`}
          </div>
          {plan.warnings.map((w) => <div key={w} className="notice warn small">{w}</div>)}

          {plan.banks.length > 0 && (
            <>
              <h3>Bankrekeningen</h3>
              <table className="list"><tbody>
                {plan.banks.map((b) => (
                  <tr key={b.accountId}>
                    <td>{b.name}<div className="small muted">{b.iban ?? `rekening ${b.accountId}`}</div></td>
                    <td style={{ textAlign: 'right' }}><Euro cents={b.amount} /></td>
                    <td>
                      <select aria-label={`Rekening in de app voor ${b.name}`} value={String(banks[b.accountId] ?? '')} onChange={(e) => setBanks({ ...banks, [b.accountId]: e.target.value === '' ? null : e.target.value === 'nieuw' ? 'nieuw' : Number(e.target.value) })}>
                        {(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}{a.iban ? ` (${a.iban})` : ''}</option>)}
                        <option value="nieuw">Nieuwe rekening in de app</option>
                        <option value="">Niet overnemen</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody></table>
            </>
          )}

          <h3>Wat de app overneemt</h3>
          <table className="list"><tbody>
            {plan.proposals.map((p) => (
              <tr key={p.key}>
                <td style={{ width: 28 }}><input type="checkbox" aria-label={p.label} checked={include.has(p.key)} onChange={() => toggle(p.key)} /></td>
                <td>{p.label}{p.note && <div className="small muted">{p.note}</div>}</td>
                <td style={{ textAlign: 'right' }}><Euro cents={p.amount} /></td>
              </tr>
            ))}
          </tbody></table>
          {plan.relations.total > 0 && (
            <label className="row" style={{ marginTop: 10 }}>
              <input type="checkbox" checked={relations} onChange={(e) => setRelations(e.target.checked)} />
              <span>{plan.relations.total} klanten en leveranciers overnemen ({plan.relations.fresh} nieuw)</span>
            </label>
          )}
          <p style={{ marginTop: 12 }}>Volgens je vorige administratie zat er <strong><Euro cents={plan.equity} /></strong> van jou in de zaak. De app vergelijkt dat straks met je startpositie.</p>
          <div className="row end">
            <Button onClick={() => { setPlan(null); setFile(null); }}>Annuleren</Button>
            <Button
              kind="primary"
              disabled={busy}
              onClick={async () => {
                const r = await run(() => api.switchover.applyXaf(file.data, { include: [...include], banks, relations }));
                if (!r) return;
                toast('Overgenomen uit je auditfile');
                setPlan(null);
                setFile(null);
                await refresh(r);
                await accounts.reload();
              }}
            >
              Overnemen
            </Button>
          </div>
        </div>
      )}
      {nextButton}
    </>
  );
}

// ---------- 3. bank ----------

function Banks({ state, refresh, nextButton }: SectionProps) {
  const { run, busy } = useAction();
  const { toast, go } = useApp();
  const [adding, setAdding] = useState(false);
  const date = state.settings.date!;
  const beforeCount = state.banks.reduce((s, b) => s + b.beforeDate, 0);

  const importFile = async (file: File) => {
    const content = await readAsText(file);
    const preview = await run(() => api.bank.previewFile(file.name, content));
    if (!preview) return;
    if (preview.format === 'onbekend') return toast('Dit bestand herkennen we niet. Download bij je bank een afschrift als CAMT-, MT940- of CSV-bestand.', 'error');
    if (preview.format === 'csv' && !preview.csv?.detectedBank && !preview.savedMapping) {
      toast('Dit CSV-bestand kennen we nog niet. Lees het één keer in via Bank, daar wijs je de kolommen aan.', 'error');
      return go({ screen: 'bank' });
    }
    const r = await run(() => api.bank.importFile(file.name, content, preview.savedMapping ?? undefined));
    if (r) toast(`${r.imported} betalingen ingelezen${r.duplicates ? ` (${r.duplicates} hadden we al)` : ''}`);
    await refresh();
  };

  return (
    <>
      <h2>Bankrekeningen</h2>
      <p className="muted">
        Lees je afschriften in vanaf <DateNl date={date} />, van elke zakelijke rekening. Een CAMT- of MT940-bestand is het handigst: daar staat het saldo in,
        dan rekent de app het beginsaldo zelf uit en controleert hij of er niets ontbreekt.
      </p>
      <DropZone accept=".csv,.txt,.sta,.940,.mt940,.xml" onFile={(f) => void importFile(f)}>
        <div style={{ fontSize: 26 }}>🏦</div>
        <strong>Sleep je bankafschriften hierheen</strong>
        <div className="small">Meerdere bestanden of rekeningen? Sleep ze een voor een.</div>
      </DropZone>
      {beforeCount > 0 && (
        <div className="notice warn row between" style={{ marginTop: 14 }}>
          <span>{beforeCount} {beforeCount === 1 ? 'betaling is' : 'betalingen zijn'} van vóór <DateNl date={date} />. Die zitten al in je vorige administratie.</span>
          <Button small kind="primary" disabled={busy} onClick={async () => { await run(() => api.switchover.ignoreBeforeDate(), 'Overgeslagen'); await refresh(); }}>Overslaan</Button>
        </div>
      )}
      {state.banks.map((b) => <BankCard key={b.bankAccountId} bank={b} date={date} checks={state.checks.filter((c) => c.key.endsWith(`-${b.bankAccountId}`))} refresh={refresh} />)}
      <div style={{ marginTop: 14 }}>
        <Button small onClick={() => setAdding(true)}>+ Nog een rekening (spaarrekening, creditcard)</Button>
      </div>
      {adding && <AddAccount onClose={async () => { setAdding(false); await refresh(); }} />}
      {nextButton}
    </>
  );
}

function BankCard({ bank, date, checks, refresh }: { bank: SwitchoverState['banks'][number]; date: string; checks: SwitchoverState['checks']; refresh: SectionProps['refresh'] }) {
  const { run, busy } = useAction();
  const [amount, setAmount] = useState<number | null>(bank.opening);
  const [checkDate, setCheckDate] = useState(bank.balanceCheck?.date ?? bank.coverageTo ?? today());
  const [checkAmount, setCheckAmount] = useState<number | null>(bank.balanceCheck?.source === 'opgegeven' ? bank.balanceCheck.bank : null);
  const save = async (value: number) => {
    const r = await run(() => api.switchover.setBankOpening(bank.bankAccountId, value), 'Beginsaldo opgeslagen');
    if (r) await refresh(r);
  };
  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="row between">
        <strong>{bank.name}</strong>
        <span className="small muted">{bank.iban ?? (bank.isPot ? 'potje' : 'rekeningnummer onbekend')}</span>
      </div>
      <div className="grid cols-2" style={{ marginTop: 10 }}>
        <Field label={`Saldo aan het begin van ${new Date(`${date}T00:00:00`).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' })}`} hint="rood staan: met een min ervoor">
          <div className="row">
            <MoneyInput value={amount} onChange={setAmount} ariaLabel={`Beginsaldo ${bank.name}`} />
            <Button small kind="primary" disabled={busy || amount === null || amount === bank.opening} onClick={() => void save(amount!)}>Opslaan</Button>
          </div>
        </Field>
        <div className="small" style={{ alignSelf: 'end' }}>
          {bank.opening !== null ? <span className="pill good">ingevuld: <Euro cents={bank.opening} /></span> : <span className="pill warn">nog invullen</span>}
          {bank.suggestedOpening && bank.suggestedOpening.amount !== bank.opening && (
            <div style={{ marginTop: 6 }}>
              Voorstel: <Euro cents={bank.suggestedOpening.amount} /> <span className="muted">({bank.suggestedOpening.basis})</span>{' '}
              <Button small onClick={() => { setAmount(bank.suggestedOpening!.amount); void save(bank.suggestedOpening!.amount); }}>Overnemen</Button>
            </div>
          )}
        </div>
      </div>
      {!bank.isPot && (
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          {bank.coverageFrom ? <>Ingelezen: <DateNl date={bank.coverageFrom} /> t/m <DateNl date={bank.coverageTo} /></> : 'Nog geen afschriften ingelezen.'}
        </p>
      )}
      {bank.balanceCheck && bank.balanceCheck.bank === bank.balanceCheck.computed && (
        <div className="notice good small">✓ Klopt: op <DateNl date={bank.balanceCheck.date} /> <Euro cents={bank.balanceCheck.bank} />, precies wat de ingelezen afschriften zeggen.</div>
      )}
      {checks.filter((c) => c.level !== 'ok' && !c.key.startsWith('bank-saldo')).map((c) => (
        <div key={c.key} className={`notice small ${c.level === 'probleem' ? 'bad' : 'warn'}`}><strong>{c.title}</strong><div>{c.detail}</div></div>
      ))}
      {!bank.isPot && bank.opening !== null && bank.coverageTo && (
        <details style={{ marginTop: 8 }}>
          <summary className="small">Saldo volgens je bank invullen om te controleren</summary>
          <div className="row" style={{ marginTop: 8 }}>
            <input type="date" value={checkDate} min={date} max={today()} onChange={(e) => setCheckDate(e.target.value)} aria-label="Datum saldo" />
            <MoneyInput value={checkAmount} onChange={setCheckAmount} ariaLabel={`Saldo volgens de bank ${bank.name}`} placeholder="saldo aan het eind van die dag" />
            <Button small disabled={busy || checkAmount === null || !isIsoDate(checkDate) || checkDate < date || checkDate > today()} onClick={async () => { const r = await run(() => api.switchover.setBankCheck(bank.bankAccountId, checkDate, checkAmount!)); if (r) await refresh(r); }}>Controleren</Button>
          </div>
        </details>
      )}
    </div>
  );
}

function AddAccount({ onClose }: { onClose: () => void }) {
  const { run, busy } = useAction();
  const [name, setName] = useState('');
  const [iban, setIban] = useState('');
  return (
    <Modal title="Rekening toevoegen" onClose={onClose}>
      <div className="grid">
        <Field label="Naam"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="bv. Spaarrekening" autoFocus /></Field>
        <Field label="IBAN" hint="leeg laten voor een potje zonder eigen nummer"><input value={iban} onChange={(e) => setIban(e.target.value)} /></Field>
      </div>
      <div className="row end" style={{ marginTop: 14 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={busy || !name.trim()} onClick={async () => { if ((await run(() => api.bank.addAccount(name.trim(), iban.trim() || null))) !== undefined) onClose(); }}>Toevoegen</Button>
      </div>
    </Modal>
  );
}

// ---------- voorstellen uit de bank ----------

function Suggestions({ list, refresh }: { list: OpeningSuggestion[]; refresh: SectionProps['refresh'] }) {
  const { run, busy } = useAction();
  const [edit, setEdit] = useState<OpeningSuggestion | null>(null);
  if (list.length === 0) return null;
  return (
    <div className="card" style={{ margin: '14px 0' }}>
      <h3 style={{ marginTop: 0 }}>💡 Gevonden in je bankafschriften</h3>
      <p className="small muted">Deze betalingen lijken bij iets van vóór de overstap te horen. Klopt het? Dan zet de app het erin en koppelt de betaling meteen.</p>
      {list.map((s) => (
        <div key={s.txId} className="row between" style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <strong>{s.question}</strong>
            <div className="small muted"><DateNl date={s.date} /> · <Euro cents={s.amount} /> · {s.name}{s.description ? ` · ${s.description}` : ''}</div>
          </div>
          <div className="row">
            <Button small kind="primary" disabled={busy} onClick={() => (s.kind === 'btw' ? void run(async () => refresh(await api.switchover.acceptSuggestion(s.txId)), 'Toegevoegd') : setEdit(s))}>Ja</Button>
            <Button small kind="ghost" disabled={busy} onClick={async () => { const r = await run(() => api.switchover.dismissSuggestion(s.txId)); if (r) await refresh(r); }}>Nee</Button>
          </div>
        </div>
      ))}
      {edit && (
        <SuggestionForm
          s={edit}
          onClose={() => setEdit(null)}
          onSave={async (o) => {
            const r = await run(() => api.switchover.acceptSuggestion(edit.txId, o), 'Toegevoegd en gekoppeld');
            if (r) {
              setEdit(null);
              await refresh(r);
            }
          }}
        />
      )}
    </div>
  );
}

function SuggestionForm({ s, onClose, onSave }: { s: OpeningSuggestion; onClose: () => void; onSave: (o: { relationName: string; number: string; invoiceDate: string }) => void }) {
  const [name, setName] = useState(s.name);
  const [number, setNumber] = useState(s.number ?? '');
  const [date, setDate] = useState(addDays(s.date, -30));
  return (
    <Modal title={s.kind === 'klant' ? 'Factuur van vóór de overstap' : 'Rekening van vóór de overstap'} onClose={onClose}>
      <p className="small muted">Bedrag <Euro cents={s.amount} />, betaald op <DateNl date={s.date} />.</p>
      <div className="grid">
        <Field label={s.kind === 'klant' ? 'Klant' : 'Leverancier'}><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid cols-2">
          <Field label="Factuurnummer" hint={s.kind === 'klant' ? 'verplicht' : 'als je het weet'}><input value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
          <Field label="Factuurdatum" hint="ongeveer mag"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
      </div>
      <div className="row end" style={{ marginTop: 14 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={!name.trim() || (s.kind === 'klant' && !number.trim()) || !isIsoDate(date)} onClick={() => onSave({ relationName: name, number, invoiceDate: date })}>Opslaan</Button>
      </div>
    </Modal>
  );
}

// ---------- 3/4. openstaande facturen en rekeningen ----------

function OpenItems({ kind, state, suggestions, refresh, nextButton }: SectionProps & { kind: 'klant' | 'leverancier' }) {
  const [editing, setEditing] = useState<OpeningItem | 'nieuw' | null>(null);
  const items = state.items.filter((i) => i.kind === kind);
  const date = state.settings.date!;
  const total = items.reduce((s, i) => s + Math.abs(i.amount), 0);
  return (
    <>
      <h2>{kind === 'klant' ? 'Klanten die je nog moesten betalen' : 'Rekeningen die jij nog moest betalen'}</h2>
      <p className="muted">
        {kind === 'klant'
          ? <>Facturen die op <DateNl date={addDays(date, -1)} /> nog niet (helemaal) betaald waren. Komt het geld later binnen, dan koppelt de app de betaling eraan. De omzet en btw stonden al in je vorige administratie; die tellen hier niet nog eens.</>
          : <>Rekeningen van leveranciers of onderaannemers die op <DateNl date={addDays(date, -1)} /> nog open stonden. De kosten en btw stonden al in je vorige administratie.</>}
      </p>
      <Suggestions list={suggestions.filter((s) => s.kind === kind)} refresh={refresh} />
      {kind === 'klant' && <UblDrop refresh={refresh} />}
      <ItemList items={items} onEdit={setEditing} refresh={refresh} empty={kind === 'klant' ? 'Nog geen openstaande facturen. Had je er geen? Dan is dit klaar.' : 'Nog geen openstaande rekeningen. Had je er geen? Dan is dit klaar.'} />
      {items.length > 0 && <p className="small">Samen: <strong><Euro cents={total} /></strong></p>}
      <Button onClick={() => setEditing('nieuw')}>+ {kind === 'klant' ? 'Openstaande factuur' : 'Openstaande rekening'} toevoegen</Button>
      {editing && <InvoiceForm kind={kind} date={date} item={editing === 'nieuw' ? null : editing} onClose={() => setEditing(null)} refresh={refresh} />}
      {nextButton}
    </>
  );
}

/** Openstaande facturen als e-factuur (UBL) uit het vorige programma erop slepen. */
function UblDrop({ refresh }: { refresh: SectionProps['refresh'] }) {
  const { run } = useAction();
  const { toast } = useApp();
  return (
    <DropZone accept=".xml" multiple onFile={async (f) => {
      const xml = await readAsText(f);
      const r = await run(() => api.switchover.addUblInvoices([{ name: f.name, xml }]));
      if (!r) return;
      if (r.added) toast(`Factuur uit ${f.name} toegevoegd. Al deels betaald? Pas dan het bedrag aan.`);
      for (const msg of r.skipped) toast(msg, 'error');
      await refresh(r.state);
    }}>
      <div className="small"><strong>Heb je de facturen als e-factuur (UBL, .xml)?</strong> Sleep ze hierheen, dan vult de app ze in.</div>
    </DropZone>
  );
}

function ItemList({ items, onEdit, refresh, empty }: { items: OpeningItem[]; onEdit: (i: OpeningItem) => void; refresh: SectionProps['refresh']; empty: string }) {
  const { run, busy } = useAction();
  if (items.length === 0) return <p className="small muted">{empty}</p>;
  return (
    <table className="list" style={{ margin: '10px 0' }}>
      <tbody>
        {items.map((i) => (
          <tr key={i.id}>
            <td>
              {i.description}
              {i.open !== null && i.open !== Math.abs(i.amount) && <div className="small muted">{i.open === 0 ? 'betaald ✓' : <>nog open: <Euro cents={i.open} /></>}</div>}
            </td>
            <td style={{ textAlign: 'right' }}><Euro cents={Math.abs(i.amount)} /></td>
            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              {i.locked ? (
                <span className="small muted" title="Al betaald of afgeschreven">🔒</span>
              ) : (
                <>
                  <Button small kind="ghost" onClick={() => onEdit(i)}>Aanpassen</Button>
                  <Button small kind="ghost" disabled={busy} onClick={async () => { const r = await run(() => api.switchover.remove(i.id), 'Verwijderd'); if (r) await refresh(r); }}>Weg</Button>
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function InvoiceForm({ kind, date, item, onClose, refresh }: { kind: 'klant' | 'leverancier'; date: string; item: OpeningItem | null; onClose: () => void; refresh: SectionProps['refresh'] }) {
  const { run, busy } = useAction();
  const d = (item?.data ?? {}) as Partial<Extract<OpeningInput, { kind: 'klant' }>> & { reference?: string | null };
  const [name, setName] = useState(d.relationName ?? '');
  const [number, setNumber] = useState((kind === 'klant' ? d.number : d.reference) ?? '');
  const [invoiceDate, setInvoiceDate] = useState(d.invoiceDate ?? addDays(date, -1));
  const [dueDate, setDueDate] = useState(d.dueDate ?? '');
  const [amount, setAmount] = useState<number | null>(d.amount ?? null);
  const input: OpeningInput =
    kind === 'klant'
      ? { kind, relationName: name, number, invoiceDate, dueDate: dueDate || null, amount: amount ?? 0 }
      : { kind, relationName: name, reference: number || null, invoiceDate, dueDate: dueDate || null, amount: amount ?? 0 };
  return (
    <Modal title={kind === 'klant' ? 'Openstaande factuur' : 'Openstaande rekening'} onClose={onClose}>
      <div className="grid">
        <Field label={kind === 'klant' ? 'Klant' : 'Leverancier'}><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <div className="grid cols-2">
          <Field label="Factuurnummer" hint={kind === 'klant' ? 'dan herkent de app de betaling' : 'als je het weet'}><input value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
          <Field label="Nog open (inclusief btw)"><MoneyInput value={amount} onChange={setAmount} /></Field>
          <Field label="Factuurdatum"><input type="date" value={invoiceDate} max={addDays(date, -1)} onChange={(e) => setInvoiceDate(e.target.value)} /></Field>
          <Field label="Uiterlijk betalen op" hint="optioneel"><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
        </div>
      </div>
      <div className="row end" style={{ marginTop: 14 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={busy || !name.trim() || !amount} onClick={async () => { const r = await run(() => api.switchover.save(input, item?.id), 'Opgeslagen'); if (r) { onClose(); await refresh(r); } }}>Opslaan</Button>
      </div>
    </Modal>
  );
}

// ---------- 5. bezittingen ----------

function Assets({ state, refresh, nextButton }: SectionProps) {
  const [editing, setEditing] = useState<OpeningItem | 'nieuw' | null>(null);
  const items = state.items.filter((i) => i.kind === 'bezit');
  const year = state.settings.date!.slice(0, 4);
  return (
    <>
      <h2>Bus, auto en gereedschap</h2>
      <p className="muted">
        Dingen van meer dan € 450 die je een paar jaar zakelijk gebruikt. De app schrijft ze verder af vanaf de waarde op 1 januari {year}.
        Heb je de balans van je boekhouder? Daar staat die waarde op ("boekwaarde"). Zo niet, dan rekent de app hem uit.
      </p>
      {!state.startOfYear && <div className="notice small">Tel de afschrijving van dit jaar níet mee bij je kosten tot nu toe: die rekent de app voor het hele jaar.</div>}
      <ItemList items={items} onEdit={setEditing} refresh={refresh} empty="Nog niets ingevuld. Heb je geen bus of duur gereedschap? Dan is dit klaar." />
      <Button onClick={() => setEditing('nieuw')}>+ Toevoegen</Button>
      {editing && <AssetForm date={state.settings.date!} item={editing === 'nieuw' ? null : editing} onClose={() => setEditing(null)} refresh={refresh} />}
      {nextButton}
    </>
  );
}

function AssetForm({ date, item, onClose, refresh }: { date: string; item: OpeningItem | null; onClose: () => void; refresh: SectionProps['refresh'] }) {
  const { run, busy } = useAction();
  const d = (item?.data ?? {}) as Partial<Extract<OpeningInput, { kind: 'bezit' }>>;
  const [name, setName] = useState(d.name ?? '');
  const [type, setType] = useState<'vervoer' | 'inventaris'>(d.type ?? 'vervoer');
  const [acquiredOn, setAcquiredOn] = useState(d.acquiredOn ?? '');
  const [cost, setCost] = useState<number | null>(d.cost ?? null);
  const [bookValue, setBookValue] = useState<number | null>(d.bookValue ?? null);
  const [years, setYears] = useState(d.remainingYears ? String(d.remainingYears) : '');
  const year = date.slice(0, 4);
  const guess = cost && isIsoDate(acquiredOn) ? defaultBookValue(cost, acquiredOn, date) : null;
  const thisYear = isIsoDate(acquiredOn) && acquiredOn >= `${year}-01-01`;
  const value = thisYear ? cost : bookValue ?? guess?.bookValue ?? null;
  const remaining = Number(years) || guess?.remainingYears || 5;
  return (
    <Modal title="Bus, auto of gereedschap" onClose={onClose}>
      <div className="grid">
        <Field label="Wat is het?"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="bv. Bus Ford Transit" autoFocus /></Field>
        <div className="chips">
          <button className={type === 'vervoer' ? 'selected' : ''} onClick={() => setType('vervoer')}>🚐 Bus of auto</button>
          <button className={type === 'inventaris' ? 'selected' : ''} onClick={() => setType('inventaris')}>🛠️ Gereedschap, machine, computer</button>
        </div>
        <div className="grid cols-2">
          <Field label="Gekocht op"><input type="date" value={acquiredOn} max={addDays(date, -1)} onChange={(e) => setAcquiredOn(e.target.value)} /></Field>
          <Field label="Prijs (zonder btw)"><MoneyInput value={cost} onChange={setCost} /></Field>
          {!thisYear && (
            <Field label={`Waarde op 1 januari ${year}`} hint={guess ? `leeg: de app rekent € ${(guess.bookValue / 100).toFixed(2).replace('.', ',')}` : 'boekwaarde volgens je boekhouder'}>
              <MoneyInput value={bookValue} onChange={setBookValue} placeholder={guess ? (guess.bookValue / 100).toFixed(2).replace('.', ',') : undefined} />
            </Field>
          )}
          <Field label="Hoeveel jaar gebruik je het nog?" hint={thisYear ? 'minstens 5 jaar voor de belasting' : undefined}>
            <input value={years} inputMode="numeric" placeholder={String(guess?.remainingYears ?? 5)} onChange={(e) => setYears(e.target.value.replace(/\D/g, '').slice(0, 2))} />
          </Field>
        </div>
        {thisYear && <p className="small muted">Dit jaar gekocht: dat telt als investering van dit jaar (ook voor de investeringsaftrek).</p>}
      </div>
      <div className="row end" style={{ marginTop: 14 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button
          kind="primary"
          disabled={busy || !name.trim() || !cost || !isIsoDate(acquiredOn) || value === null}
          onClick={async () => {
            const input: OpeningInput = { kind: 'bezit', name, type, acquiredOn, cost: cost!, bookValue: value!, remainingYears: remaining };
            const r = await run(() => api.switchover.save(input, item?.id), 'Opgeslagen');
            if (r) { onClose(); await refresh(r); }
          }}
        >
          Opslaan
        </Button>
      </div>
    </Modal>
  );
}

// ---------- 6. btw ----------

function Vat({ state, suggestions, refresh, nextButton }: SectionProps) {
  const { run, busy } = useAction();
  const date = state.settings.date!;
  const existing = state.items.find((i) => i.kind === 'btw');
  const ex = existing?.data as Extract<OpeningInput, { kind: 'btw' }> | undefined;
  const [direction, setDirection] = useState<'betalen' | 'terug' | 'niets'>(existing && ex?.amount === 0 ? 'niets' : ex?.direction ?? 'betalen');
  const [amount, setAmount] = useState<number | null>(ex?.amount ?? null);
  const split = state.splitPeriod;
  const filed = state.settings.filedElsewhere;
  return (
    <>
      <h2>Btw</h2>
      {filed.length > 0 && <p className="small muted">De btw-aangiften van vóór <DateNl date={date} /> deed je in je vorige administratie. Die staan in de app als "al aangegeven".</p>}
      <Suggestions list={suggestions.filter((s) => s.kind === 'btw')} refresh={refresh} />
      <h3>Moest je op <DateNl date={addDays(date, -1)} /> nog btw betalen, of kreeg je nog iets terug?</h3>
      <p className="small muted">Van je laatste aangifte(n) die nog niet betaald of uitbetaald was. Zo sluit de betaling aan de Belastingdienst straks netjes aan.</p>
      <div className="chips">
        <button className={direction === 'betalen' ? 'selected' : ''} onClick={() => setDirection('betalen')}>Ik moest nog betalen</button>
        <button className={direction === 'terug' ? 'selected' : ''} onClick={() => setDirection('terug')}>Ik kreeg nog terug</button>
        <button className={direction === 'niets' ? 'selected' : ''} onClick={() => setDirection('niets')}>Alles was al betaald</button>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        {direction !== 'niets' && <MoneyInput value={amount} onChange={setAmount} ariaLabel="Btw-bedrag" />}
        <Button
          kind="primary"
          small
          disabled={busy || (direction !== 'niets' && !amount)}
          onClick={async () => {
            const input: OpeningInput = direction === 'niets' ? { kind: 'btw', direction: 'betalen', amount: 0 } : { kind: 'btw', direction, amount: amount! };
            const r = await run(() => api.switchover.save(input, existing?.id), 'Opgeslagen');
            if (r) await refresh(r);
          }}
        >
          Opslaan
        </Button>
        {existing && <span className="pill good">{existing.amount === 0 ? 'niets meer open' : existing.amount > 0 ? <>terug: <Euro cents={existing.amount} /></> : <>te betalen: <Euro cents={-existing.amount} /></>}</span>}
      </div>
      {split && <SplitPeriod state={state} refresh={refresh} split={split} />}
      {nextButton}
    </>
  );
}

function SplitPeriod({ state, refresh, split }: { state: SwitchoverState; refresh: SectionProps['refresh']; split: NonNullable<SwitchoverState['splitPeriod']> }) {
  const { run, busy } = useAction();
  const date = state.settings.date!;
  const existing = state.items.find((i) => i.kind === 'btw-periode');
  const d = existing?.data as Extract<OpeningInput, { kind: 'btw-periode' }> | undefined;
  const [v, setV] = useState({ omzetHoog: d?.omzetHoog ?? null, btwHoog: d?.btwHoog ?? null, omzetLaag: d?.omzetLaag ?? null, btwLaag: d?.btwLaag ?? null, omzetNul: d?.omzetNul ?? null, voorbelasting: d?.voorbelasting ?? null } as Record<string, number | null>);
  const field = (key: string, label: string, hint?: string) => (
    <Field label={label} hint={hint}><MoneyInput value={v[key] ?? null} onChange={(c) => setV({ ...v, [key]: c })} /></Field>
  );
  const n = (k: string) => v[k] ?? 0;
  return (
    <div className="card" style={{ marginTop: 22 }}>
      <h3 style={{ marginTop: 0 }}>Omzet en btw van <DateNl date={split.start} /> tot <DateNl date={date} /></h3>
      <p className="small muted">
        Je stapt midden in {split.label} over. De aangifte over die periode doe je straks uit de app; dan heeft hij ook het stuk van vóór <DateNl date={date} /> nodig.
        Haal de bedragen uit je vorige programma (btw-overzicht over die dagen).
      </p>
      <div className="grid cols-2">
        {field('omzetHoog', 'Omzet 21% (zonder btw)')}
        {field('btwHoog', 'Btw 21%')}
        {field('omzetLaag', 'Omzet 9% (zonder btw)')}
        {field('btwLaag', 'Btw 9%')}
        {field('omzetNul', 'Omzet zonder btw', 'btw verlegd, 0%')}
        {field('voorbelasting', 'Btw op je inkopen', 'voorbelasting')}
      </div>
      <div className="row end" style={{ marginTop: 10 }}>
        {existing && <span className="pill good">ingevuld</span>}
        <Button
          kind="primary"
          small
          disabled={busy}
          onClick={async () => {
            const input: OpeningInput = { kind: 'btw-periode', omzetHoog: n('omzetHoog'), btwHoog: n('btwHoog'), omzetLaag: n('omzetLaag'), btwLaag: n('btwLaag'), omzetNul: n('omzetNul'), voorbelasting: n('voorbelasting') };
            const r = await run(() => api.switchover.save(input), 'Opgeslagen');
            if (r) await refresh(r);
          }}
        >
          Opslaan
        </Button>
      </div>
    </div>
  );
}

// ---------- 7. omzet en kosten tot nu toe ----------

function Result({ state, refresh, nextButton }: SectionProps) {
  const { run, busy } = useAction();
  const date = state.settings.date!;
  const existing = state.items.find((i) => i.kind === 'resultaat');
  const d = existing?.data as Extract<OpeningInput, { kind: 'resultaat' }> | undefined;
  const [v, setV] = useState({ omzet: d?.omzet ?? null, materiaal: d?.materiaal ?? null, auto: d?.auto ?? null, overig: d?.overig ?? null } as Record<'omzet' | 'materiaal' | 'auto' | 'overig', number | null>);
  const n = (k: keyof typeof v) => v[k] ?? 0;
  const winst = n('omzet') - n('materiaal') - n('auto') - n('overig');
  return (
    <>
      <h2>Omzet en kosten van 1 januari tot <DateNl date={date} /></h2>
      <p className="muted">
        Voor je belastingaangifte telt het hele jaar. Neem de totalen over uit je vorige programma (de winst-en-verliesrekening) of vraag ze aan je boekhouder.
        Alles zonder btw.
      </p>
      <div className="notice small">Laat de afschrijving (van je bus of gereedschap) weg: die rekent de app voor het hele jaar.</div>
      <div className="grid cols-2">
        <Field label="Omzet"><MoneyInput value={v.omzet} onChange={(c) => setV({ ...v, omzet: c })} /></Field>
        <Field label="Materiaal, inkoop en onderaannemers"><MoneyInput value={v.materiaal} onChange={(c) => setV({ ...v, materiaal: c })} /></Field>
        <Field label="Autokosten" hint="brandstof, onderhoud, verzekering"><MoneyInput value={v.auto} onChange={(c) => setV({ ...v, auto: c })} /></Field>
        <Field label="Alle andere kosten" hint="telefoon, verzekeringen, boekhouder, …"><MoneyInput value={v.overig} onChange={(c) => setV({ ...v, overig: c })} /></Field>
      </div>
      <p>Winst tot nu toe: <strong><Euro cents={winst} /></strong></p>
      <div className="row">
        <Button kind="primary" disabled={busy} onClick={async () => { const r = await run(() => api.switchover.save({ kind: 'resultaat', omzet: n('omzet'), materiaal: n('materiaal'), auto: n('auto'), overig: n('overig') }), 'Opgeslagen'); if (r) await refresh(r); }}>Opslaan</Button>
        {existing && <span className="pill good">ingevuld</span>}
      </div>
      {nextButton}
    </>
  );
}

// ---------- 8. leningen en overig ----------

const OTHER_KINDS: [Extract<OpeningKind, 'lening' | 'vordering' | 'schuld'>, string, string][] = [
  ['lening', 'Lening', 'bv. voor je bus, bij de bank of familie: wat er nog af te lossen is'],
  ['vordering', 'Iets wat je nog tegoed hebt', 'bv. een borg of een voorschot dat je betaalde'],
  ['schuld', 'Een andere schuld', 'iets wat je nog moet betalen en geen rekening is'],
];

function Other({ state, refresh, nextButton }: SectionProps) {
  const { run, busy } = useAction();
  const [editing, setEditing] = useState<OpeningItem | 'nieuw' | null>(null);
  const items = state.items.filter((i) => i.kind === 'lening' || i.kind === 'vordering' || i.kind === 'schuld');
  const [kind, setKind] = useState<'lening' | 'vordering' | 'schuld'>('lening');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const open = (i: OpeningItem | 'nieuw') => {
    const d = i === 'nieuw' ? null : (i.data as Extract<OpeningInput, { kind: 'lening' | 'vordering' | 'schuld' }>);
    setKind(d?.kind ?? 'lening');
    setDescription(d?.description ?? '');
    setAmount(d?.amount ?? null);
    setEditing(i);
  };
  return (
    <>
      <h2>Leningen en overig</h2>
      <p className="muted">Heb je een lening voor je bedrijf, een borg betaald, of nog een andere schuld? Zet het hier. Geen? Dan is dit klaar.</p>
      <ItemList items={items} onEdit={open} refresh={refresh} empty="Niets ingevuld." />
      <Button onClick={() => open('nieuw')}>+ Toevoegen</Button>
      {editing && (
        <Modal title="Lening of overig" onClose={() => setEditing(null)}>
          <div className="choice">
            {OTHER_KINDS.map(([k, label, hint]) => (
              <button key={k} className={kind === k ? 'selected' : ''} onClick={() => setKind(k)}>{label}<div className="hint">{hint}</div></button>
            ))}
          </div>
          <div className="grid cols-2" style={{ marginTop: 12 }}>
            <Field label="Omschrijving"><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="bv. Lening bus Rabobank" /></Field>
            <Field label={`Bedrag op ${new Date(`${addDays(state.settings.date!, -1)}T00:00:00`).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' })}`}><MoneyInput value={amount} onChange={setAmount} /></Field>
          </div>
          <div className="row end" style={{ marginTop: 14 }}>
            <Button onClick={() => setEditing(null)}>Annuleren</Button>
            <Button kind="primary" disabled={busy || !description.trim() || !amount} onClick={async () => { const r = await run(() => api.switchover.save({ kind, description, amount: amount! }, editing === 'nieuw' ? undefined : editing.id), 'Opgeslagen'); if (r) { setEditing(null); await refresh(r); } }}>Opslaan</Button>
          </div>
        </Modal>
      )}
      {nextButton}
    </>
  );
}

// ---------- 9. startpositie en controles ----------

function Position({ state, refresh, onSection }: SectionProps & { onSection: (s: SectionKey) => void }) {
  const { run, busy } = useAction();
  const { go, reloadSettings } = useApp();
  const [equity, setEquity] = useState<number | null>(state.settings.accountantEquity);
  const [provisional, setProvisional] = useState(state.settings.provisional);
  const p = state.position;
  const problems = state.checks.filter((c) => c.level === 'probleem');
  const warnings = state.checks.filter((c) => c.level === 'let-op');
  const date = state.settings.date!;
  return (
    <>
      <h2>Je startpositie op <DateNl date={date} /></h2>
      {p && (
        <div className="grid cols-2">
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Wat je had</h3>
            {p.bezittingen.length === 0 && <p className="small muted">Nog niets.</p>}
            {p.bezittingen.map((l) => <div key={l.key} className="row between"><span>{l.label}</span><Euro cents={l.amount} /></div>)}
          </div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Wat je nog moest betalen</h3>
            {p.schulden.length === 0 && <p className="small muted">Niets.</p>}
            {p.schulden.map((l) => <div key={l.key} className="row between"><span>{l.label}</span><Euro cents={l.amount} /></div>)}
          </div>
        </div>
      )}
      {p && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="row between"><strong>Wat er van jou in de zaak zit</strong><strong><Euro cents={p.eigenVermogen} /></strong></div>
          <div className="small muted">Wat je had min wat je nog moest betalen. Je boekhouder noemt dit het eigen vermogen.</div>
          {p.winstTotNu !== null && <div className="small" style={{ marginTop: 6 }}>Waarvan winst van 1 januari tot <DateNl date={date} />: <Euro cents={p.winstTotNu} /></div>}
        </div>
      )}
      {state.startOfYear && (
        <details style={{ marginTop: 14 }} open={state.settings.accountantEquity !== null}>
          <summary>Heb je de balans van je boekhouder? Vergelijk het eigen vermogen</summary>
          <div className="row" style={{ marginTop: 8 }}>
            <MoneyInput value={equity} onChange={setEquity} ariaLabel="Eigen vermogen volgens de boekhouder" placeholder="eigen vermogen 31 december" />
            <Button small disabled={busy} onClick={async () => { const r = await run(() => api.switchover.setAccountantEquity(equity)); if (r) await refresh(r); }}>Vergelijken</Button>
          </div>
          {p && state.settings.accountantEquity !== null && state.settings.accountantEquity === p.eigenVermogen && <div className="notice good small">✓ Precies gelijk aan de balans van je boekhouder.</div>}
        </details>
      )}
      <h3 style={{ marginTop: 22 }}>Controles</h3>
      {problems.length === 0 && warnings.length === 0 && <div className="notice good">✓ Alles klopt.</div>}
      {[...problems, ...warnings].map((c) => (
        <div key={c.key} className={`notice ${c.level === 'probleem' ? 'bad' : 'warn'}`}>
          <div className="row between">
            <strong>{c.title}</strong>
            <Button small kind="ghost" onClick={() => onSection(c.section)}>Oplossen</Button>
          </div>
          <div className="small">{c.detail}</div>
        </div>
      ))}
      <label className="row" style={{ marginTop: 16 }}>
        <input type="checkbox" checked={provisional} onChange={(e) => setProvisional(e.target.checked)} />
        <span>Sommige bedragen zijn nog voorlopig (bv. de jaarrekening van vorig jaar is nog niet klaar). Aanpassen kan later altijd.</span>
      </label>
      <div className="row end" style={{ marginTop: 16 }}>
        {state.settings.status === 'klaar' ? (
          <>
            <span className="pill good">Klaar ✓</span>
            <Button onClick={async () => { const r = await run(() => api.switchover.reopen()); if (r) await refresh(r); }}>Toch nog aanpassen</Button>
            <Button kind="primary" onClick={() => go({ screen: 'home' })}>Naar Vandaag</Button>
          </>
        ) : (
          <Button
            kind="primary"
            disabled={busy || problems.length > 0}
            onClick={async () => {
              const r = await run(() => api.switchover.confirm({ provisional }), 'Je administratie is overgezet');
              if (r) {
                await refresh(r);
                await reloadSettings();
              }
            }}
          >
            Klopt, zet klaar
          </Button>
        )}
      </div>
      {problems.length > 0 && <p className="small muted" style={{ textAlign: 'right' }}>Los eerst de rode punten op.</p>}
    </>
  );
}
