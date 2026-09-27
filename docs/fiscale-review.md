# Fiscale review en code-audit

**Peildatum:** 27 september 2026  
**Codebasis:** `main` @ `9970c629b96ae17a3f67d28d2ff4ae31d1a709ee`  
**Scope:** Nederlandse zzp'ers en kleine IB-ondernemers.

Deze review beschrijft wat de code werkelijk doet en toetst dat aan actuele primaire bronnen. Geen ontbrekende feiten zijn als aanname ingevuld.

Legenda: **✅ akkoord**, **⚠️ conditioneel**, **❌ correctie vereist**, **ℹ️ buiten scope**.

## 1. Eindoordeel

De dubbele boekhouding, centenadministratie, onveranderlijke journaalregels, tegenboekingen en standaard-btw-rubrieken zijn degelijk. De app is nog niet fiscaal volledig correct.

| Prio | Bevinding |
|---|---|
| P0 | **KOR:** inkopen kunnen 21%/9% als aftrekbare voorbelasting boeken. Onder KOR mag btw op kosten/investeringen niet worden afgetrokken. |
| P0 | **Buiten-EU diensten:** `export` zet omzet generiek in 3a. Een B2B-dienst die buiten de EU belast is hoort doorgaans niet in de Nederlandse btw-aangifte. |
| P0 | **IB tariefbeperking ontbreekt:** zelfstandigenaftrek en mkb-winstvrijstelling mogen bij hoog inkomen maximaal 37,48% (2025) / 37,56% (2026) voordeel geven. |
| P1 | **Startersaftrek/lage winst:** de winstbeperking van zelfstandigenaftrek geldt niet bij recht op startersaftrek; code kapt wel af. Niet-gerealiseerde zelfstandigenaftrek (9 jaar) ontbreekt. |
| P1 | **Desinvestering:** code €2.500; correct €2.800 (2025) en €2.900 (2026). |
| P1 | **Representatie 2025:** code €5.600; correct €5.700. |
| P1 | **Zvw 2025:** code max €75.860; actuele Belastingdiensttabel €75.864. |
| P1 | **ICP:** goederen/diensten zijn één code; ICP-correctie wordt te sterk gekoppeld aan btw-suppletie. |
| P1 | **Auto-btw:** 2,7%/1,5%-forfait wordt te automatisch toegepast. |
| P1 | **OSS:** €10.000-waarschuwing is te breed zonder prestatietype. |
| P1 | **Werkruimte thuis:** producttekst is te stellig over aftrek van inrichting. |

## 2. Boekhoudkundige kern — ✅

`src/core-ledger/ledger.ts`, `rules.ts`, `events.ts` en database-triggers vormen een echte dubbele boekhouding. Bedragen staan in centen, posten moeten in balans zijn en correcties lopen via tegenboekingen. Interne rekeningcodes en officiële RGS-referenties zijn gescheiden en getest.

## 3. Omzetbelasting

### Binnenland

`hoog` → 21%/1a, `laag` → 9%/1b en `nul` → 0%/1e zijn technisch goed. `verlegd` → 1e is juist **mits** een wettelijke verleggingsgrond bestaat. Een btw-nummer alleen is niet voldoende.

### KOR — ❌

De verkoopflow houdt rekening met `kor=true`, maar de aankoopmotor kan nog `hoog`/`laag` accepteren en via `expenseLines()` voorbelasting boeken.

Vereist:
- onder KOR Nederlandse factuur-btw niet op `btwVoorbelasting`;
- niet-aftrekbare btw in kosten/kostprijs;
- verlegde/buitenlandse btw apart behandelen: incidentele aangifte kan nodig zijn;
- echte vrijstelling en KOR semantisch scheiden;
- overgang naar/uit KOR kan herziening van eerdere btw-aftrek veroorzaken.

### Verlegde inkoop 2a/4a/4b — ✅/⚠️

De boeking kosten/actief + voorbelasting tegenover verlegde btw + bank/crediteur is passend voor volledig aftrekgerechtigde ondernemers. 5b is alleen aftrekbaar voor zover recht op aftrek bestaat.

Leveranciersgeheugen (Stripe, Meta, Google enz.) mag alleen voorstellen. Factuur, contracterende entiteit, land en reverse-chargevermelding gaan voor.

### ICP — ⚠️/❌

Rubriek 3b is op hoofdlijn goed. De app moet echter goederen en diensten onderscheiden. De huidige tekst “art. 138 / art. 196” is te generiek en de ICP-CSV bevat geen prestatietype.

De recente code koppelt ICP-correcties bovendien aan de btw-suppletieroute. Dat zijn afzonderlijke processen. Bewaar aparte btw-correctiestatus en ICP-correctiestatus.

### Buiten EU — ❌

`export`/3a is geschikt voor goederenuitvoer als aan de voorwaarden is voldaan. Een B2B-dienst die volgens de plaats-van-dienstregels buiten de EU belast is, hoeft volgens de Belastingdienst niet in de Nederlandse btw-aangifte.

Minimaal toevoegen: `buiten-eu-goederen` en `buiten-eu-dienst`.

### OSS — ❌ waarschuwing verfijnen

De €10.000-regel geldt niet generiek voor iedere B2C-dienst. Zonder prestatietype alleen waarschuwen dat plaats van heffing en OSS moeten worden gecontroleerd.

### Suppletie en afronding — ✅/⚠️

De €1.000-hoofdregel is passend: tot en met €1.000 kan in de eerstvolgende aangifte, daarboven afzonderlijke suppletie. Houd ook rekening met tijdige correctie.

De recente afrondingsfix voor 5a/5b/5c/5g is rekenkundig goed.

## 4. Inkomstenbelasting

De uitkomst moet een **reserveringsschatting** blijven. Partner, ander inkomen, eigen woning, box 2/3, persoonsgebonden aftrek, andere ondernemingen en voorlopige aanslagen ontbreken.

| Onderdeel | 2025 | 2026 | Audit |
|---|---:|---:|---|
| Box 1 schijf 1 | €38.441 / 35,82% | €38.883 / 35,75% | ✅ |
| Box 1 schijf 2 | €76.817 / 37,48% | €78.426 / 37,56% | ✅ |
| Schijf 3 | 49,50% | 49,50% | ✅ |
| Zelfstandigenaftrek | €2.470 | €1.200 | ✅ |
| Mkb-winstvrijstelling | 12,7% | 12,7% | ✅ |
| Startersaftrek | €2.123 | €2.123 | ✅ |
| Privévervoermiddel | €0,23/km | €0,25/km | ✅ |
| Urencriterium | 1.225 | 1.225 | ✅ |
| Representatiedrempel | **€5.700** | €5.700 | ❌ 2025 |
| Desinvesteringsdrempel | **€2.800** | **€2.900** | ❌ |
| Zvw max. inkomen | **€75.864** | €79.409 | ❌ 2025 |

De 2026 algemene heffingskorting en arbeidskorting in de code sluiten aan op de officiële tabellen. Zvw 2026 4,85% klopt.

### Zelfstandigenaftrek/startersaftrek — ❌

De code begrenst zelfstandigenaftrek op de winst en startersaftrek daarna op het restant. De Belastingdienst vermeldt dat deze winstbeperking niet geldt als recht bestaat op startersaftrek. Niet-gerealiseerde zelfstandigenaftrek kan 9 jaar worden verrekend.

`isStarter()` leidt historisch gebruik deels af uit startjaar/teller. Laat historische toepassing per relevant jaar bevestigen/importeren.

### Tariefbeperking — ❌ P0

Bij inkomen in de hoogste schijf moet het voordeel van onder meer zelfstandigenaftrek en mkb-winstvrijstelling worden beperkt tot 37,48%/37,56%. De huidige formule doet dit niet en kan de reservering te laag maken.

### Verlies — ❌

Mkb-winstvrijstelling verkleint ook een fiscaal verlies. `estimateIncomeTax()` retourneert bij `fiscal <= 0` direct nullen. Splits “belasting te reserveren” van “fiscale winst/verlies”.

## 5. Bedrijfsmiddelen/KIA

De €450-KIA-grens en KIA-staffels 2025/2026 zijn correct. €450 excl. btw is alleen universeel bruikbaar als btw aftrekbaar is; onder KOR hoort niet-aftrekbare btw bij de kostprijs.

Minimaal 60 maanden sluit aan bij maximaal 20% afschrijving per jaar voor gewone bedrijfsmiddelen. De code start echter op aankoopdatum; fiscaal is **ingebruikname** relevant. Voeg `in_use_on` toe.

Restwaarde €0 mag alleen een aanpasbare default zijn.

Desinvestering: wijzig drempel naar €2.800 (2025) en €2.900 (2026). De berekening moet aansluiten op de investeringsaftrek die werkelijk eerder is toegepast, niet uitsluitend op een reconstructie uit het huidige assetregister.

## 6. Auto

Privévervoermiddel voor IB: €0,23/km (2025), €0,25/km (2026) is correct. Brandstof, verzekering, tol en parkeren mogen dan voor IB niet daarnaast als autokosten worden afgetrokken.

Voor btw kan bij een privéauto wel aftrek naar rato van zakelijk gebruik mogelijk zijn. De huidige conservatieve aanpak kan dus rechtmatige voorbelasting missen.

Voor een auto van de zaak is 2,7%/1,5% geen universele automatische berekening. Werkelijk privégebruik, vrijgestelde omzet, eigen bijdrage en de periode sinds ingebruikname kunnen de uitkomst wijzigen. IB-bijtelling blijft terecht buiten scope.

## 7. Overige posten

**Representatie:** de methode “80% aftrek of drempel, wat gunstiger is” is bruikbaar voor IB-ondernemers; zet 2025 op €5.700. Btw kent aparte regels.

**Telefoon/internet:** een zakelijk percentage kan als gebruikersinschatting werken. Beter is privégebruik en werkelijk niet-aftrekbare btw bij de oorspronkelijke boeking te splitsen dan later circa 21% te reconstrueren.

**Werkruimte thuis:** Belastingdienst: meestal 0% aftrek, met uitzonderingen. Vervang “bureau, stoel en kast mag je altijd aftrekken” door een feitelijke werkruimtetoets. Losse apparatuur kan afzonderlijk zakelijk worden beoordeeld.

**Meewerkaftrek:** staffel 1,25% / 2% / 3% / 4% bij 525 / 875 / 1.225 / 1.750 uur is correct; overige voorwaarden en partnervergoeding moeten expliciet worden bevestigd.

**AOV/lijfrente/pensioen:** gebruik “kan aftrekbaar zijn”, niet generiek “mag je aftrekken”.

**EIA/MIA/Vamil:** alleen signaleren is juist; geen recht claimen zonder actuele RVO-lijst en voorwaarden.

## 8. Regels toekomstige jaren

`rulesFor()` mag een eerdere tabel alleen als expliciete prognose/fallback gebruiken. Zet een jaar pas `checked: true` wanneer alle bedragen én formules van dat jaar tegen actuele primaire bronnen zijn geverifieerd. Door bovenstaande P0/P1-punten mogen 2025/2026 nog niet als volledig gecontroleerd worden gemarkeerd.

## 9. Vereiste regressietests

1. KOR + 21%-inkoop: geen voorbelasting; btw in kosten/kostprijs.
2. KOR + verlegde buitenlandse dienst: incidentele aangifte zonder automatische 5b-aftrek.
3. Buiten-EU goederen versus B2B-dienst: alleen goederenroute naar 3a.
4. IB boven hoogste schijf: tariefbeperking 37,48%/37,56%.
5. Starter met lage winst: startersuitzondering en verlies correct.
6. Niet-gerealiseerde zelfstandigenaftrek over jaren.
7. Desinvestering rond €2.800/€2.900.
8. Representatie 2025 rond €5.700.
9. Zvw 2025 max €75.864.
10. ICP goederen/diensten apart en correctie onafhankelijk van suppletie.
11. Auto-btw: 2,7%, 1,5%, vrijgestelde omzet/eigen bijdrage.
12. Afschrijving met latere ingebruiknamedatum.
13. KOR-investering: kostprijs inclusief niet-aftrekbare btw.

## 10. Primaire bronnen

Voor deze audit zijn actuele pagina's van de **Belastingdienst** gebruikt over KOR, buitenlandse diensten, ICP, privégebruik auto, zelfstandigenaftrek, mkb-winstvrijstelling, tariefsaanpassing aftrekposten, heffingskortingen, Zvw, KIA/desinvesteringsbijtelling, beperkt aftrekbare kosten en werkruimte thuis. Voor EIA/MIA/Vamil moet steeds de actuele **RVO**-lijst worden gebruikt.

## 11. Status

De architectuur is geschikt om fiscale regels betrouwbaar uit te voeren. De resterende risico's zitten hoofdzakelijk in fiscale beslislogica, uitzonderingen en ontbrekende feiten. Los eerst de P0/P1-punten op en laat daarna de regressiesuite opnieuw draaien voordat `checked: true` of een claim “fiscaal correct” wordt gebruikt.
