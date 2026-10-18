// Golden-runner voor de gedeelde rekenkern (stap S2).
//
// Draait elke vector uit packages/core/golden/vectors.json letterlijk door
// computeTotals van packages/core en vergelijkt het volledige resultaat met
// de verwachte uitvoer in het bestand. Het vectorbestand is puur data; dit
// script is de enige Node-specifieke kant, zodat de desktop en een latere
// Android-app dezelfde vectoren tegen dezelfde kern kunnen draaien.
//
// Gebruik: npm run test:golden  (bouwt de kern eerst)
// Of direct: node scripts/golden-kern.mjs  (vereist een actuele build van packages/core)
//
// Bij succes print het script GOLDEN_OK <aantal>; bij een verschil een duidelijke
// foutmelding met de vector-id en exitcode 1.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeTotals } from '../packages/core/dist/index.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vectorsPath = join(root, 'packages', 'core', 'golden', 'vectors.json');

const data = JSON.parse(readFileSync(vectorsPath, 'utf8'));
const vectors = data?.vectors;
if (!Array.isArray(vectors) || vectors.length === 0) {
  console.error(`FOUT: geen vectoren gevonden in ${vectorsPath}`);
  process.exit(1);
}

/** Strikte structurele vergelijking: eerst kanoniseren (gesorteerde sleutels), dan tekstvergelijking. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  }
  return value;
}

const failures = [];
for (const vector of vectors) {
  let actual;
  try {
    actual = computeTotals(vector.invoer.lines);
  } catch (e) {
    failures.push({ id: vector.id, reden: `gooide fout: ${e.message}` });
    continue;
  }
  const expected = vector.verwacht;
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
    failures.push({
      id: vector.id,
      reden: 'uitvoer verschilt van verwacht',
      verwacht: JSON.stringify(expected),
      werkelijk: JSON.stringify(actual),
    });
  }
}

if (failures.length > 0) {
  console.error(`GOLDEN_FAIL ${failures.length} van ${vectors.length} vectoren verschillen:`);
  for (const f of failures) {
    console.error(`- ${f.id}: ${f.reden}`);
    if (f.verwacht) console.error(`    verwacht:  ${f.verwacht}`);
    if (f.werkelijk) console.error(`    werkelijk: ${f.werkelijk}`);
  }
  process.exit(1);
}

console.log(`GOLDEN_OK ${vectors.length}`);
