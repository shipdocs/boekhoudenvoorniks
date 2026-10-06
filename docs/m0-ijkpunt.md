# M0-ijkpunt voor de gedragsneutrale refactor

Dit document legt het ijkpunt vast waartegen de gedragsneutrale refactor naar de
gedeelde berekeningskern (`packages/core`) wordt getoetst. Zie de opdracht: de
refactor is gedragsneutraal — exact dezelfde uitkomsten, bestaande tests blijven
groen. De protocoluitbreiding v2 is een aparte, additieve stap in M1 en valt
niet onder dit ijkpunt.

## IJkpunt-commit

- Refactor-branch: `ooo/android-m0-gedeelde-kern`
- Merge-base van de refactor-branch met `main` (het ijkpunt):
  `ffad204e952b0985b96522fc64a5f4b7324ab8ed`
  — "Site: wekelijkse update met de websitecijfers in de ShipDocs-updates (#329)" (2026-10-05)
- Op het moment van meten staan `main`, `origin/main` en de refactor-branch op
  ditzelfde commit; de merge-base is dus dit punt.

## Testset op het ijkpunt

- Datum meting: 2026-10-06
- Omgeving: Linux, Node v22.22.0, vitest 5.0.2
- Commando: `npm test` (gelijk aan `npm run rebuild:node && vitest run`)
- Uitkomst:
  - Testbestanden: **114, allemaal geslaagd**
  - Tests: **1770 geslaagd, 1 voorwaardelijk overgeslagen, 0 gefaald** (1771 totaal)
  - Duur: ca. 44 s
- De enige overgeslagen test is omgevingsvoorwaardelijk en was ook op het
  ijkpunt al uit:
  `tests/bonnenscanner.test.ts > live: een andere mDNS-socket vindt het ontvangstpunt en ziet het weer verdwijnen`
  (`it.skipIf(!process.env.BVN_TEST_MDNS)` — draait alleen met die omgevings­variabele).

## Afspraak voor de refactor-branch

Op de refactor-branch geldt:

- Geen bestaande test is verwijderd, overgeslagen of inhoudelijk gewijzigd;
  alleen importpaden mogen aanpassen (bijvoorbeeld doordat code uit
  `packages/core` wordt geïmporteerd).
- Het aantal geslaagde tests is minimaal dat van het ijkpunt: **1770**.
- De volledige testset slaagt (`vitest run`, geen voorbijgeslagen bestanden).

## Reproduceren

```bash
git checkout ooo/android-m0-gedeelde-kern
npm test
```

Vergelijk de slotregel `Tests  N passed | M skipped (T)` met de aantallen
hierboven: `N` moet minstens 1770 zijn en er mogen geen testbestanden of tests
zijn verdwenen (uitgangspunt: 114 bestanden, 1771 totaal, waarvan hooguit de
bovenstaande mDNS-live-test voorwaardelijk overgeslagen).
