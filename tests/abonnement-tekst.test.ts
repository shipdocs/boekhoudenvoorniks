import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { LicenseService } from '../src/license/license';
import { createApi, type HostContext } from '../src/main/api';
import { PHONE_SCANNER } from '../src/shared/phone-scanner';
import { subscriptionText } from '../src/shared/subscription-text';
import { setup } from './helpers';
import { signLicense } from './license-token';

/**
 * De tekst van het abonnement (src/shared/subscription-text.ts) in beide varianten: met telefoon koppelen uit
 * (zoals in de uitgebrachte app) en aan. Uit: de tekst is zoals hij was en noemt de telefoon niet. Aan: de tekst
 * noemt ook de telefoon, en dat ontvangen altijd kan. De tests zetten de schakelaar zelf om.
 */

const TODAY = '2026-10-15';
const UNTIL = '2026-11-22';

afterEach(() => {
  PHONE_SCANNER.available = false;
});

function keys() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as { x: string; d: string };
  return { publicKey: jwk.x, privateJwk: JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d }) };
}

/** alle teksten van een variant achter elkaar, met een vaste datum */
function all(phone: boolean): string {
  const t = subscriptionText(phone);
  return [t.lead, t.body, t.refused, t.expired(UNTIL), t.cancelling, t.cancelled(UNTIL), t.cancelledToast(UNTIL)].join('\n');
}

function message(run: () => void): string {
  try {
    run();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('er werd niets geweigerd');
}

describe('de tekst van het abonnement', () => {
  it('TEKST-01 telefoon koppelen uit: de tekst is zoals hij was', () => {
    const t = subscriptionText(false);
    expect(t.lead).toBe('Versturen naar je boekhouder is een extra functie van het abonnement.');
    expect(t.body).toBe('Met het abonnement steun je de verdere ontwikkeling en krijg je de extra functies. Koppelen, een antwoord inlezen en het pakket voor je boekhouder blijven gratis; alleen het versturen vraagt een abonnement.');
    expect(t.refused).toBe('Versturen naar je boekhouder is een extra functie van het abonnement. Neem een abonnement, of haal je licentie op als je al betaald hebt; een antwoord inlezen kan altijd, en het pakket voor je boekhouder kun je altijd zelf sturen.');
    expect(t.expired(UNTIL)).toBe('Je abonnement liep tot 22 november 2026. Verleng het om weer naar je boekhouder te versturen; een antwoord inlezen kan altijd.');
    expect(t.cancelling).toBe('Er wordt daarna niets meer afgeschreven. Je kunt nog naar je boekhouder versturen tot het eind van de maand waarvoor je betaald hebt; een antwoord inlezen kan altijd.');
    expect(t.cancelled(UNTIL)).toBe('Abonnement opgezegd: je kunt versturen t/m 22 november 2026; er wordt niets meer afgeschreven.');
    expect(t.cancelledToast(UNTIL)).toBe('Opgezegd; versturen kan nog t/m 22 november 2026');
  });

  it('TEKST-02 telefoon koppelen uit: de telefoon wordt nergens genoemd', () => {
    expect(all(false)).not.toMatch(/telefoon|klanten|projecten|btw-regels/i);
  });

  it('TEKST-03 telefoon koppelen aan: de tekst noemt beide extra functies, en wat altijd kan', () => {
    const t = subscriptionText(true);
    expect(t.lead).toBe('Versturen naar je boekhouder, een telefoon koppelen en het bijwerken van klanten, projecten en btw-regels op je telefoon zijn extra functies van het abonnement.');
    expect(t.body).toBe('Met het abonnement steun je de verdere ontwikkeling en krijg je de extra functies. Koppelen aan je boekhouder, een antwoord inlezen en het pakket voor je boekhouder blijven gratis, en wat een gekoppelde telefoon stuurt, komt altijd aan.');
    expect(t.refused).toBe('Versturen naar je boekhouder, een telefoon koppelen en het bijwerken van klanten, projecten en btw-regels op je telefoon zijn extra functies van het abonnement. Neem een abonnement, of haal je licentie op als je al betaald hebt; een antwoord inlezen kan altijd, wat een gekoppelde telefoon stuurt komt altijd aan, en het pakket voor je boekhouder kun je altijd zelf sturen.');
    expect(t.expired(UNTIL)).toBe('Je abonnement liep tot 22 november 2026. Verleng het om weer naar je boekhouder te versturen, een telefoon te koppelen en klanten, projecten en btw-regels op je telefoon bij te werken; een antwoord inlezen kan altijd, en wat een gekoppelde telefoon stuurt, komt altijd aan.');
    expect(t.cancelling).toBe('Er wordt daarna niets meer afgeschreven. Je kunt nog naar je boekhouder versturen, een telefoon koppelen en klanten, projecten en btw-regels op je telefoon bijwerken tot het eind van de maand waarvoor je betaald hebt; een antwoord inlezen kan altijd, en wat een gekoppelde telefoon stuurt, komt altijd aan.');
    expect(t.cancelled(UNTIL)).toBe('Abonnement opgezegd: de extra functies werken t/m 22 november 2026; er wordt niets meer afgeschreven.');
    expect(t.cancelledToast(UNTIL)).toBe('Opgezegd; de extra functies werken nog t/m 22 november 2026');
  });

  it('TEKST-04 in beide varianten: geen bedrag, en een antwoord inlezen kan altijd', () => {
    for (const phone of [false, true]) {
      const t = subscriptionText(phone);
      expect(all(phone)).not.toMatch(/€|\d+ maanden|gratis beginnen/);
      for (const s of [t.refused, t.expired(UNTIL), t.cancelling]) expect(s).toMatch(/een antwoord inlezen kan altijd/);
      expect(t.body).toMatch(/een antwoord inlezen en het pakket voor je boekhouder blijven gratis/);
    }
    // met de telefoon erbij: ontvangen kan altijd, overal waar staat wat altijd kan
    const t = subscriptionText(true);
    for (const s of [t.body, t.refused, t.expired(UNTIL), t.cancelling]) expect(s).toMatch(/wat een gekoppelde telefoon stuurt,? komt altijd aan/);
  });

  it('TEKST-05 versturen zonder abonnement geeft de tekst van de stand van de schakelaar (geen, ongeldig en verlopen)', async () => {
    const k = keys();
    const { s } = setup();
    const license = new LicenseService(s.db, s.settings, k.publicKey);
    const refused = (today: string) => message(() => license.requireActive(today));

    // geen abonnement
    expect(license.status(TODAY)).toEqual({ state: 'geen' });
    PHONE_SCANNER.available = false;
    expect(refused(TODAY)).toBe(subscriptionText(false).refused);
    PHONE_SCANNER.available = true;
    expect(refused(TODAY)).toBe(subscriptionText(true).refused);

    // een licentie die niet klopt
    s.db.prepare(`INSERT INTO settings (key, value) VALUES ('license', ?)`).run(JSON.stringify('geen.licentie'));
    expect(license.status(TODAY).state).toBe('ongeldig');
    PHONE_SCANNER.available = false;
    expect(refused(TODAY)).toBe(subscriptionText(false).refused);
    PHONE_SCANNER.available = true;
    expect(refused(TODAY)).toBe(subscriptionText(true).refused);

    // actief: niets geweigerd, in beide standen; daarna verlopen
    const token = await signLicense({ v: 1, product: 'uitwisseling', administratie: s.settings.administrationId(), email: 'piet@example.nl', validUntil: UNTIL, issuedAt: TODAY }, k.privateJwk);
    license.install(token, TODAY);
    for (const phone of [false, true]) {
      PHONE_SCANNER.available = phone;
      expect(() => license.requireActive(TODAY)).not.toThrow();
    }
    PHONE_SCANNER.available = false;
    expect(refused('2026-11-23')).toBe(subscriptionText(false).expired(UNTIL));
    PHONE_SCANNER.available = true;
    expect(refused('2026-11-23')).toBe(subscriptionText(true).expired(UNTIL));
  });

  it('TEKST-06 het scherm krijgt de schakelaar via app.meta(), en het abonnementsblok haalt zijn tekst op die ene plek', () => {
    const { s } = setup();
    const api = createApi(s, { appVersion: () => 'test' } as unknown as HostContext);
    PHONE_SCANNER.available = false;
    expect(api.app.meta().phoneScanner).toBe(false);
    PHONE_SCANNER.available = true;
    expect(api.app.meta().phoneScanner).toBe(true);

    const screen = readFileSync(new URL('../src/renderer/screens/Exchange.tsx', import.meta.url), 'utf8');
    expect(screen).toContain('subscriptionText(meta.phoneScanner)');
    for (const part of ['text.lead', 'text.body', 'text.cancelling', 'text.cancelled(', 'text.cancelledToast(']) expect(screen).toContain(part);
    // de zinnen zelf staan niet meer in het scherm of in de licentiedienst
    const license = readFileSync(new URL('../src/license/license.ts', import.meta.url), 'utf8');
    for (const source of [screen, license]) expect(source).not.toMatch(/extra functie van het abonnement|vraagt een abonnement|versturen kan nog/);
  });
});
