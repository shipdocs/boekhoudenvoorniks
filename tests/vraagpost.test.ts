import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';
import { createApi, type HostContext } from '../src/main/api';
import type { OcrProvider } from '../src/intake/ocr';

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
