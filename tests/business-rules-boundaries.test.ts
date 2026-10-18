import { businessShareFor } from '../src/intake/business-share';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { compile } from '../src/core-ledger/rules';
import { compile as legacyCompile } from '../src/core-ledger/rules-2026-2';
import { RULES_VERSION } from '../src/core-ledger/rules-version';
import { carPrivateUse, carPrivateUseFromLedger } from '../src/btw/car';
import { rulesFor } from '../src/tax/income-tax';

type S = ReturnType<typeof setup>['s'];
const purchase = (s: S, net: number, extra = {}) => s.purchases.create({ invoiceDate: '2026-02-01', description: 'Machine', lines: [{ account: ACCOUNTS.inventaris, netAmount: net, vatCode: 'hoog' }], ...extra });
const inv = (s: S, customer: number, date: string) => s.invoices.finalize(s.invoices.createDraft({ relationId: customer, invoiceDate: date, lines: [{ description: 'Werk', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] }).id);

describe('business rules: correcties, historie en grensgevallen', () => {
  it('verlegde btw: de volledige grondslag in het overzicht en de detailregels, ook onder KOR', () => {
    for (const kor of [false, true]) {
      const { s } = setup(); s.settings.update({ kor });
      s.purchases.create({ invoiceDate: '2026-02-01', description: 'B2B-dienst', businessPct: 50, lines: [{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'eu' }] });
      const report = s.vat.calculate('2026-Q1');
      expect(report.rubrieken.find(r => r.code === '4b')).toMatchObject({ omzet: 10000, btw: 2100 });
      expect(report.summary.voorbelasting).toBe(kor ? 0 : 1050);
      expect(s.vat.rubriekDetails('2026-Q1', '4b')).toMatchObject({ omzet: 10000, btw: 2100 });
      expect(s.ledger.balance(ACCOUNTS.priveOpnamen)).toBe(6050);
      expect(s.ledger.checkIntegrity().balanced).toBe(true);
    }
  });
  it('oude boekingsversie blijft herhaalbaar; corrigeren maakt een nieuwe versie', () => {
    const { s, db } = setup();
    const p = s.purchases.create({ invoiceDate: '2026-02-01', description: 'Dienst', businessPct: 50, lines: [{ account: 'WBedKanSof', netAmount: 10000, vatCode: 'eu' }] });
    const event = s.events.forEntry(p.journal_entry_id!)!;
    db.prepare("UPDATE events SET rules_version = '2026.2' WHERE id = ?").run(event.id);
    expect(s.events.recompile(event.id)).toEqual(legacyCompile({ type: event.type, payload: event.payload } as never));
    const corrected = s.purchases.setBusinessPct(p.id, 75);
    expect(s.events.forEntry(corrected.journal_entry_id!)!.rules_version).toBe(RULES_VERSION);
    expect(compile({ type: event.type, payload: event.payload } as never, '2026.2')).not.toEqual(compile({ type: event.type, payload: event.payload } as never));
  });
  it('historische openstaande facturen verwerken deelbetalingen en hun latere tegenboeking', () => {
    const { s, klant } = setup(); const p = inv(s, klant.id, '2026-02-01');
    s.invoices.registerPayment(p.id, { date: '2026-02-15', amount: 5000 });
    s.invoices.registerPayment(p.id, { date: '2026-03-01', amount: 7100 });
    expect(s.dashboard.get('2026-02-10').openInvoices.amount).toBe(12100);
    expect(s.dashboard.get('2026-02-28').openInvoices.amount).toBe(7100);
    expect(s.dashboard.get('2026-03-01').openInvoices.amount).toBe(0);
  });
  it('een toekomstige creditnota wist de eerdere debiteur niet', () => {
    const { s, klant } = setup(); const p = inv(s, klant.id, '2026-02-01');
    const credit = s.invoices.createCreditNote(p.id);
    s.invoices.updateDraft(credit.id, { invoiceDate: '2026-03-01' });
    s.invoices.finalize(credit.id);
    expect(s.dashboard.get('2026-02-28').openInvoices.amount).toBe(12100);
    expect(s.dashboard.get('2026-03-01').openInvoices.amount).toBe(0);
  });
  it('overbetaling maakt de factuur betaald en verschijnt niet opnieuw als openstaand', () => {
    const { s, klant } = setup(); const p = inv(s, klant.id, '2026-02-01');
    s.invoices.registerPayment(p.id, { date: '2026-02-02', amount: 13000 });
    expect(s.invoices.get(p.id).status).toBe('betaald');
    expect(s.invoices.listOpen('2026-02-03')).toHaveLength(0);
  });
  it('gemengde KOR-investeringen met meerdere regels houden hun eigen btw-kostprijs', () => {
    const { s } = setup(); s.settings.update({ kor: true });
    s.purchases.create({ invoiceDate: '2026-02-01', description: 'Twee machines', businessPct: 50, lines: [
      { account: ACCOUNTS.inventaris, netAmount: 100000, vatCode: 'hoog', description: 'A' },
      { account: ACCOUNTS.inventaris, netAmount: 200000, vatCode: 'hoog', description: 'B' },
    ] });
    expect(s.assets.list().map(a => a.cost).sort((a,b) => a-b)).toEqual([60500,121000]);
    expect(s.assets.list().reduce((n,a) => n+a.cost,0)).toBe(s.ledger.balance(ACCOUNTS.inventaris));
  });
  it('credit bij meerdere investeringen vraagt een keuze, blijft zichtbaar en is idempotent', () => {
    const { s } = setup(); purchase(s, 100000); purchase(s, 200000);
    purchase(s, -20000, { invoiceDate: '2026-02-03' });
    const choices = s.assets.unassignedCredits();
    expect(choices).toHaveLength(1); expect(choices[0]!.candidates).toHaveLength(2);
    expect(s.vat.checks('2026-Q1').some(c => c.key === 'investering-credit')).toBe(true);
    const c = choices[0]!; const asset = c.candidates[0]!;
    s.assets.allocateCredit(c.lineId, asset.id); s.assets.allocateCredit(c.lineId, asset.id);
    expect(s.assets.unassignedCredits()).toHaveLength(0);
    expect(s.assets.list().reduce((n,a) => n+a.cost,0)).toBe(280000);
  });
  it('teruggedraaide credit herstelt de kostprijs; de historische waarde blijft gelijk', () => {
    const { s } = setup(); purchase(s, 100000);
    const c = purchase(s, -20000, { invoiceDate: '2026-02-03' });
    expect(s.assets.list({}, '2026-02-04')[0]!.cost).toBe(80000);
    expect(s.assets.list({}, '2026-02-02')[0]!.cost).toBe(100000);
    s.purchases.cancel(c.id, '2026-02-05');
    expect(s.assets.list({}, '2026-02-06')[0]!.cost).toBe(100000);
    expect(s.assets.list({}, '2026-02-04')[0]!.cost).toBe(80000);
  });
  it('meerdere credits kunnen een bedrijfsmiddel niet onder nul brengen', () => {
    const { s } = setup(); purchase(s, 100000);
    purchase(s, -80000, { invoiceDate: '2026-02-03' }); purchase(s, -80000, { invoiceDate: '2026-02-04' });
    expect(s.assets.list()[0]!.cost).toBe(20000);
    expect(s.assets.unassignedCredits()).toHaveLength(1);
  });
  it('marge-auto: 1,5% met maximum van de btw op de kosten; nul is een geldige correctie', () => {
    const { s } = setup();
    s.settings.update({ carUse: 'zakelijk', carPrivateUse: true, carVatDeducted: true, carVatMethod: 'forfait', carPurchaseVatDeducted: false, carCatalogValue: 7500000, carInUseSince: 2025 });
    s.purchases.create({ invoiceDate: '2026-02-01', description: 'Autokosten', lines: [{ account: 'WBedAutOnd', netAmount: 400000, vatCode: 'hoog' }] });
    expect(s.vat.carPrivateUse('2026-Q4').due).toMatchObject({ state: 'bekend', pct: 0.015, amount: 84000 });
    s.settings.update({ carCostVatOverride: { year: 2026, amount: 0 } });
    expect(() => s.vat.bookCarPrivateUse('2026-Q4')).not.toThrow();
    expect(s.vat.carPrivateUse('2026-Q4').booked).toBe(0);
  });
  it('gemengde aankoopbon: de maximale autocorrectie gebruikt alleen de afgetrokken autokosten-btw', () => {
    const { s } = setup(); s.settings.update({ carUse: 'zakelijk', carPrivateUse: true, carVatDeducted: true, carVatMethod: 'forfait', carPurchaseVatDeducted: false, carCatalogValue: 7500000, carInUseSince: 2025 });
    s.purchases.create({ invoiceDate: '2026-02-01', description: 'Kosten', businessPct: 50, lines: [{ account: 'WBedAutBra', netAmount: 100000, vatCode: 'hoog' }, { account: 'WBedKanSof', netAmount: 300000, vatCode: 'hoog' }] });
    expect(carPrivateUseFromLedger(s.db, s.settings.get(), 2026)).toMatchObject({ amount: 10500 });
  });
  it('KOR-controle beschermt ook direct boeken en herindelen; vrijgestelde omzet blijft mogelijk', () => {
    const { s } = setup(); s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-02-01', amount: 12100, description: 'Verkoop' }] });
    const t = s.bank.list()[0]!; s.bank.bookSale(t.id, { vatCode: 'hoog' }); s.settings.update({ kor: true });
    expect(() => s.bank.reclassify(t.id, { account: ACCOUNTS.omzetHoog, vatCode: 'laag' })).toThrow(/KOR/);
    s.bank.reclassify(t.id, { account: ACCOUNTS.omzetHoog, vatCode: 'vrijgesteld' });
    expect(s.ledger.balance(ACCOUNTS.omzetVrijgesteld)).toBe(-12100);
  });
  it('bankrefund voor een gemengde investering herstelt kosten en voorbelasting symmetrisch', () => {
    const { s } = setup();
    s.bank.import({ source: 'csv', warnings: [], transactions: [
      { date: '2026-02-01', amount: -121000, description: 'Machine', counterName: 'Machinewinkel' },
      { date: '2026-02-03', amount: 121000, description: 'Refund machine', counterName: 'Machinewinkel' },
    ] });
    const transactions = s.bank.list();
    s.bank.bookToAccount(transactions.find(t => t.amount < 0)!.id, { account: ACCOUNTS.inventaris, vatCode: 'hoog', businessPct: 50 });
    s.assets.list();
    s.bank.bookToAccount(transactions.find(t => t.amount > 0)!.id, { account: ACCOUNTS.inventaris, vatCode: 'hoog' });
    expect(s.ledger.balance(ACCOUNTS.inventaris)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.priveOpnamen)).toBe(0);
    expect(s.assets.list()[0]!.cost).toBe(0);
  });
  it('expliciet 100% zakelijk voorkomt een tweede algemene telefooncorrectie', () => {
    const { s } = setup(); s.settings.update({ phoneInternetBusinessPct: 50 });
    const p = s.purchases.create({ invoiceDate: '2026-02-01', description: 'Zakelijk abonnement', businessPct: 50, lines: [{ account: 'WBedKanTel', netAmount: 10000, vatCode: 'hoog' }] });
    s.purchases.setBusinessPct(p.id, 100);
    expect(s.taxOverview.adjustments(2026, '2026-02-28').phonePrivate).toMatchObject({ bijtelling: 0, vat: 0 });
  });
  it('ongeldige btw op een directe aankoop wordt afgewezen zonder boekingen achter te laten', () => {
    const { s } = setup();
    expect(() => purchase(s, 10000, { lines: [{ account: ACCOUNTS.inventaris, netAmount: 10000, vatCode: 'hoog', vatAmount: 9999 }] })).toThrow(/tarief/);
    expect(s.purchases.list()).toHaveLength(0);
    expect(s.ledger.balance(ACCOUNTS.inventaris)).toBe(0);
  });
  it('een afgewezen bankboeking onthoudt geen zakelijk percentage', () => {
    const { s, db } = setup();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-02-01', amount: -12100, description: 'Uitgave', counterName: 'Winkel' }] });
    const t = s.bank.list()[0]!;
    expect(() => s.bank.bookToAccount(t.id, { account: 'WBedKanSof', vatCode: 'ongeldig', businessPct: 50 })).toThrow();
    expect(businessShareFor(db, 'Winkel')).toBe(100);
    expect(s.bank.get(t.id).status).toBe('nieuw');
  });
  it('een toekomstige definitieve factuur staat in de actuele lijst als open, maar niet op een eerdere peildatum', () => {
    const { s, klant } = setup(); const p = inv(s, klant.id, '2027-02-01');
    expect(s.invoices.list().find(i => i.id === p.id)).toMatchObject({ status: 'verzonden', open_amount: 12100 });
    expect(s.invoices.listOpen('2026-12-31')).toHaveLength(0);
  });
  it('na de herzieningsperiode is alleen de jaarlijkse autokosten-btw nodig voor het maximum', () => {
    const { s } = setup();
    const settings = { ...s.settings.get(), carUse: 'zakelijk' as const, carPrivateUse: true, carVatDeducted: true, carVatMethod: 'forfait' as const, carCatalogValue: 4000000, carInUseSince: 2021 };
    expect(carPrivateUse(settings, 2026, { purchaseDeducted: null, purchaseVat: null, costVat: 20000 })).toMatchObject({ state: 'bekend', pct: 0.015, amount: 20000 });
  });
  it('meerdere auto’s vragen expliciete eigen bedragen en gebruiken geen gezamenlijke aftrek als maximum', () => {
    const { s } = setup();
    s.settings.update({ carUse: 'zakelijk', carPrivateUse: true, carVatDeducted: true, carVatMethod: 'forfait', carCatalogValue: 4000000, carInUseSince: 2025 });
    for (const name of ['Auto A','Auto B']) s.purchases.create({ invoiceDate: '2025-01-01', description: name, lines: [{ account: ACCOUNTS.vervoermiddelen, netAmount: 2000000, vatCode: 'hoog' }] });
    expect(carPrivateUseFromLedger(s.db, s.settings.get(), 2026).state).toBe('onbekend');
  });
  it('Zvw maximum voor 2025 is het gepubliceerde bedrag', () => {
    expect(rulesFor(2025).rules.zvw.maxIncome).toBe(75864);
  });
});
