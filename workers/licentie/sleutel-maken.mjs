#!/usr/bin/env node
/**
 * Maakt het sleutelpaar voor licenties (Ed25519), één keer.
 *
 *   node workers/licentie/sleutel-maken.mjs [pad]
 *
 * - De privésleutel komt in een bestand buiten de repo (standaard ~/.config/boekhoudenvoorniks-licentiesleutel.json,
 *   alleen leesbaar voor jou). Daarna: `npx wrangler secret put LICENSE_PRIVATE_KEY < <dat bestand>`.
 * - De publieke sleutel wordt getoond; die komt in src/license/license.ts (LICENSE_PUBLIC_KEY).
 *
 * Bestaat het bestand al, dan stopt het script: een nieuwe sleutel maakt alle uitgegeven licenties ongeldig.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const target = process.argv[2] ?? join(homedir(), '.config', 'boekhoudenvoorniks-licentiesleutel.json');
if (existsSync(target)) {
  console.error(`${target} bestaat al. Een nieuwe sleutel maakt alle uitgegeven licenties ongeldig; verwijder het bestand eerst als je dat echt wilt.`);
  process.exit(1);
}
const { privateKey } = generateKeyPairSync('ed25519');
const jwk = privateKey.export({ format: 'jwk' });
writeFileSync(target, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d }), { mode: 0o600 });
console.log(`Privésleutel bewaard in ${target} (alleen voor jou leesbaar). Zet hem in de Worker met:`);
console.log(`  cd workers/licentie && npx wrangler secret put LICENSE_PRIVATE_KEY < ${target}`);
console.log('');
console.log('Publieke sleutel voor src/license/license.ts (LICENSE_PUBLIC_KEY):');
console.log(`  ${jwk.x}`);
