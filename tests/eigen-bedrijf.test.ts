import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { financialSnapshot, setup } from './helpers';
import { makePdf } from './pdf';
import { parseDocumentText } from '../src/intake/text-parser';
import { parseUbl } from '../src/intake/ubl';
import { detectOwnInvoice, vatNumbers, type OwnIdentity } from '../src/intake/own-company';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { formatEuro } from '../src/shared/money';

/** Het bedrijf uit tests/helpers.ts. */
const OWN: OwnIdentity = { name: 'Stukadoorsbedrijf Piet', vatNumber: 'NL123456789B01', kvkNumber: '12345678', ibans: ['NL91ABNA0417164300'] };

/**
 * Zoals de factuur uit #205 gelezen wordt (verzonnen gegevens): een abonnement op de eigen dienst, betaald
 * via een betaalprovider. Bovenaan de naam van het product, verkoper en koper naast elkaar op één regel,
 * het eigen btw- en KvK-nummer twee keer, en geen ander btw-nummer.
 */
const EIGEN_FACTUUR = [
  'KalkPlanner',
  'Factuur I-MOL-2026-00347',
  'Datum van uitgifte: 30-09-2026',
  'Stukadoorsbedrijf Piet Stukadoorsbedrijf Piet',
  'Kalkweg 1 Kalkweg 1',
  '1234 AB Utrecht 1234 AB Utrecht',
  'Btw-nummer: NL123456789B01 Btw-nummer: NL123456789B01',
  'KvK: 12345678 KvK: 12345678',
  'Abonnement KalkPlanner oktober 9,00',
  'BTW 21% 9,00 1,89',
  'Totaal 10,89',
  'Betaald op: 30-09-2026',
];

const read = (lines: string[]) => parseDocumentText(lines.map((text, i) => ({ text, page: 1, bbox: [10, 20 + i * 20, 300, 34 + i * 20] as [number, number, number, number], confidence: 0.97 })), 'pdf-text');
const detect = (lines: string[], ownNumber: (n: string) => boolean = () => false) => detectOwnInvoice(read(lines), OWN, ownNumber);

describe('factuur van je eigen bedrijf herkennen (#205)', () => {
  it('de factuur uit het issue: zeker, met de redenen erbij', () => {
    const r = read(EIGEN_FACTUUR);
    expect(r).toMatchObject({ supplier: { value: 'KalkPlanner' }, invoiceDate: { value: '2026-09-30' }, invoiceNumber: { value: 'I-MOL-2026-00347' }, total: { value: 1089 } });
    expect(detectOwnInvoice(r, OWN)).toEqual({
      level: 'zeker',
      signals: ['je eigen KvK-nummer staat erop', 'je eigen btw-nummer staat er twee keer op (verkoper en koper)', 'je eigen bedrijfsnaam staat als verkoper en als koper op dezelfde regel'],
    });
  });

  it('een gewone factuur aan jou, met jouw naam en btw-nummer als koper: niet', () => {
    expect(detect(['Bouwmaat Nederland B.V.', 'KvK 30123456 Btw NL001234567B01', 'Factuur 2026-1001', 'Factuurdatum 12-09-2026', 'Aan: Stukadoorsbedrijf Piet', 'Kalkweg 1, 1234 AB Utrecht', 'Uw btw-nummer: NL123456789B01', 'Gips 100,00', 'BTW 21% 100,00 21,00', 'Totaal 121,00', 'IBAN NL20INGB0001234567'])).toBeNull();
    // ook als jouw btw-nummer er twee keer op staat en je eigen rekening genoemd wordt (automatische incasso)
    expect(detect(['KPN B.V.', 'Btw NL009292056B01', 'Factuur 88-2026', 'Factuurdatum 12-09-2026', 'Stukadoorsbedrijf Piet', 'Btw-nummer klant NL123456789B01', 'Totaal 61,00', 'Wordt afgeschreven van NL91 ABNA 0417 1643 00', 'Klant btw: NL123456789B01'])).toBeNull();
  });

  it('een factuur met verlegde btw van een leverancier uit de EU die jouw btw-nummer noemt: niet', () => {
    expect(detect(['Hetzner Online GmbH', 'USt-IdNr. DE 812871812', 'Invoice R0012345', 'Invoice date 12-09-2026', 'Customer: Stukadoorsbedrijf Piet', 'VAT ID customer: NL123456789B01', 'Reverse charge: VAT to be paid by the recipient NL123456789B01', 'Total 20,00'])).toBeNull();
    expect(detect(['Odoo S.A.', 'TVA BE 0477.472.701', 'Factuur 2026/55', 'Datum 12-09-2026', 'Stukadoorsbedrijf Piet', 'NL123456789B01', 'Btw verlegd', 'Totaal 50,00'])).toBeNull();
  });

  it('een factuur van buiten de EU met alleen jouw btw-nummer bij "Bill to": niet; twee keer zonder iets anders: vragen', () => {
    const us = ['Invoice', 'Invoice number QX7ZTR2K-0003', 'Date of issue September 2, 2026', 'Wolkje Inc. Bill to', '169 Example Ave Stukadoorsbedrijf Piet', 'United States Netherlands', 'NL VAT NL123456789B01', 'Total $5.00'];
    expect(detect(us)).toBeNull();
    expect(detect([...us, 'Customer VAT ID: NL123456789B01'])).toEqual({ level: 'waarschijnlijk', signals: ['je eigen btw-nummer staat er twee keer op (verkoper en koper)'] });
  });

  it('één aanwijzing is "waarschijnlijk" (vragen); alleen je eigen rekeningnummer zegt niets; een ander KvK-nummer is een andere verkoper', () => {
    // alleen de eigen naam als verkoper gelezen
    expect(detect(['Stukadoorsbedrijf Piet', 'Factuur 2026-0009', 'Datum 12-09-2026', 'Totaal 121,00'])).toEqual({ level: 'waarschijnlijk', signals: ['je eigen bedrijfsnaam is de verkoper'] });
    // verzekeraar zonder btw-nummer, incasso van je eigen rekening
    expect(detect(['Polis Direct', 'Factuur 77', 'Datum 12-09-2026', 'Totaal 45,00', 'Wordt afgeschreven van NL91ABNA0417164300'])).toBeNull();
    expect(detect(['Polis Direct', 'KvK 87654321', 'Factuur 77', 'Datum 12-09-2026', 'Totaal 45,00', 'Uw KvK-nummer 12345678'])).toBeNull();
    // eigen KvK-nummer en eigen rekening om naar te betalen: twee aanwijzingen
    expect(detect(['Onbekend', 'KvK 12345678', 'Factuur 77', 'Datum 12-09-2026', 'Totaal 45,00', 'Betalen op NL91ABNA0417164300'])?.level).toBe('zeker');
  });

  it('een van je eigen factuurnummers: met een ander btw-nummer erop (factuur aan een klant) alleen een vraag', () => {
    const own = (n: string) => n === '2026-0007';
    expect(detect(['Stukadoorsbedrijf Piet', 'Factuur 2026-0007', 'Datum 12-09-2026', 'Totaal 121,00'], own)?.level).toBe('zeker');
    expect(detect(['Stukadoorsbedrijf Piet', 'Factuur 2026-0007', 'Datum 12-09-2026', 'Aan Bouwbedrijf De Vries BV, btw NL999999999B01', 'Totaal 121,00'], own)).toEqual({ level: 'waarschijnlijk', signals: ['het factuurnummer is van een van je eigen facturen'] });
  });

  it('e-factuur (UBL): de verkoper staat apart; jouw btw-nummer als verkoper is zeker, als koper niet', () => {
    const xml = readFileSync(join(__dirname, 'fixtures', 'ubl-invoice.xml'), 'utf8');
    expect(detectOwnInvoice(parseUbl(xml), OWN)).toBeNull();
    expect(detectOwnInvoice(parseUbl(xml.replace('NL001234567B01', 'NL123456789B01')), OWN)).toEqual({ level: 'zeker', signals: ['je eigen btw-nummer staat als verkoper op de e-factuur'] });
  });

  it('een rekeningnummer is geen btw-nummer', () => {
    expect(vatNumbers('IBAN NL91 ABNA 0417 1643 00, DE89 3704 0044 0532 0130 00, BE68539007547034, GB29 NWBK 6016 1331 9268 19')).toEqual([]);
    expect(vatNumbers('btw NL 1234.56.789 B01, USt DE 812871812, TVA BE 0477.472.701, ATU12345678, FR 12 345678901')).toEqual(['NL123456789B01', 'DE812871812', 'BE0477472701', 'ATU12345678', 'FR12345678901']);
  });

  it('zonder bedrijfsgegevens in Instellingen wordt er niets herkend', () => {
    expect(detectOwnInvoice(read(EIGEN_FACTUUR), { name: '', vatNumber: '', kvkNumber: '', ibans: [] })).toBeNull();
  });
});

describe('factuur en betaling van je eigen bedrijf: één keuze, nooit vanzelf (#205)', () => {
  const pdf = makePdf(EIGEN_FACTUUR);
  const world = () => {
    const ctx = setup();
    ctx.s.settings.update({ onboardingDone: true, autopilot: 'maximaal' });
    return ctx;
  };
  /** De afschrijving: je eigen bedrijfsnaam als tegenpartij, geen eigen rekening. */
  const payment = (s: ReturnType<typeof setup>['s'], date = '2026-10-01') => {
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount: -1089, description: 'KalkPlanner abonnement via Mollie', counterName: 'STUKADOORSBEDRIJF PIET' }] });
    s.inbox.autoProcess(date);
    return s.bank.list().find((t) => t.amount === -1089)!;
  };
  const tasksFor = (s: ReturnType<typeof setup>['s']) => s.inbox.tasks('2026-10-02').filter((t) => t.kind === 'document-review' || (t.kind.startsWith('bank-') && t.kind !== 'bank-stale'));
  const euro = formatEuro(1089);
  const CHOICES = [['prive', 'Privé'], ['vraag', 'Weet ik nog niet: vraag mijn boekhouder'], ['open', 'Bekijken']];

  it('de factuur komt eerst: nooit vanzelf geboekt, alleen privé of "weet ik nog niet", en niets te leren', async () => {
    const ctx = world();
    const { s } = ctx;
    const before = financialSnapshot(ctx, { vatPeriods: ['2026-Q3', '2026-Q4'] });
    const d = await s.intake.add('factuur.pdf', pdf, '2026-09-30');
    expect(d).toMatchObject({ status: 'controle', outcome: 'controle', link: null, result: { ownCompany: { level: 'zeker' } } });
    expect(s.intake.ownIssue(d)).toMatchObject({ severity: 'fout', message: expect.stringMatching(/^Dit is een factuur van je eigen bedrijf: verkoper en koper zijn hetzelfde\./) });
    expect(financialSnapshot(ctx, { vatPeriods: ['2026-Q3', '2026-Q4'] })).toEqual(before);
    // als gewone aankoop met btw-aftrek boeken wordt geweigerd
    const gewoon = { supplier: 'KalkPlanner', date: '2026-09-30', total: 1089, categoryKey: 'software', vatCode: 'hoog' as const, business: true, paidWith: 'later' as const };
    expect(() => s.intake.confirm(d.id, gewoon)).toThrow(/factuur van je eigen bedrijf.*Privé.*Weet ik nog niet/);
    expect(financialSnapshot(ctx, { vatPeriods: ['2026-Q3', '2026-Q4'] })).toEqual(before);
    // op Vandaag: de uitleg en precies de twee keuzes (plus bekijken), geen "Ja" dat hem als kosten boekt
    const [task] = tasksFor(s);
    expect(task).toMatchObject({ kind: 'document-review', ref: { documentId: d.id } });
    expect(task!.question).toBe('Dit is een factuur van je eigen bedrijf: verkoper en koper zijn hetzelfde. Dat is geen gewone aankoop, dus de app boekt hem niet als kosten en trekt de btw niet af. Kies wat het was.');
    expect(task!.actions.map((a) => [a.id, a.label])).toEqual(CHOICES);
    expect(task!.why).toMatch(/je eigen KvK-nummer staat erop/);
    expect(task!.group).toBeUndefined();

    // weet ik nog niet: apart op Vraagposten, zonder btw-aftrek, en de leverancier wordt niet onthouden
    const done = s.intake.settleOwn(d.id, 'vraag')!;
    expect(done).toMatchObject({ status: 'verwerkt', outcome: 'nieuwe-aankoop' });
    expect(s.purchases.list()).toEqual([expect.objectContaining({ description: 'Nog uitzoeken — Stukadoorsbedrijf Piet', total: 1089, vat_total: 0, status: 'open' })]);
    expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(1089);
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(0);
    expect(s.memory.get('KalkPlanner')).toBeNull();
    expect(s.memory.get('Stukadoorsbedrijf Piet')).toBeNull();
  });

  for (const choice of ['vraag', 'prive'] as const) {
    it(`factuur eerst, dan de betaling: één vraag voor allebei (${choice})`, async () => {
      const ctx = world();
      const { s } = ctx;
      const d = await s.intake.add('factuur.pdf', pdf, '2026-09-30');
      const before = financialSnapshot(ctx, { vatPeriods: ['2026-Q3', '2026-Q4'] });
      const t = payment(s);
      // niets vanzelf: de betaling staat open, de factuur wacht
      expect(s.bank.get(t.id).status).toBe('nieuw');
      expect(financialSnapshot(ctx, { vatPeriods: ['2026-Q3', '2026-Q4'] })).toEqual({ ...before, bank_transactions: [expect.objectContaining({ id: t.id, status: 'nieuw', matched_journal_entry_id: null })] });
      const tasks = tasksFor(s);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ kind: 'bank-own-company', title: `Factuur van je eigen bedrijf: ${euro}`, ref: { bankTransactionId: t.id, documentId: d.id } });
      expect(tasks[0]!.question).toMatch(/^Dit is een factuur van je eigen bedrijf.*Op 1 oktober 2026 is .{1,3}10,89 van je rekening naar STUKADOORSBEDRIJF PIET gegaan: de betaling ervan\. Kies wat het was; de factuur en de betaling gaan samen mee\.$/);
      expect(tasks[0]!.actions.map((a) => [a.id, a.label])).toEqual(CHOICES);
      expect(s.intake.get(d.id).bank_match?.id).toBe(t.id);

      s.ownCompany.settle(t.id, choice);
      expect(tasksFor(s)).toEqual([]);
      expect(s.bank.get(t.id).status).toBe('gematcht');
      expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(0);
      expect(s.ledger.balances().filter((b) => b.category === 'kosten' && b.balance !== 0)).toEqual([]);
      expect(s.memory.get('Stukadoorsbedrijf Piet')).toBeNull();
      if (choice === 'vraag') {
        // de factuur op Vraagposten, de betaling eraan gekoppeld: één open vraag voor de boekhouder, niet twee
        expect(s.purchases.list()).toEqual([expect.objectContaining({ total: 1089, vat_total: 0, status: 'betaald' })]);
        expect(s.bank.get(t.id).matched_purchase_invoice_id).toBe(s.purchases.list()[0]!.id);
        expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(1089);
        expect(s.intake.get(d.id)).toMatchObject({ outcome: 'nieuwe-aankoop' });
      } else {
        expect(s.purchases.list()).toEqual([]);
        expect(s.ledger.balance(ACCOUNTS.priveOpnamen)).toBe(1089);
        expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(0);
        // de factuur blijft bewaard, als bewijs bij de betaling
        expect(s.intake.get(d.id)).toMatchObject({ outcome: 'bewijs-gekoppeld', link: { target: { kind: 'bank', id: t.id } } });
      }
    });

    it(`betaling eerst, dan de factuur: de keuze bij de betaling geldt, de factuur komt er alleen als bewijs bij (${choice})`, async () => {
      const ctx = world();
      const { s } = ctx;
      const before = financialSnapshot(ctx, { vatPeriods: ['2026-Q4'] });
      const t = payment(s, '2026-09-30');
      expect(s.bank.get(t.id).status).toBe('nieuw');
      const tasks = tasksFor(s);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ kind: 'bank-own-company', title: `${euro} betaald aan je eigen bedrijf`, ref: { bankTransactionId: t.id } });
      expect(tasks[0]!.question).toBe(`Op 30 september 2026 is ${euro} van je rekening naar STUKADOORSBEDRIJF PIET gegaan: dat is je eigen bedrijf, geen eigen rekening. Bijvoorbeeld een betaling voor je eigen dienst. Dat is geen gewone aankoop. Kies wat het was; komt de factuur later binnen, dan hoort die hierbij.`);
      expect(tasks[0]!.actions.map((a) => [a.id, a.label])).toEqual(CHOICES);
      expect({ ...financialSnapshot(ctx, { vatPeriods: ['2026-Q4'] }), bank_transactions: [] }).toEqual(before);

      s.ownCompany.settle(t.id, choice);
      expect(s.ledger.balance(choice === 'vraag' ? ACCOUNTS.vraagposten : ACCOUNTS.priveOpnamen)).toBe(1089);
      expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(0);
      const settled = financialSnapshot(ctx, { vatPeriods: ['2026-Q3', '2026-Q4'] });

      // de factuur komt later: niet nog een keer boeken, alleen de vraag of hij als bewijs bij die betaling hoort
      const d = await s.intake.add('factuur.pdf', pdf, '2026-10-02');
      expect(d.status).toBe('controle');
      expect(s.intake.pending(d)).toMatchObject({ kind: 'evidence', candidate: `bank:${t.id}` });
      expect(d.issues.map((i) => i.field)).toEqual(['own-company', 'evidence']);
      expect(() => s.intake.confirm(d.id, { supplier: 'KalkPlanner', date: '2026-09-30', total: 1089, categoryKey: 'software', vatCode: 'hoog', business: true, paidWith: 'later' })).toThrow();
      expect(financialSnapshot(ctx, { vatPeriods: ['2026-Q3', '2026-Q4'] })).toEqual(settled);
      expect(await s.intake.decide(d.id, 'ja')).toMatchObject({ outcome: 'bewijs-gekoppeld', link: { target: { kind: 'bank', id: t.id } } });
      expect(financialSnapshot(ctx, { vatPeriods: ['2026-Q3', '2026-Q4'] })).toEqual(settled);
      expect(tasksFor(s)).toEqual([]);
    });

    it(`de factuur stond al op "weet ik nog niet": de betaling komt erbij in plaats van een tweede onbekende (${choice})`, async () => {
      const ctx = world();
      const { s } = ctx;
      const d = await s.intake.add('factuur.pdf', pdf, '2026-09-30');
      s.intake.settleOwn(d.id, 'vraag');
      const purchase = s.purchases.list()[0]!;
      const before = financialSnapshot(ctx, { vatPeriods: ['2026-Q3', '2026-Q4'] });
      const t = payment(s);
      // niet vanzelf gekoppeld, en één vraag (niet ook nog "hoort dit bij Nog uitzoeken …?")
      expect(s.bank.get(t.id).status).toBe('nieuw');
      const tasks = tasksFor(s);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ kind: 'bank-own-company', ref: { bankTransactionId: t.id, purchaseId: purchase.id } });
      expect(tasks[0]!.question).toMatch(/De factuur daarvan \(30 september 2026\) staat al op "weet ik nog niet"\. Kies wat het was; de betaling en de factuur gaan samen mee\.$/);
      expect({ ...financialSnapshot(ctx, { vatPeriods: ['2026-Q3', '2026-Q4'] }), bank_transactions: [] }).toEqual({ ...before, bank_transactions: [] });

      s.ownCompany.settle(t.id, choice);
      expect(tasksFor(s)).toEqual([]);
      expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(0);
      if (choice === 'vraag') {
        expect(s.purchases.get(purchase.id)).toMatchObject({ status: 'betaald', total: 1089 });
        expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(1089);
      } else {
        // toch privé: de aankoop op "weet ik nog niet" vervalt (tegenboeking), de betaling is een privé-opname
        expect(s.purchases.list()).toEqual([]);
        expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(0);
        expect(s.ledger.balance(ACCOUNTS.priveOpnamen)).toBe(1089);
        expect(s.intake.get(d.id)).toMatchObject({ outcome: 'bewijs-gekoppeld', link: { target: { kind: 'bank', id: t.id } } });
      }
    });
  }

  it('factuur al op privé gezet toen de betaling er nog niet was: bij de betaling komt de factuur er als bewijs bij', async () => {
    const ctx = world();
    const { s } = ctx;
    const before = financialSnapshot(ctx, { vatPeriods: ['2026-Q3', '2026-Q4'] });
    const d = await s.intake.add('factuur.pdf', pdf, '2026-09-30');
    // privé zonder betaling: er wordt niets geboekt, de factuur blijft bewaard
    expect(s.intake.settleOwn(d.id, 'prive')).toMatchObject({ status: 'genegeerd', outcome: 'niet-geboekt' });
    expect(financialSnapshot(ctx, { vatPeriods: ['2026-Q3', '2026-Q4'] })).toEqual(before);
    const t = payment(s);
    const [task] = tasksFor(s);
    expect(task).toMatchObject({ kind: 'bank-own-company', ref: { bankTransactionId: t.id } });
    expect(task!.question).toMatch(/de factuur die je al op privé zette, komt erbij\.$/);
    s.ownCompany.settle(t.id, 'prive');
    expect(s.ledger.balance(ACCOUNTS.priveOpnamen)).toBe(1089);
    expect(s.purchases.list()).toEqual([]);
    expect(s.intake.get(d.id)).toMatchObject({ outcome: 'bewijs-gekoppeld', link: { target: { kind: 'bank', id: t.id } } });
  });

  it('bestaande gegevens: een open "nog uitzoeken"-aankoop bij je eigen bedrijf naast een losse betaling wordt een vraag; wat al geboekt is blijft staan', async () => {
    const ctx = world();
    const { s } = ctx;
    // zoals het vóór deze versie ging: met de hand op "weet ik nog niet" gezet, zonder dat de app iets herkende
    const lev = s.relations.findOrCreateSupplier('stukadoorsbedrijf piet');
    const purchase = s.purchases.create({ relationId: lev.id, supplierReference: 'I-MOL-2026-00347', invoiceDate: '2026-09-30', description: 'Nog uitzoeken — stukadoorsbedrijf piet', lines: [{ account: ACCOUNTS.vraagposten, netAmount: 1089, vatCode: 'geen' }] });
    const t = payment(s);
    expect(tasksFor(s)).toEqual([expect.objectContaining({ kind: 'bank-own-company', ref: expect.objectContaining({ bankTransactionId: t.id, purchaseId: purchase.id }) })]);
    // allebei al op "weet ik nog niet" gezet (zoals in het issue): de app laat staan wat geboekt is en boekt niets
    // vanzelf; wel vraagt hij of het dezelfde betaling is, want zo staat het bedrag er twee keer (#221)
    s.bank.bookToAccount(t.id, { account: ACCOUNTS.vraagposten, vatCode: 'geen' });
    const booked = financialSnapshot(ctx, { vatPeriods: ['2026-Q3', '2026-Q4'] });
    s.inbox.autoProcess('2026-10-02');
    expect(tasksFor(s)).toEqual([]);
    expect(financialSnapshot(ctx, { vatPeriods: ['2026-Q3', '2026-Q4'] })).toEqual(booked);
    expect(s.inbox.tasks('2026-10-02').filter((x) => x.kind === 'purchase-double')).toMatchObject([{ ref: { purchaseId: purchase.id, bankTransactionId: t.id }, question: expect.stringContaining('al verwerkt als "weet ik nog niet"') }]);
  });

  it('waarschijnlijk: eerst de vraag; ja geeft de twee keuzes, nee ("toch een gewone aankoop") de gewone controle', async () => {
    const ctx = world();
    const { s } = ctx;
    const twijfel = makePdf(['Stukadoorsbedrijf Piet', 'Factuur 2026-0009', 'Datum 12-09-2026', 'Verf 100,00', 'BTW 21% 100,00 21,00', 'Totaal 121,00']);
    const before = financialSnapshot(ctx);
    const d = await s.intake.add('twijfel.pdf', twijfel, '2026-09-13');
    expect(s.intake.ownIssue(d)).toMatchObject({ message: 'Dit lijkt een factuur van je eigen bedrijf: verkoper en koper lijken hetzelfde. Klopt dat?', suggestion: { level: 'waarschijnlijk' } });
    expect(tasksFor(s)[0]!.actions.map((a) => a.id)).toEqual(['open']);
    const gewoon = { supplier: 'Verfhandel', date: '2026-09-12', total: 12100, categoryKey: 'materiaal', vatCode: 'hoog' as const, business: true, paidWith: 'kas' as const };
    expect(() => s.intake.confirm(d.id, gewoon)).toThrow(/eigen bedrijf/);
    const ja = await s.intake.decideOwn(d.id, 'ja');
    expect(s.intake.ownIssue(ja)?.suggestion).toMatchObject({ level: 'zeker', signals: ['je eigen bedrijfsnaam is de verkoper', 'je hebt het zelf bevestigd'] });
    expect(tasksFor(s)[0]!.actions.map((a) => a.id)).toEqual(['prive', 'vraag', 'open']);
    // bij nader inzien toch een gewone aankoop: een uitdrukkelijke stap, daarna de gewone controle
    const nee = await s.intake.decideOwn(d.id, 'nee');
    expect(s.intake.ownIssue(nee)).toBeNull();
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(s.intake.confirm(d.id, gewoon).outcome).toBe('nieuwe-aankoop');
    expect(s.ledger.balance(ACCOUNTS.inkoopMaterialen)).toBe(10000);
  });

  it('ook met "voortaan automatisch" voor die naam wordt een betaling aan je eigen bedrijf nooit vanzelf geboekt', () => {
    const ctx = world();
    const { s } = ctx;
    for (let i = 0; i < 4; i++) s.memory.learn('Stukadoorsbedrijf Piet', { categoryKey: 'software', vatCode: 'hoog', business: true });
    s.memory.setAutomatic(s.memory.get('Stukadoorsbedrijf Piet')!.supplier_key, true);
    const before = financialSnapshot(ctx, { vatPeriods: ['2026-Q4'] });
    const t = payment(s);
    expect(s.bank.get(t.id).status).toBe('nieuw');
    expect({ ...financialSnapshot(ctx, { vatPeriods: ['2026-Q4'] }), bank_transactions: [] }).toEqual(before);
    expect(tasksFor(s).map((x) => x.kind)).toEqual(['bank-own-company']);
  });

  it('een overboeking naar een eigen rekening blijft een overboeking, ook met je eigen naam erbij', () => {
    const { s } = world();
    const spaar = s.bank.addAccount('Spaarrekening', 'NL20INGB0001234567');
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-10-01', amount: -1089, description: 'Sparen', counterName: 'Stukadoorsbedrijf Piet', counterIban: 'NL20INGB0001234567' }] });
    const t = s.bank.list().find((x) => x.amount === -1089)!;
    expect(s.ownCompany.match(t)).toBeNull();
    expect(tasksFor(s).map((x) => x.kind)).toEqual(['bank-own']);
    void spaar;
  });
});
