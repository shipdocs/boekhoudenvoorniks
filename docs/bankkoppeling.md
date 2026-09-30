# Live bankfeed (PSD2 AIS): ontwerp met Ponto en Enable Banking

Status: **ontwerp, niets gebouwd.** `src/integrations/openbanking.ts` is alleen een interface met een lege
lijst (`OPEN_BANKING_PROVIDERS = []`); er is geen route, geen UI en geen test.

Bestandsimport (CAMT, MT940, CSV) blijft altijd de basis. De live bankfeed is een opt-in extra. Dit document
beschrijft twee aanbieders achter dezelfde providerlaag:

| | **Ponto** (Isabel Group) | **Enable Banking** (eigen applicatie per gebruiker) |
|---|---|---|
| Wat de gebruiker doet | Account bij Ponto, bank daar koppelen, in de app "Verbinden met Ponto" | Account bij Enable Banking, applicatie registreren, sleutel en redirect-URL instellen, rekeningen koppelen |
| Moeilijkheid voor een zzp'er | **Laag**: inloggen en toestemming geven | **Hoog**: technisch Control Panel-werk |
| Wie betaalt | De gebruiker rechtstreeks aan Ponto (per gekoppelde rekening per maand; het bedrag moet nog bevestigd worden), of wij | Niemand (restricted mode), als Enable Banking dat toestaat |
| Heeft het een server van ons nodig? | **Ja, een dunne doorgeefpost** (zie hieronder) | Nee |
| Contract met ons | Ibanity-developeraccount, per bevestiging | Geen |
| Dekking Nederland | Te bevestigen | Te bevestigen |

**Advies:** Ponto als hoofdroute voor gebruikers, omdat het voor hen veel eenvoudiger is. Enable Banking blijft
een optionele route voor wie zelf wil sleutelen, alleen als Enable Banking die toestaat. Beide zijn opt-in.

Waarom andere aanbieders afvielen: GoCardless Bank Account Data neemt geen nieuwe klanten meer aan; Tink,
Yapily en Finqware hebben vaste maandbedragen.

---

## Ponto

### Hoe Ponto werkt (uit de Ponto Connect-documentatie, nog niet zelf uitgeprobeerd)

| Onderwerp | Stand |
|---|---|
| Identiteit van onze applicatie | Een clientcertificaat met privésleutel (mTLS) en een client-id en -secret uit het Ibanity Developer Portal. Die horen bij **onze** applicatie, niet bij de gebruiker. |
| Toestemming | OAuth2-code-flow met PKCE. De gebruiker logt in bij Ponto en geeft onze applicatie toegang. Wij krijgen een access token en een refresh token. Redirect-URL's moeten in het Developer Portal worden toegestaan. |
| Rekeningen koppelen | Doet de gebruiker **zelf in het Ponto-dashboard** (bank-SCA zit dus bij Ponto). Verlopen toestemming herstel je via Ponto of met `POST /reauthorizations/accounts`. |
| Gegevens | `GET /accounts`, `GET /accounts/{id}/transactions` met cursor (`page[after]`, tot 100). Synchronisatie is asynchroon: `POST /synchronizations`, pollen tot `success`, dan lezen. Maximaal één sync per 30 minuten per rekening, maximaal 50 per dag, `customerIpAddress` is verplicht. Ponto synchroniseert zelf ook vier keer per dag. |
| Transactie | `id` (uuid, stabiel), `digest`, `amount` (getal in euro's, negatief bij afschrijving), `counterpartName`, `counterpartReference` (IBAN), `remittanceInformation`, `endToEndId`, `valueDate`, `executionDate`. |
| Sandbox | Ja, met eigen testdata. |
| Foutcodes bij sync | `authorizationInvalid`, `authorizationRevoked`, `authorizationExpired` (gebruiker moet opnieuw toestemming geven), `technicalFailure` (tijdelijk). |

### Waarom er een server nodig is

Het certificaat en het client-secret van onze applicatie kunnen niet in de Electron-app staan: die gaat naar
alle gebruikers en iedereen kan ze eruit halen. Met alleen dat geheim kan niemand bij andermans gegevens (daar is
ook een token van de gebruiker voor nodig), maar wel namens onze applicatie aanroepen doen, en Ibanity staat dat
vermoedelijk niet toe. **Dit moet Ponto bevestigen**: mag het certificaat in een desktop-app, of moet er een
tussenstap zijn?

Gaan we uit van een tussenstap, dan is dat de kleinste server die kan: een **doorgeefpost** in
`shipdocs/boekhoudenvoorniks-server` (Cloudflare Worker, naast de licentie- en assistent-Worker).

```text
app ──Bearer beheersleutel + refresh token──▶ bank-Worker ──mTLS + token──▶ api.ibanity.com ──▶ Ponto ──▶ bank
                                              (houdt certificaat en secret; slaat niets op)
```

- **Geen opslag.** De Worker bewaart geen transacties, geen tokens en geen rekeningen. Het refresh token staat
  alleen in de app (`SecretStore`). De app stuurt het mee, de Worker wisselt het om in een access token, doet
  de aanroep en geeft het antwoord terug. Logs bevatten geen bedragen, tegenpartijen of tokens.
- **Authenticatie van app naar Worker** zoals de assistent-Worker (`docs/jev-assistent.md`): administratie-ID
  plus de lokale beheersleutel, de Worker kent alleen de hash. Of een actief abonnement vereist is, is een
  productbeslissing.
- **`customerIpAddress`.** Ponto vereist het IP-adres van de gebruiker. De Worker neemt het uit
  `CF-Connecting-IP` van het verzoek van de app en geeft het door.
- **Synchronisatie.** De app beslist wanneer; de Worker bewaakt de limieten (30 minuten, 50 per dag) zodat een
  storing in de app Ponto niet blokkeert.
- **Of Cloudflare Workers een mTLS-clientcertificaat naar een externe API kunnen sturen** is niet uitgezocht en
  moet eerst worden gecontroleerd. Zo niet, dan is een andere kleine host nodig.
- **AVG.** Ook een doorgeefpost verwerkt gegevens onderweg. De verwerkersovereenkomst met Ibanity/Ponto en de
  tekst in `site/privacy.html` moeten dat dekken. Te laten controleren.

### Hoe het voor de gebruiker werkt

1. Account aanmaken bij Ponto en daar de eigen bank koppelen (stappenplan met schermafbeeldingen op de site).
2. In de app: Bank → "Automatisch ophalen" → **Verbinden met Ponto**. De browser opent, de gebruiker geeft
   toestemming, de app neemt het over.
3. Klaar. Daarna haalt de app zelf op. Bij verlopen toestemming verschijnt een taak "Bank opnieuw koppelen".

**Redirect.** De app luistert tijdelijk op `http://127.0.0.1:<vrije poort>/bank/terug` met `state` als
CSRF-controle en PKCE (`S256`). De documentatie noemt lokale redirect-URL's voor ontwikkeling; of ze ook in
productie mogen, moet Ponto bevestigen. Zo niet, dan komt er een **statische** terugkeerpagina op de site
(`workers/site`) die de `code` alleen doorstuurt naar `127.0.0.1` of een `boekhoudenvoorniks://`-link, en niets
opslaat of logt.

### Open punten voor Ponto

1. Mag het certificaat en client-secret in een desktop-app, of is een tussenstap verplicht?
2. Wat kost het per gekoppelde rekening per maand, en kan de gebruiker zelf betalen ("customer paying") zonder
   dat wij factureren?
3. Werkt Ponto voor eenmanszaken en privérekeningen van zzp'ers, of alleen voor zakelijke rekeningen? Welke
   Nederlandse banken zitten erin (ING, Rabobank, ABN AMRO, bunq, Knab, Triodos)?
4. Zijn lokale redirect-URL's (`http://127.0.0.1:<poort>`) in productie toegestaan?
5. Verwerkersovereenkomst en datalocatie.

---

## Enable Banking (optioneel, voor wie het zelf wil inrichten)

Elke gebruiker maakt een eigen, gratis applicatie in **restricted mode** en koppelt de eigen rekeningen. Sleutel
en toestemming blijven op de eigen computer; er komt geen server bij en wij zijn geen verwerker. Te technisch
voor de meeste zzp'ers, vandaar dat dit niet de hoofdroute is.

| Onderwerp | Stand (uit hun documentatie, niet zelf uitgeprobeerd) |
|---|---|
| Authenticatie | JWT, `RS256`, header `kid` = applicatie-id, claims `iss: enablebanking.com`, `aud: api.enablebanking.com`, `exp` maximaal 24 uur na `iat`. Identificeert de applicatie, niet de gebruiker. |
| Sleutelpaar | In het Control Panel gegenereerd (de browser bewaart de privésleutel lokaal) of zelf aangeleverd. |
| Toestemming | `POST /auth` (bank, land, `psu_type`, `access.valid_until`, `state`, `redirect_url`) geeft een URL; na de redirect `POST /sessions` met de `code`. Meestal maximaal 180 dagen. |
| Gegevens | `GET /accounts/{uid}/transactions` met `date_from` en `continuation_key`; balansen; banken via `GET /aspsps`. Transactie: `entry_reference`, `transaction_amount`, `credit_debit_indicator` (CRDT/DBTR), `booking_date`, `creditor`/`debtor`, `remittance_information`. |
| Restricted mode | Elke ontwikkelaar kan zonder contract of KYB een productie-applicatie activeren door eigen rekeningen te koppelen. Gegevens zijn beperkt tot die rekeningen. |
| Publieke productie | Contract + KYB + volumeprijs met maandminimum (geen bedragen gepubliceerd). Niet de bedoeling hier. |

Eenmalige installatie voor de gebruiker: account bij Enable Banking; in het Control Panel een
productie-applicatie registreren, sleutelpaar laten genereren, de redirect-URL van de app toestaan en de eigen
rekeningen koppelen; in de app het applicatie-id plakken en het `.pem`-bestand kiezen (beide in
`SecretStore`). Daarna: bank kiezen en inloggen.

```text
app ──JWT(RS256, eigen sleutel)──▶ api.enablebanking.com ──▶ bank
```

**Open punten voor Enable Banking:** mag restricted mode door eindgebruikers van onze software worden gebruikt
(hun documentatie noemt het "testen met eigen rekeningen" en "internal testing purposes")? Zijn
`127.0.0.1`-redirects toegestaan? Welke Nederlandse banken? Zonder ja op de eerste vraag laten we deze route
vallen.

---

## Wat er in de app moet veranderen (voor beide)

`OpenBankingProvider` gaat uit van `startConsent` → `completeConsent` → `fetchTransactions`. Dat past op beide,
met een verschil: bij Ponto kiest de gebruiker de bank in het Ponto-dashboard en niet in onze app.

| Onderdeel | Doel |
|---|---|
| Interface | `startConsent(bankId?)` wordt `startConsent(options)`. `listBanks` alleen waar de provider dat in onze app doet (Enable Banking). Toevoegen: `status()` (verbonden, rekeningen, verloopdatum), `disconnect()`, en een eigenschap `bankChoice: 'in-app' \| 'bij-aanbieder'`. |
| `src/integrations/ponto.ts` | Provider met transport via `FetchLike` (zoals `stripe.ts`): basis-URL is onze Worker. OAuth met PKCE, `POST /synchronizations` + pollen, transacties met cursor, mapping. |
| `src/integrations/enablebanking.ts` | Provider met JWT (Node `crypto`, RS256), `POST /auth`, `POST /sessions`, `continuation_key`, mapping. Transport rechtstreeks naar Enable Banking. |
| Mapping Ponto | `bankId` = transactie-`id`; `date` = `executionDate` (datum deel); `amount` = `Math.round(amount * 100)` (centen, het teken blijft); `counterIban` = `counterpartReference`; `counterName`; `description` = `remittanceInformation` of anders `description`; `reference` = `endToEndId`; `ownIban` = `reference` van de account. |
| Mapping Enable Banking | `bankId` = `entry_reference`; `date` = `booking_date`; `amount` in centen, negatief bij `DBTR`; `counter*` van `creditor` (uitgaand) of `debtor` (inkomend); `description` = `remittance_information` samengevoegd; alleen geboekte (`BOOK`) transacties, geen `PDNG`. |
| Opslag | `bank_connections`: provider, rekening-id's met IBAN, `valid_until`, laatste sync. Refresh token (Ponto) of applicatie-id en privésleutel (Enable Banking) in `secrets`. Migratie in `src/db/migrations.ts`. |
| Import | `BankService.import(..., source: 'openbanking')`: dezelfde matching, leveranciersgeheugen en ontdubbeling als CSV/CAMT. Ontdubbelen op `bankId`. Zie "Ontdubbelen" hieronder. |
| Synchronisatie | Bij opstarten en met een knop "Nu ophalen"; niet vaker dan toegestaan. |
| Verlopen toestemming | De app toont een taak "Bank opnieuw koppelen" in "Moet ik iets doen?", vanaf 14 dagen vóór het verlopen (Enable Banking: `valid_until`), of meteen bij `authorizationExpired`/`authorizationRevoked` (Ponto). Bestandsimport blijft werken. |
| IPC | Routes in `src/main/api.ts` (whitelist): `bank.verbinding.status`, `.start`, `.afronden`, `.ophalen`, `.verwijderen`, en bij Enable Banking `.instellen`. Geen geheimen naar de renderer. |
| UI | Bank → "Automatisch ophalen": kies Ponto (aanbevolen) of Enable Banking; stappenplan; status per rekening, verloopdatum, foutmeldingen in gewone taal. |
| Tests | Nep-`FetchLike` met opgenomen antwoorden; mapping van beide aanbieders (incl. afronding van `amount` naar centen, teken, meerdere omschrijvingen); paginering; ontdubbeling; verlopen toestemming; `state`-controle; bij Enable Banking JWT-claims. Een handmatig te draaien sandbox-test per aanbieder. |

### Ontdubbelen

`BankService.hash` telt identieke transacties per batch (`occurrence`). Zonder stabiele id is een overlappend
ophaalvenster daarom onveilig: twee gelijke betalingen op één dag worden verkeerd genummerd (de tweede wordt als
eerste gezien en overgeslagen, of dubbel geboekt).

- Beide aanbieders leveren een stabiele id (Ponto: `id`; Enable Banking: `entry_reference`). Die gaat als
  `bankId` mee, en dan geldt de id-hash en speelt het probleem niet.
- Ontbreekt de id (Enable Banking bij sommige banken): per rekening alleen **hele dagen** ophalen en opnieuw
  importeren, het venster begint altijd aan het begin van een dag, en de import geeft een waarschuwing.
- Een test bewijst dat twee identieke transacties op één dag, en een dag die twee keer wordt opgehaald, niets
  dubbel of niet toevoegen, met en zonder id.

## Privacy en veiligheid

- Alleen rekeninginformatie (saldi en transacties), nooit betalingen.
- Geen opslag van transacties bij ons. Ponto: alleen een doorgeefpost; het refresh token blijft in de app.
  Enable Banking: geen server van ons.
- Sleutels en tokens staan in `safeStorage`; op Linux zonder veilige backend (`basic_text`) weigert
  `SecretStore` het bewaren, zoals bij de andere koppelingen, en vallen we terug op bestandsimport.
- De gebruiker heeft een relatie met de aanbieder (Ponto of Enable Banking) en moet dat weten; dat staat in het
  stappenplan en in `site/privacy.html`.
- De lokale redirect-poort sluit direct na de terugkeer of na een time-out.
- Back-ups: geheimen volgen hetzelfde beleid als de andere geheimen. Bij herstel op een andere computer moet de
  gebruiker opnieuw toestemming geven.

## Volgorde

1. Vragen aan Ponto (en Enable Banking). Bij een nee op de certificaatvraag van Ponto: bepalen of een
   tussenstap acceptabel is, of Enable Banking de enige route wordt. Bij twee keer nee: geen live bankfeed.
2. Zelf uitproberen met de sandbox van Ponto en restricted mode van Enable Banking, nog geen code in de app.
3. Providerlaag, mapping en tests tegen opgenomen antwoorden, zonder UI. Eerst Ponto.
4. Doorgeefpost in de server-repo (alleen als Ponto dat vereist).
5. IPC, UI en de verloop-taak; proefadministratie-test en e2e met een nep-provider.
6. Stappenplan met schermafbeeldingen op de site; `site/privacy.html` en de README bijwerken.
