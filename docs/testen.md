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
| Testgegevens van het telefoonprotocol tegen het document | `BVN_PROTOCOL_DOC=<pad> npx vitest run tests/protocol-document.test.ts` | Optioneel: vergelijkt `tests/fixtures/protocol/` met de volledige technische beschrijving; zonder de variabele overgeslagen |
| TypeScript controleren | `npm run typecheck` | Productiecode en tests |
| Alle browserflows | `npm run e2e` | Build plus Playwright tegen een tijdelijke database |
| Browserflows zonder nieuwe build | `npm run e2e:only` | Alleen Playwright |
| Productiebuild | `npm run build` | Main-process en renderer |
| Alles wat CI controleert, lokaal | `npm run controle` | Typecheck, tests, build en de overige controles; met `-- --e2e` ook de kritieke schermflows |

## Wat draait waar

- **Lokaal, vóór een wijziging erin gaat**: `npm run controle` en, als je schermen raakt, `npm run e2e`. De volledige browsertest-suite draait lokaal.
- **Op GitHub**: bij elke push en pull request de Linux-controles (unit-tests met build en de rooktest van de verpakte app), een kleine set kritieke financiële Playwright-schermflows (facturen, bank/bonnen en periodeafsluiting) en het Windows-Store-pakket. De overige Windows-controles (de hele unit-suite op Windows en de rooktest van de verpakte Windows-app) draaien pas na een push naar `main`, niet bij een pull request.
- **Bij een release**: de Release-workflow draait de tests op Linux en Windows nog een keer en publiceert alleen als beide slagen.

Gebruik Node 22 ook als de systeemversie ouder is. Met de lokale nvm-installatie kan dat bijvoorbeeld
zo:

```bash
PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH" npm test
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

## Fiscale wijzigingen beoordelen

Leg bij een wijziging van een boekhoudregel of fiscale parameter vast welk gedrag verandert, voor
welk belastingjaar en welke voorwaarden gelden. Onderbouw de verwachting met een primaire bron
(bijvoorbeeld Belastingdienst, toepasselijke wettekst of RVO), inclusief raadpleegdatum en relevante
passage of tabel. Een toelichting van een derde kan helpen bij de interpretatie, maar vervangt de
primaire onderbouwing niet. Maak onderscheid tussen een voorstel en een vastgestelde regel.

Controleer de verwachte uitkomst afzonderlijk van de implementatie:

- Gebruik voor een test van een wettelijk tarief of grensbedrag een expliciete verwachting uit de
  bron. Alleen vergelijken met dezelfde productieparameter bewijst de juistheid van die parameter
  niet. Een test met productieparameters kan wel de toepassing ervan controleren.
- Schrijf voor een berekening de invoer, tussenstappen, afronding en uitkomst uit, zonder de verwachte
  uitkomst door de productiefunctie te laten genereren. Laat die berekening door de maintainer
  beoordelen; dezelfde agent opnieuw laten rekenen is geen onafhankelijke fiscale review.
- Neem toepasselijke grensgevallen op: net onder, op en boven een grens, uitzonderingen en een
  jaarovergang. Behoud controles voor historische jaren als de nieuwe regel alleen later geldt.
- Vermeld wie de verwachting heeft beoordeeld, op welke datum en op welke commit de gedraaide
  controles betrekking hebben. Maak onderscheid tussen bronbeoordeling, geslaagde tests en een
  externe beoordeling door een accountant of fiscalist.

Leg de openbare onderbouwing bij het scenario of in de PR vast.
Bij ontbrekend bewijs blijft de fiscale verificatie open; een groene test maakt een aanname niet
automatisch tot een bevestigde regel. Pas een fiscale regel niet uitsluitend op basis van een
AI-samenvatting aan.

## Business rules en correcties

`tests/business-rules-review.test.ts` bewaakt de zestien bevindingen van 4 oktober 2026.
`tests/business-rules-boundaries.test.ts` test onder meer historische betalingen, tegenboekingen,
credits bij meerdere bedrijfsmiddelen, btw-maxima en reproduceerbaarheid van oude regelversies.
`e2e/business-rules.spec.ts` controleert de creditkeuze en de aparte aanschaf-/autokosten-btw-instellingen.

De scannertest voor een verhuizing naar `127.0.0.2` controleert eerst met een onafhankelijke HTTP-server
of de testomgeving dat tweede loopback-adres kan bereiken. Als de transportlaag alle lokale verzoeken
naar `127.0.0.1` stuurt, wordt uitsluitend deze netwerkproef met een expliciete reden overgeslagen.
Op een normale Linux-/Windows-host blijft de echte scannerproef actief.

## Beroepen en btw-voorstellen

`tests/beroepen-btw.test.ts` controleert de voorgestelde tarieven voor schilders en stukadoors,
ook het overnemen van het tarief van het werk door de voorrijkosten. `e2e/beroepen-btw.spec.ts`
controleert de echte factuurknoppen voor werk, materiaal en voorrijkosten, en handmatig gekozen
21% of btw verlegd. De KOR-varianten bewijzen alleen dat alle voorstelregels dan vrijgesteld zijn.
Deze tests bewijzen geen fiscale juistheid buiten de genoemde voorwaarden.
