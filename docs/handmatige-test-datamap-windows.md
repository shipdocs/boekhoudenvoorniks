# Handmatige test: gegevensmap op Windows (NSIS-upgrade van 0.7.5)

De verhuizing van de gegevensmap van AppData naar `%USERPROFILE%\BoekhoudenVoorNiks` (#172) is
geautomatiseerd getest op Linux. Wat daar niet gedekt wordt — geheimen via DPAPI/Chromium
*Local State*, de echte AppData-mappen van Windows en de koppeling met Claude/Codex — staat in dit
stappenplan. Voer het één keer uit op een echte Windows-machine met een bestaande installatie.

De release wordt pas uitgebracht als dit formulier én de windows-latest CI-run zijn afgetekend; de
NSIS-release gaat vóór eventuele Store/MSIX-builds uit, zodat de verhuizing plaatsvindt terwijl de
gegevens nog gewoon in AppData staan en niet door MSIX-virtualisatie verborgen worden.

## Voorbereiding

1. Zet een echte Windows-machine (Windows 10 of 11) klaar met **0.7.5 via de NSIS-installer** en
   gebruik de app even echt:
   - een administratie met minstens één bijlage (bijvoorbeeld een ingescande bon bij Aankopen);
   - een SMTP-account bij Instellingen → SMTP (e-mail verzenden), zodat er een wachtwoord in de
     veilige opslag (safeStorage) staat;
   - een paar boeking(en), zodat de administratie herkenbare inhoud heeft.
2. Noteer welke oude map er is: `%APPDATA%\boekhoudenvoorniks` (gebruikelijk) of
   `%APPDATA%\gratis-boekhouden` (installatie van vóór de naamswijziging). Beide paden kunnen in de
   rest van dit stappenplan voorkomen; `%APPDATA%` is `%USERPROFILE%\AppData\Roaming`.
3. Maak zelf een back-up: kopieer de volledige oude map naar een veilige plek. De migratie kopieert
   alleen en houdt de bron intact, maar bij een releasetest hoort een eigen back-up bij de voorzorg.
4. Sluit de app af en sluit ook Claude/Codex af (of een andere client die de `--mcp`-koppeling
   gebruikt), zodat niets de oude map vasthoudt tijdens de upgrade.

## Stappen en verwachte resultaten

Vul per controle het resultaat in. Zet bij een afwijking ook de versie en het bouwtijdstip van de
geteste installer in de bevinding.

### 1. Upgrade en eerste start (één oude map met gegevens)

1. Installeer de nieuwe versie (eerste release na 0.7.5 met de gedeelde gegevensmap) met de gewone
   NSIS-installer, **bovenop de bestaande 0.7.5-installatie**. Niet eerst de-installeren: dit is
   een upgrade-test.
2. Start de app. Verwacht:
   - een voortgangsindicator met de knop *Stoppen* (deze ronde niet aanklikken);
   - na afloop een melding dat de gegevens zijn overgezet, met het advies Claude/Codex opnieuw te
     starten zodat de koppeling de nieuwe map leest.
3. Controleer in Verkenner:
   - `%USERPROFILE%\BoekhoudenVoorNiks` bestaat en bevat onder andere `boekhouding.sqlite`,
     `administraties`, `bijlagen`, `backups`, `ocr` en het markerbestand `migratie-klaar` (een klein
     JSON-bestand met onder andere de bronmap en het tijdstip).
   - de oude map bestaat nog en heet nu `<oude naam>.gemigreerd-<jjjjmmdd-uummss>`, bijvoorbeeld
     `boekhoudenvoorniks.gemigreerd-20261001-120000` (met `-2`, `-3`… als die naam al bestond). De
     inhoud is nog volledig aanwezig.

   Resultaat: `migratie-klaar` bestaat in de gedeelde map
   ☐ geslaagd ☐ niet geslaagd — bevinding: ______________________________

   Resultaat: oude AppData-map nog aanwezig als `<naam>.gemigreerd-<tijdstip>`
   ☐ geslaagd ☐ niet geslaagd — bevinding: ______________________________

4. De administratie opent vanuit de gedeelde map: de app start zonder foutmelding en toont de
   bestaande administratie (saldi, relaties, boeking van de voorbereiding kloppen).
   Controleer eventueel dat de app nu uit `%USERPROFILE%\BoekhoudenVoorNiks` werkt en niet meer uit
   AppData (het bestand `boekhouding.sqlite` ligt in de gedeelde map).

   Resultaat: administratie opent vanuit `%USERPROFILE%\BoekhoudenVoorNiks`
   ☐ geslaagd ☐ niet geslaagd — bevinding: ______________________________

5. Open één van de bijlagen (bijvoorbeeld een bon bij Aankopen of de PDF van een verkoopfactuur).
   Het bestand opent gewoon in de juiste kijker: de bijlagepaden zijn tijdens de migratie naar de
   nieuwe map bijgewerkt.

   Resultaat: een bijlage opent
   ☐ geslaagd ☐ niet geslaagd — bevinding: ______________________________

6. Geheim uit de veilige opslag nog leesbaar: ga naar Instellingen → SMTP en verzend een testmail
   (of haal e-mail op via de IMAP-instellingen) **zonder het wachtwoord opnieuw in te typen**. Typ
   je het wachtwoord wél opnieuw in, dan mask je juist een defect. Op Windows zit de sleutel van
   safeStorage in DPAPI, afgesloten in het bestand *Local State* van de gebruikersmap; dat bestand
   is vóór de eerste start uit de oude map overgenomen. Lukt het ontsleutelen niet, dan is het
   wachtwoord weg en verstuurt/haalt de app geen mail meer.

   Resultaat: safeStorage-geheim (SMTP/IMAP-wachtwoord) nog leesbaar
   ☐ geslaagd ☐ niet geslaagd — bevinding: ______________________________

7. De `--mcp`-koppeling leest de nieuwe map: herstart Claude/Codex (of de client met de
   koppeling) en vraag de koppeling iets waarvan je nieuw versus oud kunt zien — maak vóór het
   herstarten eerst een herkenbare boeking in de app. De koppeling toont die nieuwe boeking en
   geeft geen foutmelding: hij leest voortaan uit `%USERPROFILE%\BoekhoudenVoorNiks`.

   Resultaat: `--mcp`-koppeling leest de nieuwe map na herstart van Claude/Codex
   ☐ geslaagd ☐ niet geslaagd — bevinding: ______________________________

### 2. Beide oude mappen met gegevens (keuzedialoog)

1. Maak de situatie "beide mappen met gegevens": zorg dat `%APPDATA%\boekhoudenvoorniks` én
   `%APPDATA%\gratis-boekhouden` elk een `boekhouding.sqlite` bevatten (bijvoorbeeld door de eerder
   hernoemde map terug te hernoemen en er een kopie van een oude `gratis-boekhouden`-map naast te
   zetten). Verwijder vervolgens tijdelijk `%USERPROFILE%\BoekhoudenVoorNiks` (of in ieder geval
   `migratie-klaar` en `.migratie-keuze` daarin), zodat de migratie opnieuw kan starten.
2. Start de app. Er komt géén automatische keuze: een dialoog toont beide mappen met per map de
   laatste wijziging, de grootte en het aantal administraties.
3. Sluit de dialoog zonder te kiezen. De app stopt dan. Controleer: beide oude mappen zijn
   onaangetast (zelfde bestanden, zelfde tijden en groottes), er is geen `.migratie-keuze`, geen
   `migratie-klaar`, en er is geen *Local State* in de wortel van
   `%USERPROFILE%\BoekhoudenVoorNiks` (uiterlijk een map `.keuze-sessie` mag blijven staan; die
   wordt bij de volgende start gewist).
4. Start opnieuw en kies nu één van de twee mappen in de dialoog. De app zet de keuze weg in
   `.migratie-keuze` in de gedeelde map en herstart één keer; daarna verloopt de gewone
   migratie vanuit de gekozen map.
5. Controleer na afloop: de gekozen map heet `<naam>.gemigreerd-<tijdstip>`; de níet-gekozen map
   heeft nog gewoon zijn oude naam en is onaangetast. Die map wordt nooit hernoemd of verwijderd.

   Resultaat: keuzedialoog bij beide mappen met gegevens (tonen, niets kiezen stopt netjes, kiezen
   migreert de gekozen map; de andere blijft met oude naam bestaan)
   ☐ geslaagd ☐ niet geslaagd — bevinding: ______________________________

### 3. Losse controles (aanbevolen)

- `--mcp` vóór de eerste start van de app: op een schone Windows-gebruiker (geen gegevens, geen
  `migratie-klaar`) geeft de koppeling de melding *"Er is nog geen administratie. Open
  BoekhoudenVoorNiks eerst één keer."* en stopt met een foutmelding; er wordt niets aangemaakt. (Met
  beide oude mappen en nog geen keuze is de melding *"Open de app eerst om je gegevens over te
  zetten"*.)
  ☐ geslaagd ☐ niet geslaagd — bevinding: ______________________________
- Ongeldige verwijzing: maak `%USERPROFILE%\.boekhoudenvoorniks.json` met de inhoud
  `{"version": 1, "dataDir": "C:\\bestaat\\niet"}`. Zowel de app (blokkerende foutdialoog die het pad noemt) als `--mcp`
  (foutmelding, exitcode ongelijk aan nul) weigeren dan; er wordt geen lege administratie
  aangemaakt. Verwijder daarna het bestand weer.
  ☐ geslaagd ☐ niet geslaagd — bevinding: ______________________________

## Aftekening

| Punt | Resultaat |
|---|---|
| Alle controles hierboven geslaagd op een echte Windows-machine | ☐ |
| windows-latest CI-run (data-dir-tests) groen | ☐ |
| NSIS-release uitbrengen vóór eventuele Store/MSIX-build | ☐ |

Vastgelegd door (naam/datum) en versie van de geteste installer:
______________________________ ______________________________
