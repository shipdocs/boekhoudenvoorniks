# Golden-vectoren voor de gedeelde rekenkern

`vectors.json` bevat karakteriseringstests voor de gedeelde kern (`@gratis-boekhouden/kern`):
vaste invoer en de verwachte uitvoer in centen. Desktop en (later) de Android-app moeten
dezelfde vectoren halen, zodat een afwijking van één cent een falende test is en geen
ontdekking achteraf.

## Wat de vectoren zijn

- **Karakterisering:** de verwachte uitvoer is door de bestaande code (`computeTotals`)
  berekend en niet met de hand nagekomen. Het bestand legt het huidige gedrag vast; het
  verandert niets aan de berekening. Staat er iets in dat fiscaal niet klopt, dan hoort dat
  in een nieuw bestand `OPMERKINGEN.md` naast dit bestand en niet in een stille wijziging van de code.
- **Puur data:** JSON, geen code en geen Node-API's. Elke app kan het bestand inlezen.
- **Bedragen in centen** als gehele getallen. `quantity` mag een decimaal aantal zijn.

## Velden

Bovenin het bestand: `versie`, `soort`, `gegenereerdUit` (pakketversie, commit, datum,
methode), `uitleg` en `categorieen`. Daarna de lijst `vectors`; elke vector heeft:

| Veld | Betekenis |
|---|---|
| `id` | vaste naam, bijvoorbeeld `afronding-half-product-1505` |
| `categorie` | afronding, meerdere tarieven, KOR, verlegd, icp, export, creditnota, korting, nul-tarief, dienst-buiten-eu, grote-bedragen, kleine-bedragen |
| `omschrijving`, `toelichting` | wat de vector toetst en hoe het getal tot stand komt |
| `invoer.lines` | de regels zoals `computeTotals` ze krijgt (`description`, `quantity`, `unit`, `unitPrice` in centen, `vatCode`) |
| `verwacht` | `lines` (regelnetto in invoervolgorde), `groups` (per btw-groep: `vatCode`, `percentage`, `label`, `net`, `vat`; percentage aflopend, dan `vatCode`), `subtotal`, `vatTotal`, `total` |

## Draaien op de desktop

```bash
npm run test:golden
```

Het script bouwt de kern en print `GOLDEN_OK <aantal>`. Bij een verschil print het
`GOLDEN_FAIL` met de vector-id, het verwachte en het werkelijke resultaat, en eindigt het
met exitcode 1.

## Draaien in de Android-app

1. Neem `packages/core` als gedeeld pakket over (dezelfde code, niet herschreven).
2. Lees `vectors.json` in (als test-asset).
3. Roep voor elke vector `computeTotals(vector.invoer.lines)` aan uit de kern.
4. Vergelijk het volledige resultaat met `vector.verwacht`: dezelfde sleutels, dezelfde
   gehele getallen in centen, geen afronding in de test zelf.
5. De build is groen als alle vectoren gelijk zijn en het aantal gelijk is aan dat op de
   desktop (`GOLDEN_OK <aantal>`).

Pas de vectoren niet aan om een test groen te krijgen. Verandert de kern met opzet (nieuwe
btw-regel), regenereer dan het bestand in de desktop-repo, leg het verschil vast in de
commitmelding en neem het nieuwe bestand in beide repo's over.
