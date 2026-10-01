/** De website: bestanden uit site/; http en www.boekhoudenvoorniks.nl gaan naar https://boekhoudenvoorniks.nl. */
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

/**
 * Vaste downloadadressen: /download/windows en /download/appimage verwijzen naar het bestand van de nieuwste
 * release, ook als de naam het versienummer bevat. Zo hoeft er op de website niets te veranderen bij een
 * nieuwe versie en komt niemand op een GitHub-pagina terecht.
 */
const RELEASES_API = 'https://api.github.com/repos/shipdocs/boekhoudenvoorniks/releases/latest';
const RELEASES_PAGE = 'https://github.com/shipdocs/boekhoudenvoorniks/releases/latest';
export const DOWNLOADS: Record<string, RegExp> = {
  windows: /^BoekhoudenVoorNiks-Setup-[\d.]+\.exe$/,
  appimage: /^BoekhoudenVoorNiks-[\d.]+\.AppImage$/,
  deb: /\.deb$/,
  'sha256-windows': /^SHA256SUMS-Windows\.txt$/,
  'sha256-linux': /^SHA256SUMS-Linux\.txt$/,
};

interface ReleaseAsset { name: string; browser_download_url: string }

/** De bestanden van de nieuwste release; tien minuten onthouden, zodat de GitHub-API niet bij elk bezoek gevraagd wordt. */
async function latestAssets(fetcher: typeof fetch = fetch): Promise<ReleaseAsset[]> {
  const store = typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null;
  const key = new Request('https://boekhoudenvoorniks.nl/__nieuwste-release');
  const cached = await store?.match(key);
  if (cached) return (await cached.json()) as ReleaseAsset[];
  const res = await fetcher(RELEASES_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'boekhoudenvoorniks-site' } });
  if (!res.ok) throw new Error(`GitHub: ${res.status}`);
  const release = (await res.json()) as { draft?: boolean; prerelease?: boolean; assets?: ReleaseAsset[] };
  const assets = !release.draft && !release.prerelease && Array.isArray(release.assets) ? release.assets : [];
  if (assets.length > 0 && store) {
    await store.put(key, new Response(JSON.stringify(assets), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=600' } }));
  }
  return assets;
}

/** Een downloadadres: doorsturen naar het juiste bestand; lukt dat niet, dan naar de releasepagina als noodgreep. */
export async function download(kind: string, fetcher: typeof fetch = fetch): Promise<Response> {
  const pattern = DOWNLOADS[kind];
  if (!pattern) return new Response('Onbekende download', { status: 404 });
  let target = RELEASES_PAGE;
  try {
    const asset = (await latestAssets(fetcher)).find((a) => pattern.test(a.name));
    if (asset && asset.browser_download_url.startsWith('https://github.com/shipdocs/boekhoudenvoorniks/releases/download/')) target = asset.browser_download_url;
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
    if (url.pathname.startsWith('/download/') && (request.method === 'GET' || request.method === 'HEAD')) return download(url.pathname.slice('/download/'.length));
    // één adres per pagina: /index.html is de homepage
    if (url.pathname.endsWith('/index.html')) {
      url.pathname = url.pathname.slice(0, -'index.html'.length);
      return Response.redirect(url.toString(), 301);
    }
    // / en een map: index.html (html_handling staat uit, zodat .html-adressen niet doorverwijzen)
    const assetUrl = new URL(url);
    if (assetUrl.pathname.endsWith('/')) assetUrl.pathname += 'index.html';
    const res = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
    const out = new Response(res.body, res);
    out.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
    out.headers.set('x-content-type-options', 'nosniff');
    out.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    if (res.ok && LONG_CACHE.test(url.pathname)) out.headers.set('cache-control', 'public, max-age=86400, s-maxage=604800');
    return out;
  },
};
