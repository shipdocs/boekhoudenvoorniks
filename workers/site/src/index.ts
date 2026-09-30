/** De website: bestanden uit site/; http en www.boekhoudenvoorniks.nl gaan naar https://boekhoudenvoorniks.nl. */
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
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
