---
titel: De boekhoudermodus
omschrijving: Wat er verschijnt als je de boekhouding voor je boekhouder aanzet, voor wie het is, en wat je ermee kunt: kolommenbalans, journaal, correcties en exports.
hoofdstuk: Voor de boekhouder
volgorde: 10
boekhouder: ja
---

## Voor wie

Dit hoofdstuk is voor de boekhouder of accountant die een administratie in BoekhoudenVoorNiks nakijkt of corrigeert. Een ondernemer heeft het niet nodig: alles wat je dagelijks doet, staat in de andere hoofdstukken, en de app bewaakt daar zelf dat de boekhouding klopt. In de boekhoudermodus werk je rechtstreeks in de boekhouding en kun je dat ongedaan maken.

## Aanzetten

1. *Instellingen → Voor de boekhouder → Toon de boekhouding voor je boekhouder (grootboek, balans en exports)*.
2. De app legt uit dat deze functies voor wie boekhoudt zijn, en dat we geen ondersteuning geven op een administratie waarin buiten de boekhouder om in deze modus is geschreven. Vink *Ik begrijp dit* aan en kies *Aanzetten*. Dat akkoord wordt onthouden.
3. In het menu verschijnt *Boekhouding*; bij *Bank* verschijnt de lijst *Ingelezen afschriften*.

Uitzetten kan altijd met hetzelfde vinkje. Kijken (balansen, kaarten, rapporten, exports) verandert niets aan de administratie; alleen boeken, terugdraaien, rekeningen wijzigen en afschriften weghalen grijpen in. Die handelingen legt de app vast: bij *Instellingen → Over* staat of er ooit in de boekhoudermodus is geschreven, en het pakket voor de boekhouder heeft er een controle voor. Wat via de uitwisseling uit een antwoord van de boekhouder komt, telt daarin niet mee.

## Wat er onder Boekhouding staat

De tabbladen, met bovenaan een periode (*Van* en *Tot*):

- **Kolommenbalans**: beginbalans, mutaties debet en credit en eindsaldo per rekening, met de controle of debet en credit gelijk zijn. Filter op balans of winst en verlies; klik op een rekening voor de kaart.
- **Grootboekkaarten**: alle boekingen op één rekening, met de bron (factuur, bon, bankregel).
- **Relatiekaarten**: per klant of leverancier wat er gefactureerd en betaald is.
- **Periodebalans**: de balans per periode naast elkaar.
- **Journaal**: alle journaalposten, met *Correctieboeking* (memoriaal) en *Terugdraaien*. Een teruggedraaide post krijgt een tegenboeking; de oorspronkelijke post blijft zichtbaar. Een correctieboeking kan een btw-code dragen en een vraagpost afboeken.
- **W&V en balans**: winst-en-verliesrekening en balans over de gekozen periode.
- **Exports**: auditfile (XAF 3.2), kolommenbalans en journaal als bestand, los van het [pakket voor de boekhouder](boekhouder.html#het-pakket-voor-je-boekhouder).
- **Leveranciersregels**: wat de app per leverancier heeft geleerd (categorie, btw, zakelijk deel), om te controleren en te corrigeren.
- **Controle**: signalen die de app zelf vindt: uitschieters per leverancier, btw-afwijkingen, openstaande vraagposten.
- **Rekeningschema**: rekeningen toevoegen met een officiële RGS-code, hernoemen, en een eigen rekening waarop nog niets geboekt is weer weghalen. Omzet- en btw-rekeningen beheert de app zelf, omdat de btw-aangifte eruit volgt. Bij een bv staan de rekeningen voor loon, rekening-courant, vennootschapsbelasting en kapitaal klaar.

## Grootboek en btw

De app boekt op het Referentie Grootboekschema (RGS). De btw-aangifte wordt uit de btw-codes op de regels gerekend, niet uit de saldi van de btw-rekeningen; een correctieboeking met btw-code komt dus in de aangifte van de periode van de btw-datum. Na *Ik heb de aangifte gedaan* ligt die periode voor de btw vast: een latere correctie met een btw-datum in die periode schuift de app naar de eerstvolgende open periode en meldt dat.

## Wat de boekhoudermodus niet doet

- Geen bankregels bewerken. Een verkeerde verwerking draai je terug via *Ongedaan maken* bij de betaling, of je haalt het hele afschrift weg: [Een ingelezen afschrift weghalen](afschrift-weghalen.html).
- Geen facturen wijzigen. Een verstuurde factuur corrigeer je met een creditfactuur.
- Geen afgesloten periode openen. Een afsluiting is definitief; correcties komen in de volgende periode.
