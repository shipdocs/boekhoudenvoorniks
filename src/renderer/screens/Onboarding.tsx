import { useState, type ReactNode } from 'react';
import { api } from '../api';
import { Button, DropZone, Field, readAsText, useAction, useApp } from '../ui';
import { isValidIban, isValidKvk, isValidVatNumber } from '../../shared/validation';
import { TERMS_VERSION } from '../../shared/legal';
import { markSeen, pendingSteps } from '../../shared/onboarding';
import type { AppSettings } from '../../settings/settings';
import { TermsBlock } from './Terms';
import { startDateConsequences, startDateOptions } from '../../shared/switchover';
import { isIsoDate, today } from '../../shared/dates';
import { Logo } from '../Logo';

const AUTOPILOT: [AppSettings['autopilot'], string, string][] = [
  ['voorzichtig', 'Voorzichtig', 'Ik bevestig alles zelf. De app doet voorstellen, maar boekt niets zonder mij.'],
  ['normaal', 'Normaal (aangeraden)', 'Wat zeker is (een betaling met je factuurnummer erin) gaat vanzelf. De rest vraagt de app.'],
  ['maximaal', 'Maximaal', 'De app doet ook dingen zelf als hij bijna zeker is. Alles wat hij zelf deed, zie je terug met een knop "Klopt niet".'],
];

/**
 * Onboarding zonder boekhoudtermen: wat voor werk, alleen of niet, bedrijf, btw, bank, eerste factuur.
 * Alleen gegevens die echt nodig zijn (wettelijke factuureisen).
 *
 * De stappen komen uit shared/onboarding.ts. Een nieuwe gebruiker krijgt ze allemaal; wie de app al
 * gebruikt, krijgt na een update alleen de stappen die nieuw of gewijzigd zijn.
 */
export function Onboarding() {
  const { meta, settings, reloadSettings, reloadMeta, go, toast } = useApp();
  const { run, busy } = useAction();
  // vast bij binnenkomst: de lijst mag niet verspringen terwijl je invult
  const [steps] = useState(() => pendingSteps(settings));
  const update = settings.onboardingDone;
  const [index, setIndex] = useState(0);
  const [profile, setProfile] = useState(settings.profile);
  const [company, setCompany] = useState(settings.company);
  const [kor, setKor] = useState(settings.kor);
  const [vatPeriod, setVatPeriod] = useState(settings.vatPeriod);
  const [autopilot, setAutopilot] = useState(settings.autopilot);
  const [carUse, setCarUse] = useState(settings.carUse);
  const [startYear, setStartYear] = useState(settings.startYear ? String(settings.startYear) : '');
  const [startersUsed, setStartersUsed] = useState(settings.startersaftrekUsed.count);
  const [phonePct, setPhonePct] = useState<number | null>(settings.phoneInternetBusinessPct);
  const [workspace, setWorkspace] = useState(settings.homeWorkspace);
  const [partnerHours, setPartnerHours] = useState(settings.partnerHours ? String(settings.partnerHours) : '');
  const [lastNumber, setLastNumber] = useState('');
  // kostenposten van het beroep: standaard alles aangevinkt; opnieuw als je een ander beroep kiest
  const [costChoice, setCostChoice] = useState<{ trade: string; add: string[]; hide: string[] } | null>(null);
  const trade = meta.trades.find((t) => t.key === profile.trade);
  const has = (label: string) => meta.expenseCategories.some((c) => c.label.toLowerCase() === label.toLowerCase());
  const costs = costChoice?.trade === profile.trade
    ? costChoice
    : { trade: profile.trade, add: trade?.costs.map((c) => c.label).filter((l) => !has(l)) ?? [], hide: trade?.hide.filter((k) => meta.expenseCategories.some((c) => c.key === k)) ?? [] };
  const toggleCost = (list: 'add' | 'hide', value: string) =>
    setCostChoice({ ...costs, [list]: costs[list].includes(value) ? costs[list].filter((v) => v !== value) : [...costs[list], value] });
  const [terms, setTerms] = useState(settings.termsAcceptedVersion === TERMS_VERSION);
  const [switchMode, setSwitchMode] = useState(settings.switchover.mode);
  const [switchDate, setSwitchDate] = useState(settings.switchover.date ?? `${new Date().getFullYear()}-01-01`);
  const [otherDate, setOtherDate] = useState(false);
  // zelfde grenzen als de service: anders is de onboarding al opgeslagen als de overstap mislukt
  const validSwitchDate = isIsoDate(switchDate) && switchDate >= '2000-01-01' && switchDate <= today();
  const year = new Date().getFullYear();
  const ids = steps.map((s) => s.id);
  const shows = (id: string) => ids.includes(id);
  const step = steps[index];
  const isLast = index === steps.length - 1;

  const next = () => setIndex((i) => Math.min(steps.length - 1, i + 1));
  const prev = () => setIndex((i) => Math.max(0, i - 1));

  const overstap = shows('start') && switchMode === 'overstapper';
  const finish = async (then: 'factuur' | 'home' | 'overstap') => {
    const ok = await run(async () => {
      // alleen opslaan wat in de getoonde stappen stond: een update mag eerdere keuzes niet overschrijven
      const patch: Partial<AppSettings> = { profile, company, autopilot, onboardingDone: true, onboardingSteps: markSeen({ ...settings, company, kor }, ids) };
      if (shows('btw')) Object.assign(patch, { kor, vatPeriod, defaultVatCode: kor ? 'vrijgesteld' : 'hoog' });
      if (shows('bedrijf')) patch.smtp = { ...settings.smtp, fromName: company.name, fromEmail: settings.smtp.fromEmail || company.email };
      if (shows('nummering')) patch.termsAcceptedVersion = TERMS_VERSION;
      if (shows('thuis')) Object.assign(patch, { phoneInternetBusinessPct: phonePct, homeWorkspace: workspace, partnerHours: Number(partnerHours) || 0 });
      if (shows('fiscaal')) Object.assign(patch, { carUse, startYear: Number(startYear) || null, startersaftrekUsed: { count: startersUsed, asOfYear: year } });
      // vóór de instellingen: mislukt dit, dan is de onboarding nog niet klaar en probeer je opnieuw (dubbel toepassen kan geen kwaad)
      if (shows('kosten') && trade && (costs.add.length || costs.hide.length)) await api.categories.applyTrade(trade.key, { add: costs.add, hide: costs.hide });
      await api.settings.update(patch);
      if (shows('bank')) {
        const accounts = await api.bank.accounts();
        if (company.iban && accounts[0] && !accounts[0].iban) await api.bank.updateAccount(accounts[0].id, { iban: company.iban });
      }
      const n = Number(lastNumber.replace(/\D/g, '').slice(-4));
      if (lastNumber && Number.isInteger(n) && n > 0) await api.settings.setInvoiceCounter(year, n);
      // na de btw-keuze: de instapdatum markeert eerdere btw-periodes als al aangegeven
      if (shows('start') && switchMode) await api.switchover.setMode(switchMode, switchMode === 'overstapper' ? switchDate : null);
      return true;
    });
    if (!ok) return;
    await Promise.all([reloadSettings(), reloadMeta()]);
    go(then === 'factuur' ? { screen: 'factuur' } : then === 'overstap' ? { screen: 'overstap' } : { screen: 'home' });
  };

  const startDemo = async () => {
    const ok = await run(() => api.app.startDemo());
    if (ok) window.location.reload();
  };

  if (!step) {
    // niets (meer) te doen, bv. na "Later" en opnieuw openen
    return (
      <div className="page-narrow" style={{ paddingTop: 30 }}>
        <h1>Alles is ingesteld ✓</h1>
        <Button kind="primary" onClick={() => go({ screen: 'home' })}>Naar Vandaag</Button>
      </div>
    );
  }

  const companyErrors = [
    !company.name && 'bedrijfsnaam',
    !company.address && 'adres',
    !company.city && 'plaats',
    company.kvkNumber && !isValidKvk(company.kvkNumber) && 'KvK-nummer (8 cijfers)',
  ].filter(Boolean);

  const needsTerms = step.id === 'nummering';
  const footer = (canContinue = true, back: ReactNode = index > 0 ? <Button onClick={prev}>Terug</Button> : update ? <Button kind="ghost" onClick={() => go({ screen: 'home' })}>Later</Button> : <span />) => (
    <div className="row between" style={{ marginTop: 28 }}>
      {back}
      {isLast ? (
        overstap ? (
          <Button kind="primary" disabled={busy || !canContinue || (needsTerms && !terms)} onClick={() => void finish('overstap')}>Klaar, verder met overstappen</Button>
        ) : (
          <div className="row">
            <Button kind={update ? 'primary' : undefined} disabled={busy || !canContinue || (needsTerms && !terms)} onClick={() => void finish('home')}>Klaar</Button>
            {!update && <Button kind="primary" disabled={busy || !canContinue || (needsTerms && !terms)} onClick={() => void finish('factuur')}>Maak mijn eerste factuur</Button>}
          </div>
        )
      ) : (
        <Button kind="primary" disabled={!canContinue} onClick={next}>Verder</Button>
      )}
    </div>
  );

  return (
    <div className="page-narrow" style={{ paddingTop: 30 }}>
      {steps.length > 1 && <div className="steps">{steps.map((s, i) => <span key={s.id} className={i <= index ? 'on' : ''} />)}</div>}
      {update && step.whatsNew && <div className="notice">✨ {step.whatsNew}</div>}

      {step.id === 'welkom' && (
        <>
          <div style={{ marginBottom: 18 }}><Logo variant="gestapeld" width={200} /></div>
          <h1>Welkom 👋</h1>
          <p className="sub">We stellen je in een paar vragen in. Geen boekhoudkennis nodig.</p>
          <Field label="Hoe mogen we je noemen?">
            <input value={profile.firstName} onChange={(e) => setProfile({ ...profile, firstName: e.target.value })} placeholder="Voornaam" autoFocus />
          </Field>
          <h2>Wat voor werk doe je?</h2>
          <div className="chips">
            {meta.trades.map((t) => (
              <button key={t.key} className={profile.trade === t.key ? 'selected' : ''} onClick={() => setProfile({ ...profile, trade: t.key })}>{t.label}</button>
            ))}
          </div>
          {footer(!!profile.trade)}
          {!update && (
            <div className="card flat" style={{ marginTop: 28 }}>
              <strong>Eerst rustig rondkijken?</strong>
              <p className="small muted" style={{ margin: '4px 0 10px' }}>
                Bekijk de app met een voorbeeldbedrijf: klanten, facturen, bonnetjes en een bankafschrift. Er gaat niets naar buiten.
                Als je klaar bent, wis je de demo met één klik en begin je echt.
              </p>
              <Button disabled={busy} onClick={() => void startDemo()}>🧪 Bekijk de demo</Button>
            </div>
          )}
        </>
      )}

      {step.id === 'alleen' && (
        <>
          <h1>Werk je alleen?</h1>
          <p className="sub">Dan houden we het extra eenvoudig.</p>
          <div className="choice">
            <button className={profile.worksAlone ? 'selected' : ''} onClick={() => { setProfile({ ...profile, worksAlone: true }); if (!isLast) next(); }}>Ja, ik werk alleen</button>
            <button className={!profile.worksAlone ? 'selected' : ''} onClick={() => { setProfile({ ...profile, worksAlone: false }); if (!isLast) next(); }}>Nee, ik heb personeel of werk met anderen</button>
          </div>
          {footer()}
        </>
      )}

      {step.id === 'kosten' && (
        <>
          <h1>Waar geef je geld aan uit?</h1>
          <p className="sub">Dit zijn kosten die vaak voorkomen in jouw vak{trade && trade.key !== 'anders' ? ` (${trade.label})` : ''}. Vink uit wat je niet gebruikt; je kunt dit later altijd aanpassen bij Instellingen → Categorieën.</p>
          {trade && trade.costs.length > 0 && (
            <div>
              {trade.costs.map((c) => {
                const already = has(c.label);
                return (
                  <label key={c.label} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0' }}>
                    <input type="checkbox" disabled={already} checked={already || costs.add.includes(c.label)} onChange={() => toggleCost('add', c.label)} />
                    <span style={{ flex: 1 }}>
                      {c.label}{already && <span className="muted small"> (heb je al)</span>}
                      <div className="hint small muted">{c.hint}</div>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {trade && trade.hide.some((k) => meta.expenseCategories.some((c) => c.key === k)) && (
            <>
              <h2>Gebruik je deze niet? Dan verbergen we ze</h2>
              <div>
                {trade.hide.map((k) => meta.expenseCategories.find((c) => c.key === k)).filter((c) => !!c).map((c) => (
                  <label key={c.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0' }}>
                    <input type="checkbox" checked={costs.hide.includes(c.key)} onChange={() => toggleCost('hide', c.key)} />
                    <span style={{ flex: 1 }}>{c.label}<div className="hint small muted">verbergen kan altijd terug; eerdere boekingen blijven gewoon staan</div></span>
                  </label>
                ))}
              </div>
            </>
          )}
          <p className="small muted">Software, telefoon, reclame, verzekeringen en de andere vaste categorieën blijven er gewoon bij.</p>
          {footer()}
        </>
      )}

      {step.id === 'bedrijf' && (
        <>
          <h1>Je bedrijf</h1>
          <p className="sub">Dit komt op je facturen. Het is wettelijk verplicht.</p>
          <div className="grid">
            <Field label="Bedrijfsnaam"><input value={company.name} onChange={(e) => setCompany({ ...company, name: e.target.value })} autoFocus /></Field>
            <Field label="Straat en huisnummer"><input value={company.address} onChange={(e) => setCompany({ ...company, address: e.target.value })} /></Field>
            <div className="grid cols-2">
              <Field label="Postcode"><input value={company.postcode} onChange={(e) => setCompany({ ...company, postcode: e.target.value })} /></Field>
              <Field label="Plaats"><input value={company.city} onChange={(e) => setCompany({ ...company, city: e.target.value })} /></Field>
            </div>
            <div className="grid cols-2">
              <Field label="KvK-nummer"><input value={company.kvkNumber} onChange={(e) => setCompany({ ...company, kvkNumber: e.target.value })} /></Field>
              <Field label="E-mailadres"><input type="email" value={company.email} onChange={(e) => setCompany({ ...company, email: e.target.value })} /></Field>
            </div>
            <Field label="Telefoon" hint="optioneel"><input value={company.phone} onChange={(e) => setCompany({ ...company, phone: e.target.value })} /></Field>
          </div>
          {companyErrors.length > 0 && <p className="muted small">Nog nodig: {companyErrors.join(', ')}</p>}
          {footer(companyErrors.length === 0)}
        </>
      )}

      {step.id === 'btw' && (
        <>
          <h1>Reken je btw?</h1>
          <p className="sub">De meeste vakmensen wel. Twijfel je? Kijk op je brief van de Belastingdienst.</p>
          <div className="choice">
            <button className={!kor ? 'selected' : ''} onClick={() => setKor(false)}>
              Ja, ik reken btw
              <div className="hint">Je doet btw-aangifte (meestal per kwartaal). Wij rekenen het voor je uit.</div>
            </button>
            <button className={kor ? 'selected' : ''} onClick={() => setKor(true)}>
              Nee, ik gebruik de kleineondernemersregeling (KOR): ik heb me aangemeld omdat ik minder dan € 20.000 omzet heb
              <div className="hint">Je rekent geen btw en doet geen aangifte.</div>
            </button>
          </div>
          {!kor && (
            <div className="grid cols-2" style={{ marginTop: 18 }}>
              <Field label="Btw-identificatienummer" hint="staat op je brief van de Belastingdienst: begint met NL, eindigt op B01 of B02">
                <input value={company.vatNumber} onChange={(e) => setCompany({ ...company, vatNumber: e.target.value })} placeholder="NL123456789B01" />
              </Field>
              <Field label="Hoe vaak doe je aangifte?" hint="staat op je brief van de Belastingdienst of in Mijn Belastingdienst Zakelijk; weet je het niet, dan is het bijna altijd per kwartaal">
                <select value={vatPeriod} onChange={(e) => setVatPeriod(e.target.value as typeof vatPeriod)}>
                  <option value="kwartaal">Per kwartaal (meest gebruikelijk)</option>
                  <option value="maand">Per maand</option>
                  <option value="jaar">Per jaar</option>
                </select>
              </Field>
            </div>
          )}
          {footer(kor || isValidVatNumber(company.vatNumber || ''))}
        </>
      )}

      {step.id === 'bank' && (
        <>
          <h1>Heb je een zakelijke bankrekening?</h1>
          <p className="sub">Je rekeningnummer komt op je facturen, en via je bank zien we wie er betaald heeft.</p>
          <Field label="IBAN">
            <input value={company.iban} onChange={(e) => setCompany({ ...company, iban: e.target.value })} placeholder="NL00 BANK 0123 4567 89" />
          </Field>
          {company.iban && !isValidIban(company.iban) && <p className="small" style={{ color: 'var(--bad)' }}>Dit rekeningnummer klopt niet.</p>}
          <h2>Bankafschrift inlezen (mag ook later)</h2>
          <p className="muted small">Download een afschrift in je internetbankieren (bij "downloaden" of "exporteren"; kies CSV, MT940 of CAMT) en sleep het hierheen. Automatisch ophalen bij je bank komt later.</p>
          <DropZone
            accept=".csv,.txt,.sta,.940,.xml"
            onFile={async (file) => {
              const text = await readAsText(file);
              const r = await run(() => api.bank.importFile(file.name, text));
              if (r) toast(`${r.imported} betalingen ingelezen`);
            }}
          >
            📥 Sleep je bankafschrift hierheen of klik om te kiezen
          </DropZone>
          {footer(!company.iban || isValidIban(company.iban))}
        </>
      )}

      {step.id === 'start' && (
        <>
          <h1>Heb je al een administratie?</h1>
          <p className="sub">Bijvoorbeeld in een ander programma, in Excel of bij je boekhouder. Dan zetten we die erin, zodat alles doorloopt.</p>
          <div className="choice">
            <button className={switchMode === 'nieuw' ? 'selected' : ''} onClick={() => setSwitchMode('nieuw')}>
              Nee, ik begin net
              <div className="hint">Je begint met een schone lei.</div>
            </button>
            <button className={switchMode === 'overstapper' ? 'selected' : ''} onClick={() => setSwitchMode('overstapper')}>
              Ja, ik stap over
              <div className="hint">De app helpt je daarna stap voor stap: welke papieren je nodig hebt en wat je waar invult.</div>
            </button>
          </div>
          {switchMode === 'overstapper' && (
            <>
              <h2>Vanaf wanneer houdt de app je administratie bij?</h2>
              <div className="choice">
                {startDateOptions(today(), vatPeriod, kor).map((o) => (
                  <button key={o.key} className={!otherDate && switchDate === o.date ? 'selected' : ''} onClick={() => { setOtherDate(false); setSwitchDate(o.date); }}>
                    {o.label}{o.recommended ? ' (aangeraden)' : ''}
                    <div className="hint">{o.hint}</div>
                  </button>
                ))}
                <button className={otherDate ? 'selected' : ''} onClick={() => setOtherDate(true)}>
                  Een andere datum
                  <div className="hint">Bijvoorbeeld de dag dat je bij je vorige programma stopte.</div>
                </button>
              </div>
              {otherDate && (
                <Field label="Instapdatum">
                  <input type="date" value={switchDate} min="2000-01-01" max={today()} onChange={(e) => setSwitchDate(e.target.value)} />
                </Field>
              )}
              {validSwitchDate && (
                <div className="notice">
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {startDateConsequences(switchDate, vatPeriod, kor).map((c) => <li key={c}>{c}</li>)}
                  </ul>
                  <div className="small muted" style={{ marginTop: 6 }}>Je hoeft nu nog niets op te zoeken.</div>
                </div>
              )}
            </>
          )}
          {footer(switchMode === 'nieuw' || (switchMode === 'overstapper' && validSwitchDate))}
        </>
      )}

      {step.id === 'fiscaal' && (
        <>
          <h1>Auto en startjaar</h1>
          <p className="sub">Hiermee rekenen we je aftrek uit: kilometers, investeringen en de aftrek voor starters.</p>
          <h2>Waarmee rijd je zakelijk?</h2>
          <div className="choice">
            {([
              ['prive', 'Met mijn privéauto', 'Je mag € 0,25 per zakelijke kilometer aftrekken. Tanken en parkeren tellen dan als privé.'],
              ['zakelijk', 'Met een bus of auto van de zaak', 'Tanken, onderhoud en verzekering zijn kosten. De bus zelf telt de app verdeeld over een paar jaar als kosten.'],
              ['geen', 'Ik rijd niet zakelijk', ''],
            ] as const).map(([key, label, hint]) => (
              <button key={key} className={carUse === key ? 'selected' : ''} onClick={() => setCarUse(key)}>
                {label}
                {hint && <div className="hint">{hint}</div>}
              </button>
            ))}
          </div>
          <div className="grid cols-2" style={{ marginTop: 18 }}>
            <Field label="In welk jaar ben je gestart?">
              <input value={startYear} onChange={(e) => setStartYear(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder={String(year)} inputMode="numeric" />
            </Field>
            {Number(startYear) > 0 && year - Number(startYear) < 5 && (
              <Field label="Hoe vaak kreeg je al startersaftrek (extra aftrek voor nieuwe ondernemers)?" hint="vóór dit jaar; weet je het niet, kies 0">
                <select value={startersUsed} onChange={(e) => setStartersUsed(Number(e.target.value))}>
                  {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}×</option>)}
                </select>
              </Field>
            )}
          </div>
          {footer(carUse !== 'onbekend' && Number(startYear) > 1900 && Number(startYear) <= year)}
        </>
      )}

      {step.id === 'thuis' && (
        <>
          <h1>Telefoon, internet en werkplek</h1>
          <p className="sub">Veel vakmensen doen hun administratie thuis en bellen met één telefoon. Dan telt alleen het zakelijke deel.</p>
          <h2>Hoeveel gebruik je je telefoon en internet zakelijk?</h2>
          <div className="chips">
            {[[100, 'Alleen zakelijk'], [75, 'Vooral zakelijk (75%)'], [50, 'Half-half'], [25, 'Vooral privé (25%)']].map(([pct, label]) => (
              <button key={pct} className={phonePct === pct ? 'selected' : ''} onClick={() => setPhonePct(pct as number)}>{label}</button>
            ))}
          </div>
          <p className="small muted">Een redelijke schatting mag. Internet thuis telt alleen mee als je er voor je bedrijf extra voor betaalt (bv. een sneller abonnement).</p>
          <h2>Heb je een werkplek thuis?</h2>
          <div className="choice">
            {([
              ['geen', 'Nee', ''],
              ['thuis', 'Ja, een plek in huis', 'Bijvoorbeeld een bureau op zolder. De ruimte zelf is niet aftrekbaar; inrichting en apparaten wel.'],
              ['zelfstandig', 'Ja, met eigen ingang en eigen sanitair', 'Dan kan de ruimte zelf aftrekbaar zijn, als je er genoeg van je inkomen verdient.'],
            ] as const).map(([key, label, hint]) => (
              <button key={key} className={workspace === key ? 'selected' : ''} onClick={() => setWorkspace(key)}>
                {label}
                {hint && <div className="hint">{hint}</div>}
              </button>
            ))}
          </div>
          {!profile.worksAlone && (
            <Field label="Werkt je partner onbetaald mee? Hoeveel uur per jaar?" hint="vanaf 525 uur krijg je extra aftrek (meewerkaftrek)">
              <input value={partnerHours} onChange={(e) => setPartnerHours(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="0" inputMode="numeric" />
            </Field>
          )}
          {footer(phonePct !== null && workspace !== null)}
        </>
      )}

      {step.id === 'automatisch' && (
        <>
          <h1>Hoeveel mag de app zelf doen?</h1>
          <p className="sub">De app kan betalingen en bonnetjes voor je verwerken. Jij bepaalt hoe ver dat gaat; je kunt het later altijd aanpassen bij Instellingen.</p>
          <div className="choice">
            {AUTOPILOT.map(([key, label, hint]) => (
              <button key={key} className={autopilot === key ? 'selected' : ''} onClick={() => setAutopilot(key)}>
                {label}
                <div className="hint">{hint}</div>
              </button>
            ))}
          </div>
          {footer()}
        </>
      )}

      {step.id === 'nummering' && (
        <>
          <h1>Heb je al eerder gefactureerd?</h1>
          <p className="sub">Dan gaan we verder met je nummering, zodat je factuurnummers netjes doorlopen.</p>
          <Field label="Wat was je laatste factuurnummer dit jaar?" hint="leeg laten als dit je eerste is">
            <input value={lastNumber} onChange={(e) => setLastNumber(e.target.value)} placeholder={`bv. ${year}-0012`} />
          </Field>
          <h2>Afspraken</h2>
          <TermsBlock checked={terms} onChange={setTerms} />
          {footer()}
        </>
      )}
    </div>
  );
}
