import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

/**
 * Spullen van buiten de EU in rubriek 4a. Bij invoer betaal je de btw bij de Douane (of de koerier) en trek je die
 * af als voorbelasting; alleen met een vergunning artikel 23 geef je hem aan in 4a. Diensten van buiten de EU
 * (software, advies) horen wél in 4a. Bronnen: belastingdienst.nl "Aangifte doen als u goederen invoert vanuit
 * landen buiten de EU" en "Btw-aangifte als u diensten afneemt van leveranciers uit landen buiten de EU"
 * (geraadpleegd 2026-10-30); Wet OB 1968 art. 23 lid 5 (KOR: geen verlegging bij invoer), toestand 2026-01-01.
 */
describe('btw-controle: spullen van buiten de EU in 4a', () => {
  it('een dienst van buiten de EU (software) in 4a geeft geen melding', () => {
    const { s } = setup();
    s.quick.recordExpense({ date: '2026-05-03', supplierName: 'Anthropic', description: 'Claude', categoryKey: 'software', grossAmount: 2000, vatCode: 'buiten-eu', paidWith: 'bank' });
    expect(s.vat.checks('2026-Q2').some((c) => c.key === 'invoer-4a')).toBe(false);
    // de dienst zelf staat gewoon in 4a: grondslag € 20,00, btw € 4,20 verschuldigd en afgetrokken
    const r4a = s.vat.calculate('2026-Q2').rubrieken.find((r) => r.code === '4a')!;
    expect(r4a.omzet).toBe(2000);
    expect(r4a.btw).toBe(420);
  });

  it('materiaal of gereedschap van buiten de EU in 4a geeft een melding met de aankoop erbij (geen blokkade)', () => {
    const { s } = setup();
    const p = s.quick.recordExpense({ date: '2026-05-10', supplierName: 'Shenzhen Tools', description: 'Boormachine', categoryKey: 'gereedschap', grossAmount: 15000, vatCode: 'buiten-eu', paidWith: 'bank' });
    const c = s.vat.checks('2026-Q2').find((x) => x.key === 'invoer-4a')!;
    expect(c).toMatchObject({ blocking: false, count: 1, screen: 'aankopen' });
    expect(c.title).toContain('Shenzhen Tools');
    expect(c.detail).toContain('vergunning artikel 23');
    expect(c.detail).toContain('Douane');
    expect(c.items).toEqual([{ kind: 'aankoop', id: p.id, date: '2026-05-10', label: 'Shenzhen Tools', amount: -15000 }]);
    // buiten het tijdvak telt hij niet mee
    expect(s.vat.checks('2026-Q3').some((x) => x.key === 'invoer-4a')).toBe(false);
  });

  it('een investering (bedrijfsmiddel) van buiten de EU in 4a telt ook', () => {
    const { s } = setup();
    s.quick.recordExpense({ date: '2026-06-01', supplierName: 'US Machines LLC', description: 'Freesmachine', categoryKey: 'investering', grossAmount: 300000, vatCode: 'buiten-eu', paidWith: 'bank' });
    expect(s.vat.checks('2026-Q2').find((x) => x.key === 'invoer-4a')).toMatchObject({ count: 1 });
  });

  it('onder de KOR blokkeert de melding: artikel 23 geldt dan niet', () => {
    const { s } = setup();
    s.settings.update({ kor: true });
    s.quick.recordExpense({ date: '2026-05-10', supplierName: 'Shenzhen Tools', description: 'Boormachine', categoryKey: 'gereedschap', grossAmount: 15000, vatCode: 'buiten-eu', paidWith: 'bank' });
    const c = s.vat.checks('2026-Q2').find((x) => x.key === 'invoer-4a')!;
    expect(c.blocking).toBe(true);
    expect(c.detail).toContain('KOR');
  });

  it('"Geen btw" kiezen haalt de aankoop uit 4a; de melding verdwijnt en de btw staat niet meer dubbel', () => {
    const { s } = setup();
    const p = s.quick.recordExpense({ date: '2026-05-10', supplierName: 'Shenzhen Tools', description: 'Boormachine', categoryKey: 'gereedschap', grossAmount: 15000, vatCode: 'buiten-eu', paidWith: 'bank' });
    expect(s.vat.calculate('2026-Q2').rubrieken.find((r) => r.code === '4a')!.omzet).toBe(15000);
    const updated = s.purchases.setVatCode(p.id, 'geen');
    expect(updated.total).toBe(15000);
    expect(updated.vat_total).toBe(0);
    expect(s.vat.checks('2026-Q2').some((x) => x.key === 'invoer-4a')).toBe(false);
    const report = s.vat.calculate('2026-Q2');
    expect(report.rubrieken.find((r) => r.code === '4a')!.omzet).toBe(0);
    expect(report.summary.voorbelasting).toBe(0);
    // de oude post is tegengeboekt, niet gewist: twee posten plus de tegenboeking
    expect(s.ledger.listEntries({ source: 'inkoop' })).toHaveLength(3);
  });

  it('een andere btw-code dan "geen" of verlegd wordt geweigerd, en een betaald bedrag mag niet veranderen', () => {
    const { s } = setup();
    const p = s.quick.recordExpense({ date: '2026-05-10', supplierName: 'Shenzhen Tools', description: 'Boormachine', categoryKey: 'gereedschap', grossAmount: 15000, vatCode: 'buiten-eu', paidWith: 'kas' });
    // 21% zou het te betalen bedrag veranderen (de btw zou erbij komen) terwijl er al contant betaald is
    expect(() => s.purchases.setVatCode(p.id, 'hoog')).toThrow(/te betalen bedrag/);
    expect(() => s.purchases.setVatCode(p.id, 'onzin' as never)).toThrow();
    expect(s.purchases.setVatCode(p.id, 'geen').vat_total).toBe(0);
  });
});
