#!/usr/bin/env node
/**
 * Menu en voettekst van de website (site/*.html) op één plek.
 *
 * Elke pagina heeft dezelfde kop (<header class="top">) en voettekst (<footer class="wrap foot">).
 * Dit script schrijft ze opnieuw in elke pagina, met aria-current op de pagina zelf.
 * Nieuwe pagina of nieuw menupunt? Pas MENU of FOOTER hieronder aan en draai `npm run site:menu`.
 */
const fs = require('node:fs');
const path = require('node:path');

const SITE = path.join(__dirname, '..', 'site');
const DOWNLOAD = 'downloaden.html';
const GITHUB = 'https://github.com/shipdocs/boekhoudenvoorniks';

/** Het hoofdmenu: weinig punten, de doelgroep-pagina's samen onder "Voor wie". */
const MENU = [
  { href: './#functies', label: 'Functies' },
  { href: './#prijzen', label: 'Prijzen' },
  {
    label: 'Voor wie',
    items: [
      { href: 'starters.html', label: 'Starters', hint: 'Van KvK tot eerste btw-aangifte' },
      { href: 'stukadoors.html', label: 'Stukadoors' },
      { href: 'btw-stucwerk.html', label: 'Btw op stucwerk: 9% of 21%' },
      { href: 'schilders.html', label: 'Schilders' },
      { href: 'webdevelopers.html', label: 'Webdevelopers' },
      { href: 'boekhouders.html', label: 'Boekhouders', hint: 'Pakket en uitwisseling' },
    ],
  },
  { href: 'handleiding/index.html', label: 'Handleiding' },
  { href: 'waarom.html', label: 'Waarom' },
  { href: 'wijzigingen.html', label: 'Nieuw' },
];

/** De voettekst: alles wat niet in het menu hoeft, in drie kolommen. */
const FOOTER = [
  {
    title: 'Programma',
    items: [
      { href: 'werkadministratie.html', label: 'Werkadministratie, geen boekhoudpakket' },
      { href: './#functies', label: 'Functies' },
      { href: './#prijzen', label: 'Prijzen' },
      { href: './#overstappen', label: 'Overstappen' },
      { href: 'bank-automatisch.html', label: 'Bank automatisch inlezen' },
      { href: 'btw-aangifte.html', label: 'Btw-aangifte zelf doen' },
      { href: 'buitenlandse-facturen.html', label: 'Buitenlandse facturen verwerken' },
      { href: 'zonder-abonnement.html', label: 'Zonder abonnement' },
      { href: 'offline-boekhoudprogramma.html', label: 'Offline boekhoudprogramma' },
      { href: 'gratis-boekhoudprogramma-downloaden.html', label: 'Gratis boekhoudprogramma downloaden' },
      { href: 'handleiding/index.html', label: 'Handleiding' },
      { href: './#vragen', label: 'Veelgestelde vragen' },
      { href: 'wijzigingen.html', label: 'Wat is er nieuw' },
    ],
  },
  {
    title: 'Voor wie',
    items: [
      { href: 'starters.html', label: 'Starters' },
      { href: 'stukadoors.html', label: 'Stukadoors' },
      { href: 'schilders.html', label: 'Schilders' },
      { href: 'webdevelopers.html', label: 'Webdevelopers' },
      { href: 'boekhouders.html', label: 'Boekhouders' },
    ],
  },
  {
    title: 'Over',
    items: [
      { href: 'waarom.html', label: 'Waarom we dit maakten' },
      { href: 'kwaliteit.html', label: 'Hoe wij de software controleren' },
      { href: DOWNLOAD, label: 'Downloaden' },
      { href: GITHUB, label: 'Broncode (AGPL-3.0-or-later)' },
      { href: 'mailto:info@shipdocs.app?subject=Vraag%20over%20BoekhoudenVoorNiks', label: 'Vragen en feedback: mail ons' },
      { href: 'voorwaarden.html', label: 'Voorwaarden' },
      { href: 'privacy.html', label: 'Privacy' },
    ],
  },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Een pad vanaf de siteroot, gezien vanaf een pagina in `base` ('' voor de root, '../' voor een submap). */
const rel = (href, base) => (/^(https?:|mailto:|tel:)/.test(href) ? href : href === './' ? (base || './') : base + href);

function link(item, page, base = '', extra = '') {
  const current = item.href === page || (page.startsWith('handleiding/') && item.href === 'handleiding/index.html') ? ' aria-current="page"' : '';
  const hint = item.hint ? `<span class="hint">${esc(item.hint)}</span>` : '';
  return `<a href="${rel(item.href, base)}"${current}${extra}>${esc(item.label)}${hint}</a>`;
}

function header(page, base = '') {
  const lines = [];
  for (const item of MENU) {
    if (!item.items) {
      lines.push(`        ${link(item, page, base)}`);
      continue;
    }
    const inGroup = item.items.some((i) => i.href === page);
    lines.push(`        <details class="sub"${inGroup ? ' data-current' : ''}>`);
    lines.push(`          <summary>${esc(item.label)}</summary>`);
    lines.push('          <div class="panel">');
    for (const sub of item.items) lines.push(`            ${link(sub, page, base)}`);
    lines.push('          </div>');
    lines.push('        </details>');
  }
  return `<!-- Menu en voettekst staan in scripts/site-menu.cjs; bijwerken met: npm run site:menu -->
  <header class="top">
    <div class="wrap nav">
      <a class="brand" href="${base || './'}"><picture><source srcset="${base}img/logo-compact-wit.svg" media="(prefers-color-scheme: dark)"><img src="${base}img/logo-compact-website-blauw.svg" alt="BoekhoudenVoorNiks" width="258" height="54"></picture></a>
      <button class="menu-button" type="button" aria-expanded="false" aria-controls="menu" aria-label="Menu"><span></span><span></span><span></span></button>
      <nav id="menu" class="menu" aria-label="Hoofdmenu">
${lines.join('\n')}
        <a class="btn small" href="${base}${DOWNLOAD}">Downloaden</a>
      </nav>
    </div>
  </header>
  <script src="${base}menu.js" defer></script>`;
}

function footer(page, base = '') {
  const cols = FOOTER.map((col) => {
    const items = col.items.map((i) => `          <li>${link(i, page, base)}</li>`).join('\n');
    return `      <div>\n        <h2>${esc(col.title)}</h2>\n        <ul>\n${items}\n        </ul>\n      </div>`;
  }).join('\n');
  return `<footer class="wrap foot">
    <div class="foot-links">
${cols}
    </div>
    <p class="foot-legal">BoekhoudenVoorNiks is een product van <strong><a href="https://shipdocs.app/">ShipDocs</a></strong> · Middelweg 211, 1911 EE Uitgeest · KvK 95207341 · btw NL005138041B29 · <a href="mailto:info@shipdocs.app">info@shipdocs.app</a> · <a href="tel:+31203695765">+31 20 369 5765</a> · <button type="button" class="linkish" data-cookie-settings>Cookie-voorkeuren</button></p>
    <div id="privacy-choice" role="dialog" aria-label="Meten van advertenties">
      <p><strong>Mogen we meten of onze advertentie werkt?</strong> Met je toestemming laden we de Meta Pixel (Facebook en Instagram). Meta plaatst dan cookies en ziet dat je deze site bezocht. Zonder toestemming gaat er niets naar Meta. <a href="${base}privacy.html#website">Meer uitleg</a></p>
      <div class="row"><button type="button" class="btn small" data-choice="ja">Toestaan</button><button type="button" class="btn small ghost" data-choice="nee">Niet toestaan</button></div>
    </div>
    <script src="${base}meta-pixel.js" defer></script>
  </footer>`;
}

const HEADER_RE = /(?:[ \t]*<!-- Menu en voettekst[^\n]*-->\n)?[ \t]*<header class="top">[\s\S]*?<\/header>(?:\n[ \t]*<script src="menu\.js" defer><\/script>)?(?:\n[ \t]*<script>\n[ \t]*\(function \(\) \{\n[ \t]*var top = document\.querySelector\('\.top'\)[\s\S]*?<\/script>)?/;
const FOOTER_RE = /[ \t]*<footer class="wrap foot">[\s\S]*?<\/footer>/;

function main() {
  let changed = 0;
  // de root en de handleiding (submap, dus links met ../)
  const dirs = [{ dir: SITE, base: '', prefix: '' }, { dir: path.join(SITE, 'handleiding'), base: '../', prefix: 'handleiding/' }];
  for (const { dir, base, prefix } of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort()) {
      const page = !prefix && file === 'index.html' ? './' : prefix + file;
      const before = fs.readFileSync(path.join(dir, file), 'utf8');
      if (!HEADER_RE.test(before) || !FOOTER_RE.test(before)) {
        console.error(`${prefix}${file}: geen <header class="top"> of <footer class="wrap foot"> gevonden, overgeslagen`);
        continue;
      }
      const after = before
        .replace(HEADER_RE, () => `  ${header(page, base)}`)
        .replace(FOOTER_RE, () => `  ${footer(page, base)}`);
      if (after !== before) {
        fs.writeFileSync(path.join(dir, file), after);
        changed++;
        console.log(`${prefix}${file}: bijgewerkt`);
      }
    }
  }
  console.log(`${changed} pagina('s) bijgewerkt`);
}

module.exports = { header, footer };
if (require.main === module) main();
