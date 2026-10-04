# Vervolgcontrole na Claude — PR #274 en #275

Deze overdracht hoort bij [PR #274](https://github.com/shipdocs/boekhoudenvoorniks/pull/274).
Ze vult [de oorspronkelijke R01–R16-overdracht](README.md) aan. De aanleiding is Claude’s
[reviewcommentaar](https://github.com/shipdocs/boekhoudenvoorniks/pull/274#issuecomment-5981783111),
[aanvulling over afschrijving](https://github.com/shipdocs/boekhoudenvoorniks/pull/274#issuecomment-5981806814)
en [PR #275](https://github.com/shipdocs/boekhoudenvoorniks/pull/275).

## Wat gecontroleerd en overgenomen is

Uitgangspunt van de vervolgcontrole is Claude’s commit `83ea8bb23fa65e43628f706cb7f51651b138dbba`.
Deze zes bestanden bevatten vijf kleine correcties: de Zvw-tabel 2025, afwijzen van onmogelijke
Ponto-kalenderdatums, voorkomen van een impliciete nuloverride bij autokosten-btw, het vernieuwen
van de investeringslijsten na credittoewijzing en het bewaren van de oorspronkelijke restwaarde.
Deze correcties blijven behouden. Het historische kostprijsregister gebruikt bij een credit de
kostprijs op de peildatum en begrenst alleen de getoonde restwaarde; de opgeslagen restwaarde blijft staan.

De volledige bestaande suite op Claude’s commit gaf **1.566 geslaagd, 5 overgeslagen, 0 mislukt**.
Dat maakte de PR nog niet voldoende: onze onafhankelijke controle van elf scenario’s gaf
**6 mislukt en 5 geslaagd**, met vijf verschillende nog open problemen (het legacy-btw-probleem
faalde in twee leespaden). Drie aanvullende schermproeven gaven **2 mislukt en 1 geslaagd**.
De ongewijzigde rode testbronnen en logs staan in [vervolg-bewijs](vervolg-bewijs/manifest.json).
De fixtures gebruiken uitsluitend een tijdelijke testadministratie, geen echte klantgegevens.

## Vijf resterende fouten en de gekozen oplossingen

| ID | Trigger en oude uitkomst | Verwachting en herstel | Code en regressie |
|---|---|---|---|
| F01 | Algemeen telefoonpercentage 70%; bankbetaling € 121; categorie telefoon; percentageveld 100 ongewijzigd. De UI stuurde expliciet 100 en schakelde daarmee de algemene privé-correctie uit. | Ongewijzigde standaard stuurt geen eigen percentage: € 30 privébijtelling en € 6,30 btw-correctie over € 100 netto + € 21 btw. Een zelf ingevulde 100 blijft expliciet en krijgt geen tweede correctie; een onthouden leverancierspercentage blijft gelden. | `selectedBusinessPct` in `src/shared/business-share.ts`, `CategoryPicker` in `src/renderer/screens/Bank.tsx`; unit- en echte schermregressie. |
| F02 | Oude OCR-aankoop met netto € 100, expliciete btw € 6 en code `nul`, geboekt onder regels 2026.2. Nieuwe schrijfvalidatie werd ook bij lezen uitgevoerd; aankooplijst en leveranciersverdeling crashten. | Opgeslagen € 6 blijft zichtbaar met een controlewaarschuwing. De leesroute herinterpreteert of herschrijft geen oude journaalregels. Nieuwe invoer blijft strikt: code `nul` met € 6 btw wordt geweigerd. Compleet herkende gemengde OCR-tarieven buiten 0/9/21% vragen een gecontroleerd, zelf ingevuld btw-bedrag; 6% wordt niet stil naar `nul` vertaald. | `src/core-ledger/stored-purchase.ts`, `purchases.list` in `src/main/api.ts`, `src/intake/business-share.ts`, `purchaseLines` in `src/intake/intake.ts`; regressies met een daadwerkelijk door de legacy-compiler geboekte fixture en OCR-bevestiging. |
| F03 | Vraagpost debet € 100, gevolgd door memoriaal credit Vraagposten € 100/debet kosten € 100. Grootboeksaldo nul, maar beide posten bleven de btw- en afsluitcontroles blokkeren. | De boekhouder kiest expliciet welke vraagpost het memoriaal afboekt. Volledige afboeking sluit beide; deelafboeking laat het restant open. Een latere tegenboeking heropent de vraagpost zonder een eerdere peildatum te wijzigen. Een achteraf gedateerde correctie kan een later al afgeboekt bedrag niet nogmaals verbruiken. Onverwante tegengestelde posten worden nooit blind gesaldeerd. | Migratie 35, `src/core-ledger/open-items.ts`, `Ledger.post`, API `ledger.questionItems/manualEntry`, memoriaalscherm en `src/exchange/exchange.ts`; units voor saldo, delen, peildata, rollback, dubbele herindeling en label; browserproef en volledige uitwisselingscyclus met uiteenlopende ids. |
| F04 | Handmatig aanschaf-btw-bedrag € 6.500; daarna keuze “Afleiden uit de aankoop”. Het verborgen oude bedrag bleef zwaarder wegen dan de geboekte aanschaf-btw van € 3.150. Met € 735 kosten-btw bleef het plafond € 2.025 in plaats van € 1.365. | Bij automatisch afleiden gebruikt de berekening de geboekte aanschaf-btw: € 735 + 1/5 × € 3.150 = € 1.365. De UI wist het handbedrag bij wisselen naar automatisch of nee. De backend negeert oude verborgen bedragen ook als een oude client ze laat staan. | `src/btw/car.ts`, `src/renderer/screens/Settings.tsx`; backendregressie en echte schermregressie. |
| F05 | Aankoop € 1.000 op 1 januari 2025; € 200 afschrijving geboekt op 31 december. Het register op 30 juni 2025 toonde daarna € 800; het grootboek nog € 1.000. Bij verkoop overschreef de app daarnaast het oude jaarbedrag. | Historische afschrijving volgt de werkelijke journaaldatum: op 30 juni € 0 afschrijving en € 1.000 boekwaarde. Elke nieuwe afschrijving/correctie heeft een eigen onveranderlijke historieregel. Migratie 36 herstelt oorspronkelijke bedragen uit het journaal. Een latere verkoop of tegenboeking verandert de eerdere activastatus niet. | `src/tax/assets.ts`, migratie 36; units voor afschrijving, verkoop, tegenboekingen, toekomstige aankoopcorrectie, onveranderlijkheid en backfill bij gelijke/gewijzigde namen. |

Alle vervolgscenario’s staan in [tests/business-rules-followup.test.ts](../../../tests/business-rules-followup.test.ts).
De vijf nieuwe schermproeven staan in [e2e/business-rules-followup.spec.ts](../../../e2e/business-rules-followup.spec.ts).
De aanvullende uitwisselingsproef staat in [tests/uitwisseling.test.ts](../../../tests/uitwisseling.test.ts).

### Waarom een directe datumfilter bij afschrijving niet genoeg was

Een `WHERE journal_entry.entry_date <= peildatum` op de oude jaarcache zou F05 niet volledig oplossen:
`dispose()` verlaagde de opgeslagen `asset_depreciation.amount` in dezelfde rij. Het oorspronkelijke
bedrag was daarna niet meer uit die cache af te leiden. De nieuwe `asset_depreciation_history`
bevat positieve afschrijving en negatieve correctie als afzonderlijke, gedateerde boekingen.
Update/delete-triggers beschermen deze historie; de oude tabel blijft de idempotente jaarmarker.

Een extra bestaande test vond tijdens de volledige suite nog het verkoopgeval binnen een al
geboekt jaar. Stel: € 600 over 2024 en € 600 op 31 december 2025, achteraf verkocht op 1 juli 2025.
Alleen € 300 terugnemen op 1 juli zou vóór 31 december een onjuiste cumulatieve afschrijving geven.
Daarom neutraliseert de app het volledige jaarbedrag op **de oorspronkelijke datum 31 december**
en boekt ze de juiste € 300 op **de verkoopdatum 1 juli**. De eerdere € 600 blijft staan. Zowel
het register als de cumulatieve grootboekrekening sluiten aan op 1 juli en op 31 december.
De eerste volledige vervolgrun en deze gerichte regressies blijven als bewijs bewaard.

### Migraties en compatibiliteit

- Migratie 35 maakt `question_item_settlements`; bestaande tegengestelde posten worden niet automatisch
  gekoppeld omdat een gelijk bedrag geen bewijs van samenhang is. Oude ongekoppelde memoriaalcorrecties
  kan de boekhouder terugdraaien en opnieuw met de expliciete keuze boeken.
- De afboekkoppeling ontstaat in dezelfde transactie als de journaalpost. Een ongeldige richting of
  ontbrekende vraagpost laat geen journaalpost of event achter. Zolang een expliciete memoriaalcorrectie
  actief is, wordt een tweede herindeling van de originele bank-/aankoopboeking geweigerd om dubbele
  kosten te voorkomen; eerst die correctie terugdraaien.
- In een kantooruitwisseling wordt de vraagpost als bestaande id of verwijzing naar een eerdere
  handeling opgenomen. Replay vertaalt de verwijzing naar de klant-id; ids van nieuw werk mogen verschillen.
- Migratie 36 backfillt de oorspronkelijke jaarbedragen uit de onveranderlijke cumulatieve regels en
  de bestaande `afschrijving-correctie:<activum>[:jaar]`-boekingen. Per rekening worden de activum-ids
  en journaalregels in de door de oude app gebruikte primaire-sleutelvolgorde gekoppeld; actuele namen
  en mogelijk overschreven cachebedragen bepalen de toewijzing niet. Voor nieuwe jaarboekingen staat
  die volgorde nu expliciet als `ORDER BY id` in de query.
- De migratie herschrijft geen bestaande journaalregels, oude gebeurtenissen of legacy-compilers.
  Zij reconstrueert de werkelijk geboekte bedragen. Een al geboekte fout wordt dus niet stil
  weggepoetst of fiscaal opnieuw beoordeeld. Afwijkende, handmatig gewijzigde externe databases
  vallen buiten het bewijs van de app-eigen migratie.
- Nieuwe boekingen blijven regels 2026.3 gebruiken. Regels 2026.2 blijven bevroren; het legacy-leespad
  is uitsluitend voor bestaande gegevens. Een waarschuwing bij oude btw maakt die aftrek niet fiscaal geldig.

### Beoordeelde nuance uit Claude’s overdracht

Een oudere onkoppelbare investeringscredit zonder kandidaat kan in een later kwartaal terugkomen
als controle. Dit is geen permanent onontkoombare blokkade: de gebruiker kan de concrete controle
bewust overslaan met een reden. De regressie bewaakt die mogelijkheid. Geen automatische koppeling,
verwijdering of claim dat een oude credit fiscaal is opgelost. De oorspronkelijke beperkingen rond
credits na afschrijving, KIA, meerdere auto’s, historische KOR en bijzondere fiscale situaties blijven gelden.

## Validatie van deze vervolgpatch

Geteste lokale codecommit: `0551238b57125044834c9913028e3c20aa4261e5`.
Gepubliceerde codecommit: `1ef727bdc538f39b6360dba1cbff0e9315a23bd0`.
Code-tree: `d125eaffd35fc8a35e300343b4425987ddbc1395`.
De lokale en via GitHub gemaakte code-trees zijn exact gelijk; het bewijsmanifest bewaart die vergelijking.
PR #275 is opgenomen in de werkbranch met mergecommit `a607d7326105eb153a622b8facb02e4f18f4d2f0`.
Het oorspronkelijke dossier blijft ongewijzigd bewijs van de eerste ronde; deze vervolglogs horen bij deze code.

| Controle | Uitkomst | Bewijs |
|---|---|---|
| Volledige unit-/integratiesuite, Europe/Amsterdam | 1.590 geslaagd, 5 overgeslagen, 0 mislukt; 1.595 totaal, 97 bestanden | [Log](vervolg-bewijs/unit-final.log) |
| UTC: Ponto, oorspronkelijke review en vervolggevallen | 90 geslaagd, 0 mislukt | [Log](vervolg-bewijs/utc-final.log) |
| Gerichte units: vervolg, belastingvoordelen en uitwisseling | 64 geslaagd | [Log](vervolg-bewijs/gerichte-regressies.log) |
| Schermregressies en bestaande kantooruitwisseling | 6 geslaagd | [Log](vervolg-bewijs/e2e-gerichte-regressies.log) |
| Volledige browserrun vóór de laatste guard tegen dubbel afboeken | 91 geslaagd op een verse build | [Log](vervolg-bewijs/e2e-full.log) |
| Nieuwe build en gerichte schermregressies na de laatste guard | 9 geslaagd, 0 mislukt | [Log](vervolg-bewijs/e2e-last.log) |
| Laatste productiebuild | Geslaagd | [Log](vervolg-bewijs/build-final.log) |
| TypeScript | Geslaagd | [Log](vervolg-bewijs/typecheck-final.log) |

De volledige browserrun hoort bij code-tree `728c7f124a1230cd50f43fa8a64979fbc12ef1f6`.
Na toevoeging van de guard tegen achteraf dubbel afboeken zijn de volledige unit-suite, UTC,
TypeScript, productiebuild en alle betrokken schermproeven opnieuw uitgevoerd. De laatste
schermselectie bevat ook de nieuwe afwijzingsproef, beide oorspronkelijke business-rule-schermen
en de twee kantooruitwisselingsproeven. Zij hoort bij de hierboven genoemde definitieve code-tree.

De vijf unit-skips zijn dezelfde vier bestaande skips en één onafhankelijke capability-probe voor
het onbereikbare tweede loopback-adres `127.0.0.2`. De scannerproductiecode is niet aangepast.
Dit dossier claimt geen Windows-/installer-CI, daadwerkelijke klantmigratie of fiscale certificering.

Reproduceren met Node 24 en geïnstalleerde afhankelijkheden:

```sh
TZ=Europe/Amsterdam node node_modules/vitest/vitest.mjs run
npm run typecheck
TZ=UTC node node_modules/vitest/vitest.mjs run tests/business-rules-followup.test.ts tests/business-rules-review.test.ts tests/ponto.test.ts
npm run build
PW_CHROMIUM=/pad/naar/chromium E2E_PORT=5190 node node_modules/@playwright/test/cli.js test
```

Bewaar bij verder werk vooral de betekenis van een expliciete keuze, de scheiding tussen lezen en
nieuwe validatie, afboekrelaties, concrete controle-fingerprints, daadwerkelijke journaaldatums en
het verschil tussen een onveranderlijke historie en een actuele cache.
