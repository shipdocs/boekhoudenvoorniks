import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { makePdf } from './pdf';
import { ACCOUNTS } from '../src/core-ledger/accounts';

const TRANSIP_2607 = ['TransIP BV', 'Factuurnummer F0000.2607.0000.1394', 'Factuurdatum 01-07-2026', 'Hosting 127,46', 'BTW 21% 127,46 26,77', 'Totaal 154,23'];
const TRANSIP_2507 = ['TransIP BV', 'Factuurnummer F0000.2507.0000.1458', 'Factuurdatum 01-07-2025', 'Hosting 119,95', 'BTW 21% 119,95 25,19', 'Totaal 145,14'];

describe('bon bij een betaling of aankoop zonder bon', () => {
  it('de controle noemt de omschrijving van de betaling (factuurnummer), en de bon toevoegen lost hem op', async () => {
    const { s } = setup();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-07-08', amount: -15423, description: 'FACTUUR F0000.2607.0000.1394', counterName: 'TRANSIP B.V.' }] });
    const t = s.bank.list()[0]!;
    s.bank.bookToAccount(t.id, { account: 'WBedKanSof', vatCode: 'hoog' });
    const check = () => s.vat.checks('2026-Q3').find((c) => c.key === 'bewijs');
    expect(check()!.items).toEqual([expect.objectContaining({ kind: 'bank', id: t.id, label: 'TRANSIP B.V.', hint: 'FACTUUR F0000.2607.0000.1394' })]);
    const doc = await s.intake.addEvidence('F0000.2607.0000.1394.pdf', makePdf(TRANSIP_2607), t.id);
    expect(doc.result?.total?.value).toBe(15423);
    expect(check()).toBeUndefined();
  });

  it('aankoop zonder bon: bon toevoegen maakt hem de bijlage', async () => {
    const { s } = setup();
    const lev = s.relations.findOrCreateSupplier('Gamma');
    const p = s.purchases.create({ relationId: lev.id, invoiceDate: '2026-08-01', description: 'Materiaal — Gamma', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 20000, vatCode: 'hoog' }] });
    const doc = await s.intake.addPurchaseEvidence('gamma.pdf', makePdf(['Gamma', 'Datum 01-08-2026', 'Totaal 242,00']), p.id);
    expect(s.purchases.get(p.id)).toMatchObject({ document_id: doc.id, attachment_path: doc.file_path });
    expect(s.intake.get(doc.id)).toMatchObject({ status: 'verwerkt', purchase_invoice_id: p.id });
  });

  it('een factuur van vóór de instapdatum wordt geen nieuwe aankoop vanzelf, maar een vraag met uitleg', async () => {
    const { s } = setup();
    s.switchover.setMode('overstapper', '2026-01-01');
    s.settings.update({ autopilot: 'maximaal' });
    const d = await s.intake.add('F0000.2507.0000.1458.pdf', makePdf(TRANSIP_2507), '2026-09-28');
    expect(d.status).toBe('controle');
    expect(d.purchase_invoice_id).toBeNull();
    expect(d.issues).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'invoiceDate', severity: 'fout', message: expect.stringMatching(/vóór je instapdatum.*factuurnummer/) })]));
  });
});
