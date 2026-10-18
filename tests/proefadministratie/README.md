# Proefadministratie

Dit is een vaste, samenhangende administratie waarmee we periodiek controleren of dezelfde invoer
nog exact dezelfde boekhouding oplevert.

## Draaien

Node 22.12 of nieuwer is vereist.

```bash
npm run test:proefadministratie
```

De test begint iedere keer met een lege tijdelijke database en verwerkt vervolgens:

1. `opening/administratie-2025.xaf` als startpositie op 1 januari 2026;
2. de twee verkoopfacturen uit `scenario.json` via de normale factuurservice;
3. alle UBL-inkoopfacturen uit `inkopen/` via de normale documentinbox;
4. `bank/afschrift-2026-q1.camt053.xml` via de CAMT-import;
5. de expliciete koppelingen en categorie uit `scenario.json`;
6. alle verwachtingen uit `expected.json`.

## Wat wordt gecontroleerd

- elke journaalpost is in balans;
- de volledige lijst van niet-nulle grootboeksaldi is exact gelijk;
- het banksaldo sluit aan op het eindsaldo in het afschrift;
- omzet, kosten en winst zijn exact gelijk;
- btw-rubrieken en het te betalen bedrag zijn exact gelijk;
- openstaande verkoop- en inkoopfacturen zijn exact gelijk;
- alle bankregels en documenten zijn verwerkt;
- dezelfde bank- en documentbestanden nogmaals inlezen veroorzaakt geen dubbele boekingen.

`expected.json` is de onafhankelijke afspraak. Werk dat bestand niet automatisch bij wanneer een test
faalt. Bepaal eerst of de app fout is of dat de boekhoudkundige verwachting bewust moet veranderen.

De XAF bevat alleen de administratie tot en met 31 december 2025. Alles vanaf 1 januari 2026 staat in
de overige bestanden. Zo worden posten niet dubbel geïmporteerd.

## Onafhankelijke handberekening

Alle bedragen hieronder zijn in euro's; `expected.json` bewaart ze als gehele centen.

- Start: bank 10.000 + debiteur 1.210 - crediteur 605 - te betalen btw 105 = eigen vermogen 10.500.
- Bankmutaties: 1.210 + 1.210 - 605 - 242 - 12,50 = 1.560,50. Samen met het beginsaldo is het eindsaldo 11.560,50.
- Omzet 2026: 1.000 tegen 21% + 500 tegen 9% = 1.500.
- Kosten 2026: materialen 200 + software 100 + gereedschap 300 + onderaannemer 400 + bankkosten 12,50 = 1.012,50.
- Winst 2026: 1.500 - 1.012,50 = 487,50.
- Btw Q1: 210 + 45 + 84 verlegd - (42 + 21 + 63 + 84 voorbelasting) = 129 te betalen.
- Open na alle betalingen: verkoopfactuur 545; inkopen 363 + 400 = 763.

PDF- en fotoherkenning horen bewust niet bij deze saldotest: OCR kan veranderen zonder dat de
boekingsregels veranderen. Daarvoor bestaan aparte intake- en OCR-tests.
