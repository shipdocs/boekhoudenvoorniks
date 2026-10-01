# End-to-end tests

De echte schermen in Chromium, met de echte services en een echte (tijdelijke) database. Alleen
Electron zelf is vervangen door een kleine testserver (`server.cjs`): de renderer praat via
`window.bridge` met HTTP in plaats van IPC. Het verpakte Electron-programma wordt apart getest in CI
(`package-smoke`).

```bash
npm run e2e                 # bouwen en alle tests draaien
npm run e2e:only            # zonder opnieuw te bouwen
npx playwright test --ui    # met de Playwright-interface (stap voor stap kijken)
```

Eigen Chromium (bv. als `npx playwright install` niet kan): `PW_CHROMIUM=/pad/naar/chrome npm run e2e`.

Elke test begint met een lege administratie. Een crash of console-fout in de pagina laat de test
falen (zie `fixtures.ts`). `rondgang.spec.ts` bezoekt alle schermen van de demo en doet een
toegankelijkheidscontrole (axe); kritieke problemen laten de test falen, de rest staat in het rapport.
`overstappen.spec.ts` doorloopt de overstap-hulp: elk hoofdstuk met de hand (op 1 januari en midden
in het jaar), voorstellen uit bankafschriften, e-facturen, en elk bestand dat erop gesleept kan
worden (auditfile, kolommenbalans, saldibalans, lijst met openstaande posten, onbekende kolommen).
De datums zijn relatief aan het huidige jaar, zodat de tests niet verlopen.
Bij een fout staan een schermafbeelding en een trace in `e2e-results/`
(`npx playwright show-trace e2e-results/…/trace.zip`).

`bonnenscanner.spec.ts` gebruikt het echte ontvangstpunt van de bonnenscanner (op de testserver alleen op
127.0.0.1, zonder mDNS): de test leest de QR-code van het scherm en meldt zich als telefoon met echte,
versleutelde verzoeken. "Map kiezen…" krijgt de map die de test via `POST /__scanner` opgeeft, en met
`POST /__reset {"scannerPlatform":"win32"}` doet de server alsof de app op Windows draait. Telefoon koppelen
staat in de app nog uit (`src/shared/phone-scanner.ts`); de tests van het koppelen zetten het zelf aan met
`POST /__reset {"phoneScanner":true}`, en één test controleert de app zoals hij nu is (alleen de bonnenmap).

De E2E-tests bewijzen de bediening in de echte schermen. De aparte
[proefadministratie](../tests/proefadministratie/README.md) controleert aanvullend dat één vaste set
XAF-, UBL- en CAMT-gegevens exact dezelfde grootboeksaldi, btw en openstaande posten blijft geven.
Een overzicht van alle testlagen staat in [docs/testen.md](../docs/testen.md).
