#!/usr/bin/env node
/**
 * De controles van CI, lokaal: `npm run controle` vóór je pusht of een PR merget.
 * Typecontrole, site-pagina "Wat is er nieuw" bij, alle tests, productiebuild en de controle op wat openbaar
 * gaat. Met --e2e ook de kritieke schermflows in de browser. Onderdelen waarvan het script ontbreekt (in de
 * openbare repo staat de website niet) worden overgeslagen.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const metE2e = process.argv.includes('--e2e');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const bestaat = (f) => fs.existsSync(path.join(ROOT, f));

const stappen = [
  ['Typecontrole', npm, ['run', 'typecheck']],
  bestaat('scripts/site-wijzigingen.cjs') && ['"Wat is er nieuw" bij CHANGELOG', 'node', ['scripts/site-wijzigingen.cjs', '--check']],
  ['Tests', npm, ['test']],
  ['Productiebuild', npm, ['run', 'build']],
  bestaat('scripts/openbaar.cjs') && ['Openbare broncode', 'node', ['scripts/openbaar.cjs', 'controle']],
  metE2e && ['Kritieke schermflows', 'npx', ['playwright', 'test', 'e2e/factuur.spec.ts', 'e2e/bank-bonnetjes.spec.ts', 'e2e/periode-afsluiten.spec.ts']],
].filter(Boolean);

const uitkomst = [];
for (const [naam, cmd, args] of stappen) {
  console.log(`\n=== ${naam} ===`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  uitkomst.push([naam, r.status === 0]);
  if (r.status !== 0) break;
}

console.log('\n=== Samenvatting ===');
for (const [naam, goed] of uitkomst) console.log(`${goed ? '✓' : '✗'} ${naam}`);
const overgeslagen = stappen.slice(uitkomst.length).map(([naam]) => naam);
if (overgeslagen.length) console.log(`  niet gedraaid: ${overgeslagen.join(', ')}`);
process.exit(uitkomst.every(([, goed]) => goed) && !overgeslagen.length ? 0 : 1);
