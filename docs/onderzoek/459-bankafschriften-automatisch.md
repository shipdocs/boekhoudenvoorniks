# Onderzoek #459: automatisch bankafschriften verwerken als gebruikersbehoefte

Datum: 17 oktober 2026. Basis: `main` op commit `8990de6`. De sitetekst uit §6 (behalve de SEO-suggestie) is verwerkt in dezelfde PR; nieuwe boekhoudlogica is niet gebouwd.
De reproducties staan in de bijlage (§7), niet als test in de repo.

## 0. Conclusie in het kort

- De zoekvragen uit GSC ("bankafschriften automatisch verwerken", "automatisch inlezen/importeren", "banktransactie automatisch inlezen") passen bij wat de app **al kan**. Je hoeft er dus geen nieuwe functie voor te bouwen. Er zijn drie routes: (1) een bestand slepen, (2) de downloadmap laten bewaken met één klik "Inlezen" op Vandaag, (3) Ponto, dat zelf ophaalt. Na elke route volgt dezelfde automatische verwerking.
- 50 vertoningen en 0 klikken is te weinig om een behoefte te bewijzen. De vertoningen landen op een pagina met "Ponto" in de titel (`/bank-ophalen.html`). De zoekwoorden gaan over afschriften en passen beter bij `/bank-automatisch.html`. Dat is een SEO- en tekstkwestie, geen gat in de functies.
- De code is uitgebreid en goed getest: 21 testbestanden met 451 tests, allemaal groen. Er zijn wel **een paar beweringen op de site te absoluut of onjuist**:
  1. "komt niet dubbel binnen" klopt niet in alle gevallen. Aangetoond: eerst Ponto zonder bewezen aansluiting, daarna een afschrift over dezelfde dagen. Dan komen beide regels erin. De app meldt ze wel als "dezelfde betaling?" en verwerkt ze niet vanzelf.
  2. "leest je afschriften vanzelf in vanuit een map" klopt niet. De app vindt het bestand vanzelf, maar de gebruiker kiest zelf "Inlezen".
  3. "betalingen worden (automatisch) gekoppeld" geldt alleen als de app zeker is, en bij de autopilotstand "voorzichtig" helemaal niet.
- Twee kleine gaten in de functies (alleen als voorstel, niet gebouwd): na een **ronde op de achtergrond** van Ponto start de automatische verwerking niet (die wacht tot de volgende ronde, tot zes uur later). En de bestandsextensies verschillen tussen slepen, de downloadmap en de herkenning van het formaat.

## 1. Inventaris

### 1.1 Afschriften inlezen (bestand)

| Onderdeel | Waar | Wat het doet |
|---|---|---|
| Formaat herkennen | `src/import/detect.ts:3-10` | XML met `camt.053`/`BkToCstmrStmt` geeft camt. `:20:`+`:25:`+`:61:` of een extensie `.sta/.mt940/.940/.swi` geeft mt940. `.csv/.txt` of een scheidingsteken in regel 1 geeft csv. Anders `onbekend`. |
| Eén route voor slepen en de map | `src/import/parse-file.ts:10-21`, `src/main/api.ts:277-292` (`importBankFile`) | Inlezen, CSV-toewijzing onthouden (`csv_mappings`), `bank.import`, `statementFolder.noteImported`, daarna `inbox.autoProcess()`. |
| CAMT.053 | `src/import/camt053.ts` | .001.02 t/m .08. Alleen `BOOK`-posten (regel 47). Eindsaldo `CLBD`. Batchboekingen worden gesplitst in deelposten met `batch.ref/total`. `bankId` = `AcctSvcrRef` (deelposten `REF#2…`). |
| MT940 | `src/import/mt940.ts` | Via `mt940-js`. Veld :86: zelf geparsed (`/CNTP/`, `/REMI/`, `/EREF/`, Rabobank-varianten). Eindsaldo `:62F:`. `bankId` = bankreferentie. |
| CSV | `src/import/csv.ts` | Bekende indelingen (`KNOWN_FORMATS`, r. 49-134): ING, Rabobank, ABN AMRO, bunq, Knab, Revolut, Triodos. Anders een gok (`guessMapping`) en de dialoog "Welke kolom is wat?" (`Bank.tsx:717`). Af/bij-detectie en een waarschuwing als alles één kant op gaat (#407). Een "indeling" (`csvLayout`) telt mee als soort afschrift voor het ontdubbelen. |
| Scherm | `src/renderer/screens/Bank.tsx:111` | DropZone `accept=".csv,.txt,.sta,.940,.mt940,.xml"`. Na het inlezen een melding: nieuw / stonden er al / toegevoegd in een al ingelezen periode / "Bekijken" / aantal automatisch verwerkt (r. 117-127). Regels die niet te lezen zijn: alleen een toast (r. 93). |
| Afschrift weghalen | `bank.ts:1799-1937` (`imports`, `removeImportPreview`, `removeImport`) | Alleen met "boekhouding voor de boekhouder" aan. Eerst een tegenboeking, bonnen terug naar controle, overgeslagen regels komen terug (#408). |
| Saldocontrole | `bank.ts:1327` (`balanceCheck`) | Het laatste eindsaldo van het afschrift tegen wat de app heeft. Een overgeslagen regel met precies het verschil is de eerste kandidaat. |
| Dekking | `bank.ts:1371` (`importStatus`) | `coverageFrom/To`, `completeTo` (een dag telt pas als hij is ingelezen ná die dag), `gap`. |

### 1.2 Ponto (open banking)

| Onderdeel | Waar | Wat het doet |
|---|---|---|
| Client | `src/integrations/ponto.ts` | OAuth-token met `expires_in` en verversen, scope `ai` verplicht (`pi` geweigerd). Cursorpaginering beperkt tot dezelfde origin (`complete=false` bij een lus of maxPages). Niet-EUR wordt overgeslagen. `bankId` = Ponto-id. |
| Service | `src/bankfeed/bankfeed.ts` | `test`, `saveLinks`, `save` (opslaan plus eerste ronde), `round`, `refreshNow` (Nu bijwerken: IP via Cloudflare-trace, twee synchronisaties, venster van 30 min), `remove`. Credentials alleen in `SecretStore`. |
| Ronde | `bankfeed.ts:748-905` | Alleen `actief` met een bankrekening. Venster `max(link_from, provenTo-7)`. Import met bron `openbanking`. **Zonder bewezen aansluiting wordt de dekkingsrij van die import gewist** (r. 863-866). Dekking schuift alleen op na een volledige, geslaagde ronde. Saldoafwijking pas na 2 vergelijkbare rondes. |
| Achtergrond | `src/main/main.ts:1030` → `src/main/background-feeds.ts:18-25`, gepland in `main.ts:1446-1449` | Bij het starten (+10 s) en daarna elke 6 uur, alleen als de app draait en niet alleen-lezen is. |
| IPC | `src/main/api.ts:2058-2105` | `opslaan`, `ophalen` en `bijwerken` roepen na nieuwe imports precies één keer `inbox.autoProcess()` aan (`autoNaFeedronde`, r. 319-329). |
| Taken op Vandaag | `src/inbox/inbox.ts` (feed-taken, o.a. r. 445 "Opnieuw plakken") | Toestemming vervalt binnen 14 dagen of is verlopen, credentials, rekening weg, stil > 3 dagen, saldoafwijking. |
| Scherm | `src/renderer/screens/PontoDialog.tsx` | Wizard 0-5, Nu ophalen (r. 322), Nu bijwerken met privacymodal (r. 229, 328), Opnieuw plakken (r. 323). |
| Vlag | `src/shared/bank-feed.ts` | `BANK_FEED.available = true` sinds 1.2.0. |

### 1.3 Herkennen en koppelen van betalingen

| Mechanisme | Waar | Regels |
|---|---|---|
| Verkoopfactuur / creditnota | `src/import/matching.ts:64-93` | Score: bedrag 50 (of totaal 35), factuurnummer in de omschrijving 60, IBAN van de klant 50, naam 15. Voorstel vanaf 40. |
| Inkoop / bon (aankoop) | `matching.ts:94-123`, `src/documents/bank-purchase-match.ts` | Bedrag (ook binnen koersmarge), leveranciersreferentie, IBAN alleen naast bedrag en datum, naam. Afgewezen paren komen niet terug (#221). |
| Grootboekvoorstel | `matching.ts:125-134` | "Zelfde als vorige keer", Belastingdienst, betaalprovider (kruisposten), bankkosten. |
| Automatisch koppelen | `matching.ts:139-170` | Drempel `AUTO_MATCH_THRESHOLD=100` → zekerheid 0,9. Twijfelmarge 30 halveert de zekerheid. Een regel die als mogelijke dubbel is vastgehouden, een eigen overboeking, of een aankoop waar ook een privé/contant-betaling bij past, wordt overgeslagen. |
| Automatisch boeken via leveranciersregel | `src/inbox/inbox.ts:591-651`, `src/intake/supplier-memory.ts:17,58` | Alleen een regel die `auto_approved` is zonder correcties (na 3 bevestigingen vraagt de app "voortaan automatisch?"). Nooit bij betalingen van vandaag, een vergrendelde periode, een eigen overboeking of betaling aan het eigen bedrijf, privéauto-brandstof, een aankoop die erbij kan horen, of een bon die op controle wacht. |
| Autopilotstand | `inbox.ts:596-598` | **`voorzichtig` koppelt en boekt niets vanzelf** (alleen herstel van dubbel geboekte aankopen). |
| Vaste lasten | `src/import/recurring.ts` | Minstens 3 betalingen met een vast interval, alleen een voorstel. |

### 1.4 Dubbelen voorkomen

| Situatie | Mechanisme (`src/import/bank.ts`) |
|---|---|
| Hetzelfde bestand opnieuw | Stap 1: `hash` (r. 549-554) op `bankId`, of op inhoud plus volgnummer binnen het bestand. Bestaat al → "stond er al". Getest: `import.test.ts` "ontdubbelt bij opnieuw importeren". |
| Hetzelfde bestand in de downloadmap | `content_hash` van het bestand (`statement-folder.ts:219-224`): al ingelezen → geen vraag. |
| Ander soort afschrift over dezelfde dagen (CSV ↔ CAMT ↔ MT940 ↔ Ponto) | Stap 2 (r. 752-851): alleen als de dag in een eerder **bewezen** periode valt (`inKnownPeriod`, r. 630: `import_batch_accounts` met `transactions > 0`) of tot 3 werkdagen rond een afschrift van een ander soort. Tegenhanger: zelfde rekening en bedrag, zelfde tegen-IBAN als beide er een hebben, ≤ 3 werkdagen. Gevonden → `import_skipped` (te bekijken, "Toch toevoegen"). |
| Verzamelbetaling (1 regel ↔ deelposten) | r. 776-799 en 837-851, plus de melding `batchDoubles` (r. 1020). |
| Wat er toch doorheen glipt | `paymentDoubles` (r. 1128) meldt het achteraf op Bank en Vandaag. `heldAsDouble` (r. 1188) houdt zo'n regel weg van automatisch verwerken. `assertNotHeld` blokkeert handmatig indelen tot de gebruiker heeft gekozen. |
| Ponto: dezelfde Ponto-id met een andere inhoud | Wordt niet stil overschreven (`bank-feed.test.ts` "veranderde inhoud"). Een id die voor een ander bedrag of een andere datum wordt hergebruikt, telt als regel zonder id (r. 701-710). |

### 1.5 Downloadmap bewaken

`src/import/statement-folder.ts`, `src/main/statement-watch.ts`, `Bank.tsx:341-372`, Vandaag-taak `inbox.ts:1188`.
- Staat standaard uit en is alleen aan te zetten voor de voorgestelde Downloads-map of een zelf gekozen map. Bij het aanzetten kijkt de app 14 dagen terug.
- Kijken: bij het starten, bij `fs.watch` (na 2 s), en elke 5 min (`statement-watch.ts:35,44`).
- Alleen `.xml .sta .940 .txt .csv` (r. 21), kleiner dan 20 MB, niet leeg, minstens 5 s ongewijzigd, en de grootte is tijdens het lezen niet veranderd.
- Herkend als afschrift "van deze administratie": CAMT/MT940 met het IBAN van een eigen rekening, of een CSV van een bekende bank of met eerder aangewezen kolommen van een rekening die er al is (r. 235-262). Er wordt niet op kolomnamen gegokt.
- Vraag "Nieuw afschrift gevonden: <rekening>, <periode>" met **Inlezen** of **Niet nu** (na 3 keer niet meer). De app verplaatst of wist nooit iets.

### 1.6 Tests

Gedraaid: `npx vitest run` op 21 bestanden (import, betrouwbaar-inlezen, csv-af-bij, dubbele-betaling, verzamelbetaling-dubbel, afschriften-downloadmap, afschrift-weghalen, bank-dekking, bank-feed (×7), ponto, bank-aankoop-koppeling, via-bank-onthouden, bank-nulbedrag, eigen-rekeningen, betaling-details). **451/451 groen** (26 s). De e2e-tests zijn niet gedraaid. Relevante e2e-specs: `bank-inlezen.spec.ts` (CSV dan CAMT, saldo, verzamelbetaling), `ponto-koppelen.spec.ts` (wizard, paginering, Nu bijwerken, toestemming), `afschriften-downloadmap.spec.ts`, `bank-bonnetjes.spec.ts`.

## 2. Gebruiksscenario's (zoals de app nu werkt)

### A. Ondernemer zonder bankkoppeling

1. **Bank** openen. Bij een nieuwe administratie staat er één rekening "Zakelijke rekening". Optioneel een beginsaldo invullen (nodig voor de saldocontrole).
2. In internetbankieren een afschrift downloaden: bij voorkeur CAMT.053, anders MT940, of een CSV.
3. Kies een van twee manieren:
   - **Slepen** op "Sleep je bankafschrift hierheen" (of klikken en kiezen).
   - **Downloadmap**: eenmalig "Afschriften vanzelf inlezen" aanzetten op Bank. Daarna verschijnt na het downloaden binnen seconden tot 5 minuten een toast en op Vandaag "Nieuw afschrift gevonden: Knab zakelijk, 1 t/m 29 september". Kies **Inlezen**.
4. Bij een CSV van een onbekende bank opent "Welke kolom is wat?". Je wijst één keer de kolommen aan en de app onthoudt ze per set kolomkoppen. Bij een bekende CSV waarin alles af of alles bij lijkt, vraagt de app eerst om de kolommen na te kijken.
5. De app kiest de rekening op IBAN. **Een onbekend IBAN levert vanzelf een nieuwe rekening "Rekening 1234" op** (`bank.ts:395`). Een privé-afschrift dat per ongeluk wordt gesleept, komt dus als extra bankrekening in de administratie.
6. Ontdubbelen (zie 1.4). De melding toont: X nieuw, Y stonden er al (uit welk eerder afschrift), Z toegevoegd in een al ingelezen periode, met de knop "Bekijken".
7. Automatisch verwerken: nulregels negeren, vaste lasten voorstellen, eigen overboekingen, facturen en aankopen koppelen die zeker zijn, en betalingen van leveranciers die je op automatisch hebt gezet boeken. Bij "voorzichtig" gebeurt niets vanzelf.
8. De rest staat als vraag op Vandaag en Bank ("Bij N hebben we je hulp nodig").
9. Controle: het eindsaldo van het afschrift tegen de app, de dekking "compleet t/m", en meldingen over dubbelen.

### B. Ondernemer met Ponto

1. Zelf bij Ponto een account aanmaken, de bank koppelen, een custom integration maken met alleen AIS, en Client ID en Client Secret noteren.
2. Bank, "Ponto instellen", wizard stap 0-5. Zonder veilige opslag (keychain) stopt het hier.
3. Plakken, dan "Verbinding testen". Per Ponto-rekening kiezen: bestaande rekening (alleen voorgesteld bij een exact gelijk IBAN), nieuwe rekening (nooit standaard), of niet gebruiken. Bij elke keuze staat of de aansluiting op je afschriften bewezen is.
4. "Koppelen en ophalen": opslaan, eerste ronde, en bij nieuwe regels meteen automatisch verwerken.
5. Daarna haalt de app zelf op bij het starten en elke ~6 uur, zolang de app open is. **Na zo'n achtergrondronde verwerkt de app nog niet vanzelf** (zie gat G1). "Nu ophalen" en "Nu bijwerken" doen dat wel meteen.
6. "Nu bijwerken" per rekening laat Ponto de bank verversen. Eenmalig verschijnt een privacymelding (IP-adres via Cloudflare), daarna 30 minuten wachten.
7. Op Vandaag staan taken bij: toestemming binnen 14 dagen of verlopen, credentials die niet meer werken ("Opnieuw plakken"), een rekening die weg is, langer dan 3 dagen stil, en een saldoafwijking na 2 rondes.
8. Een nieuwe rekening zonder afschrift blijft "niet aantoonbaar compleet". De app vraagt de periode te onderbouwen met een afschrift of beginsaldo. **Doe je dat met een afschrift over dagen die Ponto al ophaalde, dan komen die betalingen dubbel binnen en moet je ze per paar oplossen** (zie gat G2).

## 3. Site tegenover de code

Legenda: ✅ gedekt door code, ⚠️ te absoluut of onduidelijk, ❌ onjuist.

| Bestand:regel | Tekst (exact) | Oordeel | Onderbouwing |
|---|---|---|---|
| `site/bank-ophalen.html:140` | "De app haalt zelf betalingen op bij het starten en daarna ongeveer elke zes uur." | ✅ | `main.ts:1446-1449`, `background-feeds.ts:18-20`. Alleen als de app draait. |
| `site/bank-ophalen.html:132` en `site/index.html:405` | "de app haalt je betalingen zelf op en koppelt ze aan je facturen en bonnetjes" | ⚠️ | Koppelen alleen als de app zeker is (`matching.ts:154`), niets bij "voorzichtig" (`inbox.ts:598`), en na een achtergrondronde pas bij de volgende run (`main.ts:1015` loopt vóór `1030`). |
| `site/bank-ophalen.html:67, 141, 190`, `site/index.html:409` | "Een betaling die al uit een afschrift is ingelezen, komt niet dubbel binnen." | ⚠️ | In deze richting (eerst het afschrift, dan Ponto) klopt het voor de normale gevallen (`bank-feed.test.ts` "sluit gatloos aan…"; `betrouwbaar-inlezen.test.ts` "rechtstreeks van de bank"). Het is te absoluut: bij een datumverschil van meer dan 3 werkdagen of een ander tegen-IBAN komt de betaling er wel in (`bank.ts:819-823`), en wordt dan ook niet gemeld (reproductie B). In het algemeen beschermt een vangnet (melding en vasthouden), geen garantie. |
| `site/bank-automatisch.html:83, 173, 189` | "komt niet dubbel binnen, ook niet als je later Ponto aanzet" / "Geen dubbele betalingen" | ⚠️/❌ | Kopje "Geen dubbele betalingen" (r. 173) is **onjuist** voor de omgekeerde volgorde die de pagina zelf aanraadt ("Afschriften blijven de terugval", r. 177): eerst Ponto zonder bewezen dekking, dan een afschrift over dezelfde dagen geeft 4 regels in plaats van 2. Ze worden wel als 2 dubbelen gemeld en vastgehouden (reproductie E, met de echte `BankFeedService`; oorzaak `bankfeed.ts:863-866` met `bank.ts:630`). |
| `site/bank-automatisch.html:7` (meta) en `:140` (lead) | "leest je afschriften vanzelf in vanuit een map" / "de app leest afschriften die je downloadt vanzelf in vanuit een map" | ❌ | De app **vindt** het afschrift vanzelf en vraagt "Inlezen?". Inlezen gebeurt pas na een klik (`statement-folder.ts:13-18`, `Bank.tsx:372` "Er gaat niets vanzelf je boekhouding in"). De pagina zegt het zelf op r. 148 en 186. |
| `site/index.html:236` en `:666` | "de app kan afschriften vanzelf inlezen uit je downloadmap" | ❌ | Zelfde punt: vanzelf vinden, inlezen na één klik. `index.html:474` zegt het wel goed ("leest het na één klik in"). |
| `site/index.html:236` en `:666` | "Betalingen worden automatisch gekoppeld aan je facturen en bonnetjes." | ⚠️ | Alleen bij genoeg zekerheid. De rest wordt een vraag. Bij "voorzichtig" nooit. |
| `site/bank-automatisch.html:157` | "Klaar: de betalingen worden gekoppeld aan je facturen en bonnetjes." | ⚠️ | Zelfde punt. Regel 140 zegt het wel goed ("alleen wat niet zeker is komt als vraag"). |
| `site/bank-automatisch.html:155`, `index.html:236/473/666` | "een CSV van ING, Rabobank, ABN AMRO, bunq, Knab, Triodos of Revolut" | ⚠️ (niet aangetoond) | De indelingen bestaan (`csv.ts:49-134`). **Triodos heeft geen enkele test of fixture.** ABN AMRO wordt alleen getest met een zelfgemaakt tab-bestand **mét** kopregel (`tests/betrouwbaar-inlezen.test.ts:66`). De kolomnamen (`accountNumber`, `transactiondate`, …) lijken op de Excel-export van ABN AMRO. Die leest de app niet als bankbestand (geen `.xls/.xlsx` in DropZone of `parseBankFile`), en een TXT/TAB-export zonder kopregel zou niet worden herkend. Controleren met echte exportbestanden voordat de bewering zo blijft staan. |
| `site/bank-ophalen.html:83/174`, `bank-automatisch.html:165` | "Binnen 14 dagen voor die datum, en na het verlopen, zet de app een taak op Vandaag." | ✅ | `bank-feed-taken.test.ts` "waarschuwt op de grenzen 14 en 0 dagen". Vervaldatum wordt elke ronde ververst (#426). |
| `site/bank-ophalen.html:175` | "…meldt de app dat op Vandaag en kun je met Opnieuw plakken de twee gegevens vervangen." | ✅ | `inbox.ts:445`, `PontoDialog.tsx:323`. |
| `site/bank-ophalen.html:173/189` | IP via Cloudflare alleen bij Nu bijwerken, "laat dat eerst zien", niet bewaard | ✅ | `PontoDialog.tsx:328` (privacymodal), `bankfeed.ts` traceIp, `bank-feed-refresh.test.ts` "privacy". "Laat dat eerst zien" betekent: het feit dat het gebeurt, niet het IP-adres zelf. Dat mag duidelijker. |
| `site/bank-ophalen.html:142/191`, `bank-automatisch.html:174/190` | dekking, "tot welke datum … volledig", onderbouwen | ✅ | `importStatus`, `bankfeed.ts` covered_to, `bank-dekking.test.ts`, `bank-feed.test.ts`. |
| `site/bank-automatisch.html:148/185` | Downloads-map of map naar keuze, Vandaag-vraag, verplaatst of verwijdert nooit | ✅ | `afschriften-downloadmap.test.ts` (alle punten). |
| `site/bank-automatisch.html:191`, `index.html:252/668` | Afschrift weghalen vanaf 1.7.0 via "boekhouding voor de boekhouder" | ✅ | `afschrift-weghalen.test.ts`, `Bank.tsx:52`. |
| `site/index.html:244/667` | "laat de app vóór het inlezen zien wat ze van een CSV maakt" | ⚠️ | Geldt voor een **onbekende** CSV (dialoog) en voor een bekende CSV die één kant op gaat. Een gewone bekende CSV wordt meteen ingelezen zonder voorbeeld (`Bank.tsx:77-86`). De zin loopt verder met de voorwaarde, dus dit is verdedigbaar. |

## 4. Gaten, gevolgen voor de gebruiker, foutscenario's

### G1. Geen automatische verwerking na een achtergrondronde van Ponto
- Code: `main.ts:1015` (`autoProcess`) draait vóór `main.ts:1030` (`runBackgroundFeeds`). `background-feeds.ts` roept na `round()` geen `autoProcess` aan en stuurt ook geen `emit`. Het commentaar `bankfeed.ts` ("`autoProcess()` wordt hier niet aangeroepen") is bewust, maar de IPC-routes vangen het alleen bij een klik op.
- Gevolg: opgehaalde betalingen staan tot ~6 uur als "nieuw" voordat facturen en bonnen vanzelf worden gekoppeld (of tot de gebruiker "Opnieuw automatisch uitzoeken" kiest). Het scherm ververst ook niet vanzelf. Er gaat niets fout in de boekhouding. Het voelt alleen minder automatisch dan de site belooft.
- Voorstel (niet gebouwd): in `runBackgroundFeeds` na een ronde met `importedAny` één keer `inbox.autoProcess()` aanroepen en een event sturen, met dezelfde `autoNaFeedronde`-semantiek. Plus een test.

### G2. Eerst Ponto zonder bewezen aansluiting, daarna een afschrift over dezelfde dagen geeft dubbele regels
- Code: zonder `period` wist `bankfeed.ts:863-866` de `import_batch_accounts`-rij. Stap 2 van het ontdubbelen kijkt alleen naar dagen met zo'n rij (`bank.ts:630`, en `nearOtherKind` r. 632-635). Het afschrift ziet de Ponto-regels dus niet als tegenhanger, en de hash verschilt (Ponto-id ≠ bankreferentie).
- Reproductie E (echte `BankFeedService` en `BankService`): nieuwe rekening, ronde met 2 transacties (`coverage rows 0`, `completeTo null`), daarna een CAMT met dezelfde 2 betalingen. Uitkomst: `imported 2, duplicates 0, rows 4, paymentDoubles 2, held 2`.
- Gevolg: het vangnet werkt. Beide meldingen staan op Bank en Vandaag, de tweede regel wordt niet vanzelf verwerkt, en handmatig indelen wordt geblokkeerd. Maar tot de gebruiker per paar kiest, **telt het saldo dubbel** en moet hij bij veel betalingen veel paren afhandelen. Dit is precies de route die de app zelf aanraadt ("onderbouw met een afschrift") en die de site "terugval" noemt.
- Wanneer: elke nieuwe Ponto-rekening zonder eerder afschrift, en elke ronde met onvolledige paginering of onbruikbare metadata.
- Voorstel (aparte boekhoudlogica, niet gebouwd): bewaar voor een onbewezen Ponto-import wél een "waargenomen" periode (bijvoorbeeld een kolom `proven=0` in `import_batch_accounts`, of een aparte tabel). Die telt mee voor `inKnownPeriod`/`nearOtherKind`, maar niet voor `completeTo`. Dan valt het afschrift in stap 2 en worden de regels overgeslagen in plaats van toegevoegd. Eerst een regressietest schrijven die het huidige gedrag vastlegt.

### G3. Datumverschil van meer dan 3 werkdagen of een afwijkend tegen-IBAN tussen bronnen
- `SAME_PAYMENT_WORKDAYS = 3` (`bank.ts:102`), IBAN-veto r. 819. Reproductie B: CAMT op 1-10, Ponto op 7-10 (4 werkdagen), allebei erin, **geen melding** (`paymentDoubles 0`).
- Gevolg: een stille dubbel. De saldocontrole vangt het alleen als er een eindsaldo met een geboekt beginsaldo is (CAMT/MT940 of Ponto na 2 rondes). Bij een CSV zonder saldo vangt niets het op.
- Inschatting: zeldzaam (kaartbetaling over een lang weekend of feestdagen). `workdaysBetween` telt feestdagen niet, dus Pasen en Kerst maken het waarschijnlijker. Zo nodig documenteren, geen code.

### G4. Onterecht overgeslagen (wegvallende) betaling
- Zonder tegen-IBAN aan één kant telt alleen het bedrag binnen 3 werkdagen (`betrouwbaar-inlezen.test.ts` "zonder tegenrekening aan één kant telt alleen het bedrag"). Reproductie C: andere naam, geen IBAN, toch overgeslagen. Dat is terecht als het dezelfde betaling is. Twee echt verschillende betalingen met hetzelfde bedrag, waarvan er één in het eerdere afschrift ontbrak, kunnen zo wegvallen.
- Vangnet: `import_skipped` met "Bekijken" en "Toch toevoegen", en de saldocontrole noemt de overgeslagen regel als eerste kandidaat. Gedekt.

### G5. Gedeeltelijke import
- CSV-regels die niet te lezen zijn, worden overgeslagen met alleen een toast (`csv.ts:356-358`, `Bank.tsx:93`). De rest wordt ingelezen en de periode telt als "ingelezen". CAMT-posten die niet `BOOK` zijn, worden stil overgeslagen (`camt053.ts:47`), en komen bij een later afschrift alsnog mee. De import zelf is atomair (`tx`).
- Gevolg: bij een verkeerd datumformaat in een deel van de regels lijkt een periode compleet terwijl er regels missen. Zonder eindsaldo merkt niemand het. Opnieuw inlezen met een gecorrigeerde toewijzing geeft een andere `layout`, dus een ander soort afschrift, dus ontdubbelen via stap 2. Dat zou moeten werken, maar er is geen test voor.
- Voorstel (UI, niet gebouwd): het aantal niet-gelezen regels blijvend tonen in de importmelding of bij "Ingelezen afschriften", in plaats van alleen een toast.

### G6. Ponto: token, toestemming, verdwenen rekening
- Accesstoken: verversen op `expires_in` (`ponto.test.ts` "vernieuwt vóór expires_in"). Gedekt.
- Toestemming verlopen: taak op 14 en 0 dagen en daarna "verlopen". De vervaldatum wordt elke ronde ververst (#426). Gedekt (`bank-feed-taken`, `bank-feed` #426, e2e "verlopende toestemming").
- Credentials ongeldig of rekening weg: `errorKind`, taak met "Opnieuw plakken", status `weg`/`account-gone`. Gedekt.
- Na een gat door verlopen toestemming: een afschrift over het gat, daarna gaat Ponto verder met een overlap van 7 dagen op de bewezen grens. Gedekt in de basis ("sluit aan op completeTo en slaat een ouder open gat niet over"). Een test met echte overlappende betalingen in die 7 dagen ontbreekt.

### G7. Overlappende periodes met afschriften
- Hetzelfde soort met een dag overlap, ander soort, drie soorten in elke volgorde, verzamelbetalingen, weghalen en opnieuw inlezen: uitgebreid getest (`betrouwbaar-inlezen`, `dubbele-betaling`, `verzamelbetaling-dubbel`, `afschrift-weghalen`, e2e `bank-inlezen`). Gedekt.

### G8. Bestandsextensies niet consistent
- Herkenning van het formaat: `.sta .mt940 .940 .swi` (`detect.ts:7`). DropZone: `.csv,.txt,.sta,.940,.mt940,.xml` (geen `.swi`). Downloadmap: `.xml .sta .940 .txt .csv` (geen `.mt940`, geen `.swi`). Nergens `.tab`.
- Gevolg: een MT940-bestand met `.mt940` wordt wel gesleept maar in de map genegeerd. Een `.swi` wordt in het kiesvenster niet getoond. Een ABN AMRO-`.TAB` wordt nergens geaccepteerd. Klein, maar het valt precies onder "automatisch inlezen".
- Voorstel: één gedeelde lijst met extensies, plus een test die de drie plekken gelijk houdt.

### G9. Onbekend IBAN maakt stil een nieuwe rekening
- `bank.ts:384-396`: een gesleept afschrift met een onbekend IBAN maakt "Rekening 1234" aan (de downloadmap negeert zo'n bestand juist). Een privé-afschrift komt zo in de zakelijke administratie. Er is geen expliciete test gevonden voor deze aanmaak vanuit `import`.
- Voorstel (UI): bij een nieuw IBAN eerst vragen "Nieuwe rekening toevoegen?".

## 5. Regressietests: aanwezig en ontbrekend

Aanwezig (selectie): opnieuw inlezen (`import.test.ts`), 4 soorten afschrift in elke volgorde (`betrouwbaar-inlezen.test.ts`), Ponto naast afschriften (idem, "rechtstreeks van de bank"), aansluiting van Ponto op een afschrift (`bank-feed.test.ts`), onvolledige paginering, metadata, saldo na 2 rondes, toestemming en taken, privacy van het IP, downloadmap (alle randen), afschrift weghalen, verzamelbetalingen, af/bij-detectie, aankoopkoppeling, Revolut, ING- en Rabo-fixtures.

Ontbrekend (voorstel):
1. **Eerst Ponto zonder bewezen dekking, dan een afschrift over dezelfde dagen** (G2). Leg het huidige gedrag vast (gemeld en vastgehouden, saldo dubbel tot het is opgelost) en, na een eventuele fix, het gewenste gedrag (overgeslagen).
2. **Achtergrondronde met nieuwe transacties gevolgd door automatisch verwerken** (G1): `runBackgroundFeeds` plus een open factuur, en verwachten dat er na de ronde wordt gekoppeld (faalt nu).
3. **Echte exportbestanden per bank**: Triodos (geen test), ABN AMRO TXT/TAB zoals de bank het levert, bunq en Knab als fixturebestand in plaats van in de test opgebouwd. Elk: herkend, af/bij goed, eigen IBAN, opnieuw inlezen geeft geen dubbel.
4. **Gelijke extensielijsten**: DropZone `accept`, `STATEMENT_EXTENSIONS` en `detectFormat` (G8).
5. **CSV deels onleesbaar, daarna opnieuw met een gecorrigeerde toewijzing** (andere layout): de eerder ingelezen regels worden niet dubbel en de ontbrekende komen erbij (G5).
6. **Datumverschil > 3 werkdagen tussen bronnen**: leg vast dat de saldocontrole (CAMT met eindsaldo) het verschil meldt, als enige vangnet (G3).
7. **Gat door verlopen toestemming**: afschrift over het gat, daarna een Ponto-ronde met 7 dagen overlap die echte betalingen bevat: geen dubbelen (G6).
8. **Gesleept afschrift met een onbekend IBAN**: maakt een rekening aan (huidig gedrag vastleggen) (G9).
9. **Autopilot "voorzichtig"**: na het inlezen wordt niets gekoppeld of geboekt, en de melding zegt "0 automatisch verwerkt" (bewering op de site, G-tekst).

## 6. Voorstellen voor sitetekst (alleen tekst)

Verwerkt in `site/index.html`, `site/bank-automatisch.html`, `site/bank-ophalen.html` en `site/llms*.txt`. Kern: "vanzelf inlezen" wordt "vanzelf vinden, na één klik inlezen". "Komt niet dubbel binnen" wordt "herkent de app, en vraagt bij twijfel". "Wordt gekoppeld" wordt "wordt gekoppeld als de app zeker is". SEO: geef `bank-automatisch.html` een title of meta met "bankafschriften automatisch verwerken/inlezen". Laat `bank-ophalen.html` bovenaan verwijzen naar de route zonder Ponto.

## 7. Bijlage: reproducties (niet in de repo)

`exp/overlap.exp.test.ts` (BankService direct) en `exp/feed.exp.test.ts` (echte BankFeedService met nep-client). Draaien met
`npx vitest run` met een eigen config die deze bestanden oppikt:

```
A imported2 2 dups 0 rows 4 doubles 2 held 2      # openbanking zonder dekkingsrij, dan CAMT
B imported2 1 rows 3 doubles 0                    # 4 werkdagen verschil: stille dubbel
C imported2 0 skipped 1 rows 2 doubles 0          # geen IBAN, andere naam: overgeslagen
D imported2 1 dups 2                              # zelfde CSV-indeling opnieuw: ok
E round imported 2 coverage rows 0 … completeTo null
E camt imported 2 duplicates 0 rows 4 paymentDoubles 2 held 2
```

### overlap.exp.test.ts

```ts
import { describe, expect, it, vi } from '/home/user/boekhoudenvoorniks/node_modules/vitest/dist/index.js';
import Database from '/home/user/boekhoudenvoorniks/node_modules/better-sqlite3';
import { migrate } from '/home/user/boekhoudenvoorniks/src/db/database';
import { createServices, MemorySecretStore } from '/home/user/boekhoudenvoorniks/src/services';
import { BANK_FEED } from '/home/user/boekhoudenvoorniks/src/shared/bank-feed';

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  const s = createServices(db, { pdf: async () => Buffer.from('PDF'), mailerFactory: async () => { throw new Error('x'); }, secrets: new MemorySecretStore(), fetch: async () => { throw new Error('x'); }, storeFile: async (n: string) => `/tmp/${n}`, licensePublicKey: '' } as any);
  return s;
}
const IBAN = 'NL91ABNA0417164300';
const t = (date: string, amount: number, extra: any = {}) => ({ date, amount, counterIban: 'NL44RABO0123456789', counterName: 'Koffiehoek', description: 'Betaling', reference: null, ownIban: IBAN, ...extra });

describe('experiment', () => {
  it('A: Ponto-achtig (openbanking, zonder dekkingsrij) eerst, dan CAMT over dezelfde dagen', () => {
    const s = setup();
    const acc = s.bank.addAccount('Zakelijk', IBAN);
    const id = acc.id;
    // nabootsen wat roundAccount doet zonder bewezen periode: import en dekkingsrij weghalen
    const r1 = s.bank.import({ source: 'openbanking', warnings: [], transactions: [t('2026-10-05', -3500, { bankId: 'uuid-1' }), t('2026-10-06', 12100, { bankId: 'uuid-2', counterIban: 'NL02RABO0000000001', counterName: 'Klant' })] }, { bankAccountId: id });
    s.db.prepare('DELETE FROM import_batch_accounts WHERE batch_id = ?').run(r1.batchId);
    const r2 = s.bank.import({ source: 'camt', warnings: [], transactions: [t('2026-10-05', -3500, { bankId: 'REF-A' }), t('2026-10-06', 12100, { bankId: 'REF-B', counterIban: 'NL02RABO0000000001', counterName: 'Klant' })] }, {});
    const n = (s.db.prepare('SELECT COUNT(*) n FROM bank_transactions').get() as any).n;
    console.log('A imported2', r2.imported, 'dups', r2.duplicates, 'rows', n, 'doubles', s.bank.paymentDoubles().length, 'held', s.bank.heldAsDouble().size);
  });
  it('B: CAMT eerst, dan openbanking met datum 4 werkdagen later', () => {
    const s = setup();
    const acc = s.bank.addAccount('Zakelijk', IBAN);
    const id = acc.id;
    s.bank.import({ source: 'camt', warnings: [], transactions: [t('2026-10-01', -3500, { bankId: 'REF-A' }), t('2026-10-09', -100, { bankId: 'REF-Z' })] }, {});
    const r2 = s.bank.import({ source: 'openbanking', warnings: [], transactions: [t('2026-10-07', -3500, { bankId: 'uuid-1' })] }, { bankAccountId: id });
    const n = (s.db.prepare('SELECT COUNT(*) n FROM bank_transactions').get() as any).n;
    console.log('B imported2', r2.imported, 'rows', n, 'doubles', s.bank.paymentDoubles().length);
  });
  it('C: CAMT eerst, dan openbanking zonder tegen-IBAN maar andere naam', () => {
    const s = setup();
    const acc = s.bank.addAccount('Zakelijk', IBAN);
    const id = acc.id;
    s.bank.import({ source: 'camt', warnings: [], transactions: [t('2026-10-01', -3500, { bankId: 'REF-A', counterName: 'CCV*KOFFIEHOEK AMS', description: 'Betaalautomaat', counterIban: null }), t('2026-10-09', -100, { bankId: 'REF-Z' })] }, {});
    const r2 = s.bank.import({ source: 'openbanking', warnings: [], transactions: [t('2026-10-02', -3500, { bankId: 'uuid-1', counterIban: null, counterName: 'Koffiehoek', description: 'Koffiehoek Amsterdam NLD' })] }, { bankAccountId: id });
    const n = (s.db.prepare('SELECT COUNT(*) n FROM bank_transactions').get() as any).n;
    console.log('C imported2', r2.imported, 'skipped', r2.skipped, 'rows', n, 'doubles', s.bank.paymentDoubles().length);
  });
  it('D: zelfde CSV opnieuw met een regel verwijderd/bewerkt (partiele export)', () => {
    const s = setup();
    const acc = s.bank.addAccount('Zakelijk', IBAN);
    s.bank.import({ source: 'csv', layout: 'L1', warnings: [], transactions: [t('2026-10-01', -3500), t('2026-10-02', -200)] }, {});
    const r2 = s.bank.import({ source: 'csv', layout: 'L1', warnings: [], transactions: [t('2026-10-01', -3500, { description: 'Betaling ' }), t('2026-10-02', -200), t('2026-10-03', -50)] }, {});
    console.log('D imported2', r2.imported, 'dups', r2.duplicates);
  });
});
```

### feed.exp.test.ts

```ts
import { describe, expect, it, vi } from '/home/user/boekhoudenvoorniks/node_modules/vitest/dist/index.js';
import Database from '/home/user/boekhoudenvoorniks/node_modules/better-sqlite3';
import { migrate } from '/home/user/boekhoudenvoorniks/src/db/database';
import { createServices, MemorySecretStore } from '/home/user/boekhoudenvoorniks/src/services';
import { BANK_FEED } from '/home/user/boekhoudenvoorniks/src/shared/bank-feed';
import { BankFeedService } from '/home/user/boekhoudenvoorniks/src/bankfeed/bankfeed';

const IBAN = 'NL91ABNA0417164300';
const NOW = new Date('2026-10-12T16:00:00Z');
const account = { id: 'acc-1', iban: IBAN, referenceType: 'IBAN', name: 'Zakelijk', holder: 'X', currency: 'EUR', subtype: null, deprecated: false, availability: 'available', balance: 100000, balanceAt: '2026-10-12T12:00:00.000Z', detailsSynchronizedAt: '2026-10-12T12:00:00.000Z', expiresAt: '2026-11-17' };
const t = (date: string, amount: number, bankId: string, extra: any = {}) => ({ date, amount, counterIban: 'NL44RABO0123456789', counterName: 'Koffiehoek', description: 'Betaling', reference: null, ownIban: IBAN, bankId, ...extra });

describe('feed', () => {
  it('E: nieuwe rekening alleen Ponto (geen bewezen dekking), daarna afschrift als onderbouwing', async () => {
    BANK_FEED.available = true;
    vi.useFakeTimers({ now: NOW });
    const db = new Database(':memory:'); db.pragma('foreign_keys = ON'); migrate(db);
    const secrets = new MemorySecretStore();
    const s = createServices(db, { pdf: async () => Buffer.from('PDF'), mailerFactory: async () => { throw new Error('x'); }, secrets, fetch: async () => { throw new Error('x'); }, storeFile: async (n: string) => `/tmp/${n}`, licensePublicKey: '' } as any);
    const read = { transactions: [t('2026-10-05', -3500, 'p-uuid-1'), t('2026-10-06', 12100, 'p-uuid-2', { counterIban: 'NL02RABO0000000001', counterName: 'Klant' })], skippedForeign: 0, complete: true, pages: 1, synchronizedAt: '2026-10-12T12:00:00.000Z', latestSynchronization: { id: 's', status: 'success', subtype: 'accountTransactions', errors: [] } };
    const feed = new BankFeedService({ db, secrets, bank: s.bank, settings: s.settings, now: () => NOW, client: () => ({ accounts: async () => ({ accounts: [account], scope: 'ai' }), transactions: async () => read }) as any } as any);
    await feed.test({ clientId: 'client-id-1234', clientSecret: 'geheim' });
    feed.saveLinks({ clientId: 'client-id-1234', clientSecret: 'geheim' }, [{ pontoId: 'acc-1', bankAccountId: 'nieuw' }]);
    const sum = await feed.round();
    const bankAccountId = (db.prepare('SELECT bank_account_id b FROM bank_feed_accounts').get() as any).b;
    console.log('E round imported', sum.accounts[0]?.imported, 'coverage rows', (db.prepare('SELECT COUNT(*) n FROM import_batch_accounts').get() as any).n, 'status', JSON.stringify(s.bank.importStatus().find((x) => x.bankAccountId === bankAccountId)));
    const r = s.bank.import({ source: 'camt', warnings: [], transactions: [t('2026-10-05', -3500, 'BANKREF-1'), t('2026-10-06', 12100, 'BANKREF-2', { counterIban: 'NL02RABO0000000001', counterName: 'Klant' })], balances: [{ ownIban: IBAN, date: '2026-10-06', amount: 8600 }] } as any, { filename: 'camt.xml' });
    console.log('E camt imported', r.imported, 'duplicates', r.duplicates, 'rows', (db.prepare('SELECT COUNT(*) n FROM bank_transactions').get() as any).n, 'paymentDoubles', s.bank.paymentDoubles().length, 'held', s.bank.heldAsDouble().size);
    vi.useRealTimers(); BANK_FEED.available = false;
  });
});
```
