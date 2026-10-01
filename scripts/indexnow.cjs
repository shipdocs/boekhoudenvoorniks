// Meldt alle URL's uit site/sitemap.xml bij IndexNow (Bing, Yandex e.a.).
// De sleutel staat als site/<sleutel>.txt op de site zelf; de bestandsnaam is de sleutel.
// Gebruik: node scripts/indexnow.cjs   (alleen na een deploy; faalt zacht)
const fs = require('fs');
const path = require('path');

const host = 'boekhoudenvoorniks.nl';
const siteDir = path.join(__dirname, '..', 'site');
const keyFile = fs.readdirSync(siteDir).find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
if (!keyFile) {
  console.error('Geen IndexNow-sleutelbestand gevonden in site/.');
  process.exit(1);
}
const key = keyFile.replace('.txt', '');
const sitemap = fs.readFileSync(path.join(siteDir, 'sitemap.xml'), 'utf8');
const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

(async () => {
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host, key, keyLocation: `https://${host}/${keyFile}`, urlList }),
  });
  console.log(`IndexNow: ${urlList.length} URL's gemeld, status ${res.status}`);
  if (res.status >= 400) process.exit(1);
})().catch((e) => {
  console.error('IndexNow mislukt:', e.message);
  process.exit(1);
});
