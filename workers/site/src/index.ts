/** De website: bestanden uit site/; http en www.boekhoudenvoorniks.nl gaan naar https://boekhoudenvoorniks.nl. */
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** Workers Analytics Engine; ontbreekt het (bij tests of lokaal), dan wordt er niets geteld. */
  STATS?: { writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void };
}

/**
 * Anonieme tellers voor paginabezoeken en downloads, zonder cookies en zonder IP-adres: alleen wat voor
 * de statistieken nodig is (soort, pagina of bestand, land, de site waarvandaan iemand kwam, en of het een
 * robot lijkt). Er wordt niets bewaard waarmee je een bezoeker kunt herkennen.
 */
const BOT = /bot|crawl|spider|slurp|preview|fetch|monitor|curl|wget|python|go-http|headless|lighthouse|uptime/i;

export function countPoint(kind: 'pagina' | 'download', name: string, request: Request): { indexes: string[]; blobs: string[]; doubles: number[] } {
  let referrer = '';
  try {
    const host = new URL(request.headers.get('referer') ?? '').hostname.replace(/^www\./, '');
    referrer = host === 'boekhoudenvoorniks.nl' ? 'intern' : host;
  } catch {
    // geen of ongeldige verwijzer
  }
  const country = (request as Request & { cf?: { country?: string } }).cf?.country ?? request.headers.get('cf-ipcountry') ?? '';
  const bot = BOT.test(request.headers.get('user-agent') ?? '') ? 'bot' : 'mens';
  return { indexes: [kind], blobs: [kind, name, country, referrer, bot], doubles: [1] };
}

/**
 * Vaste downloadadressen: /download/windows en /download/appimage verwijzen naar het bestand van de nieuwste
 * release, ook als de naam het versienummer bevat. Zo hoeft er op de website niets te veranderen bij een
 * nieuwe versie en komt niemand op een GitHub-pagina terecht.
 *
 * Het versienummer komt uit `latest.yml` van de nieuwste release (die ook de updater in de app gebruikt). Dat is
 * een gewoon bestand op github.com en geen aanroep van de GitHub-API: die staat maar 60 verzoeken per uur per
 * adres toe en Workers delen adressen, dus daar liep het op vast. De bestandsnamen volgen uit het versienummer.
 */
const RELEASES_PAGE = 'https://github.com/shipdocs/boekhoudenvoorniks/releases/latest';
const LATEST_DOWNLOAD = `${RELEASES_PAGE}/download/`;
const TAG_DOWNLOAD = 'https://github.com/shipdocs/boekhoudenvoorniks/releases/download/';
/** Per soort: de bestandsnaam bij een versie, of null als het bestand een vaste naam heeft in de nieuwste release. */
export const DOWNLOADS: Record<string, { file: ((version: string) => string) | null; fixed?: string }> = {
  windows: { file: (v) => `BoekhoudenVoorNiks-Setup-${v}.exe` },
  appimage: { file: (v) => `BoekhoudenVoorNiks-${v}.AppImage` },
  deb: { file: (v) => `gratis-boekhouden_${v}_amd64.deb` },
  'sha256-windows': { file: null, fixed: 'SHA256SUMS-Windows.txt' },
  'sha256-linux': { file: null, fixed: 'SHA256SUMS-Linux.txt' },
};

/** Het nieuwste versienummer; tien minuten onthouden, en bij een storing de laatste bekende waarde (een week). */
async function latestVersion(fetcher: typeof fetch, store: Cache | null): Promise<string> {
  const fresh = new Request('https://boekhoudenvoorniks.nl/__nieuwste-versie');
  const stale = new Request('https://boekhoudenvoorniks.nl/__laatste-bekende-versie');
  const cached = await store?.match(fresh);
  if (cached) return (await cached.text()).trim();
  try {
    const res = await fetcher(`${LATEST_DOWNLOAD}latest.yml`, { headers: { 'user-agent': 'boekhoudenvoorniks-site' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`GitHub: ${res.status}`);
    const version = /^version:\s*["']?(\d+\.\d+\.\d+)["']?\s*$/m.exec(await res.text())?.[1];
    if (!version) throw new Error('geen versienummer in latest.yml');
    const put = (key: Request, seconds: number) => store?.put(key, new Response(version, { headers: { 'cache-control': `max-age=${seconds}` } }));
    await put(fresh, 600);
    await put(stale, 7 * 24 * 3600);
    return version;
  } catch (e) {
    const known = await store?.match(stale);
    if (known) return (await known.text()).trim();
    throw e;
  }
}

/** Een downloadadres: doorsturen naar het juiste bestand; lukt dat niet, dan naar de releasepagina als noodgreep. */
export async function download(kind: string, fetcher: typeof fetch = fetch, store: Cache | null = typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null): Promise<Response> {
  const entry = DOWNLOADS[kind];
  if (!entry) return new Response('Onbekende download', { status: 404 });
  let target = RELEASES_PAGE;
  try {
    if (entry.fixed) target = `${LATEST_DOWNLOAD}${entry.fixed}`;
    else if (entry.file) {
      const version = await latestVersion(fetcher, store);
      target = `${TAG_DOWNLOAD}v${version}/${entry.file(version)}`;
    }
  } catch {
    // de noodgreep hierboven
  }
  return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}

/** Afbeeldingen, stijl en iconen veranderen zelden: een dag in de browser, een week bij Cloudflare. */
const LONG_CACHE = /\.(png|webp|svg|ico|css|webmanifest)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // altijd https en zonder www.
    if (url.hostname === 'www.boekhoudenvoorniks.nl' || url.protocol === 'http:') {
      url.hostname = 'boekhoudenvoorniks.nl';
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    // /download/windows, /download/appimage, ...: het bestand van de nieuwste release
    if (url.pathname === '/download' || url.pathname === '/download/') return Response.redirect(`${url.origin}/downloaden.html`, 302);
    if (url.pathname.startsWith('/download/') && (request.method === 'GET' || request.method === 'HEAD')) {
      const kind = url.pathname.slice('/download/'.length);
      if (request.method === 'GET' && DOWNLOADS[kind]) env.STATS?.writeDataPoint(countPoint('download', kind, request));
      return download(kind);
    }
    // één adres per pagina: /index.html is de homepage
    if (url.pathname.endsWith('/index.html')) {
      url.pathname = url.pathname.slice(0, -'index.html'.length);
      return Response.redirect(url.toString(), 301);
    }
    // / en een map: index.html (html_handling staat uit, zodat .html-adressen niet doorverwijzen)
    const assetUrl = new URL(url);
    if (assetUrl.pathname.endsWith('/')) assetUrl.pathname += 'index.html';
    const res = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
    if (res.ok && request.method === 'GET' && /(\/|\.html)$/.test(assetUrl.pathname)) env.STATS?.writeDataPoint(countPoint('pagina', url.pathname === '/' ? '/' : url.pathname, request));
    const out = new Response(res.body, res);
    // Securityheaders horen bij de sitecode, zodat ze versioneerbaar en testbaar blijven.
    // CSP blokkeert inline uitvoerbare scripts; JSON-LD is niet uitvoerbaar en blijft toegestaan door de browser.
    // Meta Pixel is na toestemming de enige externe scriptbron. Trusted Types zetten we nog niet afdwingend aan:
    // third-party scripts moeten daar expliciet compatibel mee zijn; eerst rapporteren/testen om tracking niet stil te breken.
    out.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
    out.headers.set('x-content-type-options', 'nosniff');
    out.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    out.headers.set('x-frame-options', 'DENY');
    out.headers.set('cross-origin-opener-policy', 'same-origin');
    out.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    out.headers.set(
      'content-security-policy',
      "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
      "form-action 'self' mailto:; script-src 'self' https://connect.facebook.net; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.facebook.com; " +
      "connect-src 'self' https://www.facebook.com https://connect.facebook.net; " +
      "font-src 'self'; manifest-src 'self'; upgrade-insecure-requests"
    );
    if (res.ok && LONG_CACHE.test(url.pathname)) out.headers.set('cache-control', 'public, max-age=86400, s-maxage=604800');
    return out;
  },
};
