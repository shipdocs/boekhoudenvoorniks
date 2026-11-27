import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { makePdf } from './pdf';
import { createApi, type HostContext } from '../src/main/api';
import { formatEuro } from '../src/shared/money';
import type { FetchLike } from '../src/integrations/types';

/**
 * Een bon en een betaling die bijna passen: een factuur in dollars, en een kaartbetaling met een
 * andere naam en een bedrag dat door de koers van de bank 3,8% hoger is. Te onzeker om vanzelf te koppelen; op Vandaag
 * één vraag op de kaart van de bon: "Hoort deze betaling bij de bon?". Alle namen en bedragen zijn verzonnen.
 */

const CSV = ['KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE', 'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-05-05,1.0800'].join('\n');
const ecb = (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => CSV })) as unknown as FetchLike;
const INVOICE = ['Invoice', 'Invoice number WLK-0042', 'Date of issue May 6, 2026', 'Wolkendienst Inc.', 'Pro plan 1 $90.00', 'Total $90.00', 'Amount due $90.00 USD', 'Tax to be paid on reverse charge basis'];

const world = async () => {
  const ctx = setup({ fetch: ecb });
  ctx.s.settings.update({ onboardingDone: true, company: { ...ctx.s.settings.get().company, name: 'Testbedrijf' } });
  const api = createApi(ctx.s, { appVersion: () => '0.0.0', hasSmtpPassword: () => false } as unknown as HostContext);
  const doc = await ctx.s.intake.add('invoice.pdf', makePdf(INVOICE), '2026-05-08', { autoConfirm: false });
  // de betaling komt pas na de bon binnen, met de naam van de betaaldienst en de koers van de bank
  ctx.s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-05-07', amount: -8650, description: 'LINK.COM* VOORBEELDLAB', counterName: 'LINK.COM* VOORBEELDLAB' }] });
  const tx = ctx.s.bank.list().find((t) => t.amount === -8650)!;
  return { ...ctx, api, doc, tx };
};

describe('bon en betaling die bijna passen', () => {
  it('één vraag op de kaart van de bon, geen losse vraag bij de betaling', async () => {
    const { s, doc, tx } = await world();
    expect(s.intake.get(doc.id)).toMatchObject({ status: 'controle', bank_match: null, result: { total: { value: 8333 } } });
    const tasks = s.inbox.tasks('2026-05-20');
    expect(tasks.filter((t) => t.ref.bankTransactionId === tx.id)).toEqual([]);
    const card = tasks.find((t) => t.ref.documentId === doc.id)!;
    expect(card).toMatchObject({ kind: 'document-review', ref: { candidate: `pay:${tx.id}` }, payment: { date: '2026-05-07', amount: -8650, name: 'LINK.COM* VOORBEELDLAB', possible: true } });
    expect(card.question).toBe(`Hoort deze betaling bij de bon? Het bedrag wijkt ${formatEuro(317)} af van de bon, waarschijnlijk door de koers van je bank.`);
    expect(card.actions.map((a) => a.id)).toEqual(['betaling-ja', 'betaling-nee', 'open']);
  });

  it('"Ja, hoort erbij": de betaling gaat mee met de bon, het verschil wordt koersverschil', async () => {
    const { s, api, doc, tx } = await world();
    const card = s.inbox.tasks('2026-05-20').find((t) => t.ref.documentId === doc.id)!;
    await api.home.act(card, 'betaling-ja');
    expect(s.intake.get(doc.id)).toMatchObject({ bank_match: { id: tx.id }, bank_match_strong: true });
    // daarna de gewone vraag bij de bon, met de betaling die meegaat
    const next = s.inbox.tasks('2026-05-20').find((t) => t.ref.documentId === doc.id)!;
    expect(next.payment).toEqual({ date: '2026-05-07', amount: -8650, name: 'LINK.COM* VOORBEELDLAB' });
    expect(s.inbox.tasks('2026-05-20').filter((t) => t.ref.bankTransactionId === tx.id)).toEqual([]);
    s.intake.confirm(doc.id, { supplier: 'Wolkendienst Inc.', date: '2026-05-06', total: 8333, invoiceNumber: 'WLK-0042', categoryKey: 'software', vatCode: 'buiten-eu', business: true, paidWith: 'bank' });
    expect(s.bank.get(tx.id).status).toBe('gematcht');
    const purchase = s.purchases.list().find((p) => p.supplier_reference === 'WLK-0042')!;
    expect(purchase.status).toBe('betaald');
  });

  it('"Nee": niet meer voorstellen; de bon en de betaling komen apart terug', async () => {
    const { s, api, doc, tx } = await world();
    const card = s.inbox.tasks('2026-05-20').find((t) => t.ref.documentId === doc.id)!;
    await api.home.act(card, 'betaling-nee');
    const tasks = s.inbox.tasks('2026-05-20');
    expect(tasks.find((t) => t.ref.documentId === doc.id)!.payment).toBeUndefined();
    expect(tasks.filter((t) => t.ref.bankTransactionId === tx.id)).toHaveLength(1);
  });

  it('twee betalingen die passen: geen voorstel (de gebruiker kiest zelf)', async () => {
    const { s, doc } = await world();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-05-08', amount: -8600, description: 'ANDERE DIENST', counterName: 'ANDERE DIENST' }] });
    expect(s.intake.possiblePayment(s.intake.get(doc.id))).toBeNull();
    expect(s.inbox.tasks('2026-05-20').find((t) => t.ref.documentId === doc.id)!.payment).toBeUndefined();
  });
});
