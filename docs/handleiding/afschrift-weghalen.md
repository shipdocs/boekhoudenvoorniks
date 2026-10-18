---
titel: Een ingelezen afschrift weghalen
omschrijving: Een verkeerd ingelezen bankafschrift helemaal weghalen, inclusief wat er al mee gedaan was, en het daarna opnieuw inlezen.
hoofdstuk: Voor de boekhouder
volgorde: 20
boekhouder: ja
---

## Wanneer

Een afschrift is verkeerd ingelezen: alle regels als "bij", een verkeerde rekening, een bestand van een ander bedrijf. In plaats van regel voor regel te negeren haal je het hele bestand weg, alsof het nooit is ingelezen, en lees je het goede bestand in.

Dit kan niet voor:

- rondes van de bankkoppeling (Ponto): die komen bij de volgende ronde vanzelf terug en staan daarom niet in de lijst;
- een afschrift met betalingen in een afgesloten periode.

## Zo doe je het

1. Zet de [boekhoudermodus](boekhoudermodus.html#aanzetten) aan.
2. Ga naar *Bank*. Onderaan staat *Ingelezen afschriften*: per bestand wanneer het is ingelezen, de rekening, de periode en het aantal regels (en hoeveel daarvan al verwerkt zijn).
3. Kies bij het afschrift *Weghalen*. De app laat eerst zien wat er gaat gebeuren (zie hieronder). Kies dan *Weghalen* in het venster, of *Annuleren*.
4. De app maakt eerst een back-up en haalt dan alles van dat bestand weg.
5. Lees het goede bestand in. Dat is nu een eerste keer: niets wordt als "stond er al" overgeslagen.

## Wat er precies gebeurt

- **Regels die nog niet verwerkt waren** gaan weg.
- **Regels die al verwerkt waren** krijgen eerst een tegenboeking op de dag van vandaag; een gekoppelde factuur of aankoop staat daarna weer open. Het venster noemt ze.
- **Bonnen die er als bewijs bij hingen** gaan terug naar *Even controleren*.
- **Regels uit latere afschriften die waren overgeslagen** omdat ze hier al stonden: het geld stond alleen in dit bestand, dus één ervan komt alsnog in, uit het oudste van die afschriften. Zijn er meer kopieën (dezelfde betaling in CSV, MT940 én CAMT), dan blijven de andere overgeslagen, nu tegen die ene.
- **Een betaling die ook in een ander afschrift staat dat je houdt** (bijvoorbeeld een week-afschrift dat ook in het maand-afschrift zit) blijft gewoon staan en hoort voortaan bij dat andere afschrift.
- **Regels die als dubbel van een regel hiervan uit de boekhouding waren gehaald** komen terug.
- **Wat de app over deze regels onthield** (overgeslagen vragen, afgehandelde dubbel-meldingen) gaat weg; de dekking *Bijgewerkt t/m* wordt opnieuw bepaald.
- Stond het bestand in de downloadmap, dan vraagt de app er niet opnieuw om; slepen kan altijd.

> Afschriften die met een versie vóór 1.7.0 zijn ingelezen, hebben geen vastlegging van "staat ook in een ander afschrift". Voor zulke oude overlappingen geldt de bescherming hierboven niet: controleer na het weghalen het saldo bij *Bank*.

## Daarna controleren

- *Bank*: klopt *Bijgewerkt t/m* en het saldo?
- *Vandaag*: zijn er nieuwe vragen (betalingen die weer open staan, bonnen bij *Even controleren*)?
- *Boekhouding → Journaal*: de tegenboekingen staan er met de omschrijving van de oorspronkelijke boeking.
