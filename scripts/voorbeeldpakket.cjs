/**
 * Maakt het voorbeeldpakket voor boekhouders (site/voorbeeld/): de demo-administratie als
 * "Pakket voor je boekhouder", zodat een boekhouder het in zijn eigen pakket kan proberen
 * zonder de app te installeren. Verzonnen bedrijf en verzonnen bonnen.
 *
 *   npm run build:main && NODE_PATH=node_modules node scripts/voorbeeldpakket.cjs
 *
 * PDF's komen uit Chromium (Playwright), net als in de app uit Electron.
 */
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { chromium } = require('@playwright/test');

const ROOT = path.join(__dirname, '..', 'dist', 'main');
const { migrate } = require(path.join(ROOT, 'db/database.js'));
const { createServices, MemorySecretStore } = require(path.join(ROOT, 'services.js'));
const { seedDemo } = require(path.join(ROOT, 'demo/demo.js'));

const YEAR = Number(process.env.JAAR || 2025);
const OUT = path.join(__dirname, '..', 'site', 'voorbeeld');

(async () => {
  const browser = await chromium.launch();
  const pdf = async (html) => {
    const page = await browser.newPage();
    await page.setContent(html);
    const b = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    await page.close();
    return b;
  };
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  const s = createServices(db, { pdf, mailerFactory: async () => ({}), secrets: new MemorySecretStore(), fetch: async () => { throw new Error('offline'); }, storeFile: async (n) => n });
  seedDemo(s, `${YEAR}-12-15`);

  // verzonnen bonnen bij de aankopen, zodat de documentindex iets laat zien; één blijft bewust zonder bon
  const purchases = db.prepare('SELECT p.id, p.invoice_date, p.description, p.total, r.name FROM purchase_invoices p LEFT JOIN relations r ON r.id = p.relation_id ORDER BY p.id').all();
  const bonnen = new Map();
  for (const p of purchases.slice(0, -1)) {
    const key = `voorbeeld-bon-${p.id}.pdf`;
    bonnen.set(key, await pdf(`<body style="font:14px sans-serif;padding:40px"><h2>${p.name ?? 'Leverancier'}</h2><p>VOORBEELDBON — verzonnen, alleen om het pakket te tonen</p><p>${p.invoice_date}<br>${p.description}</p><p><strong>Totaal € ${(p.total / 100).toFixed(2).replace('.', ',')}</strong></p></body>`));
    db.prepare('UPDATE purchase_invoices SET attachment_path = ? WHERE id = ?').run(key, p.id);
  }

  // de aangiftes van het voorbeeldjaar zijn gedaan, zoals bij een afgesloten boekjaar
  for (const v of s.accountantPackage.preview(YEAR).vat) if (v.omzet || v.voorbelasting || v.teBetalen) s.vat.markSubmitted(v.periodKey, { alreadyFiled: true });

  const r = await s.accountantPackage.build(YEAR, { softwareVersion: require('../package.json').version, readAttachment: (p) => bonnen.get(p) ?? null });
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `voorbeeldpakket-boekhouder-${YEAR}.zip`);
  fs.writeFileSync(file, r.zip);
  console.log(`${file}: ${r.files.length} bestanden, ${(r.zip.length / 1024).toFixed(0)} kB`);
  for (const c of r.summary.checks) console.log(`${c.ok ? '✓' : '!'} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
