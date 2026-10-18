import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Button, DateNl, Field, Modal, useAction, useApp, useLoad } from '../ui';
import { pontoAccountStatusText, pontoCooldownText, pontoErrorKindText, pontoLinkText } from '../../shared/bank-feed-text';
import type { FeedAccountInfo, FeedLink, FeedTestAccount, RoundSummary } from '../../bankfeed/bankfeed';

const PONTO_DASHBOARD = 'https://dashboard.myponto.com';
const PONTO_INSTALL = 'https://dashboard.myponto.com/new-custom-integration?customIntegrationName=BoekhoudenVoorNiks';

type FeedStatus = Awaited<ReturnType<typeof api.bankfeed.status>>;
type BankAccount = Awaited<ReturnType<typeof api.bank.accounts>>[number];

export function PontoIntro({ secureStorage }: { secureStorage: boolean }) {
  return (
    <div className="grid">
      <h3>Voor je begint</h3>
      <p>Ponto is een afzonderlijke zakelijke dienst. Controleer bij Ponto zelf de actuele kosten, proefvoorwaarden, ondersteunde banken en of jouw bedrijf wordt toegelaten.</p>
      {!secureStorage ? (
        <div role="status" className="card flat">Deze computer heeft geen veilige opslag voor de inloggegevens. Blijf daarom bankafschriften downloaden en inlezen; de koppeling kan hier niet worden ingesteld.</div>
      ) : <p className="muted">De app bewaart de twee Ponto-gegevens alleen in de veilige opslag van je computer.</p>}
    </div>
  );
}

export function PontoStoredCredentialHint({ last4 }: { last4: string | null }) {
  return <p className="small muted">Er is al een koppeling ingesteld{last4 ? ` met Client ID eindigend op ${last4}` : ''}. Plak beide gegevens opnieuw om haar te vervangen.</p>;
}

export function PontoCredentialFields({ clientId, clientSecret, onClientId, onClientSecret }: {
  clientId: string;
  clientSecret: string;
  onClientId(value: string): void;
  onClientSecret(value: string): void;
}) {
  return (
    <div className="grid cols-2">
      <Field label="Client ID" hint="wordt net als een wachtwoord behandeld">
        <input autoFocus type="password" autoComplete="off" value={clientId} onChange={(e) => onClientId(e.target.value)} />
      </Field>
      <Field label="Client Secret">
        <input type="password" autoComplete="off" value={clientSecret} onChange={(e) => onClientSecret(e.target.value)} />
      </Field>
    </div>
  );
}

export function PontoAccountChoice({ account, bankAccounts, value, usedBankAccountIds = [], onChange }: {
  account: FeedTestAccount;
  bankAccounts: BankAccount[];
  value: number | 'nieuw' | null;
  usedBankAccountIds?: number[];
  onChange(value: number | 'nieuw' | null): void;
}) {
  return (
    <fieldset className="card flat ponto-account">
      <legend><strong>{account.name}</strong>{account.iban ? ` · ${account.iban}` : ''}</legend>
      {!account.usable ? <p role="alert" className="small">Niet bruikbaar: {account.reason}</p> : (
        <>
          <Field label="In deze administratie gebruiken als">
            <select value={value ?? ''} onChange={(e) => onChange(e.target.value === 'nieuw' ? 'nieuw' : e.target.value ? Number(e.target.value) : null)}>
              <option value="">Niet gebruiken</option>
              {bankAccounts.map((bank) => <option key={bank.id} value={bank.id} disabled={bank.id !== value && usedBankAccountIds.includes(bank.id)}>{bank.name}{bank.iban ? ` (${bank.iban})` : ''}{bank.id !== value && usedBankAccountIds.includes(bank.id) ? ' — al gekozen' : ''}</option>)}
              <option value="nieuw">Nieuwe zakelijke rekening maken</option>
            </select>
          </Field>
          {value !== null && <p className="small muted">{value === account.suggestedBankAccountId ? pontoLinkText(account) : 'Deze aansluiting is niet bewezen. Eerdere periode nog onderbouwen met een afschrift/openingssaldo.'}</p>}
        </>
      )}
    </fieldset>
  );
}

function Summary({ summary }: { summary: RoundSummary & { autoMatched?: number } }) {
  const imported = summary.accounts.reduce((total, account) => total + account.imported, 0);
  return (
    <div role="status" className="card flat">
      <strong>Koppeling opgeslagen en opgehaald</strong>
      <p className="small">{imported} nieuwe {imported === 1 ? 'betaling' : 'betalingen'}, {summary.skipped.length} overgeslagen, {summary.failed.length} mislukt{summary.autoMatched != null ? `, ${summary.autoMatched} automatisch verwerkt` : ''}.</p>
    </div>
  );
}

export function PontoDialog({ initialStep = 0, onClose, onChanged }: { initialStep?: number; onClose(): void; onChanged(): void | Promise<void> }) {
  const [step, setStep] = useState(Math.max(0, Math.min(5, initialStep)));
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [tested, setTested] = useState<FeedTestAccount[] | null>(null);
  const [choices, setChoices] = useState<Record<string, number | 'nieuw' | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<(RoundSummary & { autoMatched?: number }) | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [working, setWorking] = useState(false);
  const status = useLoad(() => api.bankfeed.status());
  const banks = useLoad(() => api.bank.accounts());
  const credentialsEntered = Boolean(clientId || clientSecret);

  useEffect(() => setStep(Math.max(0, Math.min(5, initialStep))), [initialStep]);

  const clearCredentials = () => {
    setClientId('');
    setClientSecret('');
  };
  const close = () => {
    if (credentialsEntered) return setConfirmClose(true);
    onClose();
  };
  const discardAndClose = () => {
    clearCredentials();
    setConfirmClose(false);
    onClose();
  };
  const test = async () => {
    setError(null);
    setWorking(true);
    try {
      const result = await api.bankfeed.testen(clientId, clientSecret);
      setTested(result.accounts);
      const used = new Set<number>();
      setChoices(Object.fromEntries(result.accounts.map((account) => {
        const suggested = account.usable ? account.suggestedBankAccountId : null;
        if (suggested == null || used.has(suggested)) return [account.pontoId, null];
        used.add(suggested);
        return [account.pontoId, suggested];
      })));
      setStep(5);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const save = async () => {
    if (!tested) return;
    setError(null);
    setWorking(true);
    const links: FeedLink[] = tested.map((account) => ({ pontoId: account.pontoId, bankAccountId: account.usable ? choices[account.pontoId] ?? null : null, name: account.name }));
    try {
      const result = await api.bankfeed.opslaan(clientId, clientSecret, links);
      clearCredentials();
      setSummary(result);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  if (status.loading || banks.loading) return <Modal title="Ponto-bankkoppeling" wide onClose={close}><p role="status">Laden…</p></Modal>;

  return (
    <Modal title="Ponto-bankkoppeling" wide onClose={close}>
      <div className="ponto-progress" aria-label={`Stap ${step} van 5`}>
        <span>Stap {step} van 5</span>
        <progress max={5} value={step} />
      </div>
      {(error || status.error || banks.error) && <div role="alert" className="notice bad">{error ?? status.error ?? banks.error}</div>}

      {step === 0 && (
        <PontoIntro secureStorage={Boolean(status.data?.secureStorage)} />
      )}
      {step === 1 && (
        <div className="grid">
          <h3>Maak of open je Ponto-account</h3>
          <p>Open het beveiligde Ponto-dashboard en rond daar je zakelijke account af.</p>
          <div><Button kind="primary" onClick={() => void api.app.openExternal(PONTO_DASHBOARD)}>Open Ponto-dashboard</Button></div>
        </div>
      )}
      {step === 2 && (
        <div className="grid">
          <h3>Koppel je bank bij Ponto</h3>
          <p>Kies in Ponto de zakelijke bankrekening(en) die je in deze administratie wilt gebruiken. Rond de toestemming bij je bank af en kom daarna hier terug.</p>
          <div><Button kind="primary" onClick={() => void api.app.openExternal(PONTO_DASHBOARD)}>Naar mijn Ponto-rekeningen</Button></div>
        </div>
      )}
      {step === 3 && (
        <div className="grid">
          <h3>Maak de koppeling voor Boekhouden Voor Niks</h3>
          <p>Kies alleen <strong>AIS</strong> (rekeninginformatie), selecteer de gewenste rekeningen en behandel zowel de Client ID als het Client Secret als een wachtwoord.</p>
          <div><Button kind="primary" onClick={() => void api.app.openExternal(PONTO_INSTALL)}>Custom integration maken</Button></div>
        </div>
      )}
      {step === 4 && (
        <div className="grid">
          <h3>Plak en test de twee gegevens</h3>
          {status.data?.configured && <PontoStoredCredentialHint last4={status.data.clientIdLast4} />}
          <PontoCredentialFields clientId={clientId} clientSecret={clientSecret} onClientId={setClientId} onClientSecret={setClientSecret} />
          <div><Button kind="primary" disabled={working || !clientId.trim() || !clientSecret.trim()} onClick={() => void test()}>Verbinding testen</Button></div>
        </div>
      )}
      {step === 5 && (
        <div className="grid">
          <h3>Kies waar elke rekening hoort</h3>
          {summary ? <Summary summary={summary} /> : (tested ?? []).map((account) => (
            <PontoAccountChoice key={account.pontoId} account={account} bankAccounts={banks.data ?? []} value={choices[account.pontoId] ?? null} usedBankAccountIds={Object.entries(choices).filter(([pontoId]) => pontoId !== account.pontoId).map(([, value]) => value).filter((value): value is number => typeof value === 'number')} onChange={(value) => setChoices((current) => ({ ...current, [account.pontoId]: value }))} />
          ))}
          {!tested && <p role="alert">Test eerst de Client ID en het Client Secret.</p>}
        </div>
      )}

      <div className="row between ponto-dialog-actions">
        <Button disabled={step === 0 || Boolean(summary)} onClick={() => setStep((value) => Math.max(0, value - 1))}>Terug</Button>
        <div className="row">
          <Button onClick={close}>{summary ? 'Sluiten' : 'Annuleren'}</Button>
          {step < 4 && <Button kind="primary" disabled={step === 0 && !status.data?.secureStorage} onClick={() => setStep((value) => value + 1)}>Volgende</Button>}
          {step === 5 && !summary && <Button kind="primary" disabled={working || !tested} onClick={() => void save()}>Koppelen en ophalen</Button>}
        </div>
      </div>

      {confirmClose && (
        <Modal title="Ingetypte Ponto-gegevens wissen?" onClose={() => setConfirmClose(false)}>
          <p>De Client ID en het Client Secret zijn nog niet opgeslagen. Als je sluit, worden ze uit dit venster gewist.</p>
          <div className="row end"><Button onClick={() => setConfirmClose(false)}>Verdergaan</Button><Button kind="danger" onClick={discardAndClose}>Wissen en sluiten</Button></div>
        </Modal>
      )}
    </Modal>
  );
}

function PontoAccountRow({ account, onRefresh, busy, cooldown }: { account: FeedAccountInfo; onRefresh(account: FeedAccountInfo): void; busy: boolean; cooldown?: string }) {
  return (
    <div className="card flat grid ponto-status-account" data-feed-account-id={account.id}>
      <div className="row between">
        <strong>{account.name}{account.iban ? ` · ${account.iban}` : ''}</strong>
        <span className={`pill ${account.status === 'actief' ? 'good' : account.status === 'weg' ? 'bad' : ''}`}>Ponto · {account.status}</span>
      </div>
      <div className="small">{pontoAccountStatusText(account)}</div>
      <div className="small muted">Toestemming: {account.expiresAt ? <>t/m <DateNl date={account.expiresAt} /></> : 'datum onbekend'}{account.lastOkAt ? <> · Laatste geslaagde ronde <DateNl date={account.lastOkAt.slice(0, 10)} /></> : ''}</div>
      {account.status === 'actief' && account.bankAccountId != null && <div><Button small disabled={busy || Boolean(cooldown)} onClick={() => onRefresh(account)}>{cooldown ? pontoCooldownText(cooldown) : 'Nu bijwerken'}</Button></div>}
    </div>
  );
}

export function PontoCard({ initialStep, focusAccountId }: { initialStep?: number; focusAccountId?: number }) {
  const { toast } = useApp();
  const status = useLoad(() => api.bankfeed.status());
  const { busy: busyOther } = useAction();
  const [busyManual, setBusyManual] = useState(false);
  const busy = busyOther || busyManual;
  const [wizard, setWizard] = useState<number | null>(initialStep ?? null);
  const [privacyAccount, setPrivacyAccount] = useState<FeedAccountInfo | null>(null);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [disconnect, setDisconnect] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [lastAction, setLastAction] = useState<{ at: Date; ok: boolean; lines: string[] } | null>(null);
  const [cooldowns, setCooldowns] = useState<Record<number, string>>({});
  const focused = useMemo(() => status.data?.accounts.find((account) => account.id === focusAccountId), [status.data, focusAccountId]);

  const cooldownFor = (account: FeedAccountInfo): string | undefined => {
    const explicit = cooldowns[account.id];
    if (explicit && new Date(explicit).getTime() > Date.now()) return explicit;
    if (!account.manualSyncAt) return undefined;
    const started = new Date(`${account.manualSyncAt.replace(' ', 'T')}Z`).getTime();
    const allowed = started + 30 * 60_000;
    return allowed > Date.now() ? new Date(allowed).toISOString() : undefined;
  };

  useEffect(() => {
    if (initialStep != null) setWizard(initialStep);
  }, [initialStep]);

  const track = async (label: string, fn: () => Promise<{ allowed?: boolean; allowedAt?: string; summary?: RoundSummary } | RoundSummary>, accountId?: number) => {
    let outcome: { ok: boolean; lines: string[] };
    try {
      const result = await fn();
      const summary: RoundSummary | undefined = 'summary' in result ? result.summary : 'failed' in result ? (result as RoundSummary) : undefined;
      if ('allowed' in result && result.allowed === false && accountId !== undefined && result.allowedAt) {
        const allowedAt = result.allowedAt;
        setCooldowns((current) => ({ ...current, [accountId]: allowedAt }));
        outcome = { ok: false, lines: [`${label}: nog niet toegestaan, probeer het ${pontoCooldownText(allowedAt).toLowerCase()}.`] };
      } else {
        const failed = summary?.failed ?? [];
        const imported = summary?.accounts.reduce((sum, a) => sum + a.imported, 0) ?? 0;
        outcome = failed.length === 0
          ? { ok: true, lines: [`${label}: gelukt. ${imported} nieuwe transactie${imported === 1 ? '' : 's'} geïmporteerd.`] }
          : { ok: false, lines: [`${label}: niet volledig gelukt.`, ...failed.map((f) => `${f.subtype === 'accountDetails' ? 'Saldo' : f.subtype === 'accountTransactions' ? 'Transacties' : 'Rekening'}: ${pontoErrorKindText(f.errorKind)}`)] };
      }
    } catch (e) {
      outcome = { ok: false, lines: [`${label}: mislukt. ${(e as Error).message}`] };
    }
    setLastAction({ at: new Date(), ...outcome });
    await status.reload();
  };
  const refresh = async (account: FeedAccountInfo) => {
    if (!privacyAccepted) return setPrivacyAccount(account);
    await refreshAfterAcceptance(account);
  };
  const acceptPrivacy = async () => {
    const account = privacyAccount;
    setPrivacyAccepted(true);
    setPrivacyAccount(null);
    if (account) await refreshAfterAcceptance(account);
  };
  const refreshAfterAcceptance = async (account: FeedAccountInfo) => {
    setBusyManual(true);
    try { await track(`Handmatig bijwerken (${account.name})`, () => api.bankfeed.bijwerken(account.id), account.id); } finally { setBusyManual(false); }
  };
  const remove = async () => {
    setRemoving(true);
    try {
      await api.bankfeed.verwijderen();
      toast('Ponto is ontkoppeld. Bestaande transacties zijn bewaard.');
      setDisconnect(false);
      await status.reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="card grid ponto-card">
      <div className="row between"><div><h2 style={{ margin: 0 }}>Bank automatisch ophalen met Ponto</h2><p className="small muted" style={{ margin: '4px 0 0' }}>Ponto is een afzonderlijke zakelijke dienst.</p></div>{status.data?.configured && <span className="pill good">gekoppeld</span>}</div>
      {status.error && <div role="alert" className="notice bad">{status.error}</div>}
      {status.loading && <div role="status">Ponto-status laden…</div>}
      {lastAction && <div role={lastAction.ok ? 'status' : 'alert'} className={`notice ${lastAction.ok ? 'good' : 'bad'}`}><strong>{lastAction.at.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</strong>{lastAction.lines.map((line) => <div key={line}>{line}</div>)}<button type="button" className="btn small" onClick={() => setLastAction(null)}>Sluiten</button></div>}
      {focused && <div role="status" className="small">Deze rekening hoort bij de melding die je opende.</div>}
      {(status.data?.accounts ?? []).map((account) => <PontoAccountRow key={account.id} account={account} busy={busy} cooldown={cooldownFor(account)} onRefresh={(selected) => void refresh(selected)} />)}
      <div className="row">
        {!status.data?.configured && <Button kind="primary" onClick={() => setWizard(0)}>Ponto instellen</Button>}
        {status.data?.configured && <Button disabled={busy} onClick={async () => { setBusyManual(true); try { await track('Bank ophalen', () => api.bankfeed.ophalen()); } finally { setBusyManual(false); } }}>Nu ophalen</Button>}
        {status.data?.configured && <Button onClick={() => setWizard(4)}>Opnieuw plakken</Button>}
        {status.data?.configured && <Button kind="danger" onClick={() => setDisconnect(true)}>Ontkoppelen</Button>}
      </div>

      {wizard != null && <PontoDialog initialStep={wizard} onClose={() => setWizard(null)} onChanged={() => status.reload()} />}
      {privacyAccount && <Modal title="Handmatig bijwerken via Ponto" onClose={() => setPrivacyAccount(null)}><p>Voor deze handmatige actie ontvangt Cloudflare je publieke IP-adres. Ponto vereist dit om de synchronisatie te starten. De app bewaart het IP-adres niet.</p><div className="row end"><Button onClick={() => setPrivacyAccount(null)}>Annuleren</Button><Button kind="primary" onClick={() => void acceptPrivacy()}>Doorgaan en bijwerken</Button></div></Modal>}
      {disconnect && <Modal title="Ponto ontkoppelen" onClose={() => setDisconnect(false)}><p>De koppeling en opgeslagen inloggegevens worden op deze computer verwijderd. Je bestaande transacties en bankrekeningen blijven staan.</p><p>Verwijder de custom integration daarna ook zelf in Ponto.</p><div className="row end"><Button disabled={removing} onClick={() => setDisconnect(false)}>Annuleren</Button><Button kind="danger" disabled={busy || removing} onClick={() => void remove()}>Ontkoppelen</Button></div></Modal>}
    </div>
  );
}
