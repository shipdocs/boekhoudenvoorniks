// Upgrade-test op Windows (CI): installeert de vorige release met de echte NSIS-installer, laat die een
// administratie in AppData aanmaken, installeert de nieuwe installer eroverheen en controleert het
// overzetten naar %USERPROFILE%\BoekhoudenVoorNiks. Dit is het deel van
// docs/handmatige-test-datamap-windows.md dat zonder scherm te controleren is; de dialogen zelf en
// het versturen van een echte mail blijven handwerk.
//
// Gebruik: node scripts/upgrade-test-windows.cjs <oude installer> <nieuwe installer> <nieuwe versie>
const { spawn, spawnSync } = require('node:child_process');
const { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const [oldInstaller, newInstaller, newVersion] = process.argv.slice(2);
if (process.platform !== 'win32' || !oldInstaller || !newInstaller || !newVersion) {
  console.error('Alleen op Windows: node scripts/upgrade-test-windows.cjs <oude installer> <nieuwe installer> <nieuwe versie>');
  process.exit(2);
}

const APPDATA = process.env.APPDATA;
const HOME = process.env.USERPROFILE;
const oldNew = join(APPDATA, 'boekhoudenvoorniks');
const oldOld = join(APPDATA, 'gratis-boekhouden');
const shared = join(HOME, 'BoekhoudenVoorNiks');
const pointer = join(HOME, '.boekhoudenvoorniks.json');
const STORED_ATTACHMENT = 'bijlagen/2026/bon.pdf';

let checks = 0;
function check(what, ok, detail = '') {
  if (!ok) {
    console.error(`NIET GESLAAGD: ${what}${detail ? ` (${detail})` : ''}`);
    process.exit(1);
  }
  checks++;
  console.log(`ok: ${what}`);
}

function appEnv() {
  const env = { ...process.env, BOEKHOUDENVOORNIKS_SMOKE_TEST: '1' };
  delete env.BOEKHOUDENVOORNIKS_DATA;
  delete env.GRATIS_BOEKHOUDEN_DATA;
  return env;
}

function installedExe() {
  const programs = join(process.env.LOCALAPPDATA, 'Programs');
  for (const dir of existsSync(programs) ? readdirSync(programs) : []) {
    const exe = join(programs, dir, 'BoekhoudenVoorNiks.exe');
    if (existsSync(exe)) return exe;
  }
  return null;
}

function install(installer) {
  const r = spawnSync(installer, ['/S'], { timeout: 300_000 });
  check(`installer ${installer} loopt stil af`, r.status === 0, `exit ${r.status}`);
  // de installer kan terugkeren voordat alles op zijn plek staat
  for (let i = 0; i < 60 && !installedExe(); i++) spawnSync('powershell', ['-Command', 'Start-Sleep -Seconds 1']);
  check('de app is geïnstalleerd', installedExe() !== null);
}

function productVersion(exe) {
  return spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${exe}').VersionInfo.ProductVersion`], { encoding: 'utf8' }).stdout.trim();
}

/** Start de app in rooktestmodus (zonder eigen gegevensmap) en geeft de exitcode. */
function startApp() {
  const r = spawnSync(installedExe(), [], { env: appEnv(), timeout: 120_000, encoding: 'utf8' });
  if (r.stdout) console.log(r.stdout.trim());
  if (r.stderr) console.log(r.stderr.trim());
  return r.status;
}

/** Start de koppeling, stuurt `initialize` en geeft het antwoord (of de fout op stderr) terug. */
function startMcp() {
  return new Promise((resolve) => {
    const env = appEnv();
    delete env.BOEKHOUDENVOORNIKS_SMOKE_TEST;
    const child = spawn(installedExe(), ['--mcp'], { env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('\n')) child.stdin.end();
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'upgrade-test', version: '1' } } })}\n`);
  });
}

function encryptedKey(dir) {
  const file = join(dir, 'Local State');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')).os_crypt?.encrypted_key ?? null;
}

function documentPaths(dbFile) {
  const db = new DatabaseSync(dbFile);
  try {
    return db.prepare('SELECT file_path FROM documents ORDER BY id').all().map((r) => r.file_path);
  } finally {
    db.close();
  }
}

/** Alle bestanden met grootte en wijzigingstijd: om te zien dat een map onaangeroerd is. */
function snapshot(dir) {
  const out = [];
  const walk = (d, prefix) => {
    for (const item of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) walk(join(d, item.name), rel);
      else {
        const s = statSync(join(d, item.name));
        out.push(`${rel}|${s.size}|${s.mtimeMs}`);
      }
    }
  };
  walk(dir, '');
  return out.sort().join('\n');
}

function migrated(appData, name) {
  return readdirSync(appData).filter((n) => n.startsWith(`${name}.gemigreerd-`));
}

async function main() {
  // --- Voorbereiding: de vorige release, echt geïnstalleerd, met een administratie en een bijlage
  install(oldInstaller);
  console.log(`Vorige versie: ${productVersion(installedExe())}`);
  check('de vorige versie start en maakt een administratie in AppData', startApp() === 0 && existsSync(join(oldNew, 'boekhouding.sqlite')));
  check('de gedeelde map bestaat nog niet', !existsSync(shared));

  const attachment = join(oldNew, 'bijlagen', '2026', 'bon.pdf');
  mkdirSync(join(oldNew, 'bijlagen', '2026'), { recursive: true });
  writeFileSync(attachment, 'bon van de upgrade-test');
  const seed = new DatabaseSync(join(oldNew, 'boekhouding.sqlite'));
  seed.prepare(`INSERT INTO documents (file_path, original_name, mime_type, sha256) VALUES (?, 'bon.pdf', 'application/pdf', 'upgrade-test')`).run(attachment);
  seed.close();
  const keyBefore = encryptedKey(oldNew);
  check('de vorige versie heeft een sleutel voor de opgeslagen wachtwoorden (Local State)', keyBefore !== null);

  // --- 1. Upgrade en eerste start (één oude map met gegevens)
  install(newInstaller);
  check(`de nieuwe versie (${newVersion}) staat over de oude installatie heen`, productVersion(installedExe()).startsWith(newVersion), productVersion(installedExe()));
  check('eerste start na de upgrade slaagt', startApp() === 0);
  check('migratie-klaar bestaat in de gedeelde map', existsSync(join(shared, 'migratie-klaar')));
  check('de administratie staat in de gedeelde map', existsSync(join(shared, 'boekhouding.sqlite')));
  check('de oude map heeft zijn oude naam niet meer', !existsSync(oldNew));
  const renamed = migrated(APPDATA, 'boekhoudenvoorniks');
  check('de oude map is bewaard als .gemigreerd-<tijd>', renamed.length === 1, renamed.join(', '));
  const kept = join(APPDATA, renamed[0]);
  check('de inhoud van de oude map is er nog', existsSync(join(kept, 'boekhouding.sqlite')) && readFileSync(join(kept, 'bijlagen', '2026', 'bon.pdf'), 'utf8') === 'bon van de upgrade-test');
  const movedAttachment = join(shared, 'bijlagen', '2026', 'bon.pdf');
  check('de bijlage staat in de gedeelde map', existsSync(movedAttachment) && readFileSync(movedAttachment, 'utf8') === 'bon van de upgrade-test');
  // sinds #186 staat het pad relatief aan de map van de administratie in de database
  check('het bijlagepad in de database is relatief aan de gedeelde map', documentPaths(join(shared, 'boekhouding.sqlite')).join() === STORED_ATTACHMENT, documentPaths(join(shared, 'boekhouding.sqlite')).join());
  check('de sleutel van de opgeslagen wachtwoorden is dezelfde gebleven', encryptedKey(shared) === keyBefore);
  check('tweede start slaagt', startApp() === 0);
  check('de sleutel is na de tweede start nog steeds dezelfde', encryptedKey(shared) === keyBefore);

  let mcp = await startMcp();
  check('de koppeling (--mcp) leest de gedeelde map en antwoordt op initialize', mcp.code === 0 && mcp.out.includes('"result"'), `exit ${mcp.code}: ${mcp.err || mcp.out}`);

  // --- 3. Ongeldige verwijzing: de koppeling weigert en maakt niets aan
  writeFileSync(pointer, JSON.stringify({ version: 1, dataDir: 'C:\\bestaat\\niet' }));
  mcp = await startMcp();
  rmSync(pointer);
  check('ongeldige verwijzing: de koppeling weigert met een foutmelding', mcp.code !== 0 && mcp.code !== null && mcp.err.includes('bestaat'), `exit ${mcp.code}: ${mcp.err}`);
  check('ongeldige verwijzing: er is geen map C:\\bestaat aangemaakt', !existsSync('C:\\bestaat'));

  // --- 2. Beide oude mappen met gegevens: geen stille keuze
  cpSync(kept, oldNew, { recursive: true });
  cpSync(kept, oldOld, { recursive: true });
  rmSync(shared, { recursive: true, force: true });
  const beforeNew = snapshot(oldNew);
  const beforeOld = snapshot(oldOld);
  mcp = await startMcp();
  check('twee oude mappen: de koppeling weigert tot er gekozen is', mcp.code !== 0 && mcp.code !== null && mcp.err.includes('Open de app eerst'), `exit ${mcp.code}: ${mcp.err}`);
  check('twee oude mappen: de app kiest niet zelf (rooktest stopt zonder over te zetten)', startApp() === 1);
  check('twee oude mappen: beide mappen zijn onaangeroerd', snapshot(oldNew) === beforeNew && snapshot(oldOld) === beforeOld);
  check('twee oude mappen: geen marker, geen keuze en geen sleutel in de gedeelde map', !existsSync(join(shared, 'migratie-klaar')) && !existsSync(join(shared, '.migratie-keuze')) && !existsSync(join(shared, 'Local State')));

  // de keuze die de dialoog zou vastleggen: de map van vóór de naamswijziging
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, '.migratie-keuze'), oldOld);
  check('na de keuze zet de app de gekozen map over', startApp() === 0 && existsSync(join(shared, 'migratie-klaar')));
  check('de gekozen map is bewaard als .gemigreerd-<tijd>', !existsSync(oldOld) && migrated(APPDATA, 'gratis-boekhouden').length === 1);
  check('de niet gekozen map is onaangeroerd', snapshot(oldNew) === beforeNew);
  check('bijlagepad uit de map van vóór de naamswijziging is relatief aan de gedeelde map', documentPaths(join(shared, 'boekhouding.sqlite')).join() === STORED_ATTACHMENT && existsSync(movedAttachment), documentPaths(join(shared, 'boekhouding.sqlite')).join());
  check('de sleutel van de gekozen map is overgenomen', encryptedKey(shared) === keyBefore);
  check('de keuze is opgeruimd', !existsSync(join(shared, '.migratie-keuze')));

  console.log(`\nUpgrade-test geslaagd: ${checks} controles.`);
}

main().catch((e) => {
  console.error('NIET GESLAAGD:', e);
  process.exit(1);
});
