# Windows-versie via de Microsoft Store

Status: onderzocht op 30 september 2026, bij [issue #172](https://github.com/shipdocs/boekhoudenvoorniks/issues/172).

## Besluit

**Ja, BoekhoudenVoorNiks kan zonder een eigen publiek code-signingcertificaat in de Microsoft
Store worden gepubliceerd. Gebruik daarvoor een MSIX/AppX-pakket, niet de bestaande NSIS-EXE.**

Microsoft ondertekent een MSIX/AppX na certificering opnieuw met een Microsoft-certificaat. Een
Store-installatie geeft daardoor geen SmartScreen-waarschuwing en Store-updates worden door
Windows verzorgd. Bij de alternatieve Store-route met een MSI- of EXE-installer moet de uitgever
de installer en de PE-bestanden juist zelf ondertekenen met een publiek vertrouwd certificaat.

Bronnen:

- [Microsoft: opties voor code signing](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Microsoft: distributieroutes vergelijken](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/choose-distribution-path)
- [Microsoft: een Electron-app als MSIX verpakken](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/guides/electron-packaging)

| Route | Eigen publiek certificaat | Updates | Gevolg voor de huidige download |
|---|---|---|---|
| Store met MSIX/AppX | Nee; de Store ondertekent na certificering | Microsoft Store | Aanbevolen Store-route |
| Store met de bestaande `Setup.exe` | Ja | De app zelf | Lost het certificaatprobleem niet op |
| `Setup.exe` via GitHub | Ja, voor een normale SmartScreen-ervaring | `electron-updater` | Kan parallel blijven bestaan, maar blijft zonder certificaat waarschuwen |

De Store levert ook echte vindbaarheid: een openbare, vindbare inzending kan worden gevonden via
zoeken, bladeren en samengestelde Store-lijsten. Partner Center kan per markt bepalen waar de app
beschikbaar is. Zie [zichtbaarheid](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/visibility-options)
en [prijs en beschikbaarheid](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/price-and-availability).

## Aansluiting op deze app

De huidige techniek vormt geen principiële blokkade:

- Electron ondersteunt MSIX en meldt in zo'n pakket `process.windowsStore === true`.
- De gebruikte `electron-builder` 26 ondersteunt het Windows-doel `appx`, de naam die deze tool
  nog voor het MSIX/Store-formaat gebruikt. Het voegt voor Electron automatisch `runFullTrust` toe.
- De app schrijft administratie, bijlagen, back-ups en het OCR-model naar `userData`, niet naar de
  alleen-lezen installatiemap. Windows kan bestaand AppData van een niet-verpakte desktop-app aan
  een verpakte versie aanbieden. Dit moet met onze echte installatie worden getest; het is geen
  bewijs dat alle gegevens en versleutelde geheimen probleemloos overkomen. Zie
  [hoe verpakte desktop-apps draaien](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes).

Er zijn wel twee distributievarianten met verschillend updategedrag. De huidige GitHub/NSIS-versie
moet `electron-updater` blijven gebruiken. In de Store-versie moet die updater uit staan, omdat de
Store het pakket bijwerkt. De knop en status voor updates moeten daar naar de Store verwijzen of
niet worden getoond.

## Uitvoerbaar stappenplan

### 1. Product in Partner Center aanmaken

De productnaam is gereserveerd. Partner Center heeft de volgende publieke identiteit toegekend:

| Veld | Waarde |
|---|---|
| `Package/Identity/Name` | `ShipDocs.BoekhoudenVoorNiks` |
| `Package/Identity/Publisher` | `CN=B884F2A1-35F1-4BD8-9EB7-F2746D9FB427` |
| `Package/Properties/PublisherDisplayName` | `ShipDocs` |
| Package Family Name | `ShipDocs.BoekhoudenVoorNiks_xxc75kaw9g27y` |
| Package SID | `S-1-15-2-3905005716-3216547000-2216740364-2595733345-4201265192-1642952654-1993401824` |
| Store ID | `9NZ4D5JNN5BM` |

De HTML-weergave in Partner Center zette achter enkele gekopieerde waarden `&#x20;`; dat is alleen
een afsluitende spatie en maakt geen deel uit van de identiteit.

Zet de eerste inzending op **Private audience** met Microsoft-accounts van de testers. Let op:
   een product dat eenmaal met een public audience is ingediend, kan later niet terug naar private.

De drie identiteitswaarden worden door Partner Center toegekend en mogen daarom niet worden
gegokt of van `appId` worden afgeleid. Zie [Product identity](https://learn.microsoft.com/en-us/windows/apps/publish/view-app-identity-details)
en [een naam reserveren](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/reserve-your-apps-name).

### 2. Afzonderlijk Store-pakket bouwen

Voeg na ontvangst van de identiteit een apart Windows-builddoel toe. Behoud `nsis` voor GitHub en
bouw voor de Store `appx` op een Windows-runner. De configuratie moet minimaal bevatten:

- de drie exacte Partner Center-identiteitswaarden;
- `applicationId` zonder spaties, bijvoorbeeld `BoekhoudenVoorNiks`;
- `languages: [nl-NL]`;
- Store-afbeeldingen in `build/appx/` in de maten die `electron-builder` voorschrijft;
- eerst alleen `x64`; voeg `arm64` pas toe nadat de native module `better-sqlite3` en de lokale
  OCR-runtime daarop afzonderlijk zijn gebouwd en getest.

Voor de Store mag het te uploaden pakket ongesigneerd zijn; een lokaal te installeren proefpakket
heeft wel een tijdelijk testcertificaat nodig dat op de testcomputer wordt vertrouwd. Publiceer het
Store-pakket niet als los MSIX-bestand op GitHub: buiten de Store ondertekent Microsoft het niet.

### 3. Store-variant in de app herkennen

Gebruik `process.windowsStore` in het hoofdproces om voor de Store-variant:

- geen controles via `electron-updater` te starten;
- geen GitHub-update te downloaden of `quitAndInstall` aan te roepen;
- in Instellingen uit te leggen dat updates automatisch via Microsoft Store komen.

Laat de NSIS-variant ongewijzigd via GitHub bijwerken. Zo kunnen beide distributiekanalen naast
elkaar blijven bestaan zonder dat de ene variant het pakket van de andere probeert te installeren.

De normale release kan daarmee één bronversie en twee Windows-artifacts opleveren:

1. `Setup.exe` gaat zoals nu naar GitHub Releases; bestaande installaties vinden hem met
   `electron-updater`.
2. Het MSIX/AppX-pakket met hetzelfde appversienummer gaat naar een nieuwe Partner
   Center-inzending; na certificering werkt de Store zijn installaties automatisch bij.

In de eerste tranche is stap 2 bewust handmatig. Als de Store-route stabiel is, kan het uploaden en
aanmaken van een inzending met de Microsoft Store submission API worden geautomatiseerd. De
certificering door Microsoft blijft onderdeel van die route.

### 4. Besloten Windows-proef

Test eerst een private-audience-inzending op een schone Windows 11-computer en op een computer met
de laatste NSIS-versie. Bewaar vooraf een complete app-back-up. Controleer aantoonbaar:

- schone installatie, starten, afsluiten en verwijderen;
- bestaande administratie, bijlagen en automatische back-ups na overstap vanaf NSIS;
- ontsleutelen van bestaande SMTP-, IMAP- en API-geheimen via `safeStorage`;
- SQLite/native module, importeren, PDF maken, e-mail en bestandskiezers;
- lokale OCR downloaden en `llama-server.exe` vanuit de gegevensmap starten;
- Claude Code/Codex vinden en de MCP-koppeling met `--mcp` starten;
- update van Store-versie N naar N+1 met behoud van alle gegevens;
- dat de Store-variant nergens `electron-updater` start.

Voer daarnaast de Windows App Certification Kit uit. `runFullTrust` is een restricted capability;
licht in de certificeringsnotities kort toe dat dit een bestaande Electron-desktopapp is die lokaal
SQLite, bestanden, e-mail en optionele lokale OCR gebruikt. Microsoft vraagt bij restricted
capabilities om deze toelichting. Zie [capabilities](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations)
en [submission options](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/manage-submission-options).

### 5. Inzenden en pas daarna openbaar maken

Vul een Nederlandstalige Store-pagina in met beschrijving, categorie, screenshots, leeftijdsclassificatie,
support- en privacy-URL. Kies prijs **Free**; het bestaande optionele abonnement blijft buiten de
Store en verandert hierdoor niet. Upload het pakket en dien het in voor certificering.

Maak het product pas na de besloten proef public en discoverable. Voeg daarna de Store-link toe aan
de website en laat de GitHub-download als alternatieve installatie staan. Iedere nieuwe Store-versie
is een nieuwe Partner Center-inzending met een hoger pakketversienummer; bestaande gebruikers krijgen
hem via de Store. Zie [een MSIX-inzending maken](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission)
en [updates publiceren](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/publish-update-to-your-app-on-store).

## Nog nodig van de accounteigenaar

De productnaam en identiteit zijn bekend. Voor de besloten publicatie moet de accounteigenaar nog:

1. Microsoft-accounts voor de besloten proef kiezen;
2. de uiteindelijke Store-tekst, screenshots en marktkeuze bevestigen.

Dit onderzoek autoriseert nog geen openbare publicatie. De eerstvolgende technische tranche is:
Store-build, Store-updatergedrag en regressietests implementeren, daarna het private pakket op echte
Windows-installaties valideren.
