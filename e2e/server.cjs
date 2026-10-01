/**
 * Testserver voor de end-to-end tests: dezelfde services en api als de app (uit dist/), maar via
 * HTTP in plaats van Electron-IPC. De renderer draait in een gewone browser; e2e/fixtures.ts zet
 * daar een window.bridge neer die naar deze server praat.
 *
 * POST /api            { method, args }  → { ok } of { error }
 * POST /__reset        lege administratie (nieuwe map), voor elke test; body {"licenses":true} = licenties aan,
 *                      met een nagebootste licentie-Worker (echte Ed25519-handtekening, eigen sleutelpaar)
 * POST /__downloads    de map die in de test de Downloads-map is (leeg aangemaakt per test); de test zet er bestanden in
 * POST /__opened       de bijlagen die geopend zijn: het pad uit de database en de inhoud van het bestand (base64)
 * POST /__pay          de laatst gestarte betaling "betaald" (zoals de Mollie-webhook); geeft de abonnementen
 * POST /__store        de versie uit de Microsoft Store nabootsen: body {"on":true} en eventueel "readOnly";
 *                      geeft terug wat er gebeurde (toestemming voor lokaal lezen, "Opnieuw proberen")
 * POST /__datafolder   body {"pick":{"name","kind"}} = de map die het keuzevenster "teruggeeft" (kind: leeg, vol of
 *                      compleet; null = annuleren), {"custom":true} = de app werkt uit een zelf gekozen map,
 *                      {"oldStandard":true} = in de standaardmap staat nog een administratie; geeft wat er bevestigd is
 * POST /__scanner      bonnenscanner: body {"folder": "..."} = de map die "Map kiezen…" oplevert; geeft de tekst van
 *                      de laatst getoonde QR-code terug, zodat de test zich als telefoon kan melden
 * alles anders         bestanden uit dist/renderer
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'dist');
const { openDatabase } = require(path.join(ROOT, 'main/db/database.js'));
const { createServices, MemorySecretStore } = require(path.join(ROOT, 'main/services.js'));
const { createApi } = require(path.join(ROOT, 'main/main/api.js'));
const { wipeDatabase } = require(path.join(ROOT, 'main/main/reset.js'));
const { deleteAttachment, resolveAttachmentPath, saveAttachment } = require(path.join(ROOT, 'main/main/attachments.js'));
const { seedDemo } = require(path.join(ROOT, 'main/demo/demo.js'));
const { Administrations, readAdministrationFile } = require(path.join(ROOT, 'main/main/administrations.js'));
const { SettingsService } = require(path.join(ROOT, 'main/settings/settings.js'));
const { createBackupBundle, extractBundle } = require(path.join(ROOT, 'main/main/backup.js'));
const { ExchangeService, sanitizeForExchange } = require(path.join(ROOT, 'main/exchange/exchange.js'));
const { generateOfficeKeys } = require(path.join(ROOT, 'main/exchange/crypto.js'));
const { folderAccess } = require(path.join(ROOT, 'main/main/statement-files.js'));
const { markComplete, planSwitch, sharedDataDir } = require(path.join(ROOT, 'main/main/data-dir.js'));
const { Bonnenscanner } = require(path.join(ROOT, 'main/scanner/scanner.js'));
const Database = require('better-sqlite3');
/** het kantoor op deze "computer" (in de app: kantoor.json in de gegevensmap) */
let officeProfile = null;
/** geheimen per administratie (in de app: in de eigen database, versleuteld); blijven bewaard bij wisselen */
let secretStores = new Map();
const secretsFor = (dbFile) => {
  if (!secretStores.has(dbFile)) secretStores.set(dbFile, new MemorySecretStore());
  return secretStores.get(dbFile);
};

/**
 * Bonnenscanner: het echte ontvangstpunt, in de test alleen op 127.0.0.1 (zonder mDNS). `scannerPlatform`
 * doet alsof de app op Windows draait (uitleg over de firewall); `pickedFolder` is wat het keuzevenster geeft.
 */
let scanner = null;
let lastPairing = null;
let pickedFolder = null;
let scannerPlatform = 'linux';

/** zoals de app: de huidige administratie sluiten en een andere openen */
function openAdmin(key) {
  const admins = new Administrations(dir);
  admins.select(key);
  void scanner?.stop();
  db.close();
  file = path.join(admins.dirFor(key), 'boekhouding.sqlite');
  init(false);
}

/**
 * Nagebootste licentie-Worker (privé-repo boekhoudenvoorniks-server) voor de test van het abonnement: zelfde tokenformaat
 * (`<payload>.<handtekening>`, base64url, Ed25519 over de payloadtekst), zodat de app hem echt controleert.
 */
let licensing = null;
function makeLicensing() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey: publicKey.export({ format: 'jwk' }).x, privateKey, accounts: new Map(), lastStarted: null };
}
const isoAddDays = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
function signLicense(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.sign(null, Buffer.from(body, 'ascii'), licensing.privateKey).toString('base64url')}`;
}
function fakeLicenseApi() {
  const account = (administratie, managementKey) => {
    const a = licensing.accounts.get(administratie);
    if (a && a.managementKey !== managementKey) throw new Error('De licentieserver gaf een fout (403); probeer het later opnieuw');
    return a;
  };
  return {
    async price() {
      return { bedrag: '9.00', inclusiefBtw: '10.89', valuta: 'EUR', per: 'maand', btw: 'exclusief', proefMaanden: 4 };
    },
    async start(input) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(input.managementKey)) throw new Error('Ongeldige beheersleutel');
      const a = account(input.administratie, input.managementKey);
      if (a?.paid && !a.cancelled) return { al: true };
      licensing.accounts.set(input.administratie, { ...input, paid: false, cancelled: false });
      licensing.lastStarted = input.administratie;
      return { checkout: 'https://www.mollie.com/checkout/test-e2e' };
    },
    async fetch(administratie, managementKey) {
      const a = account(administratie, managementKey);
      if (!a?.paid) return null;
      return signLicense({ v: 1, product: 'uitwisseling', administratie, email: a.email, validUntil: isoAddDays(37), issuedAt: isoAddDays(0), ...(a.cancelled ? { cancelled: true } : {}) });
    },
    async cancel(administratie, managementKey) {
      const a = account(administratie, managementKey);
      if (!a?.paid) throw new Error('Geen abonnement gevonden voor deze administratie');
      a.cancelled = true;
      return { betaaldTot: isoAddDays(30), geldigTot: isoAddDays(37) };
    },
  };
}

const PORT = Number(process.env.E2E_PORT || 5190);
let dir, file, db, services, api;
/** api-verzoeken die nog lopen: een reset wacht tot ze klaar zijn */
let inflight = 0;
/** wat de app "verstuurde" (e-mail) en "opsloeg" (bestanden), voor controles in de tests */
let sent = [];
/** nagebootste update-status (POST /__update), en of "Nu herstarten" is aangeklikt */
let updateStatus = { state: 'uit', version: null, notes: null, percent: null, error: null };
let updateInstalled = false;
/** aanroepen van "Back-up terugzetten" (in de test annuleert de gebruiker het keuzevenster) */
let restoreCalls = [];
/** nagebootste versie uit de Microsoft Store (POST /__store) */
const noStore = () => ({ on: false, readOnly: false, consent: false, installs: 0, retried: false });
let store = noStore();

const downloadsDir = () => path.join(dir, 'Downloads');
/**
 * Gegevensmap wijzigen: de echte beoordeling van de gekozen map (planSwitch), op echte mappen in een
 * nagebootste thuismap. Alleen het keuzevenster en de herstart van de app zijn vervangen.
 */
let folders = null;
function resetFolders() {
  if (folders) fs.rmSync(folders.root, { recursive: true, force: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-e2e-mappen-'));
  folders = { root, home: path.join(root, 'home'), custom: false, pick: null, plan: null, applied: null };
  fs.mkdirSync(folders.home);
}
/** een map met een complete (lege) administratie */
function completeFolder(p) {
  fs.mkdirSync(p, { recursive: true });
  openDatabase(path.join(p, 'boekhouding.sqlite')).close();
  markComplete(p);
}
const planFolder = (chosen, copyToStandard) => planSwitch({ home: folders.home, current: dir, chosen, copyToStandard });

/** zoals de app: bijlagen in de map van de open administratie, met het relatieve pad in de database */
async function storeFile(name, data) {
  return saveAttachment(path.dirname(file), name, data);
}
/** de bijlagen die de test "opende" (in de app: met het programma van de computer) */
let openedAttachments = [];

function init(fresh) {
  if (fresh) {
    try { db?.close(); } catch { /* al dicht */ }
    // de vorige (tijdelijke) administratie opruimen
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-e2e-'));
    secretStores = new Map();
    officeProfile = null;
    file = path.join(dir, 'boekhouding.sqlite');
    // de "Downloads-map" van deze test: buiten de administratie, zoals in het echt
    fs.mkdirSync(downloadsDir(), { recursive: true });
  }
  db = openDatabase(file);
  services = createServices(db, {
    pdf: async (html) => Buffer.from(`%PDF-1.4 test ${html.length}`),
    mailerFactory: async () => ({ send: async (m) => { sent.push({ to: m.to, subject: m.subject }); return { messageId: `<e2e-${sent.length}@test>` }; } }),
    secrets: secretsFor(file),
    fetch: async () => { throw new Error('geen netwerk in e2e-tests'); },
    storeFile,
    removeFile: (p) => deleteAttachment(path.dirname(file), p),
    statementFiles: folderAccess,
    // alleen voor een test van het abonnement; standaard staan licenties uit ('' = uit, ook nu de app een echte sleutel heeft)
    licensePublicKey: licensing?.publicKey ?? process.env.E2E_LICENSE_PUBLIC_KEY ?? '',
  });
  let smtpPassword = null;
  scanner = new Bonnenscanner({
    db,
    secrets: secretsFor(file),
    intake: services.intake,
    settings: services.settings,
    spoolDir: path.join(path.dirname(file), 'bonnenscanner'),
    protectedDirs: [dir],
    interfaces: () => [{ address: '127.0.0.1', netmask: '255.0.0.0' }],
    platform: scannerPlatform,
  });
  const pair = scanner.pair.bind(scanner);
  scanner.pair = async () => {
    const p = await pair();
    lastPairing = p.payload;
    return p;
  };
  const current = scanner;
  void current.start();
  api = createApi(services, {
    appVersion: () => '0.0.0-e2e',
    scanner: { service: () => current, pickFolder: async () => pickedFolder },
    licenseApi: licensing ? fakeLicenseApi() : undefined,
    exchange: {
      bundle: () => createBackupBundle(db, path.dirname(file), (copy) => {
        const d = new Database(copy);
        try { sanitizeForExchange(d); } finally { d.close(); }
      }),
      office: () => officeProfile,
      // zoals saveOffice in src/main/main.ts: `newKey` = bewust een nieuwe kantoorsleutel
      saveOffice({ office, email, newKey, keys }) {
        officeProfile = { office, email, ...(keys ?? (newKey ? null : officeProfile) ?? generateOfficeKeys()) };
        officeProfile.office = office;
        officeProfile.email = email;
        return officeProfile;
      },
      // zoals openClientExport in src/main/main.ts
      async openClientExport(data) {
        if (!officeProfile) throw new Error('Vul eerst de naam van je kantoor in (Instellingen > Administraties)');
        const opened = ExchangeService.openExport(officeProfile, data, '0.0.0-e2e');
        const result = { company: opened.meta.company, exchange: opened.header.uitwisseling, endDate: opened.header.einddatum };
        const admins = new Administrations(dir);
        const existing = admins.list(readAdministrationFile).find((a) => a.id === opened.header.administratie && a.officeCopy?.exchange === opened.header.uitwisseling);
        if (existing) {
          openAdmin(existing.key);
          return result;
        }
        const key = admins.create(`${opened.meta.company} uitwisseling ${opened.header.uitwisseling}`);
        extractBundle(opened.bundle, admins.dirFor(key));
        const copyDb = openDatabase(path.join(admins.dirFor(key), 'boekhouding.sqlite'));
        const copyFile = path.join(admins.dirFor(key), 'boekhouding.sqlite');
        const copy = createServices(copyDb, { pdf: async () => Buffer.from(''), mailerFactory: async () => { throw new Error('geen mail'); }, secrets: secretsFor(copyFile), fetch: async () => { throw new Error('geen netwerk'); }, storeFile });
        copy.exchange.initCopy(opened.header, opened.meta, officeProfile.office);
        copyDb.close();
        openAdmin(key);
        return result;
      },
    },
    // zoals de app: `dir` is de gegevensmap, extra administraties in administraties/<sleutel>/
    administrations: {
      list: () => new Administrations(dir).list(readAdministrationFile),
      async open(key) {
        openAdmin(key);
      },
      async create(name) {
        const admins = new Administrations(dir);
        const key = admins.create(name);
        const fresh = openDatabase(path.join(admins.dirFor(key), 'boekhouding.sqlite'));
        const settings = new SettingsService(fresh);
        settings.update({ company: { ...settings.get().company, name } });
        fresh.close();
        openAdmin(key);
        return key;
      },
    },
    // afschriften uit de downloadmap: echt in een (tijdelijke) map kijken; "Andere map kiezen" kiest een tweede map
    statementFolder: {
      defaultPath: () => downloadsDir(),
      async choose() {
        const other = path.join(dir, 'Andere map');
        fs.mkdirSync(other, { recursive: true });
        return other;
      },
      reconfigure() {},
    },
    dataFolder: {
      info: () => ({ dir, standard: folders.custom ? sharedDataDir(folders.home) : dir, isStandard: !folders.custom }),
      async choose() { return folders.pick ? (folders.plan = planFolder(folders.pick)) : null; },
      chooseStandard: () => (folders.plan = planFolder(sharedDataDir(folders.home), true)),
      // zoals de app: opnieuw beoordelen, het verzoek vastleggen; de herstart blijft hier achterwege
      async apply() {
        const plan = planFolder(folders.plan.dir, folders.plan.standard && folders.plan.action === 'kopieren');
        if (plan.problem) throw new Error(plan.problem);
        folders.applied = { target: plan.dir, action: plan.action };
      },
    },
    async checkForUpdates() { return 'Je hebt de nieuwste versie.'; },
    get windowsStore() { return store.on; },
    readOnly: () => store.readOnly,
    retryDataMove() { store.retried = true; },
    // echt wegschrijven: de tests lezen bv. een uitnodiging of export terug
    async saveFile(name, content) {
      const p = path.join(dir, 'bewaard', name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      return p;
    },
    storeAttachment: storeFile,
    readAttachment: (p) => fs.readFileSync(resolveAttachmentPath(path.dirname(file), p)),
    reconfigureLocalAi() {},
    // zoals de app: alleen een bijlage van de open administratie, en het bestand moet er staan
    async openPath(p) {
      const target = resolveAttachmentPath(path.dirname(file), p);
      if (!fs.existsSync(target)) throw new Error('Het bestand is niet gevonden');
      openedAttachments.push({ stored: p, content: fs.readFileSync(target).toString('base64') });
    },
    async openExternal() {},
    setSmtpPassword: (pw) => { smtpPassword = pw || null; },
    hasSmtpPassword: () => smtpPassword !== null,
    async testSmtp() { throw new Error('Geen mailserver in de test'); },
    async backupNow() { return path.join(dir, 'backup.sqlite'); },
    async restoreBackup(password) { restoreCalls.push(password ?? null); return false; },
    async exportEncrypted() { return path.join(dir, 'export.gbbackup'); },
    updates: {
      status: () => updateStatus,
      install: () => { updateInstalled = true; },
      reconfigure: () => { updateStatus = { ...updateStatus, state: updateStatus.state === 'klaar' ? 'klaar' : services.settings.get().autoUpdate ? 'wacht' : 'uit' }; },
    },
    // in de test "staat" alleen Claude Code op de computer (nep); gezocht wordt pas na de knop
    findCli: (kind) => (kind === 'claude-code' ? '/opt/claude/bin/claude' : null),
    programExists: (p) => p === '/opt/claude/bin/claude',
    pickProgram: async () => null,
    checkCli: async () => 'Claude Code werkt ✓',
    openLoginTerminal: async () => 'Claude Code is geopend in een terminal.',
    mcpCommand: () => ({ command: '/opt/BoekhoudenVoorNiks/boekhoudenvoorniks', args: ['--mcp'] }),
    localOcr: {
      status: () => ({ state: 'niet-geinstalleerd' }),
      install: () => { store.installs++; return { state: 'niet-geinstalleerd' }; },
      uninstall: async () => ({ state: 'niet-geinstalleerd' }),
      // zoals de app: alleen in de Store-versie is toestemming nodig
      get consent() { return store.on ? { runtimeVersion: 'b0000', given: () => store.consent, give: () => { store.consent = true; } } : undefined; },
    },
    async resetData(withDemo) {
      await current.stop();
      const backup = await wipeDatabase(db, file, path.join(dir, 'backups'));
      init(false);
      if (withDemo) seedDemo(services);
      return { backup };
    },
  });
}
resetFolders();
init(true);

/** Uint8Array/Buffer over JSON: { __bytes: base64 } */
const revive = (_k, v) => (v && typeof v === 'object' && typeof v.__bytes === 'string' ? new Uint8Array(Buffer.from(v.__bytes, 'base64')) : v);
const replace = (_k, v) => (v && v.type === 'Buffer' && Array.isArray(v.data) ? { __bytes: Buffer.from(v.data).toString('base64') } : v instanceof Uint8Array ? { __bytes: Buffer.from(v).toString('base64') } : v);

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm', '.mjs': 'text/javascript' };

http
  .createServer(async (req, res) => {
    if (req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/__reset') {
        // niet midden in een verzoek van de vorige test de database wisselen
        for (let i = 0; inflight > 0 && i < 100; i++) await new Promise((r) => setTimeout(r, 50));
        sent = [];
        updateStatus = { state: 'uit', version: null, notes: null, percent: null, error: null };
        updateInstalled = false;
        restoreCalls = [];
        store = noStore();
        openedAttachments = [];
        licensing = body && JSON.parse(body).licenses ? makeLicensing() : null;
        resetFolders();
        await scanner?.stop();
        lastPairing = null;
        pickedFolder = null;
        scannerPlatform = (body && JSON.parse(body).scannerPlatform) || 'linux';
        init(true);
        return res.end('{"ok":true}');
      }
      if (req.url === '/__sent') return res.end(JSON.stringify({ ok: sent }));
      if (req.url === '/__downloads') return res.end(JSON.stringify({ ok: downloadsDir() }));
      if (req.url === '/__restore') return res.end(JSON.stringify({ ok: restoreCalls }));
      if (req.url === '/__opened') return res.end(JSON.stringify({ ok: openedAttachments }));
      if (req.url === '/__pay') {
        const a = licensing?.accounts.get(licensing.lastStarted);
        if (a) a.paid = true;
        return res.end(JSON.stringify({ ok: licensing ? [...licensing.accounts.values()].map(({ managementKey: _k, ...rest }) => rest) : null }));
      }
      if (req.url === '/__store') {
        if (body) store = { ...store, ...JSON.parse(body) };
        return res.end(JSON.stringify({ ok: store }));
      }
      if (req.url === '/__datafolder') {
        const input = body ? JSON.parse(body) : {};
        if (input.custom !== undefined) folders.custom = !!input.custom;
        if (input.oldStandard) completeFolder(sharedDataDir(folders.home));
        if (input.pick !== undefined) {
          folders.pick = input.pick ? path.join(folders.root, input.pick.name) : null;
          if (input.pick?.kind === 'compleet') completeFolder(folders.pick);
          else if (input.pick) fs.mkdirSync(folders.pick, { recursive: true });
          if (input.pick?.kind === 'vol') fs.writeFileSync(path.join(folders.pick, 'vakantie.jpg'), 'foto');
        }
        return res.end(JSON.stringify({ ok: { applied: folders.applied, root: folders.root } }));
      }
      if (req.url === '/__scanner') {
        if (body && 'folder' in JSON.parse(body)) pickedFolder = JSON.parse(body).folder;
        return res.end(JSON.stringify({ ok: { payload: lastPairing } }));
      }
      if (req.url === '/__update') {
        if (body) updateStatus = { ...updateStatus, ...JSON.parse(body) };
        return res.end(JSON.stringify({ ok: { status: updateStatus, installed: updateInstalled } }));
      }
      const { method, args } = JSON.parse(body, revive);
      const [ns, fn] = String(method).split('.');
      const handler = Object.hasOwn(api, ns) && Object.hasOwn(api[ns], fn) ? api[ns][fn] : null;
      if (typeof handler !== 'function') return res.end(JSON.stringify({ error: `Onbekende functie: ${method}` }));
      inflight++;
      try {
        const r = await handler(...args);
        res.end(JSON.stringify({ ok: r === undefined ? null : r }, replace));
      } catch (e) {
        res.end(JSON.stringify({ error: e.message }));
      } finally {
        inflight--;
      }
      return;
    }
    const rel = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const p = path.join(ROOT, 'renderer', rel);
    if (!p.startsWith(path.join(ROOT, 'renderer')) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('content-type', TYPES[path.extname(p)] ?? 'application/octet-stream');
    res.end(fs.readFileSync(p));
  })
  .listen(PORT, () => console.log(`e2e-server op http://localhost:${PORT}`));

process.on('exit', () => {
  try { db?.close(); } catch { /* al dicht */ }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  if (folders) fs.rmSync(folders.root, { recursive: true, force: true });
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
