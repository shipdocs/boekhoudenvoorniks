import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

function icpInvoice(s: ReturnType<typeof setup>['s']) {
  const de = s.relations.create({ name: 'Bau GmbH', address: 'Hauptstraße 1', postcode: '47533', city: 'Kleve', country: 'DE', vat_number: 'DE123456789', email: 'info@bau.example' });
  s.invoices.finalize(s.invoices.createDraft({ relationId: de.id, invoiceDate: '2026-04-10', lines: [{ description: 'Spullen', quantity: 1, unitPrice: 100000, vatCode: 'icp' }] }).id);
}
const check = (s: ReturnType<typeof setup>['s']) => s.vat.checks('2026-Q2').find((c) => c.key === 'vies');

describe('Waarschuwing: EU-verkoop zonder geldige VIES-controle', () => {
  it('zonder controle: waarschuwing; na een geldige uitslag: weg', async () => {
    const { s } = setup({ fetch: ok({ isValid: true, name: 'BAU GMBH', address: '---' }) });
    icpInvoice(s);
    expect(check(s)).toMatchObject({ blocking: false, count: 1 });
    expect(check(s)!.title).toContain('niet in VIES is gecontroleerd');
    await s.vies.check('DE123456789');
    expect(check(s)).toBeUndefined();
  });
  it('ongeldig nummer: sterkere waarschuwing met de uitslag erbij', async () => {
    const { s } = setup({ fetch: ok({ isValid: false }) });
    icpInvoice(s);
    await s.vies.check('DE123456789');
    expect(check(s)!.title).toContain('niet kent');
    expect(check(s)!.items![0]!.label).toContain('ongeldig');
  });
  it('geen uitslag (dienst onbereikbaar) telt niet als gecontroleerd', async () => {
    const { s } = setup({ fetch: async () => { throw new Error('netwerk'); } });
    icpInvoice(s);
    await s.vies.check('DE123456789');
    expect(check(s)).toMatchObject({ count: 1 });
  });
});
