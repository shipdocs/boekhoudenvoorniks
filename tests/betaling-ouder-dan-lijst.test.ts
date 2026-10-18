import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { createApi, type HostContext } from '../src/main/api';
import type { NormalizedTransaction, ParseResult } from '../src/import/types';

/**
 * Een betaling openen die ouder is dan de 500 nieuwste (#441): de lijst voor het bankscherm is afgekapt op
 * 500 regels, maar een betaling uit Zoeken (bv. een genegeerde uit een eerder jaar) moet altijd te openen zijn.
 */
const OWN = 'NL91ABNA0417164300';
const line = (date: string, amount: number, name: string): NormalizedTransaction => ({ date, amount, counterName: name, counterIban: null, description: `betaling ${name}`, reference: null, ownIban: OWN });
const statement = (transactions: NormalizedTransaction[]): ParseResult => ({ source: 'csv', warnings: [], transactions });

describe('betaling ouder dan de lijst van 500', () => {
  it('bank.transaction geeft ook een betaling die niet meer in bank.transactions zit', () => {
    const { s } = setup();
    s.bank.updateAccount(s.bank.listAccounts()[0]!.id, { name: 'Zakelijk', iban: OWN });
    const api = createApi(s, { appVersion: () => 'test' } as unknown as HostContext);
    // 1 oude regel, daarna 500 nieuwere: de oude valt buiten de lijst
    s.bank.import(statement([line('2024-10-21', -895, 'CHEAPCONNECT VIA STICHTING MOLLIE P')]), { filename: 'oud.csv' });
    const old = s.bank.list().find((t) => t.counter_name?.includes('MOLLIE'))!;
    s.bank.ignore(old.id);
    const newer = Array.from({ length: 500 }, (_, i) => line(`2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}`, -100 - i, `Leverancier ${i}`));
    s.bank.import(statement(newer), { filename: 'nieuw.csv' });

    expect(api.bank.transactions({})).toHaveLength(500);
    expect(api.bank.transactions({}).find((t) => t.id === old.id)).toBeUndefined();

    expect(api.bank.transaction(old.id)).toMatchObject({ id: old.id, status: 'genegeerd', amount: -895, account_name: 'Zakelijk', booked_as: null, vat_period: null });
    expect(() => api.bank.transaction(999999)).toThrow('Deze betaling bestaat niet (meer)');
  });
});
