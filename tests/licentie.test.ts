import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LICENSE_PUBLIC_KEY, LicenseService, verifyLicense } from '../src/license/license';
import { createApi, type HostContext } from '../src/main/api';
import { setup } from './helpers';
import { TERMS_VERSION } from '../src/shared/legal';
import { signLicense } from './license-token';

/**
 * De licentie in de app. De licentie-Worker zelf (afrekenen, webhook, ondertekenen) staat in de privé-repo
 * shipdocs/boekhoudenvoorniks-server; die test hetzelfde tokenformaat met een kopie van verifyLicense.
 */

const TODAY = '2026-10-15';
const ACCEPT = { terms: TERMS_VERSION, business: true };

function keys() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  return { publicKey: jwk.x, privateJwk: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d }) };
}

describe('licentie in de app', () => {
  const token = (privateJwk: string, administratie: string, validUntil: string, cancelled = false) =>
    signLicense({ v: 1, product: 'uitwisseling', administratie, email: 'piet@example.nl', validUntil, issuedAt: TODAY, ...(cancelled ? { cancelled: true } : {}) }, privateJwk);

  it('de sleutel in de app is een geldige Ed25519-sleutel (die van de live licentie-Worker)', () => {
    // Op 30 september 2026 is een echte licentie van de live Worker met deze sleutel gecontroleerd. Die
    // licentie zelf staat bewust niet in de repo: hij is geldig. Hier: vorm en bruikbaarheid van de sleutel.
    expect(LICENSE_PUBLIC_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(LICENSE_PUBLIC_KEY, 'base64url')).toHaveLength(32);
    expect(() => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: LICENSE_PUBLIC_KEY }, format: 'jwk' })).not.toThrow();
    expect(() => verifyLicense('e30.AAAA', LICENSE_PUBLIC_KEY)).toThrow(/handtekening/);
  });

  it('zonder sleutel staan licenties uit: alles mag', () => {
    const { s } = setup();
    expect(s.license.status(TODAY)).toEqual({ state: 'uit' });
    expect(() => s.license.requireActive(TODAY)).not.toThrow();
  });

  it('geen, actief, verlopen, andere administratie, vervalst', async () => {
    const k = keys();
    const { s } = setup();
    const license = new LicenseService(s.db, s.settings, k.publicKey);
    const id = s.settings.administrationId();
    expect(license.status(TODAY)).toEqual({ state: 'geen' });
    expect(() => license.requireActive(TODAY)).toThrow(/extra functie van het abonnement/);

    expect(license.install(await token(k.privateJwk, id, '2026-11-22'), TODAY)).toEqual({ state: 'actief', validUntil: '2026-11-22', email: 'piet@example.nl', cancelled: false });
    expect(() => license.requireActive(TODAY)).not.toThrow();
    expect(license.needsRefresh(TODAY)).toBe(false);
    expect(license.needsRefresh('2026-11-16')).toBe(true);
    expect(license.status('2026-11-23')).toMatchObject({ state: 'verlopen' });
    expect(() => license.requireActive('2026-11-23')).toThrow(/liep tot 22 november 2026/);

    await expect(async () => license.install(await token(k.privateJwk, '00000000-0000-4000-8000-000000000000', '2027-01-01'), TODAY)).rejects.toThrow(/andere administratie/);
    await expect(async () => license.install(await token(keys().privateJwk, id, '2099-01-01'), TODAY)).rejects.toThrow(/handtekening/);
    const good = await token(k.privateJwk, id, '2026-11-22');
    const [body, sig] = good.split('.');
    const forged = `${Buffer.from(Buffer.from(body!, 'base64url').toString().replace('2026-11-22', '2099-12-31')).toString('base64url')}.${sig}`;
    expect(() => license.install(forged, TODAY)).toThrow(/handtekening/);
  });

  it('versturen haalt eerst de licentie op; zonder abonnement geweigerd; afsluiten met bedrijfsgegevens; opzeggen', async () => {
    const k = keys();
    const { s } = setup({ licensePublicKey: k.publicKey });
    const id = s.settings.administrationId();
    let served: string | null = null;
    const opened: string[] = [];
    const started: unknown[] = [];
    const fetched: { administratie: string; managementKey: string }[] = [];
    const cancelled: { administratie: string; managementKey: string }[] = [];
    let running = false;
    const api = createApi(s, {
      appVersion: () => '1.0.0',
      saveFile: async (name: string) => `/tmp/${name}`,
      openExternal: async (url: string) => void opened.push(url),
      hasSmtpPassword: () => false,
      licenseApi: {
        price: async () => ({ bedrag: '9.99', valuta: 'EUR', per: 'maand' }),
        fetch: async (administratie: string, managementKey: string) => {
          fetched.push({ administratie, managementKey });
          return served;
        },
        start: async (input: unknown) => {
          started.push(input);
          return running ? { al: true } : { checkout: 'https://www.mollie.com/checkout/test' };
        },
        cancel: async (administratie: string, managementKey: string) => {
          cancelled.push({ administratie, managementKey });
          served = await token(k.privateJwk, id, '2099-01-31', true);
          return { betaaldTot: '2099-01-24', geldigTot: '2099-01-31' };
        },
      },
      exchange: { bundle: async () => Buffer.from('bundel'), office: () => null, saveOffice: () => { throw new Error('x'); }, openClientExport: async () => { throw new Error('x'); } },
    } as unknown as HostContext);
    const { generateOfficeKeys } = await import('../src/exchange/crypto');
    const { ExchangeService } = await import('../src/exchange/exchange');
    s.exchange.link(ExchangeService.invite({ office: 'Kantoor', email: 'k@example.nl', ...generateOfficeKeys() }));

    await expect(api.exchange.send('2026-06-30', [], 'bestand')).rejects.toThrow(/extra functie van het abonnement/);
    expect(s.periods.status().exchange).toBeNull();

    // afsluiten: eerst de bedrijfsgegevens compleet (voor de factuur)
    s.settings.update({ company: { ...s.settings.get().company, kvkNumber: '  ', vatNumber: '' } });
    // zonder akkoord (artikel 8.2/8.3), of met een oude versie van de voorwaarden: niet afsluiten
    await expect(api.license.checkout('piet@example.nl')).rejects.toThrow(/voor je bedrijf afsluit en ga akkoord/);
    await expect(api.license.checkout('piet@example.nl', { terms: '2026-10-01', business: true })).rejects.toThrow(/ga akkoord met de voorwaarden/);
    await expect(api.license.checkout('piet@example.nl', { terms: TERMS_VERSION, business: false })).rejects.toThrow(/voor je bedrijf/);
    expect(started).toHaveLength(0);
    await expect(api.license.checkout('piet@example.nl', ACCEPT)).rejects.toThrow(/ontbreekt nog: KvK- of btw-nummer/);
    expect(started).toHaveLength(0);
    s.settings.update({ company: { ...s.settings.get().company, kvkNumber: '12345678' } });
    expect(await api.license.checkout('piet@example.nl', ACCEPT)).toEqual({ al: false });
    expect(started[0]).toEqual({ administratie: id, email: 'piet@example.nl', bedrijf: { naam: 'Stukadoorsbedrijf Piet', adres: 'Kalkweg 1', postcode: '1234 AB', plaats: 'Utrecht', land: 'NL', kvk: '12345678', btw: undefined }, managementKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), voorwaarden: TERMS_VERSION, zakelijk: true });
    const managementKey = (started[0] as { managementKey: string }).managementKey;
    // de beheersleutel gaat niet mee naar het scherm
    expect(JSON.stringify(api.settings.get())).not.toContain(managementKey);
    expect(opened).toEqual(['https://www.mollie.com/checkout/test']);
    await expect(api.license.refresh()).rejects.toThrow(/Nog geen betaald abonnement/);

    // betaald: bij versturen wordt de licentie vanzelf opgehaald
    served = await token(k.privateJwk, id, '2099-01-31');
    running = true;
    expect(await api.exchange.send('2026-06-30', [], 'bestand')).toMatchObject({ exchange: expect.any(Number) });
    expect(s.license.status(TODAY)).toMatchObject({ state: 'actief', cancelled: false });
    // nog een keer afsluiten terwijl het loopt: geen betaalpagina
    expect(await api.license.checkout('piet@example.nl', ACCEPT)).toEqual({ al: true });
    expect(opened).toHaveLength(1);

    // opzeggen: de licentie loopt af, versturen kan tot dan
    expect(await api.license.cancel()).toMatchObject({ state: 'actief', cancelled: true, validUntil: '2099-01-31' });
    expect(cancelled).toEqual([{ administratie: id, managementKey }]);
    expect(fetched).toEqual(fetched.map(() => ({ administratie: id, managementKey })));
    expect(s.license.needsRefresh(TODAY)).toBe(false);
    expect(await api.license.price()).toEqual({ bedrag: '9.99', valuta: 'EUR', per: 'maand' });
  });
});

describe('voorwaarden', () => {
  it('site, PDF en app hebben dezelfde versie (anders vraagt de app om akkoord met een andere tekst)', async () => {
    const { readFileSync, statSync } = await import('node:fs');
    const html = readFileSync(new URL('../site/voorwaarden.html', import.meta.url), 'utf8');
    expect(html).toContain(`Versie ${TERMS_VERSION}`);
    // na een wijziging: npm run voorwaarden:pdf
    expect(statSync(new URL('../site/voorwaarden.pdf', import.meta.url)).mtimeMs).toBeGreaterThanOrEqual(statSync(new URL('../site/voorwaarden.html', import.meta.url)).mtimeMs - 60_000);
  });
});
