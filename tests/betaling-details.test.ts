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

describe('bankrekeningen uit een auditfile', () => {
  it('dezelfde bank met een andere naam wordt herkend', async () => {
    const { sameBankName } = await import('../src/onboarding/xaf-import');
    expect(sameBankName('Bank Knab', 'KNAB')).toBe(true);
    expect(sameBankName('Rabo zakelijk', 'Rabobank Zakelijke rekening')).toBe(true);
    expect(sameBankName('revolut', 'Revolut Business')).toBe(true);
    expect(sameBankName('Bank Knab', 'Rabobank')).toBe(false);
    expect(sameBankName('ING', 'Triodos')).toBe(false);
  });

  it('een rekening zonder nummer kan een echte rekening zijn (geen potje), en een lege rekening kan weg', () => {
    const { s } = setup();
    s.bank.ensureDefaultAccount('NL91ABNA0417164300');
    const echt = s.bank.addAccount('Rabo zakelijk', null, { pot: false });
    const potje = s.bank.addAccount('Btw-potje', null);
    expect(echt.is_pot).toBe(0);
    expect(potje.is_pot).toBe(1);
    s.bank.updateAccount(potje.id, { pot: false });
    expect(s.bank.getAccount(potje.id).is_pot).toBe(0);

    // leeg: weg te halen; daarna kan er gewoon weer een rekening bij
    expect(s.bank.removable(echt.id).ok).toBe(true);
    s.bank.removeAccount(echt.id);
    expect(s.bank.listAccounts().some((a) => a.id === echt.id)).toBe(false);
    const nieuw = s.bank.addAccount('Spaar', null);
    expect(nieuw.rgs_code).not.toBe(echt.rgs_code);

    // met een beginsaldo of afschriften niet
    s.bank.setOpeningBalance(potje.id, 10_000, '2026-01-01');
    expect(s.bank.removable(potje.id)).toMatchObject({ ok: false, reason: expect.stringMatching(/beginsaldo/) });
    const hoofd = s.bank.listAccounts()[0]!;
    expect(s.bank.removable(hoofd.id).ok).toBe(false);
  });
});

describe('vragen op Vandaag met genoeg informatie', () => {
  it('verlopen offerte: nummer, datum, bedrag en een knop om hem te bekijken', () => {
    const { s, klant } = setup();
    const q = s.quotes.create({ relationId: klant.id, quoteDate: '2026-04-01', lines: [{ description: 'Stucwerk', quantity: 1, unitPrice: 100_000, vatCode: 'hoog' }] });
    s.quotes.setStatus(q.id, 'verzonden');
    const task = s.inbox.tasks('2026-09-25').find((t) => t.kind === 'quote-expired')!;
    expect(task.question.replace(/\s/g, ' ')).toContain(`Offerte ${q.number} van 1 april 2026, € 1.210,00, was geldig tot`);
    expect(task.actions.map((a) => a.id)).toContain('open');
  });
});

describe('bij elke knop: wat er gebeurt', () => {
  it('zakelijk of privé: welke kosten en of je de btw terugkrijgt', () => {
    const { s } = setup();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-10', amount: -1311, description: 'PayPal Hetzner', counterName: 'PAYPAL EUROPE' }] });
    const t = s.inbox.tasks('2026-09-25').find((x) => x.kind === 'bank-business')!;
    const hint = (id: string) => t.actions.find((a) => a.id === id)?.hint;
    expect(hint('zakelijk')).toMatch(/kosten/);
    expect(hint('prive')).toMatch(/Geen kosten en geen btw/);
  });
});

describe('btw-controles: om welke posten het gaat', () => {
  it('"betalingen uitzoeken" noemt de betalingen', () => {
    const { s } = setup();
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-08-10', amount: -5000, description: 'iets', counterName: 'ONBEKEND BV' }] });
    const check = s.vat.checks('2026-Q3').find((c) => c.key === 'bank-open')!;
    expect(check.items).toEqual([expect.objectContaining({ kind: 'bank', date: '2026-08-10', label: 'ONBEKEND BV', amount: -5000 })]);
  });
});
