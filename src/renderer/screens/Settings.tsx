import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Button, DateNl, ErrorBox, Field, useAction, useApp, useLoad, type Settings } from '../ui';
import type { AppSettings } from '../../settings/settings';
import { LICENSE_NAME, PRIVACY_URL, SOURCE_URL, TERMS_URL } from '../../shared/legal';

type Tab = 'bedrijf' | 'facturen' | 'email' | 'btw' | 'koppelingen' | 'ai' | 'backup' | 'geavanceerd' | 'over';

const TABS: [Tab, string][] = [
  ['bedrijf', 'Je bedrijf'],
  ['facturen', 'Facturen & offertes'],
  ['email', 'E-mail'],
  ['btw', 'BTW'],
  ['koppelingen', 'Koppelingen'],
  ['ai', 'Automatisch & herkenning'],
  ['backup', 'Back-up & updates'],
  ['geavanceerd', 'Voor de boekhouder'],
  ['over', 'Over'],
];

export function SettingsScreen() {
  const { settings, reloadSettings, route, go } = useApp();
  const { run, busy } = useAction();
  const [tab, setTab] = useState<Tab>((route.extra?.tab as Tab) ?? 'bedrijf');
  const [draft, setDraft] = useState<Settings>(settings);
  const bankAccounts = useLoad(() => api.bank.accounts());
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const set = (patch: Partial<AppSettings>) => setDraft({ ...draft, ...patch });
  const save = async () => {
    const { smtpPasswordSet: _ignored, ...rest } = draft;
    if ((await run(() => api.settings.update(rest), 'Opgeslagen')) !== undefined) await reloadSettings();
  };

  const section = (content: ReactNode) => (
    <>
      <div className="card grid">{content}</div>
      {dirty && (
        <div className="row end" style={{ marginTop: 12 }}>
          <Button onClick={() => setDraft(settings)}>Annuleren</Button>
          <Button kind="primary" disabled={busy} onClick={() => void save()}>Opslaan</Button>
        </div>
      )}
    </>
  );

  return (
    <div className="page">
      <h1>Instellingen</h1>
      <div className="chips" style={{ margin: '12px 0 18px' }}>
        {TABS.map(([k, l]) => <button key={k} className={tab === k ? 'selected' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {tab === 'bedrijf' && section(
        <>
          <div className="grid cols-2">
            <Field label="Bedrijfsnaam"><input value={draft.company.name} onChange={(e) => set({ company: { ...draft.company, name: e.target.value } })} /></Field>
            <Field label="Je voornaam" hint="voor de begroeting"><input value={draft.profile.firstName} onChange={(e) => set({ profile: { ...draft.profile, firstName: e.target.value } })} /></Field>
          </div>
          <Field label="Adres"><input value={draft.company.address} onChange={(e) => set({ company: { ...draft.company, address: e.target.value } })} /></Field>
          <div className="grid cols-2">
            <Field label="Postcode"><input value={draft.company.postcode} onChange={(e) => set({ company: { ...draft.company, postcode: e.target.value } })} /></Field>
            <Field label="Plaats"><input value={draft.company.city} onChange={(e) => set({ company: { ...draft.company, city: e.target.value } })} /></Field>
            <Field label="E-mail"><input value={draft.company.email} onChange={(e) => set({ company: { ...draft.company, email: e.target.value } })} /></Field>
            <Field label="Telefoon"><input value={draft.company.phone} onChange={(e) => set({ company: { ...draft.company, phone: e.target.value } })} /></Field>
            <Field label="Website"><input value={draft.company.website} onChange={(e) => set({ company: { ...draft.company, website: e.target.value } })} /></Field>
            <Field label="KvK-nummer"><input value={draft.company.kvkNumber} onChange={(e) => set({ company: { ...draft.company, kvkNumber: e.target.value } })} /></Field>
            <Field label="IBAN"><input value={draft.company.iban} onChange={(e) => set({ company: { ...draft.company, iban: e.target.value } })} /></Field>
            <Field label="BIC" hint="optioneel"><input value={draft.company.bic} onChange={(e) => set({ company: { ...draft.company, bic: e.target.value } })} /></Field>
          </div>
        </>,
      )}

      {tab === 'facturen' && section(
        <>
          <label className="row"><input type="checkbox" checked={draft.sendUbl} onChange={(e) => set({ sendUbl: e.target.checked })} /> Stuur ook een e-factuur (UBL) mee, zodat de klant de factuur zonder overtypen kan inlezen</label>
          <div className="grid cols-3">
            <Field label="Betaaltermijn (dagen)"><input className="num" type="number" value={draft.paymentTermDays} onChange={(e) => set({ paymentTermDays: Number(e.target.value) })} /></Field>
            <Field label="Offerte geldig (dagen)"><input className="num" type="number" value={draft.quoteValidityDays} onChange={(e) => set({ quoteValidityDays: Number(e.target.value) })} /></Field>
            <Field label="Factuurnummer" hint="{JJJJ} jaar, {NNNN} volgnummer"><input value={draft.invoiceNumberFormat} onChange={(e) => set({ invoiceNumberFormat: e.target.value })} /></Field>
          </div>
          <Field label="Onderwerp factuur-mail"><input value={draft.invoiceEmailSubject} onChange={(e) => set({ invoiceEmailSubject: e.target.value })} /></Field>
          <Field label="Tekst factuur-mail" hint="{klant} {nummer} {bedrag} {vervaldatum} {iban} {bedrijf}"><textarea rows={6} value={draft.invoiceEmailBody} onChange={(e) => set({ invoiceEmailBody: e.target.value })} /></Field>
          <Field label="Tekst offerte-mail"><textarea rows={5} value={draft.quoteEmailBody} onChange={(e) => set({ quoteEmailBody: e.target.value })} /></Field>
          <h3>Herinneringen</h3>
          <label className="row"><input type="checkbox" checked={draft.remindersEnabled} onChange={(e) => set({ remindersEnabled: e.target.checked })} /> Automatisch een vriendelijke herinnering sturen als een klant te laat is</label>
          <Field label="Na hoeveel dagen te laat?" hint="bv. 7, 21"><input value={draft.reminderDays.join(', ')} onChange={(e) => set({ reminderDays: e.target.value.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 0) })} /></Field>
          <Field label="Tekst herinnering"><textarea rows={6} value={draft.reminderEmailBody} onChange={(e) => set({ reminderEmailBody: e.target.value })} /></Field>
          <div><Button onClick={() => go({ screen: 'opmaak' })}>🎨 Opmaak van facturen en offertes aanpassen</Button></div>
        </>,
      )}

      {tab === 'email' && <EmailSettings draft={draft} set={set} section={section} />}

      {tab === 'btw' && section(
        <>
          <label className="row"><input type="checkbox" checked={draft.kor} onChange={(e) => set({ kor: e.target.checked, defaultVatCode: e.target.checked ? 'vrijgesteld' : 'hoog' })} /> Ik gebruik de kleineondernemersregeling (KOR)</label>
          {!draft.kor && (
            <div className="grid cols-2">
              <Field label="Btw-identificatienummer"><input value={draft.company.vatNumber} onChange={(e) => set({ company: { ...draft.company, vatNumber: e.target.value } })} /></Field>
              <Field label="Aangifte doen per">
                <select value={draft.vatPeriod} onChange={(e) => set({ vatPeriod: e.target.value as AppSettings['vatPeriod'] })}>
                  <option value="kwartaal">Kwartaal</option><option value="maand">Maand</option><option value="jaar">Jaar</option>
                </select>
              </Field>
              <Field label="Belastingpotje" hint="een (spaar)rekening waar je de btw opzij zet">
                <select value={draft.vatPotAccountId ?? ''} onChange={(e) => set({ vatPotAccountId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Geen potje</option>
                  {(bankAccounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}{a.iban ? ` (${a.iban})` : ''}</option>)}
                </select>
              </Field>
              <Field label="Standaard BTW op nieuwe regels">
                <select value={draft.defaultVatCode} onChange={(e) => set({ defaultVatCode: e.target.value as AppSettings['defaultVatCode'] })}>
                  <option value="hoog">21%</option><option value="laag">9%</option><option value="nul">0%</option><option value="verlegd">Verlegd</option>
                </select>
              </Field>
            </div>
          )}
          <h3>Inkomstenbelasting</h3>
          <label className="row"><input type="checkbox" checked={draft.incomeTaxEstimate} onChange={(e) => set({ incomeTaxEstimate: e.target.checked })} /> Toon een schatting van de inkomstenbelasting</label>
          {draft.incomeTaxEstimate && (
            <label className="row"><input type="checkbox" checked={draft.urencriterium} onChange={(e) => set({ urencriterium: e.target.checked })} /> Ik werk minstens 1.225 uur per jaar in mijn bedrijf (urencriterium, voor de zelfstandigenaftrek)</label>
          )}
          <p className="muted small">Altijd een schatting: de app kent alleen de winst uit je bedrijf, niet je partner, hypotheek of ander inkomen.</p>
        </>,
      )}

      {tab === 'koppelingen' && <Integrations />}
      {tab === 'ai' && section(
        <>
          <Field label="Hoe automatisch?" hint="wat de app zelf mag afhandelen">
            <div className="chips">
              {([['voorzichtig', 'Voorzichtig: ik bevestig alles zelf'], ['normaal', 'Normaal'], ['maximaal', 'Maximaal: iets lagere drempels']] as const).map(([k, l]) => (
                <button key={k} className={draft.autopilot === k ? 'selected' : ''} onClick={() => set({ autopilot: k })}>{l}</button>
              ))}
            </div>
          </Field>
          <label className="row" style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={draft.jobLocation} onChange={(e) => set({ jobLocation: e.target.checked })} />
            <span>Gebruik de locatie van foto's om bonnen aan klussen te koppelen<br /><span className="small muted">Standaard uit. De plek uit de foto (als je telefoon die opslaat) blijft alleen op deze computer en wordt vergeleken met waar je eerder voor de klus fotografeerde.</span></span>
          </label>
          <p className="small muted">Ook op "maximaal" gaat alleen automatisch wat zeker genoeg is, en een leverancier pas nadat jij daar ja op zei. Alles wat automatisch ging zie je terug op Vandaag, met de reden en een knop "Klopt niet".</p>
          <p className="muted">Alles draait op je eigen computer; documenten gaan nergens naartoe. Zonder slimme herkenning werken e-facturen en PDF's met tekst gewoon; alleen foto's van bonnetjes vul je dan zelf in.</p>
          <LocalOcr engine={draft.ocr.engine} />
          <details style={{ marginTop: 12 }}>
            <summary className="small">Eigen OCR-dienst of lokale AI (geavanceerd)</summary>
          <div className="grid cols-2">
            <Field label="Lokale tekstherkenning (OCR)" hint="adres van de OCR-dienst op deze computer"><input value={draft.ocr.url} onChange={(e) => set({ ocr: { ...draft.ocr, url: e.target.value } })} placeholder="http://127.0.0.1:8765" /></Field>
            <Field label="OCR-model"><select value={draft.ocr.engine} onChange={(e) => set({ ocr: { ...draft.ocr, engine: e.target.value } })}><option value="ingebouwd">Ingebouwd (GLM-OCR)</option><option value="glm-ocr">GLM-OCR</option><option value="paddleocr-vl">PaddleOCR-VL</option><option value="grm-ocr">GRM-OCR</option><option value="anders">Anders</option></select></Field>
            <Field label="Lokale AI voor herkennen van aankopen" hint="Ollama-adres, optioneel"><input value={draft.ocr.llmUrl} onChange={(e) => set({ ocr: { ...draft.ocr, llmUrl: e.target.value } })} placeholder="http://127.0.0.1:11434" /></Field>
            <Field label="AI-model"><input value={draft.ocr.llmModel} onChange={(e) => set({ ocr: { ...draft.ocr, llmModel: e.target.value } })} placeholder="bv. qwen2.5:3b" /></Field>
          </div>
          <p className="small muted">De AI doet alleen voorstellen ("dit lijkt gereedschap"). De boeking zelf wordt altijd door vaste regels gemaakt.</p>
          </details>
        </>,
      )}
      {tab === 'backup' && <BackupSettings />}
      {tab === 'over' && <About />}
      {tab === 'geavanceerd' && section(
        <>
          <label className="row"><input type="checkbox" checked={draft.advancedMode} onChange={(e) => set({ advancedMode: e.target.checked })} /> Toon de boekhouding (grootboek, journaal, balans, exports)</label>
          <p className="small muted">Handig voor je boekhouder. Voor dagelijks gebruik heb je dit niet nodig.</p>
        </>,
      )}
    </div>
  );
}

function EmailSettings({ draft, set, section }: { draft: Settings; set: (p: Partial<AppSettings>) => void; section: (c: ReactNode) => ReactNode }) {
  const { run, busy } = useAction();
  const { reloadSettings } = useApp();
  const [pw, setPw] = useState('');
  return (
    <>
      {section(
        <>
          <p className="muted small">Facturen worden verstuurd via je eigen e-mailadres (SMTP). Je vindt deze gegevens bij je e-mailprovider.</p>
          <div className="grid cols-3">
            <Field label="Server"><input value={draft.smtp.host} onChange={(e) => set({ smtp: { ...draft.smtp, host: e.target.value } })} placeholder="smtp.jouwprovider.nl" /></Field>
            <Field label="Poort"><input className="num" type="number" value={draft.smtp.port} onChange={(e) => set({ smtp: { ...draft.smtp, port: Number(e.target.value) } })} /></Field>
            <Field label="Beveiliging"><select value={draft.smtp.secure ? 'ssl' : 'starttls'} onChange={(e) => set({ smtp: { ...draft.smtp, secure: e.target.value === 'ssl' } })}><option value="starttls">STARTTLS (587)</option><option value="ssl">SSL/TLS (465)</option></select></Field>
            <Field label="Gebruikersnaam"><input value={draft.smtp.user} onChange={(e) => set({ smtp: { ...draft.smtp, user: e.target.value } })} /></Field>
            <Field label="Afzendernaam"><input value={draft.smtp.fromName} onChange={(e) => set({ smtp: { ...draft.smtp, fromName: e.target.value } })} /></Field>
            <Field label="Afzenderadres"><input value={draft.smtp.fromEmail} onChange={(e) => set({ smtp: { ...draft.smtp, fromEmail: e.target.value } })} /></Field>
            <Field label="Kopie (BCC) naar" hint="optioneel"><input value={draft.smtp.bcc} onChange={(e) => set({ smtp: { ...draft.smtp, bcc: e.target.value } })} /></Field>
          </div>
        </>,
      )}
      <div className="card grid" style={{ marginTop: 14 }}>
        <Field label="Wachtwoord" hint={draft.smtpPasswordSet ? 'is ingesteld — veilig opgeslagen' : 'wordt versleuteld opgeslagen'}>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <div className="row">
          <Button disabled={busy || !pw} onClick={async () => { await run(() => api.settings.setSmtpPassword(pw), 'Wachtwoord opgeslagen'); setPw(''); await reloadSettings(); }}>Wachtwoord opslaan</Button>
          <Button disabled={busy} onClick={() => void run(() => api.settings.testSmtp(), 'Verbinding werkt ✓')}>Test verbinding</Button>
        </div>
      </div>
    </>
  );
}

function Integrations() {
  const { run, busy } = useAction();
  const list = useLoad(() => api.integrations.list());
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  return (
    <div className="grid">
      <p className="muted">Heb je een webshop of betaalprovider? Dan worden bestellingen automatisch facturen en kloppen uitbetalingen vanzelf met je bank.</p>
      <ErrorBox error={list.error} />
      {(list.data ?? []).map((s) => {
        const id = s.definition.id;
        const v = values[id] ?? {};
        return (
          <div key={id} className="card grid">
            <div className="row between">
              <div><h3>{s.definition.label}</h3><div className="muted small">{s.definition.description}</div></div>
              {s.enabled && <span className="pill good">actief</span>}
            </div>
            <div className="grid cols-2">
              {s.definition.fields.map((f) => (
                <Field key={f.key} label={f.label} hint={f.help}>
                  <input type={f.type === 'secret' ? 'password' : 'text'} placeholder={f.type === 'secret' && s.secretsSet[f.key] ? '•••••• (ingesteld)' : f.placeholder} value={v[f.key] ?? (f.type === 'secret' ? '' : s.config[f.key] ?? '')} onChange={(e) => setValues({ ...values, [id]: { ...v, [f.key]: e.target.value } })} />
                </Field>
              ))}
            </div>
            {s.lastError && <div className="notice bad small">{s.lastError}</div>}
            {s.lastSyncAt && <div className="small muted">Laatst bijgewerkt: <DateNl date={s.lastSyncAt.slice(0, 10)} /></div>}
            <div className="row">
              <Button kind="primary" disabled={busy} onClick={async () => { await run(() => api.integrations.configure(id, v, true), 'Opgeslagen'); await list.reload(); }}>{s.enabled ? 'Opslaan' : 'Koppelen'}</Button>
              {s.enabled && <Button disabled={busy} onClick={async () => { const r = await run(() => api.integrations.sync(id)); if (r) alert(`${r.created} verwerkt, ${r.skipped} overgeslagen${r.messages.length ? '\n\n' + r.messages.join('\n') : ''}`); await list.reload(); }}>Nu bijwerken</Button>}
              {s.enabled && <Button kind="danger" disabled={busy} onClick={async () => { await run(() => api.integrations.disconnect(id)); await list.reload(); }}>Ontkoppelen</Button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BackupSettings() {
  const { run, busy } = useAction();
  const version = useLoad(() => api.app.version());
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [restorePw, setRestorePw] = useState('');
  return (
    <div className="card grid">
      <p>Je administratie staat op deze computer. Er wordt elke dag automatisch een back-up gemaakt (de laatste 14 dagen). Maak af en toe ook een kopie op een USB-stick of in je eigen cloudmap.</p>
      <div className="row">
        <Button kind="primary" disabled={busy} onClick={() => void run(() => api.app.backup(), 'Back-up opgeslagen')}>Back-up maken</Button>
        <Button disabled={busy} onClick={() => void run(() => api.app.restore(restorePw || undefined))}>Back-up terugzetten…</Button>
        <input type="password" placeholder="wachtwoord (alleen bij versleutelde back-up)" value={restorePw} onChange={(e) => setRestorePw(e.target.value)} style={{ minWidth: 280 }} />
      </div>
      <h3>Versleutelde kopie voor je boekhouder</h3>
      <p className="small muted">Maakt een kopie van je hele administratie die alleen met het wachtwoord te openen is, in Gratis Boekhouden via "Back-up terugzetten". Geef het wachtwoord apart door (bijvoorbeeld telefonisch), niet in dezelfde mail.</p>
      <div className="row">
        <input type="password" placeholder="wachtwoord (min. 10 tekens)" value={pw} onChange={(e) => setPw(e.target.value)} />
        <input type="password" placeholder="herhaal wachtwoord" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        <Button disabled={busy || pw.length < 10 || pw !== pw2} onClick={async () => { const r = await run(() => api.app.exportEncrypted(pw), 'Versleutelde kopie opgeslagen'); if (r) { setPw(''); setPw2(''); } }}>Versleutelde kopie maken</Button>
      </div>
      <h3>Updates</h3>
      <div className="row">
        <span className="muted">Versie {version.data}</span>
        <Button disabled={busy} onClick={async () => { const r = await run(() => api.app.checkForUpdates()); if (r) alert(r); }}>Zoek naar updates</Button>
      </div>
    </div>
  );
}

/** Ingebouwde tekstherkenning (#9): één klik om te downloaden, daarna alles lokaal. */
function LocalOcr({ engine }: { engine: string }) {
  const { run, busy } = useAction();
  const { reloadSettings, toast } = useApp();
  const info = useLoad(() => api.localOcr.info());
  const status = useLoad(() => api.localOcr.status());
  const st = status.data;
  const downloading = st?.state === 'downloaden';
  // tijdens het downloaden de voortgang volgen; klaar = direct in gebruik nemen
  useEffect(() => {
    if (!downloading) return;
    // één ronde tegelijk: een trage status-aanroep mag niet overlappen met de volgende
    let busyTick = false;
    let finished = false;
    const t = setInterval(async () => {
      if (busyTick || finished) return;
      busyTick = true;
      try {
        const next = await api.localOcr.status();
        if (next.state === 'geinstalleerd') {
          finished = true;
          await api.localOcr.use();
          await reloadSettings();
          toast('Slimme herkenning is klaar ✓');
        }
        await status.reload();
      } finally {
        busyTick = false;
      }
    }, 1000);
    return () => {
      finished = true;
      clearInterval(t);
    };
  }, [downloading]);
  if (!st || !info.data) return null;
  const mb = (n: number) => `${Math.round(n / 1_000_000).toLocaleString('nl-NL')} MB`;
  const installed = st.state === 'geinstalleerd' || st.state === 'actief' || st.state === 'starten';
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <h3 style={{ marginTop: 0 }}>Slimme herkenning van bonnetjes</h3>
      {!installed && !downloading && (
        <>
          <p className="small">Lees foto's van bonnen automatisch uit. Eenmalig downloaden (± {mb(info.data.downloadSize)}); daarna werkt het zonder internet en blijven je documenten op deze computer.</p>
          <p className="small muted">{info.data.requirements}</p>
          {st.state === 'fout' && <div className="notice warn small">{st.error}</div>}
          <Button kind="primary" disabled={busy} onClick={async () => { await run(() => api.localOcr.install()); await status.reload(); }}>
            {st.state === 'fout' ? 'Opnieuw proberen' : 'Slimme herkenning installeren'}
          </Button>
        </>
      )}
      {downloading && (
        <>
          <p className="small">Bezig met downloaden{st.progress?.file ? ` (${st.progress.file})` : ''}… Je kunt gewoon doorwerken.</p>
          <progress max={st.progress?.total || 1} value={st.progress?.done ?? 0} style={{ width: '100%' }} />
          <p className="small muted">{st.progress ? `${mb(st.progress.done)} van ${mb(st.progress.total)}` : ''}</p>
        </>
      )}
      {installed && (
        <>
          <p className="small">✓ Geïnstalleerd ({info.data.model}{st.llamaVersion ? `, runtime ${st.llamaVersion}` : ''}). {engine === 'ingebouwd' ? 'In gebruik voor foto\'s van bonnen.' : 'Niet in gebruik: je gebruikt een eigen OCR-dienst.'}</p>
          <div className="row">
            {engine !== 'ingebouwd' && <Button small onClick={async () => { await run(() => api.localOcr.use()); await reloadSettings(); }}>Gebruiken</Button>}
            <Button small disabled={busy} onClick={async () => {
              if (!confirm('Slimme herkenning verwijderen? Foto\'s van bonnen vul je daarna weer zelf in.')) return;
              await run(() => api.localOcr.uninstall(), 'Verwijderd');
              await reloadSettings();
              await status.reload();
            }}>Verwijderen</Button>
          </div>
        </>
      )}
      <p className="small muted" style={{ marginTop: 8 }}>
        Model: {info.data.model} ({info.data.modelLicense}-licentie) · Runtime: {info.data.runtime} ({info.data.runtimeLicense}-licentie). Beide mogen vrij gebruikt en verspreid worden.
      </p>
    </div>
  );
}

function About() {
  const version = useLoad(() => api.app.version());
  const open = (url: string) => (e: { preventDefault(): void }) => {
    e.preventDefault();
    void api.app.openExternal(url);
  };
  return (
    <div className="card grid">
      <h3>Gratis Boekhouden {version.data}</h3>
      <p>Gratis en open source onder de {LICENSE_NAME}. Je mag de software gebruiken, bestuderen, aanpassen en delen onder de voorwaarden van die licentie.</p>
      <p>
        <a href="#" onClick={open(SOURCE_URL)}>Broncode</a> · <a href="#" onClick={open(TERMS_URL)}>Gebruiksvoorwaarden</a> · <a href="#" onClick={open(PRIVACY_URL)}>Privacyverklaring</a>
      </p>
      <p className="small muted">De software wordt geleverd zonder garantie. Jij blijft verantwoordelijk voor je administratie en aangiften.</p>
    </div>
  );
}
