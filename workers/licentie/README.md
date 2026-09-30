# Licentie-Worker

Het enige online onderdeel van BoekhoudenVoorNiks: een klant neemt via Mollie een abonnement voor
de uitwisseling met zijn boekhouder, en de app haalt daarna een ondertekende licentie op. Hier staat
alleen wat nodig is om te betalen (administratie-ID, e-mailadres, Mollie-nummers), geen boekhouding.

| Route | Wat |
|---|---|
| `GET /prijs` | prijs per maand exclusief en inclusief btw (`PRICE_EXCL_VAT`) en de proefperiode (`TRIAL_MONTHS`), voor het scherm in de app |
| `POST /start` | (JSON: administratie, e-mail, bedrijfsgegevens) klant en eerste betaling (`sequenceType: first`) bij Mollie; bij een eerste abonnement is dat alleen € 0,01 voor de machtiging (proefperiode, zie hieronder); geeft de betaallink terug, of `al` als er al een abonnement loopt |
| `POST /mollie` | webhook: haalt de betaling zelf op bij Mollie. Eerste betaling → abonnement (`1 month`, start na de betaalde maand of na de proefperiode); maandelijkse betaling → een maand erbij. Idempotent en herstelbaar (zie hieronder). |
| `GET /licentie?administratie=…` | met de lokale beheersleutel als Bearer-token: ondertekende licentie (Ed25519) t/m de betaalde periode plus 7 dagen marge; met `cancelled` na opzeggen |
| `POST /opzeggen` | met de lokale beheersleutel als Bearer-token: abonnement stoppen bij Mollie; de licentie loopt af na de betaalde periode |
| `GET /bedankt` | terugkeerpagina na het afrekenen |
| RPC `Controle.assistent()` | alleen via de Service Binding van `workers/assistent` (niet via internet): mag deze administratie de online hulp gebruiken (actief abonnement, juiste beheersleutel) en is het dagquotum nog niet op? Telt de aanroep in `assistant_usage` (migratie 0005) |

De app controleert licenties offline (`src/license/license.ts`). Alleen *versturen naar je
boekhouder* vraagt een licentie; een antwoord inlezen werkt altijd. Zolang `LICENSE_PUBLIC_KEY` in
de app leeg is, staan licenties uit en is alles vrij.

Bij het eerste afsluiten maakt de app een willekeurige beheersleutel. Die blijft lokaal in de
administratie en gaat nooit in een URL of export naar de boekhouder. D1 bewaart alleen de SHA-256-hash.
Daardoor is alleen kennis van een administratie-UUID niet genoeg om de licentie op te halen of het
abonnement op te zeggen. Bewaar of herstel daarom de volledige administratieback-up; bij verlies van
de sleutel moet ShipDocs het abonnement handmatig in Mollie afhandelen.

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
- **Dubbel klikken bij afsluiten:** klant en eerste betaling krijgen stabiele Mollie
  `Idempotency-Key`-waarden voor dezelfde betaalpoging. Gelijktijdige verzoeken maken daardoor geen
  dubbele klant of betaalpoging; na een betaalde periode krijgt opnieuw afsluiten een nieuwe sleutel.
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
   `subscriptions.read`, `subscriptions.write` en, voor de facturen, `sales-invoices.read` en `sales-invoices.write` (Mollie weigert het aanmaken van een factuur zonder het leesrecht). Geen `refunds`, `payouts` of `mandates`: een uitgelekte
   sleutel kan dan geen geld terugstorten. Zet in `wrangler.jsonc` bij `vars` het profiel-ID
   (`MOLLIE_PROFILE_ID`, `pfl_…`) en `MOLLIE_TESTMODE: "true"`; live gaan is later alleen
   `MOLLIE_TESTMODE: "false"`. (Een gewone API-sleutel `test_…`/`live_…` werkt ook: laat die twee vars
   dan weg.)
4. **Geheimen** (nooit in `wrangler.jsonc`):
   ```bash
   npx wrangler secret put MOLLIE_API_KEY                              # het organisatie-toegangstoken (access_…)
   npx wrangler secret put LICENSE_PRIVATE_KEY < ~/.config/boekhoudenvoorniks-licentiesleutel.json
   ```
5. **Deployen**: `npx wrangler deploy`. De route `licentie.boekhoudenvoorniks.nl` staat in
   `wrangler.jsonc` als custom domain; het domein staat al bij Cloudflare.
6. **Testen met Mollie in testmodus**: in de app op *Abonnement nemen*, in de testbetaalpagina van
   Mollie "betaald" kiezen, en daarna *Ik heb betaald: licentie ophalen*.

## Stand (30 september 2026)

Staat **live** op `licentie.boekhoudenvoorniks.nl` (`MOLLIE_TESTMODE: "false"`, facturen aan), met een
organisatie-toegangstoken met de zeven rechten hierboven. D1-database `boekhoudenvoorniks-licenties` in
West-Europa, migraties t/m 0005; de testregels zijn verwijderd. Getest in testmodus: betaling, abonnement,
factuur (met `sales-invoices.read`), licentie ondertekend. In de app staan licenties nog **uit**
(`LICENSE_PUBLIC_KEY` leeg) tot na de eerste echte betaling (stap 4 van "Live gaan").

## Prijs en proefperiode

`PRICE_EXCL_VAT` (in `wrangler.jsonc`, bv. `"9.00"`) is de prijs per maand exclusief btw; afgeschreven
wordt die plus 21% btw (`€ 10,89`). Een prijswijziging geldt alleen voor nieuwe abonnementen: een
lopend Mollie-abonnement houdt zijn bedrag (en de voorwaarden vragen een maand vooraankondiging).

`TRIAL_MONTHS` (bv. `"4"`) geeft een eerste abonnement gratis maanden: de eerste betaling is dan € 0,01,
alleen voor de machtiging (Mollie kan € 0 alleen met creditcard of PayPal, niet met iDEAL). Die telt voor
de gratis maanden, krijgt geen factuur (`payments.trial`) en het abonnement begint daarna. Een
proefperiode krijgt alleen een administratie zonder licentie én een e-mailadres dat nog geen abonnement
had; opnieuw afsluiten na opzeggen is een gewone betaalde eerste maand.

## Facturen

Na elke betaalde betaling (de eerste en elke maandelijkse) maakt de Worker een **betaalde factuur** via
de Sales Invoices-API van Mollie: op naam van het bedrijf (met KvK- of btw-nummer, die de app bij het
afsluiten meestuurt), over het afgeschreven bedrag met 21% btw daarin, gekoppeld aan de betaling. Mollie nummert hem en mailt hem naar
de klant. Eén factuur per betaling (`payments.invoice_id`, Idempotency-Key `factuur-<betaling>`). Staat
aan met `INVOICES: "true"` in `wrangler.jsonc`; dat vraagt de rechten `sales-invoices.read` en `sales-invoices.write` op het token.
Onze bedrijfsgegevens op de factuur komen uit het Mollie-account.

Mislukt een factuur (bv. een ontbrekend recht op het token), dan geeft de webhook 500 en herhaalt Mollie
hem; de betaling telt maar één keer. Let op: Mollie geeft voor dezelfde `Idempotency-Key` (`factuur-<betaling>`)
tot een uur hetzelfde antwoord terug, ook een fout. Na het herstellen van het token krijgt een herhaling
van dezelfde betaling dus nog tot een uur de oude fout; daarna lukt het vanzelf (gezien op 30 september 2026).

## Live gaan

Pas als het Mollie-profiel is goedgekeurd, en in deze volgorde:

0. `npm run migrate` uitvoeren (t/m migratie 0004, de proefperiode) en controleren met
   `npx wrangler d1 migrations list boekhoudenvoorniks-licenties --remote`. Het token het recht
   `sales-invoices.read` en `sales-invoices.write` geven (of een nieuw token met de zeven rechten maken en het geheim vervangen),
   `INVOICES: "true"` zetten en deployen; een testbetaling doen en de testfactuur in Mollie bekijken.
   Laat de voorwaarden (artikel 8) nakijken.
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

- Rate limiting op `/start` (Mollie-idempotentie voorkomt dubbele objecten voor dezelfde betaalpoging,
  maar begrenst niet hoeveel verschillende administratie-UUID's een aanvaller kan aanbieden).
- De webhookmelding is niet ondertekend (Mollie doet dat niet); de Worker vertrouwt alleen wat hij zelf
  bij Mollie ophaalt.
