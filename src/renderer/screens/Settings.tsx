import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Button, DateNl, ErrorBox, Field, MoneyInput, useAction, useApp, useLoad, type Settings } from '../ui';
import type { AppSettings } from '../../settings/settings';
import { ResetCard } from './Reset';
import { CategoriesDialog } from './Categories';
import { LICENSE_NAME, PRIVACY_URL, SOURCE_URL, TERMS_URL } from '../../shared/legal';

type Tab = 'bedrijf' | 'facturen' | 'email' | 'btw' | 'categorieen' | 'koppelingen' | 'ai' | 'backup' | 'geavanceerd' | 'over';

const TABS: [Tab, string][] = [
  ['bedrijf', 'Je bedrijf'],
  ['facturen', 'Facturen & offertes'],
  ['email', 'E-mail'],
  ['btw', 'Btw'],
  ['categorieen', 'Categorieën'],
  ['koppelingen', 'Koppelingen'],
  ['ai', 'Automatisch & herkenning'],
  ['backup', 'Back-up, demo & updates'],
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
          <label className="row"><input type="checkbox" checked={draft.sendUbl} onChange={(e) => set({ sendUbl: e.target.checked })} /> Stuur ook een e-factuur mee: een bestand dat het boekhoudprogramma van je klant zelf kan inlezen (zonder overtypen)</label>
          <div className="grid cols-3">
            <Field label="Betaaltermijn (dagen)"><input className="num" type="number" value={draft.paymentTermDays} onChange={(e) => set({ paymentTermDays: Number(e.target.value) })} /></Field>
            <Field label="Offerte geldig (dagen)"><input className="num" type="number" value={draft.quoteValidityDays} onChange={(e) => set({ quoteValidityDays: Number(e.target.value) })} /></Field>
            <Field label="Factuurnummer" hint="bv. {JJJJ}-{NNNN} wordt 2026-0001"><input value={draft.invoiceNumberFormat} onChange={(e) => set({ invoiceNumberFormat: e.target.value })} /></Field>
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

      {tab === 'categorieen' && <CategoriesCard />}

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
              <Field label="Standaard btw op nieuwe regels">
                <select value={draft.defaultVatCode} onChange={(e) => set({ defaultVatCode: e.target.value as AppSettings['defaultVatCode'] })}>
                  <option value="hoog">21%</option><option value="laag">9%</option><option value="nul">0%</option><option value="verlegd">Btw verlegd (klant regelt de btw)</option>
                </select>
              </Field>
            </div>
          )}
          <h3>Inkomstenbelasting</h3>
          <label className="row"><input type="checkbox" checked={draft.incomeTaxEstimate} onChange={(e) => set({ incomeTaxEstimate: e.target.checked })} /> Toon een schatting van de inkomstenbelasting</label>
          {draft.incomeTaxEstimate && (
            <label className="row"><input type="checkbox" checked={draft.urencriterium} onChange={(e) => set({ urencriterium: e.target.checked })} /> Ik werk minstens 1.225 uur per jaar in mijn bedrijf (urencriterium, voor de zelfstandigenaftrek)</label>
          )}
          <Field label="Waarmee rijd je zakelijk?">
            <select value={draft.carUse} onChange={(e) => set({ carUse: e.target.value as AppSettings['carUse'] })}>
              <option value="onbekend">Nog niet opgegeven</option>
              <option value="prive">Mijn privéauto (aftrek per kilometer)</option>
              <option value="zakelijk">Een bus of auto van de zaak</option>
              <option value="geen">Ik rijd niet zakelijk</option>
            </select>
          </Field>
          {draft.carUse === 'prive' && <p className="small muted">Tanken en parkeren tellen dan als privé; je zakelijke kilometers vul je in bij Belasting → Aftrek → Kilometers.</p>}
          {draft.carUse === 'zakelijk' && (
            <div className="card" style={{ marginBottom: 12 }}>
              <Field label="Rijd je er ook privé mee?" hint="woon-werk telt voor de btw als zakelijk">
                <select value={draft.carPrivateUse === null ? '' : draft.carPrivateUse ? 'ja' : 'nee'} onChange={(e) => set({ carPrivateUse: e.target.value === '' ? null : e.target.value === 'ja' })}>
                  <option value="">Nog niet opgegeven</option>
                  <option value="ja">Ja, ik rijd er ook privé mee</option>
                  <option value="nee">Nee, alleen zakelijk (bijvoorbeeld een bestelbus)</option>
                </select>
              </Field>
              {draft.carPrivateUse && (
                <>
                  <div className="grid cols-2">
                    <Field label="Cataloguswaarde" hint="nieuwprijs incl. btw en bpm; staat bij de RDW of vraag je dealer">
                      <MoneyInput value={draft.carCatalogValue} onChange={(v) => set({ carCatalogValue: v })} />
                    </Field>
                    <Field label="Sinds wanneer gebruik je deze auto?" hint="voor je bedrijf; de maand is nodig voor het eerste jaar">
                      <div className="row">
                        <select value={draft.carInUseMonth ?? ''} onChange={(e) => set({ carInUseMonth: Number(e.target.value) || null })} aria-label="Maand">
                          <option value="">Maand</option>
                          {['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'].map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                        </select>
                        <input inputMode="numeric" value={draft.carInUseSince ?? ''} onChange={(e) => set({ carInUseSince: Number(e.target.value) || null })} placeholder={String(new Date().getFullYear())} aria-label="Jaar" />
                      </div>
                    </Field>
                  </div>
                  <p className="small muted">
                    Over privégebruik betaal je één keer per jaar btw, in je laatste aangifte van het jaar: 2,7% van de cataloguswaarde (vanaf het 5e jaar na ingebruikname 1,5%; in het eerste jaar naar rato). De app zet dat voor je klaar.
                    Daarnaast telt privégebruik mee voor de inkomstenbelasting (bijtelling). Dat rekent de app niet uit: vraag je boekhouder.
                  </p>
                </>
              )}
              {draft.carPrivateUse === false && <p className="small muted">Rijd je toch meer dan 500 km per jaar privé? Dan betaal je btw over dat privégebruik en telt het mee voor de inkomstenbelasting. Vraag je boekhouder.</p>}
            </div>
          )}
          <div className="grid cols-2">
            <Field label="In welk jaar ben je gestart?" hint="voor de startersaftrek">
              <input value={draft.startYear ?? ''} onChange={(e) => set({ startYear: e.target.value ? Number(e.target.value.replace(/\D/g, '').slice(0, 4)) || null : null })} placeholder="bv. 2024" inputMode="numeric" />
            </Field>
            {draft.startYear && new Date().getFullYear() - draft.startYear < 5 && (
              <Field label="Hoe vaak heb je de startersaftrek al gebruikt?" hint="vóór dit jaar">
                <select value={draft.startersaftrekUsed.count} onChange={(e) => set({ startersaftrekUsed: { count: Number(e.target.value), asOfYear: new Date().getFullYear() } })}>
                  {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}×</option>)}
                </select>
              </Field>
            )}
          </div>
          <div className="grid cols-2">
            <Field label="Zakelijk deel telefoon & internet" hint="het privédeel telt niet als kosten">
              <select value={draft.phoneInternetBusinessPct ?? 100} onChange={(e) => set({ phoneInternetBusinessPct: Number(e.target.value) })}>
                {[100, 90, 75, 50, 25, 0].map((p) => <option key={p} value={p}>{p}%</option>)}
              </select>
            </Field>
            <Field label="Werkplek thuis">
              <select value={draft.homeWorkspace ?? 'geen'} onChange={(e) => set({ homeWorkspace: e.target.value as AppSettings['homeWorkspace'] })}>
                <option value="geen">Geen</option>
                <option value="thuis">Een plek in huis</option>
                <option value="zelfstandig">Eigen ingang en sanitair</option>
              </select>
            </Field>
          </div>
          <Field label="Uren dat je partner onbetaald meewerkt, per jaar" hint="vanaf 525 uur krijg je extra aftrek (meewerkaftrek)">
            <input value={draft.partnerHours || ''} onChange={(e) => set({ partnerHours: Number(e.target.value.replace(/\D/g, '').slice(0, 4)) || 0 })} placeholder="0" inputMode="numeric" />
          </Field>
          <p className="muted small">Altijd een schatting: de app kent alleen de winst uit je bedrijf, niet je partner, hypotheek of ander inkomen.</p>
        </>,
      )}

      {tab === 'koppelingen' && <Integrations />}
      {tab === 'ai' && section(
        <>
          <Field label="Hoe automatisch?" hint="wat de app zelf mag afhandelen">
            <div className="chips">
              {([['voorzichtig', 'Voorzichtig: ik bevestig alles zelf'], ['normaal', 'Normaal'], ['maximaal', 'Maximaal: de app doet meer zelf']] as const).map(([k, l]) => (
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
          {settings.advancedMode && (
          <details style={{ marginTop: 12 }}>
            <summary className="small">Voor technische gebruikers: eigen herkenningsdienst of lokale AI</summary>
          <div className="grid cols-2">
            <Field label="Lokale tekstherkenning (OCR)" hint="adres van de OCR-dienst op deze computer"><input value={draft.ocr.url} onChange={(e) => set({ ocr: { ...draft.ocr, url: e.target.value } })} placeholder="http://127.0.0.1:8765" /></Field>
            <Field label="OCR-model"><select value={draft.ocr.engine} onChange={(e) => set({ ocr: { ...draft.ocr, engine: e.target.value } })}><option value="ingebouwd">Ingebouwd (GLM-OCR)</option><option value="glm-ocr">GLM-OCR</option><option value="paddleocr-vl">PaddleOCR-VL</option><option value="grm-ocr">GRM-OCR</option><option value="anders">Anders</option></select></Field>
            <Field label="Lokale AI voor herkennen van aankopen" hint="Ollama-adres, optioneel"><input value={draft.ocr.llmUrl} onChange={(e) => set({ ocr: { ...draft.ocr, llmUrl: e.target.value } })} placeholder="http://127.0.0.1:11434" /></Field>
            <Field label="AI-model"><input value={draft.ocr.llmModel} onChange={(e) => set({ ocr: { ...draft.ocr, llmModel: e.target.value } })} placeholder="bv. qwen2.5:3b" /></Field>
          </div>
          <p className="small muted">De AI doet alleen voorstellen ("dit lijkt gereedschap"). De boeking zelf wordt altijd door vaste regels gemaakt.</p>
          </details>
          )}
        </>,
      )}
      {tab === 'backup' && (
        <>
          <BackupSettings />
          <ResetCard />
        </>
      )}
      {tab === 'over' && <About />}
      {tab === 'geavanceerd' && section(
        <>
          <label className="row"><input type="checkbox" checked={draft.advancedMode} onChange={(e) => set({ advancedMode: e.target.checked })} /> Toon de boekhouding voor je boekhouder (grootboek, balans en exports)</label>
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
          <p className="muted small">Facturen worden verstuurd via je eigen e-mailadres. De gegevens (server en poort) vind je bij je e-mailprovider: zoek op "SMTP-instellingen".</p>
          <div className="grid cols-3">
            <Field label="Server"><input value={draft.smtp.host} onChange={(e) => set({ smtp: { ...draft.smtp, host: e.target.value } })} placeholder="smtp.jouwprovider.nl" /></Field>
            <Field label="Poort"><input className="num" type="number" value={draft.smtp.port} onChange={(e) => set({ smtp: { ...draft.smtp, port: Number(e.target.value) } })} /></Field>
            <Field label="Beveiliging" hint="neem over wat je provider zegt; meestal 587"><select value={draft.smtp.secure ? 'ssl' : 'starttls'} onChange={(e) => {
              const secure = e.target.value === 'ssl';
              // standaardpoort meeschuiven, maar een zelf ingevulde poort laten staan
              const port = draft.smtp.port === (secure ? 587 : 465) ? (secure ? 465 : 587) : draft.smtp.port;
              set({ smtp: { ...draft.smtp, secure, port } });
            }}><option value="starttls">STARTTLS (587)</option><option value="ssl">SSL/TLS (465)</option></select></Field>
            <Field label="Gebruikersnaam"><input value={draft.smtp.user} onChange={(e) => set({ smtp: { ...draft.smtp, user: e.target.value } })} /></Field>
            <Field label="Afzendernaam"><input value={draft.smtp.fromName} onChange={(e) => set({ smtp: { ...draft.smtp, fromName: e.target.value } })} /></Field>
            <Field label="Afzenderadres"><input value={draft.smtp.fromEmail} onChange={(e) => set({ smtp: { ...draft.smtp, fromEmail: e.target.value } })} /></Field>
            <Field label="Stuur mij een stille kopie op" hint="optioneel, e-mailadres"><input value={draft.smtp.bcc} onChange={(e) => set({ smtp: { ...draft.smtp, bcc: e.target.value } })} /></Field>
            <Field label="Antwoorden gaan naar" hint="optioneel: als een klant op je factuur antwoordt, komt dat hier binnen"><input value={draft.smtp.replyTo} placeholder="bv. je gewone mailadres" onChange={(e) => set({ smtp: { ...draft.smtp, replyTo: e.target.value } })} /></Field>
          </div>
          {(() => {
            // tikfout in het afzenderadres (bv. .ap i.p.v. .app) valt op als het domein afwijkt van de gebruikersnaam
            const domain = (s: string) => (s.includes('@') ? s.split('@').pop()!.trim().toLowerCase() : '');
            const from = domain(draft.smtp.fromEmail);
            const user = domain(draft.smtp.user);
            return from && user && from !== user ? (
              <div className="notice warn small">Het afzenderadres eindigt op <strong>@{from}</strong>, je gebruikersnaam op <strong>@{user}</strong>. Klopt dat? Een tikfout in het afzenderadres zorgt dat klanten niet kunnen antwoorden, of dat je mail als spam wordt gezien.</div>
            ) : null;
          })()}
        </>,
      )}
      <div className="card grid" style={{ marginTop: 14 }}>
        <Field label="Wachtwoord" hint={draft.smtpPasswordSet ? 'is ingesteld — veilig opgeslagen' : 'wordt versleuteld opgeslagen'}>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <div className="row">
          <Button disabled={busy || !pw} onClick={async () => { await run(() => api.settings.setSmtpPassword(pw), 'Wachtwoord opgeslagen'); setPw(''); await reloadSettings(); }}>Wachtwoord opslaan</Button>
          <Button disabled={busy} onClick={async () => {
            // test met wat er nu is ingevuld; een ingetypt wachtwoord wordt na een geslaagde test meteen bewaard
            const ok = await run(async () => { await api.settings.testSmtp(draft.smtp, pw || undefined); return true; }, pw ? 'Verbinding werkt ✓ en het wachtwoord is opgeslagen' : 'Verbinding werkt ✓');
            if (ok && pw) { await api.settings.setSmtpPassword(pw); setPw(''); await reloadSettings(); }
          }}>Test verbinding</Button>
        </div>
      </div>
      <IncomingMail />
    </>
  );
}

const OUTCOME_LABEL: Record<string, string> = {
  bijlage: 'bonnetje/factuur opgehaald',
  'online-factuur': 'factuur staat online',
  klant: 'van een klant (niet aangeraakt)',
  eigen: 'van jezelf',
  overig: 'niets mee gedaan',
  fout: 'kon niet gelezen worden',
};

/**
 * Inkomende post: een apart mailadres voor de administratie. Eigen opslaan-knop, los van de
 * uitgaande mail erboven.
 */
function IncomingMail() {
  const { settings, reloadSettings, toast } = useApp();
  const { run, busy } = useAction();
  const status = useLoad(() => api.mail.summary());
  const [cfg, setCfg] = useState(settings.mailIn);
  const [pw, setPw] = useState('');
  const [folders, setFolders] = useState<string[] | null>(null);
  const change = (patch: Partial<typeof cfg>) => setCfg({ ...cfg, ...patch });
  const dirty = JSON.stringify(cfg) !== JSON.stringify(settings.mailIn);
  const save = async (next = cfg) => {
    // eerste keer aanzetten: alleen mail van de laatste 30 dagen, geen jaren archief
    const since = next.since || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const ok = await run(async () => {
      await api.settings.update({ mailIn: { ...next, since } });
      if (pw) await api.mail.setPassword(pw);
      return true;
    }, 'Opgeslagen');
    if (ok) {
      setCfg({ ...next, since });
      setPw('');
      await reloadSettings();
      await status.reload();
    }
  };
  const address = cfg.user.includes('@') ? cfg.user : 'administratie@jouwbedrijf.nl';
  const supplierText = `Wilt u vanaf nu uw facturen sturen naar ${address}? Graag als PDF-bijlage of e-factuur (UBL). Alvast bedankt!`;

  return (
    <div className="card grid" style={{ marginTop: 14 }}>
      <h3 style={{ margin: 0 }}>Inkomende post (bonnetjes per mail)</h3>
      <p className="small muted">
        Maak een apart mailadres voor je administratie, bijvoorbeeld <strong>administratie@jouwbedrijf.nl</strong>, en vraag leveranciers hun facturen daarheen te sturen.
        De app haalt de bijlagen eruit (bij het opstarten en elk kwartier) en zet ze klaar om te controleren.
      </p>
      <details>
        <summary className="small">Wat gebeurt er met de mail?</summary>
        <ul className="small">
          <li><strong>Met een factuur of bon als bijlage</strong> (PDF, foto of e-factuur): komt bij Aankopen &amp; bonnetjes, wacht op jouw controle. Er wordt niets vanzelf geboekt. De mail gaat naar de map "{cfg.processedFolder || 'Verwerkt'}".</li>
          <li><strong>"Je factuur staat online"</strong> zonder bijlage: een taak op Vandaag om hem te downloaden.</li>
          <li><strong>Van een klant</strong>: blijft ongelezen en onaangeroerd in je mailbox; je krijgt een seintje op Vandaag.</li>
          <li><strong>Andere mail</strong>: blijft gewoon staan.</li>
          <li>Er wordt <strong>nooit mail verwijderd</strong>, en gelezen of gearchiveerde mail wordt niet dubbel verwerkt: de app onthoudt welke berichten hij al zag.</li>
        </ul>
      </details>
      <label className="row"><input type="checkbox" checked={cfg.enabled} onChange={(e) => change({ enabled: e.target.checked })} /> Bonnetjes en facturen uit deze mailbox ophalen</label>
      <div className="grid cols-3">
        <Field label="Server" hint="zoek bij je provider op 'IMAP-instellingen'"><input value={cfg.host} placeholder="imap.jouwprovider.nl" onChange={(e) => change({ host: e.target.value.trim() })} /></Field>
        <Field label="Poort"><input className="num" type="number" value={cfg.port} onChange={(e) => change({ port: Number(e.target.value) })} /></Field>
        <Field label="Beveiliging"><select value={cfg.secure ? 'ssl' : 'starttls'} onChange={(e) => {
          const secure = e.target.value === 'ssl';
          change({ secure, port: cfg.port === (secure ? 143 : 993) ? (secure ? 993 : 143) : cfg.port });
        }}><option value="ssl">SSL/TLS (993)</option><option value="starttls">STARTTLS (143)</option></select></Field>
        <Field label="Gebruikersnaam" hint="meestal het mailadres"><input value={cfg.user} onChange={(e) => change({ user: e.target.value.trim() })} /></Field>
        <Field label="Wachtwoord" hint={status.data?.passwordSet ? 'is ingesteld — veilig opgeslagen' : 'wordt versleuteld opgeslagen'}><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
        <Field label="Verwerkte mail naar map" hint="leeg = laten staan"><input value={cfg.processedFolder} onChange={(e) => change({ processedFolder: e.target.value })} /></Field>
      </div>
      <Field label="Ook doorzoeken" hint="bv. je archiefmap, voor mail die je al had opgeruimd; daar wordt nooit iets verplaatst">
        {folders ? (
          <div className="chips">
            {folders.filter((f) => f !== cfg.folder && f !== cfg.processedFolder).map((f) => {
              const on = cfg.extraFolders.includes(f);
              return <button key={f} className={on ? 'selected' : ''} onClick={() => change({ extraFolders: on ? cfg.extraFolders.filter((x) => x !== f) : [...cfg.extraFolders, f] })}>{f}</button>;
            })}
          </div>
        ) : (
          <span className="small muted">{cfg.extraFolders.length ? cfg.extraFolders.join(', ') : 'Klik op "Test verbinding" om je mappen te zien.'}</span>
        )}
      </Field>
      <Field label="Mail vanaf" hint="oudere mail wordt overgeslagen"><input type="date" value={cfg.since} onChange={(e) => change({ since: e.target.value })} style={{ maxWidth: 200 }} /></Field>
      <div className="row">
        <Button kind="primary" disabled={busy || (!dirty && !pw)} onClick={() => void save()}>Opslaan</Button>
        <Button disabled={busy || !cfg.host || !cfg.user} onClick={async () => {
          const r = await run(() => api.mail.test(cfg, pw || undefined), pw ? 'Verbinding werkt ✓ en het wachtwoord is opgeslagen' : 'Verbinding werkt ✓');
          if (r) { setFolders(r.folders); setPw(''); await status.reload(); }
        }}>Test verbinding</Button>
        <Button disabled={busy || dirty || !settings.mailIn.enabled} title={dirty ? 'Eerst opslaan' : undefined} onClick={async () => {
          const r = await run(() => api.mail.fetchNow());
          if (r) {
            const parts = [`${r.documents} ${r.documents === 1 ? 'bonnetje' : 'bonnetjes'}`, r.onlineInvoices && `${r.onlineInvoices} online`, r.fromCustomers && `${r.fromCustomers} van klanten`, r.errors && `${r.errors} niet te lezen`].filter(Boolean);
            toast(`Mail opgehaald: ${parts.join(', ')}${r.missingFolders.length ? `. Map niet gevonden: ${r.missingFolders.join(', ')}` : ''}`);
            await status.reload();
          }
        }}>Nu ophalen</Button>
      </div>
      {status.data?.lastChecked && (
        <div className="small muted">
          Laatst gekeken: {status.data.lastChecked.replace('T', ' ').slice(0, 16)} · {status.data.counts.bijlage} opgehaald · {status.data.counts['online-factuur']} online · {status.data.counts.klant} van klanten · {status.data.counts.overig + status.data.counts.eigen} overige
        </div>
      )}
      {status.data && status.data.recent.length > 0 && (
        <details>
          <summary className="small">Laatste berichten</summary>
          <table className="list small">
            <tbody>
              {status.data.recent.map((m) => (
                <tr key={m.id}><td><DateNl date={m.received_on} /></td><td>{m.from_name || m.from_address}</td><td>{m.subject}</td><td className="muted">{OUTCOME_LABEL[m.outcome]}{m.note ? `: ${m.note}` : ''}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <Field label="Tekst voor je leveranciers" hint="kopieer en stuur door">
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input className="grow" readOnly value={supplierText} onFocus={(e) => e.target.select()} />
          <Button onClick={() => void navigator.clipboard.writeText(supplierText).then(() => toast('Gekopieerd'))}>Kopiëren</Button>
        </div>
      </Field>
    </div>
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

/** Instellingen → Categorieën: dezelfde lijst als achter "Aanpassen" bij het boeken. */
function CategoriesCard() {
  const [open, setOpen] = useState(false);
  return (
    <div className="card grid">
      <p>
        Bij een betaling of bon kies je waar het voor was, bijvoorbeeld Materiaal of Telefoon &amp; internet. Mist er iets, of heet het bij jou anders?
        Voeg een eigen categorie toe of pas de naam, uitleg en btw aan. Categorieën die je niet gebruikt kun je verbergen.
      </p>
      <p className="small muted">Veilig: er wordt nooit iets verwijderd en eerdere boekingen veranderen niet mee.</p>
      <div className="row end"><Button kind="primary" onClick={() => setOpen(true)}>Categorieën bekijken en aanpassen</Button></div>
      {open && <CategoriesDialog onClose={() => setOpen(false)} />}
    </div>
  );
}
