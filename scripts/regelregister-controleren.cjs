const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const registerPath = path.join(root, 'docs', 'regelregister.json');
const register = JSON.parse(fs.readFileSync(registerPath, 'utf8'));
const errors = [];
const ids = new Set();
const allowedStates = new Set(['te-controleren', 'bron-gecontroleerd', 'extern-te-beoordelen']);

for (const rule of register.rules ?? []) {
  const prefix = `regel ${rule.id ?? '(zonder id)'}`;
  if (!/^BvN-[A-Z]+-[0-9]{3}$/.test(rule.id ?? '')) errors.push(`${prefix}: ongeldig id`);
  if (ids.has(rule.id)) errors.push(`${prefix}: dubbel id`);
  ids.add(rule.id);
  if (!rule.title || !rule.domain) errors.push(`${prefix}: titel of domein ontbreekt`);
  if (!allowedStates.has(rule.verification?.status)) errors.push(`${prefix}: ongeldige verificatiestatus`);
  if (!Array.isArray(rule.implementation) || rule.implementation.length === 0) errors.push(`${prefix}: implementatieverwijzing ontbreekt`);
  if (!Array.isArray(rule.tests) || rule.tests.length === 0) errors.push(`${prefix}: testverwijzing ontbreekt`);
  for (const file of [...(rule.implementation ?? []), ...(rule.tests ?? [])]) {
    if (!fs.existsSync(path.join(root, file))) errors.push(`${prefix}: bestand bestaat niet: ${file}`);
  }
  for (const source of rule.sources ?? []) {
    if (!/^https:\/\//.test(source.url ?? '')) errors.push(`${prefix}: bron is geen https-url`);
  }
  if (rule.verification?.status === 'bron-gecontroleerd' && (!rule.verification.checkedOn || !(rule.sources?.length))) {
    errors.push(`${prefix}: gecontroleerde regel mist controledatum of bron`);
  }
}

if (!register.rules?.length) errors.push('register bevat geen regels');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Regelregister geldig: ${register.rules.length} regels, ${ids.size} unieke ids.`);
}
