/**
 * Licentie als ondertekend token: `<payload>.<handtekening>`, beide base64url. De payload is JSON; de
 * handtekening (Ed25519) is over de base64url-tekst van de payload, zodat er niets te normaliseren valt.
 * De app controleert dit offline met de publieke sleutel (src/license/license.ts).
 */
export interface LicensePayload {
  v: 1;
  product: 'uitwisseling';
  /** administratie-ID van de klant (UUID) */
  administratie: string;
  email: string;
  /** t/m deze datum (JJJJ-MM-DD), inclusief een paar dagen marge voor de incasso */
  validUntil: string;
  issuedAt: string;
  /** opgezegd: er wordt niets meer afgeschreven, de licentie loopt tot validUntil */
  cancelled?: boolean;
}

const b64u = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** `privateJwk`: de privésleutel als JWK (JSON met kty OKP, crv Ed25519, x en d), uit een Worker-secret. */
export async function signLicense(payload: LicensePayload, privateJwk: string): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', JSON.parse(privateJwk) as JsonWebKey, { name: 'Ed25519' }, false, ['sign']);
  const body = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(body)));
  return `${body}.${b64u(signature)}`;
}
