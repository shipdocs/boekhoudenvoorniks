# Bonnenscanner: de telefoon koppelen met de pc

Met de bonnenscanner maak je onderweg een foto van een bon en staat die daarna in de inbox van
BoekhoudenVoorNiks op je computer. Je koppelt je telefoon één keer met een QR-code; daarna stuurt de
telefoon zijn bonnen rechtstreeks naar je computer.

Dit is de korte beschrijving voor gebruikers. De volledige technische beschrijving wordt intern
bijgehouden. De code van de computerkant staat in `src/scanner/` en `src/sync/`.

**Stand:** de kant van de computer is gebouwd en getest, maar staat in de uitgebrachte app nog uit tot
de scanner-app voor Android er is. Zolang dat zo is, zie je in Instellingen niets van koppelen,
weigert de app te koppelen en luistert de computer nergens naar. De bonnenmap voor gewone bestanden
(onderaan dit document) werkt wel.

## Koppelen

- Op de computer kies je *Instellingen → Telefoon & bonnenmap → Telefoon koppelen*. Er verschijnt een
  QR-code, die je met de scanner-app op je telefoon scant.
- Een QR-code is voor **één telefoon** en **tien minuten** geldig. Scan je hem niet op tijd, of sluit je
  het venster, dan vervalt hij.
- Je kunt meerdere telefoons koppelen (hooguit tien). Per telefoon zie je op de computer de naam en
  wanneer hij voor het laatst iets stuurde.
- Met **Ontkoppelen** trek je de toegang van een telefoon in. Die telefoon kan daarna niets meer
  sturen of ophalen.

## Abonnement

Een nieuwe telefoon koppelen en het bijwerken van je klanten, projecten en btw-regels op de telefoon
horen bij het abonnement van BoekhoudenVoorNiks. Ontvangen blijft altijd werken: een telefoon die al
gekoppeld is, blijft gekoppeld, en de bonnen, foto's, klant- en projectwijzigingen en facturen die hij
stuurt, komen altijd aan en worden bevestigd, ook zonder abonnement. Ontkoppelen kan altijd. Is er weer
een abonnement, dan werkt alles meteen weer, zonder opnieuw te koppelen.

## Versleuteld, zonder cloud

- Alles gaat over je eigen netwerk, van de telefoon rechtstreeks naar de computer. Er is geen server
  en geen cloud van ons bij betrokken.
- Elk bericht is versleuteld en ondertekend met een geheime sleutel die in de QR-code zit. Elke
  telefoon heeft zijn eigen sleutel. Met een bericht dat de computer niet kan ontsleutelen, doet hij
  niets.
- De QR-code ís de sleutel. Daarom staat hij alleen tijdens het koppelen op het scherm en verloopt hij
  na tien minuten. Laat niemand er een foto van maken.
- Iemand anders op hetzelfde netwerk kan zien dát er berichten gaan, hoe groot ze zijn en wanneer,
  maar niet wat erin staat. Een aangepast bericht wordt geweigerd, en een bericht dat opnieuw wordt
  ingestuurd heeft geen tweede effect.
- De telefoon ruimt een bon pas op als de computer heeft bevestigd dat hij is opgeslagen, met een
  bevestiging die alleen met de sleutel te openen is.
- Is er geen verbinding met de computer, dan kunnen dezelfde versleutelde berichten ook als bestand
  via de bonnenmap reizen, of als bijlage van een mail aan de mailbox van je administratie. Ze blijven
  versleuteld met dezelfde sleutel: de dienst waarmee je de map gelijk houdt en je mailprovider kunnen
  ze niet lezen.

## Wat de computer naar een gekoppelde telefoon stuurt, en wat nooit

Een gekoppelde telefoon kan bonnen, foto's bij een project, klant- en projectwijzigingen en facturen
aanleveren. De computer controleert alles wat binnenkomt, en een telefoon kan nooit iets verwijderen.

Om onderweg een factuur te kunnen maken haalt de telefoon een beperkte set gegevens op. Dat is
alleen lezen, altijd versleuteld, en alleen voor een gekoppelde telefoon (zie *Abonnement*).

**Wel:**

- je **klanten** (relaties die klant zijn, of klant en leverancier tegelijk) met hun gegevens, en of
  hun btw-nummer bij de laatste controle geldig was;
- je **projecten** (klussen) van die klanten;
- de **btw-tabel**: de tarieven en de vaste teksten die op een factuur horen;
- je **eigen bedrijfsgegevens zoals ze op een factuur staan** (naam, adres, contactgegevens, KvK- en
  btw-nummer, IBAN en BIC), of de kleineondernemersregeling geldt, je standaard betaaltermijn en je
  factuursjabloon (kleuren, lettertype, logo en tekstblokken).

**Nooit:**

- leveranciers, en projecten die aan een leverancier hangen;
- boekingen, banktransacties, facturen en andere documenten uit je administratie;
- instellingen en geheimen: gegevens van je mail, koppelingen, licentie of betalingen;
- bankgegevens van je administratie, behalve het IBAN en de BIC die op elke factuur staan;
- je omzetbelastingnummer voor contact met de Belastingdienst.

Verder krijgt de telefoon alleen te horen of iets is aangekomen en wat de computer ermee heeft gedaan.
De plaats waar een bon is gefotografeerd gaat alleen mee als je locatie hebt aangezet (#32).

## Firewall en thuisnetwerk

- Telefoon en computer moeten op **hetzelfde thuisnetwerk** zitten (dezelfde wifi). Op een gastnetwerk
  dat apparaten van elkaar scheidt, werkt het niet.
- De computer luistert alleen op het lokale netwerk en neemt alleen verbindingen aan vanaf datzelfde
  netwerk, niet vanaf internet. Zonder gekoppelde telefoon (en zonder openstaande QR-code) luistert hij
  helemaal niet.
- **Windows:** de eerste keer dat je koppelt, vraagt de firewall of BoekhoudenVoorNiks toegang mag
  krijgen. Klik op *Toestaan* en laat het vinkje bij *Particuliere netwerken* (je thuisnetwerk) staan;
  de app legt dat vooraf uit. Klikte je op *Annuleren*, dan vindt je telefoon de computer niet. Je
  past het later aan in Windows bij "Een app toelaten via Windows Firewall".
- Krijgt de computer een ander adres, bijvoorbeeld na een herstart van de router, dan vindt de telefoon
  hem vanzelf terug. De computer maakt zich daarvoor op het netwerk bekend zonder computernaam of
  bedrijfsnaam.

## De bonnenmap als uitwijk

Zonder wifi-koppeling kan de telefoon bonnen ook in een map zetten die met de pc gelijk wordt gehouden
(Syncthing, Google Drive). Op de pc kiest de gebruiker die map bij *Instellingen → Telefoon &
bonnenmap*. Daar is geen protocol voor nodig, wel deze afspraken:

- De pc pakt alleen bestanden direct in de map op (geen submappen), met de extensie `.jpg`, `.jpeg`,
  `.png`, `.pdf` of `.xml` (e-factuur, UBL), tot 20 MB. De inhoud moet bij de extensie passen.
- Een bestand wordt opgepakt als grootte en wijzigingstijd drie seconden gelijk zijn gebleven; lege
  bestanden en namen die met `.` of `~` beginnen of op `.tmp`, `.part`, `.partial`, `.crdownload` of
  `.download` eindigen, slaat de pc over.
- Na verwerking verplaatst de pc het bestand naar de submap `verwerkt/`. Bestaat de naam daar al, dan
  wordt het `naam (2).jpg`. De pc verwijdert of overschrijft nooit iets.
- Hetzelfde bestand twee keer (zelfde inhoud) geeft één document: de pc herkent het aan de hash.
- De mappen `van-telefoon/` en `van-pc/` (voor de versleutelde berichten van een gekoppelde telefoon)
  liggen in dezelfde map; omdat het submappen zijn, pakt deze bewaking de bestanden daarin nooit op.
- Betaalwijze, notitie en locatie gaan langs deze weg niet mee.
- Een bestand uit de bonnenmap verandert de pc niet: het is een eigen bestand van de gebruiker, net als
  een bestand dat hij in de app sleept. Wat erin staat (ook een positie in de EXIF) blijft dus staan, in
  de map `verwerkt` en bij de bijlagen. In de database komt de positie alleen met locatie aan (#32).
