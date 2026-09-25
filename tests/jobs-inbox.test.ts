import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { vatDeadline } from '../src/inbox/inbox';

describe('klussen', () => {
  it('offerte → akkoord → klus → klaar → factuur', () => {
    const { s, klant } = setup();
    const q = s.quotes.create({ relationId: klant.id, reference: 'Woonkamer schilderen', lines: [{ description: 'Woonkamer schilderen', quantity: 42, unit: 'm²', unitPrice: 2400, vatCode: 'hoog' }, { description: 'Materiaal', quantity: 1, unitPrice: 18000, vatCode: 'hoog' }] });
    const job = s.jobs.acceptQuote(q.id);
    expect(job).toMatchObject({ title: 'Woonkamer schilderen', status: 'gepland', quoted: 42 * 2400 + 18000 });
    expect(s.jobs.acceptQuote(q.id).id).toBe(job.id); // idempotent
    s.quick.recordExpense({ date: '2026-09-02', supplierName: 'Sikkens', description: 'Verf', categoryKey: 'materiaal', grossAmount: 12100, vatCode: 'hoog', paidWith: 'kas', jobId: job.id });
    s.jobs.setStatus(job.id, 'klaar');
    const tasks = s.inbox.tasks('2026-09-25');
    expect(tasks.find((t) => t.kind === 'job-done')?.ref.jobId).toBe(job.id);
    const inv = s.jobs.makeInvoice(job.id);
    expect(inv.lines).toHaveLength(2);
    const after = s.jobs.get(job.id);
    expect(after).toMatchObject({ status: 'gefactureerd', invoiced: 42 * 2400 + 18000, costs: 10000 });
  });
});

describe('inbox: "Ben ik bij?"', () => {
  it('lege administratie is bij, op het eerste bankafschrift na', () => {
    const { s } = setup();
    s.settings.update({ onboardingDone: true });
    expect(s.inbox.tasks('2026-09-25').map((t) => t.kind)).toEqual(['bank-stale']);
    s.settings.update({ profile: { ...s.settings.get().profile, hasBusinessAccount: false } });
    const home = s.inbox.home('2026-09-25');
    expect(home.upToDate).toBe(true);
    expect(home.checklist.every((c) => c.ok)).toBe(true);
  });

  it('toont per rekening de laatste import en de periode, en waarschuwt als de bank verouderd is', () => {
    const { s } = setup();
    s.settings.update({ onboardingDone: true });
    const r1 = s.bank.import({ source: 'csv', warnings: [], transactions: [
      { date: '2026-08-01', amount: 100, description: 'a' },
      { date: '2026-08-31', amount: 200, description: 'b' },
    ] }, { filename: 'augustus.csv' });
    expect(r1.periods).toEqual([{ bankAccountId: 1, from: '2026-08-01', to: '2026-08-31' }]);
    // tweede afschrift overlapt: alleen dubbelen + één nieuwe
    s.bank.import({ source: 'mt940', warnings: [], transactions: [
      { date: '2026-08-31', amount: 200, description: 'b' },
      { date: '2026-09-10', amount: 300, description: 'c' },
    ] }, { filename: 'sept.sta' });
    const [st] = s.bank.importStatus();
    expect(st).toMatchObject({ coverageFrom: '2026-08-01', coverageTo: '2026-09-10', totalTransactions: 3 });
    expect(st!.lastImport).toMatchObject({ filename: 'sept.sta', from: '2026-08-31', to: '2026-09-10', transactions: 2, imported: 1, duplicates: 1 });
    expect(s.inbox.tasks('2026-09-20').some((t) => t.kind === 'bank-stale')).toBe(false);
    const stale = s.inbox.tasks('2026-09-25').find((t) => t.kind === 'bank-stale')!;
    expect(stale.title).toContain('t/m 10 september 2026');
    expect(s.inbox.home('2026-09-25').bankUpdatedTo).toBe('2026-09-10');
  });

  it('stelt alleen vragen over uitzonderingen en leert van antwoorden', () => {
    const { s, klant } = setup();
    s.settings.update({ onboardingDone: true });
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-09-01', lines: [{ description: 'x', quantity: 1, unitPrice: 120000, vatCode: 'hoog' }] }).id);
    s.relations.update(klant.id, { iban: null });
    s.bank.import({
      source: 'csv',
      warnings: [],
      transactions: [
        { date: '2026-09-10', amount: 145200, description: 'betaling', counterName: 'J. de Vries' },
        { date: '2026-09-11', amount: -8430, description: 'Pinbetaling', counterName: 'PRAXIS UTRECHT' },
        { date: '2026-09-12', amount: -85000, description: 'Overboeking', counterName: 'Onbekend' },
      ],
    });
    const tasks = s.inbox.tasks('2026-09-12');
    const kinds = tasks.map((t) => t.kind);
    expect(kinds).toEqual(['bank-business', 'bank-business', 'bank-invoice']);
    const pay = tasks.find((t) => t.kind === 'bank-invoice')!;
    expect(pay.question).toContain(inv.number!);
    s.bank.matchInvoice(pay.ref.bankTransactionId!, pay.ref.invoiceId!);

    const praxis = tasks.find((t) => t.title.startsWith('PRAXIS'))!;
    expect(praxis.ref.categoryKey).toBe('materiaal');
    s.inbox.answerBank(praxis.ref.bankTransactionId!, { business: true, categoryKey: 'materiaal' });
    expect(s.ledger.balance('WKprInkMat')).toBe(6967);

    // Tweede en derde Praxis-betaling: eerst voorstellen, dan automatisch
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-15', amount: -24300, description: 'Pin', counterName: 'PRAXIS UTRECHT' }] });
    const second = s.inbox.tasks('2026-09-15').find((t) => t.amount === -24300)!;
    expect(second).toMatchObject({ kind: 'bank-category', question: 'We denken dat dit materiaal is.' });
    s.inbox.answerBank(second.ref.bankTransactionId!, { business: true, categoryKey: 'materiaal' });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-16', amount: -8700, description: 'Pin', counterName: 'PRAXIS UTRECHT' }] });
    // nog niet automatisch: pas na 3× dezelfde keuze vragen we het, en pas na "ja" doen we het (#22)
    expect(s.inbox.autoProcess('2026-09-16')).toMatchObject({ booked: 0 });
    const third = s.inbox.tasks('2026-09-16').find((t) => t.amount === -8700)!;
    s.inbox.answerBank(third.ref.bankTransactionId!, { business: true, categoryKey: 'materiaal' });
    const ask = s.inbox.tasks('2026-09-16').find((t) => t.kind === 'supplier-auto')!;
    expect(ask.actions.map((a) => a.id)).toEqual(['ja', 'nee']);
    s.memory.setAutomatic(ask.ref.supplierKey!, true);
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-16', amount: -8800, description: 'Pin', counterName: 'PRAXIS UTRECHT' }] });
    expect(s.inbox.autoProcess('2026-09-16')).toMatchObject({ booked: 1 });
    expect(s.inbox.home('2026-09-16').automated[0]!.summary).toContain('PRAXIS');
    expect(s.inbox.tasks('2026-09-16').some((t) => t.amount === -8800)).toBe(false);

    const onbekend = s.inbox.tasks('2026-09-16').find((t) => t.amount === -85000)!;
    s.inbox.answerBank(onbekend.ref.bankTransactionId!, { business: false });
    expect(s.ledger.balance(ACCOUNTS.priveOpnamen)).toBe(85000);
    const home = s.inbox.home('2026-09-16');
    expect(home.checklist[0]).toMatchObject({ ok: true });
    expect(home.money.toReceive).toBe(0);
  });

  it('herinnert aan de BTW-aangifte met deadline', () => {
    const { s, klant } = setup();
    s.settings.update({ onboardingDone: true });
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-08-01', lines: [{ description: 'x', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] }).id);
    s.invoices.registerPayment(s.invoices.list()[0]!.id, { amount: 121000, date: '2026-08-05' });
    const t = s.inbox.tasks('2026-10-02').find((x) => x.kind === 'vat-due')!;
    expect(t.title).toBe('BTW 3e kwartaal 2026 aangeven');
    expect(t.question).toContain('31 oktober 2026');
    expect(s.inbox.home('2026-10-02').money.vatReserve).toBe(21000);
    s.vat.markSubmitted('2026-Q3');
    expect(s.inbox.tasks('2026-10-02').some((x) => x.kind === 'vat-due')).toBe(false);
    expect(s.inbox.home('2026-10-02').money.vatReserve).toBe(21000); // nog niet betaald
    expect(vatDeadline('2026-12-31', 'kwartaal')).toBe('2027-01-31');
    expect(vatDeadline('2026-02-28', 'maand')).toBe('2026-03-31');
  });
});
