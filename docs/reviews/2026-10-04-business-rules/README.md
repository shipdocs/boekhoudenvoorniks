# Onderzoek en overdracht — business rules, 4 oktober 2026

Dit dossier hoort bij [PR #274](https://github.com/shipdocs/boekhoudenvoorniks/pull/274).
Het bewaart het onderzoek vóór herstel, de gemaakte implementatiekeuzes en het bewijs na herstel,
zodat een volgende agent de wijzigingen kan beoordelen zonder de chatgeschiedenis.

## Vervolgcontrole van main na PR #276

De controle van `main` op commit `c71239c` bevestigde dat alle eerdere correcties zijn overgenomen,
maar vond een nieuwe fout in de leescontrole van investeringscredits. Lees
[de oorzaak, correctie en regressiebewijzen](creditcontrole-na-pr276.md): meerdere credits konden
ieder afzonderlijk passen, maar samen de kostprijs overschrijden en toch uit de btw-waarschuwing verdwijnen.

## Actuele vervolgcontrole na Claude’s review

Claude’s correcties uit [PR #275](https://github.com/shipdocs/boekhoudenvoorniks/pull/275) zijn meegenomen.
Lees eerst [de vervolgcontrole en overdracht](vervolg-na-claude.md): die beschrijft vijf resterende
fouten, het herstel, de migraties 35–36 en de nieuwe testuitslagen. De bestaande R01–R16-secties en
het oorspronkelijke bewijs hieronder blijven de historische eerste onderzoeksronde beschrijven.

## Begin hier

1. Lees deze overdracht, vooral de scenario's en afbakeningen per R01–R16.
2. Vergelijk de wijzigingen met de [oorspronkelijke bevindingen](bevindingen.json).
3. Lees [de 16 regressies](../../../tests/business-rules-review.test.ts),
   [de 20 grensgevallen](../../../tests/business-rules-boundaries.test.ts) en
   [de twee nieuwe browserproeven](../../../e2e/business-rules.spec.ts).
4. Gebruik [het manifest](bewijs/manifest.json) en de logs hieronder om resultaten te controleren.
5. Behoud de beschreven betekenis van peildatum, regelversie en individuele controles bij vervolgwerk.

## Waarom deze wijzigingen nodig waren

Een gebalanceerde journaalpost bewijst alleen dat debet en credit overeenkomen. De oorspronkelijke
code kon nog steeds een verkeerde btw-rubriek, aftrek, zakelijke verdeling of investeringskostprijs
boeken. Daarnaast gaven rapporten op dezelfde historische datum verschillende antwoorden en konden
onopgeloste posten of dubbele facturen uit controles verdwijnen.

Het onderzoek combineerde code-inspectie, de bestaande proefadministratie en testsuite,
16 gericht handmatig berekende regressies, vergelijking tussen grootboek en afgeleide overzichten,
en officiële fiscale bronnen. Er zijn **11 P1- en 5 P2-bevindingen**. Alle 16 nieuwe regressies
faalden op de uitgangsversie en slagen na de correcties. R13 beschrijft een controlepolicy;
R12 gebruikt een expliciete aanname over een volledig aan de ondernemer verlegde B2B-prestatie.

## Versies en bewijs

- Onderzochte uitgangsversie: `4ae07b77a3c51655f043d8b61094ba2ad6a912ce`.
- Geteste lokale correctiecommit: `dd5cc143d812ac1b7509e9a3ba92363a10dc426f`.
- Dezelfde correcties gepubliceerd als: `eff49d6b0d140867a602962f27e31a9986b9b087`.
- Beide correctiecommits hebben exact Git-tree `e17710c5a2ef897f8629cc4dcb1601ada5d5a172`.
  Het verschil in commit-ID komt door publicatie via de GitHub-verbinding met nieuwe commitmetadata.
- De eerste documentatiecommit `446a957` voegde alleen dit dossier toe. De resultaten hieronder gelden voor
  bovenstaande code; er zijn voor deze documentatietoevoeging geen nieuwe testuitslagen geclaimd.

[Het oorspronkelijke HTML-onderzoek](onderzoek-voor-herstel.html) en
[bevindingen.json](bevindingen.json) zijn ongewijzigde historische bewijsstukken.
Zinnen daarin zoals “tests falen” en “niets gepubliceerd” beschrijven de toestand **vóór herstel**.
De bronregels daarin verwijzen naar de uitgangscommit en zijn geen huidige regelnummers.

| Controle | Voor herstel | Na herstel | Bewijs |
|---|---|---|---|
| Bestaande unit-/integratiesuite, Europe/Amsterdam | 1.529 geslaagd, 1 mislukt, 4 overgeslagen; 1.534 totaal | Volledige suite inclusief nieuwe tests: 1.565 geslaagd, 0 mislukt, 5 overgeslagen; 1.570 totaal, 96 bestanden | [baseline](bewijs/baseline-unit.log), [finale suite](bewijs/unit-final.log) |
| Onafhankelijke R01–R16-regressies | 16 mislukt | Alle 16 geslaagd in de finale suite | [oorspronkelijk Vitest-JSON](bewijs/review-voor-herstel.json), [testbron](../../../tests/business-rules-review.test.ts) |
| UTC-controle van Ponto, review en grensgevallen | Ponto was afhankelijk van de hosttijdzone | 86 geslaagd | [UTC-log](bewijs/utc-final.log) |
| Volledige browser-E2E | Niet uitgevoerd in de eerste onderzoeksfase | 87 geslaagd | [E2E-log](bewijs/e2e-full.log) |
| Nieuwe browserproeven na laatste codewijziging/build | Nog niet aanwezig | 2 geslaagd | [finale E2E-log](bewijs/e2e-final.log) |
| TypeScript | Geslaagd, inclusief de nieuwe rode regressies | Geslaagd, exitcode 0 | [manifest](bewijs/manifest.json), [typecheck-output](bewijs/typecheck.log) |
| Productiebuild | Niet als herstelvalidatie uitgevoerd | Geslaagd | [buildlog](bewijs/build-final.log) |

De volledige E2E-suite liep vóór de laatste aanvullende auto-grensgevallen. Na de laatste codewijziging
zijn de volledige unit-/integratiesuite, UTC-selectie, TypeScript en build uitgevoerd; daarna zijn de
twee nieuwe E2E-scenario's opnieuw uitgevoerd. Bij tekstlogs zijn alleen spaties aan regeleinden en lege eindregels genormaliseerd; het manifest
bewaart waar nodig ook de originele hash. Uitslagen en foutmeldingen zijn behouden.
De logs zijn lokale resultaten, geen verklaring dat
alle GitHub-CI-, installer- of platformchecks groen zijn.

### Waarom de scanner-skip is veranderd

De enige bestaande fout onder Europe/Amsterdam was de scannerproef die naar `127.0.0.2` verhuist:
`fetch failed / UND_ERR_SOCKET`. Een **onafhankelijke HTTP-server** op dat adres bleek in deze
omgeving ook onbereikbaar, terwijl `127.0.0.1` wel werkte. De test controleert nu vooraf of die
transportmogelijkheid bestaat. Alleen bij een mislukte capability-probe wordt dit scenario met reden
overgeslagen. De productie-scanner is niet gewijzigd; op een host die het tweede loopback-adres
ondersteunt blijft de echte proef actief.

De finale vijf skips zijn vier bestaande skips plus deze omgevingafhankelijke skip.
Dit resultaat bewijst dus niet dat scanner-IP-verhuizing in deze omgeving is getest.
Een volgende agent moet die proef op een normale geschikte host laten lopen, niet de productiecode
aanpassen om de beperking van deze container te omzeilen.

## Ontwerpkeuzes die vervolgwerk moet respecteren

### Oude boekingen blijven reproduceerbaar

Nieuwe events krijgen regelversie **2026.3**. De oorspronkelijke compiler staat bevroren in
`src/core-ledger/rules-2026-2.ts`; `EventService.recompile` geeft de opgeslagen regelsversie door.
Wijzig niet achteraf de betekenis van oude events of bestaande definitieve journaalregels.
Een bewuste correctie via de app gebruikt tegenboeking en een nieuwe gebeurtenis met de nieuwe regels.
De grensgevaltest vergelijkt hercompilatie van een oud event met de legacycompiler.

Een afgeleid rapport of activaregister mag daardoor wél een betere aansluiting tonen. Dat is iets
anders dan een reeds ingediende aangifte of een historische journaalpost stil herschrijven.
Bij credits na eerdere afschrijving moeten eerdere afschrijving en vastgelegde investeringsaftrek
afzonderlijk worden beoordeeld; deze PR automatiseert die fiscale herziening niet.

### Eén peildatum, boekingshistorie als bron

Historische facturen en grootboeksaldi gebruiken gedateerde journaalregels, niet de actuele
betaaldstatus. Een toekomstige betaling, creditnota of tegenboeking mag de eerdere stand niet
uitwissen. De actuele algemene facturenlijst mag toekomstige definitieve facturen tonen;
`listOpen(asOf)` begrenst de factuurdatum. Grootboekbanksaldo en laatst geïmporteerd
afschriftsaldo blijven verschillende gegevens.

### Een controle beoordeelt posten, geen toevallig saldo

Vraagposten worden individueel bepaald met `src/core-ledger/open-items.ts`.
Tegengestelde onbekende posten blijven twee onbekende posten. Een oversla-redenenregistratie mag
alleen gelden voor de exact bijbehorende IDs en bedragen. Houd btw-controle, detaildialoog,
periodeafsluiting en boekhouderexport op dezelfde regel.
Dubbelwaarschuwingen zijn aanleiding om een boeking te beoordelen, niet om zonder keuze data te wissen.

### Ambiguïteit wordt een gebruikerskeuze

Een activacredit wordt alleen automatisch gekoppeld bij één passende kandidaat.
Meerdere mogelijkheden blijven zichtbaar en vragen een keuze in Investeringen.
Migratie **34**, `asset_credit_allocations`, bewaart die koppeling. Dubbele toewijzing is idempotent;
credits kunnen een kostprijs niet onder nul brengen en annulering of historische peildatum
verandert welke credits meetellen. Bewaar dit gedrag bij synchronisatie, export en read-only toegang.

Voor het autoforfait moet bekend zijn hoeveel aanschaf- en autokosten-btw is afgetrokken.
Ontbrekende gegevens mogen geen verzonnen zekere correctie opleveren. Handmatig opgegeven
historische aanschaf-btw en jaarlijkse kosten-btw zijn aparte velden.

## Bevindingen met vóór/na, oorzaak en regressie

Alle bedragen in deze uitleg zijn euro's; de testcode rekent in gehele centen.
De prioriteiten en originele scope hieronder komen uit het vastgelegde onderzoek.

### R01 (P2) — Herindeling van verkoop kan omzet en btw over verschillende rubrieken verdelen

**Scenario:** Boek € 109 bankverkoop met hoog. Gebruik de service om te corrigeren naar laag, met de oorspronkelijke omzetrekening.

**Vóór herstel:** Rubriek 1b: € 0 omzet en € 9 btw. De omzet blijft op de rekening voor 1a.

**Verwacht:** Na correctie: rubriek 1b € 100 omzet en € 9 btw.

**Oorzaak:** bookToAccount() kiest de canonieke omzetrekening bij de btw-code. reclassify() kopieert de aangeleverde rekening zonder dezelfde mapping.

**Gekozen correctie:** `reclassify` kiest bij verkoop opnieuw de canonieke omzetrekening die bij de btw-code hoort, net als de eerste boeking. Daardoor blijven omzetgrondslag en btw in dezelfde aangifterubriek.

**Waar:** `src/import/bank.ts`.

**Regressiebewijs:** De R01-regressie verwacht bij € 109 met laag tarief rubriek 1b: € 100 omzet en € 9 btw. De corresponderende R-test staat in `tests/business-rules-review.test.ts`; aanvullende proeven staan in `tests/business-rules-boundaries.test.ts`.

**Afbakening van het oorspronkelijke bewijs:** Servicefout gereproduceerd. De huidige normale reclassify-UI biedt kostencategorieën; directe verkoopcorrectie via die UI is hiermee niet aangetoond.

### R02 (P1) — Gemengde aankoop en terugbetaling laten onjuiste kosten en btw achter

**Scenario:** Boek −€ 121 telefoonkosten met 50% zakelijk gebruik. Boek daarna een volledige terugbetaling van € 121 op dezelfde kostenrekening, eveneens met 50%.

**Vóór herstel:** Kosten eindigen op −€ 50. De code neemt bij een positieve bankregel 100% zakelijk, ook als 50% is opgegeven.

**Verwacht:** Kosten, voorbelasting en privédeel moeten samen weer nul zijn: dezelfde aankoop is volledig terugbetaald.

**Oorzaak:** expense is uitsluitend waar bij amount < 0. Daardoor worden het expliciete percentage en het leveranciersgeheugen bij restituties genegeerd.

**Gekozen correctie:** Ook positieve kosten-/activarestituties nemen het expliciete zakelijke percentage of de onthouden leveranciersverdeling mee. De netto-, btw- en privéregels worden symmetrisch teruggenomen; een afgewezen bankboeking laat ook geen geleerd percentage achter.

**Waar:** `src/import/bank.ts`, `src/core-ledger/rules.ts`.

**Regressiebewijs:** R02 en grensgevallen voor een volledig terugbetaalde gemengde investering, onthouden leveranciersverdeling en transactionele afwijzing. De corresponderende R-test staat in `tests/business-rules-review.test.ts`; aanvullende proeven staan in `tests/business-rules-boundaries.test.ts`.

**Afbakening van het oorspronkelijke bewijs:** Bankservice gereproduceerd. Ook het btw- en privégedeelte volgen uit dezelfde onjuiste 100%-verdeling.

### R03 (P1) — Binnenlandse bankverkoop kan onder de KOR toch btw boeken

**Scenario:** Zet KOR aan en verwerk een gewone binnenlandse ontvangst van € 121 als verkoop met code hoog.

**Vóór herstel:** De verkoop wordt geaccepteerd en bevat btw. De factuurservice blokkeert een vergelijkbare factuur wel.

**Verwacht:** Blokkeer de onverenigbare keuze of vraag om een geldige verwerking zonder btw. Laat eerst een eventuele KOR-overschrijding beoordelen.

**Oorzaak:** bookSale() en bookToAccount() bewaken alleen de inkoopkant van KOR. SaleForm kiest standaard hoog en bevat geen KOR-controle.

**Gekozen correctie:** KOR-validatie beschermt `bookSale`, direct boeken en herindelen. Het verkoopformulier kiest onder KOR vrijgesteld en biedt alleen keuzes zonder binnenlandse btw. Dit modelleert geen historische KOR-deelname of automatische beoordeling van een drempeloverschrijding.

**Waar:** `src/import/bank.ts`, `src/renderer/screens/Bank.tsx`.

**Regressiebewijs:** R03 en grensgeval voor herindeling onder KOR: belastbare omzet geweigerd, vrijgestelde omzet mogelijk. De corresponderende R-test staat in `tests/business-rules-review.test.ts`; aanvullende proeven staan in `tests/business-rules-boundaries.test.ts`.

**Afbakening van het oorspronkelijke bewijs:** Bankservice gereproduceerd; SaleForm in Bank.tsx regels 694–726 toont de bijbehorende invoerroute. De KOR-regel is officieel geverifieerd.

### R04 (P1) — Investeringsregister mist niet-aftrekbare btw bij KOR en gemengd gebruik

**Scenario:** Machine € 1.000 excl. + € 210 btw, KOR en 50% zakelijk. Laat de aankoop als investering registreren.

**Vóór herstel:** Grootboek € 605; register € 500. Het verschil is € 105 niet-aftrekbare zakelijke btw.

**Verwacht:** Zakelijke kostprijs € 605, zowel in grootboek als register.

**Oorzaak:** AssetService zoekt niet-aftrekbare btw alleen op journaalregel id + 1. De compiler zet bij gemengd gebruik eerst een privéregel tussen netto en btw.

**Gekozen correctie:** De kostprijs combineert per investeringsregel het zakelijke netto en de bijbehorende niet-aftrekbare KOR-btw, ook wanneer er een privéregel tussen staat. Meerdere middelen op één factuur behouden hun eigen kostprijs.

**Waar:** `src/tax/assets.ts`.

**Regressiebewijs:** R04: € 605 in register én grootboek. Grensgeval met twee gemengde KOR-investeringen: € 605 en € 1.210. De corresponderende R-test staat in `tests/business-rules-review.test.ts`; aanvullende proeven staan in `tests/business-rules-boundaries.test.ts`.

**Afbakening van het oorspronkelijke bewijs:** Beide uitkomsten onafhankelijk vergeleken. Dit kan ook KIA en afschrijving beïnvloeden.

### R05 (P1) — Onduidelijke posten verdwijnen als zij elkaar wegstrepen

**Scenario:** Een onbekende uitgave van € 100 en een afzonderlijke onbekende ontvangst van € 100 staan op Vraagposten.

**Vóór herstel:** De rekening bevat twee actieve posten, maar de btw-controle ontbreekt. Het boekhouderpakket gebruikt eveneens saldo === 0 voor Niets meer bij weet ik nog niet.

**Verwacht:** Beide onopgeloste posten blijven zichtbaar en tellen mee in de controle, ook bij saldo nul.

**Oorzaak:** De controle beoordeelt alleen het nettosaldo; zij heeft geen individuele afhandelstatus.

**Gekozen correctie:** Eén gedeelde query volgt actieve vraagposten per boeking en houdt rekening met tegenboekingen op de peildatum. Controles en export gebruiken aantal en absolute omvang in plaats van alleen het nettosaldo.

**Waar:** `src/core-ledger/open-items.ts`, `src/btw/checks.ts`, `src/export/accountant-package.ts`, `src/main/api.ts`.

**Regressiebewijs:** R05: twee onopgeloste posten van tegengesteld € 100 blijven zichtbaar bij saldo nul. De corresponderende R-test staat in `tests/business-rules-review.test.ts`; aanvullende proeven staan in `tests/business-rules-boundaries.test.ts`.

**Afbakening van het oorspronkelijke bewijs:** Twee actieve regels en het ontbrekende signaal zijn gereproduceerd. De fout in het exportlabel is statisch bevestigd in accountant-package.ts regel 416.

### R06 (P1) — Overgeslagen waarschuwing kan voor een andere post blijven gelden

**Scenario:** Sla de vraagpostcontrole voor onbekende post A van € 100 over. Deel A goed in en voeg vervolgens een andere onbekende post B van € 100 toe.

**Vóór herstel:** De nieuwe waarschuwing blijft skipped = true.

**Verwacht:** B is niet door de gebruiker beoordeeld; de waarschuwing moet terugkomen.

**Oorzaak:** De fingerprint is alleen String(vraag). De identiteit en inhoud van de posten ontbreken. De bank-open-controle gebruikt eveneens slechts count en sum.

**Gekozen correctie:** De fingerprints voor vraagposten en onverwerkte bankregels bevatten de concrete IDs en bedragen in stabiele volgorde. Een skip geldt alleen zolang diezelfde situatie bestaat; hetzelfde totaal geeft een nieuwe post geen impliciete goedkeuring.

**Waar:** `src/btw/checks.ts`.

**Regressiebewijs:** R06: A herindelen en vervangen door B met hetzelfde bedrag laat de waarschuwing terugkomen. De corresponderende R-test staat in `tests/business-rules-review.test.ts`; aanvullende proeven staan in `tests/business-rules-boundaries.test.ts`.

**Afbakening van het oorspronkelijke bewijs:** Vraagpostvariant gereproduceerd. Hetzelfde risico bij andere fingerprints is code-inspectie en vraagt aparte regressies.

### R07 (P2) — Historische openstaande facturen gebruiken huidige betaaldstatus

**Scenario:** Factuur € 121 op 1 februari, betaald op 1 maart. Vraag dashboard met peildatum 28 februari.

**Vóór herstel:** Debiteurenkaart € 121; dashboard € 0 open.

**Verwacht:** Op 28 februari € 121 open; dezelfde uitkomst als historische debiteurenkaart.

**Oorzaak:** listOpen(asOf) gebruikt het huidige amount_paid en status. asOf beïnvloedt alleen de vervallen-weergave, niet de historische betalingsstand.

**Gekozen correctie:** Open factuurbedragen worden per peildatum uit debiteurenregels met `source_ref = invoice:<id>` berekend, inclusief deelbetalingen, tegenboekingen en creditverrekening. Historische lijsten begrenzen ook de factuurdatum; de actuele algemene lijst mag toekomstige definitieve facturen bevatten. Een overbetaling maakt een factuur betaald.

**Waar:** `src/documents/invoices.ts`.

**Regressiebewijs:** R07 plus grensgevallen: € 121 vóór betaling, € 71 na € 50 deelbetaling, nul na restbetaling; toekomstige credit wist eerdere debiteur niet; overbetaling en toekomstige definitieve factuur. De corresponderende R-test staat in `tests/business-rules-review.test.ts`; aanvullende proeven staan in `tests/business-rules-boundaries.test.ts`.

**Afbakening van het oorspronkelijke bewijs:** Interne historische API gereproduceerd. De test bewijst een peildatum-inconsistentie, geen fout in iedere huidige openstaande-facturenlijst.

### R08 (P2) — Maandomzet en jaaromzet gebruiken verschillende einddatums

**Scenario:** Twee facturen van € 100 excl. op 1 en 20 februari. Vraag dashboard met peildatum 10 februari.

**Vóór herstel:** Dit jaar € 100; deze maand € 200. De huidige maand in revenueByMonth loopt eveneens tot maandultimo.

**Verwacht:** Tot de peildatum zowel deze maand als dit jaar € 100.

**Oorzaak:** YTD eindigt bij asOf; revenueThisMonth en maandreeks gebruiken period.end en tellen toekomstige posten mee.

**Gekozen correctie:** Maandomzet, maandreeks en grootboekbanksaldo eindigen op de gekozen peildatum. Het afschriftsaldo blijft het laatst geïmporteerde banksaldo; dat heeft een andere betekenis en wordt niet als historisch grootboeksaldo gepresenteerd.

**Waar:** `src/dashboard/dashboard.ts`.

**Regressiebewijs:** R08: per 10 februari is zowel maand- als jaaromzet € 100, ook als op 20 februari nog € 100 wordt gefactureerd. De corresponderende R-test staat in `tests/business-rules-review.test.ts`; aanvullende proeven staan in `tests/business-rules-boundaries.test.ts`.

**Afbakening van het oorspronkelijke bewijs:** Service-output gereproduceerd. Bij alleen boekingen tot vandaag is het verschil niet zichtbaar.

### R09 (P1) — Dubbelcontrole rond kwartaalgrens hangt af van invoervolgorde

**Scenario:** Twee dezelfde aankopen van dezelfde leverancier: 1 juli wordt eerst ingevoerd, daarna 30 juni. Controleer Q3.

**Vóór herstel:** Geen dubbelpaar. Bij de omgekeerde invoervolgorde kan het paar wel worden gevonden.

**Verwacht:** Het paar wordt in Q3 gemeld omdat één van de twee aankopen in Q3 valt.

**Oorzaak:** De query sorteert op id en vergelijkt alleen eerdere ids met b, terwijl b binnen de gekozen periode moet vallen. Een later ingevoerde juni-post wordt daardoor overgeslagen.

**Gekozen correctie:** De achterafcontrole behandelt factuurparen symmetrisch: minstens één datum moet in de gecontroleerde periode vallen. De invoervolgorde/ID-volgorde kan het paar niet meer uitsluiten. Een signaal leidt tot beoordeling, niet tot automatische verwijdering.

**Waar:** `src/documents/bank-purchase-match.ts`.

**Regressiebewijs:** R09: eerst 1 juli invoeren, daarna 30 juni; de Q3-controle meldt het paar. Dit bewijst niet dat iedere invoerroute of ieder gelijk bedrag een duplicaat is. De corresponderende R-test staat in `tests/business-rules-review.test.ts`; aanvullende proeven staan in `tests/business-rules-boundaries.test.ts`.

**Afbakening van het oorspronkelijke bewijs:** Dit betreft de achterafcontrole van al aanwezige aankopen. Andere invoerroutes bevatten voorafgaande dubbele-invoercontroles; de test bewijst niet dat die allemaal falen.

### R10 (P1) — Telefoonprivédeel kan dubbel worden gecorrigeerd

**Scenario:** Boek € 100 excl. btw telefoon met 50% zakelijk. Stel daarnaast Zakelijk deel telefoon & internet globaal op 50%.

**Vóór herstel:** Grootboekkosten € 50; jaaroverzicht telt daar nog € 25 privé bij, zodat slechts € 25 aftrekbaar blijft.

**Verwacht:** Het privédeel is al uit de kosten gehaald. Voor deze post geen extra fiscale privécorrectie.

**Oorzaak:** Het jaaroverzicht past het globale percentage toe op alle resterende telefoonkosten en herkent de al gesplitste gebeurtenis niet.

**Gekozen correctie:** De algemene telefoon-/internetcorrectie slaat boekingen met een expliciet zakelijk percentage over. Ook expliciet 100% en de bijbehorende tegenboekingen behouden die betekenis, zodat een algemene instelling geen tweede correctie toepast.

**Waar:** `src/tax/overview.ts`, `src/documents/purchases.ts`.

**Regressiebewijs:** R10: de resterende € 50 kosten krijgen geen extra € 25 privécorrectie. Grensgeval: wijzigen van 50% naar expliciet 100% blijft uitgesloten van de algemene correctie. De corresponderende R-test staat in `tests/business-rules-review.test.ts`; aanvullende proeven staan in `tests/business-rules-boundaries.test.ts`.

**Afbakening van het oorspronkelijke bewijs:** Fiscale bijtelling gereproduceerd. De btw-notitie gebruikt dezelfde globale correctie over de verkleinde grondslag.

### R11 (P2) — Service accepteert tegenstrijdige btw-code en btw-bedrag

**Scenario:** Geef rechtstreeks een inkoopregel met netto € 100, code geen en expliciete btw € 21 door.

**Vóór herstel:** De inkoop wordt geaccepteerd en voorbelasting wordt geboekt.

**Verwacht:** Afwijzen: de 0%-code en positieve voorbelasting zijn onverenigbaar.

**Oorzaak:** purchaseVat() geeft een expliciet bedrag ongecontroleerd terug. De latere grootboekvalidatie controleert centen en balans, niet de fiscale samenhang.

**Gekozen correctie:** `purchaseVat` valideert centraal de code, gehele centen, het teken en de maximale btw bij het gekozen tarief. Bij 0%-codes moet expliciete btw nul zijn. Maximaal twee cent overschrijding is toegestaan als afrondingstolerantie; het is geen eis dat ieder expliciet bedrag exact het maximum is. De legacycompiler blijft ongewijzigd.

**Waar:** `src/core-ledger/rules.ts`.

**Regressiebewijs:** R11 en grensgeval voor te hoge btw: afwijzing laat geen aankoop of journaalregels achter. De corresponderende R-test staat in `tests/business-rules-review.test.ts`; aanvullende proeven staan in `tests/business-rules-boundaries.test.ts`.

**Afbakening van het oorspronkelijke bewijs:** Directe service/API-invoer gereproduceerd. De gewone documentbevestiging bevat voor deze 0%-combinatie wél een guard; niet als een universele UI-fout behandelen.

### R12 (P1) — Gemengd gebruik verlaagt zowel verlegde btw-schuld als aftrek

**Scenario:** Een aan de onderneming gefactureerde EU-dienst van € 100 met 21% verlegging en 50% aftrekbaar zakelijk gebruik.

**Vóór herstel:** De compiler boekt € 10,50 verschuldigd en € 10,50 aftrekbaar. Er blijft geen btw te betalen over.

**Verwacht:** Bij verlegging over de volledige zakelijke factuur: € 21 verschuldigd, € 10,50 aftrekbaar; de overige € 10,50 is niet-aftrekbare btw.

**Oorzaak:** fullVat wordt eerst met businessPct vermenigvuldigd. Vervolgens gebruikt ook de verschuldigde verlegde btw die al verkleinde waarde.

**Gekozen correctie:** Volledige belastbare grondslag en verschuldigde verlegde btw worden afzonderlijk van de aftrek berekend. Bij € 100 en 50% zakelijk blijft € 21 verschuldigd en is € 10,50 aftrekbaar; niet-aftrekbare btw op het privédeel gaat naar privé. Aangifterubriek en detailregels gebruiken dezelfde volledige grondslag. Onder KOR blijft de schuld staan en is de aftrek nul.

**Waar:** `src/core-ledger/rules.ts`, `src/btw/btw.ts`.

**Regressiebewijs:** R12 plus grensgeval met en zonder KOR: grondslag € 100, schuld € 21, aftrek respectievelijk € 10,50 of nul, gebalanceerde journaalpost. De corresponderende R-test staat in `tests/business-rules-review.test.ts`; aanvullende proeven staan in `tests/business-rules-boundaries.test.ts`.

**Afbakening van het oorspronkelijke bewijs:** Code-uitkomst gereproduceerd. De fiscale verwachting is afgeleid van de Belastingdienst-regel over verlegging op het gefactureerde bedrag en beperkte aftrek. Aanname: de hele factuur betreft één aan de ondernemer verlegde prestatie; afzonderlijk privé afgenomen prestaties vragen eerst een andere fiscale beoordeling.

### R13 (P2) — Periodeafsluiting meldt onduidelijke aankopen niet

**Scenario:** Een open aankoop van € 100 staat op Vraagposten. Er zijn geen nieuwe bankregels of wachtende documenten.

**Vóór herstel:** checks() meldt niets over de vraagpost. De bestaande afsluitcontrole kijkt naar nieuwe bankregels, documenten en afschriftdekking.

**Verwacht:** Toon voor afsluiten een concrete controle op deze onduidelijke boeking; bepaal expliciet of overdracht aan de boekhouder met bevestiging mag.

**Oorzaak:** Afsluiting en btw/boekhoudercontroles gebruiken verschillende regels. Een onduidelijke maar technisch geboekte post kan tussen die regels vallen.

**Gekozen correctie:** Afsluiting gebruikt dezelfde individuele vraagpostencontrole en vraagt expliciete bevestiging bij onduidelijke posten. Dit is de gekozen controlepolicy: signaleren en bewuste overdracht toestaan, zonder een saldo-nul-uitzondering.

**Waar:** `src/closing/period-close.ts`, `src/core-ledger/open-items.ts`.

**Regressiebewijs:** R13 bewaakt aanwezigheid van de afsluitcontrole. De test legt gewenst controlebeleid vast; er was geen bestaande expliciete financiële rekenregel die dit vereiste. De corresponderende R-test staat in `tests/business-rules-review.test.ts`; aanvullende proeven staan in `tests/business-rules-boundaries.test.ts`.

**Afbakening van het oorspronkelijke bewijs:** Ontbrekend controlesignaal gereproduceerd. Dit is een beleids-/controlehiaat, geen fout in optellen of in een bestaande expliciete afsluitregel.

### R14 (P1) — Gedeeltelijke credit op investering wordt niet in register verwerkt

**Scenario:** Registreer een investering van € 1.000. Boek daarna een leverancierscredit van € 200 op dezelfde activarekening, vóór afschrijving.

**Vóór herstel:** Grootboek € 800; actieve kostprijs in register € 1.000. Er is geen koppeling die de credit aan het bedrijfsmiddel toerekent.

**Verwacht:** Register en grootboek moeten € 800 kostprijs tonen, of het register moet de ongekoppelde credit als onopgelost signaleren.

**Oorzaak:** sync() neemt alleen debetregels als nieuwe investering op en reageert op volledige tegenboekingen. Losse creditregels corrigeren geen bestaande kostprijs.

**Gekozen correctie:** Migratie 34 legt activacredits vast in `asset_credit_allocations`. Slechts één passende kandidaat wordt automatisch gekoppeld (rekening, leverancier, datum en beschikbare kostprijs); bij ambiguïteit kiest de gebruiker. Onverdeelde credits blijven een controlepunt. Toewijzing is idempotent, meerdere credits overschrijden de kostprijs niet, teruggedraaide credits vervallen en historische kostprijzen gebruiken alleen credits tot de peildatum. Read-only synchronisatie muteert niet.

**Waar:** `src/tax/assets.ts`, `src/db/migrations.ts`, `src/main/api.ts`, `src/renderer/screens/TaxYear.tsx`, `src/btw/checks.ts`, `src/tax/overview.ts`.

**Regressiebewijs:** R14: € 1.000 − € 200 = € 800. Grensgevallen voor meerdere middelen, dubbele toewijzing, terugdraaien, peildatum en maximale cumulatieve credits; browsertest voor de activakeuze. De corresponderende R-test staat in `tests/business-rules-review.test.ts`; aanvullende proeven staan in `tests/business-rules-boundaries.test.ts`.

**Afbakening van het oorspronkelijke bewijs:** Eén bedrijfsmiddel in het scenario; de juiste bestemming is daardoor ondubbelzinnig. Bij meerdere middelen moet de gebruiker de verdeling kiezen.

### R15 (P1) — Automatische btw-correctie auto houdt geen rekening met maximum

**Scenario:** Belastingdienstvoorbeeld: catalogus € 75.000, aankoop in 2025 met € 3.150 afgetrokken btw; in 2026 € 735 btw op onderhoud/gebruik. Forfait 2,7%.

**Vóór herstel:** De service stelt de correctie op € 2.025; in dit voorbeeld € 660 te hoog.

**Verwacht:** Correctie maximaal € 735 + € 3.150 / 5 = € 1.365.

**Oorzaak:** carPrivateUse() rekent alleen cataloguswaarde × percentage × maanden. Het model bevat geen bedragen voor de jaarlijkse maximale correctie. Ook de keuze 1,5% bij aankoop zonder btw-aftrek is niet afzonderlijk vast te leggen.

**Gekozen correctie:** De forfaitaire autocorrectie wordt begrensd door afgetrokken autokosten-btw plus tijdens de eerste vijf jaren 1/5 van de aanschaf-btw. Zonder aanschaf-btw-aftrek geldt de 1,5%-variant; na de herzieningsperiode zijn alleen jaarlijkse autokosten nodig voor het plafond. Gemengde bonnen tellen alleen afgetrokken btw op autokosten mee. Ontbrekende gegevens geven onbekend; historische/elders geboekte bedragen kunnen expliciet worden opgegeven. Nul is geldig en veroorzaakt geen lege journaalpost.

**Waar:** `src/btw/car.ts`, `src/settings/settings.ts`, `src/main/api.ts`, `src/renderer/screens/Settings.tsx`.

**Regressiebewijs:** R15: niet € 2.025 maar € 1.365 (€ 735 + € 3.150/5). Grensgevallen voor marge-auto, nulplafond, gemengde bon, na vijf jaar en meerdere auto's; browsertest voor aparte aanschaf-/kosten-btw-instellingen. De corresponderende R-test staat in `tests/business-rules-review.test.ts`; aanvullende proeven staan in `tests/business-rules-boundaries.test.ts`.

**Afbakening van het oorspronkelijke bewijs:** De uitkomst is gereproduceerd met exact het officiële voorbeeld. De notitie bij instellingen verwijst wel naar bijzondere gevallen; dat voorkomt de te hoge automatische boeking niet.

### R16 (P1) — Creditnota via documentcontrole kan niet worden bevestigd

**Scenario:** Leverancierscredit van −€ 121 met −€ 21 btw. Het controlescherm geeft dit expliciete btw-bedrag door aan confirm().

**Vóór herstel:** ValidationError: Het btw-bedrag kan niet meer zijn dan het totaal. Negatieve btw wordt altijd geweigerd.

**Verwacht:** De boeking moet € 100 kosten en € 21 voorbelasting terugnemen; een geldige creditnota moet kunnen worden bevestigd.

**Oorzaak:** De validatie gebruikt positieve factuurlogica: vatAmount < 0 en vatAmount > total. Het scherm berekent bij een creditnota juist een negatief bedrag.

**Gekozen correctie:** Documentbevestiging controleert teken en absolute omvang van de expliciete btw tegen het brutobedrag, zodat een leverancierscredit van −€ 121 met −€ 21 btw geldig is. De centrale boekingsvalidatie bewaakt vervolgens ook de samenhang met de code en netto-grondslag.

**Waar:** `src/intake/intake.ts`.

**Regressiebewijs:** R16 bevestigt de negatieve credit via de intake-service; tegengestelde tekens en ongeldige bedragen blijven afgewezen. De corresponderende R-test staat in `tests/business-rules-review.test.ts`; aanvullende proeven staan in `tests/business-rules-boundaries.test.ts`.

**Afbakening van het oorspronkelijke bewijs:** Documentservice gereproduceerd; de doorgegeven negatieve waarde volgt ook uit DocumentReview.tsx, regels 205–210 en 432.

## Aanvullende correcties

- **Zvw 2025:** maximum bijdrage-inkomen van € 75.860 naar € 75.864, met expliciete grensgevaltest.
  Dit is aanvullend op de 16 oorspronkelijke bevindingen.
- **Ponto-datum:** ISO-tijdstippen worden expliciet naar de Nederlandse kalenderdatum vertaald,
  onafhankelijk van de hosttijdzone. De eerste UTC-baseline had juist hier een extra fout;
  de finale UTC-selectie slaagt.
- **Transactiegrens bij bankboeking:** validatiefouten laten geen onthouden zakelijk percentage
  of halve boeking achter.
- **Documentatie:** de oude suggestie van onafhankelijke fiscale goedkeuring is vervangen door de
  juiste aanduiding code-audit. Dat voorkomt dat testdekking als fiscale certificering wordt gelezen.

## Fiscale bronnen en toepassingsgrenzen

De bronnen hieronder zijn bij het oorspronkelijke onderzoek op **4 oktober 2026** geraadpleegd.
Het oorspronkelijke HTML-rapport bevat ook de primaire bronnen voor de geselecteerde
2026-jaartabellen. Dit dossier bewaart die onderbouwing en claimt geen nieuwe onafhankelijke audit.

- [Verlegde btw aftrekken — Belastingdienst](https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/btw_aftrekken/welke_btw_is_aftrekbaar/verlegde_btw_aftrekken):
  R12 gaat over één volledig aan de ondernemer verlegde B2B-prestatie. Een afzonderlijk aan een
  particulier geleverde prestatie vergt eerst een andere beoordeling.
- [KOR — Belastingdienst](https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/hoe_werkt_de_btw/kleineondernemersregeling/kleineondernemersregeling):
  R03 voorkomt de concrete onverenigbare binnenlandse verkooproute. Historische ingangs-/einddatums
  van KOR-deelname en beoordeling van drempeloverschrijding zijn geen nieuwe functionaliteit in deze PR.
- [Privégebruik auto — Belastingdienst](https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/btw_aftrekken/btw_en_de_auto/privegebruik_auto_van_de_zaak/):
  R15 gebruikt het gepubliceerde voorbeeld met maximaal € 1.365. De huidige automatische berekening
  ondersteunt één auto; meerdere auto's en een eigen bijdrage vragen afzonderlijke beoordeling.
- [Zvw-percentages en maximumbijdrage-inkomen — Belastingdienst](https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/prive/werk_en_inkomen/zorgverzekeringswet/veranderingen-bijdrage-zvw/):
  onderbouwing van € 75.864 in 2025.

Geen echte klantadministratie is gewijzigd of doorgelicht. Er is geen volledige visuele verificatie
van ieder PDF-/Excel-overzicht of Windows-/Electron-installatiepakket uitgevoerd.
De inkomstenbelastingfunctie blijft een schatting binnen de bestaande productscope; ander inkomen,
box 2/3, gedeeltelijk vrijgestelde omzet, privéauto-btw en alle bijzondere buitenlandse prestaties
worden hiermee niet volledig gemodelleerd. Zie ook [de fiscale vragenlijst](../../fiscale-review.md).

## Reproduceren en vervolgreview

Gebruik een checkout van de PR-code met passende Node-, SQLite- en Chromium-dependencies.
De [oorspronkelijke rode regressies](bewijs/review-regressies-voor-herstel.ts.txt) zijn als tekst bewaard; de huidige testbron bevat het
vastgelegde gewenste gedrag. Verander de financiële verwachting niet omdat de implementatie een
ander getal geeft: vergelijk eerst het scenario en de handberekening.

Normale repositorycommando's:

```bash
npm ci
TZ=Europe/Amsterdam npm test
npm run typecheck
npm run build
npm run e2e
```

In deze omgeving was de SQLite-binding al voor Node voorbereid. De volgende directe commando's
voeren de vastgelegde controles uit; pas het Chromium-pad aan voor een andere host:

```bash
TZ=Europe/Amsterdam node node_modules/vitest/vitest.mjs run --reporter=dot
TZ=UTC node node_modules/vitest/vitest.mjs run tests/ponto.test.ts tests/business-rules-review.test.ts tests/business-rules-boundaries.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
npm run build
PW_CHROMIUM=/root/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell node node_modules/@playwright/test/cli.js test
PW_CHROMIUM=/root/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell node node_modules/@playwright/test/cli.js test e2e/business-rules.spec.ts
```

Controleer bij vervolgwijzigingen vooral:

1. De volledige grondslag versus het aftrekbare deel bij verlegging, ook onder KOR.
2. Netto/btw/privé-symmetrie bij aankopen, refunds, credits en correcties.
3. Peildata vóór/na betaling, credit en tegenboeking; actuelere status mag de historie niet vervormen.
4. Regelversie, migratie, read-only toegang en idempotentie van activacredits.
5. Individuele vraagposten, nieuwe situaties na een skip en kwartalen met omgekeerde invoervolgorde.
6. De scanner-verhuisproef op een geschikte host en de gebruikelijke platform-/installerchecks.

Bekende niet-blokkerende uitvoer: de build meldt een rendererchunk boven 500 kB; de bestaande
browser-walkthrough meldt heading-order-waarschuwingen. Deze zijn geen bewijs van een financiële
fout en zijn niet in deze business-rulescorrectie veranderd.
