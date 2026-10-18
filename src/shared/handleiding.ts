/**
 * De online handleiding (#420): per scherm de pagina die erbij hoort. De knop "Hulp" in de app opent die in de
 * browser. De pagina's en ankers komen uit docs/handleiding (gebouwd met `npm run site:handleiding`); de test
 * `tests/handleiding-link.test.ts` bewaakt dat elke verwijzing bestaat.
 */
export const HANDLEIDING_URL = 'https://boekhoudenvoorniks.nl/handleiding/';

/** scherm (Route.screen) → pagina, eventueel met anker */
export const HANDLEIDING_PAGINAS: Record<string, string> = {
  home: 'index.html',
  zoeken: 'beginnen.html#zoeken-door-alles',
  welkom: 'beginnen.html',
  werk: 'werk-en-facturen.html',
  factuur: 'werk-en-facturen.html#een-factuur-maken',
  offerte: 'werk-en-facturen.html#een-offerte-maken',
  klussen: 'klussen.html',
  klus: 'klussen.html',
  aankopen: 'bonnetjes.html',
  document: 'bonnetjes.html#nakijken',
  categorie: 'bank.html#betalingen-uitzoeken-hulp-nodig',
  klanten: 'werk-en-facturen.html#klanten',
  klant: 'werk-en-facturen.html#klanten',
  bank: 'bank.html',
  belasting: 'btw-aangifte.html',
  aangifte: 'btw-aangifte.html#de-btw-aangifte-doen',
  overzicht: 'boekhouder.html',
  instellingen: 'instellingen.html',
  opmaak: 'instellingen.html#de-tabbladen',
  expert: 'boekhoudermodus.html',
  overstap: 'overstappen.html',
};

/** De pagina van de handleiding voor dit scherm; onbekend scherm → de index. */
export function handleidingUrl(screen: string): string {
  return HANDLEIDING_URL + (HANDLEIDING_PAGINAS[screen] ?? 'index.html');
}
