# Live bankfeed via Enable Banking (PSD2 AIS): ontwerp

Status: **ontwerp, niets gebouwd.** `src/integrations/openbanking.ts` is alleen een interface met een lege
lijst (`OPEN_BANKING_PROVIDERS = []`); er is geen route, geen UI en geen test. Dit document beschrijft hoe
Enable Banking erin past, in twee varianten die naast elkaar kunnen bestaan.

Enable Banking is gekozen als uitgangspunt omdat het de enige onderzochte aanbieder is met een gratis,
zelfbediende route (sandbox + "restricted mode") én een bankkeuze in onze eigen app. GoCardless Bank Account Data neemt geen nieuwe klanten meer aan, Tink, Yapily
en Finqware hebben vaste maandbedragen.

## Wat Enable Banking vraagt (uit hun documentatie, nog niet zelf uitgeprobeerd)

| Onderwerp | Stand |
|---|---|
| Authenticatie | Elke aanroep met een JWT, `RS256`, header `kid` = applicatie-id, claims `iss: enablebanking.com`, `aud: api.enablebanking.com`, `exp` maximaal 24 uur na `iat`. Het JWT identificeert de **applicatie**, niet de eindgebruiker. |
| Sleutelpaar | Wordt in het Control Panel gegenereerd (de browser bewaart de privésleutel lokaal) of door jezelf aangeleverd (alleen publieke sleutel). |
| Toestemming | `POST /auth` (bank, land, `psu_type` personal/business, `access.valid_until`, `state`, `redirect_url`) geeft een URL voor de gebruiker; na de redirect `POST /sessions` met de `code`. Bij de meeste banken maximaal 180 dagen. |
| Gegevens | `GET /accounts/{uid}/transactions` met `date_from`, pagina's via `continuation_key`; `GET /accounts/{uid}/balances`; banken via `GET /aspsps`. Een transactie heeft `entry_reference`, `transaction_amount`, `credit_debit_indicator` (CRDT/DBTR), `booking_date`, `creditor`/`debtor` en `remittance_information`. |
| Restricted mode | Elke ontwikkelaar kan een productie-applicatie activeren zonder contract of KYB, door eigen rekeningen te koppelen ("account linking"). Gegevens zijn dan beperkt tot die gekoppelde rekeningen. |
| Publieke productie | Contract + KYB + volumeprijs, met een maandelijks minimum. Geen bedragen gepubliceerd. |
| Redirect | Redirect-URL's moeten bij registratie worden toegestaan. |

**Open punten die Enable Banking zelf moet bevestigen (vóór we bouwen):**

1. Mag restricted mode door **eindgebruikers van onze software** gebruikt worden voor hun eigen rekeningen?
   De documentatie noemt het "testen met je eigen rekeningen" en "internal testing purposes". Variant B
   hieronder hangt hiervan af.
2. Zijn `http://localhost`- of custom-scheme-redirects toegestaan, of alleen `https`?
3. Wat is het minimum per maand en vanaf welk aantal rekeningen, voor variant A?
4. Welke Nederlandse banken zitten erin (ING, Rabobank, ABN AMRO, bunq, Knab, Triodos) en met welke
   consent-duur?
5. Hun verwerkersovereenkomst en datalocatie.

## Twee varianten

### Variant A: proxy (wij nemen de dienst af)

De Worker in `shipdocs/boekhoudenvoorniks-server` houdt de applicatiesleutel, tekent de JWT's en praat met
Enable Banking. De app praat alleen met onze Worker.

```text
app ──Bearer beheersleutel──▶ bank-Worker ──JWT(RS256)──▶ api.enablebanking.com ──▶ bank
                              (licentie-check, geen opslag van transacties)
```

- Authenticatie zoals de assistent-Worker (`docs/jev-assistent.md`): administratie-ID plus de lokale
  beheersleutel; de Worker controleert het abonnement bij de licentie-Worker. Geen geheim in Electron.
- De Worker is stateloos voor gegevens: hij geeft `transactions`-pagina's door en bewaart alleen wat nodig is
  voor de sessie (`session_id`, `uid`'s, `valid_until`) per administratie, versleuteld.
- Kosten: volume-gebaseerd met minimum bij Enable Banking; dat moet in het abonnement passen (of een eigen
  toeslag). Dit is een zakelijke beslissing.
- Voordeel: de gebruiker hoeft niets te regelen. Nadeel: wij worden verwerker in de zin van de AVG (extra
  verwerkersovereenkomst met gebruikers, en `site/privacy.html`, `docs/` en de voorwaarden aanpassen), er is
  een contract en KYB nodig, en er komt een server in de keten voor een app die nu zonder cloud werkt.

### Variant B: de gebruiker neemt de dienst zelf af (eigen applicatie, geen server van ons)

Elke gebruiker maakt zelf een gratis Enable Banking-applicatie en koppelt zijn eigen rekeningen. Sleutel en
toestemming blijven op zijn computer. Dit past het best bij het uitgangspunt "geen account, cloud of
abonnement", maar is alleen toegestaan als Enable Banking dat bevestigt (open punt 1).

Eenmalige installatie, begeleid in de app (stappen met schermafbeeldingen op de site):

1. Account aanmaken bij Enable Banking (e-mail, geen contract).
2. In het Control Panel een productie-applicatie registreren, sleutelpaar laten genereren, de **redirect-URL
   van de app** toestaan en de eigen rekeningen koppelen (account linking).
3. In de app onder Bank: applicatie-id plakken en het `.pem`-bestand met de privésleutel kiezen. De app
   bewaart beide via `SecretStore` (`safeStorage`), zoals SMTP- en Mollie-sleutels.

Elke volgende keer: bank kiezen, bij de bank inloggen, klaar.

```text
app ──JWT(RS256, eigen sleutel)──▶ api.enablebanking.com ──▶ bank
```

- Redirect: de app luistert tijdelijk op `http://127.0.0.1:<vrije poort>/bank/terug` (alleen voor de duur
  van de toestemming, met `state` als CSRF-controle). Mocht Enable Banking alleen `https` toestaan
  (open punt 2), dan komt er een **statische** terugkeerpagina op de site (`workers/site`) die de `code`
  alleen doorstuurt naar `127.0.0.1` of een `boekhoudenvoorniks://`-link en niets opslaat of logt.
- Kosten: nul voor de gebruiker (restricted mode), geen vaste lasten voor ons.
- Nadeel: de installatie is voor een zzp'er technisch (Control Panel, redirect-URL, sleutel), en wij kunnen
  geen support geven op hun Enable Banking-account. Enable Banking kan de voorwaarden van restricted mode
  wijzigen; dan vervalt deze variant.

### Advies

1. **Eerst open punt 1 en 2 voorleggen aan Enable Banking** (en 3–5 voor variant A).
2. Bevestigt Enable Banking variant B, dan B als eerste tranche bouwen, als opt-in voor wie het wil, naast
   CAMT/MT940/CSV. Er komt geen server bij en geen verwerkersrol.
3. A als betaalde gemakskeuze later, pas als er genoeg vraag is om het minimum van Enable Banking te dekken.
   De providerlaag hieronder is voor beide gelijk; alleen de transportlaag verschilt (rechtstreeks of via
   onze Worker).

## Wat er in de app moet veranderen

`OpenBankingProvider` gaat uit van `startConsent` → `completeConsent` → `fetchTransactions` en past goed bij
Enable Banking (anders dan bij Ponto, waar de koppeling in een apart dashboard gebeurt). Aanpassingen:

| Onderdeel | Doel |
|---|---|
| `src/integrations/enablebanking.ts` | Provider: JWT (Node `crypto`, RS256), `POST /auth`, `POST /sessions`, transacties met `continuation_key`, mapping naar `NormalizedTransaction`. Transport via `FetchLike` (zoals `stripe.ts`), zodat variant A alleen de basis-URL en de auth vervangt. |
| Mapping | `date` = `booking_date`; `amount` in centen, negatief bij `DBTR`; `counterName`/`counterIban` van `creditor` (bij uitgaand) of `debtor` (bij inkomend); `description` = `remittance_information` samengevoegd; `reference` = end-to-end-id; `bankId` = `entry_reference`; `ownIban` = IBAN van de rekening. Alleen geboekte (`BOOK`) transacties, geen `PDNG`. |
| Interface | Toevoegen: `status()` (verbonden, rekeningen, verloopdatum), `disconnect()`. `listBanks(country)` blijft `GET /aspsps`. `consentExpiresAt` komt uit `valid_until`. |
| Opslag | `bank_connections`: provider, sessie-id, rekening-`uid`'s met IBAN, `valid_until`, laatste sync. Sleutel en applicatie-id in `secrets`. Migratie in `src/db/migrations.ts`. |
| Import | `BankService.import(..., source: 'openbanking')`: dezelfde matching, leveranciersgeheugen en ontdubbeling als CSV/CAMT. Ontdubbelen op `bankId`; bij banken zonder stabiele `entry_reference` terugvallen op datum+bedrag+tegenpartij+omschrijving. |
| Synchronisatie | Bij opstarten en met een knop "Nu ophalen"; niet vaker dan de bank toestaat (PSD2: doorgaans vier keer per dag zonder gebruiker erbij). Haal op vanaf de laatste synchronisatiedatum min een paar dagen overlap. |
| Verlopen toestemming | Na `valid_until` (max. 180 dagen) stopt het ophalen. "Moet ik iets doen?" krijgt een taak "Bank opnieuw koppelen" vanaf 14 dagen vóór het verlopen, met één klik naar `startConsent`. Import via bestand blijft altijd werken. |
| IPC | Routes in `src/main/api.ts` (whitelist): `bank.verbinding.status`, `.start`, `.afronden`, `.ophalen`, `.verwijderen`. Geen geheimen naar de renderer. |
| UI | Bank → "Automatisch ophalen": stappenplan (variant B) of één knop (variant A), status per rekening, verloopdatum, foutmeldingen in gewone taal. |
| Tests | Nep-`FetchLike` met opgenomen antwoorden; JWT-claims; mapping (credit/debet, pending, meerdere `remittance_information`); paginering; ontdubbeling; verlopen toestemming. Een gemarkeerde, handmatig te draaien sandbox-test. |

## Privacy en veiligheid

- De app haalt alleen rekeninginformatie (`access`: saldi en transacties), nooit betalingen.
- Variant B: geen gegevens bij ons; de privésleutel verlaat de computer niet. `state` wordt gecontroleerd en de
  lokale redirect-poort sluit direct na de terugkeer.
- Variant A: geen opslag van transacties; logs zonder bedragen of tegenpartijen; verwerkersovereenkomst vereist.
- De sleutel staat in `safeStorage`; op Linux zonder veilige backend (`basic_text`) weigert `SecretStore` het
  bewaren, zoals bij de andere koppelingen, en vallen we terug op bestandsimport.

## Volgorde

1. Vragen aan Enable Banking (hierboven).
2. Zelf uitproberen met sandbox en restricted mode op een eigen rekening; nog geen code in de app.
3. Provider + mapping + tests tegen opgenomen antwoorden (variant B, zonder UI).
4. IPC + UI + verloop-taak; proefadministratie-test en e2e met nep-provider.
5. Pas daarna variant A beoordelen, met het contract en de prijs van Enable Banking in de hand.
