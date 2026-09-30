import { createPrivateKey, sign } from 'node:crypto';
import type { LicensePayload } from '../src/license/license';

/**
 * Ondertekent een licentie zoals de licentie-Worker (privé-repo shipdocs/boekhoudenvoorniks-server,
 * licentie/src/token.ts): `<payload>.<handtekening>`, beide base64url, Ed25519 over de base64url-tekst van
 * de payload. Alleen voor tests; dit is het contract dat de app controleert.
 */
export async function signLicense(payload: LicensePayload, privateJwk: string): Promise<string> {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const key = createPrivateKey({ key: JSON.parse(privateJwk) as import('node:crypto').JsonWebKey, format: 'jwk' });
  return `${body}.${sign(null, Buffer.from(body, 'ascii'), key).toString('base64url')}`;
}
