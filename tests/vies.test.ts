import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

const ok = (body: unknown, status = 200) => async () => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

describe('VIES-controle (alleen op verzoek)', () => {
  it('geldig nummer: uitslag met naam bewaard, adres opgeschoond', async () => {
    const urls: string[] = [];
    const { s } = setup({ fetch: async (url) => { urls.push(url); return ok({ isValid: true, name: 'BOL.COM B.V.', address: '\nPAPENDORPSEWEG 100\n3528BJ UTRECHT\n' })(); } });
    const r = await s.vies.check('nl 8204.71616 b01');
    expect(r).toMatchObject({ vatNumber: 'NL820471616B01', valid: true, name: 'BOL.COM B.V.', address: 'PAPENDORPSEWEG 100, 3528BJ UTRECHT' });
    expect(urls).toEqual(['https://ec.europa.eu/taxation_customs/vies/rest-api/ms/NL/vat/820471616B01']);
    expect(s.vies.latest('NL820471616B01')?.valid).toBe(true);
  });
  it('ongeldig nummer geeft een duidelijke uitslag', async () => {
    const { s } = setup({ fetch: ok({ isValid: false, name: '---', address: '---' }) });
    const r = await s.vies.check('DE123456789');
    expect(r.valid).toBe(false);
    expect(r.name).toBeNull();
    expect(r.message).toContain('kent dit btw-nummer niet');
  });
  it('dienst niet bereikbaar: geen uitslag (geen onterechte "ongeldig")', async () => {
    const down = setup({ fetch: async () => { throw new Error('netwerk'); } });
    expect((await down.s.vies.check('DE123456789')).valid).toBeNull();
    const busy = setup({ fetch: ok({ userError: 'MS_UNAVAILABLE' }, 200) });
    const r = await busy.s.vies.check('DE123456789');
    expect(r.valid).toBeNull();
    expect(r.message).toContain('MS_UNAVAILABLE');
  });
  it('geen EU-nummer of verkeerde vorm wordt geweigerd, zonder netwerkverkeer', async () => {
    let calls = 0;
    const { s } = setup({ fetch: async () => { calls++; return ok({})(); } });
    await expect(s.vies.check('CHE123456789')).rejects.toThrow(/EU/);
    await expect(s.vies.check('123')).rejects.toThrow(/landcode/);
    expect(calls).toBe(0);
  });
});
