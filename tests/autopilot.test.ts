import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { decide, thresholdFor, THRESHOLDS } from '../src/automation/decisions';
import { explain } from '../src/automation/explain';
import { matchConfidence, AUTO_MATCH_THRESHOLD } from '../src/import/matching';
import type { OcrProvider } from '../src/intake/ocr';

const items = (lines: string[]) => lines.map((text, i) => ({ text, page: 1, bbox: [10, 20 + i * 20, 300, 34 + i * 20] as [number, number, number, number], confidence: 0.97 }));
const varOcr = () => {
  const state = { lines: [] as string[] };
  const provider: OcrProvider = { id: 'test', label: 'Test OCR', available: async () => true, recognize: async () => ({ items: items(state.lines) }) };
  return { state, provider };
};
const bon = (day: number, withVat = true) => [
  'Bouwmaat Utrecht',
  `Datum: ${String(day).padStart(2, '0')}-09-2026`,
  'Gips 100,00',
  ...(withVat ? ['Subtotaal 100,00', 'BTW 21% 100,00 21,00'] : []),
  'Totaal 121,00',
];

/** Leverancier 3× bevestigen en goedkeuren voor automatisch. */
async function trainBouwmaat(s: ReturnType<typeof setup>['s'], state: { lines: string[] }) {
  for (const day of [1, 8, 15]) {
    state.lines = bon(day);
    const d = await s.intake.add(`b${day}.jpg`, new Uint8Array([day]), '2026-09-25');
    s.intake.confirm(d.id, { supplier: 'Bouwmaat', date: `2026-09-${String(day).padStart(2, '0')}`, total: 12100, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas' });
  }
  s.memory.setAutomatic(s.memory.get('Bouwmaat')!.supplier_key, true);
}

describe('zekerheid per beslissing (#21)', () => {
  it('drempels: precies op de drempel = zeker, net eronder = vragen; voorzichtig nooit, maximaal iets lager', () => {
    for (const kind of Object.keys(THRESHOLDS) as (keyof typeof THRESHOLDS)[]) {
      const t = THRESHOLDS[kind];
      expect(decide(kind, 'x', 'x', t, [], 'normaal').ok).toBe(true);
      expect(decide(kind, 'x', 'x', t - 0.001, [], 'normaal').ok).toBe(false);
      expect(decide(kind, 'x', 'x', 1, [], 'voorzichtig').ok).toBe(false);
      expect(decide(kind, 'x', 'x', t - 0.04, [], 'maximaal').ok).toBe(true);
      expect(thresholdFor(kind, 'maximaal')).toBeLessThan(t);
    }
  });

  it('bankmatching: score gekalibreerd naar zekerheid, twijfel expliciet', () => {
    expect(matchConfidence(AUTO_MATCH_THRESHOLD).confidence).toBeCloseTo(THRESHOLDS.bankkoppeling);
    expect(matchConfidence(AUTO_MATCH_THRESHOLD - 1).confidence).toBeLessThan(THRESHOLDS.bankkoppeling);
    const doubt = matchConfidence(160, 140);
    expect(doubt.doubt).toBe(true);
    expect(doubt.confidence).toBeLessThan(THRESHOLDS.bankkoppeling);
    expect(matchConfidence(160, 120).doubt).toBe(false);
  });

  it('één onzeker veld (datum onleesbaar) → alleen dat veld is de vraag, niet automatisch', async () => {
    const { state, provider } = varOcr();
    const { s } = setup({ ocr: provider });
    await trainBouwmaat(s, state);
    state.lines = bon(22).filter((l) => !l.startsWith('Datum'));
    const d = await s.intake.add('zonder-datum.jpg', new Uint8Array([22]), '2026-09-25');
    expect(d.status).toBe('controle');
    const doubts = d.decisions!.filter((x) => !x.ok);
    expect(doubts.map((x) => x.kind)).toEqual(['veld:datum']);
    expect(d.decisions!.find((x) => x.kind === 'categorie')!.ok).toBe(true);
  });
});

describe('"Waarom?" en autopilot (#28, #29)', () => {
  it('automatische verwerking heeft een opgeslagen uitleg met alleen gebruikte signalen; Klopt niet draait alles terug', async () => {
    const { state, provider } = varOcr();
    const { s, db } = setup({ ocr: provider });
    s.settings.update({ onboardingDone: true });
    await trainBouwmaat(s, state);
    state.lines = bon(22);
    const d = await s.intake.add('auto.jpg', new Uint8Array([22]), '2026-09-25');
    expect(d.status).toBe('verwerkt');
    const [entry] = s.inbox.home('2026-09-25').automated;
    expect(entry).toMatchObject({ kind: 'document-auto', actor: 'systeem', status: 'auto' });
    expect(entry!.reason).toMatch(/^Omdat je 3 eerdere aankopen bij Bouwmaat als materiaal hebt bevestigd en hebt gezegd dat dit voortaan automatisch mag/);
    expect(entry!.reason).toContain('21% btw');
    expect(entry!.reason).not.toContain('bankbetaling'); // geen bankmatch gebruikt
    expect(entry!.details!.expert).toMatch(/extractie \d/);
    // na "herstart" (opnieuw uit de database) exact dezelfde uitleg
    const again = db.prepare('SELECT reason, details FROM automation_log WHERE id = ?').get(entry!.id) as { reason: string; details: string };
    expect(again.reason).toBe(entry!.reason);
    expect(JSON.parse(again.details)).toEqual(entry!.details);

    const before = s.ledger.balance('WKprInkMat');
    s.inbox.correctAutomation(entry!.id, '2026-09-25');
    expect(s.ledger.balance('WKprInkMat')).toBe(before - 10000);
    expect(s.intake.get(d.id).status).toBe('controle');
    expect(s.memory.isAutomatic(s.memory.get('Bouwmaat'))).toBe(false);
    expect(s.inbox.month('2026-09', '2026-09-25').automatic[0]!.status).toBe('klopt_niet');
    expect(() => s.inbox.correctAutomation(entry!.id)).toThrow(/al teruggedraaid/);
    expect(s.ledger.checkIntegrity().balanced).toBe(true);
  });

  it('Klopt niet op een automatisch privé-bonnetje: privé-opname terug en document weer ter controle', async () => {
    const { state, provider } = varOcr();
    const { s } = setup({ ocr: provider });
    for (const day of [1, 8, 15]) {
      state.lines = bon(day);
      const d = await s.intake.add(`p${day}.jpg`, new Uint8Array([day]), '2026-09-25');
      s.intake.confirm(d.id, { supplier: 'Bouwmaat', date: `2026-09-${String(day).padStart(2, '0')}`, total: 12100, categoryKey: 'materiaal', vatCode: 'hoog', business: false, paidWith: 'prive' });
    }
    s.memory.setAutomatic(s.memory.get('Bouwmaat')!.supplier_key, true);
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-22', amount: -12100, description: 'Pin', counterName: 'BOUWMAAT UTRECHT' }] });
    state.lines = bon(22);
    const d = await s.intake.add('prive.jpg', new Uint8Array([22]), '2026-09-25');
    expect(d.status).toBe('genegeerd'); // privé: niet in de boekhouding
    expect(s.ledger.balance(ACCOUNTS.priveOpnamen)).toBe(12100);
    const entry = s.inbox.home('2026-09-25').automated.find((e) => e.kind === 'document-auto')!;
    s.inbox.correctAutomation(entry.id, '2026-09-25');
    expect(s.intake.get(d.id).status).toBe('controle');
    expect(s.ledger.balance(ACCOUNTS.priveOpnamen)).toBe(0);
    expect(s.bank.list({ status: 'nieuw' })).toHaveLength(1);
  });

  it('uitleg-sjabloon noemt alleen meegegeven signalen', () => {
    const e = explain([{ type: 'leveranciersregel', label: 'je dit 5× zo koos', value: 0.97 }, { type: 'extractie', label: 'tekst herkend', value: 0.9 }]);
    expect(e.sentence).toBe('Omdat je dit 5× zo koos.');
    expect(e.expert).toBe('leveranciersregel 97% · extractie 90%');
  });

  it('bank: automatisch na ja, zichtbaar in de maandtellers, en Klopt niet zet de betaling terug als vraag', () => {
    const { s } = setup();
    s.settings.update({ onboardingDone: true });
    for (const k of [1, 2, 3]) s.memory.learn('SHELL', { categoryKey: 'auto', vatCode: 'hoog', business: true });
    s.memory.setAutomatic(s.memory.get('SHELL')!.supplier_key, true);
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-20', amount: -6050, description: 'Tank', counterName: 'SHELL' }] });
    expect(s.inbox.autoProcess('2026-09-20').booked).toBe(1);
    const month = s.inbox.month('2026-09', '2026-09-20');
    const home = s.inbox.home('2026-09-20');
    // tellers kloppen met de lijsten
    expect(home.monthCounts.automatic).toBe(month.automatic.filter((e) => e.status === 'auto').length);
    expect(home.monthCounts.byUser).toBe(month.byUser.length);
    expect(home.monthCounts.attention).toBe(home.tasks.length);
    expect(month.automatic[0]!.reason).toContain('voortaan automatisch');

    s.inbox.correctAutomation(month.automatic[0]!.id, '2026-09-21');
    expect(s.bank.list({ status: 'nieuw' })).toHaveLength(1);
    expect(s.memory.isAutomatic(s.memory.get('SHELL'))).toBe(false);
    expect(s.inbox.home('2026-09-21').monthCounts.automatic).toBe(0);
    expect(s.ledger.balance(ACCOUNTS.bank)).toBe(0); // boeking teruggedraaid; de betaling wacht weer op een antwoord
  });

  it('voorzichtig: niets gaat automatisch; een taak afhandelen telt als "door jou"', async () => {
    const { state, provider } = varOcr();
    const { s, klant } = setup({ ocr: provider });
    s.settings.update({ onboardingDone: true });
    await trainBouwmaat(s, state);
    s.settings.update({ autopilot: 'voorzichtig' });
    state.lines = bon(22);
    const d = await s.intake.add('voorzichtig.jpg', new Uint8Array([22]), '2026-09-25');
    expect(d.status).toBe('controle');
    const inv = s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-09-01', lines: [{ description: 'x', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] }).id);
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-10', amount: inv.total!, description: `Factuur ${inv.number}`, counterName: 'Jansen', counterIban: 'NL44RABO0123456789' }] });
    expect(s.inbox.autoProcess('2026-09-10')).toEqual({ matched: 0, booked: 0 });
    const task = s.inbox.tasks('2026-09-25').find((t) => t.kind === 'bank-invoice')!;
    expect(task.why).toMatch(/^Omdat /);
    s.bank.matchInvoice(task.ref.bankTransactionId!, task.ref.invoiceId!);
    s.inbox.recordUserAction(task, 'klopt');
    expect(s.inbox.home('2026-09-25').monthCounts.byUser).toBe(1);
  });

  it('taken van dezelfde soort hebben een gemeenschappelijke groep voor "Alle bevestigen"', () => {
    const { s } = setup();
    s.settings.update({ onboardingDone: true });
    s.memory.learn('SHELL', { categoryKey: 'auto', vatCode: 'hoog', business: true });
    s.bank.import({ source: 'csv', warnings: [], transactions: [1, 2, 3].map((i) => ({ date: `2026-09-1${i}`, amount: -5000 - i, description: 'Tank', counterName: 'SHELL' })) });
    const tasks = s.inbox.tasks('2026-09-20').filter((t) => t.kind === 'bank-category');
    expect(tasks).toHaveLength(3);
    expect(new Set(tasks.map((t) => t.group!.key)).size).toBe(1);
    expect(tasks[0]!.group!.label).toContain('SHELL');
  });
});

describe('controles vóór de btw-aangifte (#20)', () => {
  const Q3 = '2026-Q3';

  it('elke controle gaat af en blokkeert het indienen tot opgelost of bewust overgeslagen', () => {
    const { s, aannemer } = setup();
    // verlegd, en daarna is het btw-nummer van de klant weggehaald
    s.invoices.finalize(s.invoices.createDraft({ relationId: aannemer.id, invoiceDate: '2026-07-10', lines: [{ description: 'Stucwerk', quantity: 1, unitPrice: 100000, vatCode: 'verlegd' }] }).id);
    s.relations.update(aannemer.id, { vat_number: '' });
    // kas negatief (contant betaald zonder kas)
    s.quick.recordExpense({ date: '2026-07-12', supplierName: 'Gamma', description: 'Verf', categoryKey: 'materiaal', grossAmount: 12100, vatCode: 'hoog', paidWith: 'kas' });
    // dubbele aankoop zonder bewijs
    for (let i = 0; i < 2; i++) s.quick.recordExpense({ date: '2026-07-20', supplierName: 'Hornbach', description: 'Steiger', categoryKey: 'gereedschap', grossAmount: 60500, vatCode: 'hoog', paidWith: 'bank' });
    // onverwerkte bank + vraagpost
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-08-01', amount: -2000, description: 'iets' }, { date: '2026-08-02', amount: -3000, description: 'weet ik niet' }] });
    const vraag = s.bank.list({ status: 'nieuw' }).find((t) => t.amount === -3000)!;
    s.bank.bookToAccount(vraag.id, { account: ACCOUNTS.vraagposten });

    const keys = s.vat.checks(Q3).map((c) => c.key).sort();
    expect(keys).toEqual(['bank-open', 'bewijs', 'dubbel', 'kas-negatief', 'verlegd-btwnummer', 'vraagposten'].sort());
    expect(() => s.vat.markSubmitted(Q3)).toThrow(/Los eerst op/);
    // de controles staan ook in de ene "Nog te doen"-lijst (als Q3 de vorige periode is)
    expect(s.inbox.tasks('2026-10-05').filter((t) => t.kind === 'vat-check')).toHaveLength(6);

    for (const c of s.vat.checks(Q3)) s.vat.skipCheck(Q3, c.key, 'test');
    expect(s.vat.checks(Q3).every((c) => c.skipped)).toBe(true);
    expect(s.inbox.tasks('2026-10-05').filter((t) => t.kind === 'vat-check')).toHaveLength(0);

    // de situatie verandert → de overgeslagen controle komt terug
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-08-03', amount: -1000, description: 'nog iets' }] });
    const bank = s.vat.checks(Q3).find((c) => c.key === 'bank-open')!;
    expect(bank.skipped).toBe(false);
    expect(bank.count).toBe(2);
    s.vat.skipCheck(Q3, 'bank-open', 'test');
    expect(s.vat.markSubmitted(Q3).status).toBe('ingediend');
  });

  it('groot verschil met vorig kwartaal is alleen een signaal', () => {
    const { s, klant } = setup();
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-04-10', lines: [{ description: 'x', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] }).id);
    s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-07-10', lines: [{ description: 'y', quantity: 1, unitPrice: 1000000, vatCode: 'hoog' }] }).id);
    const checks = s.vat.checks(Q3);
    expect(checks.map((c) => c.key)).toEqual(['groot-verschil']);
    expect(checks[0]!.blocking).toBe(false);
    expect(s.vat.markSubmitted(Q3).status).toBe('ingediend');
  });

  it('een mogelijk dubbel document uit een andere periode blokkeert deze aangifte niet', async () => {
    const { state, provider } = varOcr();
    const { s } = setup({ ocr: provider });
    state.lines = bon(10).map((l) => l.replace('-09-', '-06-'));
    const a = await s.intake.add('a.jpg', new Uint8Array([1]), '2026-09-25');
    s.intake.confirm(a.id, { supplier: 'Bouwmaat', date: '2026-06-10', total: 12100, categoryKey: 'materiaal', vatCode: 'hoog', business: true, paidWith: 'kas' });
    state.lines = bon(11).map((l) => l.replace('-09-', '-06-'));
    const b = await s.intake.add('b.jpg', new Uint8Array([2]), '2026-09-25');
    expect(b.issues.some((i) => i.field === 'duplicate')).toBe(true);
    expect(s.vat.checks('2026-Q2').some((c) => c.key === 'dubbel')).toBe(true);
    expect(s.vat.checks(Q3).some((c) => c.key === 'dubbel')).toBe(false);
  });

  it('een schone administratie heeft geen controles', () => {
    const { s, aannemer } = setup();
    s.invoices.finalize(s.invoices.createDraft({ relationId: aannemer.id, invoiceDate: '2026-07-10', lines: [{ description: 'Stucwerk', quantity: 1, unitPrice: 100000, vatCode: 'verlegd' }] }).id);
    expect(s.vat.checks(Q3)).toEqual([]);
  });
});
