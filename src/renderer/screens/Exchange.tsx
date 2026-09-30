import { useState } from 'react';
import { api } from '../api';
import { Button, DropZone, ErrorBox, Field, Modal, readAsBytes, useAction, useApp, useLoad } from '../ui';
import { formatDateNl } from '../../shared/dates';
import { TERMS_PDF_URL, TERMS_URL, TERMS_VERSION } from '../../shared/legal';
import { PeriodPicker, usePeriodChoice } from './PeriodClose';

/**
 * Uitwisseling met de boekhouder (docs/uitwisseling.md). De klant stuurt een periode, de boekhouder
 * corrigeert in zijn kopie, de klant leest het antwoord in. Niets gaat via een server van ons.
 */
export function ExchangeCard({ onChange }: { onChange?: () => void }) {
  const { toast } = useApp();
  const status = useLoad(() => api.exchange.status());
  const choice = usePeriodChoice();
  const { run, busy } = useAction();
  const [invite, setInvite] = useState<{ office: string; email: string; code: string; data: Uint8Array } | null>(null);
  const [sending, setSending] = useState<'mail' | 'bestand' | null>(null);
  const [aborting, setAborting] = useState(false);
  const license = useLoad(() => api.license.status());
  const [result, setResult] = useState<{ office: string; count: number; summaries: string[]; closedUntil: string; conflicts: { kind: string; label: string }[] } | null>(null);
  const st = status.data;
  if (!st || st.copy) return null;

  const changed = async () => {
    await Promise.all([status.reload(), choice.reload()]);
    onChange?.();
  };

  const send = async (how: 'mail' | 'bestand') => {
    const until = choice.until!;
    const r = await run(() => api.exchange.send(until, choice.confirmed, how));
    setSending(null);
    if (!r) return;
    if (r.note) toast(r.note);
    if (r.mailedTo) toast(`Gemaild naar ${r.mailedTo}`);
    else if (r.path) toast(`Bewaard: ${r.path}. Stuur dit bestand naar je boekhouder.`);
    await changed();
  };

  return (
    <div className="card grid" data-testid="uitwisseling">
      <h2 style={{ margin: 0 }}>🤝 Uitwisseling met je boekhouder</h2>
      <ErrorBox error={status.error ?? choice.error} />

      {!st.partner && (
        <>
          <p style={{ margin: 0 }}>
            Werkt je boekhouder ook met BoekhoudenVoorNiks? Dan stuur je hem een periode, hij corrigeert wat nodig is, en jij leest zijn antwoord in. Wat je na die periode doet, blijft gewoon staan.
            Vraag hem om een uitnodiging (een bestand dat eindigt op <code>.gbuitnodiging</code>) en open die hier.
          </p>
          <DropZone accept=".gbuitnodiging,application/json" onFile={async (f) => {
            const data = await readAsBytes(f);
            const r = await run(() => api.exchange.readInvite(data));
            if (r) setInvite({ ...r, data });
          }}>
            <p style={{ margin: 0 }}>Sleep de uitnodiging hierheen, of klik om hem te kiezen.</p>
          </DropZone>
        </>
      )}

      {st.partner && !st.running && (
        <>
          <p style={{ margin: 0 }}>
            Gekoppeld aan <strong>{st.partner.office}</strong>{st.partner.email ? ` (${st.partner.email})` : ''} · controlecode <code>{st.partner.code}</code>
          </p>
          {st.last && (
            <p className="small muted" style={{ margin: 0 }}>
              Laatste antwoord: uitwisseling {st.last.exchange} t/m {formatDateNl(st.last.until)}, {st.last.count} {st.last.count === 1 ? 'aanpassing' : 'aanpassingen'}, ingelezen op {formatDateNl(st.last.readAt.slice(0, 10))}.
            </p>
          )}
          {choice.dates.data && choice.dates.data.length === 0 && <p className="small muted" style={{ margin: 0 }}>Alles t/m het vorige kwartaal is al afgesloten.</p>}
          {license.data && <Subscription status={license.data} onChange={() => void license.reload()} />}
          <PeriodPicker label="Sturen t/m" choice={choice} />
          {choice.until && (
            <div className="row" style={{ alignItems: 'center' }}>
              {st.canMail && st.partner.email && <Button kind="primary" disabled={!choice.ready || busy} onClick={() => setSending('mail')}>Mailen naar {st.partner.office}</Button>}
              <Button kind={st.canMail && st.partner.email ? undefined : 'primary'} disabled={!choice.ready || busy} onClick={() => setSending('bestand')}>Als bestand bewaren</Button>
              <Button kind="ghost" small disabled={busy} onClick={async () => { if ((await run(() => api.exchange.unlink())) !== undefined) await changed(); }}>Ontkoppelen</Button>
            </div>
          )}
        </>
      )}

      {st.running && (
        <>
          <p style={{ margin: 0 }}>
            <strong>Uitwisseling {st.running.no} ligt bij {st.partner?.office ?? 'je boekhouder'}</strong>: alles t/m {formatDateNl(st.running.until)} ligt vast tot zijn antwoord is ingelezen. Na {formatDateNl(st.running.until)} werk je gewoon door.
          </p>
          <DropZone accept=".gbpakket" onFile={async (f) => {
            const data = await readAsBytes(f);
            const r = await run(() => api.exchange.readAnswer(data), 'Antwoord ingelezen');
            if (r) {
              setResult(r);
              await changed();
            }
          }}>
            <p style={{ margin: 0 }}>Antwoord van je boekhouder ontvangen? Sleep het hierheen (<code>.gbpakket</code>), of klik om het te kiezen.</p>
          </DropZone>
          <div className="row">
            <Button kind="ghost" small onClick={() => setAborting(true)}>Uitwisseling afbreken</Button>
          </div>
        </>
      )}

      {invite && (
        <Modal title="Koppelen aan je boekhouder?" onClose={() => setInvite(null)}>
          <p><strong>{invite.office}</strong>{invite.email ? ` (${invite.email})` : ''}</p>
          <p>Controlecode: <code style={{ fontSize: 18 }}>{invite.code}</code></p>
          <p className="small">Vergelijk deze code even met je boekhouder, bijvoorbeeld telefonisch. Is hij gelijk, dan weet je zeker dat alleen dit kantoor je administratie kan openen.</p>
          <div className="row end">
            <Button onClick={() => setInvite(null)}>Annuleren</Button>
            <Button kind="primary" disabled={busy} onClick={async () => {
              const r = await run(() => api.exchange.link(invite.data), `Gekoppeld aan ${invite.office}`);
              setInvite(null);
              if (r) await changed();
            }}>Koppelen</Button>
          </div>
        </Modal>
      )}

      {sending && choice.until && st.partner && (
        <Modal title={`T/m ${formatDateNl(choice.until)} naar ${st.partner.office}?`} onClose={() => setSending(null)}>
          <p>Je boekhouder krijgt je administratie zoals hij nu is, met je bonnen en facturen, versleuteld zodat alleen zijn kantoor hem kan openen. Wachtwoorden en koppelingen gaan niet mee. Hij corrigeert alleen t/m {formatDateNl(choice.until)}; wat je daarna al geboekt hebt, ziet hij wel (bijvoorbeeld of een klant zijn factuur nog betaalde), maar verandert hij niet.</p>
          <p>Tot zijn antwoord is ingelezen, ligt alles t/m {formatDateNl(choice.until)} vast. Daarna werk je gewoon door. Na het inlezen is die periode afgesloten.</p>
          <div className="row end">
            <Button onClick={() => setSending(null)}>Annuleren</Button>
            <Button kind="primary" disabled={busy} onClick={() => void send(sending)}>{sending === 'mail' ? 'Mailen' : 'Bewaren'}</Button>
          </div>
        </Modal>
      )}

      {aborting && st.running && (
        <Modal title={`Uitwisseling ${st.running.no} afbreken?`} onClose={() => setAborting(false)}>
          <p>De periode t/m {formatDateNl(st.running.until)} is dan weer open. Een antwoord van je boekhouder op deze uitwisseling kun je daarna niet meer inlezen; je stuurt hem dan een nieuwe.</p>
          <div className="row end">
            <Button onClick={() => setAborting(false)}>Nee</Button>
            <Button kind="danger" disabled={busy} onClick={async () => {
              await run(() => api.exchange.abort(), 'Uitwisseling afgebroken');
              setAborting(false);
              await changed();
            }}>Afbreken</Button>
          </div>
        </Modal>
      )}

      {result && (
        <Modal title={`Antwoord van ${result.office} ingelezen`} onClose={() => setResult(null)}>
          <p>Alles t/m {formatDateNl(result.closedUntil)} is nu afgesloten. {result.count === 0 ? 'Je boekhouder hoefde niets aan te passen.' : `Je boekhouder heeft ${result.count === 1 ? '1 aanpassing' : `${result.count} aanpassingen`} gedaan:`}</p>
          {result.summaries.length > 0 && <ul className="small">{result.summaries.map((s, i) => <li key={i}>{s}</li>)}</ul>}
          {result.conflicts.length > 0 && (
            <div className="notice warn small">
              Let op: je boekhouder heeft {result.conflicts.map((c) => `${c.kind === 'factuur' ? 'factuur' : 'inkoop'} ${c.label}`).join(', ')} teruggedraaid, terwijl er al op betaald is. Dat staat op Vandaag, zodat je het met hem kunt afhandelen.
            </div>
          )}
          <div className="row end"><Button kind="primary" onClick={() => setResult(null)}>Oké</Button></div>
        </Modal>
      )}
    </div>
  );
}

type LicenseState = Awaited<ReturnType<typeof api.license.status>>;

/**
 * Het abonnement: alleen versturen naar de boekhouder vraagt het. Niets te zien zolang licenties uit
 * staan (geen sleutel in de app).
 */
function Subscription({ status, onChange }: { status: LicenseState; onChange: () => void }) {
  const { settings, toast } = useApp();
  const price = useLoad(() => api.license.price(), [status.state]);
  const { run, busy } = useAction();
  const [email, setEmail] = useState(settings.company.email);
  const [cancelling, setCancelling] = useState(false);
  const [agreed, setAgreed] = useState(false);
  if (status.state === 'uit') return null;

  // artikel 8.2 en 8.3 van de voorwaarden: vóór het afsluiten, ook bij opnieuw afsluiten
  const consent = (
    <label className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
      <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} aria-describedby="abonnement-voorwaarden" />
      <span id="abonnement-voorwaarden" className="small">
        Ik sluit dit abonnement af voor mijn bedrijf en ga akkoord met de <a href={TERMS_URL} onClick={(e) => { e.preventDefault(); void api.app.openExternal(TERMS_URL); }}>gebruiksvoorwaarden</a> (versie {TERMS_VERSION}, in het bijzonder artikel 8 over het abonnement en artikel 9 over aansprakelijkheid). <a href={TERMS_PDF_URL} onClick={(e) => { e.preventDefault(); void api.app.openExternal(TERMS_PDF_URL); }}>Download de voorwaarden als PDF</a> om ze te bewaren.
      </span>
    </label>
  );

  const fetchLicense = async () => {
    const r = await run(() => api.license.refresh());
    if (r) {
      toast(r.state === 'actief' ? `Abonnement actief t/m ${formatDateNl(r.validUntil)}` : 'Licentie opgehaald');
      onChange();
    }
  };
  const checkout = async () => {
    const r = await run(() => api.license.checkout(email, { terms: TERMS_VERSION, business: agreed }));
    if (!r) return;
    if (r.al) {
      toast('Je hebt al een abonnement; we halen je licentie op');
      await fetchLicense();
    } else toast('De betaalpagina is geopend in je browser');
  };

  if (status.state === 'actief') {
    return (
      <div className="small" style={{ margin: 0 }}>
        {status.cancelled ? (
          <div className="grid" style={{ gap: 6 }}>
            <div className="row" style={{ alignItems: 'center', gap: 10 }}>
              <span className="muted">Abonnement opgezegd: je kunt versturen t/m {formatDateNl(status.validUntil)}; er wordt niets meer afgeschreven.</span>
              <Button small disabled={busy || !agreed} onClick={() => void checkout()}>Opnieuw afsluiten</Button>
            </div>
            {consent}
          </div>
        ) : (
          <div className="row" style={{ alignItems: 'center', gap: 10 }}>
            <span className="muted">Abonnement actief; de maandelijkse factuur krijg je per e-mail.</span>
            <Button small kind="ghost" onClick={() => setCancelling(true)}>Opzeggen</Button>
          </div>
        )}
        {cancelling && (
          <Modal title="Abonnement opzeggen?" onClose={() => setCancelling(false)}>
            <p>Er wordt daarna niets meer afgeschreven. Je kunt nog naar je boekhouder versturen tot het eind van de maand waarvoor je betaald hebt; een antwoord inlezen kan altijd.</p>
            <div className="row end">
              <Button onClick={() => setCancelling(false)}>Niet opzeggen</Button>
              <Button kind="danger" disabled={busy} onClick={async () => {
                const r = await run(() => api.license.cancel());
                setCancelling(false);
                if (r) {
                  toast(r.state === 'actief' ? `Opgezegd; versturen kan nog t/m ${formatDateNl(r.validUntil)}` : 'Opgezegd');
                  onChange();
                }
              }}>Opzeggen</Button>
            </div>
          </Modal>
        )}
      </div>
    );
  }
  const euro = (v: string) => `€ ${v.replace('.', ',')}`;
  const p = price.data;
  const amount = p ? (p.btw === 'exclusief' ? `${euro(p.bedrag)} per ${p.per} exclusief btw${p.inclusiefBtw ? ` (${euro(p.inclusiefBtw)} inclusief)` : ''}` : `${euro(p.bedrag)} per ${p.per} (inclusief btw)`) : null;
  // een proefperiode alleen bij een eerste abonnement; na verlopen is het gewoon verlengen
  const trial = status.state === 'geen' && p?.proefMaanden ? p.proefMaanden : 0;
  return (
    <div className="notice grid" data-testid="abonnement">
      <div>
        <strong>{status.state === 'verlopen' ? `Je abonnement liep tot ${formatDateNl(status.validUntil)}.` : 'Versturen naar je boekhouder hoort bij het abonnement.'}</strong>{' '}
        {trial > 0 && <><strong>De eerste {trial} maanden zijn gratis.</strong>{' '}</>}
        {amount ? `${trial > 0 ? 'Daarna kost het' : 'Het kost'} ${amount}, per maand opzegbaar. ` : 'Per maand opzegbaar. '}Koppelen en een antwoord inlezen kan altijd; alleen het versturen vraagt een abonnement.{' '}
        {trial > 0
          ? 'Bij het afsluiten betaal je via Mollie alleen € 0,01 met iDEAL, voor de machtiging. De eerste incasso is na de gratis maanden; zeg je daarvoor op, dan betaal je niets. Van elke betaalde maand krijg je een factuur op naam van je bedrijf.'
          : 'Je betaalt via Mollie (iDEAL, daarna automatische incasso) en krijgt elke maand een factuur op naam van je bedrijf.'}
      </div>
      {consent}
      <div className="row" style={{ alignItems: 'flex-end', gap: 10 }}>
        <Field label="E-mailadres voor het abonnement en de facturen"><input value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Button kind="primary" disabled={busy || !email.trim() || !agreed} onClick={() => void checkout()}>{status.state === 'verlopen' ? 'Verlengen' : trial > 0 ? `${trial} maanden gratis beginnen` : 'Abonnement nemen'}</Button>
        <Button disabled={busy} onClick={() => void fetchLicense()}>Ik heb betaald: licentie ophalen</Button>
      </div>
    </div>
  );
}

/** Bij de boekhouder: het kantoor op deze computer, uitnodigingen en exports van klanten. */
export function OfficeSettings() {
  const { toast } = useApp();
  const status = useLoad(() => api.exchange.status());
  const { run, busy } = useAction();
  const [office, setOffice] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [sharePassword, setSharePassword] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const st = status.data;
  if (!st) return <ErrorBox error={status.error} />;
  const name = office ?? st.office?.office ?? '';
  const mail = email ?? st.office?.email ?? '';
  return (
    <div className="card grid" style={{ marginTop: 14 }} data-testid="kantoor">
      <h3 style={{ margin: 0 }}>Voor boekhouders: je kantoor</h3>
      <p className="small muted" style={{ margin: 0 }}>
        Werken klanten van je met BoekhoudenVoorNiks? Stuur ze een uitnodiging; daarmee kunnen ze een periode naar je sturen die alleen jouw kantoor kan openen. Je opent hun export hier als aparte administratie, corrigeert, en stuurt een antwoord terug.
      </p>
      <div className="grid cols-2">
        <Field label="Naam van je kantoor"><input value={name} onChange={(e) => setOffice(e.target.value)} placeholder="bv. Administratiekantoor De Vries" /></Field>
        <Field label="E-mailadres" hint="hier sturen klanten hun export heen"><input value={mail} onChange={(e) => setEmail(e.target.value)} /></Field>
      </div>
      {st.officeProblem && (
        <div className="notice bad grid">
          <span>{st.officeProblem} Je kunt een nieuwe kantoorsleutel maken; stuur je klanten daarna een nieuwe uitnodiging. Exports die al onderweg zijn, kun je dan niet meer openen: die maakt je klant opnieuw.</span>
          <div><Button small disabled={busy || !name.trim()} onClick={async () => {
            if ((await run(() => api.exchange.saveOffice(name, mail, true), 'Nieuwe kantoorsleutel gemaakt')) !== undefined) await status.reload();
          }}>Nieuwe kantoorsleutel maken</Button></div>
        </div>
      )}
      <div className="row" style={{ alignItems: 'center' }}>
        <Button disabled={busy || !name.trim() || (name === st.office?.office && mail === st.office?.email)} onClick={async () => {
          if ((await run(() => api.exchange.saveOffice(name, mail), 'Opgeslagen')) !== undefined) {
            setOffice(null);
            setEmail(null);
            await status.reload();
          }
        }}>Opslaan</Button>
        {st.office && <span className="small">Controlecode van je kantoor: <code>{st.office.code}</code></span>}
      </div>
      {st.office && (
        <>
          <div className="row">
            <Button kind="primary" disabled={busy} onClick={async () => {
              const path = await run(() => api.exchange.invite());
              if (path) toast(`Uitnodiging bewaard: ${path}. Stuur hem naar je klant.`);
            }}>Uitnodiging voor een klant maken</Button>
          </div>
          <DropZone accept=".gbpakket" onFile={async (f) => {
            const data = await readAsBytes(f);
            await run(() => api.exchange.openExport(data), 'Export ingelezen');
          }}>
            <p style={{ margin: 0 }}>Export van een klant ontvangen? Sleep hem hierheen (<code>.gbpakket</code>), of klik om hem te kiezen. Hij wordt een aparte administratie.</p>
          </DropZone>
        </>
      )}
      <details data-testid="collega">
        <summary>Met collega's werken: de kantoorsleutel delen</summary>
        <div className="grid" style={{ marginTop: 10 }}>
          <p className="small muted" style={{ margin: 0 }}>
            Alle computers van je kantoor hebben dezelfde kantoorsleutel nodig, anders kan alleen deze computer de exports van je klanten openen. Geef het wachtwoord apart door (niet in dezelfde mail als het bestand).
          </p>
          {st.office && (
            <div className="row" style={{ alignItems: 'flex-end', gap: 10 }}>
              <Field label="Wachtwoord" hint="minimaal 10 tekens"><input type="password" value={sharePassword} onChange={(e) => setSharePassword(e.target.value)} /></Field>
              <Button disabled={busy || sharePassword.length < 10} onClick={async () => {
                const path = await run(() => api.exchange.exportOfficeKey(sharePassword));
                if (path) {
                  toast(`Kantoorsleutel bewaard: ${path}. Geef het wachtwoord apart door.`);
                  setSharePassword('');
                }
              }}>Kantoorsleutel bewaren voor een collega</Button>
            </div>
          )}
          <Field label="Wachtwoord van de kantoorsleutel van je collega"><input type="password" value={importPassword} onChange={(e) => setImportPassword(e.target.value)} /></Field>
          <DropZone accept=".gbkantoor" onFile={async (f) => {
            const data = await readAsBytes(f);
            if ((await run(() => api.exchange.importOfficeKey(data, importPassword), 'Kantoorsleutel overgenomen')) !== undefined) {
              setImportPassword('');
              setOffice(null);
              setEmail(null);
              await status.reload();
            }
          }}>
            <p style={{ margin: 0 }}>Kantoorsleutel van een collega (<code>.gbkantoor</code>): vul eerst het wachtwoord in en sleep het bestand hierheen.{st.office ? ' Je eigen sleutel wordt dan vervangen; uitnodigingen die deze computer eerder maakte, werken daarna niet meer.' : ''}</p>
          </DropZone>
        </div>
      </details>
    </div>
  );
}

/** In de kopie van een klant: wat er gecorrigeerd is, en het antwoord maken. */
export function OfficeCopyAnswer() {
  const { toast } = useApp();
  const status = useLoad(() => api.exchange.status());
  const actions = useLoad(() => api.exchange.actions());
  const { run, busy } = useAction();
  const copy = status.data?.copy;
  if (!copy) return null;
  const reload = () => Promise.all([status.reload(), actions.reload()]);
  return (
    <div className="notice warn grid" role="status" style={{ margin: '0 0 16px' }} data-testid="kopie-antwoord">
      <div>
        🗂️ <strong>Kopie van {copy.company || 'je klant'} voor {copy.office}</strong> (uitwisseling {copy.exchange}, t/m {formatDateNl(copy.endDate)}). Correctieboekingen, terugdraaien en grootboekrekeningen toevoegen (Boekhouding, expertmodus) gaan mee in je antwoord; verder gaat er niets naar buiten.
      </div>
      {actions.data && actions.data.length > 0 && (
        <details>
          <summary>{actions.data.length === 1 ? '1 aanpassing' : `${actions.data.length} aanpassingen`}</summary>
          <ul className="small" style={{ margin: '6px 0 0' }}>{actions.data.map((a) => <li key={a.seq}>{a.summary}</li>)}</ul>
        </details>
      )}
      {copy.answeredAt ? (
        <div className="row" style={{ alignItems: 'center' }}>
          <span>Antwoord gemaakt op {formatDateNl(copy.answeredAt.slice(0, 10))}. Stuur het bestand naar {copy.email || 'je klant'}.</span>
          <Button small disabled={busy} onClick={async () => { await run(() => api.exchange.reopenAnswer()); await reload(); }}>Toch nog iets wijzigen</Button>
        </div>
      ) : (
        <div className="row">
          <Button kind="primary" disabled={busy} onClick={async () => {
            const r = await run(() => api.exchange.answer());
            if (r?.path) toast(`Antwoord bewaard: ${r.path}. Stuur het naar ${r.email || 'je klant'}.`);
            await reload();
          }}>Antwoord maken</Button>
        </div>
      )}
    </div>
  );
}
