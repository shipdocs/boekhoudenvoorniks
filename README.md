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
| **Vandaag** | Hoeveel geld heb ik, hoeveel krijg ik nog, hoeveel moet ik apart houden voor BTW, en *moet ik iets doen?* De administratie werkt als een inbox die leeg kan ("Je bent bij ✓"). |
| **Werk & facturen** | Offertes → klant akkoord → klus → *werk klaar* → factuur in één klik. PDF + e-mail (eigen SMTP). Doorlopende nummering, creditfacturen, betaalstatus, automatische herinneringen. |
| **Opmaak** | Logo, kleuren, lettertype en vaste tekstblokken met live voorbeeld; eigen HTML-template in expertmodus. |
| **Aankopen & bonnetjes** | Foto, PDF of e-factuur (UBL) erin. Eerst UBL, dan de PDF-tekstlaag, dan lokale OCR. Daarna validatie, classificatie, een confidence-inschatting en de koppeling met de bank. |
| **Bank** | CSV (ING, Rabobank, ABN AMRO, bunq, Knab, Triodos + zelf kolommen aanwijzen), MT940 en CAMT.053. Automatische koppeling aan facturen en bonnetjes; de app leert per leverancier. |
| **Belasting** | BTW per kwartaal in mensentaal ("Te betalen € 3.365, uiterlijk 31 oktober"). Daaronder de officiële rubrieken (1a/1b/1e/2a/5a/5b/5g) om over te nemen in Mijn Belastingdienst Zakelijk. Periode-afsluiting, CSV-export en een XBRL-voorbereiding. |
| **Koppelingen** | WooCommerce, Shopify (orders → facturen), Mollie, Stripe (uitbetalingen + kosten). |
| **Voor de boekhouder** | Grootboek (RGS), journaal, W&V, balans, correctieboekingen, auditfile (XAF 3.2), CSV-exports en de regels die per leverancier geleerd zijn. |

## Ontwerpregels

1. **Wat is er gebeurd?** in plaats van *wat wilt u boeken?* Boekhoudtermen staan alleen in de expertmodus.
2. **De software doet het werk en vraagt alleen om uitzonderingen** (HIGH → automatisch, MEDIUM → één vraag, LOW → controle).
3. **AI verzint nooit de boekhouding.** Extractie (*wat staat er?*), classificatie (*wat is dit?*) en boeking (*hoe boeken we dit?*) zijn strikt gescheiden. Een lokale LLM mag alleen een categorie voorstellen; boekingen worden altijd met vaste, testbare regels in code gemaakt.
4. **Journaalposten zijn onveranderlijk** (afgedwongen met database-triggers); corrigeren gaat via een tegenboeking. Elke post is in balans, en een ingediende BTW-periode is dicht.
5. **Bedragen in centen** (integers), BTW-percentage per regel, BTW per tarief berekend over de som van de regels.

## Architectuur

```
src/
  core-ledger/   dubbele boekhouding: journaalposten, saldi, RGS-rekeningschema   ← het risicovolle deel, eigen tests
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

## Releases en updates

Een tag `v*` bouwt via GitHub Actions de installers voor Linux en Windows en publiceert ze als
GitHub-release. De geïnstalleerde app werkt zichzelf bij via `electron-updater`.

## Status en open punten

De fases MVP, V2 en V3 uit het technisch plan zijn gebouwd. Wat nog een beslissing of externe actie
nodig heeft, staat als issue in GitHub (milestones *MVP livegang*, *V2*, *V3*). De belangrijkste:

- **BTW-logica laten reviewen door een boekhouder of fiscalist** vóór livegang (zie `src/btw`, `src/shared/vat.ts`, `src/shared/trades.ts`).
- RGS-codes controleren tegen de officiële RGS-release.
- Directe BTW-aangifte via SBR/Digipoort (PKIoverheid-certificaat, ODB-aanmelding).
- Keuze van de OCR-engine op basis van een benchmark met ~200 echte documenten.
- Open-banking-partner kiezen (PSD2 AIS).
