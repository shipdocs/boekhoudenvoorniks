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
/** wat de app "verstuurde" (e-mail) en "opsloeg" (bestanden), voor controles in de tests */
let sent = [];

async function storeFile(name, data) {
  const p = path.join(dir, 'bijlagen', `${Date.now()}-${name.replace(/[^\w.-]+/g, '_')}`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.from(data));
  return p;
}

function init(fresh) {
  if (fresh) {
    try { db?.close(); } catch { /* al dicht */ }
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
        sent = [];
        init(true);
        return res.end('{"ok":true}');
      }
      if (req.url === '/__sent') return res.end(JSON.stringify({ ok: sent }));
      const { method, args } = JSON.parse(body, revive);
      const [ns, fn] = String(method).split('.');
      const handler = Object.hasOwn(api, ns) && Object.hasOwn(api[ns], fn) ? api[ns][fn] : null;
      if (typeof handler !== 'function') return res.end(JSON.stringify({ error: `Onbekende functie: ${method}` }));
      try {
        const r = await handler(...args);
        res.end(JSON.stringify({ ok: r === undefined ? null : r }, replace));
      } catch (e) {
        res.end(JSON.stringify({ error: e.message }));
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
