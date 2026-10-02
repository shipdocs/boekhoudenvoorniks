import { describe, expect, it } from 'vitest';
import { financialSnapshot, setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { createApi, type HostContext } from '../src/main/api';
import type { OcrProvider } from '../src/intake/ocr';
import { formatEuro } from '../src/shared/money';

/**
 * Een bon "weet ik nog niet: vraag mijn boekhouder": apart op Vraagposten, zonder btw-aftrek en zonder
 * iets te leren; gemeld vóór de btw-aangifte en in het pakket; later in te delen met btw-aftrek.
 */

const items = (lines: string[]) => lines.map((text, i) => ({ text, page: 1, bbox: [10, 20 + i * 20, 300, 34 + i * 20] as [number, number, number, number], confidence: 0.97 }));
const bon = ['Rare Winkel Zoveel', 'Datum: 10-09-2026', 'Iets onduidelijks 100,00', 'BTW 21% 100,00 21,00', 'Totaal 121,00'];

describe('bon op "weet ik nog niet"', () => {
  it('vraagposten zonder btw-aftrek, niets geleerd, gemeld; later indelen geeft de btw terug', async () => {
    const ocr: OcrProvider = { id: 'test', label: 'Test OCR', available: async () => true, recognize: async () => ({ items: items(bon) }) };
    const { s } = setup({ ocr });
    s.settings.update({ onboardingDone: true });
    const api = createApi(s, { appVersion: () => '0.0.0', hasSmtpPassword: () => false } as unknown as HostContext);
    const d = await s.intake.add('bon.jpg', new Uint8Array([7]), '2026-09-30');

    // ook als de gebruiker (of een oud formulier) 21% meestuurt: geen btw-aftrek op een vraagpost
    s.intake.confirm(d.id, { supplier: 'Rare Winkel Zoveel', date: '2026-09-10', total: 12100, categoryKey: 'onbekend', vatCode: 'hoog', vatAmount: 2100, business: true, paidWith: 'later' });
    expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(12100);
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(0);
    expect(s.memory.get('Rare Winkel Zoveel')).toBeNull();

    // gemeld vóór de btw-aangifte en in het pakket voor de boekhouder
    expect(s.vat.checks('2026-Q3').find((c) => c.key === 'vraagposten')).toMatchObject({ blocking: true });
    const check = s.accountantPackage.preview(2026).checks.find((c) => c.label.startsWith('Niets meer bij'))!;
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('€ 121,00');

    // in de lijst als "nog uitzoeken", en indelen
    const p = api.purchases.list().find((x) => x.relation_name === 'Rare Winkel Zoveel')!;
    expect(p.question).toBe(true);
    // de controle "weet ik nog niet" wijst de bon aan als meteen in te delen (#188)
    expect(api.vat.accountLines(ACCOUNTS.vraagposten).lines).toMatchObject([{ purchaseId: p.id, question: true, amount: 12100 }]);
    api.purchases.resolveQuestion(p.id, 'materiaal', 'hoog');
    expect(api.vat.accountLines(ACCOUNTS.vraagposten).lines).toEqual([]);
    expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(2100);
    expect(s.ledger.balance('WKprInkMat')).toBe(10000);
    expect(api.purchases.list().find((x) => x.id === p.id)).toMatchObject({ question: false, description: 'Materiaal — Rare Winkel Zoveel' });
    expect(s.accountantPackage.preview(2026).checks.find((c) => c.label.startsWith('Niets meer bij'))!.ok).toBe(true);
    // nog een keer indelen kan niet
    expect(() => api.purchases.resolveQuestion(p.id, 'materiaal', 'hoog')).toThrow(/niet \(meer\)/);
  });
});

/**
 * De betaling van een aankoop die op "weet ik nog niet" staat (#223). Via de gewone bankindeling kwam die
 * betaling er als tweede post bij (Vraagposten twee keer, en de aankoop bleef als schuld open staan). Nu
 * vraagt de app eerst of de betaling bij de aankoop hoort; zo ja, dan sluit hij de aankoop af (Crediteuren
 * aan Bank) en staat het bedrag één keer op Vraagposten. Verzonnen leverancier en bedragen.
 */
describe('betaling van een aankoop die op "weet ik nog niet" staat (#223)', () => {
  type S = ReturnType<typeof setup>['s'];
  const world = () => {
    const ctx = setup();
    ctx.s.settings.update({ onboardingDone: true });
    const api = createApi(ctx.s, { appVersion: () => '0.0.0', hasSmtpPassword: () => false } as unknown as HostContext);
    return { ...ctx, api };
  };
  /** De factuur van € 48,40, door de gebruiker op "weet ik nog niet" gezet. */
  const question = (s: S) =>
    s.purchases.create({ relationId: s.relations.findOrCreateSupplier('Printhuis').id, invoiceDate: '2026-09-03', description: 'Nog uitzoeken — Printhuis', lines: [{ account: ACCOUNTS.vraagposten, netAmount: 4840, vatCode: 'geen' }] });
  /** De afschrijving van die factuur, nog niet verwerkt. */
  const debit = (s: S) => {
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-04', amount: -4840, description: 'PRINTHUIS order 991', counterName: 'Printhuis' }] });
    return s.bank.list().find((t) => t.amount === -4840)!;
  };
  const bankTasks = (s: S, txId: number) => s.inbox.tasks('2026-09-28').filter((t) => t.ref.bankTransactionId === txId && t.kind.startsWith('bank-'));
  const doubles = (s: S) => s.inbox.tasks('2026-09-28').filter((t) => t.kind === 'purchase-double');
  const T5 = `Deze betaling lijkt bij de aankoop bij Printhuis van 3 september 2026 (${formatEuro(4840)}) te horen. Kies eerst "Ja" of "Nee, iets anders"; anders tellen de kosten twee keer.`;

  it('de betaling ook op "weet ik nog niet" zetten kan niet zomaar: eerst de vraag; "ja" sluit de aankoop af, het bedrag staat er één keer', async () => {
    const ctx = world();
    const { s, api } = ctx;
    const p = question(s);
    const t = debit(s);
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 0 });
    const before = financialSnapshot(ctx);
    expect(() => api.bank.book(t.id, { account: ACCOUNTS.vraagposten, vatCode: 'geen' })).toThrow(T5);
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(4840);

    // op Vandaag: hoort dit bij de aankoop? Met de uitleg dat de aankoop op "weet ik nog niet" blijft staan
    const [task] = bankTasks(s, t.id);
    expect(task).toMatchObject({ kind: 'bank-purchase', ref: { bankTransactionId: t.id, purchaseId: p.id } });
    expect(task!.question).toBe(`Hoort dit bij de aankoop bij Printhuis van 3 september 2026 (${formatEuro(4840)})? Die aankoop staat op "weet ik nog niet". Dat blijft zo tot je hem indeelt; de betaling komt er niet nog een keer bij.`);
    expect(api.bank.purchaseQuestion(t.id)).toMatchObject({ strong: true, oneClick: true, candidates: [{ purchaseId: p.id, state: 'open', question: true, amountFit: 'gelijk' }] });
    await api.home.act(task!, 'klopt');
    // Crediteuren aan Bank: de aankoop is betaald, en Vraagposten staat er één keer
    expect(s.bank.get(t.id)).toMatchObject({ status: 'gematcht', matched_purchase_invoice_id: p.id });
    expect(s.purchases.get(p.id)).toMatchObject({ status: 'betaald', open_amount: 0 });
    expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(4840);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.bank)).toBe(-4840);
    expect(doubles(s)).toEqual([]);
    expect(s.vat.checks('2026-Q3').find((c) => c.key === 'dubbel')).toBeUndefined();

    // daarna indelen: Vraagposten leeg, de btw komt terug, de betaling blijft staan
    api.purchases.resolveQuestion(p.id, 'materiaal', 'hoog');
    expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(840);
    expect(s.ledger.balance('WKprInkMat')).toBe(4000);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.purchases.get(p.id)).toMatchObject({ status: 'betaald', open_amount: 0 });
  });

  it('de betaling als kosten of privé indelen kan ook niet zonder antwoord; na "Nee, iets anders" wel', async () => {
    const ctx = world();
    const { s, api } = ctx;
    const p = question(s);
    const t = debit(s);
    const before = financialSnapshot(ctx);
    expect(() => api.bank.book(t.id, { account: 'WKprInkMat', vatCode: 'hoog' })).toThrow(T5);
    expect(() => s.inbox.answerBank(t.id, { business: true, categoryKey: 'materiaal', vatCode: 'hoog' })).toThrow(T5);
    expect(() => s.inbox.answerBank(t.id, { business: false })).toThrow(T5);
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(s.memory.get('Printhuis')).toBeNull(); // er is ook niets geleerd
    // "Ja, dit is de betaling van die aankoop" op het bankscherm
    api.bank.linkPurchase(t.id, p.id);
    expect(s.purchases.get(p.id).status).toBe('betaald');
    expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(4840);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.ledger.balance('WKprInkMat')).toBe(0);

    // een andere betaling van hetzelfde bedrag: "Nee, iets anders", daarna deel je hem zelf in
    const q = s.purchases.create({ relationId: s.relations.findOrCreateSupplier('Kantoorhal').id, invoiceDate: '2026-09-10', description: 'Nog uitzoeken — Kantoorhal', lines: [{ account: ACCOUNTS.vraagposten, netAmount: 2500, vatCode: 'geen' }] });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-11', amount: -2500, description: 'KANTOORHAL UTRECHT', counterName: 'Kantoorhal' }] });
    const u = s.bank.list().find((x) => x.amount === -2500)!;
    expect(() => api.bank.book(u.id, { account: ACCOUNTS.vraagposten, vatCode: 'geen' })).toThrow(/Kies eerst "Ja" of "Nee, iets anders"/);
    api.bank.rejectPurchases(u.id);
    expect(api.bank.book(u.id, { account: ACCOUNTS.vraagposten, vatCode: 'geen' })).toEqual(expect.any(Number));
    expect(s.purchases.get(q.id).status).toBe('open');
    expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(4840 + 2 * 2500);
    expect(doubles(s)).toEqual([]); // het antwoord geldt ook voor de vraag "staat deze aankoop dubbel?"
  });

  it('bestaande gegevens (allebei al op "weet ik nog niet"): gemeld vóór de btw-aangifte en een vraag; "ja" koppelt de betaling en haalt de losse post weg', async () => {
    const ctx = world();
    const { s, api } = ctx;
    const p = question(s);
    const t = debit(s);
    // zoals het vóór deze versie ging: de betaling rechtstreeks op Vraagposten, naast de aankoop
    s.bank.bookToAccount(t.id, { account: ACCOUNTS.vraagposten, vatCode: 'geen' });
    expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(2 * 4840);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(-4840);
    const before = financialSnapshot(ctx);
    expect(s.inbox.autoProcess('2026-09-28')).toEqual({ matched: 0, booked: 0 }); // nooit vanzelf
    expect(financialSnapshot(ctx)).toEqual(before);
    // de controle "dubbel" noemt de betaling en de aankoop
    const check = s.vat.checks('2026-Q3').find((c) => c.key === 'dubbel')!;
    expect(check).toMatchObject({ blocking: true, count: 1, fingerprint: `b${t.id}-p${p.id}` });
    expect(check.items!.map((i) => [i.kind, i.id])).toEqual([['bank', t.id], ['aankoop', p.id]]);
    // een andere soort kosten kiezen voor de betaling kan niet zolang de vraag open staat
    expect(() => api.bank.reclassify(t.id, 'materiaal', 'hoog')).toThrow('Deze betaling lijkt bij de aankoop bij Printhuis van 3 september 2026 te horen. Beantwoord eerst de vraag "staat deze aankoop dubbel?" op Vandaag; anders tellen de kosten twee keer.');
    expect(financialSnapshot(ctx)).toEqual(before);

    const [task] = doubles(s);
    expect(task).toMatchObject({ priority: 1, ref: { purchaseId: p.id, bankTransactionId: t.id } });
    expect(task!.question).toBe(`De bon van 3 september 2026 (${formatEuro(4840)}) staat nog open. Op Zakelijke rekening staat op 4 september 2026 ook ${formatEuro(4840)} aan Printhuis, al verwerkt als "weet ik nog niet". Is dat dezelfde betaling?`);
    await api.home.act(task!, 'ja');
    expect(s.bank.get(t.id)).toMatchObject({ status: 'gematcht', matched_purchase_invoice_id: p.id });
    expect(s.purchases.get(p.id)).toMatchObject({ status: 'betaald', open_amount: 0 });
    expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(4840);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.bank)).toBe(-4840);
    expect(doubles(s)).toEqual([]);
    expect(s.vat.checks('2026-Q3').find((c) => c.key === 'dubbel')).toBeUndefined();
    // wat er nog op "weet ik nog niet" staat, is de aankoop zelf: die deel je in
    expect(api.vat.accountLines(ACCOUNTS.vraagposten).lines).toMatchObject([{ purchaseId: p.id, question: true, amount: 4840 }]);
  });

  it('"Nee, twee aankopen": alles blijft staan, de controle meldt het niet meer en de betaling kan daarna een andere soort kosten krijgen', async () => {
    const ctx = world();
    const { s, api } = ctx;
    const p = question(s);
    const t = debit(s);
    s.bank.bookToAccount(t.id, { account: ACCOUNTS.vraagposten, vatCode: 'geen' });
    const before = financialSnapshot(ctx);
    await api.home.act(doubles(s)[0]!, 'nee');
    expect(financialSnapshot(ctx)).toEqual(before);
    expect(doubles(s)).toEqual([]);
    expect(s.vat.checks('2026-Q3').find((c) => c.key === 'dubbel')).toBeUndefined();
    api.bank.reclassify(t.id, 'materiaal', 'hoog');
    expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(4840);
    expect(s.ledger.balance('WKprInkMat')).toBe(4000);
    expect(s.purchases.get(p.id).status).toBe('open');
  });

  it('de betaling stond al op "weet ik nog niet" en de factuur komt later als gewone aankoop: "ja" maakt de betaling de betaling van die aankoop', async () => {
    const { s, api } = world();
    const t = debit(s);
    s.bank.bookToAccount(t.id, { account: ACCOUNTS.vraagposten, vatCode: 'geen' });
    const p = s.purchases.create({ relationId: s.relations.findOrCreateSupplier('Printhuis').id, invoiceDate: '2026-09-03', description: 'Materiaal — Printhuis', lines: [{ account: 'WKprInkMat', netAmount: 4000, vatCode: 'hoog', vatAmount: 840 }] });
    const [task] = doubles(s);
    expect(task).toMatchObject({ ref: { purchaseId: p.id, bankTransactionId: t.id } });
    expect(task!.actions.find((a) => a.id === 'ja')!.hint).toBe('De betaling wordt aan de aankoop gekoppeld; die staat daarna als betaald. De losse post op "weet ik nog niet" vervalt.');
    await api.home.act(task!, 'ja');
    expect(s.ledger.balance(ACCOUNTS.vraagposten)).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.crediteuren)).toBe(0);
    expect(s.ledger.balance('WKprInkMat')).toBe(4000);
    expect(s.ledger.balance(ACCOUNTS.btwVoorbelasting)).toBe(840);
    expect(s.purchases.get(p.id)).toMatchObject({ status: 'betaald', open_amount: 0 });
    expect(s.bank.get(t.id).matched_purchase_invoice_id).toBe(p.id);
  });
});
