import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { setup } from './helpers';
import { makePdf } from './pdf';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { buildEpcPayload, parseEpcPayload, purchasePaymentQr, EPC_MAX_AMOUNT } from '../src/documents/epc-qr';
import { detectRun } from '../src/import/recurring';
import { addMonths } from '../src/shared/dates';

/** Rendert de QR-matrix naar pixels en leest hem terug met een onafhankelijke decoder. */
function decodeQr(payload: string): string | null {
  const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const scale = 4;
  const border = 4;
  const dim = (size + border * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!qr.modules.get(y, x)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + border) * scale + dy) * dim + (x + border) * scale + dx;
          data[px * 4] = data[px * 4 + 1] = data[px * 4 + 2] = 0;
        }
      }
    }
  }
  return jsQR(data, dim, dim)?.data ?? null;
}

describe('betalen met QR (#25)', () => {
  it('EPC-payload volgens EPC069-12, leesbaar voor een QR-decoder', () => {
    const payload = buildEpcPayload({ name: 'Bouwmaat Utrecht', iban: 'NL91 ABNA 0417 1643 00', amount: 84250, text: 'Factuur 2026-1234' });
    expect(payload.split('\n')).toEqual(['BCD', '002', '1', 'SCT', '', 'Bouwmaat Utrecht', 'NL91ABNA0417164300', 'EUR842.50', '', '', 'Factuur 2026-1234']);
    const decoded = decodeQr(payload);
    expect(decoded).toBe(payload);
    expect(parseEpcPayload(decoded!)).toMatchObject({ iban: 'NL91ABNA0417164300', amount: 84250, name: 'Bouwmaat Utrecht', text: 'Factuur 2026-1234' });
  });

  it('weigert te hoge bedragen, ongeldige IBANs en lege namen', () => {
    expect(() => buildEpcPayload({ name: 'X', iban: 'NL91ABNA0417164300', amount: EPC_MAX_AMOUNT + 1 })).toThrow(/te hoog/);
    expect(() => buildEpcPayload({ name: 'X', iban: 'NL91ABNA0417164301', amount: 100 })).toThrow(/Ongeldig IBAN/);
    expect(() => buildEpcPayload({ name: ' ', iban: 'NL91ABNA0417164300', amount: 100 })).toThrow(/naam/);
    expect(buildEpcPayload({ name: 'X', iban: 'NL91ABNA0417164300', amount: EPC_MAX_AMOUNT })).toContain('EUR999999999.99');
  });

  it('ander IBAN dan eerder bij deze leverancier: waarschuwing, geen QR zonder bevestiging', async () => {
    const { s } = setup();
    const lev = s.relations.findOrCreateSupplier('Bouwmaat', { iban: 'NL91ABNA0417164300' });
    const first = s.purchases.create({ relationId: lev.id, invoiceDate: '2026-09-01', dueDate: '2026-09-30', description: 'Gips', supplierReference: 'F-1', payeeIban: 'NL91ABNA0417164300', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 10000, vatCode: 'hoog' }] });
    const ok = await purchasePaymentQr(s.purchases, first.id);
    expect(ok.needsConfirm).toBe(false);
    const second = s.purchases.create({ relationId: lev.id, invoiceDate: '2026-09-10', dueDate: '2026-10-10', description: 'Gips', supplierReference: 'F-2', payeeIban: 'NL44RABO0123456789', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 20000, vatCode: 'hoog' }] });
    const warn = await purchasePaymentQr(s.purchases, second.id);
    expect(warn).toMatchObject({ needsConfirm: true, warning: expect.stringMatching(/ander rekeningnummer/) });
    expect('svg' in warn).toBe(false);
    const confirmed = await purchasePaymentQr(s.purchases, second.id, true);
    expect(confirmed.needsConfirm).toBe(false);
    if (!confirmed.needsConfirm) expect(parseEpcPayload(confirmed.payload)).toMatchObject({ iban: 'NL44RABO0123456789', amount: 24200, text: 'Factuur F-2' });
  });

  it('herinnert een paar dagen vóór de vervaldatum aan betalen', () => {
    const { s } = setup();
    s.settings.update({ onboardingDone: true });
    s.purchases.create({ invoiceDate: '2026-09-01', dueDate: '2026-10-14', description: 'Steiger', payeeIban: 'NL91ABNA0417164300', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 10000, vatCode: 'hoog' }] });
    expect(s.inbox.tasks('2026-10-01').some((t) => t.kind === 'purchase-due')).toBe(false);
    const task = s.inbox.tasks('2026-10-11').find((t) => t.kind === 'purchase-due')!;
    expect(task.question).toMatch(/vóór 14 oktober/);
  });
});

describe('vaste lasten (#30)', () => {
  const pay = (s: ReturnType<typeof setup>['s'], date: string, amount: number, name = 'KPN BV') =>
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount, description: 'Abonnement', counterName: name, counterIban: 'NL44RABO0123456789' }] });

  it('3 maandelijkse betalingen met ±5% verschil = een reeks; 2 niet', () => {
    expect(detectRun([{ date: '2026-06-03', amount: 6100 }, { date: '2026-07-03', amount: 6432 }, { date: '2026-08-02', amount: 6300 }])).toMatchObject({ interval: 'maand' });
    expect(detectRun([{ date: '2026-07-03', amount: 6432 }, { date: '2026-08-02', amount: 6300 }])).toBeNull();
    expect(detectRun([{ date: '2026-06-03', amount: 3000 }, { date: '2026-07-03', amount: 6432 }, { date: '2026-08-02', amount: 6300 }])).toBeNull(); // bedrag wijkt te veel af
    expect(detectRun([{ date: '2026-01-10', amount: 9000 }, { date: '2026-04-09', amount: 9000 }, { date: '2026-07-10', amount: 9100 }])).toMatchObject({ interval: 'kwartaal' });
  });

  it('bevestigen, ontbrekende factuur geeft één taak, en na 2 gemiste betalingen "gestopt?"', () => {
    const { s } = setup();
    s.settings.update({ onboardingDone: true });
    pay(s, '2026-06-03', -6100);
    pay(s, '2026-07-03', -6432);
    s.inbox.autoProcess('2026-07-10');
    expect(s.recurring.list()).toHaveLength(0);
    pay(s, '2026-08-03', -6300);
    s.inbox.autoProcess('2026-08-05');
    const ask = s.inbox.tasks('2026-08-05').find((t) => t.kind === 'recurring-confirm')!;
    expect(ask.title).toContain('KPN');
    s.recurring.confirm(ask.ref.seriesId!);
    // de betalingen zelf worden verwerkt (bv. als telefoon), maar er is geen factuur
    for (const t of s.bank.list({ status: 'nieuw' })) s.bank.bookToAccount(t.id, { account: 'WBedKanTel', vatCode: 'hoog' });
    const invoiceTasks = (d: string) => s.inbox.tasks(d).filter((t) => t.kind === 'recurring-invoice');
    // de betaling van 3 augustus: pas na 7 dagen, en elke dag dezelfde ene taak (stabiele sleutel)
    expect(invoiceTasks('2026-08-05').filter((t) => t.ref.bankTransactionId === s.bank.list({}).find((x) => x.transaction_date === '2026-08-03')!.id)).toHaveLength(0);
    const day1 = invoiceTasks('2026-08-12').map((t) => t.key);
    const day2 = invoiceTasks('2026-08-13').map((t) => t.key);
    expect(day1.length).toBeGreaterThan(0);
    expect(day2).toEqual(day1);
    s.inbox.skipTask(day1[0]!, 'geen factuur');
    expect(invoiceTasks('2026-08-13').map((t) => t.key)).not.toContain(day1[0]);
    // september niet afgeschreven → één melding; oktober ook niet → "gestopt?"
    expect(s.inbox.tasks('2026-09-12').find((t) => t.kind === 'recurring-missing-payment')).toBeDefined();
    expect(s.inbox.tasks('2026-09-12').find((t) => t.kind === 'recurring-stopped')).toBeUndefined();
    expect(s.inbox.tasks('2026-10-12').find((t) => t.kind === 'recurring-stopped')).toBeDefined();
    expect(s.inbox.tasks('2026-10-12').find((t) => t.kind === 'recurring-missing-payment')).toBeUndefined();
    const st = s.recurring.state(s.recurring.get(ask.ref.seriesId!), '2026-10-12');
    expect(st.monthly).toBe(6300);
    expect(st.missed).toHaveLength(2);
  });
});

describe('vaste lasten boeken automatisch (#30)', () => {
  it('een bevestigde reeks boekt nieuwe betalingen direct met de bekende categorie en btw', () => {
    const { s } = setup();
    s.settings.update({ onboardingDone: true });
    s.memory.learn('KPN BV', { categoryKey: 'telefoon', vatCode: 'hoog', business: true });
    for (const d of ['2026-06-03', '2026-07-03', '2026-08-03']) {
      s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: d, amount: -6050, description: 'Abonnement', counterName: 'KPN BV', counterIban: 'NL44RABO0123456789' }] });
    }
    s.inbox.autoProcess('2026-08-05');
    const series = s.recurring.list('voorgesteld')[0]!;
    expect(series).toMatchObject({ counter_name: 'KPN BV', category_key: 'telefoon', interval: 'maand' });
    s.recurring.confirm(series.id);
    expect(s.inbox.autoProcess('2026-08-05').booked).toBe(3);
    expect(s.bank.list({ status: 'nieuw' })).toHaveLength(0);
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(3 * 1050);
  });
});

describe('belastingpotje (#33)', () => {
  it('te reserveren btw = btw van de lopende en de nog niet betaalde periodes', () => {
    const { s, klant } = setup();
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-07-10', lines: [{ description: 'x', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] }).id);
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-10-10', lines: [{ description: 'y', quantity: 1, unitPrice: 50000, vatCode: 'hoog' }] }).id);
    s.vat.markSubmitted('2026-Q3'); // aangegeven, nog niet betaald
    const home = s.inbox.home('2026-10-15');
    const expected = s.vat.calculate('2026-Q4').summary.teBetalen - s.ledger.balance(ACCOUNTS.btwAfrekening);
    expect(home.money.vatReserve).toBe(expected);
    expect(home.money.vatReserve).toBe(21000 + 10500);
  });

  it('een overboeking naar het potje verhoogt "opzijgezet" zonder effect op de winst', () => {
    const { s } = setup();
    s.settings.update({ onboardingDone: true });
    const main = s.bank.ensureDefaultAccount('NL91ABNA0417164300');
    const pot = s.bank.addAccount('Btw-spaarrekening', 'NL44RABO0123456789');
    s.settings.update({ vatPotAccountId: pot.id });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-20', amount: -50000, description: 'Naar spaarrekening', counterIban: 'NL44RABO0123456789', counterName: 'Piet' }] }, { bankAccountId: main.id });
    const task = s.inbox.tasks('2026-09-21').find((t) => t.kind === 'bank-pot')!;
    expect(task).toBeDefined();
    const profitBefore = s.ledger.balances().filter((b) => b.category === 'omzet' || b.category === 'kosten').reduce((x, b) => x + b.balance, 0);
    s.bank.bookToAccount(task.ref.bankTransactionId!, { account: pot.rgs_code, description: 'Belastingpotje' });
    const profitAfter = s.ledger.balances().filter((b) => b.category === 'omzet' || b.category === 'kosten').reduce((x, b) => x + b.balance, 0);
    expect(profitAfter).toBe(profitBefore);
    expect(s.inbox.home('2026-09-21').money.vatPot).toMatchObject({ setAside: 50000 });
  });
});

describe('review-bevindingen #40', () => {
  it('alleen een ISO 11649-referentie in het gestructureerde veld; een ander kenmerk gaat als omschrijving mee', () => {
    const base = { name: 'Bouwmaat', iban: 'NL91ABNA0417164300', amount: 1000 };
    expect(buildEpcPayload({ ...base, reference: 'RF18 5390 0754 7034' }).split('\n')[9]).toBe('RF18539007547034');
    const nl = buildEpcPayload({ ...base, reference: '1234 5678 9012 3456' }).split('\n');
    expect(nl[9]).toBe('');
    expect(nl[10]).toBe('1234 5678 9012 3456');
    expect(buildEpcPayload({ ...base, reference: 'RF19 5390 0754 7034' }).split('\n')[10]).toBe('RF19 5390 0754 7034'); // controlegetal fout
  });

  it('addMonths geeft altijd een geldige ISO-datum', () => {
    expect(addMonths('0001-01-15', -1)).toBe('0000-12-15');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2100-01-31', 1)).toBe('2100-02-28');
  });

  it('een overgeslagen afschrijving tussen twee betalingen wordt gemeld', () => {
    const { s } = setup();
    s.settings.update({ onboardingDone: true });
    const kpn = (d: string) => s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: d, amount: -6100, description: 'Abonnement', counterName: 'KPN BV', counterIban: 'NL44RABO0123456789' }] });
    for (const d of ['2026-03-03', '2026-04-03', '2026-05-04']) kpn(d);
    s.inbox.autoProcess('2026-05-06');
    const ask = s.inbox.tasks('2026-05-06').find((t) => t.kind === 'recurring-confirm')!;
    s.recurring.confirm(ask.ref.seriesId!);
    // juni ontbreekt, juli en augustus weer wel
    for (const d of ['2026-07-03', '2026-08-03']) kpn(d);
    const st = s.recurring.state(s.recurring.get(ask.ref.seriesId!), '2026-08-05');
    expect(st.missed).toEqual([]);
    expect(st.gaps).toEqual(['2026-06-04']);
    const t = s.inbox.tasks('2026-08-05').filter((x) => x.kind === 'recurring-missing-payment');
    expect(t.map((x) => x.key)).toEqual([`recurring-pay-${ask.ref.seriesId}-2026-06-04`]);
  });

  it('geld terug uit het belastingpotje is geen omzet', () => {
    const { s } = setup();
    s.settings.update({ onboardingDone: true });
    const main = s.bank.ensureDefaultAccount('NL91ABNA0417164300');
    const pot = s.bank.addAccount('Btw-spaarrekening', 'NL44RABO0123456789');
    s.settings.update({ vatPotAccountId: pot.id });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-10-20', amount: 300000, description: 'Van spaarrekening', counterIban: 'NL44RABO0123456789', counterName: 'Piet' }] }, { bankAccountId: main.id });
    const tasks = s.inbox.tasks('2026-10-21');
    expect(tasks.find((t) => t.kind === 'bank-pot')?.title).toMatch(/uit je belastingpotje/);
    expect(tasks.find((t) => t.kind === 'bank-income')).toBeUndefined();
  });

  it('een ontbrekende factuur kan direct aan de afschrijving gekoppeld worden', async () => {
    const { s } = setup();
    s.settings.update({ onboardingDone: true });
    for (const d of ['2026-06-03', '2026-07-03', '2026-08-03']) {
      s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: d, amount: -6100, description: 'Abonnement', counterName: 'KPN BV', counterIban: 'NL44RABO0123456789' }] });
    }
    s.inbox.autoProcess('2026-08-05');
    const ask = s.inbox.tasks('2026-08-05').find((t) => t.kind === 'recurring-confirm')!;
    s.recurring.confirm(ask.ref.seriesId!);
    for (const t of s.bank.list({ status: 'nieuw' })) s.bank.bookToAccount(t.id, { account: 'WBedKanTel', vatCode: 'hoog' });
    const before = s.inbox.tasks('2026-08-12').filter((t) => t.kind === 'recurring-invoice');
    expect(before.length).toBeGreaterThan(0);
    const txId = before[0]!.ref.bankTransactionId!;
    const doc = await s.intake.addEvidence('kpn-juni.pdf', makePdf(['KPN B.V.', 'Factuur 2026-06', 'Totaal 61,00']), txId);
    expect(doc.status).toBe('verwerkt');
    expect(s.inbox.tasks('2026-08-12').filter((t) => t.kind === 'recurring-invoice').map((t) => t.ref.bankTransactionId)).not.toContain(txId);
    expect(s.purchases.list()).toHaveLength(0); // niet dubbel geboekt
  });
});
