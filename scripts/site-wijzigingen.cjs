#!/usr/bin/env node
/**
 * "Wat is er nieuw" op de site (#436): site/wijzigingen.html wordt uit CHANGELOG.md gebouwd, zodat de site bij
 * elke release vanzelf bij is. Alleen het blok "Bekijk alle versies" (inhoudsopgave + artikelen) wordt vervangen;
 * de inleiding en de hoogtepunten erboven blijven met de hand geschreven. Daarnaast: `softwareVersion` in
 * index.html en de lastmod van / en wijzigingen.html in sitemap.xml.
 *
 * Draaien: `npm run site:wijzigingen`. Met `--check` schrijft het niets en faalt het als de site niet bij is
 * (CI). De Release-workflow draait het na elke release en commit het resultaat op main.
 *
 * CHANGELOG.md: `## x.y.z — titel`, daaronder optioneel inleidende alinea's, dan `### Nieuw` / `### Verbeterd` /
 * `### Opgelost` (of een ander kopje) met `- ` lijsten, één niveau genest met `  - `. "Nog niet uitgebracht"
 * wordt overgeslagen. De datum is die van de git-tag `vx.y.z`; is die er nog niet, dan de datum die al op de
 * site staat, en anders vandaag.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');
const PAGE = path.join(ROOT, 'site', 'wijzigingen.html');
const INDEX = path.join(ROOT, 'site', 'index.html');
const SITEMAP = path.join(ROOT, 'site', 'sitemap.xml');
const RELEASES = 'https://github.com/shipdocs/boekhoudenvoorniks/releases/tag/';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** vet, schuin, code en links binnen een regel (dezelfde subset als de handleiding) */
function inline(text) {
  let s = esc(text);
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => `<a href="${href}">${t}</a>`);
  return s;
}

/** De kleur van het kopje: zoals de site het al jaren doet. */
function tagClass(heading) {
  const h = heading.toLowerCase();
  if (/^nieuw/.test(h)) return 'new';
  if (/^verbeterd|^duidelijker/.test(h)) return 'improved';
  if (/^opgelost|^hersteld/.test(h)) return 'fixed';
  if (/fiscaal|belasting|btw/.test(h)) return 'tax';
  if (/beveiliging|veiligheid|security/.test(h)) return 'security';
  if (/^techniek/.test(h)) return 'tech';
  return '';
}

const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const dateNl = (iso) => `${Number(iso.slice(8, 10))} ${MAANDEN[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

function tagDate(version) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cs', `v${version}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

/** CHANGELOG.md → versies met inleiding en kopjes. */
function parseChangelog(md) {
  const versions = [];
  let v = null;
  let group = null;
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const h2 = line.match(/^## (\d+\.\d+\.\d+)(?: — (.+))?$/);
    if (h2) {
      v = { version: h2[1], title: h2[2] ?? '', intro: [], groups: [] };
      versions.push(v);
      group = null;
      continue;
    }
    if (/^## /.test(line)) { v = null; group = null; continue; } // "Nog niet uitgebracht" en andere koppen
    if (!v) continue;
    const h3 = line.match(/^### (.+)$/);
    if (h3) { group = { heading: h3[1], items: [] }; v.groups.push(group); continue; }
    const sub = line.match(/^  [-*] (.+)$/);
    if (sub && group && group.items.length) { group.items[group.items.length - 1].sub.push(sub[1]); continue; }
    const li = line.match(/^[-*] (.+)$/);
    if (li) {
      if (!group) { group = { heading: '', items: [] }; v.groups.push(group); }
      group.items.push({ text: li[1], sub: [] });
      continue;
    }
    if (line.startsWith('  ') && group && group.items.length) { // doorlopende regel van een lijstpunt
      const last = group.items[group.items.length - 1];
      if (last.sub.length) last.sub[last.sub.length - 1] += ' ' + line.trim();
      else last.text += ' ' + line.trim();
      continue;
    }
    if (line === '') continue;
    if (!group) v.intro.push(line);
  }
  return versions;
}

function article(v, date, latest) {
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const meta = `<p class="meta">${date ? `<time datetime="${date}">${dateNl(date)}</time> · ` : ''}<a href="${RELEASES}v${v.version}">Downloads en controlegetallen</a></p>`;
  const summary = v.title ? `\n        <p class="summary">${inline(cap(v.title.replace(/\.?$/, '.')))}</p>` : '';
  const intro = v.intro.map((p) => `      <p>${inline(p)}</p>`).join('\n');
  const groups = v.groups
    .map((g) => {
      const cls = tagClass(g.heading);
      const head = g.heading ? `      <h3><span class="tag${cls ? ` ${cls}` : ''}">${esc(g.heading)}</span></h3>\n` : '';
      const items = g.items.map((it) => `        <li>${inline(it.text)}${it.sub.length ? `\n          <ul>${it.sub.map((s) => `<li>${inline(s)}</li>`).join('')}</ul>\n        ` : ''}</li>`).join('\n');
      return `${head}      <ul>\n${items}\n      </ul>`;
    })
    .join('\n');
  return `    <article id="v${v.version}" class="release">
      <header>
        <h2>${v.version}${latest ? ' <span class="tag latest">Nieuwste versie</span>' : ''}</h2>
        ${meta}${summary}
      </header>
${intro ? intro + '\n' : ''}${groups}
    </article>`;
}

function build() {
  const versions = parseChangelog(fs.readFileSync(CHANGELOG, 'utf8'));
  if (!versions.length) throw new Error('geen versies gevonden in CHANGELOG.md');
  const page = fs.readFileSync(PAGE, 'utf8');
  const dates = new Map();
  for (const v of versions) {
    const onSite = page.match(new RegExp(`<article id="v${v.version.replace(/\./g, '\\.')}"[\\s\\S]*?<time datetime="(\\d{4}-\\d{2}-\\d{2})"`));
    dates.set(v.version, tagDate(v.version) ?? onSite?.[1] ?? new Date().toISOString().slice(0, 10));
  }
  const toc = versions.map((v) => `<a href="#v${v.version}">${v.version}</a>`).join('');
  const block = `<details class="release-history">
      <summary><strong>Bekijk alle versies en technische details</strong></summary>
    <nav class="toc" aria-label="Versies">
      ${toc}
    </nav>

${versions.map((v, i) => article(v, dates.get(v.version), i === 0)).join('\n\n')}
    </details>`;
  const re = /<details class="release-history">[\s\S]*?\n    <\/details>/;
  if (!re.test(page)) throw new Error('site/wijzigingen.html: blok <details class="release-history"> niet gevonden');
  const latest = versions[0];
  const out = {
    page: page.replace(re, () => block),
    index: fs.readFileSync(INDEX, 'utf8').replace(/"softwareVersion": "[^"]+"/, `"softwareVersion": "${latest.version}"`),
    sitemap: fs.readFileSync(SITEMAP, 'utf8').replace(
      /(<loc>https:\/\/boekhoudenvoorniks\.nl\/(?:wijzigingen\.html)?<\/loc>\s*<lastmod>)[0-9-]+/g,
      `$1${dates.get(latest.version)}`,
    ),
    latest: latest.version,
    date: dates.get(latest.version),
  };
  return out;
}

function main() {
  const check = process.argv.includes('--check');
  const out = build();
  const files = [[PAGE, out.page], [INDEX, out.index], [SITEMAP, out.sitemap]];
  const changed = files.filter(([file, content]) => fs.readFileSync(file, 'utf8') !== content);
  if (check) {
    if (changed.length) {
      console.error(`Niet bij met CHANGELOG.md: ${changed.map(([f]) => path.relative(ROOT, f)).join(', ')}. Draai: npm run site:wijzigingen`);
      process.exit(1);
    }
    console.log('site/wijzigingen.html is bij');
    return;
  }
  for (const [file, content] of changed) fs.writeFileSync(file, content);
  console.log(`${changed.length ? changed.map(([f]) => path.relative(ROOT, f)).join(', ') + ' bijgewerkt' : 'niets te doen'}: nieuwste versie ${out.latest} (${out.date})`);
}

module.exports = { parseChangelog, build };
if (require.main === module) main();
