/**
 * Testserver voor de end-to-end tests: dezelfde services en api als de app (uit dist/), maar via
 * HTTP in plaats van Electron-IPC. De renderer draait in een gewone browser; e2e/fixtures.ts zet
 * daar een window.bridge neer die naar deze server praat.
 *
 * POST /api            { method, args }  → { ok } of { error }
 * POST /__reset        lege administratie (nieuwe map), voor elke test
 * alles anders         bestanden uit dist/renderer
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'dist');
const { openDatabase } = require(path.join(ROOT, 'main/db/database.js'));
const { createServices, MemorySecretStore } = require(path.join(ROOT, 'main/services.js'));
const { createApi } = require(path.join(ROOT, 'main/main/api.js'));
const { wipeDatabase } = require(path.join(ROOT, 'main/main/reset.js'));
const { seedDemo } = require(path.join(ROOT, 'main/demo/demo.js'));

const PORT = Number(process.env.E2E_PORT || 5190);
let dir, file, db, services, api;
/** api-verzoeken die nog lopen: een reset wacht tot ze klaar zijn */
let inflight = 0;
/** wat de app "verstuurde" (e-mail) en "opsloeg" (bestanden), voor controles in de tests */
let sent = [];
/** nagebootste update-status (POST /__update), en of "Nu herstarten" is aangeklikt */
let updateStatus = { state: 'uit', version: null, notes: null, percent: null, error: null };
let updateInstalled = false;

async function storeFile(name, data) {
  const p = path.join(dir, 'bijlagen', `${Date.now()}-${name.replace(/[^\w.-]+/g, '_')}`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.from(data));
  return p;
}

function init(fresh) {
  if (fresh) {
    try { db?.close(); } catch { /* al dicht */ }
    // de vorige (tijdelijke) administratie opruimen
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-e2e-'));
    file = path.join(dir, 'boekhouding.sqlite');
  }
  db = openDatabase(file);
  services = createServices(db, {
    pdf: async (html) => Buffer.from(`%PDF-1.4 test ${html.length}`),
    mailerFactory: async () => ({ send: async (m) => { sent.push({ to: m.to, subject: m.subject }); return { messageId: `<e2e-${sent.length}@test>` }; } }),
    secrets: new MemorySecretStore(),
    fetch: async () => { throw new Error('geen netwerk in e2e-tests'); },
    storeFile,
  });
  let smtpPassword = null;
  api = createApi(services, {
    appVersion: () => '0.0.0-e2e',
    async checkForUpdates() { return 'Je hebt de nieuwste versie.'; },
    async saveFile(name) { return path.join(dir, name); },
    storeAttachment: storeFile,
    readAttachment: (p) => fs.readFileSync(p),
    reconfigureLocalAi() {},
    async openPath() {},
    async openExternal() {},
    setSmtpPassword: (pw) => { smtpPassword = pw || null; },
    hasSmtpPassword: () => smtpPassword !== null,
    async testSmtp() { throw new Error('Geen mailserver in de test'); },
    async backupNow() { return path.join(dir, 'backup.sqlite'); },
    async restoreBackup() { return false; },
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
    mcpCommand: () => ({ command: '/opt/Gratis Boekhouden/gratis-boekhouden', args: ['--mcp'] }),
    localOcr: { status: () => ({ state: 'niet-geinstalleerd' }), install: () => ({ state: 'niet-geinstalleerd' }), uninstall: async () => ({ state: 'niet-geinstalleerd' }) },
    async resetData(withDemo) {
      const backup = await wipeDatabase(db, file, path.join(dir, 'backups'));
      init(false);
      if (withDemo) seedDemo(services);
      return { backup };
    },
  });
}
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
        init(true);
        return res.end('{"ok":true}');
      }
      if (req.url === '/__sent') return res.end(JSON.stringify({ ok: sent }));
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
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
