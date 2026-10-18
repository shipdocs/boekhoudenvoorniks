import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { ACCOUNTS } from '../src/core-ledger/accounts';

/**
 * Een boeking op "weet ik nog niet" bij het afsluiten (#430): de melding noemt de einddatum, en als de boeking
 * daarna al is ingedeeld zegt de app dat, in plaats van opnieuw te vragen terwijl het pakket voor het hele
 * jaar al "niets meer" zegt.
 */
const OWN = 'NL91ABNA0417164300';

describe('periode afsluiten: weet ik nog niet', () => {
  it('noemt de einddatum, en zegt het als de boeking daarna al is ingedeeld', () => {
    const { s } = setup();
    s.bank.updateAccount(s.bank.listAccounts()[0]!.id, { iban: OWN });
    s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-10', amount: -5000, counterName: 'Onbekend', counterIban: null, description: 'x', reference: null, ownIban: OWN }] });
    const entryId = s.bank.bookToAccount(s.bank.list()[0]!.id, { account: ACCOUNTS.vraagposten });

    const open = s.periods.checks('2026-09-30').find((c) => c.key === 'vraagposten')!;
    expect(open.level).toBe('bevestigen');
    expect(open.title).toBe('1 boeking staat t/m 30 september 2026 nog bij "weet ik nog niet"');

    // daarna ingedeeld (hier: teruggedraaid in oktober): op 30 september stond hij er nog, nu niet meer
    s.ledger.reverse(entryId, '2026-10-05');
    const later = s.periods.checks('2026-09-30').find((c) => c.key === 'vraagposten')!;
    expect(later.level).toBe('info');
    expect(later.title).toBe('1 boeking stond op 30 september 2026 nog bij "weet ik nog niet" en is daarna ingedeeld');
    // en voor het hele jaar is er niets meer, net als in het pakket voor je boekhouder
    expect(s.periods.checks('2026-12-31').find((c) => c.key === 'vraagposten')).toBeUndefined();
  });
});
