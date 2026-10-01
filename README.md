# BoekhoudenVoorNiks

Gratis, **local-first** boekhoudprogramma voor zzp'ers en kleine ondernemers in de bouw en techniek:
stukadoor, schilder, timmerman, loodgieter, elektricien, klusbedrijf.

> **De gebruiker beheert zijn bedrijf. De software maakt daarvan automatisch de boekhouding.**

De gebruiker denkt in *klant, klus, offerte, bonnetje, factuur, betaling, belasting*, niet in
grootboek, journaalposten of BTW-codes. Onder water draait wel een volledige dubbele boekhouding
op basis van RGS, zodat een boekhouder of accountant de administratie zo kan overnemen.

Desktop-app (Electron) voor Windows en Linux. De administratie staat in een SQLite-bestand op de
eigen computer, zonder account en zonder cloud. Het programma is gratis. Met een optioneel
abonnement (voor ondernemers, de eerste 4 maanden gratis, daarna € 9 per maand excl. btw) steun je
de verdere ontwikkeling en krijg je de extra functies; nu is dat de uitwisseling met je boekhouder.
Zie [boekhoudenvoorniks.nl](https://boekhoudenvoorniks.nl) en de [voorwaarden](https://boekhoudenvoorniks.nl/voorwaarden.html).

**Vragen of feedback?** Mail naar [info@shipdocs.app](mailto:info@shipdocs.app), of gebruik in de app
Instellingen → Over → *Vraag of feedback mailen*. GitHub-issues zijn voor ontwikkelaars.

## Wat zit erin

| | |
|---|---|
| **Vandaag** | Hoeveel geld heb ik, hoeveel is vrij te besteden, hoeveel krijg ik nog, hoeveel moet ik apart houden voor BTW (met een optioneel belastingpotje), en *moet ik iets doen?* De administratie werkt als een inbox die leeg kan ("Je bent bij ✓"). |
| **Werk & facturen** | Offertes → klant akkoord → klus → *werk klaar* → factuur in één klik. PDF + e-factuur (UBL, Peppol BIS 3.0) per e-mail (eigen SMTP). Doorlopende nummering, creditfacturen, betaalstatus, automatische herinneringen. Per klus een dossier: resultaat (omzet − materiaal − uitbesteed werk), werkbon die de factuur vult, en de vraag "Was dit voor de klus bij …?" bij een bon. Optioneel (standaard uit, alleen lokaal): de locatie van de bonfoto koppelt aan de klus. |
| **Opmaak** | Logo, kleuren, lettertype en vaste tekstblokken met live voorbeeld; eigen HTML-template in expertmodus. |
| **Aankopen & bonnetjes** | Betalen met een betaal-QR (EPC) voor je bank-app, met een waarschuwing als het rekeningnummer anders is dan vorige keer. Foto, PDF of e-factuur (UBL) erin. Eerst UBL, dan de PDF-tekstlaag, dan lokale OCR (GLM-OCR, download bij eerste gebruik). Daarna validatie, classificatie, een confidence-inschatting en de koppeling met de bank. Regels op de bon worden herkend; een gemengde bon (materiaal + werkbroek + iets privé) wordt op verzoek per soort geboekt. Bonnen kunnen ook vanzelf binnenkomen uit een **bonnenmap** (een map op je computer, bijvoorbeeld gesynchroniseerd met je telefoon; standaard uit): nieuwe bestanden komen in de inbox en gaan daarna naar de submap `verwerkt`. |
| **Bank** | Elke bank via CAMT.053 of MT940. CSV van ING, Rabobank, ABN AMRO, bunq, Knab, Triodos en Revolut wordt vanzelf herkend; bij andere banken wijs je één keer de kolommen aan. Wisselen van soort afschrift geeft geen dubbele betalingen, en een saldo dat niet klopt met je afschrift wordt gemeld. Als je dat aanzet, ziet de app een gedownload afschrift in je Downloads-map en vraagt of hij het mag inlezen. Automatische koppeling aan facturen en bonnetjes; de app leert per leverancier. Vaste lasten en abonnementen worden herkend (ontbrekende factuur of afschrijving wordt gemeld). |
| **Belasting** | BTW per kwartaal in mensentaal ("Te betalen € 3.365, uiterlijk 31 oktober"). Daaronder de officiële rubrieken (1a/1b/1e/2a/5a/5b/5g) om over te nemen in Mijn Belastingdienst Zakelijk. Vóór de aangifte controleert de app wat de aangifte fout kan maken (onverwerkte bank, uitgaven zonder bewijs, dubbele aankopen, verlegd zonder btw-nummer, negatieve kas, vraagposten). Periode-afsluiting, CSV-export en een XBRL-voorbereiding. Buitenland: verkoop aan EU-bedrijven (3b, met ICP-overzicht), uitvoer (3a) en verlegde btw op diensten uit/buiten de EU (4a/4b, bv. Stripe, Google, Meta), met een duidelijke disclaimer; OSS zit er niet in. Een schatting van de inkomstenbelasting (zelfstandigenaftrek, mkb-winstvrijstelling, geversioneerde tarieven), altijd als schatting gemarkeerd en uit te zetten. |
| **Zoeken** | Ctrl+K: één zoekveld over klanten, facturen, bonnen, bank en klussen, met bedragen (`>400`) en periodes (`2026-09`). Garantie per aankoop ("nog 14 maanden garantie"). |
| **Koppelingen** | WooCommerce, Shopify, Mollie Facturen (orders/facturen → facturen), Mollie, Stripe (uitbetalingen + kosten). |
| **Overstappen** | Had je al een administratie (ander programma, Excel, boekhouder)? Kies een instapdatum (1 januari aangeraden, vrij te kiezen) en de overstap-hulp vraagt in gewone taal wat er toen al was: saldo per rekening (uit het eindsaldo van je CAMT/MT940-afschrift berekend), facturen die klanten nog moesten betalen, rekeningen die jij nog moest betalen, bus en gereedschap (verder afschrijven vanaf de boekwaarde), btw, leningen, en bij instappen midden in het jaar de omzet en kosten tot dan (en midden in een btw-periode het stuk van die periode). Alles wordt een startbalans tegen eigen vermogen, dat de app zelf uitrekent. Betalingen kort na de overstap die bij een oude factuur of de vorige btw-aangifte lijken te horen, stelt de app voor. Controles: sluit het saldo van de bank aan, ontbreken er afschriften, klopt het eigen vermogen met de balans van je boekhouder. In de auditfile staat de startbalans als `openingBalance`. Heb je een auditfile (XAF 3.x) uit je vorige programma (Exact, e-Boekhouden, Moneybird, SnelStart, Jortt, …), dan vult de app de startbalans daaruit in: saldi per rekening, openstaande facturen per klant en leverancier, bus en gereedschap, btw, omzet en kosten tot de instapdatum, klanten en leveranciers. Rekeningen worden herkend op RGS-code of naam, en het eigen vermogen wordt vergeleken met dat van de vorige administratie. Zonder auditfile werkt ook een kolommenbalans of saldibalans (Excel of CSV, bv. uit DigiBoox), en een lijst met openstaande facturen die het totaal vervangt door losse facturen. De app herkent zelf wat voor bestand het is en welke kolom wat is; alleen als dat niet lukt, stelt hij een korte vraag (en onthoudt het antwoord). Er is een voorbeeldbestand om in te vullen. Openstaande facturen van klanten kunnen ook als e-factuur (UBL) worden ingelezen. |
| **Uitwisseling met je boekhouder** | Werkt je boekhouder ook met BoekhoudenVoorNiks, dan stuur je hem een periode (versleuteld, per mail of als bestand, niet via ons), hij corrigeert in zijn eigen kopie en jij leest zijn antwoord in; de periode is daarna afgesloten. Voor de boekhouder gratis; voor jou een extra functie van het abonnement (koppelen en een antwoord inlezen kan altijd). Zie [docs/uitwisseling.md](docs/uitwisseling.md). |
| **Twijfelgevallen** | Weet je niet waar een bon of betaling bij hoort, kies dan *weet ik nog niet: vraag mijn boekhouder*: hij staat apart op vraagposten zonder btw-aftrek, komt terug vóór de btw-aangifte en in het pakket voor de boekhouder, en je deelt hem later in. |
| **Voor de boekhouder** | **Pakket voor je boekhouder**: één ZIP per boekjaar met auditfile (XAF 3.2), kolommenbalans, grootboekkaarten, journaalposten, openstaande posten per factuur, RGS-brugstaat, btw-overzicht, relaties, facturen en bonnen met index, en een lees-mij met aansluiting en importroutes (Caseware, AFAS, Visionplanner, Twinfield, Exact Online, Yuki, SnelStart). Zie [site/boekhouders.html](site/boekhouders.html) en [docs/boekhouders.md](docs/boekhouders.md). Verder: grootboek (RGS), journaal, W&V, balans, correctieboekingen, losse exports en de regels die per leverancier geleerd zijn. |

## Ontwerpregels

1. **Wat is er gebeurd?** in plaats van *wat wilt u boeken?* Boekhoudtermen staan alleen in de expertmodus.
2. **De software doet het werk en vraagt alleen om uitzonderingen** (HIGH → automatisch, MEDIUM → één vraag, LOW → controle). Een leverancier wordt pas automatisch verwerkt als jij daar ja op zegt, en alles wat de app zelf deed staat onder "Automatisch gedaan". Zekerheid wordt per veld en per beslissing bepaald; automatisch alleen als álles boven de drempel zit. Instelbaar: voorzichtig / normaal / maximaal. Elke automatische verwerking heeft een "Waarom?" (vaste sjablonen, geen AI) en een knop "Klopt niet" die het terugdraait.
3. **AI verzint nooit de boekhouding.** Extractie (*wat staat er?*), classificatie (*wat is dit?*) en boeking (*hoe boeken we dit?*) zijn strikt gescheiden. Een lokale LLM, of met een abonnement de optionele online hulp (via onze server bij Cloudflare, standaard uit, alleen leveranciersnaam en artikelomschrijvingen; zie [docs/jev-assistent.md](docs/jev-assistent.md)), mag alleen een categorie voorstellen en alleen als het leveranciersgeheugen en de vaste regels het niet weten; boekingen worden altijd met vaste, testbare regels in code gemaakt.
4. **Journaalposten zijn onveranderlijk** (afgedwongen met database-triggers); corrigeren gaat via een tegenboeking. Elke post is in balans. Een ingediende BTW-periode verandert nooit: wat later nog in die periode geboekt wordt, telt mee in de volgende aangifte (boven € 1.000 btw: een suppletie).
5. **Bedragen in centen** (integers), BTW-percentage per regel, BTW per tarief berekend over de som van de regels.
6. **Gebeurtenissen zijn de bron van waarheid.** Wat er gebeurd is (een bankbetaling, een inkoop) wordt met bewijs vastgelegd; de journaalregels worden daar met vaste, geversioneerde regels uit gecompileerd (`src/core-ledger/rules.ts`). Een andere categorie kiezen vervangt de gebeurtenis: tegenboeking van de oude post en een nieuwe post, nooit een stille wijziging. In de expertmodus toont elke post zijn herkomst.

## Architectuur

```
src/
  core-ledger/   dubbele boekhouding: journaalposten, saldi, RGS-rekeningschema, gebeurtenissen + boekingsregels   ← het risicovolle deel, eigen tests
  documents/     offertes, facturen, inkoop, templates, PDF/e-mail, herinneringen
  import/        CSV/MT940/CAMT.053 → genormaliseerde transacties, matching-engine
  ocr-runtime/   ingebouwde OCR: download (sha256, hervatten), llama-server starten/stoppen
  intake/        documentinbox: UBL, PDF-tekst, OCR-interface, validatie, classificatie, confidence, leveranciersgeheugen
  btw/           BTW-berekening uit journal_lines → rubrieken, periode-afsluiting, XBRL (voorbereiding)
  jobs/          klussen (offerte → klus → factuur)
  scanner/       bonnenmap (bestanden uit een map naar de inbox); ontvanger voor de bonnenscanner op Android (koppelen, ontvangstpunt, mDNS), uit tot die app er is: shared/phone-scanner.ts, docs/bonnenscanner-protocol.md
  inbox/         "Ben ik bij?": taken, automatisch verwerken, geld-overzicht
  onboarding/    "Aan de slag"-lijstje en de overstap-hulp (instapdatum, startbalans, controles)
  dashboard/     read-only overzichten
  integrations/  WooCommerce, Shopify, Mollie Facturen, Mollie, Stripe, open-banking-interface (los; zonder configuratie inactief)
  export/        auditfile (XAF), journaal/saldibalans CSV, pakket voor de boekhouder (ZIP)
  main/          Electron-hoofdproces: IPC-whitelist, PDF (Chromium printToPDF), safeStorage, back-ups, updater
  renderer/      React-UI
```

Online onderdelen (Cloudflare Workers): `workers/site` (de website) staat hier; de licentie-Worker
(abonnement en licentie) en de assistent-Worker (online hulp bij categorievoorstellen, #132) staan sinds
30 september 2026 in de privé-repo `shipdocs/boekhoudenvoorniks-server`. Het contract met de app: de licentie (`src/license/license.ts`)
en de routes in `src/main/main.ts` (`licenseApi`) en `src/intake/llm-jev.ts`.

De renderer heeft geen Node-toegang (`contextIsolation`, `sandbox`). Alle aanroepen gaan via één
IPC-kanaal naar een whitelist in `src/main/api.ts`. Geheimen (SMTP-wachtwoord, API-sleutels)
worden versleuteld met het sleutelbeheer van het besturingssysteem.

## Naam en technische namen

De app heette tot en met 0.6.15 *Gratis Boekhouden*. Wat gebruikers zien heet nu BoekhoudenVoorNiks
(programma `boekhoudenvoorniks`, gegevensmap `boekhoudenvoorniks`, MCP-koppeling `boekhoudenvoorniks`,
omgevingsvariabelen `BOEKHOUDENVOORNIKS_DATA` en `BOEKHOUDENVOORNIKS_SMOKE_TEST`). Twee namen blijven
bewust de oude, omdat bestaande installaties eraan hangen:

- `name` in `package.json` (`gratis-boekhouden`): daaraan hangt op Linux de sleutelhanger waarmee
  wachtwoorden en API-sleutels versleuteld zijn, en de naam van het .deb-pakket.
- `appId` (`app.shipdocs.gratisboekhouden`): daarmee gaat een update op Windows over de bestaande
  installatie heen in plaats van ernaast.

De oude gegevensmap wordt bij de eerste start overgezet (`src/main/data-dir.ts`), een MCP-koppeling
onder de oude naam wordt omgezet (`src/mcp/names.ts`), en de oude omgevingsvariabelen
(`GRATIS_BOEKHOUDEN_*`) blijven werken.

## Ontwikkelen

Vereist Node 22.12+.

```bash
npm install
npm test            # unit- en integratietests (vitest) op een in-memory database
npm run test:proefadministratie # vaste XAF/UBL/CAMT-administratie met exact verwachte saldi
npm run typecheck
npm run dev         # Vite + Electron met hot reload
npm start           # productiebuild lokaal starten
npm run dist:linux  # AppImage + .deb
npm run dist:win    # Windows-installer (NSIS)
```

`better-sqlite3` is een native module. `npm test` bouwt hem voor Node en `npm run dev`/`npm start` voor
Electron (`electron-builder install-app-deps`).

Zie [Testen](docs/testen.md) voor de testlagen, gerichte commando's en de werkwijze bij een afwijkend
saldo. De bronbestanden en onafhankelijke handberekening van de vaste proefadministratie staan in
[tests/proefadministratie](tests/proefadministratie/README.md).

Een PDF met tekst leest de app zelf (`src/intake/pdf-text.ts` en `text-parser.ts`); welke leverancier
het is, zoekt hij op in een handmatige lijst (`src/intake/suppliers.ts`) en een lijst van zo'n 3300
winkelketens uit OpenStreetMap (`src/intake/brand-index.ts`), en daarna in wat de gebruiker eerder
bevestigde. Tekstherkenning voor foto's is optioneel. De ingebouwde herkenning (GLM-OCR via llama.cpp, lokaal, CPU)
installeer je bij eerste gebruik in de instellingen; zie [`docs/lokale-ocr.md`](docs/lokale-ocr.md).
Een eigen OCR-dienst kan ook, zie [`docs/ocr-sidecar.md`](docs/ocr-sidecar.md). De benchmark met een
synthetische set staat in [`docs/ocr-benchmark.md`](docs/ocr-benchmark.md).

## Installeren

Download het programma op [boekhoudenvoorniks.nl/downloaden.html](https://boekhoudenvoorniks.nl/downloaden.html): `Setup.exe` voor Windows, AppImage of `.deb` voor Linux. De bestanden staan ook bij de [laatste release](https://github.com/shipdocs/boekhoudenvoorniks/releases/latest) op GitHub.

Op **Windows** kan SmartScreen melden dat "Windows uw pc heeft beveiligd". Dat komt doordat de installer (nog) niet met een betaald certificaat ondertekend is. Download de installer alleen van de [GitHub-release](https://github.com/shipdocs/boekhoudenvoorniks/releases) en controleer eventueel het controlegetal:

```powershell
Get-FileHash '.\BoekhoudenVoorNiks-Setup-0.7.3.exe' -Algorithm SHA256   # vergelijk met SHA256SUMS-Windows.txt
```

Klopt het, klik dan op **Meer informatie → Toch uitvoeren**. Op Linux: `sha256sum -c SHA256SUMS-Linux.txt --ignore-missing`.

## Releases en updates

Een tag `v*`, of het handmatig starten van de workflow *Release* op main (Actions → Release → Run
workflow), bouwt via GitHub Actions de installers voor Linux en Windows en publiceert ze als
GitHub-release. De versie komt uit `package.json`; de tekst bij de release komt uit het CHANGELOG-deel van die versie. De geïnstalleerde app werkt zichzelf bij via `electron-updater`.

## Status en open punten

De fases MVP, V2 en V3 uit het technisch plan zijn gebouwd en uitgebracht als v0.1.0. De slimme
automatisering volgde in v0.2.0, aftrekposten, de demo en teksten in gewone taal in v0.3.0, het pakket
voor de boekhouder in 0.6.15, en de uitwisseling met de boekhouder met het abonnement in 0.7 (zie
[CHANGELOG.md](CHANGELOG.md)). De licentieserver (Mollie) staat sinds 30 september 2026 live. De online
hulp bij categorievoorstellen is sinds 0.7.4 beschikbaar voor abonnees, standaard uit
([docs/jev-assistent.md](docs/jev-assistent.md); evaluatie in issue #168). Versie 1.0.0 (oktober 2026) bracht de
gedeelde gegevensmap met een eigen mapkeuze, het blokkeren van dubbele bonnen en het inlezen van
bankafschriften zonder dubbele betalingen. Openstaand werk staat als issue in GitHub,
met labels voor prioriteit en omvang; milestones gebruiken we niet.

Het rekeningschema gebruikt de officiële RGS-referentiecodes (taxonomie-release 20251210, `src/core-ledger/rgs-codes.json`).
Een test controleert elke standaardrekening tegen die lijst.

## Gegevens van derden

`src/intake/brand-index.json` komt uit de [Name Suggestion Index](https://github.com/osmlab/name-suggestion-index)
van OpenStreetMap (BSD-3-Clause, © name-suggestion-index contributors; de licentietekst staat in het bestand).
Opnieuw maken met `npm run leveranciers:nsi`.

## Licentie

BoekhoudenVoorNiks is vrije software onder de [GNU Affero General Public License v3.0 of later](LICENSE) (AGPL-3.0-or-later). Bijdragen: zie [CONTRIBUTING.md](CONTRIBUTING.md), ook voor de rechten op je bijdrage. Zie ook de [gebruiksvoorwaarden](https://boekhoudenvoorniks.nl/voorwaarden.html) en de [privacyverklaring](https://boekhoudenvoorniks.nl/privacy.html).
