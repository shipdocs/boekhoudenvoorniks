import { describe, expect, it } from 'vitest';
import { financialSnapshot, setup } from './helpers';
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

describe('bewijs is een echte koppeling (#179)', () => {
  const GAMMA = ['Gamma', 'Factuurnummer: G-2026-55', 'Datum 01-08-2026', 'Verf 200,00', 'BTW 21% 200,00 42,00', 'Totaal 242,00'];

  /** Een betaling die rechtstreeks als kosten geboekt is, en een aankoop zonder bon. */
  function scenario() {
    const ctx = setup();
    const { s } = ctx;
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-07-08', amount: -15423, description: 'FACTUUR F0000.2607.0000.1394', counterName: 'TRANSIP B.V.' }] });
    const payment = s.bank.list()[0]!;
    s.bank.bookToAccount(payment.id, { account: 'WBedKanSof', vatCode: 'hoog' });
    const lev = s.relations.findOrCreateSupplier('Gamma');
    const purchase = s.purchases.create({ relationId: lev.id, supplierReference: 'G-2026-55', invoiceDate: '2026-08-01', description: 'Materiaal — Gamma', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 20000, vatCode: 'hoog' }] });
    return { ...ctx, payment: s.bank.get(payment.id), purchase };
  }

  it('bon toevoegen bij een betaling en bij een aankoop: alleen de koppeling komt erbij, er wordt niets geboekt', async () => {
    const ctx = scenario();
    const { s, payment, purchase } = ctx;
    const before = financialSnapshot(ctx);
    const bij = await s.intake.addEvidence('transip.pdf', makePdf(TRANSIP_2607), payment.id);
    expect(bij).toMatchObject({ already_present: false, blocked: null, status: 'verwerkt', outcome: 'bewijs-gekoppeld', purchase_invoice_id: null, link: { target: { kind: 'bank', id: payment.id }, origin: 'bewijs', is_primary: true } });
    const bon = await s.intake.addPurchaseEvidence('gamma.pdf', makePdf(GAMMA), purchase.id);
    expect(bon).toMatchObject({ status: 'verwerkt', outcome: 'bewijs-gekoppeld', purchase_invoice_id: purchase.id, link: { target: { kind: 'aankoop', id: purchase.id }, origin: 'bewijs', is_primary: true } });
    expect(financialSnapshot(ctx)).toEqual(before);
    // vanaf de aankoop en de betaling is de bon te vinden, en andersom
    expect(s.purchases.get(purchase.id)).toMatchObject({ document_id: bon.id, attachment_path: bon.file_path });
    expect(s.intake.links.forTarget({ kind: 'bank', id: payment.id }).map((f) => f.document_id)).toEqual([bij.id]);
    expect(s.intake.links.forDocument(bon.id)?.target).toEqual({ kind: 'aankoop', id: purchase.id });
  });

  it('de uitlegtekst is nooit de koppeling: "bewijsstuk bij banktransactie #..." zonder echte koppeling telt niet als bon', () => {
    const { s, db, payment } = scenario();
    db.prepare(`INSERT INTO documents (file_path, original_name, mime_type, sha256, status, classification) VALUES ('/x/oud.pdf', 'oud.pdf', 'application/pdf', 'oud', 'verwerkt', ?)`)
      .run(JSON.stringify({ categoryKey: 'overig', vatCode: 'hoog', business: true, confidence: 1, source: 'geheugen', reasons: [`bewijsstuk bij banktransactie #${payment.id}`], automatic: true }));
    expect(s.vat.checks('2026-Q3').find((c) => c.key === 'bewijs')?.items).toContainEqual(expect.objectContaining({ kind: 'bank', id: payment.id }));
    expect(s.search.infoFor(`bank:${payment.id}`)?.evidence).toBe(false);
    expect(s.intake.links.forTarget({ kind: 'bank', id: payment.id })).toEqual([]);
  });

  it('dezelfde factuur (ander bestand) hoort al bij iets anders: niets gekoppeld, de bon wacht op controle met beide doelen erbij', async () => {
    const ctx = scenario();
    const { s, payment, purchase } = ctx;
    const eerste = await s.intake.addPurchaseEvidence('gamma.pdf', makePdf(GAMMA), purchase.id);
    const before = financialSnapshot(ctx, { evidence: true });
    // een foto-achtige tweede versie van dezelfde factuur, nu aangeboden bij de bankbetaling
    const tweede = await s.intake.addEvidence('gamma-scan.pdf', makePdf([...GAMMA, 'Bedankt voor uw aankoop']), payment.id);
    expect(tweede).toMatchObject({
      already_present: false, status: 'controle', outcome: 'controle', link: null,
      blocked: { existing: { kind: 'aankoop', id: purchase.id, reference: 'G-2026-55' }, requested: { kind: 'bank', id: payment.id } },
    });
    expect(s.intake.pending(tweede)).toMatchObject({ kind: 'duplicate', candidate: `aankoop:${purchase.id}`, documentId: eerste.id });
    // het bestaande document, de aankoop en de betaling zijn niet aangeraakt; alleen het nieuwe bestand is erbij gekomen
    const after = financialSnapshot(ctx, { evidence: true });
    expect({ ...after, documents: after.documents!.slice(0, -1) }).toEqual(before);
    expect(s.intake.links.forTarget({ kind: 'bank', id: payment.id })).toEqual([]);
  });

  it('dezelfde factuur nog een keer bij hetzelfde doel: beide bestanden bewaard, één hoofdbewijsstuk', async () => {
    const ctx = scenario();
    const { s, purchase } = ctx;
    const before = financialSnapshot(ctx);
    // eerst alleen de e-factuur-achtige losse XML is er niet; hier: eerst een PDF, daarna dezelfde factuur als tweede PDF
    const eerste = await s.intake.addPurchaseEvidence('gamma.pdf', makePdf(GAMMA), purchase.id);
    const tweede = await s.intake.addPurchaseEvidence('gamma-2.pdf', makePdf([...GAMMA, 'Kopie']), purchase.id);
    expect(tweede).toMatchObject({ blocked: null, status: 'genegeerd', outcome: 'dubbel', duplicate_of_document_id: eerste.id, link: { target: { kind: 'aankoop', id: purchase.id }, origin: 'dubbel', is_primary: false } });
    const files = s.intake.links.forTarget({ kind: 'aankoop', id: purchase.id });
    expect(files.filter((f) => f.is_primary).map((f) => f.document_id)).toEqual([eerste.id]);
    expect(files).toHaveLength(2);
    expect(financialSnapshot(ctx)).toEqual(before);
    // de database zelf staat geen tweede hoofdbewijsstuk toe
    expect(() => ctx.db.prepare('UPDATE document_links SET is_primary = 1 WHERE document_id = ?').run(tweede.id)).toThrow(/UNIQUE/);
    // en één document hoort bij precies één doel
    expect(() => ctx.db.prepare('INSERT INTO document_links (document_id, bank_transaction_id, origin) VALUES (?, ?, ?)').run(eerste.id, ctx.payment.id, 'bewijs')).toThrow(/UNIQUE/);
    expect(() => ctx.db.prepare('INSERT INTO document_links (document_id, purchase_invoice_id, bank_transaction_id, origin) VALUES (?, ?, ?, ?)').run(999, purchase.id, ctx.payment.id, 'bewijs')).toThrow(/CHECK/);
  });

  it('ontkoppelen en opnieuw koppelen: alleen na de uitdrukkelijke stap, en de aankoop zelf verandert niet', async () => {
    const ctx = scenario();
    const { s, payment, purchase } = ctx;
    const bon = await s.intake.addPurchaseEvidence('gamma.pdf', makePdf(GAMMA), purchase.id);
    const before = financialSnapshot(ctx);
    // zolang hij aan de aankoop hangt, kan hij nergens anders bij
    expect(() => s.intake.linkExisting(bon.id, { kind: 'bank', id: payment.id })).toThrow(/hoort al bij de aankoop bij Gamma.*koppeling ongedaan/);
    expect(s.intake.get(bon.id).link?.target).toEqual({ kind: 'aankoop', id: purchase.id });

    const los = await s.intake.unlink(bon.id, '2026-08-02');
    expect(los).toMatchObject({ status: 'controle', outcome: 'controle', link: null, purchase_invoice_id: null });
    // de aankoop is er nog, zonder bijlage; kosten, btw en boeking zijn gelijk gebleven
    expect(s.purchases.get(purchase.id)).toMatchObject({ document_id: null, attachment_path: null, total: 24200, status: 'open' });
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(s.vat.checks('2026-Q3').find((c) => c.key === 'bewijs')?.items?.some((i) => i.kind === 'aankoop' && i.id === purchase.id)).toBe(true);
    // de aankoop waar hij net af is, wordt niet meteen weer voorgesteld
    expect(s.intake.pending(los)).toBeNull();

    // hetzelfde bestand opnieuw aanbieden: geweigerd, maar het bestaande document is nu wel zelf te koppelen
    const opnieuw = await s.intake.addEvidence('gamma.pdf', makePdf(GAMMA), payment.id);
    expect(opnieuw).toMatchObject({ id: bon.id, already_present: true, blocked: null, linkable: true, link: null });
    const gekoppeld = s.intake.linkExisting(bon.id, { kind: 'bank', id: payment.id });
    expect(gekoppeld).toMatchObject({ status: 'verwerkt', outcome: 'bewijs-gekoppeld', link: { target: { kind: 'bank', id: payment.id }, is_primary: true } });
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(ctx.stored).toHaveLength(1);
  });

  it('aankoop vervalt omdat de betaling al geboekt was: alle bestanden van de aankoop worden het bewijs bij die betaling', async () => {
    const ctx = setup();
    const { s } = ctx;
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-08-01', amount: -24200, description: 'Pin', counterName: 'GAMMA' }] });
    const t = s.bank.list()[0]!;
    s.bank.bookToAccount(t.id, { account: ACCOUNTS.inkoopMaterialen, vatCode: 'hoog' });
    // de bon is als aankoop geboekt (privé betaald), met een kopie erbij
    const bon = await s.intake.add('gamma.pdf', makePdf(GAMMA), '2026-08-02', { autoConfirm: false });
    await s.intake.decide(bon.id, 'nee');
    s.intake.confirm(bon.id, { supplier: 'Gamma', date: '2026-08-01', total: 24200, invoiceNumber: 'G-2026-55', categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'prive' });
    const kopie = await s.intake.add('gamma-kopie.pdf', makePdf([...GAMMA, 'Kopie']), '2026-08-03');
    expect(kopie.outcome).toBe('dubbel');
    const purchase = s.purchases.list()[0]!;
    s.bookedPayments.resolve(purchase.id, t.id, '2026-08-04');
    expect(s.purchases.list()).toHaveLength(0);
    expect(s.intake.get(bon.id)).toMatchObject({ status: 'verwerkt', outcome: 'bewijs-gekoppeld', link: { target: { kind: 'bank', id: t.id }, origin: 'bewijs', is_primary: true } });
    expect(s.intake.get(kopie.id)).toMatchObject({ status: 'genegeerd', outcome: 'dubbel', link: { target: { kind: 'bank', id: t.id }, origin: 'dubbel', is_primary: false } });
    // de kosten staan er één keer in: via de betaling
    expect(s.ledger.balance(ACCOUNTS.inkoopMaterialen)).toBe(20000);
  });
});
