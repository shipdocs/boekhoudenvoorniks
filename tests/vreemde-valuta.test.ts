import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { makePdf } from './pdf';
import { detectCurrency, formatForeign, withinFx } from '../src/shared/currency';
import { parseEcbCsv } from '../src/fx/fx';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import type { FetchLike } from '../src/integrations/types';

const CSV = [
  'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE',
  'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-05-04,1.0750',
  'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-05-05,1.0800',
].join('\n');

function ecb(): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({}), text: async () => CSV };
  }) as FetchLike & { calls: string[] };
  f.calls = calls;
  return f;
}

const INVOICE = ['Invoice', 'Invoice number ABCD-0005', 'Date of issue May 6, 2026', 'Anthropic, PBC', 'Max plan 1 $90.00', 'Total $90.00', 'Amount due $90.00 USD', 'Tax to be paid on reverse charge basis'];

describe('vreemde valuta (#74)', () => {
  it('munt herkennen: dollars, ponden; een gewone bon is euro', () => {
    expect(detectCurrency('Total $90.00\nAmount due $90.00 USD').code).toBe('USD');
    expect(detectCurrency('Total £12.50').code).toBe('GBP');
    expect(detectCurrency('Totaal 12,50\nPIN').code).toBe('EUR');
    expect(detectCurrency('Totaal €12,50 (US$ 13,50)').code).toBe('EUR');
    expect(detectCurrency('Total CA$ 20.00').code).toBe('CAD');
    expect(formatForeign(9000, 'USD')).toBe('$ 90,00');
    expect(withinFx(8400, 8333)).toBe(true);
    expect(withinFx(9000, 8333)).toBe(false);
  });

  it('ECB-koers: ophalen, bewaren en niet opnieuw ophalen; zonder internet null', async () => {
    expect(parseEcbCsv(CSV)).toEqual([{ date: '2026-05-04', rate: 1.075 }, { date: '2026-05-05', rate: 1.08 }]);
    const fetch = ecb();
    const { s } = setup({ fetch });
    expect(await s.fx.rateFor('USD', '2026-05-06')).toEqual({ currency: 'USD', rate: 1.08, date: '2026-05-05' });
    expect(await s.fx.rateFor('USD', '2026-05-05')).toMatchObject({ rate: 1.08 });
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toContain('D.USD.EUR.SP00.A');
    const offline = setup();
    expect(await offline.s.fx.rateFor('USD', '2026-05-06')).toBeNull();
  });

  it('bon in dollars, betaling al op de bank: het bedrag van de bank telt', async () => {
    const { s } = setup({ fetch: ecb() });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-05-07', amount: -8312, description: 'CLAUDE.AI SUBSCRIPTION USD 90,00', counterName: 'ANTHROPIC' }] });
    const doc = await s.intake.add('invoice.pdf', makePdf(INVOICE), '2026-05-08', { autoConfirm: false });
    expect(doc.result?.foreign).toMatchObject({ currency: 'USD', total: 9000, source: 'bank' });
    expect(doc.result?.total?.value).toBe(8312);
    expect(doc.bank_match?.amount).toBe(-8312);
    s.intake.confirm(doc.id, { supplier: 'Anthropic', date: '2026-05-06', total: 8312, categoryKey: 'software', vatCode: 'buiten-eu', business: true, paidWith: 'bank' });
    const p = s.purchases.list()[0]!;
    expect(p).toMatchObject({ currency: 'USD', foreign_total: 9000, status: 'betaald', total: 8312 });
    expect(s.ledger.balance(ACCOUNTS.koersverschillen) === 0).toBe(true);
    // btw verlegd van buiten de EU: grondslag in euro's
    expect(s.vat.calculate('2026-Q2').rubrieken.find((r) => r.code === '4a')!.omzet).toBe(8312);
  });

  it('nog geen betaling: geschat met de ECB-koers; later betaald met een iets andere koers = koersverschil', async () => {
    const { s } = setup({ fetch: ecb() });
    const doc = await s.intake.add('invoice.pdf', makePdf(INVOICE), '2026-05-08');
    expect(doc.result?.foreign).toMatchObject({ currency: 'USD', total: 9000, source: 'ecb', rate: 1.08, rateDate: '2026-05-05' });
    expect(doc.result?.total?.value).toBe(8333); // 90 / 1,08
    expect(doc.status).toBe('controle'); // geschat: niet vanzelf verwerken
    // omgerekend: geen foutmelding "niet in euro's", alleen de uitleg over de schatting
    expect(doc.issues.some((i) => i.field === 'currency')).toBe(false);
    expect(doc.issues.some((i) => i.severity === 'fout')).toBe(false);
    s.intake.confirm(doc.id, { supplier: 'Anthropic', date: '2026-05-06', total: 8333, categoryKey: 'software', vatCode: 'buiten-eu', business: true, paidWith: 'later' });
    const p = s.purchases.list()[0]!;
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-05-09', amount: -8400, description: 'ANTHROPIC USD 90,00', counterName: 'ANTHROPIC' }] });
    const t = s.bank.list({ status: 'nieuw' })[0]!;
    const sug = s.matching.suggest(t).find((x) => x.kind === 'inkoop');
    expect(sug?.reasons.join(' ')).toMatch(/andere koers/);
    s.bank.matchPurchase(t.id, p.id);
    expect(s.purchases.get(p.id).status).toBe('betaald');
    expect(s.ledger.balance(ACCOUNTS.koersverschillen)).toBe(67); // 0,67 meer betaald: kosten
    expect(s.ledger.balance(ACCOUNTS.crediteuren) === 0).toBe(true);
    // ongedaan maken zet alles terug
    s.bank.unmatch(t.id);
    expect(s.purchases.get(p.id)).toMatchObject({ status: 'open', amount_paid: 0 });
    expect(s.ledger.balance(ACCOUNTS.koersverschillen) === 0).toBe(true);
  });

  it('omrekenen houdt subtotaal + btw = totaal (geen afrondingsverschil)', async () => {
    const { s } = setup({ fetch: ecb() });
    const doc = await s.intake.add('bon.pdf', makePdf(['Shop Inc', 'Date May 6, 2026', 'Subtotal $10.01', 'VAT 21% $2.10', 'Total $12.11']), '2026-05-08', { autoConfirm: false });
    const r = doc.result!;
    expect(r.foreign?.currency).toBe('USD');
    const vat = r.vat.value.reduce((x, v) => x + v.amount, 0);
    if (r.subtotal) expect(r.subtotal.value + vat).toBe(r.total!.value);
  });

  it('geen internet: geen gok in euro\'s, de gebruiker vult het bedrag in', async () => {
    const { s } = setup();
    const doc = await s.intake.add('invoice.pdf', makePdf(INVOICE), '2026-05-08');
    expect(doc.result?.foreign).toMatchObject({ currency: 'USD', total: 9000, rate: null, source: null });
    expect(doc.result?.total).toBeNull();
    expect(doc.issues.some((i) => /in dollars/.test(i.message))).toBe(true);
  });
});
