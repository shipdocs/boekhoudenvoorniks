# Online hulp bij categorievoorstellen (JEV via Cloudflare), issue #132

Uitvoerbaar plan en stand van de eerste tranche. JEV (`typesafe/jev`, Workers AI) kiest uitsluitend een
categorie uit de categorieën van de administratie, en alleen als het leveranciersgeheugen en de vaste
regels geen voorstel geven. Alles daarna (btw, zakelijk/privé, bankkoppeling, boeking) blijft
deterministisch of een keuze van de gebruiker.

## Beslissingen

| Vraag | Besluit |
|---|---|
| Wie mag het gebruiken? | Alleen met een **actief betaald abonnement** (reactie op #132). Standaard uit; de gebruiker zet het zelf aan. |
| Waar zit de controle? | Twee keer: de app stuurt niets zonder actieve licentie en opt-in; de Worker controleert het abonnement zelf opnieuw bij de licentie-Worker (Service Binding). |
| Ollama én JEV? | Nooit ongemerkt samen. Staat online hulp aan (en is het abonnement actief), dan vervangt JEV de lokale AI. Anders geldt de lokale AI zoals ingesteld. |
| Hoe authenticeert de app? | Administratie-ID + de bestaande lokale beheersleutel (Bearer). De Worker kent alleen de SHA-256-hash (licentie-D1). Geen Cloudflare-token of gedeeld geheim in Electron. |
| Quota | Per administratie per dag in de licentie-D1 (`assistant_usage`), atomisch opgehoogd; plus een rate limit per administratie in de assistent-Worker. |
| Kill switch | `ENABLED` in `workers/assistent/wrangler.jsonc`; standaard `"false"`. Uit = 503, de app valt terug. |
| Leren | Alleen de uiteindelijke keuze van de gebruiker, via het bestaande `SupplierMemory.learn(...)`. Geen apart JEV-geheugen. |
| Audit | `classification.proposedBy` (`geheugen`, `regel`, `ollama`, `jev`, `standaard`) plus `model`; bij bevestigen `classification.accepted` en een teller in `proposal_stats` (geaccepteerd/gecorrigeerd per voorsteller en model). De verstuurde payload wordt nergens bewaard. |

## Stroom

```text
document → extractie (UBL / PDF-tekst / OCR) → validatie
  → Classifier: leveranciersgeheugen → vaste regels → [JEV of Ollama] → standaard
  → Vandaag: "We denken: materiaal (voorstel van online hulp). Alles klopt?"  [Ja] [Aanpassen]
  → Ja: bestaande handler; eerst gecontroleerd dat het voorstel nog hetzelfde is
  → confirm(): SupplierMemory.learn(eindkeuze) + proposal_stats + boeking door vaste regels
```

## Contract v1 (app → `POST https://assistent.boekhoudenvoorniks.nl/v1/classificeren`)

Header `Authorization: Bearer <beheersleutel>`.

```ts
type JevClassifyRequest = {
  schemaVersion: 1;
  administrationId: string;        // UUID
  appVersion: string;              // ≤ 32 tekens
  supplier: string | null;         // ≤ 100 tekens
  lines: string[];                 // ≤ 15 regels, elk ≤ 120 tekens, zonder bedragen/IBAN/e-mail
  categories: { key: string; label: string; hint: string }[]; // 1..60, key ≤ 40, label ≤ 80, hint ≤ 200
};
type JevClassifyResponse =
  | { schemaVersion: 1; model: string; categoryKey: string; confidence: number; probabilities: Record<string, number> }
  | { schemaVersion: 1; model: string | null; categoryKey: null }; // geen (veilig) voorstel
```

Fouten: 400 ongeldig verzoek, 401 geen/ongeldige sleutel, 402 geen actief abonnement, 413 te groot,
429 rate limit of dagquotum, 503 uitgeschakeld, 504 time-out, 502 modelstoring. De app behandelt
alles behalve een geldig 200-antwoord als "geen voorstel" en gaat door met de standaardcategorie.

## Uitvoering (deze branch)

1. **App**
   - `src/intake/llm-jev.ts`: `JevClassifier implements LlmClassifier`, `minimizeJevRequest` (alleen
     toegestane velden; bedragen, IBAN, e-mail en lange nummers eruit), `parseJevResponse` (strikt).
     Time-out 8 s. Onder `JEV_MIN_CONFIDENCE` (0,5; bij te stellen na de benchmark) geen voorstel.
   - `Classifier`: `proposedBy` en `model` in de classificatie; LLM-zekerheid blijft afgetopt op 0,7
     en `automatic: false`. JEV-uitleg is een vaste zin, geen modeltekst.
   - Instelling `ocr.onlineCategoryHelp` (standaard uit), alleen aan te zetten met actief abonnement.
   - `main.ts`: kiest JEV (met licentie-/opt-in-controle per aanroep) of Ollama.
   - Vandaag: vraag en "Waarom?" noemen de voorsteller; `ref.proposal` legt het getoonde voorstel vast
     en `document-review:klopt` weigert als het voorstel intussen is veranderd.
   - `IntakeService.confirm`: legt `accepted` en `proposal_stats` vast (alleen bij een bevestiging door
     de gebruiker, niet bij automatisch verwerken). Migratie 24: `proposal_stats`.
2. **Licentie-Worker**: `authorizeAssistant()` in `app.ts` (abonnement actief t/m betaalde periode +
   marge, beheersleutel, dagquotum atomisch) en RPC-entrypoint `Controle` in `index.ts`. Migratie
   `0005_assistent_gebruik.sql`.
3. **Assistent-Worker** `workers/assistent`: `POST /v1/classificeren`, Workers AI-binding `AI`, AI
   Gateway met `skipCache: true` en `collectLog: false` en zonder metadata, Service Binding `LICENTIE`,
   rate limit `PER_ADMINISTRATIE`, kill switch, bodylimiet 16 KB, strikte schema's, time-out, logs alleen
   met status, schema-/app-/modelversie en latency-bucket.
4. **Tests**: `tests/jev.test.ts` (app), `tests/assistent-worker.test.ts` (Worker), uitbreiding van
   `tests/licentie.test.ts` (autorisatie en quotum).
5. **Benchmark (fase 0)**: `tests/fixtures/jev-benchmark.json` (synthetisch) en
   `src/tools/jev-benchmark.ts` (`npm run benchmark:jev`): regels, optioneel Ollama en optioneel JEV.
6. **Teksten**: instelling, privacyverklaring, README, CHANGELOG.

## Activeren (handmatig, in deze volgorde)

1. Benchmark draaien met JEV op staging (zie onder) en de uitkomst hieronder vastleggen. Geeft JEV geen
   duidelijke winst boven "regels + standaard", dan niet activeren.
2. Licentie-D1: `cd workers/licentie && npm run migrate` en controleren met
   `npx wrangler d1 migrations list boekhoudenvoorniks-licenties --remote` dat 0005 is toegepast.
   Pas daarna de licentie-Worker deployen (hij exporteert dan het entrypoint `Controle`).
3. AI Gateway `boekhoudenvoorniks-assistent` aanmaken (dashboard: AI > AI Gateway), en expliciet
   instellen: **logs uit**, **cache uit**, **rate limiting aan** (bv. 60/min), authenticated gateway aan.
   Niet op standaardwaarden vertrouwen.
4. Kostenalarm: Cloudflare Notifications, budgetmelding voor Workers AI.
5. Assistent-Worker deployen met `ENABLED: "false"`; met synthetische data een staging-aanroep doen
   (`wrangler dev --remote` of tijdelijk aanzetten) en de werkelijke respons en `model` noteren.
6. Actuele TypeSafe-voorwaarden nalezen; privacyverklaring op de site publiceren (bijgewerkt op deze
   branch). Laten nakijken of artikel 8 van de voorwaarden (het abonnement) de online hulp moet noemen.
   Licenties moeten in de app aan staan (`LICENSE_PUBLIC_KEY`); zonder licentie is de instelling niet
   aan te zetten.
7. `ENABLED: "true"` en deployen. Terugdraaien kan altijd met `"false"`: de app valt dan stil terug.

## Benchmark

`npm run benchmark:jev` meet top-1, top-2, precisie in de hoge-zekerheidsgroep (≥ 0,7), dekking
(voorstel ≠ geen/standaard), ongeldige antwoorden en p50/p95-latency. Opties via omgevingsvariabelen:

- `OLLAMA_URL` + `OLLAMA_MODEL`: lokale AI meenemen;
- `JEV_ACCOUNT_ID` + `JEV_API_TOKEN`: JEV rechtstreeks via de Workers AI REST-API (alleen voor de
  benchmark, met synthetische data; nooit in de app).

Nulmeting, 30 september 2026, 40 synthetische gevallen (`npm run benchmark:jev`, alleen regels):

| methode | top-1 | top-2 | dekking | precisie | hoog zeker (n) | ongeldig | p50 | p95 | tokens |
|---|---|---|---|---|---|---|---|---|---|
| regels | 18% | 18% | 20% | 88% | 88% (8) | 0 | 0 ms | 1 ms | 0 |

Per soort: bekend 88%, onbekend 0%, gemengd 0%, misleidend 0%, weinig informatie 0%. "Geen voorstel"
(standaardcategorie) telt als fout, ook als de verwachte categorie `overig` is. De ruimte voor JEV zit
dus volledig in de onbekende leveranciers; daar moet de meting winst laten zien, met een hoge precisie
in de hoge-zekerheidsgroep.

JEV-meting: nog te doen vóór activering (stap 1); vul dan deze tabel aan met `jev los` en
`regels + jev`, het teruggegeven model en de kosten (tokens × $0,042 per miljoen).

## Waar JEV verder waarde kan toevoegen (onderzoek, niet gebouwd)

Steeds: gesloten vraag (`choice`/`noul`/`score`), minimale gegevens, eigen benchmark, en het antwoord
is een signaal op Vandaag, nooit een boeking of indiening.

| Kandidaat | Vraag aan JEV | Waarom zinvol | Risico / grens |
|---|---|---|---|
| **Zakelijk of privé** bij een onbekende betaling | `noul`: lijkt dit een privé-uitgave? (omschrijving + tegenpartij) | Veel vragen op Vandaag gaan hierover | Nooit zelf privé boeken; alleen de vraag anders formuleren |
| **Investering of kosten** | `choice`: verbruik / gereedschap / bedrijfsmiddel (artikelomschrijving) | Aanvulling op de vaste € 450-grens (bedrag blijft lokaal en beslissend) | Het bedrag gaat niet mee; de grens blijft een regel |
| **Controle vóór de btw-aangifte** | `noul` per afwijkende post: past deze btw-code bij deze omschrijving? (bv. 9% op software) | Vangt typfouten die regels missen; past bij `btw/checks.ts` | Alleen extra controlevraag; de aangifte blijft deterministisch en wordt nooit door een model ingediend |
| **Gedeeltelijk aftrekbaar** | `choice`: representatie / voedsel / kleding / normaal | Beperkt aftrekbare kosten worden vaak gemist | Fiscale uitleg blijft uit vaste teksten, niet uit het model |
| **Omzet zonder factuur** | `choice` bij een binnenkomende betaling: klant / terugbetaling / eigen geld / rente | Helpt de bestaande "wat was dit?"-vraag voorsorteren | Geen bedragen of IBAN naar buiten |
| **Mail-intake** | `choice`: factuur / herinnering / nieuwsbrief / klantvraag (onderwerp + afzenderdomein) | Minder handwerk bij de mailbox | Geen mailinhoud versturen |
| **Prioriteit op Vandaag** | `score`: hoe dringend (type taak, dagen open, deadline) | Betere volgorde van taken | Zonder inhoud; puur metagegevens |
| **Dubbele bon** | `noul` bij twee kandidaten: dezelfde aankoop? (omschrijvingen) | Aanvulling op de exacte duplicaatcontrole | Nooit automatisch weggooien |

Buiten scope blijven: btw indienen, betalingen, facturen of herinneringen versturen, offertes
accepteren, opzeggen, verwijderen, en een vrije chatbot of agent.
