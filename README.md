# Gratis Boekhouden

Gratis, **local-first** boekhoudprogramma voor zzp'ers en kleine ondernemers in de bouw en techniek:
stukadoor, schilder, timmerman, loodgieter, elektricien, klusbedrijf.

> **De gebruiker beheert zijn bedrijf. De software maakt daarvan automatisch de boekhouding.**

De gebruiker denkt in *klant, klus, offerte, bonnetje, factuur, betaling, belasting*, niet in
grootboek, journaalposten of BTW-codes. Onder water draait wel een volledige dubbele boekhouding
op basis van RGS, zodat een boekhouder of accountant de administratie zo kan overnemen.

Desktop-app (Electron) voor Windows en Linux. De administratie staat in een SQLite-bestand op de
eigen computer, zonder account, cloud of abonnement.

## Wat zit erin

| | |
|---|---|
| **Vandaag** | Hoeveel geld heb ik, hoeveel is vrij te besteden, hoeveel krijg ik nog, hoeveel moet ik apart houden voor BTW (met een optioneel belastingpotje), en *moet ik iets doen?* De administratie werkt als een inbox die leeg kan ("Je bent bij ✓"). |
| **Werk & facturen** | Offertes → klant akkoord → klus → *werk klaar* → factuur in één klik. PDF + e-factuur (UBL, Peppol BIS 3.0) per e-mail (eigen SMTP). Doorlopende nummering, creditfacturen, betaalstatus, automatische herinneringen. |
| **Opmaak** | Logo, kleuren, lettertype en vaste tekstblokken met live voorbeeld; eigen HTML-template in expertmodus. |
| **Aankopen & bonnetjes** | Betalen met een betaal-QR (EPC) voor je bank-app, met een waarschuwing als het rekeningnummer anders is dan vorige keer. Foto, PDF of e-factuur (UBL) erin. Eerst UBL, dan de PDF-tekstlaag, dan lokale OCR. Daarna validatie, classificatie, een confidence-inschatting en de koppeling met de bank. Regels op de bon worden herkend; een gemengde bon (materiaal + werkbroek + iets privé) wordt op verzoek per soort geboekt. |
| **Bank** | CSV (ING, Rabobank, ABN AMRO, bunq, Knab, Triodos + zelf kolommen aanwijzen), MT940 en CAMT.053. Automatische koppeling aan facturen en bonnetjes; de app leert per leverancier. Vaste lasten en abonnementen worden herkend (ontbrekende factuur of afschrijving wordt gemeld). |
| **Belasting** | BTW per kwartaal in mensentaal ("Te betalen € 3.365, uiterlijk 31 oktober"). Daaronder de officiële rubrieken (1a/1b/1e/2a/5a/5b/5g) om over te nemen in Mijn Belastingdienst Zakelijk. Vóór de aangifte controleert de app wat de aangifte fout kan maken (onverwerkte bank, uitgaven zonder bewijs, dubbele aankopen, verlegd zonder btw-nummer, negatieve kas, vraagposten). Periode-afsluiting, CSV-export en een XBRL-voorbereiding. |
| **Koppelingen** | WooCommerce, Shopify (orders → facturen), Mollie, Stripe (uitbetalingen + kosten). |
| **Voor de boekhouder** | Grootboek (RGS), journaal, W&V, balans, correctieboekingen, auditfile (XAF 3.2), CSV-exports en de regels die per leverancier geleerd zijn. |

## Ontwerpregels

1. **Wat is er gebeurd?** in plaats van *wat wilt u boeken?* Boekhoudtermen staan alleen in de expertmodus.
2. **De software doet het werk en vraagt alleen om uitzonderingen** (HIGH → automatisch, MEDIUM → één vraag, LOW → controle). Een leverancier wordt pas automatisch verwerkt als jij daar ja op zegt, en alles wat de app zelf deed staat onder "Automatisch gedaan". Zekerheid wordt per veld en per beslissing bepaald; automatisch alleen als álles boven de drempel zit. Instelbaar: voorzichtig / normaal / maximaal. Elke automatische verwerking heeft een "Waarom?" (vaste sjablonen, geen AI) en een knop "Klopt niet" die het terugdraait.
3. **AI verzint nooit de boekhouding.** Extractie (*wat staat er?*), classificatie (*wat is dit?*) en boeking (*hoe boeken we dit?*) zijn strikt gescheiden. Een lokale LLM mag alleen een categorie voorstellen; boekingen worden altijd met vaste, testbare regels in code gemaakt.
4. **Journaalposten zijn onveranderlijk** (afgedwongen met database-triggers); corrigeren gaat via een tegenboeking. Elke post is in balans. Een ingediende BTW-periode verandert nooit: wat later nog in die periode geboekt wordt, telt mee in de volgende aangifte (boven € 1.000 btw: een suppletie).
5. **Bedragen in centen** (integers), BTW-percentage per regel, BTW per tarief berekend over de som van de regels.
6. **Gebeurtenissen zijn de bron van waarheid.** Wat er gebeurd is (een bankbetaling, een inkoop) wordt met bewijs vastgelegd; de journaalregels worden daar met vaste, geversioneerde regels uit gecompileerd (`src/core-ledger/rules.ts`). Een andere categorie kiezen vervangt de gebeurtenis: tegenboeking van de oude post en een nieuwe post, nooit een stille wijziging. In de expertmodus toont elke post zijn herkomst.

## Architectuur

```
src/
  core-ledger/   dubbele boekhouding: journaalposten, saldi, RGS-rekeningschema, gebeurtenissen + boekingsregels   ← het risicovolle deel, eigen tests
  documents/     offertes, facturen, inkoop, templates, PDF/e-mail, herinneringen
  import/        CSV/MT940/CAMT.053 → genormaliseerde transacties, matching-engine
  intake/        documentinbox: UBL, PDF-tekst, OCR-interface, validatie, classificatie, confidence, leveranciersgeheugen
  btw/           BTW-berekening uit journal_lines → rubrieken, periode-afsluiting, XBRL (voorbereiding)
  jobs/          klussen (offerte → klus → factuur)
  inbox/         "Ben ik bij?": taken, automatisch verwerken, geld-overzicht
  dashboard/     read-only overzichten
  integrations/  WooCommerce, Shopify, Mollie, Stripe, open-banking-interface (los; zonder configuratie inactief)
  export/        auditfile (XAF), journaal/saldibalans CSV
  main/          Electron-hoofdproces: IPC-whitelist, PDF (Chromium printToPDF), safeStorage, back-ups, updater
  renderer/      React-UI
```

De renderer heeft geen Node-toegang (`contextIsolation`, `sandbox`). Alle aanroepen gaan via één
IPC-kanaal naar een whitelist in `src/main/api.ts`. Geheimen (SMTP-wachtwoord, API-sleutels)
worden versleuteld met het sleutelbeheer van het besturingssysteem.

## Ontwikkelen

Vereist Node 22.12+.

```bash
npm install
npm test            # unit- en integratietests (vitest) op een in-memory database
npm run typecheck
npm run dev         # Vite + Electron met hot reload
npm start           # productiebuild lokaal starten
npm run dist:linux  # AppImage + .deb
npm run dist:win    # Windows-installer (NSIS)
```

`better-sqlite3` is een native module. `npm test` bouwt hem voor Node en `npm run dev`/`npm start` voor
Electron (`electron-builder install-app-deps`).

Lokale OCR en AI zijn optioneel; zie [`docs/ocr-sidecar.md`](docs/ocr-sidecar.md). De benchmark draai je met
`npm run benchmark:ocr -- <map> <ocr-url> <engine>`.

## Installeren

Download de installer van de [laatste release](https://github.com/shipdocs/gratis-boekhouden/releases/latest): AppImage of `.deb` voor Linux, `Setup.exe` voor Windows.

Op **Windows** kan SmartScreen melden dat "Windows uw pc heeft beveiligd". Dat komt doordat de installer (nog) niet met een betaald certificaat ondertekend is. Download de installer alleen van de [GitHub-release](https://github.com/shipdocs/gratis-boekhouden/releases) en controleer eventueel het controlegetal:

```powershell
Get-FileHash '.\Gratis Boekhouden Setup 0.1.0.exe' -Algorithm SHA256   # vergelijk met SHA256SUMS-Windows.txt
```

Klopt het, klik dan op **Meer informatie → Toch uitvoeren**. Op Linux: `sha256sum -c SHA256SUMS-Linux.txt --ignore-missing`.

## Releases en updates

Een tag `v*` bouwt via GitHub Actions de installers voor Linux en Windows en publiceert ze als
GitHub-release. De geïnstalleerde app werkt zichzelf bij via `electron-updater`.

## Status en open punten

De fases MVP, V2 en V3 uit het technisch plan zijn gebouwd en uitgebracht als v0.1.0. Openstaand werk
staat als issue in GitHub, per milestone en met prioriteit.

Het rekeningschema gebruikt de officiële RGS-referentiecodes (taxonomie-release 20251210, `src/core-ledger/rgs-codes.json`).
Een test controleert elke standaardrekening tegen die lijst.

## Licentie

Gratis Boekhouden is vrije software onder de [GNU Affero General Public License v3.0 of later](LICENSE) (AGPL-3.0-or-later). Zie ook de [gebruiksvoorwaarden](https://shipdocs.github.io/gratis-boekhouden/voorwaarden.html) en de [privacyverklaring](https://shipdocs.github.io/gratis-boekhouden/privacy.html).
