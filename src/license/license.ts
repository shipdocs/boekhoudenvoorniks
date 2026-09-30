import { createPublicKey, randomBytes, verify } from 'node:crypto';
import type { Db } from '../db/database';
import type { SettingsService } from '../settings/settings';
import { formatDateNl, type IsoDate } from '../shared/dates';
import { ValidationError } from '../shared/validation';

/**
 * Abonnement voor de uitwisseling met de boekhouder. De licentie is een token dat de licentie-Worker
 * ondertekent (privé-repo shipdocs/boekhoudenvoorniks-server) en dat de app offline controleert met de publieke sleutel hieronder.
 * Alleen *versturen naar je boekhouder* vraagt een licentie; een antwoord inlezen werkt altijd, zodat
 * een klant nooit met een vergrendelde periode blijft zitten. De kantoorkant is gratis.
 */

/** Waar de app het abonnement start en de licentie ophaalt. */
export const LICENSE_API_URL = 'https://licentie.boekhoudenvoorniks.nl';

/**
 * Publieke sleutel (Ed25519, base64url) van de licentie-Worker. Leeg = licenties staan nog uit en alles
 * is vrij te gebruiken. Het sleutelpaar maak je met licentie/sleutel-maken.mjs in de privé-repo.
 */
export const LICENSE_PUBLIC_KEY = '5X4g-WVye2XVXEURIEBkQorBD_vqDmWyEqHMsA1T_b8';

export interface LicensePayload {
  v: 1;
  product: 'uitwisseling';
  administratie: string;
  email: string;
  validUntil: IsoDate;
  issuedAt: IsoDate;
  /** opgezegd: er wordt niets meer afgeschreven, de licentie loopt tot validUntil */
  cancelled?: boolean;
}

/** Bedrijfsgegevens voor de factuur van het abonnement (licentie-Worker: Billing). */
export interface LicenseBilling {
  naam: string;
  adres: string;
  postcode: string;
  plaats: string;
  land: string;
  kvk?: string;
  btw?: string;
}

export type LicenseStatus =
  | { state: 'uit' }
  | { state: 'geen' }
  | { state: 'ongeldig'; reason: string }
  | { state: 'verlopen'; validUntil: IsoDate; email: string }
  | { state: 'actief'; validUntil: IsoDate; email: string; cancelled: boolean };

/** Controleert handtekening en inhoud; gooit bij een vervalst of kapot token. */
export function verifyLicense(token: string, publicKey: string): LicensePayload {
  const [body, sig, ...rest] = token.trim().split('.');
  if (!body || !sig || rest.length > 0) throw new Error('Dit is geen licentie');
  let ok = false;
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
    ok = verify(null, Buffer.from(body, 'ascii'), key, Buffer.from(sig, 'base64url'));
  } catch {
    ok = false;
  }
  if (!ok) throw new Error('De handtekening van deze licentie klopt niet');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LicensePayload;
  if (payload.v !== 1 || payload.product !== 'uitwisseling' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.validUntil)) throw new Error('Onbekend soort licentie; werk de app bij');
  return payload;
}

export class LicenseService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly publicKey: string = LICENSE_PUBLIC_KEY,
  ) {}

  /** Staan licenties aan (is er een sleutel om ze te controleren)? */
  get enabled(): boolean {
    return this.publicKey !== '';
  }

  /**
   * Geheim waarmee deze administratie haar licentie kan ophalen en het abonnement kan opzeggen.
   * Het blijft lokaal in de administratie(database) en gaat alleen in de body/header naar de Worker.
   */
  managementKey(): string {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'licenseManagementKey'`).get() as { value: string } | undefined;
    if (row) {
      const value = JSON.parse(row.value) as unknown;
      if (typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)) return value;
    }
    const value = randomBytes(32).toString('base64url');
    this.db.prepare(`INSERT INTO settings (key, value) VALUES ('licenseManagementKey', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(value));
    return value;
  }

  status(today: IsoDate): LicenseStatus {
    if (!this.enabled) return { state: 'uit' };
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'license'`).get() as { value: string } | undefined;
    if (!row) return { state: 'geen' };
    let payload: LicensePayload;
    try {
      payload = verifyLicense(JSON.parse(row.value) as string, this.publicKey);
    } catch (e) {
      return { state: 'ongeldig', reason: (e as Error).message };
    }
    if (payload.administratie !== this.settings.administrationId()) return { state: 'ongeldig', reason: 'Deze licentie hoort bij een andere administratie' };
    if (payload.validUntil < today) return { state: 'verlopen', validUntil: payload.validUntil, email: payload.email };
    return { state: 'actief', validUntil: payload.validUntil, email: payload.email, cancelled: payload.cancelled === true };
  }

  /** Een licentie (van de Worker) bewaren, na controle. */
  install(token: string, today: IsoDate): LicenseStatus {
    const payload = verifyLicense(token, this.publicKey);
    if (payload.administratie !== this.settings.administrationId()) throw new ValidationError('Deze licentie hoort bij een andere administratie');
    this.db.prepare(`INSERT INTO settings (key, value) VALUES ('license', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(token.trim()));
    return this.status(today);
  }

  /** Is er ooit een licentie geweest? Dan mag de app hem op de achtergrond verversen. */
  hasLicense(): boolean {
    return this.db.prepare(`SELECT 1 FROM settings WHERE key = 'license'`).get() !== undefined;
  }

  /** Moet de app de licentie verversen (verlopen, of binnen `days` dagen)? */
  needsRefresh(today: IsoDate, days = 7): boolean {
    const s = this.status(today);
    if (s.state === 'verlopen' || s.state === 'ongeldig') return this.hasLicense();
    // opgezegd: er komt geen verlenging meer, dus niet steeds opnieuw vragen
    if (s.state !== 'actief' || s.cancelled) return false;
    const soon = new Date(`${today}T00:00:00Z`);
    soon.setUTCDate(soon.getUTCDate() + days);
    return s.validUntil <= soon.toISOString().slice(0, 10);
  }

  /** Voor versturen naar de boekhouder. */
  requireActive(today: IsoDate): void {
    const s = this.status(today);
    if (s.state === 'uit' || s.state === 'actief') return;
    if (s.state === 'verlopen') throw new ValidationError(`Je abonnement liep tot ${formatDateNl(s.validUntil)}. Verleng het om weer naar je boekhouder te versturen; een antwoord inlezen kan altijd.`);
    throw new ValidationError('Versturen naar je boekhouder hoort bij het abonnement. Neem een abonnement, of haal je licentie op als je al betaald hebt; een antwoord inlezen kan altijd.');
  }
}
