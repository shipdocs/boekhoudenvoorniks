import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { KOR_TURNOVER_LIMIT, KOR_WARN_FROM } from '../src/btw/checks';

type S = ReturnType<typeof setup>['s'];
const check = (s: S, period: string) => s.vat.checks(period).find((c) => c.key === 'kor-grens');

function sale(s: S, relationId: number, date: string, amount: number, vatCode: 'vrijgesteld' | 'nul' | 'verlegd' | 'icp-dienst' | 'export' = 'vrijgesteld') {
  s.invoices.finalize(s.invoices.createDraft({ relationId, invoiceDate: date, lines: [{ description: 'Werk', quantity: 1, unitPrice: amount, vatCode }] }).id);
}

describe('KOR: bewaking van de omzetgrens van € 20.000', () => {
  it('zonder KOR geen melding, ook niet boven de grens', () => {
    const { s, klant } = setup();
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-02-10', lines: [{ description: 'x', quantity: 1, unitPrice: KOR_TURNOVER_LIMIT * 2, vatCode: 'hoog' }] }).id);
    expect(check(s, '2026-Q1')).toBeUndefined();
  });
  it('onder 80% van de grens: niets', () => {
    const { s, klant } = setup();
    s.settings.update({ kor: true });
    sale(s, klant.id, '2026-02-10', KOR_WARN_FROM - 1);
    expect(check(s, '2026-Q1')).toBeUndefined();
  });
  it('vanaf 80%: waarschuwing dat de grens nadert', () => {
    const { s, klant } = setup();
    s.settings.update({ kor: true });
    sale(s, klant.id, '2026-02-10', KOR_WARN_FROM);
    expect(check(s, '2026-Q1')).toMatchObject({ blocking: false, fingerprint: '2026:bijna' });
  });
  it('precies € 20.000 is nog niet over de grens', () => {
    const { s, klant } = setup();
    s.settings.update({ kor: true });
    sale(s, klant.id, '2026-02-10', KOR_TURNOVER_LIMIT);
    expect(check(s, '2026-Q1')?.fingerprint).toBe('2026:bijna');
  });
  it('één cent erboven: de KOR vervalt', () => {
    const { s, klant } = setup();
    s.settings.update({ kor: true });
    sale(s, klant.id, '2026-02-10', KOR_TURNOVER_LIMIT);
    sale(s, klant.id, '2026-03-01', 1);
    const c = check(s, '2026-Q1')!;
    expect(c.fingerprint).toBe('2026:boven');
    expect(c.title).toContain('boven');
  });
  it('de omzet loopt over kwartalen heen binnen één kalenderjaar', () => {
    const { s, klant } = setup();
    s.settings.update({ kor: true });
    sale(s, klant.id, '2026-02-10', 1500000);
    sale(s, klant.id, '2026-08-10', 600000);
    expect(check(s, '2026-Q1')).toBeUndefined();
    expect(check(s, '2026-Q3')?.fingerprint).toBe('2026:boven');
  });
  it('omzet van het vorige kalenderjaar telt niet mee voor dit jaar', () => {
    const { s, klant } = setup();
    s.settings.update({ kor: true });
    sale(s, klant.id, '2025-11-10', 1900000);
    sale(s, klant.id, '2026-02-10', 100000);
    expect(check(s, '2026-Q1')).toBeUndefined();
  });
  it('uitvoer, 0% en nationale verlegging tellen mee', () => {
    const { s, klant, aannemer } = setup();
    s.settings.update({ kor: true });
    const us = s.relations.create({ name: 'Acme Inc', address: '1 Main St', postcode: '10001', city: 'New York', country: 'US', email: 'a@acme.example' });
    sale(s, klant.id, '2026-02-10', 700000, 'nul');
    sale(s, aannemer.id, '2026-02-11', 700000, 'verlegd');
    sale(s, us.id, '2026-02-12', 700000, 'export');
    expect(check(s, '2026-Q1')?.fingerprint).toBe('2026:boven');
  });
  it('een dienst aan een bedrijf in een ander EU-land is elders belast en telt niet mee', () => {
    const { s } = setup();
    s.settings.update({ kor: true });
    const de = s.relations.create({ name: 'Bau GmbH', address: 'Hauptstraße 1', postcode: '47533', city: 'Kleve', country: 'de', vat_number: 'DE123456789', email: 'info@bau.example' });
    sale(s, de.id, '2026-02-10', KOR_TURNOVER_LIMIT * 2, 'icp-dienst');
    expect(check(s, '2026-Q1')).toBeUndefined();
  });
  it('een creditnota haalt de omzet weer omlaag', () => {
    const { s, klant } = setup();
    s.settings.update({ kor: true });
    sale(s, klant.id, '2026-02-10', 2100000);
    sale(s, klant.id, '2026-02-20', -250000);
    expect(check(s, '2026-Q1')?.fingerprint).toBe('2026:bijna');
  });
  it('verschijnt op Vandaag voor een KOR-gebruiker, en verdwijnt na "Klopt"', () => {
    const { s, klant } = setup();
    s.settings.update({ kor: true });
    sale(s, klant.id, '2026-08-10', KOR_WARN_FROM + 1000);
    const task = () => s.inbox.tasks('2026-09-05').find((t) => t.kind === 'vat-check' && t.key.endsWith('kor-grens'));
    expect(task()).toBeDefined();
    const periodKey = task()!.ref.periodKey as string;
    s.vat.skipCheck(periodKey, 'kor-grens', 'bekend');
    expect(task()).toBeUndefined();
    // zodra de situatie verandert (over de grens), komt hij terug
    sale(s, klant.id, '2026-08-20', KOR_TURNOVER_LIMIT);
    expect(task()).toBeDefined();
  });
});
