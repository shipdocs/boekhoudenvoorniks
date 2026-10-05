import { useState } from 'react';
import { api } from '../api';
import { Button, useApp, useLoad } from '../ui';
import { bankFetchOutcome, errorOutcome, mailFetchOutcome, type FetchOutcome } from '../../shared/fetch-text';

type Source = 'mail' | 'bank';

/** Knoppen op Vandaag om mail en bank op te halen; alleen zichtbaar voor wat is ingesteld. */
export function FetchBar({ onFetched }: { onFetched(): void | Promise<void> }) {
  const { settings } = useApp();
  const mailOn = settings.mailIn.enabled;
  const bank = useLoad(() => api.bankfeed.status());
  const mail = useLoad(async () => (mailOn ? api.mail.summary() : null), [mailOn]);
  const [busy, setBusy] = useState<Source | null>(null);
  const [result, setResult] = useState<(FetchOutcome & { at: Date }) | null>(null);
  const bankOn = Boolean(bank.data?.configured && bank.data.accounts.some((a) => a.status === 'actief'));
  if (!mailOn && !bankOn) return null;

  const fetchFrom = async (source: Source) => {
    setBusy(source);
    let outcome: FetchOutcome;
    try {
      outcome = source === 'mail' ? mailFetchOutcome(await api.mail.fetchNow()) : bankFetchOutcome(await api.bankfeed.ophalen());
    } catch (e) {
      outcome = errorOutcome(source === 'mail' ? 'Mail ophalen' : 'Bank ophalen', (e as Error).message);
    }
    setResult({ ...outcome, at: new Date() });
    await Promise.all([bank.reload(), mail.reload()]);
    await onFetched();
    setBusy(null);
  };

  const mailChecked = mail.data?.lastChecked;
  const covered = bank.data?.accounts.map((a) => a.coveredTo).filter((d): d is string => Boolean(d)).sort()[0];
  return (
    <div className="grid" style={{ margin: '10px 0' }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        {mailOn && <Button disabled={busy !== null} onClick={() => void fetchFrom('mail')}>{busy === 'mail' ? 'Mail ophalen…' : '✉️ Mail ophalen'}</Button>}
        {bankOn && <Button disabled={busy !== null} onClick={() => void fetchFrom('bank')}>{busy === 'bank' ? 'Bank ophalen…' : '🏦 Bank ophalen'}</Button>}
        <span className="small muted">
          {mailOn && mailChecked ? `Mail gekeken ${mailChecked.replace('T', ' ').slice(0, 16)}` : ''}
          {mailOn && mailChecked && bankOn && covered ? ' · ' : ''}
          {bankOn && covered ? `Bank bijgewerkt t/m ${covered.split('-').reverse().join('-')}` : ''}
        </span>
      </div>
      {result && (
        <div role={result.ok ? 'status' : 'alert'} className={`notice ${result.ok ? 'good' : 'bad'}`}>
          <strong>{result.at.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</strong>
          {result.lines.map((line) => <div key={line}>{line}</div>)}
          <button type="button" className="btn small" onClick={() => setResult(null)}>Sluiten</button>
        </div>
      )}
    </div>
  );
}
