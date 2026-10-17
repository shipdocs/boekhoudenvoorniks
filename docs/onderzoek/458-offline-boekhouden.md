# Onderzoek #458: offline boekhouden zonder abonnement

*Stand: repo `main` @ 8990de6 (versie 1.8.0), 17-10-2026. G1–G9 en G11 zijn verwerkt in dezelfde PR; G10 (privacyverklaring, met versiedatum) staat nog open.*

## 1. Samenvatting

- **Het kernbeeld klopt.** Het dagelijkse werk draait volledig lokaal: offertes en facturen (pdf via Chromium `printToPDF`, UBL), bankafschriften inlezen (CAMT.053, MT940, CSV, XLSX), bonnen nakijken, btw-overzicht, rapporten, jaarafsluiting, het pakket voor de boekhouder (XAF 3.2 en CSV), back-up en herstel. De gegevens staan in een SQLite-bestand in `~/BoekhoudenVoorNiks/`. Er is geen account, geen telemetrie en geen verplichte cloud. De renderer mag via de CSP niets buiten de app laden (`connect-src 'self'`).
- **Elke netwerkfunctie is optioneel of valt netjes terug.** Daar is één uitzondering op: de app werkt zichzelf standaard bij (GitHub, elke 4 uur) en haalt ECB-wisselkoersen **automatisch** op zodra er een bon in een vreemde munt binnenkomt. Allebei vallen ze netjes terug (een foutstatus of de vraag om het eurobedrag zelf in te vullen), maar het zijn geen "koppelingen die je zelf aanzet".
- **Een abonnement is er wél.** Het kost € 9 per maand, de eerste 4 maanden zijn gratis, en het geldt voor de Android-koppeling, versturen naar de boekhouder en de online categoriehulp. De licentie wordt offline gecontroleerd met Ed25519 en een "laatst geziene datum". Alleen het ophalen of verversen van de licentie gaat online. De pagina `zonder-abonnement.html` legt dit eerlijk uit.
- **Aantoonbare hiaten in de teksten** (details in §6):
  1. `index.html` zegt twee keer: "alleen voor het versturen van e-mail en updates is internet nodig". Dezelfde pagina promoot het bonnen-adres en Ponto, die allebei internet nodig hebben.
  2. `zonder-abonnement.html` zegt: "Wij ontvangen er niets van" en "wij ontvangen geen gegevens uit je administratie". Dat botst met het bonnen-adres (mail staat tot 60 dagen op onze server) en de online hulp. `privacy.html` en `index.html` zijn daar wel precies over.
  3. `offline-boekhoudprogramma.html` meldt niet dat foto-OCR eerst een eenmalige download van ongeveer 1,5 GB vraagt. Ook ontbreken op die pagina een duidelijk overzicht van wat wel en niet offline werkt, waar je gegevens staan en in welke formaten je ze meeneemt. Dat zijn juist de eigenschappen waar de zoekers naar vragen.
  4. Kleinere punten: de downloadroute vanaf de offline-pagina loopt via een tussenpagina, `downloaden.html` onderschat het automatisch bijwerken, `gratis-boekhoudprogramma-downloaden.html` noemt de abonnementsfuncties niet goed, en de verbindingenlijst in `privacy.html` mist de ECB en de download van het OCR-model.
- **Getest:** 25 relevante vitest-bestanden (349 tests) slagen in een netwerkloze namespace (`unshare -rn`, alleen loopback). Niet getest: een echte installatie en echte Electron-start zonder netwerk (zie §5).

## 2. Wat bedoelen zoekers met "offline / zonder abonnement / standalone"?

Dit is een interpretatie op basis van de zoektermen, niet van gebruikersonderzoek. Per eigenschap staat erbij hoe de app het nu doet.

| Eigenschap waarnaar gezocht wordt | Stand in de app | Staat het op de landingspagina's? |
|---|---|---|
| Volledige functionaliteit zonder internet | Ja voor het kernwerk. Foto-OCR werkt pas na een eenmalige download van ±1,5 GB. Nieuwe wisselkoersen, e-mail, bonnen-adres, Ponto, webshop/PSP en VIES hebben internet nodig. | Grotendeels. De opsommingen van wat internet nodig heeft zijn onvolledig of spreken elkaar tegen (G1, G3, G4). |
| Lokale database | SQLite `boekhouding.sqlite` per administratie onder `~/BoekhoudenVoorNiks/` (buiten AppData, blijft staan na verwijderen), map te verplaatsen | `downloaden.html` r.41 en de FAQ op `index.html`. Ontbreekt op de offline-pagina (G6). |
| Geen terugkerende kosten | Het programma is gratis. Er is een optioneel abonnement van € 9 per maand voor extra functies. | Goed uitgelegd op `zonder-abonnement.html`. Op `gratis-…-downloaden.html` onvolledig (G9). |
| Back-up | Elke dag automatisch een complete back-up (`.gbbackup`, database en bijlagen, laatste 14), op verzoek versleuteld (AES-256-GCM/scrypt). Vóór een update of migratie een kopie. Handmatig maken en terugzetten in Instellingen → *Back-up, demo & updates*. | Ja ("elke dag een back-up"). Waar de back-ups staan en hoe je terugzet staat niet op de offline-pagina (G6). |
| Gegevensportabiliteit | XAF 3.2 (schemagetoetst), CSV-overzichten (kolommenbalans, grootboekkaarten, openstaande posten, RGS-brugstaat), facturen als pdf en UBL, `.gbbackup`, en de open SQLite-database. Instappen met XAF, kolommen- of saldibalans. | Ja op `zonder-abonnement.html` (XAF) en `index.html`. Niet op de offline-pagina. |
| Installatie op Windows/Linux | electron-builder: Windows `nsis` (volledige offline installer, geen `nsis-web`) plus Store-`appx`. Linux `AppImage` en `deb` (x64). Geen Mac. | Ja, duidelijk op `downloaden.html`. |
| "Standalone" (geen server of account) | Geen account. Licentieserver alleen bij een abonnement. MCP alleen via stdio. Telefoonkoppeling via LAN/mDNS (geen internet, wel wifi). | Ja. |

## 3. Netwerkinventaris (uit de code)

Overal wordt de globale `fetch` van Node/Electron gebruikt (`localFetch`, `src/main/main.ts:492`). Er zijn geen axios- of `electron.net`-aanroepen. In de demo en in de kopie bij de boekhouder blokkeert `integrationFetch` (`src/services.ts:94-97`) de koppelingen, VIES en de bankfeed.

| # | Functie | Bestemming | Code | Wanneer | Optioneel? | Zonder internet |
|---|---|---|---|---|---|---|
| 1 | **Auto-update** | GitHub Releases (electron-updater) | `src/main/updates.ts:59-73`, `main.ts:1456` | 20 s na de start en daarna elke 4 uur. **Staat standaard aan** (`settings.ts:264 autoUpdate: true`). Niet in de Store-versie. | Ja, uit te zetten in Instellingen | Status `fout` met de tekst "Geen verbinding met GitHub…" (`update-notes.ts:10`). De app werkt gewoon door. |
| 2 | **ECB-wisselkoersen** | `data-api.ecb.europa.eu` | `src/fx/fx.ts:40` | **Automatisch** bij een bon in een vreemde munt (intake) en in de achtergrondtaak `fxRepair` (`main.ts:1010`). Alleen de munt en een datum gaan mee. | Nee (geen schakelaar), wel alleen als het nodig is | Eerder opgehaalde koersen blijven bewaard (`fx_rates`). Zonder koers: "De koers kon niet opgehaald worden. Vul hieronder het bedrag in euro's in…" (`DocumentReview.tsx:502`). |
| 3 | Ingebouwde OCR: downloaden | huggingface.co (GLM-OCR, 950 MB + 484 MB), api.github.com en github.com (llama.cpp, ±19–30 MB) | `src/ocr-runtime/manifest.ts:29-82`, `runtime.ts:501-540` | Alleen als de gebruiker kiest voor "Slimme herkenning installeren" | Ja | Downloaden lukt niet (de download is hervatbaar en sha256-gecontroleerd). Na installatie draait de OCR **volledig lokaal** (`127.0.0.1`). Pdf's met tekstlaag en UBL worden altijd lokaal gelezen (`intake/pdf-text.ts`, pdfjs). |
| 4 | Eigen OCR- of Ollama-dienst | localhost (instelbaar) | `main.ts:507-509, 525` | Als het is ingesteld | Ja | Lokaal, geen internet nodig |
| 5 | Claude Code / Codex als bonlezer | Anthropic/OpenAI (via de CLI van de gebruiker) | `main.ts:497-502` | Als de gebruiker dit kiest | Ja | Werkt niet. Handmatig invoeren blijft mogelijk. |
| 6 | Online categoriehulp (JEV) | `assistent.boekhoudenvoorniks.nl` | `src/intake/llm-jev.ts:14,124`, `main.ts:516-522` | Opt-in (`onlineCategoryHelp: false`) en actief abonnement | Ja | "Elke storing (offline…) = geen voorstel". Het leveranciersgeheugen en de regels blijven werken. |
| 7 | E-mail versturen | Eigen SMTP (nodemailer), of overdracht aan het eigen mailprogramma (mailto/MAPI) | `documents/smtp-mailer.ts`, `documents/own-mail.ts` | Bij versturen | Ja | Mislukt met een melding. Pdf en UBL bewaren als bestand kan altijd. |
| 8 | Mail ophalen (eigen IMAP) | Eigen IMAP-server (imapflow) | `mail/imap-source.ts`, `main.ts:395-438` | Elke 15 min als het is ingesteld | Ja | De achtergrondronde logt de fout en de volgende ronde probeert opnieuw |
| 9 | **Bonnen-adres** | Licentieserver plus `mx.post.boekhoudenvoorniks.nl` (IMAP) | `mail/bonnen-adres.ts`, `main.ts:361-438, 599` | Na aanvragen, elke 15 min | Ja | Ophalen mislukt, de mail blijft tot 60 dagen op de server. Een administratie met bonnen-adres weghalen kan **niet** offline (`main.ts:443-462`, met een duidelijke foutmelding). |
| 10 | Ponto-bankfeed | `api.myponto.com`, en bij *Nu bijwerken* ook `www.cloudflare.com/cdn-cgi/trace` | `integrations/ponto.ts:15`, `bankfeed/bankfeed.ts:155`, `background-feeds.ts` | Als het is ingesteld, elke 6 uur en handmatig | Ja | Fout wordt gelogd, er gebeurt niets. Afschriften inlezen als bestand blijft altijd mogelijk. |
| 11 | Webshop/PSP-koppelingen | Mollie, Stripe, Shopify, WooCommerce | `src/integrations/*.ts` | Als het is ingesteld, elke 6 uur | Ja | Fout per koppeling, verder niets |
| 12 | VIES-controle | `ec.europa.eu` | `src/btw/vies.ts:47` | Alleen bij een klik | Ja | Uitslag `null` ("niet bereikbaar"). De laatst bewaarde controle blijft staan. |
| 13 | Licentie en abonnement | `licentie.boekhoudenvoorniks.nl` | `main.ts:222, 828-832`, `api.ts:745-768`, `license.ts` | Afsluiten en ophalen; verversen op de achtergrond **alleen als er ooit een licentie was** (`license.ts:needsRefresh`, `main.ts:992`) | Ja | De controle is **offline** (Ed25519 en laatst geziene datum). Een geldige licentie blijft offline werken tot `validUntil`. Een verlopen licentie kun je zonder internet niet verlengen. |
| 14 | Uitwisseling met de boekhouder | Geen eigen server: versleuteld bestand per eigen SMTP, gedeelde map of los bestand | `exchange/*.ts`, `docs/uitwisseling.md:21` | Op verzoek | Ja (abonnement) | Als bestand werkt het offline, met een geldige licentie |
| 15 | Telefoonkoppeling (Android) | **LAN**: HTTP-ontvanger op lokale interfaces plus mDNS | `scanner/receiver.ts:131`, `scanner/mdns.ts` | Als het gekoppeld is | Ja (abonnement voor koppelen) | Geen internet nodig, wel hetzelfde netwerk |
| 16 | MCP (Claude Code/Codex) | stdio, lokaal | `src/mcp/start.ts` | Op verzoek | Ja | n.v.t. |
| 17 | Externe links (handleiding, Belastingdienst, Ponto-dashboard) | Browser via `shell.openExternal` (alleen https) | `main.ts:694, 1053` | Bij een klik | Ja | De browser meldt dat er geen verbinding is |
| — | Telemetrie, analytics, crashrapportage | **geen** (grep op sentry, posthog, analytics en telemetr: niets gevonden). `privacy.html` meldt "geen trackers en geen gebruiksstatistieken". | | | | |

De ontwikkeltools in `src/tools/*` (benchmarks, NSI-script) zitten niet in de app en zijn buiten beschouwing gelaten.

## 4. Opslag, back-up, portabiliteit, installers

- **Database**: `boekhouding.sqlite` per administratie. Root `~/BoekhoudenVoorNiks` (`data-dir.ts:13, 83`). Elke administratie heeft een eigen map met de database, `bijlagen/` en `backups/`. In Instellingen is een andere map te kiezen (verwijzing `.boekhoudenvoorniks.json`). De Store-versie heeft extra regels voor AppData (`windows-store.ts`).
- **Back-up**: `dailyBackup` (`backup.ts:120`) schrijft `boekhouding-JJJJ-MM-DD.gbbackup` (database en alle bijlagen, met sha256 per item) naar `<administratie>/backups/` en bewaart de laatste 14. Hij draait 10 s na de start en daarna elke 6 uur (één per dag). Vóór een versiemigratie komt er een kopie `voor-versie-…sqlite` (`main.ts:548`). Handmatig: *Back-up maken*, *Back-up terugzetten…* (`.gbbackup` of `.sqlite`, met integriteitscontrole, `validateBackup`) en *Versleutelde kopie maken* (`encrypted-backup.ts`, minimaal 10 tekens). Let op: de automatische back-ups staan op **dezelfde schijf**. De site en de app adviseren al een extra kopie.
- **Portabiliteit**: export via het pakket voor de boekhouder (XAF 3.2 en CSV's, `export/accountant-package.ts`), facturen als pdf en UBL (Peppol BIS 3.0), `.gbbackup`, en de open SQLite-database. Import uit XAF, kolommen- of saldibalans en openstaande posten.
- **Installers** (`package.json` → `build`): Windows `nsis` (keuze voor de installatiemap, per gebruiker, volledige installer die offline te installeren is zodra hij gedownload is), Store `appx`, Linux `AppImage` en `deb` (categorie Office). De publicatie loopt via GitHub Releases. Dat is ook de bron van de auto-update.

## 5. Wat is geverifieerd, en wat niet

**Uitgevoerd** (zonder netwerk, in een network namespace met alleen loopback):

```
unshare -rn env -u HTTPS_PROXY -u HTTP_PROXY npx vitest run \
  tests/backup.test.ts tests/encrypted-backup.test.ts tests/updates.test.ts tests/licentie.test.ts \
  tests/licentie-datum.test.ts tests/vreemde-valuta.test.ts tests/vreemde-valuta-bestaand.test.ts tests/vies.test.ts \
  tests/bank-feed-taken.test.ts tests/ocr-lokaal.test.ts tests/fetch-text.test.ts tests/data-dir.test.ts \
  tests/xaf-schema.test.ts tests/boekhouder-pakket.test.ts tests/documents.test.ts tests/import.test.ts \
  tests/integrations.test.ts tests/uitwisseling.test.ts tests/jev.test.ts tests/mail-intake.test.ts \
  tests/bonnen-adres.test.ts tests/onboarding-demo.test.ts tests/rapporten.test.ts tests/btw.test.ts tests/overstappen.test.ts
→ Test Files 25 passed (25), Tests 349 passed (349)
```

Eerder draaiden ook `site-download.test.ts`, `abonnement-tekst.test.ts` en `kantoormodus.test.ts` groen (16 bestanden, 180 tests, met netwerk).

Wat dit aantoont: factureren (pdf en UBL), bankimport, btw, rapporten, XAF-export (schemagetoetst), overstappen, onboarding en demo, de back-up- en herstelpakketten, versleutelde back-up, de offline licentiecontrole en de afhandeling van vreemde valuta hebben geen netwerk nodig. De netwerkdiensten (fx, VIES, JEV, koppelingen, bonnen-adres) worden in de tests met een nep-`fetch` aangestuurd. De terugvalpaden (koers `null`, geen voorstel, foutstatus) zitten dus in de tests, maar niet tegen een echt gat in het netwerk.

**Niet geverifieerd:**
- Een echte installatie (NSIS, AppImage, deb) en de eerste start zonder netwerk. Er is geen build gemaakt, want electron-builder downloadt Electron-binaries.
- De e2e-suite (Playwright/Electron) is bewust niet gedraaid. Er is ook geen e2e-test die het netwerk uitzet.
- Of de UI bij een update- of mailfout zonder internet hinderlijk is (bijvoorbeeld een banner). In de code staat de updatefout alleen in Instellingen (`Settings.tsx`).
- Een complete OCR-download en het daarna offline lezen.
- Advies voor de handmatige test uit het issue: zet de netwerkadapter uit en doorloop installeren → onboarding → factuur → afschrift inlezen → back-up maken → back-up terugzetten → afsluiten en opnieuw starten. Controleer daarbij dat er na 20 s (update) en 30 s (mail) geen storende melding komt.

## 6. Hiatenlijst met concrete voorstellen

Alles hieronder is tekst of UX. Er is niets gevonden dat een functiewijziging nodig maakt. G1 en G2 zijn de belangrijkste: daar spreken claims de code of de eigen privacyverklaring aantoonbaar tegen.

### G1. `index.html` r.300 (JSON-LD) en r.674 (zichtbare FAQ): onvolledige internetclaim
De huidige tekst (beide regels):
> Op Windows en Linux. Het programma werkt ook zonder internetverbinding; alleen voor het versturen van e-mail en updates is internet nodig.

Waarom dit een gat is: dezelfde pagina promoot het bonnen-adres (r.396, 421, 468, 664) en Ponto. Allebei hebben ze internet nodig, net als de ECB-koersen (automatisch, `fx.ts:40`).
Voorstel (op beide plaatsen; in JSON-LD zonder HTML):
> Op Windows en Linux. Het dagelijkse werk (facturen, bankafschriften inlezen, bonnen nakijken, btw-overzicht) werkt zonder internet. Internet is alleen nodig voor updates, voor het versturen en ophalen van e-mail (ook het bonnen-adres), voor koppelingen die je zelf aanzet zoals Ponto of je webshop, en voor een nieuwe wisselkoers bij een buitenlandse bon.

### G2. `zonder-abonnement.html` r.75 (JSON-LD), r.144 (FAQ) en r.126: "Wij ontvangen er niets van"
De huidige tekst, r.75 en r.144:
> Je administratie staat alleen op je eigen computer. Wij ontvangen er niets van. Het programma maakt elke dag een back-up; bewaar daarnaast af en toe een kopie op een andere plek.

Waarom dit een gat is: met het bonnen-adres staat de mail tot 60 dagen op onze mailserver (`privacy.html`, `index.html:684`). Met de online hulp gaan de winkelnaam en artikelomschrijvingen naar onze server (`llm-jev.ts`, `privacy.html:49`).
Voorstel, r.144 (r.75 hetzelfde zonder de link):
> Je administratie staat op je eigen computer, niet bij ons. Wij ontvangen er niets van, tenzij je zelf het gratis bonnen-adres gebruikt (die mail staat hooguit 60 dagen op onze mailserver, tot de app hem ophaalt) of met een abonnement de online hulp bij categorievoorstellen aanzet. Zie de <a href="privacy.html">privacyverklaring</a>. Het programma maakt elke dag een back-up; bewaar daarnaast af en toe een kopie op een andere plek.

De huidige tekst, r.126 (fragment):
> Geen cloud: wij ontvangen geen gegevens uit je administratie.

Voorstel:
> Geen cloud: je administratie staat niet bij ons. Alleen wat je zelf aanzet, zoals het bonnen-adres, loopt via onze server (<a href="privacy.html">privacy</a>).

### G3. `zonder-abonnement.html` r.59, r.125 en r.142: lijst van wat internet nodig heeft
De huidige tekst, r.59 en r.142:
> Ja. BoekhoudenVoorNiks draait op je eigen computer en werkt offline. Internet is alleen nodig voor updates, voor het versturen van e-mail en voor koppelingen die je zelf aanzet.

Het ophalen van mail en het bonnen-adres vallen er nog wel onder ("zelf aanzetten"), maar de ECB-koers gaat automatisch. Voorstel:
> Ja. BoekhoudenVoorNiks draait op je eigen computer en werkt offline. Internet is alleen nodig voor updates, voor het versturen en ophalen van e-mail, voor koppelingen die je zelf aanzet en voor een nieuwe wisselkoers bij een buitenlandse bon.

De huidige tekst, r.125 (fragment):
> Alleen voor updates, e-mail en koppelingen die je zelf aanzet, is internet nodig.

Voorstel:
> Alleen voor updates, e-mail, koppelingen die je zelf aanzet en een nieuwe wisselkoers is internet nodig.

### G4. `offline-boekhoudprogramma.html` r.98: bonnetjes offline zonder voorbehoud
De huidige tekst:
> Facturen, bonnetjes, bankimport, btw-overzicht en rapportages blijven beschikbaar.

Waarom dit een gat is: foto's lezen gaat via de ingebouwde OCR. Die vraagt een eenmalige download (`manifest.ts`: 950 MB + 484 MB + llama.cpp ≈ 1,5 GB) en werkt daarna lokaal. E-facturen en pdf's met tekst worden altijd lokaal gelezen.
Voorstel:
> Facturen, bankimport, btw-overzicht en rapportages blijven beschikbaar. Bonnetjes ook: e-facturen en pdf's met tekst leest de app zelf; voor het lezen van foto's download je eenmalig de tekstherkenning (ongeveer 1,5 GB), daarna werkt ook die zonder internet.

### G5. `offline-boekhoudprogramma.html` r.103: samenwerken met de boekhouder heet een "online functie"
De huidige tekst (fragment):
> Wil je automatische bankgegevens of samenwerken met je boekhouder vanuit de app, dan kun je die online functies apart gebruiken.

Waarom dit een gat is: de uitwisseling gaat per eigen e-mail of als bestand, niet via een server (`docs/uitwisseling.md:21`). De licentie wordt offline gecontroleerd.
Voorstel:
> Wil je je bank automatisch laten ophalen met Ponto, dan heb je daarvoor internet nodig. Een periode naar je boekhouder sturen (met het abonnement) kan per e-mail of gewoon als bestand.

### G6. `offline-boekhoudprogramma.html`: geen overzicht van offline en online, opslagplek of formaten
Dit is waar de zoekers naar vragen. De pagina noemt het nu alleen in algemene termen. Voorstel: voeg na r.101 (`</ul>`) dit blok in:

```html
    <h2>Wat werkt zonder internet, en waarvoor heb je het wel nodig?</h2>
    <ul class="checks">
      <li><strong>Zonder internet</strong><br><span class="muted">Offertes en facturen maken (pdf en e-factuur), bankafschriften inlezen (CAMT.053, MT940 of CSV), bonnen nakijken en boeken, btw-overzicht, rapporten, het pakket voor je boekhouder en back-ups maken of terugzetten. De telefoonapp werkt over je eigen wifi, ook zonder internet.</span></li>
      <li><strong>Met internet</strong><br><span class="muted">Updates, e-mail versturen en ophalen (ook het bonnen-adres), je bank laten ophalen met Ponto, een webshop- of betaalkoppeling, een btw-nummer controleren in VIES, een nieuwe wisselkoers bij een buitenlandse bon en de eenmalige download van de tekstherkenning. Lukt dat niet, dan werkt de rest gewoon door.</span></li>
    </ul>
    <h2>Je gegevens: waar ze staan en hoe je ze meeneemt</h2>
    <p>Je administratie staat in de map <code>BoekhoudenVoorNiks</code> in je gebruikersmap, ook als je het programma verwijdert. Elke dag maakt het programma een complete back-up met al je bonnen en facturen (de laatste 14 dagen). Bij <em>Instellingen</em> maak je zelf een back-up, ook versleuteld, en zet je hem terug op een andere computer. Wil je overstappen, dan exporteer je een auditfile (XAF 3.2) met overzichten in CSV; je facturen heb je als pdf en e-factuur.</p>
```

### G7. `downloaden.html` r.42: automatisch bijwerken onderschat
De huidige tekst:
> <strong>Nieuwe versies</strong><br><span class="muted">Het programma meldt zelf als er een nieuwe versie is. Voordat hij een nieuwe versie gebruikt, maakt hij eerst een kopie van je administratie.</span>

Waarom dit een gat is: standaard downloadt de app updates zelf en installeert ze bij het afsluiten (`settings.ts:264`, `updates.ts:66-67`, `Settings.tsx:710`). Voor wie bewust offline werkt, is dat relevant.
Voorstel:
> <strong>Nieuwe versies</strong><br><span class="muted">Standaard downloadt het programma nieuwe versies zelf op de achtergrond en installeert ze als je het sluit; vlak daarvoor maakt het een kopie van je administratie. Liever zelf bepalen? Zet bij Instellingen <em>Automatisch bijwerken</em> uit. Zonder internet werkt het programma gewoon door. De versie uit de Microsoft Store wordt bijgewerkt door de Store.</span>

### G8. `offline-boekhoudprogramma.html` r.107: download-CTA via een tussenpagina
De huidige tekst:
> `<a class="btn" href="gratis-boekhoudprogramma-downloaden.html">Gratis boekhoudprogramma downloaden</a>`

`gratis-boekhoudprogramma-downloaden.html` heeft zelf geen downloadknoppen, alleen links naar `downloaden.html`. Dat is een extra klik. Voorstel:
> `<a class="btn" href="downloaden.html">Gratis downloaden voor Windows of Linux</a>`

De link naar de SEO-pagina staat al in de fine print op r.109. Optioneel: geef ook de bovenste CTA op `gratis-boekhoudprogramma-downloaden.html` (r.90) directe downloadknoppen, net als op `downloaden.html`. Dat is wel een grotere wijziging.

### G9. `gratis-boekhoudprogramma-downloaden.html` r.105: abonnement onvolledig beschreven
De huidige tekst:
> Het boekhoudprogramma zelf is gratis te gebruiken. Alleen aanvullende diensten kunnen apart kosten hebben, zoals samenwerken met je boekhouder vanuit de app of een externe bankdienst die je zelf kiest.

De Android-koppeling en de online hulp ontbreken. Op `index.html` en `zonder-abonnement.html` staan ze wel. Voorstel:
> Het boekhoudprogramma zelf is gratis te gebruiken. Een los abonnement (de eerste 4 maanden gratis) geeft extra functies: de app voor Android, een periode naar je boekhouder versturen en de online hulp bij categorievoorstellen. Een externe bankdienst die je zelf kiest, zoals Ponto, bepaalt zelf zijn kosten en voorwaarden.

### G10 (optioneel). `privacy.html`: de lijst "Welke verbindingen maakt het programma?" mist twee verbindingen
- ECB-koersen gaan automatisch en staan niet in de lijst. Ze staan wel op `buitenlandse-facturen.html:184`. Voorstel: een nieuw `<li>` na r.59 (VIES):
  > `<li><strong>Wisselkoersen (alleen bij een bon of factuur in een andere munt):</strong> het programma vraagt de Europese Centrale Bank (<code>data-api.ecb.europa.eu</code>) om de koers van die munt op die datum. Er gaat alleen de munt en de datum mee; de ECB ziet je IP-adres. Opgehaalde koersen worden bewaard op je eigen computer.</li>`
- R.61 (tekstherkenning) noemt alleen localhost. Voorstel om aan het eind van dat `<li>` toe te voegen:
  > `De ingebouwde tekstherkenning download je eenmalig, na je toestemming: het model van Hugging Face (<code>huggingface.co</code>) en het programma llama.cpp van GitHub. Die diensten zien daarbij je IP-adres; er gaan geen bonnetjes mee.`

### G11 (optioneel). Handleiding `docs/handleiding/beginnen.md` r.12 (gegenereerd naar `site/handleiding/beginnen.html:80`)
De huidige tekst:
> Internet heb je alleen nodig om facturen te mailen, updates te krijgen en, als je dat wilt, je bank automatisch op te halen.

Voorstel (pas daarna `npm run site:handleiding` toe):
> Internet heb je alleen nodig om facturen te mailen, updates te krijgen, mail of je bonnen-adres op te halen, een nieuwe wisselkoers op te zoeken en, als je dat wilt, je bank automatisch op te halen.

### Kleine bijvangst (geen offline-hiaat)
- `README.md:132` zegt: "Download de installer alleen van de GitHub-release". De site zegt: "Download alleen van deze website". Allebei zijn ze juist, maar ze klinken tegenstrijdig. Eventueel aanpassen naar "van boekhoudenvoorniks.nl of de GitHub-release".
- `/zonder-abonnement.html` had 0 klikken bij een gemiddelde positie van ±40–80 voor deze zoektermen. Dat zegt vooral iets over de positie, niet over de pagina. De wijzigingen hierboven gaan over juistheid. Over CTR valt bij deze aantallen niets te zeggen.

## 7. Advies vervolg
1. Eén kleine site-PR met G1–G3 (de claims), G4–G6 (de offline-pagina) en G7–G9 (download en abonnement). G10 en G11 eventueel apart, omdat de privacyverklaring een versiedatum heeft.
2. De handmatige test zonder netwerk uit §5 één keer echt doen op Windows en op Linux. Daarmee is het tweede acceptatiecriterium van het issue afgedekt.
3. Overweeg een e2e- of unit-test die bij een uitgezet netwerk (een `fetch` die altijd faalt) de achtergrondtaken (`backgroundTasks`, `backgroundMail`, `Updates.configure`) doorloopt. Die test bewaakt dat het offline stil blijft. De bouwstenen zijn er: `updates.test.ts` en `bank-feed-taken.test.ts`.
