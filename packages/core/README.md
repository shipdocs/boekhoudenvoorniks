# Gedeelde kern (`@gratis-boekhouden/kern`)

Deze map bevat de zuivere rekenkern van BoekhoudenVoorNiks: de code die alleen
rekent en teksten vormgeeft, zonder Node, Electron of de database. De desktop-app
gebruikt haar via de oude paden onder `src` (dunne her-exports); een latere
Android-app kan haar letterlijk hetzelfde gebruiken.

## Inhoud

| Module | Wat |
| --- | --- |
| `src/shared/money.ts` | Bedragen in centen, `parseEuro`, commercieel afronden (half-away-from-zero) |
| `src/shared/validation.ts` | IBAN, e-mailadres, btw-nummer, KVK, `ValidationError` |
| `src/shared/vat.ts` | Btw-codes en -tarieven, ICP/export/verlegd, EU-landen, aangifterubrieken |
| `src/shared/dates.ts` | ISO-datums, perioden, werkdagen, deadlines, weeknummer |
| `src/shared/legal.ts` | Juridische teksten en verwijzingen (voorwaarden, privacy) |
| `src/shared/countries.ts` | Landenlijst voor keuzelijsten en de naam van een land |
| `src/shared/currency.ts` | Vreemde valuta herkennen en tonen |
| `src/documents/totals.ts` | Totalen en btw per document (per groep berekend, niet per regel) |
| `src/documents/numbering.ts` | Documentnummerformaten en tellersleutels |
| `src/documents/render.ts` | Minimale Mustache-subset voor factuur-/offertetemplates |
| `src/documents/invoices.ts` | `checkInvoiceRequirements`: de wettelijke factuurcontrole als zuivere functie (bedrijfsgegevens, adres, KOR, verlegging, ICP en export), met dezelfde foutmeldingen als de app |

De mapstructuur (`shared`, `documents`) en de interne relatieve imports zijn
ongewijzigd overgezet: de bestanden zijn exact dezelfde bytes als in `src`.

## Zuiverheid

De kern heeft geen dependencies en geen `node:`-imports, geen `Buffer`, geen
`process` en geen database- of Electron-types (het eigen `tsconfig.json` laadt
geen `@types/node`). `tests/kern.test.ts` controleert dit en rekent een paar
basisvectoren na via de oude importpaden.

Bestanden die als kandidaat bekeken zijn maar niet zuiver bleken en daarom in
`src` zijn blijven staan:

- `src/documents/lines.ts` — hangt aan de database (`Db`);
- `src/shared/zip.ts` — gebruikt `node:zlib` en `Buffer`;
- `src/shared/xlsx.ts` — geeft `Buffer` terug.

## Koppeling met de app

Gekozen voor een npm-afhankelijkheid (`"dependencies": { "@gratis-boekhouden/kern":
"file:packages/core" }`). npm legt een symlink in `node_modules`, zodat:

- de oude paden (`src/shared/money.ts`, …) als één-regel her-exports kunnen
  blijven bestaan en de rest van de code en de tests onveranderd blijven;
- zowel de app-build (`tsc -p tsconfig.main.json`, Node16-resolutie) als de
  renderer-build (Vite) en vitest via `node_modules` oplossen;
- de kern eerst naar JavaScript gecompileerd wordt (`npm run build:kern`);
  `build:main`, `test`, `test:watch`, `test:proefadministratie` en `typecheck`
  starten die stap automatisch, dus `npm run build`, `npm test` en
  `npm run typecheck` werken als voorheen.

Weggezet tegen de alternatieven:

- **tsconfig paths** naar de kernbron kan niet zonder de hoofdbuild te veranderen:
  `tsconfig.main.json` heeft `rootDir: src` en emit naar `dist/main` (de
  Electron-entry `dist/main/main/main.js` moet blijven staan); bronbestanden
  buiten `src` mogen niet mee-emit worden.
- **project references** (met of zonder `prepend`) vragen meer bouwconfiguratie
  voor hetzelfde resultaat; de `file:`-afhankelijkheid is de minst ingrijpende
  koppeling die build, tests en verpakking intact laat.

## Verpakking

electron-builder neemt productie-afhankelijkheden op uit `node_modules`, dus de
gecompileerde kern zit in het installatiepakket (`app.asar`/`node_modules/@gratis-boekhouden/kern`).
De lijst `files` in de root-`package.json` hoefde daarvoor niet te veranderen.
