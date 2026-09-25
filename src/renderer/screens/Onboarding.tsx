import { useState } from 'react';
import { api } from '../api';
import { Button, DropZone, Field, readAsText, useAction, useApp } from '../ui';
import { isValidIban, isValidKvk, isValidVatNumber } from '../../shared/validation';
import { TERMS_VERSION } from '../../shared/legal';
import { TermsBlock } from './Terms';

/**
 * Onboarding zonder boekhoudtermen: wat voor werk, alleen of niet, bedrijf, BTW, bank, eerste factuur.
 * Alleen gegevens die echt nodig zijn (wettelijke factuureisen).
 */
export function Onboarding() {
  const { meta, settings, reloadSettings, go, toast } = useApp();
  const { run, busy } = useAction();
  const [step, setStep] = useState(0);
  const [profile, setProfile] = useState(settings.profile);
  const [company, setCompany] = useState(settings.company);
  const [kor, setKor] = useState(settings.kor);
  const [vatPeriod, setVatPeriod] = useState(settings.vatPeriod);
  const [lastNumber, setLastNumber] = useState('');
  const [terms, setTerms] = useState(settings.termsAcceptedVersion === TERMS_VERSION);
  const steps = 6;
  const year = new Date().getFullYear();

  const next = () => setStep((s) => Math.min(steps - 1, s + 1));
  const prev = () => setStep((s) => Math.max(0, s - 1));

  const finish = async (then: 'factuur' | 'home') => {
    const ok = await run(async () => {
      await api.settings.update({ profile, company, kor, vatPeriod, defaultVatCode: kor ? 'vrijgesteld' : 'hoog', onboardingDone: true, termsAcceptedVersion: TERMS_VERSION, smtp: { ...settings.smtp, fromName: company.name, fromEmail: settings.smtp.fromEmail || company.email } });
      const accounts = await api.bank.accounts();
      if (company.iban && accounts[0] && !accounts[0].iban) await api.bank.updateAccount(accounts[0].id, { iban: company.iban });
      const n = Number(lastNumber.replace(/\D/g, '').slice(-4));
      if (lastNumber && Number.isInteger(n) && n > 0) await api.settings.setInvoiceCounter(year, n);
      return true;
    });
    if (!ok) return;
    await reloadSettings();
    go(then === 'factuur' ? { screen: 'factuur' } : { screen: 'home' });
  };

  const companyErrors = [
    !company.name && 'bedrijfsnaam',
    !company.address && 'adres',
    !company.city && 'plaats',
    company.kvkNumber && !isValidKvk(company.kvkNumber) && 'KvK-nummer (8 cijfers)',
  ].filter(Boolean);

  return (
    <div className="page-narrow" style={{ paddingTop: 30 }}>
      <div className="steps">{Array.from({ length: steps }, (_, i) => <span key={i} className={i <= step ? 'on' : ''} />)}</div>

      {step === 0 && (
        <>
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
          <div className="row end" style={{ marginTop: 28 }}><Button kind="primary" disabled={!profile.trade} onClick={next}>Verder</Button></div>
        </>
      )}

      {step === 1 && (
        <>
          <h1>Werk je alleen?</h1>
          <p className="sub">Dan houden we het extra eenvoudig.</p>
          <div className="choice">
            <button className={profile.worksAlone ? 'selected' : ''} onClick={() => { setProfile({ ...profile, worksAlone: true }); next(); }}>Ja, ik werk alleen</button>
            <button className={!profile.worksAlone ? 'selected' : ''} onClick={() => { setProfile({ ...profile, worksAlone: false }); next(); }}>Nee, ik heb personeel of werk met anderen</button>
          </div>
          <div className="row between" style={{ marginTop: 28 }}><Button onClick={prev}>Terug</Button></div>
        </>
      )}

      {step === 2 && (
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
          <div className="row between" style={{ marginTop: 28 }}>
            <Button onClick={prev}>Terug</Button>
            <Button kind="primary" disabled={companyErrors.length > 0} onClick={next}>Verder</Button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <h1>Reken je BTW?</h1>
          <p className="sub">De meeste vakmensen wel. Twijfel je? Kijk op je brief van de Belastingdienst.</p>
          <div className="choice">
            <button className={!kor ? 'selected' : ''} onClick={() => setKor(false)}>
              Ja, ik reken BTW
              <div className="hint">Je doet elk kwartaal BTW-aangifte. Wij rekenen het voor je uit.</div>
            </button>
            <button className={kor ? 'selected' : ''} onClick={() => setKor(true)}>
              Nee, ik gebruik de kleineondernemersregeling (KOR)
              <div className="hint">Je rekent geen BTW en doet geen aangifte.</div>
            </button>
          </div>
          {!kor && (
            <div className="grid cols-2" style={{ marginTop: 18 }}>
              <Field label="Btw-identificatienummer" hint="NL…B01">
                <input value={company.vatNumber} onChange={(e) => setCompany({ ...company, vatNumber: e.target.value })} placeholder="NL123456789B01" />
              </Field>
              <Field label="Hoe vaak doe je aangifte?">
                <select value={vatPeriod} onChange={(e) => setVatPeriod(e.target.value as typeof vatPeriod)}>
                  <option value="kwartaal">Per kwartaal (meest gebruikelijk)</option>
                  <option value="maand">Per maand</option>
                  <option value="jaar">Per jaar</option>
                </select>
              </Field>
            </div>
          )}
          <div className="row between" style={{ marginTop: 28 }}>
            <Button onClick={prev}>Terug</Button>
            <Button kind="primary" disabled={!kor && !isValidVatNumber(company.vatNumber || '')} onClick={next}>Verder</Button>
          </div>
        </>
      )}

      {step === 4 && (
        <>
          <h1>Heb je een zakelijke bankrekening?</h1>
          <p className="sub">Je rekeningnummer komt op je facturen, en via je bank zien we wie er betaald heeft.</p>
          <Field label="IBAN">
            <input value={company.iban} onChange={(e) => setCompany({ ...company, iban: e.target.value })} placeholder="NL00 BANK 0123 4567 89" />
          </Field>
          {company.iban && !isValidIban(company.iban) && <p className="small" style={{ color: 'var(--bad)' }}>Dit rekeningnummer klopt niet.</p>}
          <h2>Bank koppelen</h2>
          <p className="muted small">Download een afschrift bij je bank (CSV, MT940 of CAMT.053) en sleep het hierheen. Een directe koppeling met je bank komt later.</p>
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
          <div className="row between" style={{ marginTop: 28 }}>
            <Button onClick={prev}>Terug</Button>
            <Button kind="primary" disabled={!!company.iban && !isValidIban(company.iban)} onClick={next}>Verder</Button>
          </div>
        </>
      )}

      {step === 5 && (
        <>
          <h1>Heb je al eerder gefactureerd?</h1>
          <p className="sub">Dan gaan we verder met je nummering, zodat je factuurnummers netjes doorlopen.</p>
          <Field label="Wat was je laatste factuurnummer dit jaar?" hint="leeg laten als dit je eerste is">
            <input value={lastNumber} onChange={(e) => setLastNumber(e.target.value)} placeholder={`bv. ${year}-0012`} />
          </Field>
          <h2>Afspraken</h2>
          <TermsBlock checked={terms} onChange={setTerms} />
          <div className="row between" style={{ marginTop: 28 }}>
            <Button onClick={prev}>Terug</Button>
            <div className="row">
              <Button disabled={busy || !terms} onClick={() => void finish('home')}>Klaar</Button>
              <Button kind="primary" disabled={busy || !terms} onClick={() => void finish('factuur')}>Maak mijn eerste factuur</Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
