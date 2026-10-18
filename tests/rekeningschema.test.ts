import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { createApi, type HostContext } from '../src/main/api';
import { BV_ACCOUNTS, categoryForRgs, userAccountBlocked } from '../src/core-ledger/accounts';
import { rgsLabel, searchRgs } from '../src/core-ledger/ledger';

const apiFor = (s: ReturnType<typeof setup>['s']) => createApi(s, { appVersion: () => 'test', reconfigureLocalAi: () => {}, updates: null } as unknown as HostContext);
const codes = (s: ReturnType<typeof setup>['s']) => s.ledger.listAccounts().map((a) => a.rgs_ref);

describe('BV-rekeningen', () => {
  it('elke BV-rekening heeft een officiële RGS-code', () => {
    for (const a of BV_ACCOUNTS) expect(rgsLabel(a.ref), a.ref).toBeTruthy();
  });

  it('komen erbij zodra de rechtsvorm bv wordt, één keer, en niet bij een eenmanszaak', () => {
    const { s } = setup();
    const api = apiFor(s);
    api.settings.update({ legalForm: 'eenmanszaak' });
    expect(codes(s)).not.toContain('BSchBepLhe');
    api.settings.update({ legalForm: 'bv' });
    api.settings.update({ legalForm: 'bv' });
    const accounts = s.ledger.listAccounts();
    for (const a of BV_ACCOUNTS) expect(accounts.filter((x) => x.rgs_code === a.rgs), a.name).toHaveLength(1);
    expect(s.ledger.getAccount('BSchBepLhe')).toMatchObject({ code: '1650', name: 'Af te dragen loonheffing', category: 'passiva' });
  });

  it('een bestaande bv-administratie krijgt ze bij het openen; een bezet nummer schuift door', () => {
    const first = setup();
    first.s.settings.update({ legalForm: 'bv' });
    first.s.ledger.createAccount({ code: '1500', rgs: 'EIGEN-1500', rgsRef: 'BVorOvrOvk', name: 'Borg', category: 'activa' });
    const { s } = setup({ db: first.db });
    expect(s.ledger.getAccount('BVorOvrRca').code).toBe('1501');
    expect(s.ledger.getAccount('EIGEN-1500').name).toBe('Borg');
  });

  it('loonjournaalpost en vpb op de BV-rekeningen: in balans, in de auditfile met de RGS-code', () => {
    const { s } = setup();
    apiFor(s).settings.update({ legalForm: 'bv' });
    s.ledger.post({ date: '2026-03-31', description: 'Loon maart', source: 'handmatig', lines: [
      { account: 'WPerLesSld', debit: 500000 },
      { account: 'BSchBepLhe', credit: 150000 },
      { account: 'BSchSalNet', credit: 350000 },
    ] });
    s.ledger.post({ date: '2026-12-31', description: 'Vpb 2026', source: 'handmatig', lines: [{ account: 'WBelBgrBgr', debit: 80000 }, { account: 'BSchBepVpb', credit: 80000 }] });
    expect(s.ledger.balance('BSchBepLhe')).toBe(-150000);
    expect(s.ledger.balance('WPerLesSld')).toBe(500000);
    const xaf = s.exports.auditfile('2026-01-01', '2026-12-31', s.settings.get().company, '0.1.0');
    for (const ref of ['WPerLesSld', 'BSchBepLhe', 'BSchSalNet', 'WBelBgrBgr', 'BSchBepVpb']) expect(xaf).toContain(`<leadReference>${ref}</leadReference>`);
  });
});

describe('eigen rekening toevoegen', () => {
  it('soort volgt uit de RGS-code; omzet en btw kunnen niet', () => {
    expect(categoryForRgs('WOvbOnmOnm')).toBe('kosten');
    expect(categoryForRgs('BSchOvsTbd')).toBe('passiva');
    expect(categoryForRgs('BEivOreRvh')).toBe('passiva');
    expect(categoryForRgs('BVorVogVr1')).toBe('activa');
    expect(categoryForRgs('BFvaDigNev')).toBe('activa');
    expect(userAccountBlocked('WOmzNodOdh')).toMatch(/Omzet/);
    expect(userAccountBlocked('BSchBepBtwOla')).toMatch(/Btw/);
    expect(userAccountBlocked('BSchOvsTbd')).toBeNull();
  });

  it('via het scherm: eerste vrije nummer in de passende reeks, hernoemen, weghalen alleen zonder boekingen', () => {
    const { s } = setup();
    const api = apiFor(s);
    const dividend = api.ledger.addAccount({ name: 'Te betalen dividend', rgsRef: 'BSchOvsTbd' });
    expect(dividend).toMatchObject({ code: '1650', category: 'passiva', rgs_ref: 'BSchOvsTbd' });
    const fee = api.ledger.addAccount({ name: 'Managementvergoeding ontvangen', rgsRef: 'WOvbOnmOnm', code: '8500' });
    expect(fee).toMatchObject({ code: '8500', category: 'kosten' });
    expect(() => api.ledger.addAccount({ name: 'Dubbel', rgsRef: 'WOvbOnmOnm', code: '8500' })).toThrow(/8500 is al in gebruik/);
    expect(() => api.ledger.addAccount({ name: 'Omzet advies', rgsRef: 'WOmzNodOdh' })).toThrow(/Omzet boek je met een factuur/);
    expect(() => api.ledger.addAccount({ name: 'X', rgsRef: 'BestaatNiet' })).toThrow(/geen officiële RGS-code/);
    expect(() => api.ledger.addAccount({ name: ' ', rgsRef: 'BSchOvsTbd' })).toThrow(/naam/);

    api.ledger.renameAccount(s.ledger.getAccount('BLiqKas').id, 'Kas winkel');
    expect(s.ledger.getAccount('BLiqKas').name).toBe('Kas winkel');

    s.ledger.post({ date: '2026-06-30', description: 'Fee juni', source: 'handmatig', lines: [{ account: fee.rgs_code, credit: 100000 }, { account: 'BVorOvr', debit: 100000 }] });
    expect(api.ledger.accountsInUse()).toContain(fee.id);
    expect(() => api.ledger.archiveAccount(fee.id)).toThrow(/al geboekt/);
    // een extra bankrekening zonder boekingen blijft staan: de volgende bankimport boekt erop
    const spaar = s.bank.addAccount('Spaarrekening', 'NL02ABNA0123456789');
    const spaarAccount = s.ledger.listAccounts().find((a) => a.name === 'Bank Spaarrekening')!;
    expect(spaar).toBeTruthy();
    expect(() => api.ledger.archiveAccount(spaarAccount.id)).toThrow(/bankrekening/);
    api.ledger.archiveAccount(dividend.id);
    expect(s.ledger.listAccounts().some((a) => a.id === dividend.id)).toBe(false);
  });

  it('zoeken in de RGS-lijst op woorden, zonder omzet- en btw-codes', () => {
    const hits = searchRgs('loonheffing');
    expect(hits.map((h) => h.code)).toContain('BSchBepLhe');
    expect(searchRgs('omzet').every((h) => !h.code.startsWith('WOmz'))).toBe(true);
    expect(searchRgs('BSchBepVpb')[0]).toEqual({ code: 'BSchBepVpb', label: rgsLabel('BSchBepVpb') });
    expect(searchRgs(' ')).toEqual([]);
  });
});
