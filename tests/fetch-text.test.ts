import { describe, expect, it } from 'vitest';
import { bankFetchOutcome, errorOutcome, mailFetchOutcome } from '../src/shared/fetch-text';

describe('ophaalmeldingen op Vandaag', () => {
  it('meldt gelukte mail zonder fouten als ok', () => {
    const o = mailFetchOutcome({ documents: 1, onlineInvoices: 0, fromCustomers: 2, other: 0, errors: 0, missingFolders: [] });
    expect(o.ok).toBe(true);
    expect(o.lines[0]).toBe('Mail opgehaald: 1 bonnetje, 2 van klanten.');
  });

  it('toont mail-problemen als niet ok', () => {
    const o = mailFetchOutcome({ documents: 0, onlineInvoices: 0, fromCustomers: 0, other: 0, errors: 1, missingFolders: ['Verwerkt'] });
    expect(o.ok).toBe(false);
    expect(o.lines.join(' ')).toContain('1 bericht niet te lezen');
    expect(o.lines.join(' ')).toContain('Map niet gevonden: Verwerkt');
  });

  it('telt bankimport en legt een mislukte rekening uit', () => {
    const ok = bankFetchOutcome({ accounts: [{ pontoId: 'a', bankAccountId: 1, imported: 2 }, { pontoId: 'b', bankAccountId: 2, imported: 1 }], skipped: [], failed: [], importedAny: true });
    expect(ok).toEqual({ ok: true, lines: ['Bank opgehaald: 3 nieuwe transacties.'] });
    const bad = bankFetchOutcome({ accounts: [], skipped: [], failed: [{ pontoId: 'a', errorKind: 'network' }], importedAny: false });
    expect(bad.ok).toBe(false);
    expect(bad.lines[1]).toContain('Geen verbinding met Ponto');
  });

  it('geeft een uitzondering weer als mislukte actie', () => {
    expect(errorOutcome('Bank ophalen', 'boem')).toEqual({ ok: false, lines: ['Bank ophalen lukte niet. boem'] });
  });
});
