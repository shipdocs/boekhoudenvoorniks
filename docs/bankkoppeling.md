# Bankgegevens vanzelf binnen: afschriften uit de downloadmap en een live koppeling via Ponto

Status: **ontwerp, niets gebouwd.** `src/integrations/openbanking.ts` is alleen een interface met een lege
lijst (`OPEN_BANKING_PROVIDERS = []`); er is geen route, geen UI en geen test. In issue #13 is besloten dat
de app local-first blijft met bankafschriften (CSV, MT940, CAMT.053) als basis. Dit ontwerp verandert daar
niets aan: bestandsimport blijft altijd werken, en de live koppeling is een opt-in extra.

## Wat de gebruiker wil, en wat we daarvoor bouwen

Een stukadoor of loodgieter wil niet elke twee weken bij de bank een afschrift downloaden en in de app
slepen. Nu vraagt de app daarom na 14 dagen (`bank-stale`, `BANK_STALE_DAYS` in `src/inbox/inbox.ts`). En
wie van soort afschrift wisselt, kan nu dubbele of ontbrekende betalingen krijgen zonder het te merken.

We bouwen drie dingen, in deze volgorde:

| | **1. Betrouwbaar inlezen** | **2. Afschriften uit je downloadmap** | **3. Rechtstreeks van je bank via Ponto** |
|---|---|---|---|
| Wat de gebruiker merkt | Geen dubbele betalingen meer bij wisselen van soort afschrift, deelposten van CAMT compleet, en een melding als het saldo niet klopt | Afschrift downloaden bij de bank, verder niets: de app vraagt "Inlezen?" | Eén keer koppelen; daarna niets, behalve elke 180 dagen opnieuw toestemming geven |
| Voor wie | Iedereen, gratis | Iedereen, gratis | Met een abonnement (zie "Toegang") |
| Server van ons | Nee | Nee | Ja, een doorgeefpost zonder opslag |
| Afhankelijk van derden | Nee | Nee | Ja: Ponto moet ja zeggen op de vragen onderaan |

1 is nodig voor 2 en 3 en lost ook problemen van nu op. 2 helpt iedereen meteen en is de terugval als
Ponto nee zegt of een koppeling hapert. 3 is de echte oplossing voor wie er helemaal niet meer aan wil denken.

**Enable Banking valt af als route voor gebruikers.** Een eigen applicatie in restricted mode vraagt een
sleutelpaar, een Control Panel en redirect-URL's: dat is voor onze gebruikers niet te doen, en hun
documentatie noemt restricted mode bedoeld voor eigen rekeningen en intern testen. Enable Banking blijft
alleen denkbaar als **tweede aanbieder achter dezelfde Worker** (met een contract), als Ponto nee zegt. Andere
aanbieders vielen af: GoCardless Bank Account Data neemt geen nieuwe klanten meer aan; Tink, Yapily en
Finqware hebben vaste maandbedragen.

---

## 1. Betrouwbaar inlezen (voor alle bronnen)

### Het probleem

`BankService.hash` (`src/import/bank.ts`) ontdubbelt op de id van de bank als die er is, en anders op
datum, bedrag, tegenrekening, omschrijving en een volgnummer. Maar id, datum en tegenrekening verschillen per
bron:

| Bron | Id | Datum | Tegenrekening |
|---|---|---|---|
| CAMT.053 | `AcctSvcrRef` | boekdatum | ja |
| MT940 | bankreferentie | valutadatum | alleen bij gestructureerde `:86:` |
| CSV | geen | per bank anders (Knab transactiedatum, Revolut `Completed Date`) | niet bij ABN AMRO en Revolut |
| Ponto | eigen uuid | `executionDate` | meestal |

Dezelfde betaling uit twee bronnen komt er dus twee keer in, bijvoorbeeld bij een CSV en daarna een CAMT
over dezelfde weken, of bij de overstap naar Ponto. Ontdubbelen op "zelfde datum en bedrag" is geen
oplossing: een kaartbetaling van vrijdag heeft in de ene bron vrijdag en in de andere maandag, en zonder
tegenrekening verwisselt zo'n regel twee verschillende betalingen van hetzelfde bedrag.

**Bestaande fout:** een batchboeking in CAMT wordt in deelposten gesplitst (`src/import/camt053.ts`), maar alle
deelposten krijgen de `AcctSvcrRef` van de boeking. Ze hebben dus dezelfde hash, en alleen de eerste komt
erin; de rest telt als "al bekend".

### De regel: een betaling die er al staat, komt er niet nog een keer in

Elke import legt per rekening vast welke dagen hij besloeg (`import_batch_accounts.period_from` en
`period_to`; ook voor oude imports gevuld). Voor elke binnenkomende transactie, in deze volgorde:

1. **Zelfde hash als een bestaande, of als een eerder overgeslagen regel** (`import_skipped`): overslaan,
   zoals nu; een eerder overgeslagen regel weer tegen dezelfde tegenhanger.
2. **Valt de datum binnen de periode van een eerdere import** (van welke bron ook: ook een CSV met een andere
   indeling of een MT940 zonder bankreferentie heeft een andere hash): zoek een **tegenhanger** op dezelfde
   rekening met hetzelfde bedrag, dezelfde tegenrekening als ze er allebei een hebben, en een datum hooguit 3
   werkdagen ervandaan. Bij meer kandidaten eerst de dichtstbijzijnde datum. Geen tegenhanger kan zijn:
   - een bestaande transactie die al tegenhanger is van een overgeslagen regel in `import_skipped` (dat
     blijft zo, ook in latere imports), of in deze import al gekoppeld is of via stap 1 terugkwam;
   - een bestaande transactie **uit dezelfde bron met een eigen bank-id**, als de binnenkomende er ook een
     heeft: twee verschillende id's uit dezelfde bron zijn per definitie twee betalingen (twee keer € 50
     tanken bij hetzelfde station, twee dagen na elkaar, in overlappende Ponto-rondes). Daarvoor krijgt
     `bank_transactions` een kolom `bank_id` (nu staat alleen de hash erin); bestaande regels hebben die
     niet en tellen als "zonder bank-id".
   - Gevonden: niet toevoegen; hij "stond er al".
   - Niet gevonden: **wel toevoegen**, want dan miste de eerdere import hem waarschijnlijk.
3. **Daarbuiten** (een gat, of nieuwe dagen): gewoon toevoegen.

Omdat elke bestaande transactie maar één keer als tegenhanger telt, blijven twee echte gelijke betalingen
(twee keer € 25 aan dezelfde partij) er allebei in. Een verkeerde koppeling kan alleen bij twee verschillende
betalingen van hetzelfde bedrag binnen 3 werkdagen waarvan één in de eerdere import ontbrak; daarvoor zijn
*Toch toevoegen* en de saldocontrole.

Overgeslagen regels worden bewaard in een nieuwe tabel `import_skipped` (import, rekening, de transactie,
de tegenhanger). De samenvatting zegt het in gewone taal: "38 nieuwe betalingen. 12 stonden er al (uit je
afschrift van 1 t/m 15 september). 2 toegevoegd in een periode die al was ingelezen." met *Bekijken*; per
overgeslagen regel staat de tegenhanger ernaast, met *Toch toevoegen*. Niets verdwijnt dus stil.

**Deelposten van CAMT:** de eerste deelpost houdt precies de id die hij nu heeft (de `AcctSvcrRef` van de
boeking), zodat een eerder ingelezen afschrift niet dubbel wordt. Vanaf de tweede: de eigen `AcctSvcrRef` van
de deelpost als die bestaat en verschilt van die van de boeking, anders `AcctSvcrRef#2`, `#3`, ... Tests voor
alle drie de gevallen.

### Controle: klopt het saldo?

Nu worden eindsaldi uit CAMT en MT940 alleen bij de overstap-hulp gebruikt (`src/onboarding/switchover.ts`).
Nieuw is een taak op Vandaag, per rekening: "Knab zakelijk: volgens je bank € 4.210,55 op 29 september,
volgens de app € 4.185,55. Er mist waarschijnlijk een betaling van € 25,00." Berekening, zoals `sumSince` in
de overstap-hulp: beginsaldo (`openingBalance`) plus de som van alle transacties vanaf de datum van het
beginsaldo t/m de saldodatum, **met elke status** (ook `genegeerd`: een overgeslagen privébetaling ging wel
van de rekening af). Niet `statementBalance`, want die telt alles zonder datumgrens. Alleen als er een
beginsaldo is, alleen voor rekeningen in euro's, en per saldodatum maar één keer. Bij een verschil: de
overgeslagen regels uit `import_skipped` rond dat bedrag als eerste kandidaat, dan *Afschrift inlezen* of
*Dit klopt, negeren*.

De meeste CSV-exports hebben geen saldo (alleen Revolut), dus deze controle werkt vooral bij CAMT, MT940 en
Ponto. Dat is een reden te meer om in de uitleg per bank CAMT.053 aan te raden.

### Tests

CSV en daarna CAMT over dezelfde weken, en andersom; twee CSV's met een andere indeling over dezelfde weken;
een CAMT die een gat tussen twee CSV's vult; twee echte gelijke betalingen; twee keer € 50 aan dezelfde
IBAN twee dagen na elkaar, allebei uit Ponto, in overlappende rondes (allebei erin); een Ponto-kopie van een
CAMT-regel die is overgeslagen, en een ronde later een andere betaling van hetzelfde bedrag een dag later
(komt erin; de CAMT-regel blijft bezet); een kaartbetaling met drie dagen
verschil tussen transactie- en boekdatum; MT940 (valutadatum) na CAMT (boekdatum); een betaling die in de
eerdere import ontbrak (wordt toegevoegd); *Toch toevoegen*; CAMT-deelposten (drie gevallen, en een oud
afschrift niet dubbel); saldo klopt, klopt niet, met een genegeerde regel, en met een beginsaldo midden in de
periode.

---

## 2. Afschriften uit je downloadmap (gratis)

**Instelling** (Bank → *Afschriften vanzelf inlezen*, standaard uit): "Kijk in deze map naar nieuwe
afschriften". Standaard de Downloads-map (`app.getPath('downloads')`), te wijzigen. Bij het aanzetten
kijkt de app ook naar afschriften van de afgelopen 14 dagen.

**Werking**

- De app kijkt bij het opstarten en daarna met `fs.watch` (plus een controle elke paar minuten, omdat
  `fs.watch` niet overal betrouwbaar is) naar nieuwe bestanden met de extensie `.xml`, `.sta`, `.940`, `.txt`
  of `.csv`, kleiner dan 20 MB. Bestanden die nog downloaden (`.crdownload`, `.part`, of een grootte die nog
  verandert) slaat hij over tot ze klaar zijn. Wat al bekeken is, onthoudt hij op naam, grootte en
  wijzigingstijd, zodat hij niet elke keer alles opnieuw leest.
- Een bestand telt alleen mee als het bij de geopende administratie hoort: CAMT en MT940 met de IBAN van een
  rekening in de administratie, of een CSV die de app als bankexport herkent (ING, Rabobank, ABN AMRO, bunq,
  Knab, Triodos, Revolut, of kolommen uit `csv_mappings`) van een rekening die al in de administratie staat.
  Al het andere wordt genegeerd, zonder melding.
- **Niets gaat vanzelf de boeken in**: op Vandaag verschijnt "Nieuw afschrift gevonden: Knab zakelijk,
  1 t/m 29 september. [Inlezen] [Niet nu]". *Inlezen* gebruikt dezelfde route als slepen
  (`bank.importFile`), inclusief `autoProcess` en de regel uit deel 1. *Niet nu* vraagt het de volgende dag
  opnieuw; na drie keer niet meer voor dat bestand.
- De vraag "Download een nieuw afschrift" (`bank-stale`) krijgt per bank een korte uitleg waar je het
  afschrift vindt (CAMT.053 als de bank het heeft). Die teksten eerst per bank controleren.

**Privacy:** alles gebeurt lokaal. De app opent alleen bestanden met die extensies in de gekozen map om te
zien of het een bankafschrift is, en onthoudt van andere bestanden alleen dat ze geen afschrift zijn.

**Tests:** herkennen en negeren (vreemd bestand, andere IBAN, al gezien, nog aan het downloaden); de vraag
komt één keer; *Niet nu*; inlezen via de bestaande route; een e2e-test met een map vol bestanden.

---

## 3. Live koppeling via Ponto

### Hoe Ponto werkt (uit de documentatie, nog niet zelf uitgeprobeerd)

| Onderwerp | Stand |
|---|---|
| Identiteit van onze applicatie | Clientcertificaat met privésleutel (mTLS) plus client-id en -secret uit het Developer Portal van Isabel (Ibanity). Die horen bij **onze** applicatie. |
| Toestemming | OAuth2-code-flow met PKCE. De gebruiker maakt (als dat nog niet zo is) een Ponto-account, koppelt daar zijn bank en kiest welke rekeningen onze applicatie ziet. Wij krijgen een access token en een refresh token. **Bij elke vernieuwing komt er een nieuw refresh token; het oude vervalt.** |
| Rechten | Scopes alleen voor rekeninginformatie (`ai`) en `offline_access`; **nooit** `pi` (betalingen). |
| Gegevens | `GET /accounts` (IBAN, saldo met datum, laatste synchronisatie, verwachte verloopdatum van de toestemming); `GET /accounts/{id}/transactions` met cursor, nieuwste eerst. Ponto synchroniseert zelf een paar keer per dag; zelf een synchronisatie starten mag hooguit één keer per 30 minuten per rekening en vraagt het IP-adres van de gebruiker (`customerIpAddress`). |
| Transactie | `id` (uuid), `amount` (euro's, negatief bij afschrijving), `currency`, `counterpartName`, `counterpartReference` (IBAN), `remittanceInformation` en `remittanceInformationType` (gestructureerd of niet), `endToEndId`, `executionDate`, `valueDate`. Nog niet geboekte transacties staan apart. |
| Toestemming bij de bank | Maximaal 180 dagen; Ponto herinnert de gebruiker, verlengen gebeurt bij Ponto. |
| Kosten | Ponto rekent per gekoppelde rekening per maand, aan de gebruiker of aan de softwareleverancier. |
| Sandbox | Ja, met testdata. |

### Waarom een doorgeefpost, en hoe klein die blijft

Het certificaat en het client-secret mogen niet in de app: die gaat naar alle gebruikers en iedereen kan ze
eruit halen. Daarom komt er een **bank-Worker** in `shipdocs/boekhoudenvoorniks-server`, naast de licentie- en
assistent-Worker. Cloudflare Workers kunnen met een clientcertificaat naar buiten bellen (binding
`mtls_certificates`, geüpload met `wrangler mtls-certificate upload`); er is dus geen andere host nodig.

```text
app ──Bearer beheersleutel──▶ bank-Worker ──mTLS + client-secret──▶ Ponto ──▶ bank
                              (kent certificaat en secret; slaat niets op; logs uit)
```

**Routes (v1), en verder niets:**

| Route | Doet | Abonnement nodig |
|---|---|---|
| `POST /v1/ponto/token` | `code` + `code_verifier` + `redirect_uri` → access token (kort geldig) en refresh token | ja |
| `POST /v1/ponto/vernieuwen` | refresh token → nieuw access token en **nieuw** refresh token | ja |
| `POST /v1/ponto/intrekken` | refresh token intrekken bij Ponto (ontkoppelen) | **nee** |
| `GET /v1/ponto/accounts`, `GET /v1/ponto/accounts/{id}/transactions` | doorgeven met het access token van de app | ja |
| `POST /v1/ponto/accounts/{id}/synchronisatie` | synchronisatie starten, met `customerIpAddress` uit `CF-Connecting-IP` | ja |
| `GET /bank/terug` | statische terugkeerpagina (zie "Terugkeer naar de app") | nee |

- **Alleen lezen, afgedwongen in de Worker:** alleen deze paden en methoden; alles naar betaal-endpoints
  wordt geweigerd, ook als een token dat zou toestaan.
- **Geen opslag, geen logs.** Geen tokens, transacties of rekeningen in D1 of KV; `observability` uit. Het
  enige wat de Worker wegschrijft, is een telling per dag van aanroepen en foutcodes (Workers Analytics
  Engine), zonder administratie-ID of andere gegevens. Het
  access token gaat naar de app en blijft daar alleen in het geheugen (zonder ons certificaat is het buiten
  de Worker niet te gebruiken); het refresh token staat alleen in de app (`SecretStore`).
- **Toegang** zoals bij de assistent-Worker (`docs/jev-assistent.md`): administratie-ID plus de lokale
  beheersleutel; de Worker controleert via een Service Binding bij de licentie-Worker of er een actief
  abonnement is (402 als dat niet zo is). Rate limit per administratie. Te bevestigen als productbeslissing.
- **Kill switch:** `ENABLED` in de wrangler-config, standaard `"false"`; uit = 503. De app behandelt dat als
  een tijdelijke storing (zie hieronder) en afschriften blijven werken.

### De eenmalige koppeling, voor de gebruiker

1. **Bank → Rechtstreeks van je bank → Koppelen.** Eerst één scherm: wat er gebeurt ("De app kan je
   betalingen alleen lezen, nooit geld overmaken"), wat Ponto is en dat je daar een account maakt, dat de
   toestemming 180 dagen geldt, dat ophalen alleen gebeurt als de app openstaat, en wat het kost. De
   kostentekst hangt af van vraag 1 aan Ponto en moet kloppen met wat de gebruiker bij Ponto ziet. Knop
   *Verder naar Ponto*.
2. **De browser opent bij Ponto.** Daar: account maken of inloggen, bank kiezen, inloggen bij de bank,
   rekeningen aanvinken, toestemming voor BoekhoudenVoorNiks. De app toont intussen "Wachten op Ponto…"
   met *Annuleren*; na 30 minuten stopt het wachten vanzelf.
3. **Terug in de app, per rekening een vinkje:**
   - een rekening die al in de administratie staat (zelfde IBAN) staat aangevinkt;
   - een rekening die er nog niet in staat staat **uit**, met de vraag "Hoort deze rekening bij je
     bedrijf?" (een privérekening hoort er meestal niet in; een gemengde rekening mag, zoals nu).
4. **De aansluiting, in gewone taal:** "Je afschriften van Knab zakelijk lopen t/m 12 september. We halen op
   vanaf 12 september; wat er al staat, slaan we over." De datum is het einde van het laatst ingelezen
   afschrift (`MAX(period_to)` uit `import_batch_accounts`), niet de laatste betaling. Kan Ponto niet zo ver
   terug (vaak 90 dagen), dan zegt de app het: "1 t/m 20 juni ontbreekt: lees daarvoor nog een afschrift in."
   Zonder eerdere afschriften: vanaf de instapdatum, of zo ver terug als het kan.
5. **Klaar.** De eerste keer ophalen gebeurt meteen, met de gewone samenvatting en automatische verwerking.

Later een rekening toevoegen: *Rekening toevoegen* doet dezelfde stappen; bij Ponto vink je de extra rekening aan.

**Terugkeer naar de app.** Voorkeur: Ponto stuurt terug naar `http://127.0.0.1:<vrije poort>/bank/terug`
(RFC 8252); de app controleert `state` en rondt af met PKCE (`S256`). Staat Ponto geen `127.0.0.1` toe, dan
is de redirect-URL `https://<bank-Worker>/bank/terug`: een statische pagina, zonder logs, zonder externe
bestanden en met `Referrer-Policy: no-referrer`, die met `location` doorstuurt naar `127.0.0.1`; de poort zit
in `state`. Vóór het doorsturen staat op de pagina al: "Gebeurt er niets? Ga terug naar BoekhoudenVoorNiks en
klik nog een keer op Koppelen." (de pagina kan niet zien of de app nog luistert). Of je bij Ponto dan iets
opnieuw moet doen, proberen we in de sandbox uit. Een
onderschepte `code` is waardeloos zonder de `code_verifier`, die alleen de app kent. Geen eigen
`boekhoudenvoorniks://`-schema: dat registreren is op Linux (AppImage) onbetrouwbaar.

### Daarna: ophalen zonder dat de gebruiker iets doet

- **Wanneer:** bij het openen van de app en daarna elke 4 uur zolang hij openstaat, plus een knop *Nu
  ophalen*. Ophalen = lezen wat Ponto al heeft. Alleen *Nu ophalen* start zelf een synchronisatie, en de
  app bewaakt de 30 minuten per rekening (knop tijdelijk uit, met "kan weer om 14:35"). Alleen voor de
  geopende administratie, en nooit in de MCP-modus.
- **Eén tegelijk:** een vergrendeling als rij in de database met een vervaltijd van 10 minuten (na een
  crash blokkeert hij niet), zodat ook een tweede proces nooit tegelijk het refresh token vernieuwt.
- **Eén kopie haalt op.** Bij het koppelen maakt de app een willekeurige koppelsleutel en bewaart die
  **buiten de database** in de gegevensmap van de app (`userData`), per databasebestand; in de database staat
  alleen de hash. Alleen de kopie waarvan het databasebestand en de koppelsleutel bij elkaar horen, haalt op.
  Elke andere kopie (een back-up op een andere computer, een teruggezette back-up als tweede administratie,
  de kopie van vóór een update, een gedeelde map) toont "gekoppeld op een andere plek" en haalt niets op.
  Bij elk terugzetten van een back-up maakt de app een nieuwe koppelsleutel, zodat ook een back-up die op
  dezelfde plek wordt teruggezet (met een verouderd refresh token) niet ophaalt; een verplaatste
  administratiemap geeft hetzelfde. In beide gevallen is *Hier koppelen* één klik.
  *Hier koppelen* maakt een nieuwe toestemming; ziet de oude plek daarna een andere koppelsleutel in de
  database, dan trekt die zijn eigen token in (of dat de oude toestemming bij Ponto opruimt, hangt af van
  vraag 7).
- **Het nieuwe refresh token eerst bewaren:** na `vernieuwen` slaat de app het nieuwe refresh token op
  vóórdat hij iets anders doet. Mislukt dat, of komt het antwoord van de Worker niet aan, dan stopt de ronde
  en wordt de koppeling "opnieuw koppelen" (dezelfde flow, één klik).
- **Wat binnenkomt**, per rekening via `BankService.import(..., { bankAccountId })` met source
  `openbanking`, zodat matching, leveranciersgeheugen, `autoProcess` en de regel uit deel 1 dezelfde zijn als
  bij een afschrift:
  - pagineren van nieuw naar oud en stoppen bij de aansluitdatum of de laatst opgehaalde dag (min een paar
    dagen, want een bank boekt soms later); de hash op Ponto-`id` houdt dat dubbelvrij;
  - alleen geboekte transacties in euro's; een transactie in een andere valuta slaan we over met een
    waarschuwing, zoals bij CSV;
  - het geboekte saldo gaat naar de saldocontrole uit deel 1, zodat die ook bij de koppeling een ontbrekende
    betaling vindt (niet bij een rekening die niet in euro's is). Anders dan bij CAMT en MT940 is dat een
    saldo midden op de dag, dus het gaat niet als eindsaldo in `import_batch_accounts` maar in
    `bank_connection_accounts` (het laatste saldo met tijdstip, overschreven per ronde). De controle vergelijkt
    het met de transacties uit dezelfde ronde en maakt pas een taak als het verschil ook na de volgende ronde
    nog bestaat;
  - een importregel (`import_batches`) alleen bij nieuwe transacties; daarvoor krijgt `import()` een optie.
- **Op Vandaag:** bij "Automatisch gedaan" staat "8 betalingen opgehaald van Knab zakelijk (via Ponto)".
  De vraag "download een nieuw afschrift" verdwijnt voor gekoppelde rekeningen zolang de koppeling werkt.
- **Afschrift slepen blijft altijd kunnen**, ook met koppeling; de regel uit deel 1 vangt de overlap op, en
  zo vul je ook een gat vóór de aansluitdatum.

### Als er iets misgaat (teksten in gewone taal)

| Situatie | Wat de gebruiker ziet | Wat de app doet |
|---|---|---|
| Toestemming verloopt binnen 14 dagen | Taak "Knab: geef Ponto vóór 3 maart opnieuw toestemming" met knop naar Ponto | Blijft ophalen tot de datum |
| Toestemming verlopen of ingetrokken | Taak "Knab haalt niets meer op: opnieuw koppelen", met daaronder "of lees een afschrift in" | Stopt voor die rekening; de rest loopt door |
| Refresh token ongeldig of niet bewaard | Taak "Koppeling met Ponto opnieuw maken" (één klik, zelfde flow) | Verwijdert het oude token |
| Ponto of de bank tijdelijk storing | Niets, tenzij het langer dan 3 dagen duurt; dan "Knab: al 3 dagen niets opgehaald. Lees eventueel een afschrift in." | Probeert het bij de volgende ronde opnieuw |
| Geen internet | Niets | Volgende ronde |
| Abonnement gestopt | "Rechtstreeks ophalen staat stil sinds je abonnement stopte. Lees weer afschriften in, of sluit opnieuw een abonnement af." | Koppeling blijft 30 dagen bewaard; daarna trekt de app hem in (dat kan zonder abonnement) en zegt dat |
| Worker uitgezet (kill switch) | Na 3 dagen dezelfde melding als bij een storing | Terugval op afschriften |
| Geen veilige opslag (Linux zonder sleutelhanger) | Bij *Koppelen*: "Op deze computer kan de app de sleutel niet veilig bewaren. Gebruik afschriften of de downloadmap." | Koppelen kan niet |
| Gebruiker wil stoppen | *Ontkoppelen*: "De app haalt niets meer op; wat er al is, blijft staan." | Trekt het token in via de Worker en wist het |

### Wat er in de app verandert

| Onderdeel | Doel |
|---|---|
| Interface | `OpenBankingProvider` past niet meer: de bank kies je bij Ponto, en er is een vernieuwingsstap. Nieuw: `authorizeUrl(state, codeChallenge, redirectUri)`, `exchangeCode(...)`, `refresh(refreshToken)`, `accounts(accessToken)`, `transactions(accessToken, accountId, cursor?)`, `synchronize(...)`, `revoke(...)`. `listBanks` vervalt. |
| `src/integrations/ponto.ts` | Provider met transport via `FetchLike` (zoals `stripe.ts`); basis-URL is de bank-Worker. |
| Mapping | `bankId` = Ponto-`id`; `date` = `executionDate` (boekdatum, net als CAMT), anders `valueDate`; `amount` = `Math.round(amount * 100)` met teken; `counterIban` = `normalizeIban(counterpartReference)` als het een IBAN is; `counterName` = `counterpartName`; gestructureerde `remittanceInformation` → `reference` (zoals CAMT), anders → `description` (spaties samengevoegd); zonder `reference` → `endToEndId` tenzij `NOTPROVIDED`; lege `description` → `counterpartName` (zoals bij CSV); `ownIban` = IBAN van de Ponto-rekening. |
| Opslag (migratie in `src/db/migrations.ts`) | `bank_connections` (provider, status, hash van de koppelsleutel, laatste ronde, laatste fout, vergrendeling met vervaltijd) en `bank_connection_accounts` (koppeling ↔ `bank_account_id`, Ponto-rekening-id, aansluitdatum, laatst opgehaalde dag, verwachte verloopdatum, laatste synchronisatie, laatste saldo met tijdstip). Refresh token in `secrets`. `bank_transactions.source` kent `openbanking` al. |
| `BankService.import` | Regel uit deel 1, met de tabel `import_skipped` en de kolom `bank_transactions.bank_id` (migratie); optie om zonder nieuwe transacties geen importregel te maken. |
| Ophaaldienst | Main-proces: ronde bij openen en elke 4 uur, vergrendeling, token eerst bewaren, per rekening importeren, fouten naar de koppeling. |
| Taken | In `src/inbox/inbox.ts`: saldo klopt niet, verloopt binnenkort, opnieuw koppelen, langer dan 3 dagen niets, abonnement gestopt. `bank-stale` slaat werkende gekoppelde rekeningen over. |
| Klantkopie | `sanitizeForExchange` (`src/exchange/exchange.ts`) wist ook `bank_connections` en `bank_connection_accounts`; de beheersleutel gaat daar al weg. |
| IPC (`src/main/api.ts`, whitelist) | `bank.koppeling.status`, `.start`, `.rekeningen` (vinkjes bevestigen), `.ophalen`, `.verwijderen`, `.hierKoppelen`. Nooit tokens naar de renderer. |
| UI | Bank → *Afschriften vanzelf binnenhalen*: downloadmap en Ponto naast elkaar; per gekoppelde rekening status, "laatst opgehaald", verloopdatum en *Nu ophalen*. |
| Vlag | `BANK_FEED.available` (zoals `ONLINE_HELP` in `src/shared/online-help.ts`), standaard uit tot de proef klaar is. |

### Administraties, back-ups en de boekhouder

- **Per administratie** een eigen koppeling; tokens staan in de database van die administratie.
- **Kopie van een klant bij de boekhouder:** geen koppeling, geen taken (zie "Klantkopie").
- **Back-ups en kopieën:** alleen de plek met de koppelsleutel haalt op (zie "Eén kopie haalt op"); elders
  staat "gekoppeld op een andere plek". Een oudere back-up op dezelfde plek kan een verouderd refresh token
  bevatten: dan "opnieuw koppelen", er gaat niets verloren.
- **Afgesloten of uitgewisselde periode:** transacties komen binnen zoals bij een afschrift; de bestaande
  regels voor afgesloten periodes gelden.

### Tests

- Nep-`FetchLike` met opgenomen antwoorden uit de Ponto-sandbox: mapping (afronding naar centen, teken,
  lege tegenrekening, `NOTPROVIDED`, gestructureerde referentie, andere valuta), paginering tot de
  stopdatum, saldo als eindsaldo.
- Aansluiting: afschrift t/m 12 september, daarna Ponto vanaf 12 september: niets dubbel, niets kwijt,
  ook met twee gelijke betalingen op 12 september; een gat dat Ponto niet kan vullen wordt gemeld.
- Refresh token: nieuw token bewaard vóór de volgende aanroep; opslag mislukt of antwoord kwijt → opnieuw
  koppelen; twee processen tegelijk → één draait; vergrendeling verloopt na een crash; kopie zonder
  koppelsleutel (andere computer, back-up teruggezet als tweede administratie of op dezelfde plek, kopie van
  vóór een update) → haalt niets op;
  *Hier koppelen* → oude plek trekt zijn token in.
- `state` onjuist, time-out van de terugkeer, poort sluit na afloop.
- Foutcodes → juiste taak; kill switch → terugval; abonnement gestopt → na 30 dagen ingetrokken.
- Klantkopie bevat geen koppeling.
- Worker (privé-repo): alleen de toegestane paden, betaal-endpoints geweigerd, `intrekken` zonder
  abonnement, 402 op de rest zonder abonnement, geen logs.
- E2e met een nep-provider: koppelen, rekening aanvinken, ophalen, taak bij verlopen.
- Handmatig: sandbox-test per release die de koppeling raakt.

### Privacy en voorwaarden

- Alleen rekeninginformatie (saldi en transacties), nooit betalingen; afgedwongen in de scopes en in de Worker.
- De Worker verwerkt transacties onderweg maar bewaart en logt niets. `site/privacy.html` krijgt een eigen
  alinea (wat, waarom, geen opslag, Ponto als partij waarmee de gebruiker zelf een relatie aangaat), en de
  voorwaarden noemen dat de koppeling van Ponto en de bank afhangt en dat afschriften altijd de terugval
  zijn. Dit laten nakijken, en vastleggen welke rol wij hebben ten opzichte van Ponto.
- De lokale terugkeerpoort luistert alleen op `127.0.0.1` en sluit na de terugkeer of na 30 minuten.

---

## Vragen voor Ponto (vóór er iets van deel 3 gebouwd wordt)

1. Mogen wij als softwareleverancier de kosten per rekening betalen, zodat de gebruiker bij Ponto niets hoeft
   af te rekenen? Wat kost dat, en stopt de rekening als een gebruiker afhaakt zonder te ontkoppelen (app
   verwijderd)? Kunnen wij koppelingen zien en intrekken?
2. Is `http://127.0.0.1:<poort>` als redirect-URL in productie toegestaan? Zo niet: is één vaste
   `https`-URL genoeg?
3. Werkt het voor eenmanszaken en voor rekeningen op naam van een persoon? Welke Nederlandse banken zitten
   erin, en hoe betrouwbaar zijn ING en Rabobank via Ponto? Knab, bunq, Triodos, ABN AMRO, Revolut?
4. Welke rol hebben wij (verwerker, of alleen doorgeefpost voor de klant van Ponto), en is er een
   verwerkersovereenkomst? Waar staan de gegevens?
5. Refresh tokens: is er een korte periode waarin het oude token nog werkt, en wordt de hele toestemming
   ingetrokken als een oud token opnieuw wordt gebruikt?
6. Staat de verwachte verloopdatum van de toestemming per rekening in `GET /accounts`? Hoe ver terug gaan
   transacties bij de eerste keer? Kan een geboekte transactie achteraf nog veranderen?
7. Wat gebeurt er als dezelfde Ponto-organisatie in twee administraties wordt gekoppeld?

Bij een nee op vraag 3 (geen eenmanszaken of geen grote banken) bouwen we deel 3 niet; deel 1 en 2 staan dan
op zichzelf. Bij een nee op vraag 1 betaalt de gebruiker zelf bij Ponto, en het eerste scherm van de koppeling
legt dat uit.

## Volgorde van werken

Elke stap is een eigen PR met tests en een regel in `CHANGELOG.md`.

1. **Deelposten van CAMT** (bestaande fout) en **de regel "wat al ingelezen is, blijft staan"** (app).
2. **Saldocontrole** op Vandaag (app).
3. **Afschriften uit de downloadmap** (app, gratis), met de uitleg per bank bij `bank-stale`.
4. **Ponto:** de vragen hierboven stellen; ontwikkelaarsaccount; met de sandbox handmatig de hele flow
   doorlopen (ook de redirect en de rotatie van het refresh token) en antwoorden opnemen voor de tests.
   Stop hier bij een nee.
5. **Bank-Worker** (privé-repo): routes, mTLS-binding, toegangscontrole, rate limit, logs uit, kill switch
   uit. Deploy en de uitvoer van `wrangler` controleren; testen met de sandbox.
6. **Provider, opslag en ophaaldienst** (app) achter `BANK_FEED.available = false`, met de tests hierboven.
7. **UI, taken en e2e.**
8. **Site:** stappenplan met schermafbeeldingen, `site/privacy.html` en de voorwaarden bijwerken; README.
9. **Proef:** eerst op een eigen administratie met een echte bank, dan met een paar gebruikers. Daarna
   `BANK_FEED.available = true`.
