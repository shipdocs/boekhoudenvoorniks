#!/usr/bin/env node
/**
 * De online handleiding (#420): docs/handleiding/*.md → site/handleiding/*.html, plus een indexpagina met
 * zoekveld en handleiding/zoek.json voor het zoeken. Draaien met `npm run site:handleiding` (dat zet daarna
 * ook het menu en de voettekst goed). De gegenereerde HTML wordt meegecommit: de site-deploy bouwt niets.
 *
 * Elk Markdown-bestand begint met een kop tussen `---`:
 *   titel: Bank: afschriften inlezen      (verplicht)
 *   omschrijving: één zin voor de index   (verplicht)
 *   hoofdstuk: Dagelijks werk             (verplicht; zie HOOFDSTUKKEN)
 *   volgorde: 20                          (binnen het hoofdstuk)
 *   boekhouder: ja                        (alleen voor het hoofdstuk "Voor de boekhouder": vaste waarschuwingsbalk)
 *
 * Ondersteunde Markdown: ## en ### koppen (krijgen een id), alinea's, - en 1. lijsten (één niveau genest),
 * > citaat (wordt een "let op"-kader), **vet**, *schuin*, `code`, [tekst](link), ---.
 */
const fs = require('node:fs');
const path = require('node:path');
const { header, footer } = require('./site-menu.cjs');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'docs', 'handleiding');
const OUT = path.join(ROOT, 'site', 'handleiding');
const SITE_URL = 'https://boekhoudenvoorniks.nl/handleiding/';

/** De hoofdstukken, in deze volgorde op de index. Het laatste staat apart, met de waarschuwing. */
const HOOFDSTUKKEN = ['Beginnen', 'Dagelijks werk', 'Belasting en boekhouder', 'Problemen oplossen', 'Voor de boekhouder'];

const WAARSCHUWING =
  '<strong>Dit is de boekhoudermodus.</strong> Niet nodig en niet aan te raden voor gewone gebruikers: je werkt hier rechtstreeks in je boekhouding en kunt iets kapotmaken dat de app anders voor je bewaakt. Op een administratie waarin in deze modus is gewerkt, geven we geen ondersteuning. Twijfel je? Vraag je boekhouder.';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[àáâä]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i').replace(/[òóôö]/g, 'o').replace(/[ùúûü]/g, 'u')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Vet, schuin, code en links binnen een regel. */
function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => `<a href="${href}">${t}</a>`);
  return s;
}

function frontMatter(md, file) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`${file}: geen kop tussen --- gevonden`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const key of ['titel', 'omschrijving', 'hoofdstuk']) if (!meta[key]) throw new Error(`${file}: "${key}" ontbreekt in de kop`);
  if (!HOOFDSTUKKEN.includes(meta.hoofdstuk)) throw new Error(`${file}: onbekend hoofdstuk "${meta.hoofdstuk}"`);
  return { meta, body: md.slice(m[0].length) };
}

/** Markdown → HTML, met de koppen (voor de inhoudsopgave en het zoeken) en de platte tekst per kop. */
function render(body) {
  const lines = body.split('\n');
  const out = [];
  const koppen = [];
  const ids = new Set();
  let section = { id: '', tekst: '', inhoud: [] };
  const sections = [section];
  let para = [];
  let list = null; // { tag, items: [{ html, sub: [] }] }
  let quote = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      section.inhoud.push(para.join(' '));
      para = [];
    }
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it) => `<li>${it.html}${it.sub.length ? `<ul>${it.sub.map((x) => `<li>${x}</li>`).join('')}</ul>` : ''}</li>`).join('\n');
    out.push(`<${list.tag}>\n${items}\n</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<aside class="let-op"><p>${inline(quote.join(' '))}</p></aside>`);
      section.inhoud.push(quote.join(' '));
      quote = [];
    }
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const h = line.match(/^(##|###) (.+)$/);
    if (h) {
      flushAll();
      let id = slug(h[2]);
      while (ids.has(id)) id += '-2';
      ids.add(id);
      const level = h[1].length;
      out.push(`<h${level} id="${id}">${inline(h[2])}</h${level}>`);
      koppen.push({ id, tekst: h[2], level });
      section = { id, tekst: h[2], inhoud: [] };
      sections.push(section);
      continue;
    }
    if (line === '---') { flushAll(); out.push('<hr>'); continue; }
    if (line === '') { flushPara(); flushQuote(); if (list && !list.open) flushList(); continue; }
    const q = line.match(/^> ?(.*)$/);
    if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
    const sub = line.match(/^  [-*] (.+)$/);
    if (sub && list) { list.items[list.items.length - 1].sub.push(inline(sub[1])); section.inhoud.push(sub[1]); continue; }
    const li = line.match(/^([-*]|\d+\.) (.+)$/);
    if (li) {
      flushPara(); flushQuote();
      const tag = li[1] === '-' || li[1] === '*' ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [], open: true }; }
      list.items.push({ html: inline(li[2]), sub: [] });
      section.inhoud.push(li[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1].html += ' ' + inline(line.trim()); continue; }
    if (list) flushList();
    para.push(line);
  }
  flushAll();
  return { html: out.join('\n'), koppen, sections: sections.filter((s) => s.inhoud.length) };
}

function page(doc, all) {
  const { meta, html, koppen, file } = doc;
  const url = `${SITE_URL}${file}`;
  const toc = koppen.filter((k) => k.level === 2);
  const inHoofdstuk = all.filter((d) => d.meta.hoofdstuk === meta.hoofdstuk);
  const i = inHoofdstuk.indexOf(doc);
  const vorige = inHoofdstuk[i - 1];
  const volgende = inHoofdstuk[i + 1];
  const boekhouder = meta.hoofdstuk === 'Voor de boekhouder';
  return `<!doctype html>
<html lang="nl-NL">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(meta.titel)} | Handleiding BoekhoudenVoorNiks</title>
  <meta name="description" content="${esc(meta.omschrijving)}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="article">
  <meta property="og:locale" content="nl_NL">
  <meta property="og:site_name" content="BoekhoudenVoorNiks">
  <meta property="og:url" content="${url}">
  <meta property="og:title" content="${esc(meta.titel)}">
  <meta property="og:description" content="${esc(meta.omschrijving)}">
  <link rel="icon" href="../favicon.svg" type="image/svg+xml">
  <link rel="icon" href="../favicon.ico" sizes="any">
  <link rel="apple-touch-icon" href="../apple-touch-icon.png">
  <link rel="stylesheet" href="../styles.css">
  <script type="application/ld+json">
${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'TechArticle',
  headline: meta.titel,
  description: meta.omschrijving,
  inLanguage: 'nl-NL',
  isPartOf: { '@type': 'WebSite', name: 'BoekhoudenVoorNiks', url: 'https://boekhoudenvoorniks.nl/' },
  publisher: { '@type': 'Organization', name: 'ShipDocs', url: 'https://shipdocs.app/' },
  url,
}, null, 2)}
  </script>
</head>
<body>
  ${header(`handleiding/${file}`, '../')}

  <main class="wrap notes handleiding">
    <p class="kruimels"><a href="index.html">Handleiding</a> › ${esc(meta.hoofdstuk)}</p>
    <h1>${esc(meta.titel)}</h1>
    ${boekhouder ? `<div class="boekhouder-waarschuwing" role="note">${WAARSCHUWING}</div>` : ''}
    <p class="lead">${inline(meta.omschrijving)}</p>
${toc.length > 1 ? `    <nav class="inhoud" aria-label="Op deze pagina"><strong>Op deze pagina</strong><ul>${toc.map((k) => `<li><a href="#${k.id}">${inline(k.tekst)}</a></li>`).join('')}</ul></nav>` : ''}
${html}
    <nav class="volgende" aria-label="Verder lezen">
      <span>${vorige ? `← <a href="${vorige.file}">${esc(vorige.meta.titel)}</a>` : `← <a href="index.html">Alle onderwerpen</a>`}</span>
      <span>${volgende ? `<a href="${volgende.file}">${esc(volgende.meta.titel)}</a> →` : `<a href="index.html">Alle onderwerpen</a> →`}</span>
    </nav>
    <p class="fine">Staat je vraag er niet bij? <a href="../#vragen">Veelgestelde vragen</a> · <a href="mailto:info@shipdocs.app?subject=Vraag%20over%20de%20handleiding">Mail ons</a> · Zie je een fout in deze pagina? <a href="https://github.com/shipdocs/boekhoudenvoorniks/edit/main/docs/handleiding/${file.replace(/\\.html$/, '.md')}">Verbeter hem op GitHub</a>.</p>
  </main>

  ${footer(`handleiding/${file}`, '../')}
</body>
</html>
`;
}

/** Het zoekscript als los bestand: de CSP van de site (script-src 'self') staat geen inline script toe. */
const ZOEK_JS = `// Zoeken in de handleiding (gebouwd door scripts/site-handleiding.cjs; niet met de hand aanpassen).
  (function () {
    var input = document.getElementById('zoek');
    var treffers = document.getElementById('treffers');
    var lijst = treffers.querySelector('ul');
    var geen = document.getElementById('geen-treffers');
    var hoofdstukken = document.getElementById('hoofdstukken');
    var data = null;
    function laad() {
      if (data) return Promise.resolve(data);
      return fetch('zoek.json').then(function (r) { return r.json(); }).then(function (d) { data = d; return d; }).catch(function () { return []; });
    }
    function toon(q) {
      q = q.trim().toLowerCase();
      if (q.length < 2) { treffers.hidden = true; hoofdstukken.hidden = false; return; }
      laad().then(function (d) {
        var woorden = q.split(/\\s+/);
        var hits = [];
        d.forEach(function (p) {
          p.secties.forEach(function (s) {
            var tekst = (p.titel + ' ' + s.kop + ' ' + s.tekst).toLowerCase();
            if (woorden.every(function (w) { return tekst.indexOf(w) !== -1; })) {
              var i = s.tekst.toLowerCase().indexOf(woorden[0]);
              var frag = i >= 0 ? s.tekst.slice(Math.max(0, i - 60), i + 120) : s.tekst.slice(0, 160);
              hits.push({ url: p.url + (s.id ? '#' + s.id : ''), titel: p.titel, kop: s.kop, frag: (i > 60 ? '… ' : '') + frag + (s.tekst.length > i + 120 ? ' …' : '') });
            }
          });
        });
        // eerst de pagina's waarvan de titel of de kop de zoekwoorden bevat, dan de rest in leesvolgorde
        hits.forEach(function (h, i) { var titel = h.titel.toLowerCase(), kop = h.kop.toLowerCase(); h.score = woorden.reduce(function (n, w) { return n + (titel.indexOf(w) !== -1 ? 2 : 0) + (kop.indexOf(w) !== -1 ? 1 : 0); }, 0); h.i = i; });
        hits.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
        lijst.innerHTML = '';
        hits.slice(0, 20).forEach(function (h) {
          var li = document.createElement('li');
          var a = document.createElement('a'); a.href = h.url; a.textContent = h.titel + (h.kop ? ' › ' + h.kop : '');
          var small = document.createElement('small'); small.textContent = h.frag;
          li.appendChild(a); li.appendChild(small); lijst.appendChild(li);
        });
        geen.hidden = hits.length > 0;
        treffers.hidden = false;
        hoofdstukken.hidden = true;
      });
    }
    input.addEventListener('input', function () { toon(input.value); });
    if (location.hash.length > 1) { input.value = decodeURIComponent(location.hash.slice(1)).replace(/\\+/g, ' '); toon(input.value); }
  })();
`;

function indexPage(docs) {
  const groups = HOOFDSTUKKEN.map((h) => ({ h, docs: docs.filter((d) => d.meta.hoofdstuk === h) })).filter((g) => g.docs.length);
  const lijst = groups
    .map(
      (g) => `    <section class="hoofdstuk${g.h === 'Voor de boekhouder' ? ' boekhouder' : ''}" data-hoofdstuk="${esc(g.h)}">
      <h2>${esc(g.h)}</h2>
${g.h === 'Voor de boekhouder' ? `      <div class="boekhouder-waarschuwing" role="note">${WAARSCHUWING}</div>\n` : ''}      <ul class="paginas">
${g.docs.map((d) => `        <li data-tekst="${esc(`${d.meta.titel} ${d.meta.omschrijving} ${d.koppen.map((k) => k.tekst).join(' ')}`.toLowerCase())}"><a href="${d.file}">${esc(d.meta.titel)}</a><p>${inline(d.meta.omschrijving)}</p></li>`).join('\n')}
      </ul>
    </section>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="nl-NL">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Handleiding | BoekhoudenVoorNiks</title>
  <meta name="description" content="Zo werk je met BoekhoudenVoorNiks: beginnen, facturen en offertes, bonnetjes, bank, klussen, btw-aangifte, je boekhouder en wat je doet als iets niet klopt.">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <link rel="canonical" href="${SITE_URL}index.html">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="nl_NL">
  <meta property="og:site_name" content="BoekhoudenVoorNiks">
  <meta property="og:url" content="${SITE_URL}index.html">
  <meta property="og:title" content="Handleiding BoekhoudenVoorNiks">
  <meta property="og:description" content="Zo werk je met BoekhoudenVoorNiks, stap voor stap en in gewone taal.">
  <link rel="icon" href="../favicon.svg" type="image/svg+xml">
  <link rel="icon" href="../favicon.ico" sizes="any">
  <link rel="apple-touch-icon" href="../apple-touch-icon.png">
  <link rel="stylesheet" href="../styles.css">
</head>
<body>
  ${header('handleiding/index.html', '../')}

  <main class="wrap notes handleiding handleiding-index">
    <h1>Handleiding</h1>
    <p class="lead">Zo werk je met BoekhoudenVoorNiks, in de woorden van de app zelf: wat je ziet, wat je klikt en wat er dan gebeurt. Geen boekhoudtermen, behalve in het laatste hoofdstuk, dat voor je boekhouder is.</p>
    <label for="zoek" class="small">Zoek in de handleiding</label>
    <input id="zoek" class="zoek" type="search" placeholder="Bijvoorbeeld: afschrift weghalen, btw-aangifte, bon van mijn telefoon" autocomplete="off">
    <div id="treffers" hidden><h2>Gevonden</h2><ul class="treffers paginas"></ul><p class="fine" id="geen-treffers" hidden>Niets gevonden. Probeer een ander woord, of kijk bij <a href="problemen-oplossen.html">Problemen oplossen</a>.</p></div>
    <div id="hoofdstukken">
${lijst}
    </div>
    <p class="fine">De handleiding hoort bij versie ${esc(require(path.join(ROOT, 'package.json')).version)}. Mis je iets? <a href="mailto:info@shipdocs.app?subject=Handleiding">Mail ons</a>.</p>
  </main>

  ${footer('handleiding/index.html', '../')}
  <script src="zoek.js" defer></script>
</body>
</html>
`;
}

function main() {
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.md')).sort();
  const docs = files.map((f) => {
    const md = fs.readFileSync(path.join(SRC, f), 'utf8');
    const { meta, body } = frontMatter(md, f);
    const { html, koppen, sections } = render(body);
    return { file: f.replace(/\.md$/, '.html'), meta, html, koppen, sections };
  });
  docs.sort((a, b) => HOOFDSTUKKEN.indexOf(a.meta.hoofdstuk) - HOOFDSTUKKEN.indexOf(b.meta.hoofdstuk) || Number(a.meta.volgorde ?? 99) - Number(b.meta.volgorde ?? 99) || a.meta.titel.localeCompare(b.meta.titel));
  fs.mkdirSync(OUT, { recursive: true });
  // oude pagina's weg: een hernoemd onderwerp mag niet dubbel blijven staan
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.html') && f !== 'index.html' && !docs.some((d) => d.file === f)) fs.unlinkSync(path.join(OUT, f));
  for (const d of docs) fs.writeFileSync(path.join(OUT, d.file), page(d, docs));
  fs.writeFileSync(path.join(OUT, 'index.html'), indexPage(docs));
  const zoek = docs.map((d) => ({
    url: d.file,
    titel: d.meta.titel,
    hoofdstuk: d.meta.hoofdstuk,
    secties: d.sections.map((s) => ({ id: s.id, kop: s.tekst, tekst: s.inhoud.join(' ').replace(/[*`]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') })),
  }));
  fs.writeFileSync(path.join(OUT, 'zoek.json'), JSON.stringify(zoek));
  fs.writeFileSync(path.join(OUT, 'zoek.js'), ZOEK_JS);
  console.log(`${docs.length} pagina's + index geschreven naar site/handleiding`);
  return docs;
}

module.exports = { main, render, frontMatter };
if (require.main === module) main();
