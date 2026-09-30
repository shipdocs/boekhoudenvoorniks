/**
 * Maakt site/voorwaarden.pdf van site/voorwaarden.html (artikel 8.3: de voorwaarden kunnen bewaren).
 * Draai na elke wijziging van de voorwaarden: `npm run voorwaarden:pdf`. Eigen Chromium: PW_CHROMIUM=/pad.
 */
const path = require('node:path');
const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const page = await browser.newPage();
  await page.goto(`file://${path.join(__dirname, '..', 'site', 'voorwaarden.html')}`, { waitUntil: 'networkidle' });
  await page.emulateMedia({ media: 'print', colorScheme: 'light' });
  const out = path.join(__dirname, '..', 'site', 'voorwaarden.pdf');
  await page.pdf({ path: out, format: 'A4', margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' }, printBackground: false });
  await browser.close();
  console.log(`Geschreven: ${out}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
