# Licentie-Worker

Het enige online onderdeel van BoekhoudenVoorNiks: een klant neemt via Mollie een abonnement voor
de uitwisseling met zijn boekhouder, en de app haalt daarna een ondertekende licentie op. Hier staat
alleen wat nodig is om te betalen (administratie-ID, e-mailadres, Mollie-nummers), geen boekhouding.

| Route | Wat |
|---|---|
| `GET /prijs` | prijs per maand (`PRICE_EUR`), voor het scherm in de app |
| `GET /start?administratie=…&email=…` | klant en eerste betaling (`sequenceType: first`) bij Mollie, door naar het afrekenen |
| `POST /mollie` | webhook: haalt de betaling zelf op bij Mollie. Eerste betaling → abonnement (`1 month`, start over een maand); maandelijkse betaling → een maand erbij. Idempotent en herstelbaar (zie hieronder). |
| `GET /licentie?administratie=…` | ondertekende licentie (Ed25519) t/m de betaalde periode plus 7 dagen marge |
| `GET /bedankt` | terugkeerpagina na het afrekenen |

De app controleert licenties offline (`src/license/license.ts`). Alleen *versturen naar je
boekhouder* vraagt een licentie; een antwoord inlezen werkt altijd. Zolang `LICENSE_PUBLIC_KEY` in
de app leeg is, staan licenties uit en is alles vrij.

De logica staat in `src/app.ts` en is getest in `tests/licentie.test.ts`: met een nagebootste Mollie
en D1 als echte SQLite-database (zelfde migratie en SQL), gelijktijdige en herhaalde meldingen,
storingen midden in de verwerking, en de handtekening van de Worker gecontroleerd door de app. De CI
installeert dit package uit de lockfile en draait `npm run check` (typecheck en `wrangler deploy
--dry-run`).

## Betrouwbaarheid van de webhook

Mollie herhaalt een webhook bij een fout, en kan dezelfde melding ook dubbel of gelijktijdig sturen.

- **Opslag in D1** (sterk consistent, transacties), niet in KV (eventually consistent, geen atomisch
  lezen-en-schrijven).
- **Elke betaling telt één keer:** de extra maand en de betaling (unieke `payment_id`) worden in één
  transactie vastgelegd. Betaald t/m = `period_start` + `months` maanden; een maand erbij is
  `months = months + 1`, zonder lezen-en-terugschrijven.
- **Eén abonnement:** vóór het aanmaken claimt één betaling het aanmaken (`subscription_claim`), en
  Mollie krijgt `Idempotency-Key: abonnement-<betaling>`. Valt de verwerking halverwege uit, dan maakt de
  herhaling van dezelfde betaling het af en krijgt ze bij Mollie hetzelfde abonnement terug.
- **Incasso van een abonnement dat nog niet gekoppeld is:** de administratie komt uit de metadata van het
  abonnement. Ontbreekt de licentie nog, dan geeft de Worker 500 zodat Mollie het later opnieuw probeert.

## Eén keer instellen

1. **Sleutelpaar** (privésleutel buiten de repo):
   ```bash
   node workers/licentie/sleutel-maken.mjs
   ```
   Zet de getoonde publieke sleutel in `src/license/license.ts` (`LICENSE_PUBLIC_KEY`). Pas als die
   in een release zit, staan licenties aan.
2. **Wrangler** en de database:
   ```bash
   cd workers/licentie && npm ci
   npx wrangler login
   npx wrangler d1 create boekhoudenvoorniks-licenties   # database_id in wrangler.jsonc zetten
   npm run migrate                                         # tabellen aanmaken (migrations/)
   ```
3. **Mollie-sleutel: een organisatie-toegangstoken met alleen deze rechten** (Mollie: *Ontwikkelaars →
   Organisatie-toegangstokens*): `customers.write`, `payments.read`, `payments.write`,
   `subscriptions.read`, `subscriptions.write`. Geen `refunds`, `payouts` of `mandates`: een uitgelekte
   sleutel kan dan geen geld terugstorten. Zet in `wrangler.jsonc` bij `vars` het profiel-ID
   (`MOLLIE_PROFILE_ID`, `pfl_…`) en `MOLLIE_TESTMODE: "true"`; live gaan is later alleen
   `MOLLIE_TESTMODE: "false"`. (Een gewone API-sleutel `test_…`/`live_…` werkt ook: laat die twee vars
   dan weg.)
4. **Geheimen** (nooit in `wrangler.jsonc`):
   ```bash
   npx wrangler secret put MOLLIE_API_KEY                              # het organisatie-toegangstoken (access_…)
   npx wrangler secret put LICENSE_PRIVATE_KEY < ~/.config/boekhoudenvoorniks-licentiesleutel.json
   npx wrangler secret put PRICE_EUR                                   # bedrag per maand, bv. 7.50
   ```
5. **Deployen**: `npx wrangler deploy`. De route `licentie.boekhoudenvoorniks.nl` staat in
   `wrangler.jsonc` als custom domain; het domein staat al bij Cloudflare.
6. **Testen met Mollie in testmodus**: in de app op *Abonnement nemen*, in de testbetaalpagina van
   Mollie "betaald" kiezen, en daarna *Ik heb betaald: licentie ophalen*.

## Stand (30 september 2026)

Staat live op `licentie.boekhoudenvoorniks.nl`, **in testmodus** (`MOLLIE_TESTMODE: "true"`), met een
organisatie-toegangstoken met de vijf rechten hierboven. D1-database `boekhoudenvoorniks-licenties` in
West-Europa. Getest met een testbetaling: betaling verwerkt, abonnement aangemaakt, licentie
ondertekend en door de app goedgekeurd. In de app staan licenties nog **uit** (`LICENSE_PUBLIC_KEY` leeg).

## Live gaan

Pas als het Mollie-profiel is goedgekeurd, en in deze volgorde:

1. In Mollie (testmodus) de testabonnementen stopzetten. Anders blijft Mollie maandelijks meldingen van
   testbetalingen sturen die de Worker in live-modus niet kan ophalen.
2. De testregels uit D1 halen:
   `npx wrangler d1 execute boekhoudenvoorniks-licenties --remote --command "DELETE FROM payments; DELETE FROM licenses;"`
3. In `wrangler.jsonc` `MOLLIE_TESTMODE` op `"false"` zetten en `npx wrangler deploy`. Hetzelfde token werkt
   live; iDEAL en SEPA-incasso moeten aan staan in het profiel.
4. Eén echte betaling doen en weer opzeggen (via het Mollie-dashboard), en de licentie in de app ophalen.
5. Pas dan de publieke sleutel in `src/license/license.ts` (`LICENSE_PUBLIC_KEY`) zetten en een release
   maken. Staat de sleutel in de app terwijl de Worker in testmodus draait, dan geeft een nepbetaling op
   de testpagina van Mollie een geldige licentie.

## Nog niet gebouwd

- Opzeggen vanuit de app (nu: in het Mollie-dashboard het abonnement stopzetten; de licentie loopt
  dan af na de betaalde maand plus marge).
- Rate limiting op `/start` (maakt per aanroep een klant bij Mollie aan).
- De webhookmelding is niet ondertekend (Mollie doet dat niet); de Worker vertrouwt alleen wat hij zelf
  bij Mollie ophaalt.
- Een factuur per betaling (Mollie stuurt een betaalbevestiging; een echte factuur met btw nog niet).
