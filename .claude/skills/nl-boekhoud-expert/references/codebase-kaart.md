# Codebase-kaart: waar zit welke regel

Controleer met `ls`/grep of dit nog klopt; paden kunnen verschuiven.

| Onderwerp | Waar |
|---|---|
| Boekregels per gebeurtenistype (inkoop, verkoop, bank, privé, btw-codes) | `src/core-ledger/rules.ts`; bevroren oudere compiler `rules-2026-2.ts`; versie in `rules-version.ts` |
| Grootboek, journaalposten, tegenboekingen, integriteit | `src/core-ledger/ledger.ts`, `events.ts`, `accounts.ts`, `rgs-codes.json` (RGS-schema) |
| Open posten / vraagposten | `src/core-ledger/open-items.ts` |
| Btw-aangifte, rubrieken, correcties, KOR, ICP | `src/btw/btw.ts`; XBRL-uitvoer `xbrl.ts` |
| Btw-controles vóór indienen (blokkerend / waarschuwing, overslaan met vingerafdruk) | `src/btw/checks.ts` |
| Autokosten: forfait, privégebruik, maximum | `src/btw/car.ts`; kilometers `src/tax/mileage.ts` |
| Inkomstenbelasting: box 1, aftrekposten, heffingskortingen, Zvw | `src/tax/income-tax.ts`, overzicht `src/tax/overview.ts` |
| Bedrijfsmiddelen, afschrijving, desinvestering, credits | `src/tax/assets.ts` (historie in `asset_depreciation_history`, append-only) |
| KIA-controle | `src/tax/investment-check.ts` |
| Periodeafsluiting | `src/closing/period-close.ts` |
| Facturen, nummering, UBL-uit | `src/documents/invoices.ts`, `numbering.ts`, `ubl-out.ts`, `totals.ts` |
| Inkoop, dubbele aankopen, bank-koppeling | `src/documents/purchases.ts`, `bank-purchase-match.ts`, `src/import/bank.ts`, `src/integrations/ponto.ts` |
| Boekhouderspakket / export (XAF, UBL, CAMT) | `src/export/accountant-package.ts`, `accountant.ts` |
| Rapporten, beginbalans | `src/reports/ledger-reports.ts`, `opening-balance.ts` |
| Dashboard / peildatum-overzichten | `src/dashboard/dashboard.ts` |
| Migraties (schema-geschiedenis, append-only triggers) | `src/db/migrations.ts` |

## Eerdere reviews (lees voor je "nieuwe" bevindingen meldt)
- `docs/fiscale-review.md` — vragenlijst voor boekhouder + code-audit (27-09-2026) + business-rule-review R01–R16 (04-10-2026)
- `docs/reviews/2026-10-04-business-rules/` — dossier met scenario's, oude uitkomst, verwachting, oorzaak, oplossing
- Tests: `tests/fiscale-audit.test.ts`, `tests/business-rules-*.test.ts`, `tests/belastingvoordelen.test.ts`, `tests/btw*.test.ts`, `tests/controles.test.ts`

## Testen
- Eén bestand: `npx vitest run tests/<naam>.test.ts` (Node 22; `PATH=/home/martin/.nvm/versions/node/v22.22.0/bin:$PATH` als de systeemnode ouder is)
- Fixture: `setup()` uit `tests/helpers.ts` geeft `{ s, db }` (services + in-memory SQLite). Zie `tests/business-rules-followup.test.ts` voor helpers als `purchase()` en `bank()`.
- Volledige suite: `npm test`; typecheck `npm run typecheck`. E2E alleen lokaal.
