---
titel: Instellingen en back-ups
omschrijving: Wat er onder elk tabblad van Instellingen staat, waar je administratie staat, en hoe back-ups en updates werken.
hoofdstuk: Beginnen
volgorde: 30
---

## De tabbladen

*Instellingen* heeft bovenaan tabbladen. Verander je iets, klik dan onderaan op *Opslaan*.

- **Je bedrijf**: naam, adres, KvK- en btw-nummer, rechtsvorm (eenmanszaak, vof of bv) en je instapdatum. Hier staat ook de overstap-hulp.
- **Facturen & offertes**: nummering (en het volgende nummer zelf zetten), betaaltermijn, geldigheid van offertes, herinneringen, en de opmaak van je factuur (logo, kleuren, teksten).
- **E-mail**: de mailserver waarmee de app je facturen verstuurt (SMTP; de gegevens krijg je van je e-mailprovider) en een optionele kopie aan jezelf. Zonder mailserver kun je versturen met je eigen mailprogramma (zie [Versturen met je eigen mailprogramma](werk-en-facturen.html#versturen-met-je-eigen-mailprogramma)). Daaronder: het gratis bonnen-adres en je eigen mailbox koppelen, voor bonnen per mail (zie [Bonnen per mail](bonnetjes.html#bonnen-per-mail)).
- **Btw**: hoe vaak je aangifte doet, de kleineondernemersregeling, en je standaard btw-tarief.
- **Categorieën**: de kostensoorten waarin de app je bonnen indeelt. Je kunt namen aanpassen, een eigen categorie toevoegen (*+ Eigen categorie*) of categorieën verbergen die je nooit gebruikt.
- **Koppelingen**: webshop en betaaldiensten (WooCommerce, Shopify, Mollie, Stripe).
- **Telefoon & bonnenmap**: je telefoon koppelen voor de app voor Android, en een map op je computer waar de app bonnen uit leest. Zie [Telefoon](telefoon.html).
- **Automatisch & herkenning**: hoeveel de app zelf doet, en hoe bonnen gelezen worden (op je eigen computer, of met een hulpdienst die je zelf kiest).
- **Back-up, demo & updates**: zie hieronder.
- **Administraties**: meer dan één bedrijf op dezelfde computer. Elke administratie heeft eigen klanten, bonnen, bank en back-ups; je wisselt met één klik. Per administratie kun je de naam wijzigen (dat is de bedrijfsnaam uit *Je bedrijf*), de map openen (bijvoorbeeld om bij de back-ups te komen) en een administratie die je niet meer nodig hebt weghalen: *Weghalen…*, de naam typen, en de hele map gaat naar de prullenbak van je computer, waar je hem terug kunt halen. De administratie die open staat en de eerste administratie (die staat in de gegevensmap zelf) kun je niet weghalen; wil je helemaal opnieuw beginnen, kijk dan bij *Back-up, demo & updates*.
- **Voor de boekhouder**: het vinkje *Toon de boekhouding voor je boekhouder*. Dit is de [boekhoudermodus](boekhoudermodus.html): niet nodig voor gewoon gebruik.
- **Over**: welke versie je hebt en waar je gegevens staan. Hier mail je ook een vraag (*Vraag of feedback mailen*), en met *Idee of wens* ga je naar de pagina met [ideeën en wensen](../ideeen.html). Daar stuur je een idee in of stem je op de ideeën van anderen.

## Vof of maatschap: eigen vermogen per vennoot

Heb je een vof of maatschap, dan kan de app het eigen vermogen per vennoot bijhouden. Dat is een keuze: zolang je het niet instelt, werkt de app zoals altijd, met één eigen vermogen en *Jouw deel van de winst* voor de schatting van de inkomstenbelasting.

1. *Instellingen → Je bedrijf*, rechtsvorm *Vof*. Bij *Eigen vermogen per vennoot bijhouden?* kies je *Vennoten instellen*.
2. Vul per vennoot de naam en het winstaandeel in (2 tot 5 vennoten, samen precies 100%, hooguit 2 cijfers achter de komma). Met *Vennoot toevoegen* komt er een bij.
3. *Winst verdelen vanaf boekjaar*: vanaf dit jaar verdeelt de app de winst over de vennoten. De winst van eerdere jaren blijft bij de eerste vennoot, zoals het stond.
4. *Schatting inkomstenbelasting voor*: de schatting is per persoon; kies voor wie (met diens winstaandeel).
5. *Opslaan*.

De eerste vennoot houdt de rekeningen die er al waren (eigen vermogen, privé-opnamen en privé-stortingen). Voor elke andere vennoot maakt de app drie rekeningen met de RGS-codes voor firmant 2 tot en met 5, met de naam van de vennoot erbij (bijvoorbeeld *Eigen vermogen Bram*, *Privé-opnamen Bram* en *Privé-stortingen Bram*). Er wordt niets omgeboekt: het eigen vermogen dat er al stond, blijft bij de eerste vennoot. Heeft een andere vennoot daar een deel van, boek dat dan over met een memoriaalboeking, of vul het in bij de [overstap-hulp](overstappen.html#vof-of-maatschap-kapitaal-per-vennoot).

Bij de jaarafsluiting gaan de privé-opnamen en -stortingen van elke vennoot naar diens eigen vermogen, en verdeelt de app de winst of het verlies naar het winstaandeel. Een cent die bij het verdelen overblijft, gaat naar de vennoot met de grootste rest (bij gelijke rest de eerste); het totaal klopt altijd. Sluit je een jaar af (of ligt het bij je boekhouder), dan ligt de verdeling van dat jaar vast; breek je een uitwisseling met je boekhouder af, dan is dat jaar weer open en volgt het de huidige aandelen. Pas je daarna de aandelen aan, dan geldt dat alleen voor jaren die nog open zijn.

Een vennoot met boekingen of winstaandeel houdt zijn plaats in de lijst: je kunt zijn naam aanpassen, maar niet met een andere vennoot van plaats wisselen. Zo'n vennoot haal je ook niet zomaar weg, en zo'n vof zet je ook niet om naar een eenmanszaak of bv: dan moet het eigen vermogen eerst verrekend worden. Doe dat samen met je boekhouder.

### Privé per vennoot

Alles wat privé is, komt op de privérekening van één vennoot. De app kiest die nooit zelf: zonder keuze boekt hij het niet. Waar je de vennoot kiest:

- **Bank**: bij *Privé* (*Nee, privé van …*, *Privé gestort door …*), en bij een betaling aan je eigen bedrijf (*Privé van …*).
- **Bonnen en aankopen**: bij *Met privégeld* betaald, bij een privé-deel van de bon en bij een open rekening die je op *privé betaald* zet. Kies je daar *Voortaan altijd zo*, dan onthoudt de app de vennoot bij die leverancier.
- **Gemengd gebruik** (zakelijk deel onder 100%): de vennoot van het privédeel. De app onthoudt hem bij de leverancier, ook in *Instellingen → Categorieën → Gemengd gebruik*.
- **Kilometers**: *Wie reed?* De vergoeding is een privé-storting van die vennoot.
- **Investeringen**: bij *Ik gebruik het voortaan privé* kies je welke vennoot het meeneemt.
- **Vandaag**: bij een verkoop aan of factuur van je eigen bedrijf vraagt de app het eerst.

Een bon die anders vanzelf verwerkt zou worden, maar waarbij iets privé is, blijft staan tot je hem nakijkt en de vennoot kiest. Een eenmanszaak of bv merkt hier niets van.

## Waar je administratie staat

Alles staat op je eigen computer, in één gegevensmap met een databasebestand en de bijlagen (bonnen, facturen). Bij *Instellingen → Over* en *Back-up, demo & updates* zie je het pad. Wil je de map ergens anders, bijvoorbeeld op een tweede schijf, kies dan *Gegevensmap wijzigen…*; de app verplaatst alles en controleert het.

Er is geen cloud en geen account. Wissel je van computer, dan zet je een back-up terug (zie hieronder).

## Back-ups

- **Vanzelf**: de app maakt elke dag een back-up van de administratie die open staat (heb je er meer, dan krijgt elke administratie er een op de dag dat je hem opent), en ook vlak voordat hij iets ingrijpends doet (een periode afsluiten, een afschrift weghalen, een update). Je hoeft hier niets voor te doen.
- **Zelf een kopie maken**: *Instellingen → Back-up, demo & updates → Back-up maken*. Zet die kopie op een USB-stick of in je eigen cloudmap. Een back-up bevat je hele administratie, mét bijlagen.
- **Versleutelde kopie voor je boekhouder**: dezelfde plek, knop *Versleutelde kopie maken*, met een wachtwoord. Alleen met dat wachtwoord is de kopie te openen. Geef het wachtwoord apart door (bijvoorbeeld telefonisch), niet in dezelfde mail.
- **Hoe lang bewaren**: de wet vraagt meestal 7 jaar, en 10 jaar voor gegevens over onroerende zaken (zoals een eigen bedrijfspand) en voor verkopen via de Unie- of Invoerregeling. De termijn begint pas als een gegeven niet meer actueel is. De back-ups van de app helpen daarbij, maar vervullen de bewaarplicht niet vanzelf: bewaar je kopieën lang genoeg en controleer af en toe of je ze nog kunt terugzetten. Zie de [uitleg van de Belastingdienst](https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/administratie_bijhouden/administratie_bewaren/administratie_bewaren).
- **Terugzetten**: *Back-up terugzetten…*. Kies het bestand; de app maakt eerst een kopie van wat er nu staat, zodat je altijd terug kunt.

> Een back-up terugzetten vervangt je hele administratie door die van het moment van de back-up. Alles wat je daarna deed, is weg. Twijfel je? Maak eerst een nieuwe back-up.

## Demo en opnieuw beginnen

Op hetzelfde tabblad staat *Demo en opnieuw beginnen*: de demo-administratie bekijken, of helemaal opnieuw beginnen. Ook dan maakt de app eerst een back-up.

## Updates

De app kijkt zelf of er een nieuwe versie is en vertelt dat bovenaan het scherm. Bij de eerste start van een nieuwe versie maakt hij eerst een kopie van je administratie. Wat er per versie veranderd is, lees je bij [Wat is er nieuw](../wijzigingen.html). Je kunt automatisch bijwerken aan- of uitzetten.
