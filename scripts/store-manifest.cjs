// Het Store-pakket (MSIX/appx, #181) controleren: `node scripts/store-manifest.cjs [pakket.appx]` (in CI)
// haalt het manifest uit het gebouwde pakket en controleert de vaste identiteit uit Partner Center, de
// versie en de alias. De pakketversie is de appversie met .0 erachter (app 1.0.0 → pakket 1.0.0.0); de
// Microsoft Store weigert een versie die met 0 begint en eist dat het vierde getal 0 is.
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { inflateRawSync } = require('node:zlib');

/** De identiteit die Partner Center heeft toegekend (issue #172); mag nooit wijzigen. */
const IDENTITY = {
  name: 'ShipDocs.BoekhoudenVoorNiks',
  publisher: 'CN=B884F2A1-35F1-4BD8-9EB7-F2746D9FB427',
  publisherDisplayName: 'ShipDocs',
};
/** De App Execution Alias; dezelfde naam als STORE_ALIAS in src/main/windows-store.ts. */
const ALIAS = 'boekhoudenvoorniks.exe';

/** De pakketversie bij een appversie: dezelfde drie getallen en een vierde 0. Voor de Store mag het eerste getal geen 0 zijn. */
function packageVersion(appVersion) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(appVersion);
  if (!m) throw new Error(`Voor de Store moet de versie drie getallen zijn (bv. 1.0.0), niet "${appVersion}"`);
  if (Number(m[1]) === 0) throw new Error(`De Store weigert een versie die met 0 begint (${appVersion})`);
  return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}.0`;
}

/** Wat er aan het manifest van het Store-pakket niet klopt; een lege lijst = in orde. */
function manifestProblems(xml, appVersion) {
  const problems = [];
  const expect = (what, ok) => {
    if (!ok) problems.push(what);
  };
  const identity = /<Identity\b[^>]*>/.exec(xml)?.[0] ?? '';
  const attr = (tag, name) => new RegExp(`\\b${name}=(["'])(.*?)\\1`).exec(tag)?.[2] ?? null;
  expect(`Identity Name is ${IDENTITY.name}`, attr(identity, 'Name') === IDENTITY.name);
  expect(`Identity Publisher is ${IDENTITY.publisher}`, attr(identity, 'Publisher') === IDENTITY.publisher);
  expect(`Identity Version is ${packageVersion(appVersion)}`, attr(identity, 'Version') === packageVersion(appVersion));
  expect('ProcessorArchitecture is x64', attr(identity, 'ProcessorArchitecture') === 'x64');
  expect(`PublisherDisplayName is ${IDENTITY.publisherDisplayName}`, xml.includes(`<PublisherDisplayName>${IDENTITY.publisherDisplayName}</PublisherDisplayName>`));
  expect('de taal is nl-NL', /<Resource Language="nl-NL" \/>/.test(xml));
  const application = /<Application\b[^>]*>/.exec(xml)?.[0] ?? '';
  expect('Application Id zonder spaties', /^[A-Za-z][A-Za-z0-9.]*$/.test(attr(application, 'Id') ?? ''));
  expect('runFullTrust staat erin', /<rescap:Capability Name="runFullTrust"\s*\/>/.test(xml));
  expect('de naamruimte uap3 is gedeclareerd', xml.includes('xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3"'));
  const alias = /<uap3:Extension\b[^>]*Category="windows\.appExecutionAlias"[^>]*>/.exec(xml)?.[0] ?? '';
  expect('de App Execution Alias staat erin', alias !== '' && xml.includes(`<desktop:ExecutionAlias Alias="${ALIAS}" />`));
  expect('de alias start hetzelfde programma als de app', alias !== '' && attr(alias, 'Executable') === attr(application, 'Executable'));
  return problems;
}

/**
 * AppxManifest.xml uit een pakket lezen. Een appx is een zip (ZIP64, met de groottes achter de gegevens);
 * daarom zoeken we het bestand zelf op in plaats van via de inhoudsopgave te lopen.
 */
function readManifest(appx) {
  const name = Buffer.from('AppxManifest.xml');
  for (let at = appx.indexOf(name); at !== -1; at = appx.indexOf(name, at + 1)) {
    const header = at - 30;
    // "PK\3\4", met op 26 de lengte van de naam en op 28 die van het extra veld
    if (header < 0 || appx.readUInt32LE(header) !== 0x04034b50 || appx.readUInt16LE(header + 26) !== name.length) continue;
    const data = appx.subarray(at + name.length + appx.readUInt16LE(header + 28));
    const method = appx.readUInt16LE(header + 8);
    if (method !== 0 && method !== 8) break;
    // inflateRawSync stopt aan het eind van het gecomprimeerde blok; wat erna komt telt niet mee
    const text = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    const end = text.indexOf('</Package>');
    if (end !== -1) return text.slice(0, end + '</Package>'.length);
  }
  throw new Error('AppxManifest.xml niet gevonden in het pakket');
}

module.exports = { packageVersion, manifestProblems, readManifest, IDENTITY, ALIAS };

if (require.main === module) {
  const release = join(__dirname, '..', 'release');
  const appx = process.argv[2] ?? readdirSync(release).filter((f) => f.endsWith('.appx')).map((f) => join(release, f))[0];
  if (!appx) {
    console.error('Geen .appx gevonden in release/');
    process.exit(1);
  }
  const xml = readManifest(readFileSync(appx));
  const problems = manifestProblems(xml, require('../package.json').version);
  console.log(/<Identity\b[^>]*>/.exec(xml)?.[0].replace(/\s+/g, ' ') ?? '(geen Identity)');
  if (problems.length > 0) {
    console.error(`Het manifest in ${appx} klopt niet. Verwacht:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`ok: ${appx} heeft de vaste identiteit, de versie en de alias`);
}
