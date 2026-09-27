# Wijzigingen

## Nog niet uitgebracht

### Hersteld
- Auditfiles volgen nu de XAF 3.2-volgorde en taxonomiestructuur en zijn tegen het XAF-schema gevalideerd.
- Handmatige, dagelijkse en versleutelde back-ups bevatten voortaan ook alle bijlagen, met controlesommen en padherstel bij terugzetten op een andere computer. Oude `.sqlite`-back-ups blijven leesbaar met een waarschuwing dat ze geen bijlagen bevatten.
- Een terugbetaling aan een klant kan vanuit een negatieve bankmutatie aan de open creditfactuur worden gekoppeld.
- Na een mislukte eerste factuurmail wordt niet meer automatisch een betalingsherinnering verstuurd.
- Op Linux worden SMTP- en API-geheimen niet opgeslagen wanneer Electron alleen de onveilige `basic_text`-opslag kan aanbieden.
- Bijlagepaden, instellingen, browserrechten en het verpakte Electron-programma zijn verder afgeschermd.

### Techniek
- PDF.js wordt alleen geladen wanneer een PDF wordt bekeken; de renderer is daardoor opgesplitst in kleinere bundles.
- De Vite- en Vitest-configuratie gebruikt expliciete ESM-bestanden en geeft geen toekomstige config-loaderwaarschuwing meer.

## 0.4.0 — overstappen met een lopende administratie

- **Overstap-hulp** (#82, #83, #84): had je al een administratie, in een ander programma, in Excel of bij je
  boekhouder? Bij het begin vraagt de app "Heb je al een administratie?". Kies dan een instapdatum: 1 januari is
  aangeraden, maar elke datum kan, en de app zegt erbij wat dat betekent. Daarna vraagt de overstap-hulp in gewone
  taal, hoofdstuk voor hoofdstuk, wat er toen al was:
  - **wat je nodig hebt**: een lijstje om klaar te leggen (ook af te drukken);
  - **bankrekeningen**: het saldo aan het begin (uit het eindsaldo van je CAMT/MT940-afschrift berekend), je
    afschriften vanaf de instapdatum, en betalingen van vóór die datum met één klik overslaan;
  - **klanten die nog moesten betalen** en **rekeningen die jij nog moest betalen**: komt het geld later binnen,
    dan koppelt de app de betaling aan de oude factuur. Omzet en btw tellen niet nog eens;
  - **bus, auto en gereedschap**: verder afschrijven vanaf de waarde op 1 januari. Weet je die niet, dan rekent de
    app hem uit;
  - **btw** van de vorige aangifte die nog open stond, en bij instappen midden in een btw-periode het stuk van die
    periode, zodat de aangifte straks klopt;
  - **omzet en kosten tot nu toe** bij instappen midden in het jaar;
  - **leningen, borg en andere schulden**;
  - **je startpositie**: wat er van jou in de zaak zit (eigen vermogen), met controles: sluit het banksaldo aan,
    ontbreken er afschriften, klopt het met de balans van je boekhouder.
  Stoppen mag: alles is meteen bewaard, en "Je vorige administratie overzetten" staat op Vandaag tot het klaar is.
- **Uit je vorige programma inlezen**: sleep een bestand erop en de app vult de startbalans in. Jij kijkt het na
  en vinkt aan wat klopt:
  - een **auditfile** (XAF) uit bv. SnelStart, e-Boekhouden, Moneybird, Exact of Jortt: saldi, openstaande facturen
    per klant en leverancier, bus en gereedschap, btw, omzet en kosten tot de instapdatum, klanten en leveranciers;
  - een **kolommenbalans** als Excel (bv. uit DigiBoox) of een **saldibalans** (Excel of CSV);
  - een **lijst met openstaande facturen** (Excel of CSV): losse facturen in plaats van één totaal, zodat betalingen
    vanzelf koppelen. De app controleert of het totaal aansluit op je startbalans.
  De app herkent zelf wat voor bestand het is en welke kolom wat is. Lukt dat niet, dan stelt hij hooguit drie korte
  vragen en onthoudt hij het antwoord. Er is een voorbeeldbestand om in te vullen. Openstaande facturen kun je ook
  als **e-factuur** (UBL) erop slepen. Betalingen kort na de overstap die bij een oude factuur of de vorige
  btw-aangifte lijken te horen, stelt de app voor.
- Bedragen uit de overstap mogen voorlopig zijn (bv. als de jaarrekening nog niet klaar is). Aanpassen kan later
  altijd. Laat je startbalans nakijken door je boekhouder.

- **Bonnen in dollars die er al in stonden** (#74): oudere versies lazen "$ 90,00" als € 90,00. De app vindt die
  bonnen nu en rekent ze om:
  - een bon die je nog moet controleren wordt vanzelf opnieuw beoordeeld (er was nog niets geboekt);
  - een geboekte aankoop zie je op Vandaag en bij Aankopen ("staat als euro's in je boekhouding"). Bij **Nakijken**
    zie je wat er verandert: het bedrag dat van je rekening is afgeschreven komt in de boekhouding en de betaling
    wordt gekoppeld; zonder betaling de ECB-koers. **Alles omrekenen** doet ze in één keer. De oude boeking krijgt
    een tegenboeking; is de btw-aangifte van dat kwartaal al gedaan, dan gaat het verschil mee in de volgende;
  - staat de betaling al rechtstreeks als kosten geboekt, dan was de aankoop dubbel: die haalt de app weg en de
    bon wordt het bewijsstuk bij die betaling;
  - een aankoop zonder bon (of met een ander bedrag) reken je om met 💱 in de lijst met aankopen.
- **Niet meer dubbel**: een nieuwe bon in dollars bij een betaling die je al als kosten boekte, wordt het bewijsstuk
  in plaats van een tweede aankoop; en dezelfde bon nog eens toevoegen wordt herkend, ook als die eerder als euro's
  geboekt is.
- **Bon als PDF van meerdere pagina's** (#80): bij het nakijken zie je nu alle pagina's onder elkaar.
- **Doorgestuurde mail als bon** (#79): de tekst van de oorspronkelijke mail komt mee, ook uit een doorgestuurde
  .eml, en je eigen tekst erboven overstemt die niet meer.

## 0.3.9 — aankopen in vreemde valuta (dollars, ponden, …)

- **Aankopen in dollars (en andere munten)** (#74): de app herkent een bon of factuur in een andere munt ($, USD,
  £, CHF, …) en boekt hem in euro's, zonder extra velden:
  - staat de betaling al op de bank, dan telt **het bedrag dat de bank afschreef** (de echte koers). Bank en bon
    worden gekoppeld, ook al verschilt het bedrag door de koers van je bank;
  - nog geen betaling: omgerekend met de **dagkoers van de Europese Centrale Bank** op de factuurdatum (alleen
    de munt en de datum gaan naar de ECB; de koers wordt bewaard). Komt de betaling later, dan koppelt de app hem
    en boekt het kleine verschil als **koersverschil**;
  - geen internet: de app gokt niets en vraagt het bedrag in euro's zoals afgeschreven.
  Bij de bon en in de lijst met aankopen staat het oorspronkelijke bedrag en de koers erbij. Btw van een
  leverancier buiten de EU (verlegd, rubriek 4a) gaat over het bedrag in euro's. Laat de koers en de btw altijd
  controleren door je boekhouder.

## 0.3.8 — bonnen lezen naar keuze, vragen stellen via Claude Code/Codex, btw-termijn en potjes

- **Verbeteringen na de review**: een potje zonder IBAN wordt nu apart bijgehouden, zodat een afschrift met een
  nieuw rekeningnummer nooit op een potje terechtkomt en alleen echte potjes als "Naar potje" verschijnen;
  twee rekeningen met dezelfde naam kan niet meer; het btw-bedrag dat je bij een bon ziet is wat er geboekt
  wordt, en kan niet hoger zijn dan het tarief toelaat; "Payment date" wordt niet meer als factuurdatum gezien.
- **Kiezen hoe de app bonnen leest**: bij de eerste foto van een bon (en in Instellingen → Automatisch &
  herkenning) kies je, met uitleg:
  - **op deze computer**: eenmalig ± 1,5 GB downloaden, daarna zonder internet; alles blijft op je computer;
  - **met je eigen Claude Code** (Anthropic) of **Codex** (OpenAI), als je dat hebt: geen download, maar de foto
    gaat naar Anthropic of OpenAI. De assistent krijgt alleen die ene foto (in een lege map), mag verder niets
    (alleen lezen, geen andere hulpmiddelen) en heeft een tijdslimiet;
  - **zelf invullen**.
  De app installeert Claude Code of Codex niet en zoekt er pas naar als jij op **Zoek op deze computer** klikt
  (of het programma zelf aanwijst met **Kies zelf…**); wat gevonden is wordt onthouden. **Inloggen** opent een
  terminal met het programma erin; **Controleer** stuurt een heel klein proefbericht om te zien of het werkt.
  Bonnen die nog klaarlagen worden na het kiezen vanzelf gelezen. Wat de app leest is een voorstel: jij klikt
  op "Klopt", er wordt niets geboekt zonder dat je het ziet.
- **Vragen stellen over je boekhouding met Claude Code of Codex**: in Instellingen → Automatisch & herkenning
  voeg je met één klik (of een opdracht voor de terminal) een koppeling toe. Daarna vraag je bv. "Waarom is mijn
  btw dit kwartaal zo hoog?". De koppeling kan **alleen lezen**: de administratie wordt alleen-lezen geopend en
  er zijn alleen hulpmiddelen die iets opzoeken (overzicht, Vandaag, btw per periode en per vak, facturen,
  aankopen, bank, klanten, zoeken, inkomstenbelasting). Je vraag en wat de assistent opzoekt gaan naar
  Anthropic of OpenAI. Uitleg over btw of belasting is geen advies: laat het controleren door je boekhouder.

- **Btw-aangifte na de uiterste datum**: Vandaag bleef om de aangifte van een vorig kwartaal vragen, ook als je
  die al buiten de app deed. Nu vraagt de app na de uiterste datum eerst "Al gedaan, bv. via Mijn
  Belastingdienst of je boekhouder?" met de knop **Al ingediend** (die kan ook bij openstaande controles). Ook
  vóór de uiterste datum staat *Al ingediend* erbij. Op het Belasting-scherm zie je bij een lopend kwartaal
  wanneer je de aangifte doet.
- **Potje zonder eigen rekeningnummer** (bv. een Knab-potje voor de btw): een rekening toevoegen kan nu ook
  zonder IBAN. Bij een betaling kies je dan "Naar potje …" of "Uit potje …": geen kosten, niets "onderweg".
- **Bon controleren**: het formulier past weer binnen de kaart; het factuur- of bonnummer en het btw-bedrag kun
  je nu zelf aanpassen. Engelse facturen: datums als "May 6, 2026" worden herkend en een kopje als "Date of
  issue" wordt niet meer als leverancier gezien. Anthropic is een bekende leverancier (software, btw verlegd
  van buiten de EU). Datumvelden staan in het Nederlands (dd-mm-jjjj), ook op een Engelstalige computer.

## 0.3.7 — verkoop via een ander systeem (Mollie, webshop, kassa)

- **"Verkoop via een ander systeem"** (bij geld dat binnenkomt; heette "Omzet zonder factuur (contant/pin)"):
  voor een klant die je betaalde via bv. Mollie, je webshop, kassa, pin of contant, of voor een factuur die je
  ergens anders maakte. Zonder koppeling:
  - Je kiest nu zelf de btw; voorheen was dit altijd 21%, ook bij een klant in het buitenland. De app doet een
    voorstel op basis van de klant (herkend op IBAN of naam) of het land van de rekening; bij een klant buiten
    de EU is dat 0%. Het bedrag komt dan in de juiste rubriek van de aangifte.
  - Je kunt de naam van het systeem (bv. "Mollie") en het nummer van de factuur of bon erbij zetten; het
    nummer haalt de app zo mogelijk al uit de omschrijving van de bank. Je boekhouder vindt de factuur zo terug.
  - **De app onthoudt het**: bij de volgende betaling van dezelfde betaler vraagt Vandaag "Weer een verkoop via
    Mollie, net als vorige keer (klant buiten de EU, 0% btw)?" en is één klik op *Klopt* genoeg.

## 0.3.6 — automatisch bijwerken, zichtbaar en uit te zetten

- **Automatisch bijwerken, maar zichtbaar**: staat standaard aan. De app kijkt nu elke 4 uur (niet alleen bij
  het opstarten), downloadt op de achtergrond en installeert als je de app sluit. Bovenaan verschijnt
  "Versie … staat klaar" met *Wat is er nieuw?* en *Nu herstarten*; de app herstart nooit vanzelf midden in je
  werk. Bij de eerste start van een nieuwe versie maakt de app eerst een kopie van je administratie. Tevreden
  met wat je hebt? Zet het uit bij Instellingen → Back-up, demo & updates; *Zoek naar updates* werkt dan nog wel.

## 0.3.5 — mail doorsturen, bonnen in de mail en controles oplossen

- **Bon in de mail zelf** (geen bijlage), bijvoorbeeld van een webshop, Uber of een app: staat er een woord als
  factuur, bon of bestelling in én een bedrag, dan bewaart de app de mail als PDF-bon bij Aankopen & bonnetjes,
  om te controleren. Alleen de tekst: plaatjes, links en scripts uit de mail komen er niet in. Mist de app er
  een? Bij Instellingen → E-mail → Laatste berichten staat *Als bon bewaren*, en bij "factuur staat online" op
  Vandaag *Mail als bon bewaren*.

- **Facturen doorsturen naar je administratie-mailbox werkt nu**: mail vanaf je eigen adres werd overgeslagen
  (bedoeld voor kopieën van je eigen facturen), dus ook een factuur die je zelf doorstuurde. Nu wordt alleen
  een kopie van je eigen factuur of offerte overgeslagen (herkend aan je factuur- of offertenummer). Ook een
  mail die je "als bijlage" doorstuurt, wordt uitgepakt. Mail die eerder zo is overgeslagen, wordt na de
  update nog één keer bekeken.
- **"Nu ophalen"** zegt nu ook hoeveel mail er zonder factuur of bon was.

- **"Oplossen" laat nu zien welke betalingen het zijn**: bij "… staat nog bij *weet ik nog niet*", geld
  "onderweg", geld bij je betaalprovider, contant geld onder nul of een spaarrekening onder nul opent een
  lijst met de boekingen die samen dat bedrag vormen. Met *Opnieuw indelen* ga je naar die betaling. Voorheen
  kwam je alleen op het bankscherm en moest je zelf zoeken.
- **Ongedaan maken bij een betaling**: je blijft op dezelfde pagina en kiest meteen wat het wel was, in plaats
  van terug naar de lijst te gaan.

## 0.3.4 — getest in de browser: kleine verbeteringen

- **Factuur of offerte meteen versturen**: bij een nieuwe factuur of offerte staat *Versturen* er nu meteen
  (de app slaat eerst op). Voorheen moest je eerst op *Opslaan* klikken voordat die knop verscheen.
- **Versturen: het e-mailadres van de klant staat er weer in**, ook als je direct na het opslaan verstuurt.
- **Esc in een venster binnen een venster** (bv. *+ Eigen categorie* bij een bonnetje) sluit nu alleen dat
  venster. Voorheen ging het bonnetje-venster ook dicht en was je ingevulde gegevens kwijt.
- **Kleiner laptopscherm**: de lijst met aankopen past weer zonder opzij te schuiven.
- **Schermlezers**: de velden in de factuurregels en lege kolomkoppen hebben nu een naam.
- **End-to-end tests** (Playwright): de belangrijkste dingen die je in de app doet, worden bij elke wijziging
  automatisch in een echte browser doorlopen, met een controle op toegankelijkheid. Zie `e2e/README.md`.

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
