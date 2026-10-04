# Investeringscredits: resterende kostprijs in de leescontrole

## Probleem en bewijs vóór herstel

Onderzochte `main`: `c71239ce5cb8938c2d7ebdea2b5110b054629605`, na
[PR #276](https://github.com/shipdocs/boekhoudenvoorniks/pull/276).
De correcties uit #274 en #275 zijn aanwezig;
[de bestaande suite](creditcontrole-bewijs/main-bestaande-tests.log) slaagde met 1.592 tests en 5 skips.
De nieuwe fout zit in `AssetService.pendingCredits()`, geïntroduceerd door #276 om btw-controles
zonder databasewijzigingen uit te voeren.

Bij een investering van € 1.000 en twee credits van € 800 ziet iedere credit aanvankelijk precies
één kandidaat. De oude leescontrole verbergt daarom beide credits. De echte `sync()` verwerkt
credits op boekingsdatum en journaalregel-ID: na de eerste credit blijft € 200 over en past de
tweede credit niet. De btw-waarschuwing ontbreekt vóór verwerking en verschijnt pas na een bezoek
aan een scherm dat het activaregister synchroniseert. De waarschuwing mag niet van die schermvolgorde afhangen.

Ook het omgekeerde ging fout: bij activa van € 1.000 en € 600, een eerste credit van € 800 en
een tweede van € 500, kan de eerste credit alleen op het eerste activum. Daarna past de tweede
alleen op het tweede. De oude leescontrole bleef ten onrechte waarschuwen voor twee kandidaten.

[Dezelfde zes nieuwe regressies op de oude main](creditcontrole-bewijs/voor-herstel.log)
geven **4 mislukt en 2 geslaagd**. Dit is een aanvullende fout boven op de bestaande groene suite.

## Correctie en afspraken voor volgende agents

`pendingCredits()` simuleert de beschikbare kostprijs met een lokale `Map` per activum. Het gebruikt
dezelfde datum-/regelvolgorde en kandidaatselectie als de echte synchronisatie. Iedere credit met
precies één resterende kandidaat reserveert zijn bedrag uitsluitend in het geheugen. Een volgende
credit wordt tegen het resterende bedrag beoordeeld. Credits met nul of meerdere kandidaten blijven
zichtbaar; onduidelijke credits reserveren geen willekeurig bedrijfsmiddel. Hun teruggegeven
kandidaten weerspiegelen eveneens de resterende capaciteit.

De echte synchronisatie, de journaalposten, de regelversies en de databaseopbouw zijn niet gewijzigd.
Behoud de eis uit #276: een btw-controle mag geen koppelingen, kostprijzen of afschrijvingen opslaan.
Voeg dus geen `sync()` toe om deze leescontrole te herstellen. De oplossing maakt de bestaande
controle consistent met verwerking; zij verandert geen fiscale regel.

## Regressies en validatie

[De nieuwe testbron](../../../tests/asset-credit-checks.test.ts) controleert:

1. Twee credits van € 800 op € 1.000: precies één onopgeloste credit en € 200 resterende kostprijs.
2. Credits van € 800 en € 200: beide passen precies, zonder waarschuwing.
3. Credits van € 800, € 300 en € 200: de onkoppelbare € 300 verbruikt geen capaciteit; € 200 past nog.
4. Een eerste unieke credit maakt een volgende credit eenduidig op een ander activum.
5. Credits met meerdere kandidaten blijven zichtbaar en kiezen geen willekeurig activum.
6. Een later ingevoerde, eerdere boekingsdatum wordt eerst verwerkt; een toekomstige credit verschijnt
   pas in de controle van een aangifte waarvan de einddatum die credit omvat.

De tests vergelijken de voorspelde openstaande credits met de uitkomst van echte synchronisatie,
controleren de bedragen en vergelijken volledige tabellen voor activa, koppelingen, journaalposten
en journaalregels vóór en na de leescontrole. Herhaald lezen moet dezelfde uitkomst geven.

| Controle | Resultaat | Bewijs |
|---|---|---|
| Nieuwe regressies op oude main | 4 mislukt, 2 geslaagd | [voor herstel](creditcontrole-bewijs/voor-herstel.log) |
| Nieuwe regressies en eerdere vervolgtests | 31 geslaagd | [gerichte tests](creditcontrole-bewijs/gericht.log) |
| Volledige unit-/integratiesuite, Europe/Amsterdam | 1.598 geslaagd, 5 overgeslagen, 0 mislukt | [volledige suite](creditcontrole-bewijs/unit.log) |
| Nieuwe regressies, eerdere business rules en Ponto onder UTC | 118 geslaagd | [UTC](creditcontrole-bewijs/utc.log) |
| Relevante business-rules-schermen en uitwisseling met boekhouder | 9 geslaagd | [browserproeven](creditcontrole-bewijs/e2e.log) |
| TypeScript | Geslaagd, exitcode 0 | [typecheck](creditcontrole-bewijs/typecheck.log) |
| Productiebuild | Geslaagd, bestaande waarschuwing over chunkgrootte | [build](creditcontrole-bewijs/build.log) |

De vastgelegde resultaten en bron-/loghashes staan in
[het bewijsmanifest](creditcontrole-bewijs/manifest.json). De logs zijn lokale testresultaten;
zij doen geen uitspraak over installer-, platform- of GitHub-CI-checks. De vijf bestaande skips
blijven de eerder beschreven beperkingen van de suite en deze omgeving.
