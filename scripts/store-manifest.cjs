// Het Store-pakket (MSIX/appx, #181): het versienummer in het manifest en de controle van het pakket.
//
// 1. electron-builder roept `appxManifestCreated` aan zodra het manifest op schijf staat (zie
//    "appxManifestCreated" in package.json; alleen bij het appx-doel). De Microsoft Store weigert een
//    pakketversie die met 0 begint, en het vierde getal moet 0 zijn. Zolang de app 0.x heet, krijgt het
//    pakket daarom een eerste getal dat één hoger is: app 0.7.6 → pakket 1.7.6.0, app 1.0.0 → 2.0.0.0.
//    Zo blijft elke nieuwe versie hoger dan de vorige. De app zelf toont gewoon zijn eigen versie.
// 2. `node scripts/store-manifest.cjs [pakket.appx]` (in CI, op Windows) haalt het manifest uit het
//    gebouwde pakket en controleert de vaste identiteit uit Partner Center, de versie en de alias.
const { execFileSync } = require('node:child_process');
const { readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

/** De identiteit die Partner Center heeft toegekend (issue #172); mag nooit wijzigen. */
const IDENTITY = {
  name: 'ShipDocs.BoekhoudenVoorNiks',
  publisher: 'CN=B884F2A1-35F1-4BD8-9EB7-F2746D9FB427',
  publisherDisplayName: 'ShipDocs',
};
/** De App Execution Alias; dezelfde naam als STORE_ALIAS in src/main/windows-store.ts. */
const ALIAS = 'boekhoudenvoorniks.exe';

/** De pakketversie voor de Store bij een appversie: eerste getal één hoger, vierde getal 0. */
function storeVersion(appVersion) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(appVersion);
  if (!m) throw new Error(`Voor de Store moet de versie drie getallen zijn (bv. 0.7.6), niet "${appVersion}"`);
  return `${Number(m[1]) + 1}.${Number(m[2])}.${Number(m[3])}.0`;
}

/** Zet de pakketversie in het manifest dat electron-builder maakte (dat de appversie met .0 erachter bevat). */
function withStoreVersion(xml, appVersion) {
  const identity = /<Identity\b[^>]*>/.exec(xml);
  const from = `Version="${appVersion}.0"`;
  if (!identity || identity[0].split(from).length !== 2) throw new Error(`Het manifest bevat niet precies één keer ${from} in <Identity>`);
  return xml.replace(identity[0], identity[0].replace(from, `Version="${storeVersion(appVersion)}"`));
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
  expect(`Identity Version is ${storeVersion(appVersion)}`, attr(identity, 'Version') === storeVersion(appVersion));
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

/** De hook van electron-builder: het pad van het zojuist gemaakte AppxManifest.xml. */
async function appxManifestCreated(manifestPath) {
  const { version } = require('../package.json');
  writeFileSync(manifestPath, withStoreVersion(readFileSync(manifestPath, 'utf8'), version));
  console.log(`  • Store-pakket: versie ${storeVersion(version)} (app ${version})`);
}

module.exports = { appxManifestCreated, storeVersion, withStoreVersion, manifestProblems, IDENTITY, ALIAS };

if (require.main === module) {
  const release = join(__dirname, '..', 'release');
  const appx = process.argv[2] ?? readdirSync(release).filter((f) => f.endsWith('.appx')).map((f) => join(release, f))[0];
  if (!appx) {
    console.error('Geen .appx gevonden in release/');
    process.exit(1);
  }
  // een appx is een zip; de tar van Windows zelf (bsdtar) leest die, die van Git Bash niet
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'bsdtar';
  const xml = execFileSync(tar, ['-xOf', appx, 'AppxManifest.xml'], { encoding: 'utf8' });
  const problems = manifestProblems(xml, require('../package.json').version);
  console.log(/<Identity\b[^>]*>/.exec(xml)?.[0].replace(/\s+/g, ' ') ?? '(geen Identity)');
  if (problems.length > 0) {
    console.error(`Het manifest in ${appx} klopt niet. Verwacht:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`ok: ${appx} heeft de vaste identiteit, de Store-versie en de alias`);
}
