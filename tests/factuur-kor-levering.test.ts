import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

type S = ReturnType<typeof setup>['s'];
type Code = 'hoog' | 'vrijgesteld' | 'verlegd' | 'icp-dienst' | 'icp';
function draft(s: S, relationId: number, vatCode: Code = 'hoog', extra: Record<string, unknown> = {}, amount = 100000) {
  return s.invoices.createDraft({ relationId, invoiceDate: '2026-04-10', lines: [{ description: 'Werk', quantity: 1, unitPrice: amount, vatCode }], ...extra });
}
const html = (s: S, id: number) => s.invoices.renderHtml(id);

describe('KOR en "btw verlegd"', () => {
  it('een KOR-gebruiker kan binnenlands verlegd niet kiezen op een factuur', () => {
    const { s, aannemer } = setup();
    s.settings.update({ kor: true });
    expect(() => s.invoices.finalize(draft(s, aannemer.id, 'verlegd').id)).toThrow(/KOR/);
  });
  it('met "Geen btw" onder de KOR lukt het wel, en de factuur noemt de KOR', () => {
    const { s, aannemer } = setup();
    s.settings.update({ kor: true });
    const inv = s.invoices.finalize(draft(s, aannemer.id, 'vrijgesteld').id);
    expect(html(s, inv.id)).toContain('kleineondernemersregeling');
  });
  it('zonder KOR blijft verlegd aan een bedrijf met btw-nummer gewoon mogelijk', () => {
    const { s, aannemer } = setup();
    expect(() => s.invoices.finalize(draft(s, aannemer.id, 'verlegd').id)).not.toThrow();
  });
  it('een EU-dienst aan een bedrijf blijft onder de KOR mogelijk (elders belast)', () => {
    const { s } = setup();
    s.settings.update({ kor: true });
    const de = s.relations.create({ name: 'Bau GmbH', address: 'Hauptstraße 1', postcode: '47533', city: 'Kleve', country: 'DE', vat_number: 'DE123456789', email: 'info@bau.example' });
    expect(() => s.invoices.finalize(draft(s, de.id, 'icp-dienst').id)).not.toThrow();
  });
  it('een verkoop via de bank met "verlegd" wordt onder de KOR ook geweigerd', () => {
    const { s } = setup();
    s.settings.update({ kor: true });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-04-11', amount: 50000, description: 'Klant', counterName: 'Klant' }] });
    const t = s.bank.list().find((x) => x.counter_name === 'Klant')!;
    expect(() => s.bank.bookSale(t.id, { vatCode: 'verlegd' })).toThrow(/KOR/);
  });
});

describe('datum van levering of dienst op de factuur', () => {
  it('leeg: de factuur noemt de factuurdatum als datum van levering', () => {
    const { s, klant } = setup();
    const inv = s.invoices.finalize(draft(s, klant.id).id);
    expect(inv.delivery_date).toBeNull();
    const h = html(s, inv.id);
    expect(h).toContain('Datum levering/dienst');
    expect(h).toContain('10 april 2026');
  });
  it('een eigen datum staat op de factuur en blijft na opslaan en definitief maken', () => {
    const { s, klant } = setup();
    const d = draft(s, klant.id, 'hoog', { deliveryDate: '2026-03-28' });
    const inv = s.invoices.finalize(d.id);
    expect(inv.delivery_date).toBe('2026-03-28');
    expect(html(s, inv.id)).toContain('28 maart 2026');
  });
  it('een periode toont "t/m"', () => {
    const { s, klant } = setup();
    const inv = s.invoices.finalize(draft(s, klant.id, 'hoog', { deliveryDate: '2026-03-02', deliveryDateTo: '2026-03-27' }).id);
    const h = html(s, inv.id);
    expect(h).toContain('Periode levering/dienst');
    expect(h).toContain('2 maart 2026 t/m 27 maart 2026');
  });
  it('een concept bijwerken en weer leegmaken', () => {
    const { s, klant } = setup();
    const d = draft(s, klant.id);
    expect(s.invoices.updateDraft(d.id, { deliveryDate: '2026-04-01' }).delivery_date).toBe('2026-04-01');
    expect(s.invoices.updateDraft(d.id, { reference: 'x' }).delivery_date).toBe('2026-04-01');
    expect(s.invoices.updateDraft(d.id, { deliveryDate: null, deliveryDateTo: null }).delivery_date).toBeNull();
  });
  it('onder de KOR staat er zonder eigen invoer niets, met eigen invoer wel', () => {
    const { s, klant } = setup();
    s.settings.update({ kor: true });
    const a = s.invoices.finalize(draft(s, klant.id, 'vrijgesteld').id);
    expect(html(s, a.id)).not.toContain('Datum levering/dienst');
    const b = s.invoices.finalize(draft(s, klant.id, 'vrijgesteld', { deliveryDate: '2026-04-01' }).id);
    expect(html(s, b.id)).toContain('Datum levering/dienst');
  });
  it('een creditfactuur toont zonder eigen invoer geen leverdatum', () => {
    const { s, klant } = setup();
    const inv = s.invoices.finalize(draft(s, klant.id).id);
    const credit = s.invoices.finalize(s.invoices.createCreditNote(inv.id).id);
    expect(html(s, credit.id)).not.toContain('Datum levering/dienst');
  });
  it('ongeldige invoer: einde zonder begin, einde voor begin, geen datum', () => {
    const { s, klant } = setup();
    expect(() => draft(s, klant.id, 'hoog', { deliveryDateTo: '2026-04-02' })).toThrow(/begindatum/);
    expect(() => draft(s, klant.id, 'hoog', { deliveryDate: '2026-04-05', deliveryDateTo: '2026-04-02' })).toThrow(/vóór/);
    expect(() => draft(s, klant.id, 'hoog', { deliveryDate: '2026-02-30' })).toThrow();
  });
  it('een einddatum gelijk aan de begindatum is gewoon één datum', () => {
    const { s, klant } = setup();
    expect(draft(s, klant.id, 'hoog', { deliveryDate: '2026-04-05', deliveryDateTo: '2026-04-05' }).delivery_date_to).toBeNull();
  });
});

describe('datum van levering in de e-factuur (UBL)', () => {
  const ublOf = (s: S, id: number) => s.invoices.ublXml(id);
  it('zonder eigen invoer geen Delivery of InvoicePeriod', () => {
    const { s, klant } = setup();
    const x = ublOf(s, s.invoices.finalize(draft(s, klant.id).id).id);
    expect(x).not.toContain('ActualDeliveryDate');
    expect(x).not.toContain('InvoicePeriod');
  });
  it('één datum wordt ActualDeliveryDate', () => {
    const { s, klant } = setup();
    const x = ublOf(s, s.invoices.finalize(draft(s, klant.id, 'hoog', { deliveryDate: '2026-03-28' }).id).id);
    expect(x).toContain('<cbc:ActualDeliveryDate>2026-03-28</cbc:ActualDeliveryDate>');
  });
  it('een periode wordt InvoicePeriod, vóór de partijen', () => {
    const { s, klant } = setup();
    const x = ublOf(s, s.invoices.finalize(draft(s, klant.id, 'hoog', { deliveryDate: '2026-03-02', deliveryDateTo: '2026-03-27' }).id).id);
    expect(x).toContain('<cbc:StartDate>2026-03-02</cbc:StartDate><cbc:EndDate>2026-03-27</cbc:EndDate>');
    expect(x.indexOf('InvoicePeriod')).toBeLessThan(x.indexOf('AccountingSupplierParty'));
    expect(x).not.toContain('ActualDeliveryDate');
  });
  it('een ICP-levering gebruikt de eigen leverdatum, anders de factuurdatum', () => {
    const { s } = setup();
    const de = s.relations.create({ name: 'Bau GmbH', address: 'Hauptstraße 1', postcode: '47533', city: 'Kleve', country: 'DE', vat_number: 'DE123456789', email: 'info@bau.example' });
    const a = ublOf(s, s.invoices.finalize(draft(s, de.id, 'icp').id).id);
    expect(a).toContain('<cbc:ActualDeliveryDate>2026-04-10</cbc:ActualDeliveryDate>');
    const b = ublOf(s, s.invoices.finalize(draft(s, de.id, 'icp', { deliveryDate: '2026-04-02' }).id).id);
    expect(b).toContain('<cbc:ActualDeliveryDate>2026-04-02</cbc:ActualDeliveryDate>');
    expect(b).toContain('DeliveryLocation');
  });
});
