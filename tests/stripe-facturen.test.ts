import { describe, expect, it } from 'vitest';
import { parseDocumentText, toLines } from '../src/intake/text-parser';
import { vatFromDocument } from '../src/intake/classify';
import { setup } from './helpers';
import { makePdf } from './pdf';
import type { FetchLike } from '../src/integrations/types';

/**
 * Facturen en betaalbewijzen die Stripe maakt (Vercel, Render, Supabase, ...): de verkoper en de klant
 * staan in twee kolommen naast elkaar, bedragen in dollars, vaak "reverse charge".
 */
const parse = (lines: string[]) => parseDocumentText(lines.map((text) => ({ text, page: 1 })), 'pdf-text');

const invoice = [
  'Invoice',
  'Invoice number QX7ZTR2K-0003',
  'Date of issue August 23, 2026',
  'Date due August 23, 2026',
  'Billing period Jul 1 - Jul 31, 2026',
  'Voorbeeld Cloud Services, Inc dba Wolkje (@wolkje) Bill to',
  '1309 Main Avenue user_8Hk2PqZ',
  'Sheridan, Wyoming 82801 Middelweg 1',
  'United States Netherlands',
  'NL VAT NL123456789B01',
  '$18.00 USD due August 23, 2026',
  'Description Qty Unit price Amount',
  'Pro plan 1 $18.00 $18.00',
  'Subtotal $18.00',
  'Total $18.00',
  'Amount due $18.00 USD',
  'This invoice is subject to the reverse charge mechanism, if applicable.',
];

describe('facturen van Stripe', () => {
  it('verkoper links van "Bill to" (handelsnaam, zonder @naam), geen adres of kopje', () => {
    const r = parse(invoice);
    expect(r.supplier?.value).toBe('Wolkje');
    expect(r.invoiceNumber?.value).toBe('QX7ZTR2K-0003');
    expect(r.total?.value).toBe(1800);
    expect(r.currency.value).toBe('USD');
    expect(r.supplierCountry?.value).toBe('US');
  });

  it('zonder "dba": de naam zoals hij er staat', () => {
    const r = parse(invoice.map((l) => l.replace('Voorbeeld Cloud Services, Inc dba Wolkje (@wolkje)', 'MOONLIGHT AI PTE. LTD.').replace('United States', 'Singapore')));
    expect(r.supplier?.value).toBe('MOONLIGHT AI PTE. LTD.');
    expect(r.supplierCountry?.value).toBe('SG');
    expect(vatFromDocument(r)).toBe('buiten-eu');
  });

  it('betaalbewijs: "Amount paid" is het totaal, "paid via Stripe" is niet de leverancier', () => {
    const r = parse([
      'RECEIPT',
      'rekenkracht.ai',
      '900 Example Drive',
      'San Mateo, CA 94402',
      'United States',
      'Bill to: Invoice number VODXYZ-00002',
      'Amount paid $50.00',
      'Description Quantity Rate Amount',
      'Credits top-up 50 $1.00 $50.00',
      'Subtotal $50.00',
      'Amount paid $50.00',
      'Memo:',
      '(paid via Stripe)',
      'VAT reverse charge applies.',
    ]);
    expect(r.supplier?.value).toBe('rekenkracht.ai');
    expect(r.total?.value).toBe(5000);
    expect(r.reverseCharge).toBe(true);
    expect(vatFromDocument(r)).toBe('buiten-eu');
  });

  it('alleen het bedrag bovenaan ("$5.00 USD due ..."): dat is het totaal', () => {
    const r = parse(invoice.filter((l) => !/^(Subtotal|Total|Amount due|Pro plan)/.test(l)).map((l) => l.replace('$18.00 USD due', '$5.00 USD due')));
    expect(r.total?.value).toBe(500);
  });

  it('"VAT - Netherlands 21% on $5.00" met de btw in een eigen kolom erboven', () => {
    const r = parse(['Invoice', 'Starter 1 $5.00 21% $5.00', 'Subtotal $5.00', 'Total excluding tax $5.00', '$1.05', 'VAT - Netherlands 21% on $5.00', '€0.92', 'Total $6.05']);
    expect(r.vat.value).toEqual([{ rate: 21, base: 500, amount: 105 }]);
    expect(r.total?.value).toBe(605);
    expect(vatFromDocument(r)).toBe('hoog');
  });

  it('"(Includes VAT of € 1,73)": 21% eruit gerekend; incl. btw is nooit verlegd', () => {
    const r = parse(['Google Play', 'Order date: Sep 27, 2026', 'Total: € 9,99/month', '(Includes VAT of € 1,73)', 'Google Commerce Limited', 'Dublin 4', 'Ireland']);
    expect(r.vat.value).toEqual([{ rate: 21, base: 826, amount: 173 }]);
    expect(r.supplierCountry ?? null).toBeNull();
    expect(vatFromDocument(r)).toBe('hoog');
  });

  it('stukjes die tegen elkaar staan zijn één woord ("P6AR" "-" "0001"), met ruimte ertussen twee', () => {
    const lines = toLines([
      { text: 'Invoice', page: 1, bbox: [0, 0, 40, 10] },
      { text: 'number', page: 1, bbox: [43, 0, 80, 10] },
      { text: 'QX7ZTR2K', page: 1, bbox: [90, 0, 140, 10] },
      { text: '-', page: 1, bbox: [140, 0, 143, 10] },
      { text: '0003', page: 1, bbox: [143.5, 0, 165, 10] },
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Invoice number QX7ZTR2K-0003']);
  });

  it('je eigen btw-nummer bij "Bill to" telt niet als dat van de leverancier: verlegd van buiten de EU', async () => {
    const { s } = setup();
    s.settings.update({ onboardingDone: true });
    const doc = await s.intake.add('Invoice-QX7ZTR2K-0003.pdf', makePdf(invoice), '2026-08-25', { autoConfirm: false });
    expect(doc.result?.supplierVatNumber ?? null).toBeNull();
    expect(doc.result?.supplier?.value).toBe('Wolkje');
    expect(doc.classification?.vatCode).toBe('buiten-eu');
  });

  it('betaling al rechtstreeks geboekt: de factuur wordt bewijsstuk, ook bij een andere schrijfwijze en 13 dagen later betaald', async () => {
    const csv = ['KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE', 'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-07-31,1.1000'].join('\n');
    const ecb: FetchLike = (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => csv })) as FetchLike;
    const { s } = setup({ fetch: ecb });
    s.settings.update({ onboardingDone: true });
    const card = s.bank.ensureDefaultAccount();
    // $ 55,00 → ongeveer € 50,00; met de kaart betaald op 14 augustus, "Elevenlabs" op het afschrift
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-08-14', amount: -5040, description: 'Card Payment: Elevenlabs', counterName: 'Elevenlabs' }] }, { bankAccountId: card.id });
    const tx = s.bank.list({ status: 'nieuw' })[0]!;
    s.inbox.answerBank(tx.id, { business: true, categoryKey: 'software', vatCode: 'buiten-eu' });
    const entries = s.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number };
    const lines = ['Invoice', 'Invoice number EL55AA01-0007', 'Date of issue August 1, 2026', 'Eleven Labs Inc. @elevenlabs Bill to', '169 Example Ave Shipdocs', 'United States Netherlands', 'Description Qty Unit price Amount', 'Creator 1 $55.00 $55.00', 'Total $55.00', 'Amount due $55.00 USD'];
    const doc = await s.intake.add('Invoice-EL55AA01-0007.pdf', makePdf(lines), '2026-08-20', { autoConfirm: false });
    expect(doc.status).toBe('verwerkt');
    expect(doc.classification?.reasons.join(' ')).toMatch(new RegExp(`banktransactie #${tx.id}`));
    expect(s.purchases.list()).toHaveLength(0);
    expect((s.db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as { n: number }).n).toBe(entries.n);
  });
});
