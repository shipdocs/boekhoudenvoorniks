import { useState } from 'react';
import { api } from '../api';
import { Button, ErrorBox, Euro, Modal, useAction, useApp, useLoad } from '../ui';
import type { Task } from '../../inbox/inbox';
import { CategoryPicker } from './Bank';

export function Home() {
  const { go, settings, refreshBadge } = useApp();
  const { data, error, reload } = useLoad(() => api.home.get());
  const { run, busy } = useAction();
  const [picking, setPicking] = useState<Task | null>(null);
  const [showAll, setShowAll] = useState(false);

  const act = async (task: Task, actionId: string, payload?: { categoryKey?: string; vatCode?: string }) => {
    const r = await run(() => api.home.act(task, actionId, payload));
    if (r && r.navigate) {
      if (r.navigate.screen === 'categorie') return setPicking(task);
      return go({ screen: r.navigate.screen as never, id: r.navigate.id });
    }
    await reload();
    refreshBadge();
  };

  if (!data) return <div className="page"><ErrorBox error={error} /></div>;
  const name = settings.profile.firstName;
  const tasks = showAll ? data.tasks : data.tasks.slice(0, 6);

  return (
    <div className="page">
      <h1>
        {data.greeting}
        {name ? ` ${name}` : ''} 👋
      </h1>

      <div className="hero">
        <div className="card">
          <div className="value"><Euro cents={data.money.bank} /></div>
          <div className="label">op de bank</div>
        </div>
        <div className="card clickable" onClick={() => go({ screen: 'werk', extra: { filter: 'open' } })}>
          <div className="value"><Euro cents={data.money.toReceive} /></div>
          <div className="label">nog te ontvangen van klanten</div>
        </div>
        <div className="card clickable" onClick={() => go({ screen: 'belasting' })}>
          <div className="value">± <Euro cents={data.money.vatReserve} /></div>
          <div className="label">apart houden voor BTW</div>
        </div>
      </div>

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
          {tasks.map((t) => (
            <div className="task" key={t.key}>
              <div className="icon" aria-hidden>{t.icon}</div>
              <div className="grow">
                <div className="title">{t.title}</div>
                <div className="q">{t.question}</div>
              </div>
              <div className="row">
                {t.actions.map((a) => (
                  <Button key={a.id} kind={a.primary ? 'primary' : undefined} small disabled={busy} onClick={() => void act(t, a.id)}>
                    {a.label}
                  </Button>
                ))}
              </div>
            </div>
          ))}
          {data.tasks.length > 6 && !showAll && (
            <div className="task"><Button kind="ghost" onClick={() => setShowAll(true)}>Toon alle {data.tasks.length}</Button></div>
          )}
        </div>
      )}

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
