# Assistent-Worker

Online hulp bij categorievoorstellen (#132). Het plan, het contract en de volgorde van activeren staan
in [docs/jev-assistent.md](../../docs/jev-assistent.md); dit is de korte technische kant.

| Route | Wat |
|---|---|
| `POST /v1/classificeren` | (JSON, `Authorization: Bearer <beheersleutel>`) JEV kiest één categorie uit de meegestuurde lijst; antwoord met `categoryKey`, `confidence`, `probabilities` en `model`, of `categoryKey: null` (geen voorstel) |

Statussen: 400 ongeldig, 401 sleutel, 402 geen abonnement, 413 te groot, 429 rate limit of dagquotum,
503 uitgeschakeld (`ENABLED`), 504 time-out, 502 modelstoring. De app valt bij alles behalve een
geldig 200-antwoord terug op de gewone flow.

- **Bindings**: `AI` (Workers AI), `LICENTIE` (Service Binding naar het entrypoint `Controle` van
  `boekhoudenvoorniks-licentie`: abonnement, beheersleutel en dagquotum in de licentie-D1),
  `PER_ADMINISTRATIE` (rate limit, 30 per minuut per administratie).
- **Vars**: `ENABLED` (kill switch, alleen `"true"` = aan), `GATEWAY_ID`, `MODEL`, `DAILY_QUOTA`,
  `TIMEOUT_MS`. Geen geheimen.
- **AI Gateway**: aanroep met `skipCache: true` en `collectLog: false`, zonder metadata. Zet in het
  dashboard ook op de gateway zelf logs en cache uit en rate limiting aan.
- **Logs**: één regel per verzoek met route, status, schema-/app-/modelversie, aantallen en een
  latency-bucket. Nooit inhoud, sleutel of administratie-ID.

Geen eigen `package.json`: typecheck en bundelen met de packages van `workers/licentie`:

```bash
cd workers/licentie && npm ci
cd ../assistent
../licentie/node_modules/.bin/tsc -p tsconfig.json
../licentie/node_modules/.bin/wrangler deploy --dry-run --outdir .wrangler/dry-run
```

De logica staat in `src/app.ts` en is getest in `tests/assistent-worker.test.ts` (met nagebootste AI,
licentie-controle en rate limit); de autorisatie en het quotum in `tests/licentie.test.ts`.

## Stand (30 september 2026)

Gebouwd, niet gedeployd. `ENABLED` staat op `"false"`. Vóór activeren: zie "Activeren" in
docs/jev-assistent.md (eerst D1-migratie 0005 en de licentie-Worker, dan de Gateway, dan deze Worker).
