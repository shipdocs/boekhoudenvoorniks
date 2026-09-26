import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';

function withTx(amount = -6050) {
  const { s } = setup();
  s.settings.update({ onboardingDone: true, autopilot: 'voorzichtig' });
  s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-05-02', amount, description: 'Boek', counterIban: 'NL02ABNA0123456789', counterName: 'Boekhandel Kramer' }] });
  const t = s.bank.list({ status: 'nieuw' })[0]!;
  return { s, t };
}

describe('eigen en aangepaste categorieën', () => {
  it('eigen categorie: boekt op de rekening van "hoort bij" en staat vóór Overige kosten', () => {
    const { s, t } = withTx();
    const c = s.categories.add({ label: '  Vakliteratuur ', hint: 'boeken en tijdschriften', groupKey: 'kantoor', defaultVat: 'laag' });
    expect(c).toMatchObject({ key: 'eigen-1', label: 'Vakliteratuur', builtIn: false, groupKey: 'kantoor', defaultVat: 'laag' });
    const keys = s.categories.list().map((x) => x.key);
    expect(keys.indexOf('eigen-1')).toBe(keys.indexOf('overig') - 1);
    s.inbox.answerBank(t.id, { business: true, categoryKey: c.key });
    const kantoor = s.categories.find('kantoor')!.account;
    expect(s.ledger.balance(kantoor)).toBe(5550); // 60,50 incl. 9% btw
    // de leverancier wordt onthouden met de eigen categorie
    expect(s.memory.get('Boekhandel Kramer')?.category_key).toBe('eigen-1');
  });

  it('veilig: geen lege, dubbele of te lange naam; geen onbekende btw of "hoort bij"', () => {
    const { s } = setup();
    expect(() => s.categories.add({ label: ' ', groupKey: 'overig' })).toThrow(/naam/);
    expect(() => s.categories.add({ label: 'materiaal', groupKey: 'overig' })).toThrow(/al een categorie/);
    expect(() => s.categories.add({ label: 'x'.repeat(61), groupKey: 'overig' })).toThrow(/te lang/);
    expect(() => s.categories.add({ label: 'Iets', groupKey: 'investering' })).toThrow(/hoort/);
    expect(() => s.categories.add({ label: 'Iets', groupKey: 'bestaat-niet' })).toThrow(/hoort/);
    expect(() => s.categories.add({ label: 'Iets', groupKey: 'overig', defaultVat: 'toString' })).toThrow(/btw/);
    expect(s.categories.add({ label: 'Regel\neen\ttwee', groupKey: 'overig' }).label).toBe('Regel een twee');
  });

  it('vaste categorie: naam, uitleg en btw aanpassen; de rekening blijft; terug naar standaard', () => {
    const { s } = setup();
    const before = s.categories.find('materiaal')!;
    s.categories.update('materiaal', { label: 'Stucmateriaal', defaultVat: 'laag' });
    expect(s.categories.find('materiaal')).toMatchObject({ label: 'Stucmateriaal', defaultVat: 'laag', account: before.account, hint: before.hint });
    expect(s.categories.all().find((c) => c.key === 'materiaal')!.changed).toBe(true);
    expect(() => s.categories.update('materiaal', { groupKey: 'overig' })).toThrow(/grootboekrekening/);
    s.categories.reset('materiaal');
    expect(s.categories.find('materiaal')).toEqual(before);
    expect(s.categories.all().find((c) => c.key === 'materiaal')!.changed).toBe(false);
  });

  it('verbergen in plaats van verwijderen: eerdere leveranciers blijven werken', () => {
    const { s, t } = withTx();
    const c = s.categories.add({ label: 'Vakliteratuur', groupKey: 'kantoor' });
    s.inbox.answerBank(t.id, { business: true, categoryKey: c.key });
    s.categories.setHidden(c.key, true);
    expect(s.categories.list().some((x) => x.key === c.key)).toBe(false);
    expect(s.categories.find(c.key)?.label).toBe('Vakliteratuur');
    expect(() => s.categories.setHidden('overig', true)).toThrow(/altijd/);
    // een verborgen naam mag opnieuw gebruikt worden, maar dan kan de oude niet meer terug zonder andere naam
    s.categories.add({ label: 'Vakliteratuur', groupKey: 'overig' });
    expect(() => s.categories.setHidden(c.key, false)).toThrow(/al een categorie/);
  });

  it('eigen categorie van "hoort bij" wisselen: alleen voor nieuwe boekingen', () => {
    const { s, t } = withTx();
    const c = s.categories.add({ label: 'Vakliteratuur', groupKey: 'kantoor', defaultVat: 'laag' });
    s.inbox.answerBank(t.id, { business: true, categoryKey: c.key });
    s.categories.update(c.key, { groupKey: 'reclame' });
    expect(s.ledger.balance(s.categories.find('kantoor')!.account)).toBe(5550);
    expect(s.ledger.balance(s.categories.find('reclame')!.account)).toBe(0);
    expect(s.categories.find(c.key)!.account).toBe(s.categories.find('reclame')!.account);
  });

  it('bonnetje invoeren met een eigen categorie', () => {
    const { s } = setup();
    const c = s.categories.add({ label: 'Steigerhuur', groupKey: 'huur' });
    s.quick.recordExpense({ date: '2026-05-02', supplierName: 'Steigerverhuur BV', description: '', categoryKey: c.key, grossAmount: 12100, vatCode: 'hoog', paidWith: 'kas' });
    expect(s.ledger.balance(s.categories.find('huur')!.account)).toBe(10000);
    expect(s.ledger.balance(ACCOUNTS.kas)).toBe(-12100);
  });
});
