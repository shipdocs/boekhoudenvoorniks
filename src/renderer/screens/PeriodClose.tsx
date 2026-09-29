import { useEffect, useState } from 'react';
import { api } from '../api';
import { Button, ErrorBox, Modal, useAction, useApp, useLoad } from '../ui';
import { addDays, formatDateNl } from '../../shared/dates';

const QUARTER: Record<string, string> = { '03-31': '1e kwartaal', '06-30': '2e kwartaal', '09-30': '3e kwartaal', '12-31': 'heel' };

/** "31 december 2025 (heel 2025)", "30 september 2026 (3e kwartaal)" */
function dateLabel(date: string): string {
  const q = QUARTER[date.slice(5)];
  return `${formatDateNl(date)} (${q === 'heel' ? `heel ${date.slice(0, 4)}` : q})`;
}

/**
 * Een einddatum kiezen (eind van een afgelopen kwartaal) met de controles die daarbij horen; voor het
 * afsluiten en voor de uitwisseling met de boekhouder (die sluit bij het inlezen van het antwoord af).
 */
export function usePeriodChoice() {
  const status = useLoad(() => api.periods.status());
  const dates = useLoad(() => api.periods.suggestedDates(), [status.data?.closedUntil, status.data?.exchange?.no]);
  const [until, setUntilState] = useState<string | null>(null);
  useEffect(() => {
    if (dates.data && (!until || !dates.data.includes(until))) setUntilState(dates.data[0] ?? null);
  }, [dates.data, until]);
  const checks = useLoad(() => (until ? api.periods.checks(until) : Promise.resolve([])), [until]);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const list = checks.data ?? [];
  const ready = Boolean(until) && checks.data !== undefined && !list.some((c) => c.level === 'blokkeert') && list.filter((c) => c.level === 'bevestigen').every((c) => confirmed.includes(c.key));
  const setUntil = (d: string) => {
    setUntilState(d);
    setConfirmed([]);
  };
  const reload = async () => {
    setConfirmed([]);
    await status.reload();
  };
  return { status, dates, until, setUntil, checks, list, confirmed, setConfirmed, ready, reload, error: status.error ?? dates.error ?? checks.error };
}

/** De keuzelijst met einddatums en de controles eronder. */
export function PeriodPicker({ label, choice }: { label: string; choice: ReturnType<typeof usePeriodChoice> }) {
  const { go } = useApp();
  const { dates, until, setUntil, list, checks, confirmed, setConfirmed } = choice;
  if (!dates.data || !until) return null;
  return (
    <>
      <label className="row" style={{ alignItems: 'center', gap: 8 }}>
        <span>{label}</span>
        <select value={until} onChange={(e) => setUntil(e.target.value)} aria-label={label}>
          {dates.data.map((d) => <option key={d} value={d}>{dateLabel(d)}</option>)}
        </select>
      </label>
      {list.length === 0 && checks.data && <p className="small" style={{ margin: 0 }}>✓ Alles t/m {formatDateNl(until)} is verwerkt.</p>}
      {list.length > 0 && (
        <ul className="checklist small" style={{ margin: 0 }}>
          {list.map((c) => (
            <li key={c.key}>
              {c.level === 'blokkeert' && <span className="pill warn" style={{ marginRight: 6 }}>eerst doen</span>}
              {c.level === 'info' && <span className="pill" style={{ marginRight: 6 }}>let op</span>}
              {c.level === 'bevestigen' ? (
                <label style={{ display: 'inline' }}>
                  <input type="checkbox" checked={confirmed.includes(c.key)} onChange={(e) => setConfirmed(e.target.checked ? [...confirmed, c.key] : confirmed.filter((k) => k !== c.key))} />{' '}
                  {c.title}
                </label>
              ) : c.title}
              <div className="muted">{c.detail}</div>
              {c.level === 'blokkeert' && c.screen && <Button small onClick={() => go({ screen: c.screen! })}>Oplossen</Button>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * Periode afsluiten: afgewerkt is afgewerkt. Daarna kan er t/m die datum niets meer geboekt of
 * gewijzigd worden; een late bon of factuur komt in de eerste open periode.
 */
export function PeriodCloseCard() {
  const { toast } = useApp();
  const choice = usePeriodChoice();
  const { status, dates, until, confirmed, ready } = choice;
  const [asking, setAsking] = useState(false);
  const { run, busy } = useAction();
  const st = status.data;

  const close = async () => {
    if (!until) return;
    const r = await run(() => api.periods.close(until, confirmed));
    setAsking(false);
    if (r) {
      toast(`Afgesloten t/m ${formatDateNl(until)}`);
      await choice.reload();
    }
  };

  return (
    <div className="card grid" data-testid="periode-afsluiten">
      <h2 style={{ margin: 0 }}>🔒 Periode afsluiten</h2>
      <ErrorBox error={choice.error} />
      {st?.closedUntil && (
        <p style={{ margin: 0 }}>
          <strong>Afgesloten t/m {formatDateNl(st.closedUntil)}.</strong> Komt er nog een bon of factuur van daarvóór binnen, dan komt die in de eerste open periode.
        </p>
      )}
      {st?.exchange && (
        <p style={{ margin: 0 }}>
          <strong>T/m {formatDateNl(st.exchange.until)} ligt bij je boekhouder</strong>{st.exchange.no ? ` (uitwisseling ${st.exchange.no})` : ''}. Als zijn antwoord is ingelezen, is die periode afgesloten.
        </p>
      )}
      {!st?.closedUntil && !st?.exchange && (
        <p style={{ margin: 0 }}>
          Klaar met een kwartaal of een jaar? Sluit het af, dan verandert er niets meer aan: niet per ongeluk, en niet door iets wat later binnenkomt. Zo klopt het altijd met je btw-aangifte en met wat je boekhouder heeft.
        </p>
      )}
      {!st?.exchange && dates.data && dates.data.length === 0 && <p className="small muted" style={{ margin: 0 }}>Alles t/m het vorige kwartaal is afgesloten.</p>}
      {!st?.exchange && dates.data && dates.data.length > 0 && until && (
        <>
          <PeriodPicker label="Afsluiten t/m" choice={choice} />
          <div className="row">
            <Button kind="primary" disabled={!ready || busy} onClick={() => setAsking(true)}>Afsluiten t/m {formatDateNl(until)}</Button>
          </div>
        </>
      )}
      {asking && until && (
        <Modal title={`Afsluiten t/m ${formatDateNl(until)}?`} onClose={() => setAsking(false)}>
          <p>Daarna kun je t/m {formatDateNl(until)} niets meer boeken, wijzigen of terugdraaien. Komt er later nog een bon of factuur van daarvóór binnen, dan komt die op {formatDateNl(addDays(until, 1))}.</p>
          <p><strong>Dit kan niet ongedaan gemaakt worden.</strong> We maken eerst een back-up in de back-upmap.</p>
          <div className="row end">
            <Button onClick={() => setAsking(false)}>Annuleren</Button>
            <Button kind="primary" disabled={busy} onClick={() => void close()}>Definitief afsluiten</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
