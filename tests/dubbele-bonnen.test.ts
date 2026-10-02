import { describe, expect, it } from 'vitest';
import { financialSnapshot, setup } from './helpers';
import { makePdf } from './pdf';
import { createApi, type HostContext } from '../src/main/api';
import { validateDocument } from '../src/intake/validation';
import { parseDocumentText } from '../src/intake/text-parser';
import type { OcrProvider } from '../src/intake/ocr';
import type { DuplicateMatch } from '../src/intake/intake';
import type { FetchLike } from '../src/integrations/types';

type S = ReturnType<typeof setup>['s'];

const items = (lines: string[]) => lines.map((text, i) => ({ text, page: 1, bbox: [10, 20 + i * 20, 300, 34 + i * 20] as [number, number, number, number], confidence: 0.97 }));
const varOcr = () => {
  const state = { lines: [] as string[] };
  const provider: OcrProvider = { id: 'test', label: 'Test OCR', available: async () => true, recognize: async () => ({ items: items(state.lines) }) };
  return { state, provider };
};

/** De factuur van een abonnement; `nr` is het nummer dat de leverancier erop zet. */
const factuur = (naam: string, nr: string | null, datum: string, totaal: string) => [naam, ...(nr ? [`Factuurnummer: ${nr}`] : []), `Datum: ${datum}`, `Abonnement ${totaal}`, `Totaal ${totaal}`];
/** De bon van de betaling van diezelfde factuur: hetzelfde nummer, het bedrag zoals het is afgeschreven. */
const bon = (naam: string, nr: string | null, datum: string, totaal: string) => [naam, ...(nr ? [`Kassabon nr: ${nr}`] : []), `Datum: ${datum}`, `Abonnement ${totaal}`, `Totaal ${totaal}`, `PIN ${totaal}`];

const boek = (s: S, id: number, supplier: string, date: string, total: number, invoiceNumber: string | null = null) =>
  s.intake.confirm(id, { supplier, date, total, invoiceNumber, categoryKey: 'software', vatCode: 'geen', business: true, paidWith: 'later' });
const voorstel = (d: { issues: { field: string; suggestion?: unknown }[] }) => d.issues.find((i) => i.field === 'duplicate')?.suggestion as DuplicateMatch | undefined;

describe('dubbel-detectie van bonnen (#224)', () => {
  it('bon en factuur met hetzelfde nummer maar een ander bedrag: eerst de vraag, geen tweede aankoop', async () => {
    const { state, provider } = varOcr();
    const ctx = setup({ ocr: provider });
    const { s } = ctx;
    state.lines = factuur('Wolkendienst', 'WD-2026-0042', '20-09-2026', '15,77');
    const eerste = await s.intake.add('factuur.jpg', new Uint8Array([1]), '2026-09-25', { autoConfirm: false });
    boek(s, eerste.id, 'Wolkendienst', '2026-09-20', 1577, 'WD-2026-0042');
    const aankoop = s.purchases.list()[0]!;
    const voor = financialSnapshot(ctx);

    // de bon van de betaling: hetzelfde nummer, het bedrag een paar cent anders en de datum verkeerd gelezen
    state.lines = bon('Wolkendienst', 'WD20260042', '10-12-2026', '15,96');
    const tweede = await s.intake.add('bon.jpg', new Uint8Array([2]), '2026-09-25');
    expect(tweede).toMatchObject({ status: 'controle', link: null, duplicate_of_document_id: null });
    expect(voorstel(tweede)).toMatchObject({ strength: 'mogelijk', reason: 'bedrag', purchaseId: aankoop.id });
    expect(s.intake.pending(tweede)).toMatchObject({ kind: 'duplicate', candidate: `aankoop:${aankoop.id}` });
    // niet te boeken zolang de vraag openstaat, en er is niets bijgekomen
    expect(() => boek(s, tweede.id, 'Wolkendienst', '2026-09-20', 1596, 'WD-2026-0042')).toThrow(/Kies eerst/);
    expect(financialSnapshot(ctx)).toEqual(voor);

    // Ja: de bon hoort bij de aankoop die er al staat; er wordt niets geboekt
    const ja = await s.intake.decide(tweede.id, 'ja');
    expect(ja).toMatchObject({ status: 'genegeerd', outcome: 'dubbel' });
    expect(financialSnapshot(ctx)).toEqual(voor);
    expect(s.purchases.list()).toHaveLength(1);
  });

  it('een ander nummer of een nummer van minder dan drie tekens is geen reden voor een vraag; "Nee" geldt zolang de bon niet verandert', async () => {
    const { state, provider } = varOcr();
    const { s } = setup({ ocr: provider });
    state.lines = factuur('Wolkendienst', 'WD-2026-0042', '20-09-2026', '15,77');
    boek(s, (await s.intake.add('a.jpg', new Uint8Array([1]), '2026-09-25', { autoConfirm: false })).id, 'Wolkendienst', '2026-09-20', 1577, 'WD-2026-0042');
    state.lines = factuur('Wolkendienst', '07', '21-09-2026', '9,00');
    boek(s, (await s.intake.add('b.jpg', new Uint8Array([2]), '2026-09-25', { autoConfirm: false })).id, 'Wolkendienst', '2026-09-21', 900, '07');

    // de factuur van de maand erna: ander nummer, ander bedrag
    state.lines = factuur('Wolkendienst', 'WD-2026-0051', '20-10-2026', '16,10');
    expect(voorstel(await s.intake.add('c.jpg', new Uint8Array([3]), '2026-10-21', { autoConfirm: false }))).toBeUndefined();
    // "07" zegt te weinig: zo'n kort nummer komt bij een andere bon zo weer terug
    state.lines = factuur('Wolkendienst', '07', '28-09-2026', '12,00');
    expect(voorstel(await s.intake.add('d.jpg', new Uint8Array([4]), '2026-09-29', { autoConfirm: false }))).toBeUndefined();
    // hetzelfde nummer bij een andere leverancier: toeval
    state.lines = factuur('Printhuis', 'WD-2026-0042', '20-09-2026', '48,40');
    expect(voorstel(await s.intake.add('e.jpg', new Uint8Array([5]), '2026-09-25', { autoConfirm: false }))).toBeUndefined();

    state.lines = bon('Wolkendienst', 'WD-2026-0042', '22-09-2026', '15,96');
    const dubbel = await s.intake.add('f.jpg', new Uint8Array([6]), '2026-09-25', { autoConfirm: false });
    expect(voorstel(dubbel)).toMatchObject({ strength: 'mogelijk', reason: 'bedrag' });
    const nee = await s.intake.decide(dubbel.id, 'nee');
    expect(s.intake.pending(nee)).toBeNull();
    expect(s.intake.pending(await s.intake.evaluate(dubbel.id, [], '2026-09-26', { autoConfirm: false }))).toBeNull();
  });

  it('een leverancier die net anders geschreven is: met hetzelfde nummer een vraag, nooit vanzelf samengevoegd', async () => {
    const { state, provider } = varOcr();
    const ctx = setup({ ocr: provider });
    const { s } = ctx;
    state.lines = factuur('Pakketreus EU S.a.r.l.', 'PR-778812', '12-09-2026', '24,20');
    const eerste = await s.intake.add('factuur.jpg', new Uint8Array([1]), '2026-09-25', { autoConfirm: false });
    boek(s, eerste.id, 'Pakketreus EU S.a.r.l.', '2026-09-12', 2420, 'PR-778812');
    const aankoop = s.purchases.list()[0]!;
    const voor = financialSnapshot(ctx);

    // dezelfde factuur als PDF, met de korte naam: zelfde nummer, bedrag en datum
    const kopie = await s.intake.add('factuur.pdf', makePdf(factuur('Pakketreus', 'PR-778812', '12-09-2026', '24,20')), '2026-09-25');
    expect(kopie).toMatchObject({ status: 'controle', duplicate_of_document_id: null });
    expect(voorstel(kopie)).toMatchObject({ strength: 'mogelijk', reason: 'leverancier', purchaseId: aankoop.id });
    s.intake.ignore(kopie.id);
    // en met een ander bedrag: ook een vraag
    const anders = await s.intake.add('bon.pdf', makePdf(bon('Pakketreus', 'PR-778812', '13-09-2026', '24,95')), '2026-09-25');
    expect(voorstel(anders)).toMatchObject({ strength: 'mogelijk', reason: 'bedrag', purchaseId: aankoop.id });
    s.intake.ignore(anders.id);
    // zonder nummer: hetzelfde bedrag rond dezelfde datum
    const zonder = await s.intake.add('los.pdf', makePdf(bon('Pakketreus', null, '13-09-2026', '24,20')), '2026-09-25');
    expect(voorstel(zonder)).toMatchObject({ strength: 'mogelijk', purchaseId: aankoop.id });
    s.intake.ignore(zonder.id);
    // alleen een algemeen eerste woord gelijk: dat is een andere leverancier
    state.lines = factuur('Studio Noord', 'SN-1001', '12-09-2026', '60,50');
    boek(s, (await s.intake.add('studio.jpg', new Uint8Array([2]), '2026-09-25', { autoConfirm: false })).id, 'Studio Noord', '2026-09-12', 6050, 'SN-1001');
    const zuid = await s.intake.add('zuid.pdf', makePdf(factuur('Studio Zuid', 'SN-1001', '12-09-2026', '60,50')), '2026-09-25', { autoConfirm: false });
    expect(voorstel(zuid)).toBeUndefined();
    expect(s.purchases.list()).toHaveLength(2);
    expect(s.ledger.balance('WBedKanSof')).toBe(2420 + 6050);
    expect(financialSnapshot(ctx).purchase_invoices.slice(0, 1)).toEqual(voor.purchase_invoices);
  });

  it('vreemde munt: een bon in euro\'s naast de factuur in dollars is binnen de koersmarge "mogelijk dubbel"', async () => {
    const CSV = ['KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE', 'EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-09-18,1.1415'].join('\n');
    const fetch = (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => CSV })) as unknown as FetchLike;
    const ctx = setup({ fetch });
    const { s } = ctx;
    const usd = await s.intake.add('invoice.pdf', makePdf(['Invoice', 'Date of issue September 20, 2026', 'Wolkendienst, Inc.', 'Plan 1 $18.00', 'Total $18.00', 'Amount due $18.00 USD']), '2026-09-25', { autoConfirm: false });
    expect(usd.result).toMatchObject({ total: { value: 1577 }, foreign: { currency: 'USD', total: 1800 } });
    s.intake.confirm(usd.id, { supplier: 'Wolkendienst', date: '2026-09-20', total: 1577, categoryKey: 'software', vatCode: 'buiten-eu', business: true, paidWith: 'later' });
    const aankoop = s.purchases.list()[0]!;
    expect(aankoop).toMatchObject({ currency: 'USD', foreign_total: 1800, total: 1577 });
    const voor = financialSnapshot(ctx);

    // de bon van de betaling staat in euro's: wat er is afgeschreven, met de koers van de kaart
    const eur = await s.intake.add('bon.pdf', makePdf(bon('Wolkendienst', null, '21-09-2026', '15,96')), '2026-09-25');
    expect(eur.status).toBe('controle');
    expect(voorstel(eur)).toMatchObject({ strength: 'mogelijk', purchaseId: aankoop.id });
    expect(financialSnapshot(ctx)).toEqual(voor);
    s.intake.ignore(eur.id);
    // buiten de marge is het een andere aankoop
    const duurder = await s.intake.add('duurder.pdf', makePdf(bon('Wolkendienst', null, '21-09-2026', '18,00')), '2026-09-25', { autoConfirm: false });
    expect(voorstel(duurder)).toBeUndefined();
    // twee bonnen in euro's met een paar cent verschil en zonder nummer: geen vraag, zoals het was
    const { s: t } = setup();
    boek(t, (await t.intake.add('a.pdf', makePdf(bon('Wolkendienst', null, '20-09-2026', '15,77')), '2026-09-25', { autoConfirm: false })).id, 'Wolkendienst', '2026-09-20', 1577);
    expect(voorstel(await t.intake.add('b.pdf', makePdf(bon('Wolkendienst', null, '21-09-2026', '15,96')), '2026-09-25', { autoConfirm: false }))).toBeUndefined();
  });

  it('handmatige invoer naast een aankoop die er al staat: eerst de vraag, pas na "Toch toevoegen" een tweede aankoop', async () => {
    const { state, provider } = varOcr();
    const ctx = setup({ ocr: provider });
    const { s } = ctx;
    state.lines = factuur('Pakketreus EU S.a.r.l.', 'PR-778812', '12-09-2026', '24,20');
    const doc = await s.intake.add('factuur.jpg', new Uint8Array([1]), '2026-09-25', { autoConfirm: false });
    boek(s, doc.id, 'Pakketreus EU S.a.r.l.', '2026-09-12', 2420, 'PR-778812');
    const aankoop = s.purchases.list()[0]!;
    const voor = financialSnapshot(ctx);
    const invoer = { date: '2026-09-13', supplierName: 'Pakketreus', description: 'Kabels', categoryKey: 'kantoor', grossAmount: 2420, vatCode: 'hoog' as const, paidWith: 'bank' as const };

    // zelfde bedrag rond dezelfde datum, de naam korter getypt
    expect(s.quick.duplicateOf(invoer)).toMatchObject({ strength: 'mogelijk', purchaseId: aankoop.id });
    expect(() => s.quick.recordExpense(invoer)).toThrow(/Lijkt op de aankoop bij Pakketreus EU S\.a\.r\.l\..*Toch toevoegen/);
    // hetzelfde nummer met een ander bedrag
    expect(() => s.quick.recordExpense({ ...invoer, date: '2026-10-20', grossAmount: 2495, supplierReference: 'PR 778812' })).toThrow(/Lijkt op/);
    expect(financialSnapshot(ctx)).toEqual(voor);
    // een week later hetzelfde bedrag, of een ander bedrag zonder nummer: gewoon een nieuwe aankoop
    expect(s.quick.duplicateOf({ ...invoer, date: '2026-09-20' })).toBeNull();
    expect(s.quick.duplicateOf({ ...invoer, grossAmount: 1210 })).toBeNull();
    expect(s.quick.duplicateOf({ ...invoer, supplierName: 'Printhuis' })).toBeNull();
    expect(s.quick.duplicateOf({ ...invoer, supplierName: null })).toBeNull();

    // de gebruiker heeft gekeken en kiest "Toch toevoegen"
    const extra = s.quick.recordExpense({ ...invoer, allowDuplicate: true });
    expect(extra.total).toBe(2420);
    expect(s.purchases.list()).toHaveLength(2);
  });

  it('een bon die nog op controle wacht telt ook mee bij handmatige invoer, en de route api.purchases.create vraagt het net zo', async () => {
    const { state, provider } = varOcr();
    const ctx = setup({ ocr: provider });
    const { s } = ctx;
    const api = createApi(s, { appVersion: () => '0.0.0', hasSmtpPassword: () => false } as unknown as HostContext);
    state.lines = bon('Printhuis', 'K-55123', '14-09-2026', '48,40');
    const wacht = await s.intake.add('bon.jpg', new Uint8Array([1]), '2026-09-25', { autoConfirm: false });
    expect(wacht.status).toBe('controle');
    expect(api.purchases.duplicateOf({ date: '2026-09-14', supplierName: 'Printhuis', grossAmount: 4840 })).toMatchObject({ documentId: wacht.id, purchaseId: null });
    expect(() => api.purchases.recordExpense({ date: '2026-09-14', supplierName: 'Printhuis', description: 'Drukwerk', categoryKey: 'kantoor', grossAmount: 4840, vatCode: 'hoog', paidWith: 'bank' })).toThrow(/Lijkt op het document van Printhuis/);

    const relationId = s.relations.findOrCreateSupplier('Printhuis').id;
    const input = { relationId, supplierReference: 'K-55123', invoiceDate: '2026-09-30', description: 'Drukwerk — Printhuis', lines: [{ account: 'WBedKanKan', netAmount: 5000, vatCode: 'hoog' as const, vatAmount: 1050 }] };
    expect(() => api.purchases.create(input)).toThrow(/Lijkt op/);
    expect(s.purchases.list()).toHaveLength(0);
    expect(api.purchases.create(input, { allowDuplicate: true }).total).toBe(6050);
    // zonder leverancier valt er niets te vergelijken
    expect(api.purchases.create({ ...input, relationId: null }).total).toBe(6050);
  });

  it('een datum in de toekomst op een bon: een waarschuwing die je ziet, en op Vandaag geen "Ja" met één klik', async () => {
    const lines = bon('Printhuis', 'K-55123', '10-12-2026', '48,40');
    const gelezen = parseDocumentText(items(lines), 'ocr:test');
    expect(gelezen.documentType.value).toBe('receipt');
    const issue = validateDocument(gelezen, '2026-09-25').find((i) => i.field === 'invoiceDate');
    expect(issue).toMatchObject({ severity: 'waarschuwing', suggestion: 'toekomst' });
    expect(issue!.message).toMatch(/bon.*10 december 2026.*toekomst/i);
    // een factuur mag een dag vooruit gedateerd zijn; verder in de toekomst krijgt ook die de waarschuwing
    const inv = (datum: string) => validateDocument(parseDocumentText(items(factuur('Printhuis', 'F-1', datum, '48,40')), 'ocr:test'), '2026-09-25').find((i) => i.field === 'invoiceDate');
    expect(inv('26-09-2026')).toBeUndefined();
    expect(inv('10-12-2026')).toMatchObject({ severity: 'waarschuwing', suggestion: 'toekomst' });
    expect(validateDocument(parseDocumentText(items(bon('Printhuis', 'K-55123', '24-09-2026', '48,40')), 'ocr:test'), '2026-09-25').some((i) => i.field === 'invoiceDate')).toBe(false);

    const { state, provider } = varOcr();
    const { s } = setup({ ocr: provider });
    s.settings.update({ onboardingDone: true });
    // de leverancier mag vanzelf: ook dan boekt de app een bon met zo'n datum niet zelf
    for (let i = 0; i < 3; i++) s.memory.learn('Printhuis', { categoryKey: 'kantoor', vatCode: 'hoog', business: true });
    s.memory.setAutomatic('printhuis', true);
    state.lines = lines;
    const doc = await s.intake.add('bon.jpg', new Uint8Array([1]), '2026-09-25');
    expect(doc.status).toBe('controle');
    expect(s.purchases.list()).toHaveLength(0);
    const task = s.inbox.tasks('2026-09-25').find((t) => t.ref.documentId === doc.id)!;
    expect(task.question).toMatch(/toekomst/);
    expect(task.actions.map((a) => a.id)).toEqual(['open']);
    expect(task.group).toBeUndefined();
  });
});
