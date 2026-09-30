# Live bankfeed via Enable Banking (PSD2 AIS): ontwerp

Status: **ontwerp, niets gebouwd.** `src/integrations/openbanking.ts` is alleen een interface met een lege
lijst (`OPEN_BANKING_PROVIDERS = []`); er is geen route, geen UI en geen test. Dit document beschrijft hoe
Enable Banking erin past, als iets wat de gebruiker **zelf afneemt**: elke gebruiker heeft een eigen, gratis
Enable Banking-applicatie voor zijn eigen rekeningen. Er komt geen server van ons bij, wij zijn geen
verwerker en er is geen contract tussen ons en Enable Banking.

Enable Banking is gekozen omdat het de enige onderzochte aanbieder is met een gratis, zelfbediende route
(sandbox + "restricted mode") én een bankkeuze in onze eigen app. GoCardless Bank Account Data neemt geen
nieuwe klanten meer aan; Tink, Yapily en Finqware hebben vaste maandbedragen.

## Wat Enable Banking vraagt (uit hun documentatie, nog niet zelf uitgeprobeerd)

| Onderwerp | Stand |
|---|---|
| Authenticatie | Elke aanroep met een JWT, `RS256`, header `kid` = applicatie-id, claims `iss: enablebanking.com`, `aud: api.enablebanking.com`, `exp` maximaal 24 uur na `iat`. Het JWT identificeert de **applicatie**, niet de eindgebruiker. |
| Sleutelpaar | Wordt in het Control Panel gegenereerd (de browser bewaart de privésleutel lokaal) of door jezelf aangeleverd (alleen publieke sleutel). |
| Toestemming | `POST /auth` (bank, land, `psu_type` personal/business, `access.valid_until`, `state`, `redirect_url`) geeft een URL voor de gebruiker; na de redirect `POST /sessions` met de `code`. Bij de meeste banken maximaal 180 dagen. |
| Gegevens | `GET /accounts/{uid}/transactions` met `date_from`, pagina's via `continuation_key`; `GET /accounts/{uid}/balances`; banken via `GET /aspsps`. Een transactie heeft `entry_reference`, `transaction_amount`, `credit_debit_indicator` (CRDT/DBTR), `booking_date`, `creditor`/`debtor` en `remittance_information`. |
| Restricted mode | Elke ontwikkelaar kan een productie-applicatie activeren zonder contract of KYB, door eigen rekeningen te koppelen ("account linking"). Gegevens zijn dan beperkt tot die gekoppelde rekeningen. |
| Redirect | Redirect-URL's moeten bij registratie worden toegestaan. |

## Open punten: eerst aan Enable Banking vragen

Zonder een ja op punt 1 bouwen we niets; dan blijft bestandsimport (CAMT, MT940, CSV) de route.

1. Mag restricted mode gebruikt worden door **eindgebruikers van onze software**, elk met een eigen
   applicatie, voor hun eigen rekeningen? De documentatie noemt het "testen met je eigen rekeningen" en
   "internal testing purposes".
2. Zijn `http://127.0.0.1`- of custom-scheme-redirects toegestaan, of alleen `https`?
3. Welke Nederlandse banken zitten erin (ING, Rabobank, ABN AMRO, bunq, Knab, Triodos) en met welke
   toestemmingsduur?
4. Mag een zzp'er met een eenmanszaak als `psu_type` business of personal koppelen, en zijn er verschillen
   in wat gekoppeld kan worden?
5. Mogen wij de inrichting (Control Panel, sleutel, redirect) als handleiding in de app en op de site
   beschrijven, en wat mag er over Enable Banking in die tekst staan?

## Hoe het voor de gebruiker werkt

Eenmalige installatie, begeleid in de app (stappen met schermafbeeldingen op de site):

1. Account aanmaken bij Enable Banking (e-mail, geen contract).
2. In het Control Panel een productie-applicatie registreren, sleutelpaar laten genereren, de **redirect-URL
   van de app** toestaan en de eigen rekeningen koppelen (account linking).
3. In de app onder Bank → "Automatisch ophalen": applicatie-id plakken en het `.pem`-bestand met de
   privésleutel kiezen. De app bewaart beide via `SecretStore` (`safeStorage`), zoals SMTP- en Mollie-sleutels.

Daarna, en bij elke verlenging: bank kiezen, bij de bank inloggen, klaar.

```text
app ──JWT(RS256, eigen sleutel)──▶ api.enablebanking.com ──▶ bank
```

- **Redirect.** De app luistert tijdelijk op `http://127.0.0.1:<vrije poort>/bank/terug`, alleen voor de duur
  van de toestemming, met `state` als CSRF-controle. Staat Enable Banking alleen `https` toe (open punt 2),
  dan komt er een **statische** terugkeerpagina op de site (`workers/site`) die de `code` alleen doorstuurt
  naar `127.0.0.1` of een `boekhoudenvoorniks://`-link, en niets opslaat of logt.
- **Kosten.** Nul voor de gebruiker en voor ons (restricted mode).
- **Nadelen.**
  - De installatie is voor een zzp'er technisch (Control Panel, redirect-URL, sleutel).
  - Wij kunnen geen support geven op hun Enable Banking-account.
  - Enable Banking kan de voorwaarden van restricted mode wijzigen. Dan vervalt deze route en blijft
    bestandsimport. De koppeling is daarom een opt-in extra en nooit de enige manier om de bank binnen te
    halen.

## Wat er in de app moet veranderen

`OpenBankingProvider` gaat uit van `startConsent` → `completeConsent` → `fetchTransactions` en past goed bij
Enable Banking. Aanpassingen:

| Onderdeel | Doel |
|---|---|
| `src/integrations/enablebanking.ts` | Provider: JWT (Node `crypto`, RS256), `POST /auth`, `POST /sessions`, transacties met `continuation_key`, mapping naar `NormalizedTransaction`. Transport via `FetchLike` (zoals `stripe.ts`), zodat alles met een nep-transport te testen is. |
| Mapping | `date` = `booking_date`; `amount` in centen, negatief bij `DBTR`; `counterName`/`counterIban` van `creditor` (bij uitgaand) of `debtor` (bij inkomend); `description` = `remittance_information` samengevoegd; `reference` = end-to-end-id; `bankId` = `entry_reference`; `ownIban` = IBAN van de rekening. Alleen geboekte (`BOOK`) transacties, geen `PDNG`. |
| Interface | Toevoegen: `status()` (verbonden, rekeningen, verloopdatum), `disconnect()`. `listBanks(country)` wordt `GET /aspsps`. `consentExpiresAt` komt uit `valid_until`. |
| Opslag | `bank_connections`: provider, sessie-id, rekening-`uid`'s met IBAN, `valid_until`, laatste sync. Applicatie-id en privésleutel in `secrets`. Migratie in `src/db/migrations.ts`. |
| Import | `BankService.import(..., source: 'openbanking')`: dezelfde matching, leveranciersgeheugen en ontdubbeling als CSV/CAMT. Ontdubbelen op `bankId` (`entry_reference`). Zonder stabiele `entry_reference` werkt de bestaande terugval niet veilig: `BankService.hash` telt identieke transacties per batch (`occurrence`), dus twee gelijke betalingen op één dag worden bij een overlappend ophaalvenster verkeerd genummerd (de tweede wordt als eerste gezien en overgeslagen, of dubbel geboekt). Daarom: per rekening alleen **hele dagen** ophalen en opnieuw importeren (het venster begint altijd aan het begin van een dag, nooit midden in een dag), en de provider geeft een eigen stabiele id (`transaction_id` of `reference_number` als de bank die levert). Ontbreekt die, dan toont de import een waarschuwing en een test bewijst dat dubbel ophalen van dezelfde dagen niets toevoegt. |
| Synchronisatie | Bij opstarten en met een knop "Nu ophalen"; niet vaker dan de bank toestaat (PSD2: doorgaans vier keer per dag zonder gebruiker erbij). Haal op vanaf de laatste synchronisatiedatum min een paar dagen overlap. |
| Verlopen toestemming | Na `valid_until` (max. 180 dagen) stopt het ophalen. "Moet ik iets doen?" krijgt een taak "Bank opnieuw koppelen" vanaf 14 dagen vóór het verlopen, met één klik naar `startConsent`. Import via bestand blijft altijd werken. |
| Sleutel kwijt of ongeldig | Duidelijke melding in gewone taal ("De sleutel past niet bij de applicatie"), en een knop om de instellingen te wissen. De sleutel wordt nooit in logs, back-ups of de renderer getoond. |
| IPC | Routes in `src/main/api.ts` (whitelist): `bank.verbinding.instellen`, `.status`, `.start`, `.afronden`, `.ophalen`, `.verwijderen`. Geen geheimen naar de renderer. |
| UI | Bank → "Automatisch ophalen": het stappenplan van hierboven, daarna status per rekening, verloopdatum en foutmeldingen in gewone taal. |
| Tests | Nep-`FetchLike` met opgenomen antwoorden; JWT-claims en `kid`; mapping (credit/debet, pending, meerdere `remittance_information`); paginering; ontdubbeling (twee identieke transacties op één dag, dag twee keer opgehaald, met en zonder `entry_reference`); verlopen toestemming; `state`-controle op de redirect. Een gemarkeerde, handmatig te draaien sandbox-test. |

Back-ups: `secrets` (applicatie-id en sleutel) volgt hetzelfde beleid als de andere geheimen. Bij herstel op een
andere computer moet de gebruiker de sleutel opnieuw kiezen en opnieuw toestemming geven.

## Privacy en veiligheid

- De app haalt alleen rekeninginformatie (`access`: saldi en transacties), nooit betalingen.
- Geen gegevens bij ons: de transacties gaan rechtstreeks van Enable Banking naar de computer van de gebruiker.
  Wij zijn geen verwerker. De gebruiker heeft zelf een relatie met Enable Banking en moet dat weten; dat
  staat in het stappenplan en in `site/privacy.html`.
- De privésleutel verlaat de computer niet. `state` wordt gecontroleerd en de lokale redirect-poort sluit
  direct na de terugkeer of na een time-out.
- De sleutel staat in `safeStorage`; op Linux zonder veilige backend (`basic_text`) weigert `SecretStore` het
  bewaren, zoals bij de andere koppelingen, en vallen we terug op bestandsimport.

## Volgorde

1. Vragen aan Enable Banking (hierboven). Bij een nee op punt 1: stoppen, niets bouwen.
2. Zelf uitproberen met sandbox en restricted mode op een eigen rekening; nog geen code in de app.
3. Provider, mapping en tests tegen opgenomen antwoorden, zonder UI.
4. IPC, UI en de verloop-taak; proefadministratie-test en e2e met een nep-provider.
5. Stappenplan met schermafbeeldingen op de site; `site/privacy.html` en de README bijwerken.
