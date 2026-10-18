import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { setup } from './helpers';
import { makePdf } from './pdf';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { scaleLines, expenseLines } from '../src/documents/purchases';
import type { FetchLike } from '../src/integrations/types';
import type { DocumentResult } from '../src/intake/types';

/**
 * Vreemde valuta in wat er al stond (#74): bonnen en aankopen van vóór 0.3.9, toen de app "$ 90,00"
 * als € 90,00 las. Zulke gegevens maken we hier na door het leesresultaat terug te zetten naar euro.
 */

const CSV = ['KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE', 'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-05-05,1.0800'].join('\n');
const ecb: FetchLike = (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => CSV })) as FetchLike;
const INVOICE = ['Invoice', 'Invoice number ABCD-0005', 'Date of issue May 6, 2026', 'Anthropic, PBC', 'Max plan 1 $90.00', 'Total $90.00', 'Amount due $90.00 USD', 'Tax to be paid on reverse charge basis'];

type S = ReturnType<typeof setup>['s'];

/** Een bon zoals versie 0.3.8 hem opsloeg: munt euro, het dollarbedrag als euro's. */
async function oldDocument(s: S, lines = INVOICE): Promise<number> {
  const data = makePdf(lines);
  const { result } = await s.intake.extract('invoice.pdf', data);
  const old: DocumentResult = { ...result, currency: { value: 'EUR', confidence: 0.6, source: 'pdf-text' } };
  delete old.foreign;
  const sha = createHash('sha256').update(data).digest('hex');
  return Number(
    s.db
      .prepare(`INSERT INTO documents (file_path, original_name, mime_type, sha256, extraction_source, result, status) VALUES (?, ?, 'application/pdf', ?, 'pdf-text', ?, 'controle')`)
      .run('/tmp/test-bijlagen/invoice.pdf', 'invoice.pdf', sha, JSON.stringify(old)).lastInsertRowid,
  );
}

/** Een aankoop zoals versie 0.3.8 hem boekte: $ 90,00 als € 90,00. */
async function oldPurchase(s: S): Promise<number> {
  const id = await oldDocument(s);
  s.intake.confirm(id, { supplier: 'Anthropic', date: '2026-05-06', total: 9000, categoryKey: 'software', vatCode: 'buiten-eu', business: true, paidWith: 'later' });
  const p = s.purchases.list()[0]!;
  expect(p).toMatchObject({ total: 9000, currency: null });
  return p.id;
}

const debit = (s: S, amount: number, date = '2026-05-07') =>
  s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount: -amount, description: 'CLAUDE.AI SUBSCRIPTION USD 90,00', counterName: 'ANTHROPIC' }] });

describe('vreemde valuta in bestaande gegevens (#74)', () => {
  it('bon die nog gecontroleerd moet worden: opnieuw beoordeeld en gekoppeld aan de afschrijving', async () => {
    const { s } = setup({ fetch: ecb });
    debit(s, 8312);
    const id = await oldDocument(s);
    expect(s.fxRepair.pendingDocuments()).toEqual([id]);
    expect(await s.fxRepair.fixDocuments('2026-05-08')).toBe(1);
    const d = s.intake.get(id);
    expect(d.result?.foreign).toMatchObject({ currency: 'USD', total: 9000, source: 'bank' });
    expect(d.result?.total?.value).toBe(8312);
    expect(d.bank_match?.amount).toBe(-8312);
    expect(d.status).toBe('controle'); // nooit vanzelf boeken
    expect(s.fxRepair.pendingDocuments()).toEqual([]);
  });

  it('op de achtergrond zonder internet: de bon blijft staan tot de koers er is', async () => {
    const { s } = setup();
    const id = await oldDocument(s);
    expect(await s.fxRepair.fixDocuments('2026-05-08', { needRate: true })).toBe(0);
    expect(s.fxRepair.pendingDocuments()).toEqual([id]);
    expect(s.intake.get(id).result?.total?.value).toBe(9000);
  });

  it('geboekte aankoop, afschrijving nog niet verwerkt: omrekenen naar het bankbedrag en koppelen', async () => {
    const { s } = setup({ fetch: ecb });
    const pid = await oldPurchase(s);
    debit(s, 8312);
    expect(s.fxRepair.candidates()).toMatchObject([{ purchaseId: pid, currency: 'USD', foreignTotal: 9000, bookedTotal: 9000 }]);
    const pr = await s.fxRepair.preview(pid);
    expect(pr).toMatchObject({ euroTotal: 8312, source: 'bank', blocker: null, alreadyBooked: null });
    expect(pr.bankTransactionId).toBe(s.bank.list({ status: 'nieuw' })[0]!.id);
    s.fxRepair.apply(pid, { currency: 'USD', foreignTotal: 9000, euroTotal: 8312, bankTransactionId: pr.bankTransactionId });
    expect(s.purchases.get(pid)).toMatchObject({ total: 8312, currency: 'USD', foreign_total: 9000, status: 'betaald' });
    expect(s.bank.list({ status: 'nieuw' })).toHaveLength(0);
    expect(s.ledger.balance(ACCOUNTS.crediteuren) === 0).toBe(true);
    expect(s.ledger.balance(ACCOUNTS.koersverschillen) === 0).toBe(true);
    expect(s.vat.calculate('2026-Q2').rubrieken.find((r) => r.code === '4a')!.omzet).toBe(8312);
    expect(s.fxRepair.candidates()).toEqual([]);
    // de bon toont nu het bedrag in dollars en in euro's
    expect(s.intake.get(s.purchases.get(pid).document_id!).result?.foreign).toMatchObject({ currency: 'USD', total: 9000, source: 'bank' });
  });

  it('afschrijving intussen anders verwerkt: niets omgerekend, opnieuw nakijken', async () => {
    const { s } = setup({ fetch: ecb });
    const pid = await oldPurchase(s);
    debit(s, 8312);
    const pr = await s.fxRepair.preview(pid);
    s.bank.ignore(pr.bankTransactionId!);
    expect(() => s.fxRepair.apply(pid, { currency: 'USD', foreignTotal: 9000, euroTotal: 8312, bankTransactionId: pr.bankTransactionId })).toThrow(/intussen anders verwerkt/);
    expect(s.purchases.get(pid)).toMatchObject({ total: 9000, currency: null });
  });

  it('geboekte aankoop die al deels betaald staat (bank € 83,12 op € 90,00): wordt helemaal betaald', async () => {
    const { s } = setup({ fetch: ecb });
    const pid = await oldPurchase(s);
    debit(s, 8312);
    s.bank.matchPurchase(s.bank.list({ status: 'nieuw' })[0]!.id, pid);
    expect(s.purchases.get(pid)).toMatchObject({ status: 'open', amount_paid: 8312 });
    const pr = await s.fxRepair.preview(pid);
    expect(pr).toMatchObject({ euroTotal: 8312, source: 'bank', linkedPayment: true, blocker: null });
    s.fxRepair.apply(pid, { currency: 'USD', foreignTotal: 9000, euroTotal: 8312 });
    expect(s.purchases.get(pid)).toMatchObject({ total: 8312, status: 'betaald', currency: 'USD' });
    expect(s.ledger.balance(ACCOUNTS.crediteuren) === 0).toBe(true);
  });

  it('betaling al rechtstreeks als kosten geboekt: de aankoop was dubbel en vervalt, de bon wordt het bewijsstuk', async () => {
    const { s } = setup({ fetch: ecb });
    debit(s, 8312);
    const t = s.bank.list({ status: 'nieuw' })[0]!;
    s.bank.bookToAccount(t.id, { account: 'WBedKanSof', vatCode: 'buiten-eu' });
    const pid = await oldPurchase(s);
    const costsBefore = s.ledger.balance('WBedKanSof');
    expect(costsBefore).toBe(8312 + 9000); // dubbel
    const pr = await s.fxRepair.preview(pid);
    expect(pr.alreadyBooked).toMatchObject({ bankTransactionId: t.id, amount: 8312 });
    const docId = s.purchases.get(pid).document_id!;
    expect(s.fxRepair.apply(pid, { currency: 'USD', foreignTotal: 9000, euroTotal: 8312, alreadyBookedBankTransactionId: t.id }).kind).toBe('dubbel');
    expect(s.purchases.list()).toHaveLength(0);
    expect(s.ledger.balance('WBedKanSof')).toBe(8312);
    expect(s.ledger.balance(ACCOUNTS.crediteuren) === 0).toBe(true);
    expect(s.intake.get(docId).status).toBe('verwerkt');
    expect(s.fxRepair.candidates()).toEqual([]);
    expect(s.fxRepair.pendingDocuments()).toEqual([]);
  });

  it('dezelfde afschrijving kan maar bij één aankoop "al geboekt" zijn: de tweede aankoop blijft staan (#221)', () => {
    const { s } = setup({ fetch: ecb });
    debit(s, 8312);
    const t = s.bank.list({ status: 'nieuw' })[0]!;
    s.bank.bookToAccount(t.id, { account: 'WBedKanSof', vatCode: 'buiten-eu' });
    const buy = (date: string) => s.purchases.create({ relationId: s.relations.findOrCreateSupplier('Anthropic').id, invoiceDate: date, description: 'Software — Anthropic', lines: [{ account: 'WBedKanSof', netAmount: 9000, vatCode: 'buiten-eu' }] });
    const a = buy('2026-05-06');
    const b = buy('2026-05-08');
    const input = { currency: 'USD', foreignTotal: 9000, euroTotal: 8312, alreadyBookedBankTransactionId: t.id };
    expect(s.fxRepair.apply(a.id, input).kind).toBe('dubbel');
    expect(() => s.fxRepair.apply(b.id, input)).toThrow('Bij deze betaling hoort al een andere aankoop. Eén betaling kan niet bij twee aankopen horen.');
    expect(s.purchases.list().map((p) => p.id)).toEqual([b.id]);
    expect(s.ledger.balance('WBedKanSof')).toBe(8312 + 9000);
  });

  it('nog geen betaling: ECB-koers; komt de betaling later, dan een klein koersverschil', async () => {
    const { s } = setup({ fetch: ecb });
    const pid = await oldPurchase(s);
    const pr = await s.fxRepair.preview(pid);
    expect(pr).toMatchObject({ euroTotal: 8333, source: 'ecb', rate: 1.08, bankTransactionId: null });
    s.fxRepair.apply(pid, { currency: 'USD', foreignTotal: 9000, euroTotal: 8333 });
    expect(s.purchases.get(pid)).toMatchObject({ total: 8333, status: 'open', currency: 'USD' });
    debit(s, 8400, '2026-05-09');
    s.bank.matchPurchase(s.bank.list({ status: 'nieuw' })[0]!.id, pid);
    expect(s.purchases.get(pid).status).toBe('betaald');
    expect(s.ledger.balance(ACCOUNTS.koersverschillen)).toBe(67);
  });

  it('geen internet: niets gokken, de gebruiker vult het bedrag in euro\'s in', async () => {
    const { s } = setup();
    const pid = await oldPurchase(s);
    const pr = await s.fxRepair.preview(pid);
    expect(pr.euroTotal).toBeNull();
    expect(pr.blocker).toMatch(/geen internet/);
    const sum = await s.fxRepair.fixAll('2026-05-08');
    expect(sum).toMatchObject({ purchases: 0, duplicates: 0 });
    expect(sum.open).toHaveLength(1);
    // met de hand ingevuld
    s.fxRepair.apply(pid, { currency: 'USD', foreignTotal: 9000, euroTotal: 8290 });
    expect(s.purchases.get(pid)).toMatchObject({ total: 8290, currency: 'USD' });
  });

  it('geen internet, maar de afschrijving staat er al: die wordt gevonden op naam en datum', async () => {
    const { s } = setup();
    const pid = await oldPurchase(s);
    debit(s, 8312);
    const pr = await s.fxRepair.preview(pid);
    expect(pr).toMatchObject({ euroTotal: 8312, source: 'bank', blocker: null });
    const sum = await s.fxRepair.fixAll('2026-05-08');
    expect(sum).toMatchObject({ purchases: 1, open: [] });
    expect(s.purchases.get(pid)).toMatchObject({ total: 8312, status: 'betaald', currency: 'USD' });
  });

  it('alles in één keer', async () => {
    const { s } = setup({ fetch: ecb });
    const pid = await oldPurchase(s);
    debit(s, 8312);
    const pending = await oldDocument(s, ['Invoice', 'Date of issue May 6, 2026', 'GitHub, Inc.', 'Copilot $10.00', 'Total $10.00']);
    const sum = await s.fxRepair.fixAll('2026-05-08');
    expect(sum).toMatchObject({ documents: 1, purchases: 1, duplicates: 0, open: [] });
    expect(s.purchases.get(pid)).toMatchObject({ total: 8312, status: 'betaald' });
    expect(s.intake.get(pending).result?.foreign).toMatchObject({ currency: 'USD', total: 1000 });
  });

  it('aankoop zonder bon (met de hand ingevoerd): omrekenen met de munt en het bedrag die je invult', async () => {
    const { s } = setup({ fetch: ecb });
    s.purchases.create({ invoiceDate: '2026-05-06', description: 'Hosting', relationId: s.relations.findOrCreateSupplier('Anthropic').id, lines: [{ account: 'WBedKanSof', netAmount: 9000, vatCode: 'buiten-eu' }] });
    const p = s.purchases.list()[0]!;
    expect(s.fxRepair.candidates()).toEqual([]); // geen bon: de app weet het niet
    await expect(s.fxRepair.preview(p.id)).rejects.toThrow(/munt en het bedrag/);
    debit(s, 8312);
    const pr = await s.fxRepair.preview(p.id, { currency: 'usd', foreignTotal: 9000 });
    expect(pr).toMatchObject({ currency: 'USD', euroTotal: 8312, source: 'bank' });
    s.fxRepair.apply(p.id, { currency: 'USD', foreignTotal: 9000, euroTotal: 8312, bankTransactionId: pr.bankTransactionId });
    expect(s.purchases.get(p.id)).toMatchObject({ total: 8312, status: 'betaald' });
  });

  it('nieuwe bon in dollars bij een betaling die al als kosten geboekt is: niet dubbel boeken', async () => {
    const { s } = setup({ fetch: ecb });
    debit(s, 8312);
    s.bank.bookToAccount(s.bank.list({ status: 'nieuw' })[0]!.id, { account: 'WBedKanSof', vatCode: 'buiten-eu' });
    const doc = await s.intake.add('invoice.pdf', makePdf(INVOICE), '2026-05-08');
    // niet vanzelf boeken en ook niet stil koppelen (#179): de app vraagt of de bon alleen bewijs is
    expect(doc.status).toBe('controle');
    expect(s.intake.pending(doc)?.kind).toBe('evidence');
    expect((await s.intake.decide(doc.id, 'ja')).outcome).toBe('bewijs-gekoppeld');
    expect(s.purchases.list()).toHaveLength(0);
    expect(s.ledger.balance('WBedKanSof')).toBe(8312);
  });

  it('twee vergelijkbare afschrijvingen al als kosten geboekt: te onzeker, niets vanzelf als bewijsstuk', async () => {
    const { s } = setup({ fetch: ecb });
    debit(s, 8312);
    debit(s, 8350, '2026-05-18');
    for (const t of s.bank.list({ status: 'nieuw' })) s.bank.bookToAccount(t.id, { account: 'WBedKanSof', vatCode: 'buiten-eu' });
    const doc = await s.intake.add('invoice.pdf', makePdf(INVOICE), '2026-05-20');
    expect(doc.status).toBe('controle'); // de gebruiker kijkt zelf
    expect(s.purchases.list()).toHaveLength(0);
  });

  it('dezelfde bon opnieuw toevoegen na een oude boeking als euro\'s: herkend als dubbel', async () => {
    const { s } = setup({ fetch: ecb });
    await oldPurchase(s);
    const doc = await s.intake.add('invoice-again.pdf', makePdf([...INVOICE, ' ']), '2026-05-08');
    expect(doc.status).toBe('genegeerd');
    expect(s.purchases.list()).toHaveLength(1);
  });

  it('regels naar verhouding: totaal klopt precies, ook met btw en meerdere regels', () => {
    const lines = [
      { account: 'WBedKanSof', netAmount: 3333, vatCode: 'hoog' as const },
      { account: 'WBedKanKan', netAmount: 1001, vatCode: 'laag' as const },
      { account: 'WBedKanSof', netAmount: 999, vatCode: 'buiten-eu' as const },
    ];
    const from = expenseLines(lines, ACCOUNTS.crediteuren, null).payable;
    for (const to of [1, 4711, 8312, 123457]) {
      const scaled = scaleLines(lines, from, to);
      expect(expenseLines(scaled, ACCOUNTS.crediteuren, null).payable).toBe(to);
    }
  });
});
