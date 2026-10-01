import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { financialSnapshot, setup } from './helpers';
import { makePdf } from './pdf';
import { parseDocumentText } from '../src/intake/text-parser';
import { validateDocument } from '../src/intake/validation';
import { parseUbl } from '../src/intake/ubl';
import { supplierKey } from '../src/intake/supplier-memory';
import { extractPdf } from '../src/intake/pdf-text';
import type { OcrProvider } from '../src/intake/ocr';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { compareDuplicate } from '../src/intake/intake';

const bon = [
  'TOOLSTATION AMSTERDAM',
  'Kassabon nr: 55123-889',
  'Datum: 24-09-2026 14:02',
  'Makita accuboormachine 242,00',
  'Subtotaal excl. BTW 200,00',
  'BTW 21% 200,00 42,00',
  'Totaal 242,00',
  'PIN 242,00',
];
const items = (lines: string[]) => lines.map((text, i) => ({ text, page: 1, bbox: [10, 20 + i * 20, 300, 34 + i * 20] as [number, number, number, number], confidence: 0.97 }));

describe('extractie', () => {
  it('parseert een kassabon uit tekst', () => {
    const r = parseDocumentText(items(bon), 'ocr:test');
    expect(r.supplier?.value).toBe('Toolstation');
    expect(r.invoiceDate?.value).toBe('2026-09-24');
    expect(r.invoiceNumber?.value).toBe('55123-889');
    expect(r.total).toMatchObject({ value: 24200, source: 'ocr:test', page: 1 });
    expect(r.total!.bbox).toEqual([10, 140, 300, 154]);
    expect(r.subtotal?.value).toBe(20000);
    expect(r.vat.value).toEqual([{ rate: 21, base: 20000, amount: 4200 }]);
    expect(r.lineDescriptions.join()).toContain('Makita');
  });

  it('UBL e-factuur heeft voorrang en is volledig zeker', () => {
    const r = parseUbl(readFileSync(join(__dirname, 'fixtures', 'ubl-invoice.xml'), 'utf8'));
    expect(r).toMatchObject({ supplier: { value: 'Bouwmaat Nederland B.V.', confidence: 1, source: 'ubl' }, invoiceNumber: { value: '2026018472' }, total: { value: 12100 }, subtotal: { value: 10000 } });
    expect(r.vat.value).toEqual([{ rate: 21, base: 10000, amount: 2100 }]);
    expect(r.supplierIban?.value).toBe('NL91ABNA0417164300');
  });

  it('leest de tekstlaag van een PDF met posities', async () => {
    const pdf = await extractPdf(makePdf(['Gamma Utrecht', 'Factuurdatum 03-09-2026', 'Totaal 30,25', 'BTW 21% 25,00 5,25']));
    expect(pdf.textLength).toBeGreaterThan(30);
    const r = parseDocumentText(pdf.items, 'pdf-text');
    expect(r.supplier?.value).toBe('Gamma');
    expect(r.total?.value).toBe(3025);
    expect(r.total?.bbox?.[1]).toBeGreaterThan(0);
  });
});

describe('validatie', () => {
  it('accepteert een consistent document', () => {
    expect(validateDocument(parseDocumentText(items(bon), 'ocr:x'), '2026-09-25').filter((i) => i.severity === 'fout')).toEqual([]);
  });
  it('vangt een verkeerd gelezen BTW-bedrag', () => {
    const bad = parseDocumentText(items(bon.map((l) => l.replace('42,00', '47,00'))), 'ocr:x');
    const issues = validateDocument(bad, '2026-09-25');
    expect(issues.find((i) => i.field === 'vat.0')).toMatchObject({ severity: 'fout', suggestion: 4200 });
  });
  it('factuur van Mollie: streepjes als eigen tekens van het lettertype, "Betaald op" is geen leverancier, afzender twee keer op een regel', () => {
    // in de tekstlaag staat het streepje als Private Use Area-teken (U+E088); zonder vertaling wordt dat "30092026"
    const d = '\uE088';
    // stukjes op één regel staan tegen elkaar aan (zoals in de tekstlaag): x loopt door, 5 punten per teken
    const row = (y: number, x0: number, parts: string[], gapAfter = 0) => {
      let x = x0;
      return parts.map((text) => {
        const w = text.length * 5;
        const item = { text, page: 1, bbox: [x, y, x + w, y + 8] as [number, number, number, number], confidence: 1 };
        x += w + gapAfter;
        return item;
      });
    };
    const items = [
      ...row(100, 195, ['Factuur I', d, 'MOL', d, '2026', d, '00347']),
      ...row(126, 238, ['Datum van uitgifte: 30', d, '09', d, '2026']),
      ...row(138, 249, ['Vervaldatum: 30', d, '10', d, '2026']),
      ...row(150, 252, ['Betaald op: 30', d, '09', d, '2026']),
      ...row(168, 28, ['Onbekende Uitgever']), ...row(168, 532, ['Onbekende Uitgever']),
      ...row(264, 28, ['KVK', '95207341'], 6),
      ...row(369, 28, ['Abonnement (september 2026)']), ...row(369, 315, ['€ 10,89']), ...row(369, 454, ['21%']), ...row(369, 537, ['€ 10,89']),
      ...row(420, 380, ['Subtotaal excl. BTW']), ...row(420, 520, ['€ 9,00']),
      ...row(432, 380, ['Totaal BTW (21%)']), ...row(432, 520, ['€ 1,89']),
      ...row(444, 380, ['Totaal (EUR)']), ...row(444, 520, ['€ 10,89']),
    ];
    // zoals pdf-text.ts doet vóór het parsen: eigen tekens van het lettertype worden streepjes
    const fixed = items.map((i) => ({ ...i, text: i.text.replace(/[\u0000\uE000-\uF8FF]/g, '-') }));
    const r = parseDocumentText(fixed, 'pdf-text');
    expect(r.invoiceNumber?.value).toBe('I-MOL-2026-00347');
    expect(r.invoiceDate?.value).toBe('2026-09-30');
    expect(r.dueDate?.value).toBe('2026-10-30');
    expect(r.supplier?.value).toBe('Onbekende Uitgever');
    expect(r.total?.value).toBe(1089);
    expect(r.vat.value).toEqual([{ rate: 21, base: null, amount: 189 }]);
    // en zonder de vertaling (bv. OCR die "30092026" leest): de datum achter het kopje wordt toch gevonden
    const glued = items.map((i) => ({ ...i, text: i.text.replace(d, '') }));
    expect(parseDocumentText(glued, 'pdf-text').invoiceDate?.value).toBe('2026-09-30');
  });

  it('normaliseert leveranciersnamen', () => {
    expect(supplierKey('GAMMA UTRECHT B.V. 1234')).toBe('gamma utrecht');
    expect(supplierKey('Bouwmaat Nederland B.V.')).toBe('bouwmaat');
  });
});

describe('documentinbox', () => {
  const ocr = (lines: string[]): OcrProvider => ({ id: 'test', label: 'Test OCR', available: async () => true, recognize: async () => ({ items: items(lines) }) });

  const bouwmaat = (day: number, total = '121,00', nr?: string) => [
    'Bouwmaat Utrecht',
    ...(nr ? [`Factuurnummer: ${nr}`] : []),
    `Datum: ${String(day).padStart(2, '0')}-09-2026`,
    'Gips 100,00',
    'Subtotaal 100,00',
    'BTW 21% 100,00 21,00',
    `Totaal ${total}`,
  ];
  const varOcr = () => {
    const state = { lines: [] as string[] };
    const provider: OcrProvider = { id: 'test', label: 'Test OCR', available: async () => true, recognize: async () => ({ items: items(state.lines) }) };
    return { state, provider };
  };
  /** Een andere bon "voor de camera": de volgende foto wordt zo gelezen. */
  const setOcr = (s: ReturnType<typeof setup>['s'], lines: string[]) => {
    s.intake.setOcrProvider(ocr(lines));
    return s;
  };
  const confirmBouwmaat = (s: ReturnType<typeof setup>['s'], id: number, date: string) =>
    s.intake.confirm(id, { supplier: 'Bouwmaat', date, total: 12100, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas' });

  it('eerste keer: vraag; na bevestigingen: pas automatisch na jouw ja (#22) — en nooit dubbel boeken', async () => {
    const { state, provider } = varOcr();
    const { s } = setup({ ocr: provider });
    s.settings.update({ onboardingDone: true });
    state.lines = bouwmaat(1);
    const d1 = await s.intake.add('bon1.jpg', new Uint8Array([1]), '2026-09-25');
    expect(d1.status).toBe('controle');
    expect(d1.confidence).toBe('MEDIUM');
    expect(d1.classification).toMatchObject({ categoryKey: 'materiaal', vatCode: 'hoog', source: 'regel' });
    confirmBouwmaat(s, d1.id, '2026-09-01');
    expect(s.ledger.balance('WKprInkMat')).toBe(10000);
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(2100);

    for (const [i, day] of [[2, 8], [3, 15]] as const) {
      state.lines = bouwmaat(day);
      const d = await s.intake.add(`bon${i}.jpg`, new Uint8Array([i]), '2026-09-25');
      expect(d.classification).toMatchObject({ source: 'geheugen', automatic: false });
      expect(d.status).toBe('controle');
      confirmBouwmaat(s, d.id, `2026-09-${String(day).padStart(2, "0")}`);
    }
    // Na 3× hetzelfde: de app vraagt het, maar doet het nog niet zelf
    const ask = s.inbox.tasks('2026-09-25').find((t) => t.kind === 'supplier-auto')!;
    expect(ask.title).toContain('Bouwmaat');
    state.lines = bouwmaat(20);
    const d4 = await s.intake.add('bon4.jpg', new Uint8Array([4]), '2026-09-25');
    expect(d4.status).toBe('controle');
    confirmBouwmaat(s, d4.id, '2026-09-20');

    s.memory.setAutomatic(ask.ref.supplierKey!, true);
    expect(s.inbox.tasks('2026-09-25').some((t) => t.kind === 'supplier-auto')).toBe(false);
    state.lines = bouwmaat(24);
    const d5 = await s.intake.add('bon5.jpg', new Uint8Array([5]), '2026-09-25');
    expect(d5.confidence).toBe('HIGH');
    expect(d5.status).toBe('verwerkt');
    expect(s.ledger.balance('WKprInkMat')).toBe(50000);
    expect(s.inbox.home('2026-09-25').automated[0]).toMatchObject({ kind: 'document-auto' });
    // zelfde bestand nogmaals = geen nieuwe boeking
    const again = await s.intake.add('bon5-kopie.jpg', new Uint8Array([5]), '2026-09-25');
    expect(again.id).toBe(d5.id);
    expect(s.ledger.balance('WKprInkMat')).toBe(50000);

    // een correctie zet automatisch weer uit
    s.memory.learn('Bouwmaat', { categoryKey: 'gereedschap', vatCode: 'hoog', business: true });
    expect(s.memory.isAutomatic(s.memory.get('Bouwmaat'))).toBe(false);
  });

  it('dubbele documenten: zeker dubbel wordt niet geboekt, beste bewijs blijft bewaard (#31)', async () => {
    const { state, provider } = varOcr();
    const { s } = setup({ ocr: provider });
    state.lines = bouwmaat(10, '121,00', 'F-2026-001');
    const foto = await s.intake.add('foto.jpg', new Uint8Array([1]), '2026-09-25');
    const done = confirmBouwmaat(s, foto.id, '2026-09-10');
    expect(done.status).toBe('verwerkt');

    // dezelfde factuur komt later als PDF-mail binnen (ander bestand, zelfde nummer + bedrag)
    const pdf = makePdf(bouwmaat(10, '121,00', 'F2026001'));
    const kopie = await s.intake.add('factuur.pdf', pdf, '2026-09-25');
    expect(kopie.status).toBe('genegeerd');
    expect(kopie.duplicate_of_document_id).toBe(foto.id);
    expect(s.ledger.balance('WKprInkMat')).toBe(10000);
    // de PDF-tekst is beter bewijs dan de foto: die wordt de bijlage
    const purchase = s.purchases.list()[0]!;
    expect(purchase.document_id).toBe(kopie.id);
    expect(purchase.attachment_path).toBe(kopie.file_path);
  });

  it('dubbele documenten: mogelijk dubbel wordt gevraagd, niet automatisch geboekt (#31)', async () => {
    const { state, provider } = varOcr();
    const { s } = setup({ ocr: provider });
    s.settings.update({ onboardingDone: true });
    state.lines = bouwmaat(10);
    const a = await s.intake.add('a.jpg', new Uint8Array([1]), '2026-09-25');
    confirmBouwmaat(s, a.id, '2026-09-10');
    state.lines = bouwmaat(11);
    const b = await s.intake.add('b.jpg', new Uint8Array([2]), '2026-09-25');
    expect(b.status).toBe('controle');
    expect(b.confidence).toBe('LOW');
    const task = s.inbox.tasks('2026-09-25').find((t) => t.ref.documentId === b.id)!;
    expect(task.actions[0]!.id).toBe('dubbel');
    const issue = b.issues.find((i) => i.field === 'duplicate')!;
    s.intake.markDuplicate(b.id, issue.suggestion as { documentId: number | null; purchaseId: number | null });
    expect(s.intake.get(b.id).status).toBe('genegeerd');
    expect(s.ledger.balance('WKprInkMat')).toBe(10000);

    // een week later, zelfde bedrag = gewoon een nieuwe aankoop
    state.lines = bouwmaat(20);
    const c = await s.intake.add('c.jpg', new Uint8Array([3]), '2026-09-25');
    expect(c.issues.some((i) => i.field === 'duplicate')).toBe(false);
  });

  it('inconsistent document wordt nooit stilletjes geboekt', async () => {
    const { s } = setup({ ocr: ocr(bon.map((l) => l.replace('42,00', '47,00'))) });
    s.memory.learn('Toolstation', { categoryKey: 'gereedschap', vatCode: 'hoog', business: true });
    s.memory.learn('Toolstation', { categoryKey: 'gereedschap', vatCode: 'hoog', business: true });
    const d = await s.intake.add('bon.jpg', new Uint8Array([9]), '2026-09-25');
    expect(d.confidence).toBe('LOW');
    expect(d.status).toBe('controle');
    expect(s.ledger.balance('WBedAlkGer')).toBe(0);
  });

  it('bank + document: koppelt de bon aan de betaling', async () => {
    const { s } = setup();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-23', amount: -12100, description: 'Betaalautomaat', counterName: 'BOUWMAAT UTRECHT' }] });
    const d = await s.intake.add('factuur.xml', readFileSync(join(__dirname, 'fixtures', 'ubl-invoice.xml')), '2026-09-25');
    expect(d.bank_match?.amount).toBe(-12100);
    const done = s.intake.confirm(d.id, { supplier: 'Bouwmaat', date: '2026-09-23', total: 12100, invoiceNumber: '2026018472', categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'bank' });
    expect(done.status).toBe('verwerkt');
    expect(s.bank.list({ status: 'nieuw' })).toHaveLength(0);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.bank)).toBe(-12100);
  });

  it('privé-bon: niet in de boekhouding, bankbetaling wordt privé-opname', async () => {
    const { s } = setup({ ocr: ocr(['Albert Heijn', 'Datum 20-09-2026', 'Totaal 54,20']) });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-20', amount: -5420, description: 'AH', counterName: 'Albert Heijn' }] });
    const d = await s.intake.add('ah.jpg', new Uint8Array([4]), '2026-09-25');
    s.intake.confirm(d.id, { supplier: 'Albert Heijn', date: '2026-09-20', total: 5420, categoryKey: 'overig', vatCode: 'geen', business: false, paidWith: 'bank' });
    expect(s.intake.get(d.id).status).toBe('genegeerd');
    expect(s.ledger.balance(ACCOUNTS.priveOpnamen)).toBe(5420);
  });

  it('zonder OCR: vraagt de gebruiker om zelf in te vullen', async () => {
    const { s } = setup();
    const d = await s.intake.add('foto.jpg', new Uint8Array([5]), '2026-09-25');
    expect(d.confidence).toBe('LOW');
    expect(d.issues[0]!.message).toMatch(/nog niet uitgelezen/);
  });

  // ---- #179: dubbele bonnen expliciet blokkeren en bewijs veilig koppelen ----

  /** Een betaling die rechtstreeks als kosten geboekt is (zonder aankoop). */
  const bookedPayment = (s: ReturnType<typeof setup>['s'], amount: number, date: string, counterName = 'BOUWMAAT UTRECHT') => {
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date, amount: -amount, description: `Pin ${counterName} ${date}`, counterName }] });
    const t = s.bank.list({ status: 'nieuw' })[0]!;
    s.bank.bookToAccount(t.id, { account: ACCOUNTS.inkoopMaterialen, vatCode: 'hoog' });
    return s.bank.get(t.id);
  };

  it('exact hetzelfde bestand: op elke route geweigerd, met het bestaande document erbij; er verandert niets (#179)', async () => {
    const { state, provider } = varOcr();
    const ctx = setup({ ocr: provider });
    const { s, db } = ctx;
    state.lines = bouwmaat(10, '121,00', 'F-2026-001');
    const foto = await s.intake.add('foto.jpg', new Uint8Array([1]), '2026-09-25');
    expect(foto).toMatchObject({ already_present: false, blocked: null, outcome: 'controle' });
    const done = confirmBouwmaat(s, foto.id, '2026-09-10');
    expect(done).toMatchObject({ outcome: 'nieuwe-aankoop', link: { target: { kind: 'aankoop' }, origin: 'geboekt', is_primary: true } });
    const purchase = s.purchases.list()[0]!;
    const payment = bookedPayment(s, 5000, '2026-09-20', 'GAMMA');
    const other = s.purchases.create({ invoiceDate: '2026-09-02', description: 'Verf', lines: [{ account: ACCOUNTS.inkoopMaterialen, netAmount: 3000, vatCode: 'hoog' }] });

    const before = financialSnapshot(ctx, { evidence: true });
    // gewoon nog een keer toevoegen
    const again = await s.intake.add('foto-kopie.jpg', new Uint8Array([1]), '2026-09-26');
    expect(again).toMatchObject({ id: foto.id, already_present: true, blocked: null, outcome: 'nieuwe-aankoop', original_name: 'foto.jpg' });
    // "Bon toevoegen" bij dezelfde aankoop: stond er al in
    expect(await s.intake.addPurchaseEvidence('foto.jpg', new Uint8Array([1]), purchase.id)).toMatchObject({ id: foto.id, already_present: true, blocked: null, linkable: false });
    // "Bon toevoegen" bij een andere aankoop of bij een betaling: geweigerd, met het bestaande en het gevraagde doel
    expect(await s.intake.addPurchaseEvidence('foto.jpg', new Uint8Array([1]), other.id)).toMatchObject({
      id: foto.id, already_present: true, blocked: { existing: { kind: 'aankoop', id: purchase.id, amount: 12100 }, requested: { kind: 'aankoop', id: other.id } },
    });
    expect(await s.intake.addEvidence('foto.jpg', new Uint8Array([1]), payment.id)).toMatchObject({
      id: foto.id, already_present: true, blocked: { existing: { kind: 'aankoop', id: purchase.id }, requested: { kind: 'bank', id: payment.id, amount: 5000 } },
    });
    expect(financialSnapshot(ctx, { evidence: true })).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM documents').get()).toEqual({ n: 1 });
    // één bestand bewaard, niets achtergebleven en niets weggehaald
    expect(ctx.stored).toHaveLength(1);
    expect(ctx.removed).toEqual([]);
  });

  it('hetzelfde bestand tegelijk (ook via verschillende routes): één document en één bestand, zonder fout (#179)', async () => {
    const ctx = setup({ ocr: ocr(bouwmaat(10, '121,00', 'F-2026-001')) });
    const { s, db } = ctx;
    const payment = bookedPayment(s, 5000, '2026-09-20', 'GAMMA');
    const before = financialSnapshot(ctx);
    const data = new Uint8Array([7]);
    const results = await Promise.all([
      s.intake.add('a.jpg', data, '2026-09-25'),
      s.intake.add('b.jpg', data, '2026-09-25', { autoConfirm: false }),
      s.intake.addEvidence('c.jpg', data, payment.id),
      s.intake.add('d.jpg', data, '2026-09-25'),
    ]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.map((r) => r.already_present)).toEqual([false, true, true, true]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM documents').get()).toEqual({ n: 1 });
    expect(ctx.stored).toHaveLength(1);
    expect(ctx.removed).toEqual([]);
    // de tweede, derde en vierde keer deden niets: geen koppeling aan de betaling, geen aankoop, geen boeking
    expect(db.prepare('SELECT COUNT(*) AS n FROM document_links').get()).toEqual({ n: 0 });
    expect(s.intake.get(results[0]!.id).status).toBe('controle');
    expect(financialSnapshot(ctx)).toEqual(before);
  });

  it('kwam hetzelfde bestand er intussen langs een andere weg in: geen fout en geen los bestand (#179)', async () => {
    const ctx = setup({ ocr: ocr(bouwmaat(10)) });
    const { s, db } = ctx;
    // een ander proces was net eerder met hetzelfde bestand
    const sha = createHash('sha256').update(new Uint8Array([9])).digest('hex');
    const original = db.prepare.bind(db);
    let raced = false;
    db.prepare = ((sql: string) => {
      if (!raced && sql.startsWith('INSERT INTO documents')) {
        raced = true;
        original(`INSERT INTO documents (file_path, original_name, mime_type, sha256) VALUES ('/elders/x.jpg', 'x.jpg', 'image/jpeg', ?)`).run(sha);
      }
      return original(sql);
    }) as typeof db.prepare;
    const r = await s.intake.add('x.jpg', new Uint8Array([9]), '2026-09-25');
    expect(r).toMatchObject({ already_present: true, file_path: '/elders/x.jpg' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM documents').get()).toEqual({ n: 1 });
    expect(ctx.removed).toEqual(ctx.stored);
    // en een e-factuur die er geen is, wordt niet eerst bewaard
    await expect(s.intake.add('geen-factuur.xml', new TextEncoder().encode('<x/>'), '2026-09-25')).rejects.toThrow(/geen e-factuur/);
    expect(ctx.stored).toHaveLength(1);
  });

  it('zeker dubbel: beide bestanden bewaard, niets opnieuw geboekt, de leesbare PDF is het hoofdbewijsstuk en de losse e-factuur blijft als gegevensbron (#179)', async () => {
    const ctx = setup();
    const { s } = ctx;
    const xml = readFileSync(join(__dirname, 'fixtures', 'ubl-invoice.xml'));
    const pdfLines = ['Bouwmaat Nederland B.V.', 'Factuurnummer: 2026018472', 'Factuurdatum 23-09-2026', 'Knauf Goldband 100,00', 'BTW 21% 100,00 21,00', 'Totaal 121,00'];
    // 1. eerst de e-factuur geboekt, daarna dezelfde factuur als PDF
    const ubl = await s.intake.add('factuur.xml', xml, '2026-09-25', { autoConfirm: false });
    s.intake.confirm(ubl.id, { supplier: 'Bouwmaat', date: '2026-09-23', total: 12100, invoiceNumber: '2026018472', categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas' });
    const purchase = s.purchases.list()[0]!;
    expect(purchase.document_id).toBe(ubl.id);
    const before = financialSnapshot(ctx);
    const pdf = await s.intake.add('factuur.pdf', makePdf(pdfLines), '2026-09-26');
    expect(pdf).toMatchObject({ already_present: false, status: 'genegeerd', outcome: 'dubbel', duplicate_of_document_id: ubl.id, link: { target: { kind: 'aankoop', id: purchase.id }, origin: 'dubbel', is_primary: true } });
    expect(financialSnapshot(ctx)).toEqual(before);
    // beide bestanden horen bij de aankoop; de PDF is de bijlage, de e-factuur blijft bewaard met zijn gegevens
    expect(s.intake.links.forTarget({ kind: 'aankoop', id: purchase.id }).map((f) => [f.document_id, f.is_primary, f.origin])).toEqual([[pdf.id, true, 'dubbel'], [ubl.id, false, 'geboekt']]);
    expect(s.purchases.get(purchase.id)).toMatchObject({ document_id: pdf.id, attachment_path: pdf.file_path });
    expect(s.intake.get(ubl.id)).toMatchObject({ outcome: 'nieuwe-aankoop', status: 'verwerkt', result: { invoiceNumber: { value: '2026018472', source: 'ubl' } } });
    expect(ctx.stored).toHaveLength(2);
    // nog een foto van dezelfde factuur: komt erbij, de PDF blijft het hoofdbewijsstuk (vaste volgorde)
    const foto = await setOcr(s, [...pdfLines]).intake.add('foto.jpg', new Uint8Array([3]), '2026-09-27');
    expect(foto).toMatchObject({ outcome: 'dubbel', link: { is_primary: false } });
    expect(s.purchases.get(purchase.id).document_id).toBe(pdf.id);
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(s.purchases.list()).toHaveLength(1);
  });

  it('zeker dubbel van een bon die nog niet geboekt is: de app gaat verder met de best gelezen, en bij het boeken horen beide erbij (#179)', async () => {
    const ctx = setup();
    const { s } = ctx;
    const pdfLines = ['Bouwmaat Nederland B.V.', 'Factuurnummer: 2026018472', 'Factuurdatum 23-09-2026', 'Knauf Goldband 100,00', 'BTW 21% 100,00 21,00', 'Totaal 121,00'];
    const pdf = await s.intake.add('factuur.pdf', makePdf(pdfLines), '2026-09-25', { autoConfirm: false });
    expect(pdf.status).toBe('controle');
    const ubl = await s.intake.add('factuur.xml', readFileSync(join(__dirname, 'fixtures', 'ubl-invoice.xml')), '2026-09-25', { autoConfirm: false });
    // de e-factuur is het best gelezen: daarmee controleer je; de PDF wacht als kopie
    expect(ubl.status).toBe('controle');
    expect(s.intake.get(pdf.id)).toMatchObject({ status: 'genegeerd', outcome: 'dubbel', duplicate_of_document_id: ubl.id, link: null });
    // de kopie zelf boeken kan niet
    expect(() => s.intake.confirm(pdf.id, { supplier: 'Bouwmaat', date: '2026-09-23', total: 12100, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas' })).toThrow(/kopie/);
    s.intake.confirm(ubl.id, { supplier: 'Bouwmaat', date: '2026-09-23', total: 12100, invoiceNumber: '2026018472', categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas' });
    const purchase = s.purchases.list()[0]!;
    expect(s.purchases.list()).toHaveLength(1);
    expect(s.ledger.balance('WKprInkMat')).toBe(10000);
    expect(s.intake.get(pdf.id)).toMatchObject({ outcome: 'dubbel', link: { target: { kind: 'aankoop', id: purchase.id }, is_primary: true } });
    expect(s.intake.get(ubl.id)).toMatchObject({ outcome: 'nieuwe-aankoop', link: { is_primary: false } });
    expect(purchase.attachment_path).toBe(pdf.file_path);
  });

  it('wanneer is het zeker dubbel? Alleen met hetzelfde betrouwbare nummer, zonder andere datum, van dezelfde soort (#179)', () => {
    const base = { number: 'f2026001', reliable: true, date: '2026-09-10', credit: false };
    expect(compareDuplicate(base, { ...base })).toEqual({ strength: 'zeker' });
    expect(compareDuplicate(base, { ...base, date: null })).toEqual({ strength: 'zeker' });
    expect(compareDuplicate(base, { ...base, date: '2026-09-11' })).toEqual({ strength: 'mogelijk', reason: 'datum' });
    expect(compareDuplicate(base, { ...base, reliable: false })).toEqual({ strength: 'mogelijk', reason: 'nummer' });
    expect(compareDuplicate(base, { ...base, credit: true })).toEqual({ strength: 'mogelijk', reason: 'soort' });
    // zonder nummer: alleen rond dezelfde datum, en dan nooit zeker
    expect(compareDuplicate(base, { ...base, number: null })).toEqual({ strength: 'mogelijk', reason: 'nummer' });
    expect(compareDuplicate({ ...base, number: null }, { ...base, number: null, date: '2026-09-13', credit: true })).toEqual({ strength: 'mogelijk', reason: 'soort' });
    expect(compareDuplicate(base, { ...base, number: null, date: '2026-09-20' })).toBeNull();
    // twee verschillende nummers: twee facturen
    expect(compareDuplicate(base, { ...base, number: 'f2026002' })).toBeNull();
  });

  it('andere datum, geen betrouwbaar nummer of creditnota naast factuur: nooit vanzelf samengevoegd, altijd een vraag (#179)', async () => {
    const { state, provider } = varOcr();
    const ctx = setup({ ocr: provider });
    const { s } = ctx;
    state.lines = bouwmaat(10, '121,00', 'F-2026-001');
    const foto = await s.intake.add('foto.jpg', new Uint8Array([1]), '2026-09-25');
    s.intake.confirm(foto.id, { supplier: 'Bouwmaat', date: '2026-09-10', total: 12100, invoiceNumber: 'F-2026-001', categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas' });
    const purchase = s.purchases.list()[0]!;
    const before = financialSnapshot(ctx);
    const cases: [string, Uint8Array, string][] = [
      ['andere datum', makePdf(bouwmaat(11, '121,00', 'F2026001')), 'datum'],
      ['creditnota', makePdf(['Creditnota', ...bouwmaat(10, '121,00', 'F2026001')]), 'soort'],
      ['geen nummer', makePdf(bouwmaat(10)), 'nummer'],
    ];
    for (const [name, data, reason] of cases) {
      const d = await s.intake.add(`${name}.pdf`, data, '2026-09-26');
      expect(d, name).toMatchObject({ status: 'controle', outcome: 'controle', link: null, duplicate_of_document_id: null });
      expect(d.issues.find((i) => i.field === 'duplicate'), name).toMatchObject({ severity: 'fout', suggestion: { strength: 'mogelijk', reason, purchaseId: purchase.id } });
      expect(s.intake.pending(d), name).toMatchObject({ kind: 'duplicate', candidate: `aankoop:${purchase.id}`, target: { supplier: 'Bouwmaat', date: '2026-09-10', amount: 12100, reference: 'F-2026-001' } });
      // even uit de weg voor de volgende
      s.intake.ignore(d.id);
    }
    // slecht gelezen nummer (foto, onscherp): telt niet als betrouwbaar
    state.lines = bouwmaat(10, '121,00', 'F-2026-001');
    const vaag: OcrProvider = { id: 'vaag', label: 'Vaag', available: async () => true, recognize: async () => ({ items: items(state.lines).map((i) => ({ ...i, confidence: 0.8 })) }) };
    s.intake.setOcrProvider(vaag);
    const onscherp = await s.intake.add('onscherp.jpg', new Uint8Array([5]), '2026-09-26');
    expect(onscherp.issues.find((i) => i.field === 'duplicate')?.suggestion).toMatchObject({ strength: 'mogelijk', reason: 'nummer' });
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(s.purchases.list()).toHaveLength(1);
  });

  it('mogelijk dubbel: Later verandert niets, Nee gaat verder als nieuwe aankoop, Ja bewaart beide zonder te boeken (#179)', async () => {
    const { state, provider } = varOcr();
    const ctx = setup({ ocr: provider });
    const { s, db } = ctx;
    s.settings.update({ onboardingDone: true });
    state.lines = bouwmaat(10);
    const a = await s.intake.add('a.jpg', new Uint8Array([1]), '2026-09-25');
    confirmBouwmaat(s, a.id, '2026-09-10');
    const purchase = s.purchases.list()[0]!;
    state.lines = bouwmaat(11);
    const b = await s.intake.add('b.jpg', new Uint8Array([2]), '2026-09-25');
    const candidate = `aankoop:${purchase.id}`;
    expect(s.intake.pending(b)).toMatchObject({ kind: 'duplicate', candidate, documentId: a.id });
    // niet te boeken zolang de vraag openstaat
    expect(() => confirmBouwmaat(s, b.id, '2026-09-11')).toThrow(/Kies eerst/);

    // Later: er verandert helemaal niets
    const before = financialSnapshot(ctx, { evidence: true });
    await s.intake.decide(b.id, 'later');
    expect(financialSnapshot(ctx, { evidence: true })).toEqual(before);
    expect(s.inbox.tasks('2026-09-25').find((t) => t.ref.documentId === b.id)).toMatchObject({ ref: { candidate }, actions: [{ id: 'dubbel', label: 'Ja, dezelfde aankoop' }, { id: 'nee', label: 'Nee, andere aankoop' }, { id: 'open' }] });

    // een verouderd voorstel (de taak toonde iets anders) wordt niet uitgevoerd
    await expect(s.intake.decide(b.id, 'ja', 'aankoop:999')).rejects.toThrow(/intussen veranderd/);

    // Nee: het voorstel vervalt, de bon blijft ongekoppeld op controle en de gewone controle gaat verder
    const fin = financialSnapshot(ctx);
    const nee = await s.intake.decide(b.id, 'nee', candidate);
    expect(nee).toMatchObject({ status: 'controle', link: null, duplicate_of_document_id: null });
    expect(nee.issues.some((i) => i.field === 'duplicate')).toBe(false);
    expect(s.intake.pending(nee)).toBeNull();
    expect(nee.classification).toMatchObject({ categoryKey: 'materiaal' });
    expect(financialSnapshot(ctx)).toEqual(fin);
    // dezelfde kandidaat komt niet meteen terug
    expect(s.intake.pending(await s.intake.evaluate(b.id, [], '2026-09-26', { autoConfirm: false }))).toBeNull();
    // verandert de bon (hier: het bedrag opnieuw gelezen, zelfde uitkomst maar andere datum), dan geldt de afwijzing niet meer
    const changed = { ...nee.result!, invoiceDate: { ...nee.result!.invoiceDate!, value: '2026-09-12' } };
    db.prepare('UPDATE documents SET result = ? WHERE id = ?').run(JSON.stringify(changed), b.id);
    expect(s.intake.pending(await s.intake.evaluate(b.id, [], '2026-09-26', { autoConfirm: false }))).toMatchObject({ candidate });
    expect(financialSnapshot(ctx)).toEqual(fin);
    // nu wél verder als nieuwe aankoop: dat is de keuze van de gebruiker
    await s.intake.decide(b.id, 'nee', candidate);
    expect(confirmBouwmaat(s, b.id, '2026-09-12')).toMatchObject({ outcome: 'nieuwe-aankoop' });
    expect(s.ledger.balance('WKprInkMat')).toBe(20000);

    // Ja: beide bestanden bewaard, niets opnieuw geboekt
    state.lines = bouwmaat(9);
    const c = await s.intake.add('c.jpg', new Uint8Array([3]), '2026-09-25');
    const proposed = s.intake.pending(c)!;
    const fin2 = financialSnapshot(ctx);
    const ja = await s.intake.decide(c.id, 'ja', proposed.candidate);
    expect(ja).toMatchObject({ status: 'genegeerd', outcome: 'dubbel', link: { origin: 'dubbel', provenance: 'gebruiker', is_primary: false } });
    expect(financialSnapshot(ctx)).toEqual(fin2);
    expect(s.ledger.balance('WKprInkMat')).toBe(20000);
    expect(ctx.stored).toHaveLength(3);
  });

  it('een afwijzing geldt voor die ene kandidaat: de volgende wordt gewoon voorgesteld (#179)', async () => {
    const { state, provider } = varOcr();
    const { s } = setup({ ocr: provider });
    for (const [i, day] of [[1, 10], [2, 12]] as const) {
      state.lines = bouwmaat(day, '121,00', `F-${i}`);
      const d = await s.intake.add(`bon${i}.jpg`, new Uint8Array([i]), '2026-09-25');
      s.intake.confirm(d.id, { supplier: 'Bouwmaat', date: `2026-09-${day}`, total: 12100, invoiceNumber: `F-${i}`, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas' });
    }
    const [second, first] = s.purchases.list();
    state.lines = bouwmaat(11);
    const d = await s.intake.add('los.jpg', new Uint8Array([3]), '2026-09-25');
    expect(s.intake.pending(d)?.candidate).toBe(`aankoop:${first!.id}`);
    const after = await s.intake.decide(d.id, 'nee');
    expect(s.intake.pending(after)?.candidate).toBe(`aankoop:${second!.id}`);
    expect(s.intake.pending(await s.intake.decide(d.id, 'nee'))).toBeNull();
  });

  it('bon bij een betaling die al als kosten geboekt is: nooit stil koppelen; Ja koppelt alleen het bewijs, Nee en Later laten alles staan (#179)', async () => {
    const ctx = setup({ ocr: ocr(bouwmaat(23)) });
    const { s } = ctx;
    s.settings.update({ onboardingDone: true, autopilot: 'maximaal' });
    const payment = bookedPayment(s, 12100, '2026-09-23');
    const before = financialSnapshot(ctx);
    const d = await s.intake.add('bon.jpg', new Uint8Array([1]), '2026-09-25');
    // er is niets gekoppeld en niets geboekt: de bon wacht op een antwoord
    expect(d).toMatchObject({ status: 'controle', outcome: 'controle', link: null, purchase_invoice_id: null });
    expect(d.issues).toEqual([expect.objectContaining({ field: 'evidence', severity: 'fout', message: 'Deze betaling is al geboekt. Wil je deze bon alleen als bewijsstuk koppelen?' })]);
    const candidate = `bank:${payment.id}`;
    expect(s.intake.pending(d)).toMatchObject({ kind: 'evidence', candidate, target: { kind: 'bank', amount: 12100, date: '2026-09-23', supplier: 'BOUWMAAT UTRECHT' } });
    const task = s.inbox.tasks('2026-09-25').find((t) => t.ref.documentId === d.id)!;
    expect(task.question).toMatch(/Deze betaling is al geboekt\. Wil je deze bon alleen als bewijsstuk koppelen\?$/);
    expect(task.actions.map((x) => [x.id, x.label])).toEqual([['bewijs', 'Ja, alleen als bewijs'], ['nee', 'Nee, andere aankoop'], ['open', 'Bekijken']]);
    expect(task.actions[0]!.hint).toMatch(/geen nieuwe kosten- of btw-boeking/);
    expect(() => confirmBouwmaat(s, d.id, '2026-09-23')).toThrow(/Kies eerst/);
    expect(financialSnapshot(ctx)).toEqual(before);

    // Later
    const untouched = financialSnapshot(ctx, { evidence: true });
    await s.intake.decide(d.id, 'later');
    expect(financialSnapshot(ctx, { evidence: true })).toEqual(untouched);

    // Nee: alleen deze betaling is afgewezen; de gewone controle gaat verder en er is nog steeds niets geboekt
    const nee = await s.intake.decide(d.id, 'nee', candidate);
    expect(nee).toMatchObject({ status: 'controle', link: null });
    expect(s.intake.pending(nee)).toBeNull();
    expect(nee.classification).toMatchObject({ categoryKey: 'materiaal' });
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(s.intake.pending(await s.intake.evaluate(d.id, [], '2026-09-26'))).toBeNull();

    // een tweede bon bij dezelfde betaling: Ja koppelt alleen het bewijs
    s.intake.ignore(d.id);
    const e = await setOcr(s, bouwmaat(23)).intake.add('bon2.jpg', new Uint8Array([2]), '2026-09-25');
    expect(s.intake.pending(e)?.candidate).toBe(candidate);
    const ja = await s.intake.decide(e.id, 'ja', candidate);
    expect(ja).toMatchObject({ status: 'verwerkt', outcome: 'bewijs-gekoppeld', issues: [], link: { target: { kind: 'bank', id: payment.id }, origin: 'bewijs', provenance: 'gebruiker', is_primary: true } });
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(s.purchases.list()).toHaveLength(0);
  });

  it('koppeling ongedaan maken: de bon gaat terug naar controle, de geboekte betaling blijft precies zoals hij is (#179)', async () => {
    const ctx = setup({ ocr: ocr(bouwmaat(23)) });
    const { s } = ctx;
    const payment = bookedPayment(s, 12100, '2026-09-23');
    const d = await s.intake.add('bon.jpg', new Uint8Array([1]), '2026-09-25');
    await s.intake.decide(d.id, 'ja');
    const before = financialSnapshot(ctx);
    const loose = await s.intake.unlink(d.id, '2026-09-26');
    expect(loose).toMatchObject({ status: 'controle', outcome: 'controle', link: null });
    // niet meteen opnieuw voorgesteld, en ook niet vanzelf opnieuw gekoppeld of geboekt
    expect(s.intake.pending(loose)).toBeNull();
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(s.bank.get(payment.id)).toMatchObject({ status: 'gematcht', matched_journal_entry_id: payment.matched_journal_entry_id });
    expect(s.intake.links.forTarget({ kind: 'bank', id: payment.id })).toEqual([]);
    await expect(s.intake.unlink(d.id)).rejects.toThrow(/nergens aan gekoppeld/);

    // een bon waaruit de aankoop geboekt is, maak je niet los: dan zou hij zo dubbel geboekt kunnen worden
    const g = await setOcr(s, bouwmaat(2, '60,50')).intake.add('gamma.jpg', new Uint8Array([2]), '2026-09-25');
    s.intake.confirm(g.id, { supplier: 'Bouwmaat', date: '2026-09-02', total: 6050, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas' });
    const fin = financialSnapshot(ctx, { evidence: true });
    await expect(s.intake.unlink(g.id)).rejects.toThrow(/Weghalen/);
    expect(financialSnapshot(ctx, { evidence: true })).toEqual(fin);
  });
});
