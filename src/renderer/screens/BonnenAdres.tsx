import { useState } from 'react';
import { api } from '../api';
import { Button, ErrorBox, Field, useAction, useApp, useLoad } from '../ui';
import { BONNEN_CONSENT, PRIVACY_URL } from '../../shared/legal';

/**
 * Bonnen-adres op post.boekhoudenvoorniks.nl (#450): een eigen adres per administratie, alleen om bonnen en
 * facturen te ontvangen. Aanvragen → link in de mail bevestigen → wij keuren goed → de app haalt de mail op.
 * Niet zichtbaar buiten de app (null).
 */
export function BonnenAdres() {
  const { settings, toast } = useApp();
  const { run, busy } = useAction();
  const state = useLoad(() => api.bonnen.status());
  const [form, setForm] = useState(false);
  const [email, setEmail] = useState(settings.company.email);
  const [name, setName] = useState(settings.company.name);
  const [kvk, setKvk] = useState(settings.company.kvkNumber);
  const [agreed, setAgreed] = useState(false);
  const v = state.data;
  if (v === null) return null;
  if (!v) return <ErrorBox error={state.error} />;

  const refresh = async () => {
    const r = await run(() => api.bonnen.verversen());
    if (r) await state.reload();
  };
  const request = async () => {
    const r = await run(() => api.bonnen.aanvragen({ email, bedrijfsnaam: name, kvk, toestemming: v.toestemmingVersie }));
    if (r) {
      setForm(false);
      setAgreed(false);
      await state.reload();
    }
  };
  const stop = async (question: string) => {
    if (!confirm(question)) return;
    const r = await run(() => api.bonnen.stoppen(), 'Gestopt');
    if (r) await state.reload();
  };
  const supplierText = v.adres ? `Wilt u vanaf nu uw facturen sturen naar ${v.adres}? Graag als PDF-bijlage of e-factuur (UBL). Alvast bedankt!` : '';

  const requestForm = (
    <div className="grid">
      <div className="grid cols-3">
        <Field label="Jouw e-mailadres" hint="hier komt de bevestigingslink"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Bedrijfsnaam" hint="het begin komt in je adres"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="KvK-nummer" hint="mag leeg"><input value={kvk} onChange={(e) => setKvk(e.target.value)} /></Field>
      </div>
      <div className="small">
        <strong>Goed om te weten</strong>
        <ul>{BONNEN_CONSENT.map((t) => <li key={t}>{t}</li>)}</ul>
        Meer in de <a href="#" onClick={(e) => { e.preventDefault(); void api.app.openExternal(`${PRIVACY_URL}#bonnen-adres`); }}>privacyverklaring</a>.
      </div>
      <label className="row"><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> Ik ga hiermee akkoord</label>
      <div className="row">
        <Button kind="primary" disabled={busy || !agreed || !email || !name} onClick={() => void request()}>Bonnen-adres aanvragen</Button>
        {v.status !== 'geen' && <Button kind="ghost" disabled={busy} onClick={() => setForm(false)}>Annuleren</Button>}
      </div>
    </div>
  );

  const ended = v.status === 'geen' || v.status === 'geweigerd' || v.status === 'vervallen' || v.status === 'gestopt' || v.status === 'verwijderd' || v.status === 'ingetrokken';

  return (
    <div className="card grid" style={{ marginTop: 14 }}>
      <h3 style={{ margin: 0 }}>Bonnen-adres (gratis)</h3>
      <p className="small muted">
        Een eigen mailadres voor je bonnen en facturen, bijvoorbeeld <strong>bakkerijpi-k7m2q@post.boekhoudenvoorniks.nl</strong>. Laat leveranciers hun facturen daarheen sturen, of stuur een bon zelf door. De app haalt ze op en zet ze klaar bij Aankopen &amp; bonnetjes. Je hoeft niets in te stellen.
      </p>
      {!v.beschikbaar && <p className="small">{v.reden}</p>}

      {v.beschikbaar && v.status === 'onbevestigd' && !form && (
        <>
          <p>We stuurden een link naar <strong>{v.email}</strong>. Klik daarop en daarna op <strong>Bevestigen</strong>. Geen mail gezien? Kijk ook bij ongewenste mail.</p>
          <div className="row">
            <Button kind="primary" disabled={busy} onClick={() => void refresh()}>Ik heb bevestigd</Button>
            <Button disabled={busy} onClick={() => setForm(true)}>Ander e-mailadres</Button>
            <Button kind="ghost" disabled={busy} onClick={() => void stop('De aanvraag intrekken?')}>Aanvraag intrekken</Button>
          </div>
        </>
      )}
      {v.beschikbaar && v.status === 'overnemen' && (
        <>
          <p>We stuurden een link naar het e-mailadres waarmee je het bonnen-adres aanvroeg (<strong>{v.email}</strong>). Na bevestigen werkt het op deze computer, en niet meer op de vorige.</p>
          <div className="row"><Button kind="primary" disabled={busy} onClick={() => void refresh()}>Ik heb bevestigd</Button></div>
        </>
      )}
      {v.beschikbaar && v.status === 'wacht' && (
        <>
          <p>Je e-mailadres is bevestigd. We bekijken je aanvraag, meestal binnen een werkdag. Je krijgt een mail zodra je bonnen-adres klaar is; de app ziet het dan vanzelf.</p>
          <div className="row">
            <Button disabled={busy} onClick={() => void refresh()}>Opnieuw kijken</Button>
            <Button kind="ghost" disabled={busy} onClick={() => void stop('De aanvraag intrekken?')}>Aanvraag intrekken</Button>
          </div>
        </>
      )}
      {v.beschikbaar && v.status === 'actief' && v.adres && (
        <>
          <Field label="Je bonnen-adres">
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input className="grow" readOnly value={v.adres} onFocus={(e) => e.target.select()} />
              <Button onClick={() => void navigator.clipboard.writeText(v.adres!).then(() => toast('Gekopieerd'))}>Kopiëren</Button>
            </div>
          </Field>
          <Field label="Tekst voor je leveranciers" hint="kopieer en stuur door">
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input className="grow" readOnly value={supplierText} onFocus={(e) => e.target.select()} />
              <Button onClick={() => void navigator.clipboard.writeText(supplierText).then(() => toast('Gekopieerd'))}>Kopiëren</Button>
            </div>
          </Field>
          <p className="small muted">De app kijkt bij het opstarten en elk kwartier. Verwerkte mail gaat op de server naar de map "Verwerkt" en wordt na een jaar verwijderd; de bonnen zelf staan in je administratie.</p>
          <div className="row">
            <Button disabled={busy} onClick={async () => {
              const r = await run(() => api.mail.fetchNow());
              if (r) toast(`Mail opgehaald: ${r.documents} ${r.documents === 1 ? 'bonnetje' : 'bonnetjes'}`);
            }}>Nu ophalen</Button>
            <Button kind="danger" disabled={busy} onClick={() => void stop('Het bonnen-adres stoppen? Het adres ontvangt dan meteen niets meer en wordt na 30 dagen verwijderd. De bonnen die al in je administratie staan, blijven.')}>Stoppen</Button>
          </div>
        </>
      )}
      {v.beschikbaar && v.status === 'andere-computer' && !form && (
        <>
          <p>Dit bonnen-adres{v.adres ? <> (<strong>{v.adres}</strong>)</> : null} hoort bij een andere computer, bijvoorbeeld de computer waar je deze back-up maakte. Wil je het hier gebruiken? Dan sturen we een link naar het e-mailadres waarmee je het aanvroeg.</p>
          <div className="row"><Button kind="primary" disabled={busy} onClick={() => setForm(true)}>Hier gebruiken</Button></div>
        </>
      )}
      {v.beschikbaar && ended && !form && (
        <>
          {v.status === 'geweigerd' && <p>Je aanvraag is niet goedgekeurd. De Bonnenmap werkt gewoon. Vragen? Mail naar info@shipdocs.app.</p>}
          {v.status === 'vervallen' && <p>Je aanvraag is vervallen, omdat de link niet op tijd is bevestigd. Je kunt opnieuw aanvragen.</p>}
          {(v.status === 'gestopt' || v.status === 'verwijderd') && <p>Het bonnen-adres is gestopt. Vraag je opnieuw aan, dan krijg je een nieuw adres.</p>}
          {v.status === 'ingetrokken' && <p>Het bonnen-adres is op een andere computer in gebruik genomen, of daar gestopt. Op deze computer haalt de app er niets meer op.</p>}
          <div className="row"><Button kind="primary" disabled={busy} onClick={() => setForm(true)}>{v.status === 'geen' ? 'Bonnen-adres aanvragen' : 'Opnieuw aanvragen'}</Button></div>
        </>
      )}
      {v.beschikbaar && form && requestForm}
    </div>
  );
}
