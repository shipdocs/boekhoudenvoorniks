---
titel: Offertes en facturen
omschrijving: Een offerte maken, de klant akkoord laten gaan, een factuur maken en versturen, en zien wie nog moet betalen.
hoofdstuk: Dagelijks werk
volgorde: 10
---

## Een offerte maken

1. Ga naar *Werk & facturen* en klik op *+ Nieuwe offerte*.
2. Kies de klant, of maak er een met *+ Nieuw* (naam, adres en, bij een bedrijf, het btw-nummer; voor een klant in de EU controleert de app dat nummer op verzoek bij VIES).
3. Vul de regels in: omschrijving, aantal, prijs en btw. Bij je vak horende regels staan klaar; typ de eerste letters.
4. *Voorbeeld* laat de pdf zien. *Opslaan* bewaart het concept, *Versturen* mailt hem naar de klant, via je eigen e-mailserver of met je eigen mailprogramma (zie [Versturen met je eigen mailprogramma](#versturen-met-je-eigen-mailprogramma)). *PDF opslaan* kan altijd.

Gaat de klant akkoord? Open de offerte en kies *Klant is akkoord*. Werk je met [klussen](klussen.html), dan staat er nu een klus klaar met die regels; zo niet, dan maakt de app er direct een conceptfactuur van.

## Een factuur maken

1. *Werk & facturen → + Nieuwe factuur*, of vanuit een klus *Factuur maken*.
2. Klant, datum en regels zoals bij een offerte. Bij *Datum levering of dienst* vul je in wanneer het werk was; bij een periode ook *t/m*. Dat staat op de factuur en telt voor de ICP-opgaaf bij diensten aan EU-bedrijven. In welke btw-aangifte de omzet valt, bepaalt de factuurdatum.
3. *Versturen* maakt de factuur definitief, geeft hem zijn nummer en mailt hem, via je eigen e-mailserver of met je eigen mailprogramma (zie hieronder). Je kunt niets meer aan een verstuurde factuur veranderen; een fout herstel je met een creditfactuur (zie hieronder).

Het factuurnummer zie je al op het concept. Het volgende nummer zelf zetten, bijvoorbeeld om door te nummeren vanuit je vorige pakket, doe je bij *Instellingen → Facturen & offertes*.

### Versturen met je eigen mailprogramma

Heb je geen e-mailserver ingesteld, of mail je liever zoals je gewend bent? Kies in het verstuurvenster *Versturen met je eigen mailprogramma*. De app opent het mailprogramma dat op je computer als standaard staat (Outlook, Thunderbird, Mail, enzovoort), met de klant als ontvanger, het onderwerp, de tekst en de pdf al als bijlage. Je hoeft niets in te stellen en er is geen extra account nodig. Je controleert de mail en klikt zelf op verzenden.

1. Kies *Versturen met je eigen mailprogramma*. Het mailvenster gaat open.
2. Verstuur de mail in je mailprogramma.
3. Terug in de app vraagt de app *Is de factuur verstuurd?* (bij een offerte: *Is de offerte verstuurd?*). Kies *Ja* als de mail echt weg is.

Pas bij *Ja* telt de factuur of offerte als verstuurd, en beginnen bij een factuur de betalingsherinneringen te lopen. Kies je *Nog niet*, sluit je de vraag of sluit je het mailvenster zonder te versturen, dan verandert er niets: de factuur staat er gewoon nog, en je kunt later opnieuw versturen. De pdf blijft staan in de map *Documenten → BoekhoudenVoorNiks → Te versturen*, zodat je mailprogramma hem kan inlezen, ook als je pas later op verzenden klikt. Dit is bewust een gewone, zichtbare map: een mailprogramma dat als snap of flatpak is geïnstalleerd, ziet verborgen en tijdelijke mappen niet. Na 30 dagen ruimt de app oude pdf's daar zelf op.

**Lukt het niet?** Heb je geen standaardmailprogramma, of kan het de bijlage niet aannemen, dan zegt de app *Je mailprogramma kon niet worden geopend.* en kun je kiezen voor *Gmail / Outlook op het web*. De app opent dan het schrijfvenster van Gmail of Outlook op het web, met ontvanger, onderwerp en tekst al ingevuld, en laat de pdf zien in je bestandsbeheerder. Sleep de pdf in het mailvenster en verstuur de mail. Die keuze staat ook naast de vraag *Is de factuur verstuurd?*, voor als je mailvenster niet verscheen.

**Herinneringen.** Automatische betalingsherinneringen gaan alleen via je eigen e-mailserver en openen nooit een mailvenster. Heb je geen e-mailserver ingesteld, dan staat de herinnering als taak op Vandaag. Open de factuur en stuur hem zelf.

**Boekhoudermodus.** In de kopie die je bij je boekhouder hebt, gaat er geen e-mail naar buiten, ook niet via je eigen mailprogramma.

### Btw op de factuur

Per regel kies je 21%, 9%, 0%, *btw verlegd* of *vrijgesteld*. Bij btw verlegd eist de app het btw-nummer van de klant op de factuur. Bij een klant buiten Nederland stelt de app het juiste tarief voor en legt uit waarom; meer daarover bij [Btw-aangifte](btw-aangifte.html#buitenland-en-bijzondere-gevallen).

### E-factuur meesturen

Bij *Instellingen → Facturen & offertes* kun je bij elke factuur een e-factuur (UBL) meesturen: een bestand dat boekhoudprogramma's zonder overtypen inlezen. Handig voor zakelijke klanten.

## Betaling ontvangen

Meestal hoef je niets te doen: lees je [bankafschrift](bank.html) in en de app koppelt de betaling aan de factuur. Is er contant of op een andere manier betaald, open dan de factuur en kies *Betaling ontvangen*.

Bij *Hoe gaat het?* staat *Wie moet nog betalen?* met alle openstaande facturen. Herinneringen gaan automatisch na de dagen die je bij *Instellingen → Facturen & offertes* instelt, als je dat aanzet.

## Een factuur corrigeren: creditfactuur

Open de factuur en kies *Factuur terugdraaien (creditfactuur)*. Je kunt de hele factuur crediteren of een deel. De creditfactuur krijgt een eigen nummer en verrekent de btw netjes in de juiste periode. Een factuur die niet meer betaald gaat worden, kies je *Afboeken als oninbaar*: de btw die je al afdroeg, krijg je dan in de aangifte terug.

## Omzet zonder factuur

Krijg je geld binnen uit een webshop, via Mollie of Stripe, of van een ander systeem waarin je al factureerde? Dan maak je geen factuur in de app. Bij de betaling bij *Bank* kies je *Verkoop via een ander systeem*; de app vraagt het btw-tarief en het nummer van de factuur uit dat systeem. Koppelingen voor webshops en betaaldiensten staan bij *Instellingen → Koppelingen*.

## Klanten

Bij *Klanten* zie je per klant de facturen, offertes en klussen. Een klant hoef je niet vooraf aan te maken: dat doe je terwijl je een offerte of factuur maakt.
