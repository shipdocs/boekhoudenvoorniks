# Testen

De tests zijn in lagen verdeeld. Gebruik tijdens ontwikkeling de kleinste laag die het gewijzigde
gedrag bewijst en draai vóór samenvoegen de volledige relevante controles.

## Vereisten

- Node.js 22.12 of nieuwer;
- geïnstalleerde dependencies met `npm install` of `npm ci`;
- voor E2E-tests een bruikbare Chromium-installatie.

`better-sqlite3` is een native module. De standaard testcommando's bouwen hem voor de actieve
Node-versie voordat Vitest start.

## Commando's

| Doel | Commando | Omvang |
|---|---|---|
| Eén unit- of integratietest | `npx vitest run tests/btw.test.ts` | Eén testbestand, zonder rebuild |
| Alle unit- en integratietests | `npm test` | Alle bestanden onder `tests/`, inclusief de proefadministratie |
| Alleen de vaste proefadministratie | `npm run test:proefadministratie` | XAF, UBL, CAMT en de daaruit volgende boekhouding |
| TypeScript controleren | `npm run typecheck` | Productiecode en tests |
| Alle browserflows | `npm run e2e` | Build plus Playwright tegen een tijdelijke database |
| Browserflows zonder nieuwe build | `npm run e2e:only` | Alleen Playwright |
| Productiebuild | `npm run build` | Main-process en renderer |

## Wat draait waar

- **Lokaal, vóór een pull request**: `npm test`, `npm run typecheck` en, als je schermen raakt, `npm run e2e`. De browsertests draaien alleen lokaal; op GitHub deden ze hetzelfde en kostten ze vooral wachttijd.
- **Op GitHub bij een pull request**: alleen de snelle Linux-controles (unit-tests met build, de rooktest van de verpakte app en de website-Worker).
- **Op GitHub na het mergen naar `main`**: de Windows-controles, waar lokaal geen vervanger voor is: de hele unit-suite op Windows en de upgrade-test met de echte installers. Kijk na een merge of die groen zijn voordat je een release maakt.
- **Bij een release**: de Release-workflow draait de tests op Linux en Windows nog een keer en publiceert alleen als beide slagen.

Gebruik Node 22 ook als de systeemversie ouder is. Met de lokale nvm-installatie kan dat bijvoorbeeld
zo:

```bash
PATH=/home/martin/.nvm/versions/node/v22.22.0/bin:$PATH npm test
```

## Vaste proefadministratie

De map [tests/proefadministratie](../tests/proefadministratie/README.md) bevat één boekhoudkundig
samenhangend scenario:

1. een XAF-administratie tot en met 31 december 2025 wordt de startpositie;
2. verkoopfacturen worden via de normale factuurservice definitief gemaakt;
3. UBL-inkoopfacturen gaan door de normale documentinbox en krijgen expliciete gebruikerskeuzes;
4. een CAMT.053-afschrift wordt geïmporteerd en aan facturen en inkopen gekoppeld;
5. de uitkomst wordt vergeleken met `expected.json`.

De vergelijking omvat de volledige set niet-nulle grootboeksaldi, debet/credit-integriteit,
bankaansluiting, winst-en-verliesrekening, btw-rubrieken, openstaande posten, onverwerkte bankregels
en dubbele invoer.

### Als de test faalt

Werk `expected.json` niet automatisch bij. Bepaal eerst waar het verschil ontstaat:

1. controleer of een bronbestand of expliciete keuze bewust is veranderd;
2. vergelijk de afwijkende grootboekrekening met de handberekening in de README van de testset;
3. controleer de journaalposten die samen dat saldo vormen;
4. beslis vervolgens of de productiecode fout is of de boekhoudkundige afspraak echt is gewijzigd;
5. pas de verwachting alleen in het laatste geval aan en leg de reden vast in de commit.

Daarmee blijft het verwachte resultaat een onafhankelijke controle en geen momentopname die door de
app zelf is gegenereerd.

## Wat de proefadministratie niet test

- OCR-kwaliteit van foto's en scans: daarvoor bestaan de intake-, OCR- en benchmarktests;
- alle scherminteracties: daarvoor bestaan de Playwright-tests in `e2e/`;
- het verpakte Electron-programma: dat wordt apart in CI gecontroleerd;
- fiscale juistheid van ieder denkbaar praktijkgeval: voeg daarvoor een gericht scenario en een
  handmatig gecontroleerde verwachting toe.

## Business rules en correcties

`tests/business-rules-review.test.ts` bewaakt de zestien bevindingen van 4 oktober 2026.
`tests/business-rules-boundaries.test.ts` test onder meer historische betalingen, tegenboekingen,
credits bij meerdere bedrijfsmiddelen, btw-maxima en reproduceerbaarheid van oude regelversies.
`e2e/business-rules.spec.ts` controleert de creditkeuze en de aparte aanschaf-/autokosten-btw-instellingen.

De scannertest voor een verhuizing naar `127.0.0.2` controleert eerst met een onafhankelijke HTTP-server
of de testomgeving dat tweede loopback-adres kan bereiken. Als de transportlaag alle lokale verzoeken
naar `127.0.0.1` stuurt, wordt uitsluitend deze netwerkproef met een expliciete reden overgeslagen.
Op een normale Linux-/Windows-host blijft de echte scannerproef actief.
