# Pakket voor de boekhouder

De belofte: **de ondernemer boekt eenvoudig in BoekhoudenVoorNiks, de boekhouder ontvangt gegevens die in zijn bestaande werkwijze passen.** We vragen boekhouders niet om in nog een pakket te werken.

Code: `src/export/accountant-package.ts` (inhoud en controles), `src/shared/zip.ts`, knop in
`src/renderer/screens/AccountantPackage.tsx` (op *Hoe gaat het?* en *Boekhouding > Exports*).
Tests: `tests/boekhouder-pakket.test.ts`, `e2e/boekhouder-pakket.spec.ts`.
Voorbeeld voor de site: `npm run voorbeeldpakket` → `site/voorbeeld/voorbeeldpakket-boekhouder-2025.zip`.

## Drie behoeften

| Wat de boekhouder wil | Wat we leveren | Waarom |
|---|---|---|
| Jaarrekening samenstellen of de boekhouding controleren | XAF 3.2 per boekjaar | Caseware, AFAS (verslaglegging) en Visionplanner lezen XAF in voor rapportage of controle. Caseware Cloud documenteert 3.1 en 3.2. |
| Snel cijfers beoordelen | Kolommenbalans, grootboekkaarten, RGS-brugstaat als CSV | Een saldibalans kan direct in bijvoorbeeld AFAS-verslaglegging; Moneybird levert deze naast de auditfile. |
| De administratie naar een ander pakket verhuizen | Relaties, journaalposten, openstaande posten per factuur als CSV, plus XAF | SnelStart importeert klanten, leveranciers, grootboek en boekingen apart; Yuki neemt historie via XAF of CSV en openstaande posten apart. |

Een XAF is **geen herstelbare back-up**: AFAS leest hem bijvoorbeeld in als financieel project voor verslaglegging. Het pakket heet daarom *overdracht* en de lees-mij zegt dat. Voor herstel is er de volledige back-up in de app (Instellingen).

## Inhoud van de ZIP

| Bestand | Inhoud |
|---|---|
| `LEES-MIJ.pdf`, `lees-mij.txt` | Periode, bedrijf, aantallen, beginbalans/mutaties/eindbalans, resultaat, btw per aangifteperiode, openstaande posten, controles, ontbrekende RGS-codes en documenten, importroute per pakket. Zonder PDF-motor: `LEES-MIJ.html`. |
| `auditfile-JJJJ-xaf32.xaf` | Zelfde als de losse export: grootboek met RGS (`leadReference` en `taxonomy`), relaties, `openingBalance`, transacties per dagboek. |
| `rapporten-JJJJ.xlsx` | Dezelfde tabellen als de CSV's in één werkmap (`src/shared/xlsx.ts`): bedragen als getal (#,##0.00), datums als datum, kopregel vast, autofilter. |
| `kolommenbalans.csv` | Beginbalans, mutaties debet/credit, eindsaldo, balans en W&V gesplitst, totaalregel en resultaatregel. |
| `grootboekkaarten.csv` | Per rekening een regel *Beginsaldo* en daarna elke boeking met oplopend saldo en documentpad. |
| `journaalposten.csv` | Elke boekingsregel; *Boekstuk* = transactienummer in de XAF. |
| `openstaande-debiteuren.csv`, `openstaande-crediteuren.csv` | Per factuur op 31 december, uit het grootboek (gegroepeerd op relatie + bron), niet uit de factuurstatus. |
| `rgs-brugstaat.csv` | Alle niet-gearchiveerde rekeningen, RGS-code, officiële omschrijving, versie, gebruikt ja/nee, status *gekoppeld / ontbreekt / onbekende code*. |
| `btw-overzicht.csv` | Per aangifteperiode (instelling maand/kwartaal/jaar). |
| `relaties.csv` | Relatiecode = `custSupID` in de XAF. |
| `importprofielen/` | SnelStart (`snelstart/boekingen.xlsx`, `klanten.xlsx`, `leveranciers.xlsx`), Yuki (`yuki/historische-mutaties.csv`, `openstaande-posten.csv`), AFAS (`afas/saldibalans.csv`) en `LEES-MIJ.txt` per pakket. Tests controleren dat elk profiel aansluit op de kolommenbalans. |
| `documenten/` | `verkoopfacturen/` (PDF uit het sjabloon), `inkoop/` en `bonnen/` (originele bestanden), `index.csv` met boekstuk en wat ontbreekt. |

Formaat CSV: `;`, decimaalkomma, geen duizendtallen, UTF-8 met BOM, datums `JJJJ-MM-DD`, debet positief.

### Waarom alles aansluit

Alle bestanden gebruiken dezelfde selectie als `AccountantExport.auditfile`: een beginbalansboeking
(`source = 'opening'`) op 1 januari telt als beginbalans, alle andere boekingen van het jaar als
mutaties. De beginbalans komt uit `openingBalance()`: balansrekeningen plus het resultaat van eerdere
jaren in het eigen vermogen. Daardoor tellen beginbalans en eindsaldi op tot nul. Let op: de
kolommenbalans in het scherm (`LedgerReports.trialBalance`) laat het resultaat van eerdere jaren
níet naar het eigen vermogen lopen; het pakket wel, zoals een boekhouder dat verwacht.

De test leest de XAF uit de ZIP terug en controleert per rekening dat beginbalans + mutaties
gelijk is aan het eindsaldo in `kolommenbalans.csv`.

## Wat de ontvangende pakketten inlezen (onderzoek 29-09-2026)

Uit de officiële importdocumentatie. *Snippet* = alleen uit een zoekresultaat, de pagina zelf was niet te lezen.

| Pakket | Auditfile | Vaste importformaten | Wij leveren | Bron |
|---|---|---|---|---|
| Caseware (Cloud) | XAF 3.1 en 3.2 (snippet); RGS-versie kiezen bij inlezen | saldibalans via wizard (kolommen niet gevonden) | XAF 3.2 | support.caseware.nl (403) |
| AFAS verslaglegging | "auditbestand van versie 3" als financieel project | saldibalans: rekening; cum. debet en credit zonder beginbalans; saldo met beginbalans (eigen importdefinitie) | XAF 3.2, `importprofielen/afas/saldibalans.csv` | help.afas.nl Fin_YrEnd_NtCnsl_FnRprt, Fin_AuditF |
| Visionplanner (Nmbrs Reporting) | adviseert XML V3.1; saldi + transacties | — | XAF 3.2 (3.1 als terugvaloptie als 3.2 niet lukt) | support.reporting.nmbrs.com/auditfile-xaf |
| Twinfield | conversietool, XAF 2.0 en hoger (snippet); beginbalans in periode 0; debiteur- en crediteurcodes mogen niet overlappen | Excel/CSV-sjablonen (kolommen niet gevonden) | XAF 3.2, openstaande posten los | Wolters Kluwer community, conversie-PDF 2011 |
| Exact Online | **leest geen auditfile** (snippet) | CSV/Excel alleen met eigen importdefinitie; XML (`GLTransactions`) heeft een vast schema, nog niet uitgezocht | `journaalposten.csv`, `relaties.csv` | support.exactonline.com (JS-only) |
| Yuki (Nmbrs Accounting) | XAF 3.0 en hoger: grootboek, relaties, beginbalans, mutaties | historische mutaties (8 kolommen), openstaande posten (10 kolommen), memoriaal | XAF 3.2, `importprofielen/yuki/*.csv` | support.yuki.nl 80000787909, 80000787307 |
| SnelStart 12 | **leest geen auditfile** | Excel/CSV met `Fld…`-koppen voor boekingen, klanten, leveranciers, grootboek; geen import voor beginbalans of openstaande posten | `importprofielen/snelstart/*.xlsx`, beginbalans als memoriaalboeking | kennisplein.snelstart.nl (importeren-boekingen, -klanten, -grootboekrekeningen) |

Niet geverifieerd en daarom als aanname in de code en de lees-mij:
- **SnelStart:** het nummer van het memoriaaldagboek verschilt per administratie. We zetten 90 en vragen in de lees-mij om dat aan te passen. Grootboekrekeningen importeren we niet, omdat `FldGrootboekfunctieID` verplicht is en de waarden niet openbaar staan.
- **SnelStart:** van de import voor leveranciers namen we dezelfde velden aan als voor klanten.
- **Yuki:** of de historische CSV een kopregel mag hebben staat nergens, dus we leveren hem zonder. Ook het teken van crediteuren in openstaande posten is niet gedocumenteerd; we zetten ze negatief.
- **AFAS:** hoe AFAS een `openingBalance` in een binnenkomende XAF verwerkt. De bekende opmerking "beginbalans gaat niet mee" gaat over de export van AFAS zelf.
- **Visionplanner en Caseware:** of XAF 3.2 bij Visionplanner werkt, en of Caseware 4.0 weigert.

## Proefimport: de echte test

Een technisch geldig bestand is niet genoeg. Per ontvangend pakket doen we met een boekhouder een
proefimport in zijn eigen dossier (voorbeeldpakket of een echte klant, met toestemming) en controleren:

1. **Beginbalans**: overgenomen? Gelijk aan kolom *Beginbalans*? (AFAS: gaat niet bij elke route vanzelf mee.)
2. **Mutaties**: totaal debet/credit gelijk aan de lees-mij.
3. **Eindsaldi** per rekening gelijk aan *Eindsaldo*.
4. **RGS**: rekeningen automatisch op de juiste plek in de jaarrekening/rapportage?
5. **Btw**: rubrieken en totalen per periode gelijk aan `btw-overzicht.csv`.
6. **Openstaande posten**: per factuur en totaal gelijk.
7. **Documenten**: kan de boekhouder via boekstuk/index het document vinden?
8. **Tekens en codering**: accenten (Café), negatieve bedragen, lange omschrijvingen.

| Pakket | Route | Getest met | Datum | Uitkomst | Afwijkingen |
|---|---|---|---|---|---|
| Caseware (Cloud) | XAF 3.2 | — | — | nog niet getest | |
| AFAS verslaglegging | XAF als financieel project / saldibalans | — | — | nog niet getest | beginbalans controleren |
| Visionplanner | XAF | — | — | nog niet getest | |
| Twinfield | XAF-conversie | — | — | nog niet getest | uitkomst conversie apart controleren |
| Exact Online | CSV relaties + boekingen | — | — | nog niet getest | kolomindeling mogelijk aanpassen |
| Yuki | XAF of CSV + openstaande posten | — | — | nog niet getest | |
| SnelStart | CSV relaties, grootboek, boekingen | — | — | nog niet getest | kolomindeling mogelijk aanpassen |

Uitkomsten komen binnen via GitHub-issues (knop op `site/boekhouders.html`) of e-mail. Vul deze tabel bij.

## Volgende stappen

1. **Proefimports** met de eerste boekhouders; afwijkingen per route in de lees-mij en de tabel hierboven.
2. **Importprofielen bijstellen** op basis van die proefimports; eerste versie voor SnelStart, Yuki en AFAS
   staat erin. Exact Online: de XML-import (`GLTransactions`) uitzoeken voor een route zonder importdefinitie.
   Twinfield: de Excel-sjablonen, zodra we ze kunnen lezen.
3. **XAF 4.0** als extra keuze, zodra ontvangende pakketten die aantoonbaar inlezen; 3.2 blijft standaard.
4. Boekjaar ≠ kalenderjaar ondersteunen als een klant daarom vraagt (nu altijd 1 januari – 31 december).
