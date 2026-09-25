import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { parseCsv, previewCsv } from '../src/import/csv';
import { parseMt940, parseField86 } from '../src/import/mt940';
import { parseCamt053 } from '../src/import/camt053';
import { detectFormat } from '../src/import/detect';
import { ACCOUNTS } from '../src/core-ledger/accounts';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name));

describe('parsers', () => {
  it('herkent ING CSV en parseert af/bij', () => {
    const text = fixture('ing.csv').toString('utf8');
    const preview = previewCsv(text);
    expect(preview.detectedBank).toBe('ING');
    const r = parseCsv(text, preview.suggestedMapping!);
    expect(r.warnings).toEqual([]);
    expect(r.transactions).toHaveLength(3);
    expect(r.transactions[0]).toMatchObject({ date: '2026-09-15', amount: 93643, counterIban: 'NL44RABO0123456789', ownIban: 'NL91ABNA0417164300' });
    expect(r.transactions[1]!.amount).toBe(-6500);
  });

  it('herkent Rabobank CSV', () => {
    const text = fixture('rabo.csv').toString('utf8');
    const preview = previewCsv(text);
    expect(preview.detectedBank).toBe('Rabobank');
    const r = parseCsv(text, preview.suggestedMapping!);
    expect(r.transactions.map((t) => t.amount)).toEqual([121000, -1250]);
    expect(r.transactions[0]!.description).toContain('2026-0002');
  });

  it('MT940 via mt940-js met gestructureerd veld 86', async () => {
    const r = await parseMt940(fixture('statement.sta'));
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]).toMatchObject({ date: '2026-09-01', amount: 12100, counterIban: 'NL44RABO0123456789', counterName: 'Familie Jansen', description: 'Factuur 2026-0003' });
    expect(r.transactions[1]).toMatchObject({ amount: -3025, counterName: 'Gamma Utrecht' });
    expect(parseField86('Vrije tekst zonder tags').description).toBe('Vrije tekst zonder tags');
  });

  it('CAMT.053, alleen geboekte posten', () => {
    const r = parseCamt053(fixture('camt053.xml').toString('utf8'));
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[0]).toMatchObject({ date: '2026-09-29', amount: 24200, counterName: 'Familie Jansen', description: 'factuur 2026-0004', reference: null, bankId: 'REF-1' });
    expect(r.transactions[1]).toMatchObject({ amount: -1500, counterName: 'KPN' });
  });

  it('detecteert formaat', () => {
    expect(detectFormat('x.xml', fixture('camt053.xml').toString())).toBe('camt');
    expect(detectFormat('x.sta', fixture('statement.sta').toString())).toBe('mt940');
    expect(detectFormat('x.csv', fixture('ing.csv').toString())).toBe('csv');
  });
});

describe('bankimport en matching', () => {
  it('ontdubbelt bij opnieuw importeren, maar behoudt identieke transacties binnen één bestand', () => {
    const { s } = setup();
    const text = fixture('ing.csv').toString('utf8');
    const parsed = parseCsv(text, previewCsv(text).suggestedMapping!);
    expect(s.bank.import(parsed)).toMatchObject({ imported: 3, duplicates: 0 });
    expect(s.bank.import(parsed)).toMatchObject({ imported: 0, duplicates: 3 });
    expect(s.bank.listAccounts()[0]!.iban).toBe('NL91ABNA0417164300');
  });

  it('koppelt automatisch op bedrag + factuurnummer en leert het IBAN van de klant', () => {
    const { s, klant, aannemer } = setup();
    s.relations.update(klant.id, { iban: null });
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-09-01', lines: [{ description: 'Stucwerk', quantity: 1, unitPrice: 77391, vatCode: 'hoog' }] }).id);
    expect(inv.total).toBe(93643);
    // tweede open factuur met hetzelfde bedrag, andere klant: het nummer moet de doorslag geven
    s.invoices.finalize(s.invoices.createDraft({ relationId: aannemer.id, invoiceDate: '2026-09-02', lines: [{ description: 'Stucwerk', quantity: 1, unitPrice: 77391, vatCode: 'hoog' }] }).id);
    const text = fixture('ing.csv').toString('utf8');
    s.bank.import(parseCsv(text, previewCsv(text).suggestedMapping!));
    const r = s.matching.autoMatch('2026-09-30');
    expect(r.matched).toBe(1);
    expect(s.invoices.get(inv.id).status).toBe('betaald');
    expect(s.relations.get(klant.id).iban).toBe('NL44RABO0123456789');
    expect(s.ledger.balance(ACCOUNTS.bank)).toBe(93643);
  });

  it('twijfelgevallen worden niet automatisch gekoppeld', () => {
    const { s, klant, aannemer } = setup();
    for (const rel of [klant, aannemer]) {
      s.invoices.finalize(s.invoices.createDraft({ relationId: rel.id, invoiceDate: '2026-09-01', lines: [{ description: 'x', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] }).id);
    }
    s.relations.update(klant.id, { iban: null });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-10', amount: 12100, description: 'betaling', counterName: 'Onbekend' }] });
    expect(s.matching.autoMatch('2026-09-30').matched).toBe(0);
    const t = s.bank.list({ status: 'nieuw' })[0]!;
    expect(s.matching.suggest(t).filter((x) => x.kind === 'factuur')).toHaveLength(2);
  });

  it('boekt kosten met BTW-splitsing en leert de categorie', () => {
    const { s } = setup();
    s.bank.import({
      source: 'csv',
      warnings: [],
      transactions: [
        { date: '2026-09-16', amount: -6500, description: 'Tanken', counterName: 'SHELL STATION' },
        { date: '2026-10-16', amount: -7260, description: 'Tanken', counterName: 'SHELL STATION' },
      ],
    });
    const [later, first] = s.bank.list();
    s.bank.bookToAccount(first!.id, { account: 'WBedAutBra', vatCode: 'hoog' });
    expect(s.ledger.balance('WBedAutBra')).toBe(5372);
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(1128);
    expect(s.ledger.balance(ACCOUNTS.bank)).toBe(-6500);
    const suggestion = s.matching.suggest(later!).find((x) => x.kind === 'rekening');
    expect(suggestion).toMatchObject({ account: 'WBedAutBra', vatCode: 'hoog' });
    // ongedaan maken via tegenboeking
    s.bank.unmatch(first!.id, '2026-09-17');
    expect(s.bank.get(first!.id).status).toBe('nieuw');
    expect(s.ledger.balance('WBedAutBra')).toBe(0);
  });

  it('bonnetje eerst, bank later: koppelt aan de inkoopfactuur', () => {
    const { s } = setup();
    const p = s.quick.recordExpense({ date: '2026-09-02', supplierName: 'Gamma Utrecht', supplierReference: 'Bon 4411', description: 'Verf', categoryKey: 'materiaal', grossAmount: 3025, vatCode: 'hoog', paidWith: 'bank' });
    expect(p.status).toBe('open');
    s.bank.import({ source: 'mt940', warnings: [], transactions: [{ date: '2026-09-02', amount: -3025, description: 'Bon 4411 verf', counterName: 'Gamma Utrecht' }] });
    expect(s.matching.autoMatch().matched).toBe(1);
    expect(s.purchases.get(p.id).status).toBe('betaald');
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
  });

  it('privé betaald en beginsaldo', () => {
    const { s } = setup();
    s.quick.recordExpense({ date: '2026-09-02', description: 'Telefoon', categoryKey: 'telefoon', grossAmount: 2420, vatCode: 'hoog', paidWith: 'prive' });
    expect(s.ledger.balance(ACCOUNTS.priveStortingen)).toBe(-2420);
    s.bank.setOpeningBalance(s.bank.listAccounts()[0]!.id, 250000, '2026-01-01');
    expect(s.dashboard.get('2026-09-30').bank.ledgerBalance).toBe(250000);
  });
});
