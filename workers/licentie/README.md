# Licentie-Worker

Het enige online onderdeel van BoekhoudenVoorNiks: een klant neemt via Mollie een abonnement voor
de uitwisseling met zijn boekhouder, en de app haalt daarna een ondertekende licentie op. Hier staat
alleen wat nodig is om te betalen (administratie-ID, e-mailadres, Mollie-nummers), geen boekhouding.

| Route | Wat |
|---|---|
| `GET /prijs` | prijs per maand (`PRICE_EUR`), voor het scherm in de app |
| `GET /start?administratie=…&email=…` | klant en eerste betaling (`sequenceType: first`) bij Mollie, door naar het afrekenen |
| `POST /mollie` | webhook: haalt de betaling zelf op bij Mollie. Eerste betaling → abonnement (`1 month`, start over een maand); maandelijkse betaling → een maand erbij. Idempotent. |
| `GET /licentie?administratie=…` | ondertekende licentie (Ed25519) t/m de betaalde periode plus 7 dagen marge |
| `GET /bedankt` | terugkeerpagina na het afrekenen |

De app controleert licenties offline (`src/license/license.ts`). Alleen *versturen naar je
boekhouder* vraagt een licentie; een antwoord inlezen werkt altijd. Zolang `LICENSE_PUBLIC_KEY` in
de app leeg is, staan licenties uit en is alles vrij.

De logica staat in `src/app.ts` en is getest in `tests/licentie.test.ts` (met een nagebootste Mollie
en KV, en de handtekening van de Worker gecontroleerd door de app).

## Eén keer instellen

1. **Sleutelpaar** (privésleutel buiten de repo):
   ```bash
   node workers/licentie/sleutel-maken.mjs
   ```
   Zet de getoonde publieke sleutel in `src/license/license.ts` (`LICENSE_PUBLIC_KEY`). Pas als die
   in een release zit, staan licenties aan.
2. **Wrangler** en de types:
   ```bash
   cd workers/licentie && npm install
   npx wrangler login
   npx wrangler kv namespace create LICENTIES   # id in wrangler.jsonc zetten
   npx wrangler types                           # optioneel: Env genereren
   ```
3. **Geheimen** (nooit in `wrangler.jsonc`):
   ```bash
   npx wrangler secret put MOLLIE_API_KEY                              # eerst een test_…-sleutel
   npx wrangler secret put LICENSE_PRIVATE_KEY < ~/.config/boekhoudenvoorniks-licentiesleutel.json
   npx wrangler secret put PRICE_EUR                                   # bedrag per maand, bv. 7.50
   ```
4. **Deployen**: `npx wrangler deploy`. De route `licentie.boekhoudenvoorniks.nl` staat in
   `wrangler.jsonc` als custom domain; het domein staat al bij Cloudflare.
5. **Testen met Mollie in testmodus**: in de app op *Abonnement nemen*, in de testbetaalpagina van
   Mollie "betaald" kiezen, en daarna *Ik heb betaald: licentie ophalen*.

## Nog niet gebouwd

- Opzeggen vanuit de app (nu: in het Mollie-dashboard het abonnement stopzetten; de licentie loopt
  dan af na de betaalde maand plus marge).
- Rate limiting op `/start` (maakt per aanroep een klant bij Mollie aan).
- Een factuur per betaling (Mollie stuurt een betaalbevestiging; een echte factuur met btw nog niet).
