import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { parseQuery } from '../src/search/search';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import type { OcrProvider } from '../src/intake/ocr';
import { makePdf } from './pdf';

const items = (lines: string[]) => lines.map((text, i) => ({ text, page: 1, bbox: [10, 20 + i * 20, 300, 34 + i * 20] as [number, number, number, number], confidence: 0.97 }));

describe('zoeken (#26)', () => {
  it('een woord van een bonregel vindt het document, en via de koppelingen de betaling en de boeking', async () => {
    const ocr: OcrProvider = { id: 't', label: 'T', available: async () => true, recognize: async () => ({ items: items(['HORNBACH', 'Datum: 16-09-2026', 'Festool zaagmachine TS55 649,00', 'BTW 21% 536,36 112,64', 'Totaal 649,00']) }) };
    const { s } = setup({ ocr });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-16', amount: -64900, description: 'Pin', counterName: 'HORNBACH' }] });
    const d = await s.intake.add('hornbach.jpg', new Uint8Array([1]), '2026-09-25');
    s.intake.confirm(d.id, { supplier: 'Hornbach', date: '2026-09-16', total: 64900, categoryKey: 'investering', vatCode: 'hoog', business: true, paidWith: 'bank' });
    const [g] = s.search.search('zaagmachine');
    expect(g).toBeDefined();
    expect(g!.key).toMatch(/^inkoop:/);
    const kinds = g!.links.map((l) => l.kind).sort();
    expect(kinds).toEqual(['bank', 'boeking', 'document', 'inkoop']);
    expect(g!.hits[0]!.snippet).toContain('[[zaagmachine]]');
    // garantie
    s.search.setWarranty(Number(g!.key.split(':')[1]), 24);
    expect(s.search.search('festool')[0]!.warranty).toMatch(/nog \d+ maanden garantie/);
  });

  it('bij elk resultaat: status, rekening, waar het geboekt is en in welke btw-aangifte', () => {
    const { s } = setup();
    const revolut = s.bank.addAccount('Revolut', 'NL19REVO1775456722');
    s.bank.import({ source: 'csv', warnings: [], transactions: [
      { date: '2026-07-05', amount: -19401, description: 'Card Payment: Preply', counterName: 'Preply' },
      { date: '2026-07-08', amount: -2131, description: 'Card Payment: Vercel', counterName: 'Vercel' },
    ] }, { bankAccountId: revolut.id });
    const [preply, vercel] = ['Preply', 'Vercel'].map((n) => s.bank.list({ search: n })[0]!);
    s.bank.bookToAccount(preply!.id, { account: ACCOUNTS.priveOpnamen });
    s.bank.bookToAccount(vercel!.id, { account: 'WBedKanSof', vatCode: 'buiten-eu' });

    const p = s.search.search('preply')[0]!;
    expect(p.info).toMatchObject({ status: 'Verwerkt', attention: false, paidVia: 'Revolut', counterparty: 'Preply', evidence: false });
    expect(p.info!.booking).toMatchObject({ summary: 'Privé-opnamen', vatPeriod: null });

    const v = s.search.search('vercel')[0]!;
    expect(v.info!.booking).toMatchObject({ summary: 'Software & abonnementen · btw verlegd, buiten EU (4a)', vatPeriod: { key: '2026-Q3', filed: false } });
    expect(v.info!.booking!.lines).toEqual([{ account: 'Software & abonnementen', amount: 2131, vat: 'btw verlegd, buiten EU (4a)' }]);

    // nog niet verwerkt: aandacht nodig, nog nergens geboekt
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-01', amount: -500, description: 'Parkeren', counterName: 'Q-Park' }] }, { bankAccountId: revolut.id });
    expect(s.search.search('q-park')[0]!.info).toMatchObject({ status: 'Nog niet verwerkt', attention: true, booking: null });

    // aankoop privé betaald
    const lev = s.relations.findOrCreateSupplier('DigiBoox');
    const inkoop = s.purchases.create({ relationId: lev.id, invoiceDate: '2026-09-19', description: 'Overige kosten — DigiBoox', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 1600, vatCode: 'hoog' }] });
    s.quick.payPurchaseWith(inkoop.id, 'prive');
    expect(s.search.search('digiboox').find((g) => g.key.startsWith('inkoop:'))!.info).toMatchObject({ status: 'Betaald', paidVia: 'privé betaald', counterparty: 'DigiBoox', evidence: false });
  });

  it('factuurregels en klanten zijn doorzoekbaar, met bedrag- en periodefilters', () => {
    const { s, klant } = setup();
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-09-10', lines: [{ description: 'Trappenhuis stucen', quantity: 1, unitPrice: 50000, vatCode: 'hoog' }] }).id);
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-08-10', lines: [{ description: 'Trappenhuis sauzen', quantity: 1, unitPrice: 20000, vatCode: 'hoog' }] }).id);
    expect(s.search.search('trappenhuis')).toHaveLength(2);
    expect(s.search.search('trappenhuis > 400')).toHaveLength(1);
    expect(s.search.search('trappenhuis 2026-08')[0]!.title).toContain('Jansen');
    expect(s.search.search('trapp')[0]!.links.some((l) => l.kind === 'factuur' && l.id === inv.id)).toBe(true); // voorvoegsel
    expect(s.search.search('dorpsstraat')[0]!.hits[0]!.kind).toBe('relatie');
    expect(s.search.search('')).toEqual([]);
    expect(parseQuery('factuur 2026-0007').filters.from).toBeUndefined(); // factuurnummer is geen periode
  });

  it('filter op klus', () => {
    const { s, klant } = setup();
    const job = s.jobs.create({ relationId: klant.id, title: 'Badkamer' });
    s.purchases.create({ invoiceDate: '2026-09-01', description: 'Tegellijm', jobId: job.id, lines: [{ account: 'WKprInkMat', netAmount: 3000, vatCode: 'hoog' }] });
    s.purchases.create({ invoiceDate: '2026-09-02', description: 'Tegellijm', lines: [{ account: 'WKprInkMat', netAmount: 4000, vatCode: 'hoog' }] });
    expect(s.search.search('tegellijm')).toHaveLength(2);
    expect(s.search.search('tegellijm', { jobId: job.id })).toHaveLength(1);
  });

  it('index opnieuw opbouwen geeft dezelfde resultaten', () => {
    const { s, db, klant } = setup();
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-09-10', lines: [{ description: 'Plafond stucen', quantity: 1, unitPrice: 50000, vatCode: 'hoog' }] }).id);
    const before = (db.prepare('SELECT COUNT(*) n FROM search_index').get() as { n: number }).n;
    s.search.rebuild();
    expect((db.prepare('SELECT COUNT(*) n FROM search_index').get() as { n: number }).n).toBe(before);
    expect(s.search.search('plafond')).toHaveLength(1);
  });

  it('zoeken in 10.000 documenten blijft onder de 100 ms', () => {
    const { s, db } = setup();
    const words = ['gips', 'verf', 'kit', 'schroeven', 'pluggen', 'tegellijm', 'voegmiddel', 'stucloper', 'hoekprofiel', 'afplaktape'];
    const insert = db.prepare('INSERT INTO documents (file_path, original_name, mime_type, sha256, status, result) VALUES (?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
      for (let i = 0; i < 10000; i++) {
        const w = words[i % words.length]!;
        const result = { supplier: { value: `Leverancier ${i % 50}` }, invoiceDate: { value: `2026-${String((i % 12) + 1).padStart(2, '0')}-15` }, total: { value: 1000 + i }, rawText: `${w} ${words[(i * 7) % 10]} artikel ${i}`, lineDescriptions: [`${w} 25 kg`] };
        insert.run(`/x/${i}.jpg`, `${i}.jpg`, 'image/jpeg', `sha${i}`, 'verwerkt', JSON.stringify(result));
      }
    })();
    s.search.search('gips'); // opwarmen
    const t0 = performance.now();
    for (const q of ['gips', 'tegellijm > 50', 'leverancier 7', 'hoekprofiel 2026-03', 'artikel 9999']) s.search.search(q);
    const avg = (performance.now() - t0) / 5;
    expect(avg).toBeLessThan(100);
    expect(s.search.search('artikel 9999')).toHaveLength(1);
  });
});

describe('zoeken volgt de koppeling tussen bon en aankoop of betaling (#179)', () => {
  const TRANSIP = ['TransIP BV', 'Factuurnummer F0000.2607.0000.1394', 'Factuurdatum 01-07-2026', 'Hosting glasvezelpakket 127,46', 'BTW 21% 127,46 26,77', 'Totaal 154,23'];

  it('bon als bewijs bij een betaling: vanaf de bon naar de betaling en de boeking, en vanaf de betaling naar de bon', async () => {
    const { s } = setup();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-07-08', amount: -15423, description: 'Incasso domeinen', counterName: 'TRANSIP B.V.' }] });
    const t = s.bank.list()[0]!;
    s.bank.bookToAccount(t.id, { account: 'WBedKanSof', vatCode: 'hoog' });
    expect(s.search.infoFor(`bank:${t.id}`)?.evidence).toBe(false);
    const doc = await s.intake.addEvidence('transip.pdf', makePdf(TRANSIP), t.id);
    // een woord dat alleen op de bon staat: het resultaat is de betaling, met de bon en de boeking eraan
    const [viaBon] = s.search.search('glasvezelpakket');
    expect(viaBon).toMatchObject({ key: `bank:${t.id}`, info: { status: 'Verwerkt', evidence: true } });
    expect(viaBon!.links.map((l) => [l.kind, l.id])).toEqual(expect.arrayContaining([['bank', t.id], ['document', doc.id], ['boeking', s.bank.get(t.id).matched_journal_entry_id]]));
    // een woord dat alleen op het afschrift staat: de bon hangt er ook aan
    const [viaBank] = s.search.search('domeinen');
    expect(viaBank!.key).toBe(`bank:${t.id}`);
    expect(viaBank!.links).toContainEqual({ kind: 'document', id: doc.id, label: 'bon/factuur' });

    // koppeling ongedaan gemaakt: de bon staat weer los, met de status in gewone woorden
    await s.intake.unlink(doc.id, '2026-07-10');
    const [los] = s.search.search('glasvezelpakket');
    expect(los).toMatchObject({ key: `document:${doc.id}`, info: { status: 'Nog controleren', attention: true } });
    expect(s.search.infoFor(`bank:${t.id}`)?.evidence).toBe(false);
    expect(s.search.search('domeinen')[0]!.links.some((l) => l.kind === 'document')).toBe(false);
  });

  it('aankoop met twee bestanden: beide te vinden, het hoofdbewijsstuk eerst; de status zegt wat er gebeurd is', async () => {
    const { s } = setup();
    const eerste = await s.intake.add('transip.pdf', makePdf(TRANSIP), '2026-07-02', { autoConfirm: false });
    s.intake.confirm(eerste.id, { supplier: 'TransIP', date: '2026-07-01', total: 15423, invoiceNumber: 'F0000.2607.0000.1394', categoryKey: 'software', vatCode: 'hoog', business: true, paidWith: 'kas' });
    const kopie = await s.intake.add('transip-kopie.pdf', makePdf([...TRANSIP, 'Kopie factuur']), '2026-07-03');
    const purchase = s.purchases.list()[0]!;
    const [g] = s.search.search('glasvezelpakket');
    expect(g!.key).toBe(`inkoop:${purchase.id}`);
    expect(g!.links.filter((l) => l.kind === 'document')).toEqual([
      { kind: 'document', id: eerste.id, label: 'bon/factuur' },
      { kind: 'document', id: kopie.id, label: 'ook bewaard: transip-kopie.pdf' },
    ]);
    expect(s.search.infoFor(`document:${eerste.id}`)?.status).toBe('Nieuwe aankoop geboekt');
    expect(s.search.infoFor(`document:${kopie.id}`)?.status).toBe('Dubbel document — niet geboekt');
    expect(s.search.infoFor(`inkoop:${purchase.id}`)?.evidence).toBe(true);
  });
});

describe('review-bevindingen #43 (zoeken)', () => {
  it('">" en "<" zijn exclusief; alleen een einddatum werkt ook; garantie moet een getal zijn', () => {
    expect(parseQuery('> 400').filters.minAmount).toBe(40001);
    expect(parseQuery('>= 400').filters.minAmount).toBe(40000);
    expect(parseQuery('< 50').filters.maxAmount).toBe(4999);
    const { s, klant } = setup();
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-09-10', lines: [{ description: 'Gevel', quantity: 1, unitPrice: 40000, vatCode: 'nul' }] }).id);
    expect(s.search.search('gevel > 400')).toHaveLength(0);
    expect(s.search.search('gevel >= 400')).toHaveLength(1);
    expect(s.search.search('', { to: '2026-12-31' }).length).toBeGreaterThan(0);
    expect(() => s.search.setWarranty(1, Number.NaN)).toThrow(/getal/);
  });
});
