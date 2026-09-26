# Wijzigingen

## Nog niet uitgebracht

## 0.3.3 — bonnetjes per mail, eigen categorieën en btw-details

- **Waar komt dit bedrag vandaan?** Bij Belasting klik je op Omzet, ontvangen btw of terug te krijgen btw
  (of op 🔍 details bij een vak van de aangifte) en je ziet welke boekingen erin zitten: datum, klant of
  leverancier, en of het uit een factuur, een bankbetaling, een bonnetje of een handmatige boeking komt. Met
  *Bekijken* ga je er meteen heen. Omzet zonder factuur die van de bank komt, wordt apart uitgelegd.

- **Bonnetjes per mail**: geef je administratie een eigen mailadres (bijvoorbeeld administratie@jouwbedrijf.nl)
  en vul het in bij Instellingen → E-mail → Inkomende post. De app kijkt bij het opstarten en elk kwartier
  (of met *Nu ophalen*) en zet facturen en bonnen uit de bijlagen klaar bij Aankopen & bonnetjes. Er wordt
  niets vanzelf geboekt: alles wacht op je controle. Veilig:
  - alleen echte PDF's, foto's en e-facturen (gecontroleerd op de inhoud, niet op de naam), geen logo's,
    hoogstens 10 MB per bijlage;
  - mail wordt nooit verwijderd; mail met een opgehaalde bijlage gaat naar de map "Verwerkt";
  - gelezen of gearchiveerde mail gaat niet mis en komt niet dubbel binnen: de app onthoudt welke berichten
    hij al zag, en kan desgewenst ook je archiefmap doorzoeken (daar wordt niets verplaatst);
  - mail van een klant blijft ongelezen en onaangeroerd; je krijgt een seintje op Vandaag, bij de klant en
    op de factuur;
  - "je factuur staat online" zonder bijlage wordt een taak op Vandaag, met alleen de naam van de website
    (geen link om op te klikken: nep-mails met links zijn een bekende truc);
  - andere mail blijft gewoon staan.
  Met een kant-en-klare tekst om naar je leveranciers te sturen.
- **Antwoorden gaan naar**: bij de uitgaande mail kun je instellen waar klanten op antwoorden, bijvoorbeeld
  je gewone mailadres.

- **Eigen categorieën** bij "Was dit zakelijk?" en bij bonnetjes: met *+ Eigen categorie* voeg je er een toe
  (bijvoorbeeld Vakliteratuur of Steigerhuur), met *✎ Aanpassen* verander je naam, uitleg en btw van alle
  categorieën, of verberg je wat je niet gebruikt. Ook onder Instellingen → Categorieën. Veilig: er wordt nooit
  iets verwijderd, eerdere boekingen veranderen niet mee, en een eigen categorie boekt op de rekening van een
  vaste soort kosten ("hoort bij"), zodat je boekhouder alles terugvindt. Een aangepaste vaste categorie kan
  terug naar de standaard.

- **Offerte ziet er niet meer uit als een factuur**: uitleg bovenaan (een prijsvoorstel, nog niets in je
  boekhouding; bij "ja" wordt het met één klik een factuur), "Wat ga je doen?" in plaats van "Wat heb je
  gedaan?", en voorbeeldteksten die bij een offerte passen.
- **Geen opmaak-keuze meer in beeld** bij factuur en offerte: de standaard is goed. Wie zelf een opmaak
  heeft gemaakt, kiest die onder "Andere opmaak kiezen".
- **Omschrijving van een regel is weer breed**: een lang btw-label drukte het veld eerder samen.

- **E-mail testen**: *Test verbinding* gebruikt nu wat je hebt ingevuld, ook een ingetypt wachtwoord dat
  nog niet was opgeslagen (na een geslaagde test wordt het meteen bewaard). Voorheen kwam dan de melding
  'Missing credentials for "PLAIN"'. Foutmeldingen van de mailserver staan nu in gewone taal (wachtwoord
  ontbreekt, inloggen lukt niet, server niet gevonden, poort en beveiliging passen niet). Een waarschuwing
  als het afzenderadres een ander domein heeft dan je gebruikersnaam (tikfout?).
- **Buitenlandse klant met eigen bedrijfsnummer**: bij een klant buiten Nederland heet het veld
  "Handelsregisternummer" en hoeft het geen 8-cijferig KvK-nummer te zijn (bijvoorbeeld een Zwitserse UID
  `CHE-253.742.182`). Een Zwitsers btw-nummer mag met streepjes, punten en "MWST". Op de e-factuur komt een
  buitenlands nummer niet meer als Nederlands KvK-nummer te staan.

## 0.3.2 — buitenlandse klanten en te veel betaald

- **Land bij een klant**: het klantformulier (ook "Nieuwe klant" vanuit een factuur) heeft nu een landkeuze,
  met het btw-nummer erbij voor een buitenlandse klant. Voorheen kon je het land niet invullen, waardoor
  "Bedrijf in een ander EU-land (0%)" en "Klant buiten de EU (0%)" niet te gebruiken waren.
- **Btw bij buitenlandse klanten**: bij een klant buiten Nederland legt de factuur uit welke btw meestal
  hoort (bedrijf in de EU: verleggen; particulier in de EU: Nederlandse btw; buiten de EU: 0%), met een
  knop om alle regels goed te zetten. Vóór de btw-aangifte een signaal bij 21% op een factuur aan een
  bedrijf in een ander EU-land, en boven € 10.000 per jaar aan particulieren in andere EU-landen (OSS).
- **Klant heeft te veel betaald** (bijvoorbeeld een factuur twee keer betaald): een taak op Vandaag. Een
  terugbetaling aan die klant herkent de app aan het rekeningnummer en boekt hem niet als kosten.
## 0.3.1 — extra bankrekeningen en controles

- **Btw over privégebruik van een auto van de zaak** (vak 1d). Bij Instellingen → Btw vul je in of je er
  ook privé mee rijdt, de cataloguswaarde en sinds wanneer je de auto gebruikt. In de laatste aangifte van
  het jaar staat dan een controle met het bedrag (2,7% van de cataloguswaarde, vanaf het 5e jaar 1,5%, in het
  eerste jaar naar rato) en een knop *Neem op in deze aangifte*. Het jaaroverzicht heeft een notitie voor de boekhouder (ook over de
  bijtelling voor de inkomstenbelasting, die de app niet uitrekent).
- **Nieuwe controles vóór de btw-aangifte**: geld dat nog "onderweg" is tussen je eigen rekeningen, geld van
  een betaalprovider (Mollie, Stripe) dat nog niet op je bank staat, en een spaarrekening of potje dat onder
  nul staat. Zo merk je dat er een afschrift of beginsaldo ontbreekt.
- **Extra bankrekeningen** (Bank → Rekeningen → *Rekening toevoegen*): een spaarrekening, een btw-potje of
  een gewone tweede rekening. Naam en IBAN zijn te wijzigen, en elke rekening heeft een eigen beginsaldo
  (opnieuw invoeren vervangt het oude bedrag).
- **Overboekingen tussen eigen rekeningen** herkent de app aan het rekeningnummer. Ze tellen niet als omzet
  of kosten. Lees je van beide rekeningen het afschrift in, dan wordt de overboeking één keer geboekt en
  koppelt de app de andere kant eraan. Ongedaan maken draait beide kanten terug. Bij "voorzichtig" staat
  het als vraag op Vandaag, anders gebeurt het vanzelf.
- Releases krijgen de tekst uit deze CHANGELOG. De controlegetallen (`SHA256SUMS-*.txt`) gebruiken de
  bestandsnamen zoals ze op GitHub staan, zodat `sha256sum -c` de AppImage ook echt controleert.

## 0.3.0 — aftrekposten, demo en gewone taal

### Duidelijker
- **Alle teksten in gewone taal nagelopen** (meldingen, knoppen, foutmeldingen, taken op Vandaag). Vaktaal
  is vervangen of in één regel uitgelegd. Wat echt voor de boekhouder is, staat bij *Notities voor je
  boekhouder* in het jaaroverzicht en gaat mee met "Kopieer voor je boekhouder".
- Interne boekhoudfouten verschijnen niet meer als vaktaal, maar als een gewone melding.
- Overal "btw" (zoals de Belastingdienst het schrijft).
- Btw-overzicht: "Min: btw die je terugkrijgt" staat nu als positief bedrag; verlegde btw noemt ook buitenlandse leveranciers.
- Zoeken of filteren zonder resultaat toont "Geen facturen gevonden" in plaats van "Nog geen facturen".
- E-mail: bij SSL/TLS springt de poort mee naar 465 (STARTTLS: 587); "Verbinding testen" meldt als server of afzender ontbreekt.

### Nieuw
- **Aftrekposten** (Belasting → Aftrekposten, bedrijfsmiddelen en kilometers):
  - **Bedrijfsmiddelen en afschrijving**: aankopen vanaf € 450 worden bedrijfsmiddelen. De app schrijft ze
    lineair af (minstens 5 jaar) en boekt de afschrijving na afloop van het jaar. Verkopen verwerkt de app met
    de boekwaarde.
  - **Kleinschaligheidsinvesteringsaftrek (KIA)** en de desinvesteringsbijtelling (tabellen 2025 en 2026).
  - **Privéauto**: € 0,25 per zakelijke km (2025: € 0,23). Tanken en parkeren worden dan als privé
    voorgesteld en nooit automatisch als kosten geboekt.
  - **Etentjes, borrels & relatiegeschenken**: nieuwe categorie. De app telt 20% bij (of de drempel, als die lager is).
  - **Startersaftrek** en een **urenteller** voor het urencriterium (werkbonnen + losse uren).
  - **Voor je aangifte**: jaaroverzicht met per regel het bedrag, de uitleg en waar het in de aangifte hoort.
    Plus een signaal voor mogelijke EIA/MIA/Vamil, met de RVO-termijn.
  - **Investering of kosten?** Vanaf € 450 excl. btw vraagt de app bij het invoeren "Gaat dit langer dan
    een jaar mee?". Op Vandaag staat een vangnet voor wat toch als kosten is geboekt. Ook laptops, telefoons en
    aanhangers worden herkend. De grens rekent nu met het bedrag excl. btw.
  - **Telefoon, internet en werkplek thuis**: het zakelijke deel instellen (het privédeel telt bij de winst,
    met de btw-correctie), plus uitleg over de werkplek.
  - **Meewerkaftrek** voor een partner die onbetaald meewerkt.
  - **AOV en pensioen**: uitleg dat ze privé zijn, maar wel aftrekbaar in de aangifte.
  - **2027**: zelfstandigenaftrek € 900, startersaftrek € 10; vanaf 2028 geen startersaftrek.
  - **Altijd laten controleren**: bij elke IB-berekening de melding dat een boekhouder of accountant moet
    meekijken, eens per jaar bevestigen, en een knop "Kopieer voor je boekhouder".
  - De schatting van de inkomstenbelasting rekent dit allemaal mee.
  - Bestaande gebruikers krijgen één nieuwe onboardingstap: *Auto en startjaar*.
- **Demo**: bij de eerste start (of via Instellingen → Back-up, demo & updates) de app bekijken met een
  voorbeeldbedrijf: klanten, offertes, facturen (betaald, open, vervallen), een klus, bonnetjes en een
  bankafschrift. In de demo gaat er geen e-mail naar buiten; een balk bovenaan toont dat je in de demo zit.
- **Wissen en echt beginnen**: de demo met één klik wissen, of de hele administratie leegmaken (met
  bevestiging "WISSEN" en eerst automatisch een veiligheidskopie in de back-upmap). Daarna start de
  onboarding opnieuw.
- **Onboarding die zichzelf bijwerkt**: de stappen hebben een versie. Na een update zien bestaande
  gebruikers alléén de nieuwe of gewijzigde stappen (met "Later"), niet de hele onboarding. Nieuwe stap:
  "Hoeveel mag de app zelf doen?" (voorzichtig / normaal / maximaal).
- **Aan de slag** op Vandaag: een lijstje (bedrijfsgegevens, IBAN, eerste klant, factuur, bankafschrift,
  bonnetje, e-mail) dat zichzelf afvinkt op basis van wat er in je administratie staat.

## 0.2.0 — slimme automatisering

Uitgangspunt: niet invoeren, maar uitzonderingen afhandelen. Boekingen komen altijd uit vaste,
uitlegbare regels; herkenning en AI doen alleen voorstellen.

### Nieuw
- **Gebeurtenissen als bron van waarheid** (#19): elke boeking wordt "gecompileerd" uit wat er gebeurd
  is. Corrigeren = de gebeurtenis aanpassen; de app maakt de tegenboeking en de nieuwe boeking.
- **Autopilot met zekerheid per beslissing** (#21, #29): voorzichtig / normaal / maximaal. Alles wat
  automatisch ging staat op Vandaag, met de reden ("Waarom?", #28) en een knop "Klopt niet".
- **Eén "Nog te doen"-lijst met controles vóór de btw-aangifte** (#20): onverwerkte bank, uitgaven
  zonder bewijs, dubbele aankopen, verlegd zonder btw-nummer, negatieve kas, vraagposten.
- **Leveranciersregels leren**, ook van correcties, pas automatisch na jouw ja (#22).
- **Dubbele documenten** herkennen op inhoud (#31); **btw-correcties** op al aangegeven periodes, met
  suppletie boven € 1.000 (#27).
- **Vaste lasten en abonnementen** (#30): herkenning na drie betalingen, melding bij een ontbrekende
  factuur of afschrijving, factuur direct aan de afschrijving koppelen, "gestopt?".
- **Betalen met een betaal-QR** (EPC, #25) met waarschuwing als het IBAN anders is dan vorige keer.
- **Belastingpotje** (#33): opzijgezet / nog te reserveren, en "vrij te besteden".
- **E-factuur (UBL, Peppol BIS 3.0)** standaard als bijlage bij de factuurmail (#24); uit te zetten in
  Instellingen. Ontbreken er gegevens voor de e-factuur, dan gaat de PDF alleen mee.
- **Factuurregels herkennen** en een gemengde bon per soort boeken (materiaal, gereedschap, werkkleding,
  privé), met btw per deel (#23).
- **Zoeken over alles** met Ctrl+K, met bedrag- en periodefilters en garantie per aankoop (#26).
- **Klussendossier** (#32): resultaat per klus uit het grootboek, werkbon die de factuur vult, "Was dit
  voor de klus bij …?". Locatie van bonfoto's alleen na toestemming (standaard uit, alleen lokaal).
- **Buitenland** (#16): verkoop aan EU-bedrijven (3b, met ICP-overzicht), uitvoer (3a) en verlegde btw
  op diensten uit/buiten de EU (4a/4b, bv. Stripe, Google, Meta). Met disclaimer; OSS zit er niet in.
- **Schatting inkomstenbelasting** (#33): zelfstandigenaftrek, mkb-winstvrijstelling, geversioneerde
  tarieven; altijd als schatting gemarkeerd en uit te zetten.
- **Ingebouwde tekstherkenning** (#8, #9): één knop in Instellingen downloadt GLM-OCR (MIT) en
  llama.cpp (± 1,4 GB, controle via sha256). Daarna volledig lokaal op de CPU.
- **Synthetische OCR-benchmark** met Nederlandse bonnen en facturen (#8).

### Belangrijk om te weten
- De buitenland-rubrieken en de tarieventabel van de inkomstenbelasting zijn nog niet door een
  fiscalist gecontroleerd; de app zegt dat erbij. Zie #44 en `docs/fiscale-review.md`.
- De database wordt bij de eerste start automatisch bijgewerkt. Maak voor de
  zekerheid eerst een back-up (Instellingen → Back-up & updates).

## 0.1.0 — eerste release

MVP, V2 en V3 uit het technisch plan: facturen en offertes, bonnetjes met herkenning, bankimport en
koppelen, btw-aangifte, koppelingen met webshops en betaalproviders, en exports voor de boekhouder.
