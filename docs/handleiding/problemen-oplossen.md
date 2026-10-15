---
titel: Problemen oplossen
omschrijving: Wat je doet als iets niet klopt: een afschrift dat verkeerd is ingelezen, een saldo dat niet aansluit, een bon die niet gelezen wordt, een Windows-melding, of een back-up terugzetten.
hoofdstuk: Problemen oplossen
volgorde: 10
---

## Mijn CSV-afschrift kwam helemaal als "bij" (of "af") binnen

Dat gebeurt als de kolom die zegt wat af en bij is, niet goed gelezen is. Zo los je het op:

1. Kies voortaan **CAMT.053** of **MT940** bij je bank; daarin staat af en bij vast. Zie [Welk bestand kies ik](bank.html#welk-bestand-kies-ik-bij-mijn-bank).
2. Haal het verkeerde afschrift weg: dat zit in de boekhoudermodus, zie [Een ingelezen afschrift weghalen](afschrift-weghalen.html). Heb je al betalingen uit dat afschrift verwerkt, dan draait de app die eerst netjes terug.
3. Lees het goede bestand in. Bij een CSV laat de app vóór het inlezen zien wat hij ervan maakt (*Zo leest de app het*); kijk daar naar af en bij.

## Mijn banksaldo klopt niet

*Vandaag* of *Bank* zegt dat het saldo volgens je afschriften niet aansluit.

- **Ontbreekt er een afschrift?** Kijk bij *Bank* naar *Bijgewerkt t/m*. Lees het ontbrekende deel in; overlappende afschriften zijn geen probleem.
- **Zijn er regels overgeslagen?** Bij de melding staat *Bekijken*. Een overgeslagen regel die toch een eigen betaling was: *Toch toevoegen*.
- **Staat een betaling er dubbel in?** De app meldt dat op *Vandaag*: *Bekijken en oplossen*. Zie [Dubbele betalingen](bank.html#dubbele-betalingen).
- **Klopt het beginsaldo?** Bij *Bank → Beginsaldo* staat het saldo op je instapdatum. Vergelijk het met je afschrift van die dag.

## Een betaling is verkeerd verwerkt

Open de betaling bij *Bank* en kies *Ongedaan maken*. De boeking wordt teruggedraaid en je kiest meteen wat het wel was. Dat kan ook als de betaling aan een factuur of bon gekoppeld was: die staat daarna weer open.

## Een bon wordt niet gelezen, of verkeerd

- **Foto onscherp of schuin**: maak een nieuwe foto, liefst recht van boven met de hele bon in beeld. Of vul de velden zelf in; dat is bij een kleine bon sneller.
- **Lezen staat uit**: bij *Instellingen → Automatisch & herkenning* kies je hoe bonnen gelezen worden. Op je eigen computer lezen vraagt eenmalig een download.
- **Verkeerde categorie of btw**: pas het aan bij *Even controleren*; de app leert ervan voor de volgende bon van die leverancier.
- **Bon staat er dubbel in**: open de kopie en kies *Negeren*.

## Windows zegt "Windows heeft uw pc beveiligd"

Die melding (SmartScreen) komt bij programma's die nog niet met een betaald certificaat zijn ondertekend. Download de installer alleen van [boekhoudenvoorniks.nl](../downloaden.html) of haal het programma uit de Microsoft Store, daar verschijnt de melding niet. Wil je zeker weten dat je download echt van ons is: bij elke versie op GitHub staan controlegetallen (SHA256SUMS); vergelijk die met je bestand.

## De app start niet of blijft hangen

1. Sluit de app helemaal (ook in het systeemvak) en start opnieuw.
2. Kijk of er een update is: [Wat is er nieuw](../wijzigingen.html). Een update installeer je door de nieuwe installer te draaien; je administratie blijft staan.
3. Start de app nog steeds niet? Mail ons via [info@shipdocs.app](mailto:info@shipdocs.app?subject=App%20start%20niet) met je versie (staat in de installer-naam) en wat je ziet.

## Een back-up terugzetten

*Instellingen → Back-up, demo & updates → Back-up terugzetten…*. De app maakt eerst een kopie van de huidige stand, zodat je terug kunt. Alles wat je na het moment van de back-up deed, is daarna weg. Zie [Back-ups](instellingen.html#back-ups).

## Ik ben overgestapt naar een andere computer

1. Maak op de oude computer een back-up (*Back-up maken*) en zet die op een USB-stick.
2. Installeer het programma op de nieuwe computer en kies bij de eerste start niet de demo.
3. *Instellingen → Back-up, demo & updates → Back-up terugzetten…*.
4. Koppel je telefoon opnieuw als je de app voor Android gebruikt.

## Ik heb in de boekhoudermodus iets kapotgemaakt

Op een administratie waarin buiten de boekhouder om in de boekhoudermodus is geschreven, geven we geen ondersteuning: daar is rechtstreeks in de boekhouding ingegrepen. Zet een back-up terug van vóór dat moment (de app maakt er automatisch een vóór ingrijpende stappen), of vraag je boekhouder het recht te zetten. Kijken in de boekhoudermodus (balans, kaarten, rapporten, exports) is nooit een probleem.

## Iets anders

Werkt iets in de app niet zoals hier beschreven? Kijk bij de [veelgestelde vragen](../#vragen) of mail ons: [info@shipdocs.app](mailto:info@shipdocs.app?subject=Vraag%20over%20BoekhoudenVoorNiks). Zeg erbij welke versie je gebruikt (*Instellingen → Over*) en wat je precies deed toen het misging.

Vragen over je boekhouding zelf (klopt deze boeking, wat moet ik aangeven, hoe los ik dit verschil op) beantwoorden we niet: daarvoor is je boekhouder. Werkt die met de [uitwisseling](boekhouder.html#de-uitwisseling), dan kan hij namens jou bij ons terecht als er iets in de app niet klopt.
