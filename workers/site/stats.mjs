#!/usr/bin/env node
/**
 * Statistieken van de website uitlezen (Workers Analytics Engine, dataset boekhoudenvoorniks_site).
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node workers/site/stats.mjs [dagen]
 *   … node workers/site/stats.mjs --update    één regel voor de ShipDocs-updates (shipdocs-agent-update), voor elke week
 *
 * Het token heeft het recht "Account Analytics: Read" nodig. Robots worden apart gehouden.
 */
const update = process.argv.includes('--update');
const days = update ? 7 : Number(process.argv[2] ?? 30);
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token || !(days > 0)) {
  console.error('Zet CLOUDFLARE_ACCOUNT_ID en CLOUDFLARE_API_TOKEN (recht: Account Analytics Read).');
  process.exit(1);
}

async function sql(query) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: query });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()).data;
}
if (update) {
  const total = async (kind, from, to) => Number((await sql(`SELECT SUM(_sample_interval) AS n FROM boekhoudenvoorniks_site WHERE timestamp > NOW() - INTERVAL '${from}' DAY AND timestamp <= NOW() - INTERVAL '${to}' DAY AND blob5 = 'mens' AND blob1 = '${kind}'`))[0]?.n ?? 0);
  const [views, before, downloads, downloadsBefore] = [await total('pagina', 7, 0), await total('pagina', 14, 7), await total('download', 7, 0), await total('download', 14, 7)];
  const per = await sql(`SELECT blob2 AS soort, SUM(_sample_interval) AS n FROM boekhoudenvoorniks_site WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob5 = 'mens' AND blob1 = 'download' AND blob2 IN ('windows','appimage','deb') GROUP BY soort ORDER BY n DESC`);
  const top = await sql(`SELECT blob2 AS pagina, SUM(_sample_interval) AS n FROM boekhoudenvoorniks_site WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob5 = 'mens' AND blob1 = 'pagina' GROUP BY pagina ORDER BY n DESC LIMIT 1`);
  const src = await sql(`SELECT blob4 AS bron, SUM(_sample_interval) AS n FROM boekhoudenvoorniks_site WHERE timestamp > NOW() - INTERVAL '7' DAY AND blob5 = 'mens' AND blob1 = 'pagina' AND blob4 NOT IN ('', 'intern') GROUP BY bron ORDER BY n DESC LIMIT 1`);
  const verschil = (nu, vorig) => (vorig ? `${nu >= vorig ? '+' : '-'}${Math.abs(Math.round(((nu - vorig) / vorig) * 100))}% t.o.v. vorige week` : 'vorige week niets');
  const gedaan = [`Afgelopen 7 dagen ${views} paginabezoeken (${verschil(views, before)})`, `${downloads} downloads (${verschil(downloads, downloadsBefore)}${per.length ? `; ${per.map((r) => `${r.soort} ${r.n}`).join(', ')}` : ''})`, top[0] ? `meest bekeken ${top[0].pagina}` : null, src[0] ? `grootste bron ${src[0].bron} (${src[0].n})` : null].filter(Boolean).join('; ').replaceAll('|', '/');
  const { execFileSync } = await import('node:child_process');
  execFileSync('shipdocs-agent-update', ['post', 'BoekhoudenVoorNiks website', 'gereed', gedaan, '-', '-'], { stdio: 'inherit' });
  console.log(gedaan);
  process.exit(0);
}

const since = `timestamp > NOW() - INTERVAL '${Math.floor(days)}' DAY`;
const table = (title, rows, cols) => {
  console.log(`\n${title}`);
  if (!rows.length) return console.log('  (nog niets)');
  for (const r of rows) console.log('  ' + cols.map((c) => String(r[c]).padEnd(c === 'aantal' ? 6 : 28)).join(''));
};

const base = `FROM boekhoudenvoorniks_site WHERE ${since} AND blob5 = 'mens'`;
table(`Downloads per soort, laatste ${days} dagen`, await sql(`SELECT blob2 AS soort, SUM(_sample_interval) AS aantal ${base} AND blob1 = 'download' GROUP BY soort ORDER BY aantal DESC`), ['soort', 'aantal']);
table('Downloads per dag', await sql(`SELECT toStartOfInterval(timestamp, INTERVAL '1' DAY) AS dag, SUM(_sample_interval) AS aantal ${base} AND blob1 = 'download' GROUP BY dag ORDER BY dag DESC LIMIT 14`), ['dag', 'aantal']);
table('Meest bekeken pagina\'s', await sql(`SELECT blob2 AS pagina, SUM(_sample_interval) AS aantal ${base} AND blob1 = 'pagina' GROUP BY pagina ORDER BY aantal DESC LIMIT 15`), ['pagina', 'aantal']);
table('Waar bezoekers vandaan komen', await sql(`SELECT if(blob4 = '', '(direct of onbekend)', blob4) AS bron, SUM(_sample_interval) AS aantal ${base} AND blob1 = 'pagina' AND blob4 != 'intern' GROUP BY bron ORDER BY aantal DESC LIMIT 10`), ['bron', 'aantal']);
table('Landen', await sql(`SELECT if(blob3 = '', '?', blob3) AS land, SUM(_sample_interval) AS aantal ${base} AND blob1 = 'pagina' GROUP BY land ORDER BY aantal DESC LIMIT 8`), ['land', 'aantal']);
const bots = await sql(`SELECT SUM(_sample_interval) AS aantal FROM boekhoudenvoorniks_site WHERE ${since} AND blob5 = 'bot'`);
console.log(`\nRobots (niet meegeteld hierboven): ${bots[0]?.aantal ?? 0}`);
