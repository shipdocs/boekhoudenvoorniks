# Plan: Windows via de Microsoft Store (issue #172)

Vastgelegd op 2026-09-30, na een uitgewerkt interview over issue #172. De uitvoerbare specificatie staat in
[`windows-store-plan.seed.yaml`](windows-store-plan.seed.yaml) (Ouroboros-seed `seed_70f581426b5d`, versie 1.1).
Het onderzoek zelf staat in [`windows-store.md`](windows-store.md).

## Besluiten

- **Route:** MSIX via de Microsoft Store. De Store ondertekent het pakket, dus geen eigen certificaat. De
  ongesigneerde NSIS-download via GitHub blijft bestaan.
- **Gedeelde datamap buiten AppData**, op Windows en Linux: `%USERPROFILE%\BoekhoudenVoorNiks` en
  `~/BoekhoudenVoorNiks`. Niet in AppData, omdat MSIX nieuwe bestanden daar per pakket omleidt en bij
  verwijderen wist (bewaarplicht). Niet in Documents, omdat OneDrive die map kan synchroniseren en SQLite
  daar beschadigd kan raken. `userData`, en daarmee Chromiums `Local State` met de safeStorage-sleutel,
  gaat mee naar die map.
- **Migratie:** eerst hernoemen. Lukt dat niet, dan kopiëren via de SQLite backup-API naar
  `.staging-migratie`, `integrity_check` (alleen `ok` telt), bijlagepaden herschrijven, hernoemen, en als
  laatste de marker `migratie-klaar`. De bronmap wordt nooit gewist maar hernoemd naar
  `<naam>.gemigreerd-YYYYMMDD-HHmmss`.
- **Datamap bepalen:** één `resolveDataDir()` voor app en `--mcp`, in deze volgorde:
  `BOEKHOUDENVOORNIKS_DATA`, pointer (alleen bij een zelf gekozen map, in de thuismap), standaardmap met
  marker, oude AppData-map. Er ontstaat nooit stil een lege administratie.
- **Bestaande bug:** de migratie `gratis-boekhouden` → `boekhoudenvoorniks` herschreef de absolute
  bijlagepaden niet, terwijl `readAttachment` paden buiten `dataDir()/bijlagen` weigert. De rebase in PR 1
  herstelt die paden.
- **Store-build** (`process.windowsStore`): updater uit, lokale OCR standaard uit, MCP via een App
  Execution Alias in plaats van het wisselende WindowsApps-pad. Een mislukte migratie opent de oude map
  alleen-lezen (`mode=ro`, niet `immutable`).

## Opdeling

| PR | Branch | Inhoud |
|----|--------|--------|
| 1 | `feat/gedeelde-datamap-172` | Gedeelde datamap, migratie, bijlagepad-rebase, tests; eerst via NSIS uitbrengen |
| 2 | `feat/windows-store-msix-172` | appx-target met Store-identiteit, alias, windowsStore-guards, aparte CI-job met `--win appx --publish never` |
| 3 | `docs/windows-store-msix-172` (PR #173) | `windows-store.md` aanvullen met besluiten, proefprotocol, Store-listingconcept, Partner Center-gegevens |

Elke branch krijgt een eigen worktree naast de hoofd-checkout (`../gratis-boekhouden-<branch>`), niet
onder `/tmp`.

**PR 2 wordt pas gemerged na:**
1. een geslaagde upgrade van de eigenaar op echte data;
2. een geslaagde upgrade vanuit de vorige NSIS-versie op een schone Windows 11-VM;
3. minstens één externe gebruiker die een geslaagde upgrade naar de NSIS-release van PR 1 bevestigt.

## Harde blokkers in de Windows-proef

Faalt één van deze, dan stopt de Store-route:
- migratie, `integrity_check` en bijlagen openen;
- NSIS 0.7.5 direct naar MSIX;
- secrets leesbaar na de overstap van NSIS naar MSIX;
- better-sqlite3 laadt in MSIX;
- de gedeelde map blijft na verwijderen van het pakket staan.

OCR en MCP mogen in de Store-build uit, met een verwijzing naar de NSIS-download.

## Buiten scope

Indienen, certificering en publiceren gebeuren handmatig door de eigenaar na de proef. Buiten scope zijn
ook: automatische upload naar Partner Center en het aanpassen van de SmartScreen-tekst op site en README.

## Nog open (uit de laatste QA-ronde)

- Een lockbestand van een gekild migratieproces heeft nog geen regel voor veroudering. Voorstel: pid plus
  tijdstempel in het lock, en een lock van een proces dat niet meer bestaat overnemen.
- Een vastgelopen kopie heeft nog geen gedefinieerde uitkomst. Voorstel: na N seconden zonder voortgang
  staging weggooien en de bron houden, met een melding.
- Leg vast waar de externe upgradebevestiging wordt genoteerd, bijvoorbeeld in het proefverslag in
  `windows-store.md`.
