import { useState } from 'react';
import { api } from '../api';
import { Button, DateNl, DropZone, Empty, ErrorBox, Euro, Field, Modal, MoneyInput, StatusPill, readAsBytes, useAction, useApp, useLoad, type InvestmentSavedInfo } from '../ui';
import { today } from '../../shared/dates';
import type { PurchaseVatCode } from '../../shared/vat';
import { mightBeInvestment, netAmount } from '../../shared/investment';
import { CURRENCY_NAMES, formatForeign } from '../../shared/currency';
import { formatDateNl } from '../../shared/dates';
import type { FxCandidate } from '../../fx/repair';
import { CategoryChips } from './Categories';

export function Purchases({ pay: payInitial }: { pay?: number } = {}) {
  const { go, toast } = useApp();
  const { run } = useAction();
  const docs = useLoad(() => api.documents.list('controle'));
  const purchases = useLoad(() => api.purchases.list());
  const [manual, setManual] = useState(false);
  const [pay, setPay] = useState<number | null>(payInitial ?? null);
  const [uploading, setUploading] = useState(0);
  // vreemde valuta (#74): een aankoop omrekenen (uit de lijst van de app, of met de hand)
  const [fx, setFx] = useState<{ id: number; fromDocument: boolean } | null>(null);
  const foreign = useLoad(() => api.valuta.candidates());

  const upload = async (file: File) => {
    setUploading((n) => n + 1);
    const bytes = await readAsBytes(file);
    const d = await run(() => api.documents.add(file.name, bytes));
    setUploading((n) => n - 1);
    if (!d) return;
    if (d.status === 'verwerkt') toast(`${d.result?.supplier?.value ?? file.name} ✓ automatisch verwerkt`);
    else if (d.status === 'genegeerd') toast('Dit document hadden we al');
    await docs.reload();
    await purchases.reload();
  };

  return (
    <div className="page">
      <div className="row between">
        <div>
          <h1>Aankopen & bonnetjes</h1>
          <p className="sub">Foto of PDF erin, wij doen de rest. We vragen alleen iets als we het niet zeker weten.</p>
        </div>
        <Button onClick={() => setManual(true)}>Bonnetje zonder foto</Button>
      </div>

      <DropZone accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.xml" multiple onFile={(f) => void upload(f)}>
        <div style={{ fontSize: 34 }}>📸</div>
        <strong>Sleep bonnetjes of facturen hierheen</strong>
        <div className="small">Foto, PDF of e-factuur (XML) — of klik om te kiezen</div>
        {uploading > 0 && <div className="small" style={{ marginTop: 8 }}>Bezig met lezen… ({uploading})</div>}
      </DropZone>

      {(docs.data ?? []).length > 0 && (
        <>
          <h2>Even controleren</h2>
          <div className="card" style={{ padding: 0 }}>
            {docs.data!.map((d) => (
              <div className="task" key={d.id}>
                <div className="icon">📷</div>
                <div className="grow">
                  <div className="title">{d.result?.supplier?.value ?? d.original_name} {d.result?.total && <Euro cents={d.result.total.value} />}</div>
                  <div className="q">{d.issues.find((i) => i.severity === 'fout')?.message ?? 'Klopt alles?'}</div>
                </div>
                <Button kind="primary" small onClick={() => go({ screen: 'document', id: d.id })}>Bekijken</Button>
              </div>
            ))}
          </div>
        </>
      )}

      {foreign.data && (foreign.data.purchases.length > 0 || foreign.data.documents > 0) && (
        <ForeignRepair
          data={foreign.data}
          onOpen={(id) => setFx({ id, fromDocument: true })}
          onDone={async () => { await foreign.reload(); await docs.reload(); await purchases.reload(); }}
        />
      )}

      <h2>Aankopen</h2>
      {(purchases.data ?? []).length === 0 ? (
        <Empty icon="🧾" title="Nog geen aankopen">Bonnetjes die je hier toevoegt worden automatisch verwerkt, inclusief btw die je terugkrijgt.</Empty>
      ) : (
        <table className="list">
          <thead><tr><th>Datum</th><th>Waar</th><th>Wat</th><th>Status</th><th className="num">Btw terug</th><th className="num">Bedrag</th><th><span className="sr-only">Acties</span></th></tr></thead>
          <tbody>
            {purchases.data!.map((p) => (
              <tr key={p.id} className={p.attachment_path ? 'clickable' : ''} onClick={() => p.attachment_path && void run(() => api.app.openAttachment(p.attachment_path!))}>
                <td><DateNl date={p.invoice_date} /></td>
                <td>{p.relation_name ?? '—'}</td>
                <td>
                  {p.description} {p.attachment_path && <span title="Bewijsstuk aanwezig">📎</span>}
                  {p.warranty_months ? <div className="small muted">🛡️ {warrantyText(p.invoice_date, p.warranty_months)}</div> : null}
                </td>
                <td><StatusPill status={p.status} /></td>
                <td className="num"><Euro cents={p.vat_total} /></td>
                <td className="num"><Euro cents={p.total} />{p.currency && p.foreign_total !== null && <div className="small muted">{formatForeign(p.foreign_total, p.currency)}</div>}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <span className="row">
                    {p.status === 'open' && p.open_amount > 0 && <Button small onClick={() => setPay(p.id)}>Betaal</Button>}
                    {!p.currency && <Button small kind="ghost" title="Was deze bon in dollars of een andere munt? Dan reken je hem hier om naar euro's." ariaLabel="Omrekenen uit een andere munt" onClick={() => setFx({ id: p.id, fromDocument: false })}>💱</Button>}
                    <Button small kind="ghost" title="Garantie: hoeveel maanden? (dan weet je later of je nog garantie hebt)" ariaLabel="Garantie vastleggen" onClick={async () => {
                      const v = prompt('Hoeveel maanden garantie? (leeg = geen)', p.warranty_months ? String(p.warranty_months) : '24');
                      if (v === null) return;
                      const months = v.trim() ? Number(v.trim().replace(',', '.')) : null;
                      if (months !== null && !Number.isFinite(months)) return toast('Vul een aantal maanden in, bv. 24', 'error');
                      await run(() => api.search.setWarranty(p.id, months));
                      await purchases.reload();
                    }}>🛡️</Button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {manual && <ManualExpense onClose={() => setManual(false)} onDone={async () => { setManual(false); await purchases.reload(); }} />}
      {pay !== null && <PayModal id={pay} onClose={() => setPay(null)} />}
      {fx && <ForeignModal purchaseId={fx.id} fromDocument={fx.fromDocument} onClose={() => setFx(null)} onDone={async () => { setFx(null); await foreign.reload(); await purchases.reload(); }} />}
    </div>
  );
}

/**
 * Vreemde valuta in wat er al stond (#74): oudere versies lazen "$ 90,00" als € 90,00. Hier zie je
 * welke aankopen dat zijn, en reken je ze om (één voor één, of alles in één keer).
 */
function ForeignRepair({ data, onOpen, onDone }: { data: { purchases: FxCandidate[]; documents: number }; onOpen: (id: number) => void; onDone: () => Promise<void> }) {
  const { toast } = useApp();
  const { run, busy } = useAction();
  const n = data.purchases.length;
  return (
    <div className="notice warn" role="note" style={{ marginTop: 16 }}>
      <strong>{n + data.documents === 1 ? 'Een bon in dollars (of een andere munt) staat als euro\'s in je boekhouding' : `${n + data.documents} bonnen in dollars (of een andere munt) staan als euro's in je boekhouding`}</strong>
      <div className="small" style={{ marginTop: 4 }}>
        Een oudere versie van de app las bv. "$ 90,00" als € 90,00. De app rekent ze om naar wat er echt van je rekening is afgeschreven, en koppelt de betaling. Staat de betaling al als kosten geboekt, dan was de aankoop dubbel: die haalt de app weg en de bon komt bij de betaling.
      </div>
      {n > 0 && (
        <table className="list" style={{ marginTop: 8 }}>
          <tbody>
            {data.purchases.map((c) => (
              <tr key={c.purchaseId}>
                <td><DateNl date={c.date} /></td>
                <td>{c.supplier ?? c.description}</td>
                <td className="num">{formatForeign(c.foreignTotal, c.currency)} op de bon</td>
                <td className="num">geboekt als <Euro cents={c.bookedTotal} /></td>
                <td><Button small onClick={() => onOpen(c.purchaseId)}>Nakijken</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.documents > 0 && <div className="small" style={{ marginTop: 8 }}>{data.documents === 1 ? 'Eén bon die je nog moet controleren wordt' : `${data.documents} bonnen die je nog moet controleren worden`} ook omgerekend. Daarna controleer je ze zoals altijd.</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <Button kind="primary" small disabled={busy} onClick={async () => {
          const r = await run(() => api.valuta.fixAll());
          if (!r) return;
          const done = [r.purchases > 0 && `${r.purchases} omgerekend`, r.duplicates > 0 && `${r.duplicates} dubbele weggehaald`, r.documents > 0 && `${r.documents} ${r.documents === 1 ? 'bon' : 'bonnen'} opnieuw gelezen`].filter(Boolean).join(', ');
          if (done) toast(`${done} ✓`);
          if (r.open.length > 0) toast(`${r.open.length} ${r.open.length === 1 ? 'kon' : 'konden'} niet vanzelf: ${r.open[0]!.reason}`, 'error');
          await onDone();
        }}>Alles omrekenen</Button>
      </div>
    </div>
  );
}

/** Eén aankoop omrekenen: wat er stond, wat het wordt en waarom; het bedrag in euro's kun je aanpassen. */
function ForeignModal({ purchaseId, fromDocument, onClose, onDone }: { purchaseId: number; fromDocument: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const { run, busy } = useAction();
  const [currency, setCurrency] = useState('USD');
  const [foreignTotal, setForeignTotal] = useState<number | null>(null);
  const [asked, setAsked] = useState<{ currency: string; foreignTotal: number } | null>(null);
  const [euro, setEuro] = useState<number | null>(null);
  const preview = useLoad(async () => {
    if (!fromDocument && !asked) return null;
    const p = await api.valuta.preview(purchaseId, fromDocument ? undefined : asked!);
    setEuro(p.euroTotal);
    return p;
  }, [purchaseId, asked]);
  const p = preview.data;
  const name = (c: string) => CURRENCY_NAMES[c]?.name ?? c;
  return (
    <Modal title="Omrekenen naar euro's" onClose={onClose}>
      <div className="grid">
        {!fromDocument && (
          <>
            <p className="small">Was deze aankoop in dollars of een andere munt? Vul in wat er op de bon staat; de app zoekt de betaling op je rekening.</p>
            <div className="grid cols-2">
              <Field label="Munt op de bon">
                <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                  {Object.entries(CURRENCY_NAMES).filter(([c]) => c !== 'EUR').map(([c, v]) => <option key={c} value={c}>{v.symbol} — {v.name}</option>)}
                </select>
              </Field>
              <Field label="Bedrag op de bon"><MoneyInput value={foreignTotal} onChange={setForeignTotal} /></Field>
            </div>
            <div className="row"><Button disabled={!foreignTotal} onClick={() => setAsked({ currency, foreignTotal: foreignTotal! })}>Bereken</Button></div>
          </>
        )}
        <ErrorBox error={preview.error} />
        {p && (
          <>
            <p>
              <strong>{p.supplier ?? p.description}</strong> · <DateNl date={p.date} /><br />
              Op de bon: <strong>{formatForeign(p.foreignTotal, p.currency)}</strong> ({name(p.currency)}). Nu geboekt als <Euro cents={p.bookedTotal} />.
            </p>
            {p.alreadyBooked ? (
              <div className="notice small">
                De betaling van <strong><Euro cents={p.alreadyBooked.amount} /></strong> op {formatDateNl(p.alreadyBooked.date)} staat al als kosten in je boekhouding. Deze aankoop is dus dubbel: de app haalt hem weg en bewaart de bon als bewijsstuk bij die betaling.
              </div>
            ) : (
              <>
                {p.source && <div className="notice small">
                  {p.source === 'bank' && p.linkedPayment && <>Van je rekening is <strong><Euro cents={p.euroTotal} /></strong> afgeschreven. Dat bedrag komt in de boekhouding, en de aankoop staat daarmee op betaald.</>}
                  {p.source === 'bank' && !p.linkedPayment && <>Op je rekening staat een afschrijving van <strong><Euro cents={p.euroTotal} /></strong> die hierbij hoort. Dat bedrag komt in de boekhouding, en de app koppelt de betaling meteen.</>}
                  {p.source === 'ecb' && <>Nog geen betaling gevonden. Omgerekend met de koers van de Europese Centrale Bank: <strong><Euro cents={p.euroTotal} /></strong>. Komt de betaling later op de bank, dan koppelt de app hem en boekt hij een klein verschil als koersverschil.</>}
                  {p.rate && <> (1 euro = {p.rate.toLocaleString('nl-NL', { maximumFractionDigits: 4 })} {name(p.currency)})</>}
                </div>}
                <Field label="Bedrag in euro's" hint="zoals het van je rekening is afgeschreven"><MoneyInput value={euro} onChange={setEuro} /></Field>
              </>
            )}
            {p.blocker && <div className="notice warn small">{p.blocker}</div>}
            <p className="small muted">De oude boeking krijgt een tegenboeking en de nieuwe komt ervoor in de plaats. Is de btw-aangifte van dat kwartaal al gedaan? Dan gaat het verschil vanzelf mee in je volgende aangifte.</p>
          </>
        )}
      </div>
      <div className="row end" style={{ marginTop: 16 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={busy || !p || (!p.alreadyBooked && !euro) || (!!p.blocker && !(p.euroTotal === null && euro))} onClick={async () => {
          const r = await run(
            () => api.valuta.apply(purchaseId, { currency: p!.currency, foreignTotal: p!.foreignTotal, euroTotal: p!.alreadyBooked ? p!.alreadyBooked.amount : euro!, bankTransactionId: p!.bankTransactionId, alreadyBookedBankTransactionId: p!.alreadyBooked?.bankTransactionId ?? null }),
            p!.alreadyBooked ? 'Dubbele aankoop weggehaald ✓' : 'Omgerekend ✓',
          );
          if (r) await onDone();
        }}>{p?.alreadyBooked ? 'Weghalen' : 'Omrekenen'}</Button>
      </div>
    </Modal>
  );
}

/** Betalen met de bank-app: scan de QR-code (#25). Bij een nieuw IBAN eerst een waarschuwing. */
function PayModal({ id, onClose }: { id: number; onClose: () => void }) {
  const [confirmNew, setConfirmNew] = useState(false);
  const qr = useLoad(() => api.purchases.paymentQr(id, confirmNew), [id, confirmNew]);
  const q = qr.data;
  return (
    <Modal title="Rekening betalen" onClose={onClose}>
      <ErrorBox error={qr.error} />
      {q && (
        <div className="grid">
          <p>
            <strong><Euro cents={q.amount} /></strong> aan <strong>{q.name}</strong>
            {q.dueDate && <> · vóór <DateNl date={q.dueDate} /></>}
            <br /><span className="small muted">{q.iban}</span>
          </p>
          {q.needsConfirm ? (
            <>
              <div className="notice warn">{q.warning}</div>
              <div className="row">
                <Button kind="primary" onClick={() => setConfirmNew(true)}>Ik heb het gecontroleerd, toon de QR-code</Button>
                <Button onClick={onClose}>Nu niet</Button>
              </div>
            </>
          ) : (
            <>
              {q.warning && <div className="notice small">{q.warning}</div>}
              <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(q.svg)}`} alt="Betaal-QR-code" width={240} height={240} style={{ justifySelf: 'center', background: '#fff', borderRadius: 8 }} />
              <p className="small muted">Scan met je bank-app (“betalen met QR”). Zodra de betaling op je bankafschrift staat, zetten we de rekening op betaald.</p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

/** "Bonnetje zonder foto": in mensentaal, btw wordt automatisch berekend. */
function ManualExpense({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { meta, showInvestmentSaved } = useApp();
  const { run, busy } = useAction();
  const jobs = useLoad(() => api.jobs.list({ active: true }));
  const [supplier, setSupplier] = useState('');
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState<number | null>(null);
  const [category, setCategory] = useState('materiaal');
  const [vat, setVat] = useState<PurchaseVatCode>('hoog');
  const [paidWith, setPaidWith] = useState<'bank' | 'kas' | 'prive'>('bank');
  const [jobId, setJobId] = useState<number | null>(null);
  return (
    <Modal title="Aankoop toevoegen" onClose={onClose}>
      <div className="grid">
        <div className="grid cols-2">
          <Field label="Waar gekocht?"><input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="bv. Gamma" autoFocus /></Field>
          <Field label="Wanneer?"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <Field label="Bedrag op de bon" hint="inclusief btw"><MoneyInput value={amount} onChange={setAmount} /></Field>
        <CategoryChoice value={category} onChange={(c) => { setCategory(c); setVat(meta.expenseCategories.find((x) => x.key === c)?.defaultVat ?? 'hoog'); }} />
        <InvestmentHint categoryKey={category} gross={amount} vatCode={vat} onUse={() => setCategory('investering')} />
        <Field label="Stond er btw op de bon?">
          <select value={vat} onChange={(e) => setVat(e.target.value as PurchaseVatCode)}>
            {meta.purchaseVat.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}
          </select>
        </Field>
        <Field label="Hoe betaald?">
          <div className="chips">
            <button className={paidWith === 'bank' ? 'selected' : ''} onClick={() => setPaidWith('bank')}>Zakelijke rekening</button>
            <button className={paidWith === 'kas' ? 'selected' : ''} onClick={() => setPaidWith('kas')}>Contant</button>
            <button className={paidWith === 'prive' ? 'selected' : ''} onClick={() => setPaidWith('prive')}>Met privégeld</button>
          </div>
        </Field>
        {(jobs.data ?? []).length > 0 && (
          <Field label="Voor een klus?" hint="optioneel">
            <select value={jobId ?? ''} onChange={(e) => setJobId(Number(e.target.value) || null)}>
              <option value="">Nee / algemeen</option>
              {jobs.data!.map((j) => <option key={j.id} value={j.id}>{j.title} — {j.relation_name}</option>)}
            </select>
          </Field>
        )}
      </div>
      <div className="row end" style={{ marginTop: 16 }}>
        <Button onClick={onClose}>Annuleren</Button>
        <Button kind="primary" disabled={busy || !amount} onClick={async () => {
          const r = await run(() => api.purchases.recordExpense({ date, supplierName: supplier || null, description: meta.expenseCategories.find((c) => c.key === category)!.label, categoryKey: category, grossAmount: amount!, vatCode: vat, paidWith, jobId }), category === 'investering' ? undefined : 'Aankoop verwerkt ✓');
          if (r) {
            onDone();
            if (category === 'investering') showInvestmentSaved(investmentInfo(amount!, vat));
          }
        }}>Opslaan</Button>
      </div>
    </Modal>
  );
}

/** "Waar was deze aankoop voor?" — categorieën in mensentaal. */
export function CategoryChoice({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  return (
    <Field label="Waar was deze aankoop voor?">
      <CategoryChips value={value} onChange={(key) => onChange(key)} />
    </Field>
  );
}

const eur = (cents: number) => `€ ${(cents / 100).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * "Gaat dit langer dan een jaar mee?" — bij € 450+ excl. btw in een categorie waar dat vaak een
 * investering is. Legt in gewone taal uit wat er gebeurt als je ja zegt, en dat je verder niets hoeft
 * te doen. De gebruiker beslist; "Nee" verbergt de vraag (de app vraagt het later nog eens op Vandaag).
 */
export function InvestmentHint({ categoryKey, gross, vatCode, onUse }: { categoryKey: string; gross: number | null | undefined; vatCode: string; onUse: () => void }) {
  const { settings } = useApp();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || !mightBeInvestment(categoryKey, gross, vatCode, settings.kor)) return null;
  // KOR: btw niet aftrekbaar, dus onderdeel van de kostprijs
  const net = settings.kor ? gross! : netAmount(gross!, vatCode);
  const vat = settings.kor ? 0 : gross! - net;
  return (
    <div className="notice" role="note">
      <strong>{eur(net)}{settings.kor ? '' : ' excl. btw'} — gaat dit langer dan een jaar mee?</strong>
      <div className="small" style={{ marginTop: 4 }}>
        Denk aan een machine, laptop, telefoon of steiger. Dan is het een <em>investering</em>: iets dat je jaren gebruikt. Kies je daarvoor, dan:
      </div>
      <ul className="small" style={{ margin: '6px 0', paddingLeft: 18 }}>
        {vat > 0 && <li><strong>btw:</strong> die {eur(vat)} krijg je gewoon in één keer terug bij je volgende btw-aangifte. Daar verandert niets aan.</li>}
        <li><strong>kosten:</strong> je trekt het niet in één keer af, maar verdeeld over 5 jaar (± {eur(Math.round(net / 5))} per jaar). Dat boekt de app elk jaar vanzelf.</li>
        <li><strong>extra aftrek:</strong> het telt mee voor de investeringsaftrek (KIA). Investeer je dit jaar in totaal meer dan € 2.900, dan mag je 28% extra aftrekken.</li>
      </ul>
      <div className="small">Jij hoeft daarvoor niets extra te doen. Twijfel je? Kies dan "Nee": de app vraagt het later nog één keer op Vandaag.</div>
      <div className="row" style={{ marginTop: 8 }}>
        <Button small kind="primary" onClick={onUse}>Ja, het is een investering</Button>
        <Button small onClick={() => setDismissed(true)}>Nee, gewone kosten</Button>
      </div>
    </div>
  );
}

/** Na het opslaan: wat de app nu voor je doet, en wat jij (nog) moet doen. */
export function InvestmentSaved({ info, onClose }: { info: InvestmentSavedInfo; onClose: () => void }) {
  const { go } = useApp();
  return (
    <Modal title="Opgeslagen als investering ✓" onClose={onClose}>
      <h3 style={{ marginTop: 0 }}>Dit doet de app voor je</h3>
      <ul style={{ marginTop: 0, paddingLeft: 18 }}>
        {info.vat > 0 && <li>De btw ({eur(info.vat)}) krijg je terug bij je volgende btw-aangifte; die staat daar al in.</li>}
        <li>Elk jaar telt de app ± {eur(Math.round(info.net / 5))} als kosten, 5 jaar lang (dat heet afschrijven). Dat verlaagt je winst, en dus je inkomstenbelasting.</li>
        <li>Het telt mee voor de investeringsaftrek (KIA). Dat zie je terug bij Belasting → Aftrek → Voor je aangifte.</li>
      </ul>
      <h3>Wat jij moet doen</h3>
      <ul style={{ marginTop: 0, paddingLeft: 18 }}>
        <li>{info.hasAttachment ? 'Niets voor de bon: die is al in de app bewaard.' : 'Bewaar de bon of factuur. Dat moet 7 jaar; voeg hem het liefst toe in de app.'}</li>
        <li>Verkoop je het, of gooi je het weg? Zet dat dan bij Belasting → Aftrek → Investeringen (knop "Verkocht…"). De app rekent de rest uit.</li>
        <li>Laat bij je aangifte je boekhouder of accountant meekijken, zoals altijd.</li>
      </ul>
      <p className="small muted">Toch geen investering? Kies bij de aankoop een andere soort kosten; de app past het dan vanzelf aan.</p>
      <div className="row end">
        <Button onClick={() => { onClose(); go({ screen: 'aangifte', extra: { tab: 'bedrijfsmiddelen' } }); }}>Bekijk je investeringen</Button>
        <Button kind="primary" onClick={onClose}>Oké</Button>
      </div>
    </Modal>
  );
}

/** Info voor de bevestiging uit een bedrag zoals op de bon. */
export function investmentInfo(gross: number, vatCode: string, hasAttachment = false): InvestmentSavedInfo {
  const net = netAmount(gross, vatCode);
  return { net, vat: ['hoog', 'laag'].includes(vatCode) ? gross - net : 0, hasAttachment };
}

/** "nog 14 maanden garantie" / "garantie verlopen". */
function warrantyText(from: string, months: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  const left = (d.getTime() - Date.now()) / 86400000;
  if (left < 0) return `garantie verlopen op ${d.toISOString().slice(0, 10)}`;
  const m = Math.floor(left / 30.44);
  return m >= 1 ? `nog ${m} ${m === 1 ? 'maand' : 'maanden'} garantie` : `nog ${Math.ceil(left)} dagen garantie`;
}
