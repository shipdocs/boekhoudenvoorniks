import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

describe('betaling bekijken vanaf Vandaag', () => {
  it('alle gegevens van de bank en eerdere betalingen aan dezelfde partij, met hoe die verwerkt zijn', () => {
    const { s } = setup();
    const iban = 'LU89751000135104200E';
    s.bank.import({
      source: 'csv',
      warnings: [],
      transactions: [
        { date: '2026-07-10', amount: -1311, description: 'PayPal 1041234567890 Hetzner Online', counterIban: iban, counterName: 'PAYPAL EUROPE S.A.R.L. ET CIE S.C.A' },
        { date: '2026-08-10', amount: -1311, description: 'PayPal 1041234567891 Hetzner Online', counterIban: iban, counterName: 'PAYPAL EUROPE S.A.R.L. ET CIE S.C.A' },
        { date: '2026-09-10', amount: -1311, description: 'PayPal 1041234567892 Hetzner Online', counterIban: iban, counterName: 'PAYPAL EUROPE S.A.R.L. ET CIE S.C.A', reference: '1041234567892' },
      ],
    });
    const [nieuwste, vorige, oudste] = s.bank.list({ status: 'nieuw' });
    s.inbox.answerBank(oudste!.id, { business: false });

    const d = s.bank.details(nieuwste!.id);
    expect(d.transaction).toMatchObject({ amount: -1311, counter_iban: iban, description: 'PayPal 1041234567892 Hetzner Online', reference: '1041234567892' });
    expect(d.account.name).toBeTruthy();
    expect(d.history.map((h) => [h.date, h.how])).toEqual([
      ['2026-08-10', 'nog niet verwerkt'],
      ['2026-07-10', expect.stringMatching(/priv/i)],
    ]);
    expect(vorige!.id).toBe(d.history[0]!.id);
  });
});

describe('geld dat binnenkomt: rente en refunds', () => {
  const binnen = (s: ReturnType<typeof setup>['s'], amount: number, counterName: string, description: string) => {
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-01-01', amount, description, counterName }] });
    return s.bank.list({ status: 'nieuw' }).find((t) => t.counter_name === counterName)!;
  };

  it('rente van de bank: winst, geen omzet en geen btw', () => {
    const { s } = setup();
    const t = binnen(s, 145, 'KNAB', 'RENTE');
    s.bank.bookToAccount(t.id, { account: 'WFbeRlmObr' });
    // debet-min-credit: een bate staat als negatief saldo op de rekening
    expect(s.ledger.balance('WFbeRlmObr')).toBe(-145);
    expect(s.ledger.balance('BSchBepBtwVoo')).toBe(0);
    expect(s.bank.get(t.id).status).toBe('gematcht');
  });

  it('refund van een zakelijke aankoop: kosten en voorbelasting gaan omlaag', () => {
    const { s } = setup();
    const t = binnen(s, 13_900, 'SPEECHIFY', 'SPEECHIFY* LTFBWQLU-00 refund');
    s.inbox.answerBank(t.id, { business: true, categoryKey: 'software', vatCode: 'hoog' });
    expect(s.ledger.balance('WBedKanSof')).toBe(-11_488);
    expect(s.ledger.balance('BSchBepBtwVoo')).toBe(-2_412);
  });

  it('refund van een privé-aankoop: privé, geen kosten', () => {
    const { s } = setup();
    const t = binnen(s, 13_900, 'WEBSHOP', 'refund');
    s.inbox.answerBank(t.id, { business: false });
    expect(s.ledger.balance('BEivPriStr')).toBe(-13_900);
  });
});
