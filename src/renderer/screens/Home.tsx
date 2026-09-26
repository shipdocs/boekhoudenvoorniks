import { useState } from 'react';
import { api } from '../api';
import { Button, ErrorBox, Euro, Modal, useAction, useApp, useLoad } from '../ui';
import type { Task } from '../../inbox/inbox';
import type { AutomationEntry } from '../../inbox/automation-log';
import { formatDateNl } from '../../shared/dates';
import { CategoryPicker } from './Bank';

export function Home() {
  const { go, settings, refreshBadge, toast } = useApp();
  const { data, error, reload } = useLoad(() => api.home.get());
  const { run, busy } = useAction();
  const [picking, setPicking] = useState<Task | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const [monthOpen, setMonthOpen] = useState(false);

  const act = async (task: Task, actionId: string, payload?: { categoryKey?: string; vatCode?: string }) => {
    const r = await run(() => api.home.act(task, actionId, payload));
    if (r && r.navigate) {
      if (r.navigate.screen === 'categorie') return setPicking(task);
      return go({ screen: r.navigate.screen as never, id: r.navigate.id });
    }
    await reload();
    refreshBadge();
  };

  /** "Alle 5 bevestigen": de hoofdknop voor elke taak in dezelfde groep (#20, #29) */
  const actGroup = async (group: Task[]) => {
    // Taken die toch een scherm nodig hebben (bv. een bonnetje met ontbrekende gegevens) blijven staan.
    const needsLook: Task[] = [];
    for (const t of group) {
      const primary = t.actions.find((a) => a.primary);
      if (!primary) continue;
      const r = await run(() => api.home.act(t, primary.id));
      if (r && r.navigate) needsLook.push(t);
    }
    await reload();
    refreshBadge();
    if (needsLook.length > 0) {
      toast(`${needsLook.length} ${needsLook.length === 1 ? 'kon' : 'konden'} niet in één keer; bekijk ${needsLook.length === 1 ? 'die' : 'ze'} apart.`);
    }
  };

  if (!data) return <div className="page"><ErrorBox error={error} /></div>;
  const name = settings.profile.firstName;
  const tasks = showAll ? data.tasks : data.tasks.slice(0, 6);
  const groups = new Map<string, Task[]>();
  for (const t of data.tasks) if (t.group) groups.set(t.group.key, [...(groups.get(t.group.key) ?? []), t]);
  const shownGroup = new Set<string>();

  return (
    <div className="page">
      <h1>
        {data.greeting}
        {name ? ` ${name}` : ''} 👋
      </h1>

      <div className="hero">
        <div className="card">
          <div className="value"><Euro cents={data.money.bank} /></div>
          <div className="label">op de bank{data.bankUpdatedTo ? ` · bijgewerkt t/m ${formatDateNl(data.bankUpdatedTo)}` : ''}</div>
        </div>
        <div className="card clickable" onClick={() => go({ screen: 'werk', extra: { filter: 'open' } })}>
          <div className="value"><Euro cents={data.money.toReceive} /></div>
          <div className="label">nog te ontvangen van klanten</div>
        </div>
        <div className="card clickable" onClick={() => go({ screen: 'belasting' })}>
          <div className="value">± <Euro cents={data.money.vatReserve} /></div>
          <div className="label">apart houden voor BTW</div>
          {data.money.vatPot && (
            <div className="small" style={{ marginTop: 6 }}>
              🐷 <Euro cents={data.money.vatPot.setAside} /> in {data.money.vatPot.account}
              {data.money.vatPot.stillToReserve > 0 ? <> · nog <strong><Euro cents={data.money.vatPot.stillToReserve} /></strong> opzijzetten</> : ' · genoeg opzij ✓'}
            </div>
          )}
        </div>
      </div>

      <p className="muted small" style={{ marginTop: -6 }}>
        Vrij te besteden: <strong><Euro cents={data.money.freeToSpend} /></strong> <span title="banksaldo min de btw die je nog moet betalen en je openstaande rekeningen">(banksaldo min btw en openstaande rekeningen)</span>
      </p>

      <h2>Wat wil je doen?</h2>
      <div className="actions4">
        <button className="btn big" onClick={() => go({ screen: 'werk' })}><span className="emoji">💰</span>Werk / factuur</button>
        <button className="btn big" onClick={() => go({ screen: 'aankopen' })}><span className="emoji">🧾</span>Aankoop / bonnetje</button>
        <button className="btn big" onClick={() => go({ screen: 'klanten' })}><span className="emoji">👤</span>Klanten</button>
        <button className="btn big" onClick={() => go({ screen: 'belasting' })}><span className="emoji">📮</span>Belasting</button>
      </div>

      <h2>{data.upToDate ? 'Je bent bij' : data.tasks.length === 1 ? 'Nog 1 ding en je bent klaar' : `Nog ${data.tasks.length} dingen en je bent klaar`}</h2>
      {data.upToDate ? (
        <div className="card done-box">
          <div className="check">✓</div>
          <strong>Geen actie nodig</strong>
          <div>
            <ul className="checklist">
              {data.checklist.map((c) => (
                <li key={c.label} className={c.ok ? 'ok' : 'no'}>{c.label}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {tasks.map((t) => {
            const group = t.group ? groups.get(t.group.key) ?? [] : [];
            const header = t.group && group.length > 1 && !shownGroup.has(t.group.key);
            if (t.group && header) shownGroup.add(t.group.key);
            return (
            <div key={t.key}>
            {header && (
              <div className="task group-head">
                <div className="grow small"><strong>{group.length}×</strong> {t.group!.label}</div>
                <Button small kind="primary" disabled={busy} onClick={() => void actGroup(group)}>Alle {group.length} bevestigen</Button>
              </div>
            )}
            <div className="task">
              <div className="icon" aria-hidden>{t.icon}</div>
              <div className="grow">
                <div className="title">{t.title}</div>
                <div className="q">
                  {t.question}
                  {t.why && <> <button className="linklike small" onClick={() => setWhy(why === t.key ? null : t.key)}>Waarom?</button></>}
                </div>
                {why === t.key && <div className="small muted">{t.why}</div>}
              </div>
              <div className="row">
                {t.actions.map((a) => (
                  <Button key={a.id} kind={a.primary ? 'primary' : undefined} small disabled={busy} onClick={() => void act(t, a.id)}>
                    {a.label}
                  </Button>
                ))}
              </div>
            </div>
            </div>
            );
          })}
          {data.tasks.length > 6 && !showAll && (
            <div className="task"><Button kind="ghost" onClick={() => setShowAll(true)}>Toon alle {data.tasks.length}</Button></div>
          )}
        </div>
      )}

      <div className="card month-counts" style={{ marginTop: 18 }}>
        <strong>Deze maand</strong>
        <div className="row">
          <span>🟢 {data.monthCounts.automatic} automatisch verwerkt</span>
          <span>🟡 {data.monthCounts.byUser} door jou gecontroleerd</span>
          <span>🔴 {data.monthCounts.attention} {data.monthCounts.attention === 1 ? 'heeft' : 'hebben'} nog aandacht</span>
        </div>
        {data.monthCounts.automatic > 0 && <Button small kind="ghost" onClick={() => setMonthOpen(true)}>Bekijk wat automatisch ging</Button>}
      </div>

      {data.automated.length > 0 && (
        <details className="card" style={{ marginTop: 12 }}>
          <summary><strong>Automatisch gedaan</strong> <span className="muted small">({data.automated.length} deze week)</span></summary>
          <AutomationList items={data.automated} expert={settings.advancedMode} onChanged={async () => { await reload(); refreshBadge(); }} />
        </details>
      )}

      {monthOpen && <MonthModal expert={settings.advancedMode} onClose={() => setMonthOpen(false)} onChanged={async () => { await reload(); refreshBadge(); }} />}

      {data.vat.estimate !== 0 && (
        <p className="muted small" style={{ marginTop: 18 }}>
          BTW {data.vat.periodLabel} tot nu toe: <Euro cents={data.vat.estimate} /> — aangeven vóór {data.vat.deadlineLabel}.
        </p>
      )}

      {picking && (
        <Modal title="Waar was deze betaling voor?" onClose={() => setPicking(null)}>
          <p className="muted">{picking.title}</p>
          <CategoryPicker
            initial={picking.ref.categoryKey}
            onPick={async (categoryKey, vatCode) => {
              const t = picking;
              setPicking(null);
              await act(t, t.kind === 'bank-business' ? 'zakelijk' : 'anders', { categoryKey, vatCode });
            }}
          />
        </Modal>
      )}
    </div>
  );
}

/** Lijst van automatische verwerkingen met "Waarom?" en [Klopt niet] (#28, #29). */
function AutomationList({ items, expert, onChanged }: { items: AutomationEntry[]; expert: boolean; onChanged: () => Promise<void> }) {
  const { run, busy } = useAction();
  const [open, setOpen] = useState<number | null>(null);
  return (
    <ul className="small automation-list">
      {items.map((a) => (
        <li key={a.id} className={a.status === 'klopt_niet' ? 'muted' : ''}>
          <div className="row between">
            <span>{a.status === 'klopt_niet' ? <s>{a.summary}</s> : a.summary}</span>
            <span className="row">
              <button className="linklike" onClick={() => setOpen(open === a.id ? null : a.id)}>Waarom?</button>
              {a.status === 'auto' && (
                <Button small kind="ghost" disabled={busy} onClick={async () => {
                  if (!confirm('Terugdraaien? Het komt dan weer als vraag bij "Nog te doen", en de app vraagt het voortaan weer.')) return;
                  await run(() => api.home.correct(a.id), 'Teruggedraaid');
                  await onChanged();
                }}>Klopt niet</Button>
              )}
            </span>
          </div>
          {open === a.id && (
            <div className="muted">
              {a.reason}
              {expert && a.details?.expert && <div className="mono">{a.details.expert}</div>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function MonthModal({ expert, onClose, onChanged }: { expert: boolean; onClose: () => void; onChanged: () => Promise<void> }) {
  const month = useLoad(() => api.home.month());
  const m = month.data;
  return (
    <Modal title="Wat ging er automatisch deze maand" onClose={onClose}>
      <ErrorBox error={month.error} />
      {m && (
        <>
          <p className="muted small">{m.automatic.length} automatisch · {m.byUser.length} door jou gecontroleerd · {m.attention} nog aandacht</p>
          <AutomationList items={m.automatic} expert={expert} onChanged={async () => { await month.reload(); await onChanged(); }} />
        </>
      )}
    </Modal>
  );
}
