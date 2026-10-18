---
titel: Bank: afschriften inlezen en betalingen uitzoeken
omschrijving: Welk bestand je bij je bank downloadt, hoe je het inleest, hoe de app betalingen koppelt, en wat je doet bij een vraag, een dubbele betaling of een saldo dat niet klopt.
hoofdstuk: Dagelijks werk
volgorde: 30
---

## Welk bestand kies ik bij mijn bank?

Download in internetbankieren een afschrift (meestal onder *Afschriften*, *Downloaden* of *Exporteren*). Kies:

1. **CAMT.053** als je bank dat heeft. Daarin staat vast wat af en bij is, met naam en rekeningnummer van de tegenpartij.
2. Anders **MT940**. Banken bouwen MT940 af (Rabobank heeft het aangekondigd), dus kies CAMT.053 zodra je bank het heeft.
3. Anders **CSV**. Dat werkt ook, maar elke bank schrijft "af" en "bij" anders op; de app laat daarom vóór het inlezen zien wat hij ervan maakt.

De app neemt bestanden aan die eindigen op .xml (CAMT), .sta, .940, .mt940 of .swi (MT940), en .csv, .txt of .tab. Een CSV van ING, Rabobank, ABN AMRO, bunq, Knab, Triodos of Revolut (ook het maandafschrift van Revolut Business) herkent de app vanzelf. Je kunt ook je bank [automatisch laten ophalen met Ponto](#automatisch-ponto-en-de-downloadmap).

## Inlezen

1. Ga naar *Bank* en sleep het bestand op *Sleep je bankafschrift hierheen*.
2. De app meldt hoeveel nieuwe betalingen erin stonden en hoeveel er al bekend waren. Hetzelfde afschrift twee keer inlezen is geen probleem: dubbele regels slaat de app over.
3. Wat de app zelf kon koppelen (een betaling aan een factuur, een afschrijving aan een bon) is al verwerkt. De rest staat onder *Hulp nodig*.

### Een CSV die de app nog niet kent: kolommen aanwijzen

De eerste keer vraagt de app *Welke kolom is wat?*: de datum (en het datumformaat), het bedrag, en als de bedragen geen minteken hebben de kolom met "Af" of "Bij". Verder de naam, het rekeningnummer en de omschrijving. Onder *Zo leest de app het* zie je meteen per regel de datum, af of bij, het bedrag en de naam, met het aantal regels af en bij. Klopt het, kies *Inlezen*; de app onthoudt de keuze voor dit soort bestand.

### "Klopt dit?"

Gaan alle regels dezelfde kant op én ziet de app een aanwijzing dat af en bij verkeerd gelezen zijn (bijvoorbeeld een kolom met waarden die hij niet kent), dan vraagt hij eerst *Klopt dit?*. Kies *Kolommen nakijken* om de toewijzing te verbeteren, of *Ja, dit klopt: inlezen*. Een rustige week met alleen afschrijvingen krijgt die vraag niet.

### "Nieuwe bankrekening?"

Staat er in het afschrift een rekeningnummer dat nog niet in je administratie staat, dan leest de app nog niets in en vraagt hij eerst *Nieuwe bankrekening?*. Is het een zakelijke rekening die erbij hoort, kies dan *Nieuwe rekening toevoegen*. Is het hetzelfde geld met een nieuw rekeningnummer (bijvoorbeeld na een overstap binnen je bank), kies dan *Hoort bij* en de rekening die je al had (die keuze staat er alleen als het hele afschrift van die ene rekening is). Is het je privérekening, kies *Niet inlezen*: er verandert dan niets. Kwam het afschrift uit de downloadmap, dan telt dat als *Niet nu*. Je allereerste afschrift krijgt die vraag niet; dat rekeningnummer komt gewoon bij je eerste rekening.

## Betalingen uitzoeken: Hulp nodig

Onder *Hulp nodig* staan de betalingen waar de app niet zeker van is. Klik op een betaling. De app stelt voor wat het waarschijnlijk is; je kiest:

- **Een factuur** van jou die hiermee betaald is.
- **Een bon of aankoop** die hiermee betaald is.
- **Een kostensoort** (categorie) als er geen bon is of komt; typ een paar letters. Bij een uitgave met btw vul je het btw-tarief in.
- **Verkoop via een ander systeem**: omzet uit een webshop of betaaldienst waarvoor je geen factuur in de app maakte.
- **Privé**: geld dat niets met je bedrijf te maken heeft (een privéopname of -storting).
- **Negeren**: de regel telt niet mee in je boekhouding, wel in het saldo. Bijvoorbeeld een dubbele regel of een nulbedrag.

Een overboeking tussen je eigen rekeningen (bijvoorbeeld naar je spaarrekening of btw-potje) herkent de app zelf, als beide rekeningen in de app staan. Voeg een tweede rekening toe met *+ Rekening toevoegen*.

Vergist? Open de betaling en kies *Ongedaan maken*. Je blijft op dezelfde pagina en kiest meteen wat het wel was.

Met *Opnieuw automatisch uitzoeken* laat je de app nog een keer over alles heen gaan, bijvoorbeeld nadat je een stapel bonnen hebt toegevoegd.

## Alle betalingen en oudere betalingen terugvinden

Onder *Alle betalingen* staat alles wat je hebt ingelezen, ook wat al verwerkt of genegeerd is, met *Geboekt als* erbij. De lijst laat de 500 nieuwste betalingen zien; heb je er meer, dan zegt de app dat erbij. Een oudere betaling vind je met het zoekvak boven de lijst (naam, omschrijving of rekeningnummer) of via *Zoeken* (*Ctrl K*), dat ook op bedrag en periode zoekt. Klik erop om hem te openen, bijvoorbeeld om een genegeerde regel alsnog in te delen.

## Dubbele betalingen

Dezelfde betaling kan twee keer in de app komen, bijvoorbeeld uit een CSV en later uit een CAMT-bestand met een andere datum of naam. De app ziet dat en zegt het op *Vandaag* en bij *Bank*: *€ … staat er waarschijnlijk twee keer in*. Kies *Bekijken en oplossen*, je ziet beide regels naast elkaar en kiest welke blijft. De andere haalt de app uit je boekhouding; die blijft bewaard en kun je altijd terugzetten.

Regels die de app bij het inlezen oversloeg omdat ze er al stonden, vind je met *Bekijken* bij de melding na het inlezen. Was het toch een eigen betaling? *Toch toevoegen*.

## Klopt mijn saldo?

Bij *Bank* staat per rekening *Laatst ingelezen*, wat dat afschrift bevatte en *Bijgewerkt t/m*. Staat er een beginsaldo (knop *Beginsaldo*) en bevat je afschrift een eindsaldo, dan controleert de app of alles aansluit. Klopt het niet, dan zegt hij dat op *Vandaag* en laat hij zien welke regels zijn overgeslagen: meestal zit het verschil daar. Zie ook [Problemen oplossen](problemen-oplossen.html#mijn-banksaldo-klopt-niet).

## Automatisch: Ponto en de downloadmap

- **Afschriften vanzelf inlezen**: zet dit aan bij *Bank*. De app kijkt dan in je Downloads-map (of een map die je kiest) naar nieuwe afschriften en vraagt op *Vandaag* *Inlezen* of *Niet nu*. De app verplaatst of verwijdert nooit bestanden.
- **Bank ophalen met Ponto**: een afzonderlijke zakelijke dienst waar je zelf een overeenkomst mee sluit. Een wizard bij *Bank* leidt je er in vijf stappen langs; daarna haalt de app je betalingen zelf op, rechtstreeks bij Ponto. Afschriften blijven de basis en de terugval. Meer op [bank automatisch inlezen](../bank-automatisch.html) en [Ponto](../bank-ophalen.html).

## Een verkeerd afschrift weer weghalen

Is een afschrift verkeerd ingelezen (bijvoorbeeld alles als "bij")? Dan kun je het helemaal weghalen en opnieuw inlezen. Omdat dit rechtstreeks in je boekhouding ingrijpt, zit het in de boekhoudermodus: zie [Een ingelezen afschrift weghalen](afschrift-weghalen.html). Vraag bij twijfel je boekhouder.
