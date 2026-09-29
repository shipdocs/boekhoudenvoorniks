/** De website: bestanden uit site/; http en www.boekhoudenvoorniks.nl gaan naar https://boekhoudenvoorniks.nl. */
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // altijd https en zonder www.
    if (url.hostname === 'www.boekhoudenvoorniks.nl' || url.protocol === 'http:') {
      url.hostname = 'boekhoudenvoorniks.nl';
      url.protocol = 'https:';
      return Response.redirect(url.toString(), 301);
    }
    // / en een map: index.html (html_handling staat uit, zodat .html-adressen niet doorverwijzen)
    if (url.pathname.endsWith('/')) {
      url.pathname += 'index.html';
      return env.ASSETS.fetch(new Request(url.toString(), request));
    }
    return env.ASSETS.fetch(request);
  },
};
