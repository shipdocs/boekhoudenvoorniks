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
Bij een fout staan een schermafbeelding en een trace in `e2e-results/`
(`npx playwright show-trace e2e-results/…/trace.zip`).
