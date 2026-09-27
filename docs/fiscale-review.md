# Fiscale review en code-audit

**Peildatum:** 27 september 2026  
**Codebasis:** `main` @ `9970c629b96ae17a3f67d28d2ff4ae31d1a709ee`  
**Scope:** Nederlandse zzp'ers en kleine IB-ondernemers.

Deze review beschrijft wat de code werkelijk doet en toetst dat aan actuele primaire bronnen. Ontbrekende feiten zijn niet als aannames ingevuld.

Legenda: **OK** = akkoord binnen scope, **LET OP** = conditioneel/beperkt, **FOUT** = correctie vereist.

## 1. Eindoordeel

De dubbele boekhouding, centenadministratie, onveranderlijke journaalregels, tegenboekingen en standaard-btw-rubrieken zijn degelijk. De app is nog niet fiscaal volledig correct.

### Blokkers

1. **P0 KOR:** inkopen kunnen 21%/9% als aftrekbare voorbelasting boeken. Onder KOR mag btw op kosten/investeringen niet worden afgetrokken.
2. **P0 Buiten-EU diensten:** `export` zet omzet generiek in 3a. Een B2B-dienst die buiten de EU belast is hoort doorgaans niet in de Nederlandse btw-aangifte.
3. **P0 IB tariefbeperking:** zelfstandigenaftrek en mkb-winstvrijstelling mogen bij hoog inkomen maximaal 37,48% (2025) / 37,56% (2026) voordeel geven; de huidige formule beperkt dit niet.
4. **P1 Startersaftrek/lage winst:** de winstbeperking van zelfstandigenaftrek geldt niet bij recht op startersaftrek; code kapt wel af. Niet-gerealiseerde zelfstandigenaftrek (9 jaar) ontbreekt.
5. **P1 Desinvestering:** code gebruikt €2.500. De actuele 2026-regel gebruikt €2.900. De historische 2025-waarde moet uit de 2025-jaarinformatie worden vastgezet en niet uit een generieke actuele pagina worden afgeleid.
6. **P1 Representatie 2025:** code €5.600; opnieuw tegen de officiële 2025-jaartabel vastzetten vóór `checked=true`.
7. **P1 ICP:** goederen/diensten zijn één code en ICP-correctie wordt te sterk gekoppeld aan btw-suppletie.
8. **P1 Auto-btw:** 2,7%/1,5%-forfait wordt te automatisch toegepast.
9. **P1 OSS:** €10.000-waarschuwing is te breed zonder prestatietype.
10. **P1 Werkruimte thuis:** producttekst is te stellig over aftrek van inrichting.

## 2. Boekhoudkundige kern — OK

`src/core-ledger/ledger.ts`, `rules.ts`, `events.ts` en database-triggers vormen een echte dubbele boekhouding. Bedragen staan in centen, posten moeten in balans zijn en correcties lopen via tegenboekingen. Interne rekeningcodes en officiële RGS-referenties zijn gescheiden en getest.

## 3. Omzetbelasting

### Binnenland

`hoog` → 21%/1a, `laag` → 9%/1b en `nul` → 0%/1e zijn technisch goed. `verlegd` → 1e is juist **mits** een wettelijke verleggingsgrond bestaat. Een btw-nummer alleen is niet voldoende.

### KOR — FOUT

De verkoopflow houdt rekening met `kor=true`, maar de aankoopmotor kan nog `hoog`/`laag` accepteren en via `expenseLines()` voorbelasting boeken.

Vereist:
- onder KOR Nederlandse factuur-btw niet op `btwVoorbelasting`;
- niet-aftrekbare btw in kosten/kostprijs;
- verlegde/buitenlandse btw apart behandelen: incidentele aangifte kan nodig zijn;
- echte vrijstelling en KOR semantisch scheiden;
- overgang naar/uit KOR kan herziening van eerdere btw-aftrek veroorzaken.

### Verlegde inkoop 2a/4a/4b — OK / LET OP

De boeking kosten/actief + voorbelasting tegenover verlegde btw + bank/crediteur is passend voor volledig aftrekgerechtigde ondernemers. 5b is alleen aftrekbaar voor zover recht op aftrek bestaat.

Leveranciersgeheugen (Stripe, Meta, Google enz.) mag alleen voorstellen. Factuur, contracterende entiteit, land en reverse-chargevermelding gaan voor.

### ICP — LET OP / FOUT

Rubriek 3b is op hoofdlijn goed. De app moet goederen en diensten onderscheiden. De huidige tekst “art. 138 / art. 196” is te generiek en de ICP-CSV bevat geen prestatietype.

De recente code koppelt ICP-correcties bovendien aan de btw-suppletieroute. Dat zijn afzonderlijke processen. Bewaar aparte btw-correctiestatus en ICP-correctiestatus.

### Buiten EU — FOUT

`export`/3a is geschikt voor goederenuitvoer als aan de voorwaarden is voldaan. Een B2B-dienst die volgens de plaats-van-dienstregels buiten de EU belast is, hoeft volgens de Belastingdienst niet in de Nederlandse btw-aangifte.

Minimaal toevoegen: `buiten-eu-goederen` en `buiten-eu-dienst`.

### OSS — FOUT/te breed

De €10.000-regel geldt niet generiek voor iedere B2C-dienst. Zonder prestatietype alleen waarschuwen dat plaats van heffing en OSS moeten worden gecontroleerd.

### Suppletie en afronding — OK / LET OP

De €1.000-hoofdregel is passend: tot en met €1.000 kan in de eerstvolgende aangifte, daarboven afzonderlijke suppletie. Houd ook rekening met tijdige correctie.

De recente afrondingsfix voor 5a/5b/5c/5g is rekenkundig goed.

## 4. Inkomstenbelasting

De uitkomst moet een **reserveringsschatting** blijven. Partner, ander inkomen, eigen woning, box 2/3, persoonsgebonden aftrek, andere ondernemingen en voorlopige aanslagen ontbreken.

### Parameters die in de code staan

- Box 1 2025: €38.441 / 35,82%; €76.817 / 37,48%; daarna 49,50%.
- Box 1 2026: €38.883 / 35,75%; €78.426 / 37,56%; daarna 49,50%.
- Zelfstandigenaftrek: €2.470 (2025), €1.200 (2026).
- Mkb-winstvrijstelling: 12,7%.
- Startersaftrek: €2.123.
- Privévervoermiddel: €0,23/km (2025), €0,25/km (2026).
- Urencriterium: 1.225 uur.

Deze kernwaarden sluiten aan op de gebruikte jaarinformatie. Zet een volledige jaartabel pas `checked=true` wanneer ook alle kortingen, Zvw, drempels en formules gezamenlijk tegen de officiële jaartabel zijn geverifieerd.

### Zelfstandigenaftrek/startersaftrek — FOUT

De code begrenst zelfstandigenaftrek op de winst en startersaftrek daarna op het restant. De Belastingdienst vermeldt dat deze winstbeperking niet geldt als recht bestaat op startersaftrek. Niet-gerealiseerde zelfstandigenaftrek kan 9 jaar worden verrekend.

`isStarter()` leidt historisch gebruik deels af uit startjaar/teller. Laat historische toepassing per relevant jaar bevestigen/importeren.

### Tariefbeperking — FOUT/P0

Bij inkomen in de hoogste schijf moet het voordeel van onder meer zelfstandigenaftrek en mkb-winstvrijstelling worden beperkt. De huidige formule doet dit niet en kan de reservering te laag maken.

### Verlies — FOUT

Mkb-winstvrijstelling beïnvloedt ook een fiscaal verlies. `estimateIncomeTax()` retourneert bij `fiscal <= 0` direct nullen. Splits daarom “belasting te reserveren” van “fiscale winst/verlies”.

## 5. Bedrijfsmiddelen/KIA

De €450-KIA-grens en KIA-staffels 2025/2026 in de code sluiten aan op de officiële KIA-tabellen. €450 excl. btw is alleen universeel bruikbaar als btw aftrekbaar is; onder KOR hoort niet-aftrekbare btw bij de kostprijs.

Minimaal 60 maanden sluit aan bij maximaal 20% afschrijving per jaar voor gewone bedrijfsmiddelen. De code start echter op aankoopdatum; fiscaal is **ingebruikname** relevant. Voeg `in_use_on` toe.

Restwaarde €0 mag alleen een aanpasbare default zijn.

### Desinvestering

Voor 2026 geldt: geen desinvesteringsbijtelling bij vervreemdingen van gezamenlijk €2.900 of minder. Gebruik voor de bijtelling hetzelfde percentage als bij de eerdere investeringsaftrek en nooit meer dan de eerder gekregen aftrek.

De code gebruikt €2.500 en reconstrueert het historische percentage uit het huidige assetregister. Sla liever de werkelijk toegepaste KIA per investeringsjaar op.

Let ook op fictieve vervreemdingen: onder meer overbrengen naar privé, bepaalde verhuurbestemming en niet tijdig in gebruik nemen kunnen relevant zijn.

## 6. Auto

Privévervoermiddel voor IB: €0,23/km (2025), €0,25/km (2026) is correct. Brandstof, verzekering, tol en parkeren mogen dan voor IB niet daarnaast als autokosten worden afgetrokken.

Voor btw kan bij een privéauto wel aftrek naar rato van zakelijk gebruik mogelijk zijn. De huidige conservatieve aanpak kan dus rechtmatige voorbelasting missen.

Voor een auto van de zaak is 2,7%/1,5% geen universele automatische berekening. Werkelijk privégebruik, aftrekrecht, eigen bijdrage en historie van de auto kunnen de uitkomst wijzigen. IB-bijtelling blijft terecht buiten scope.

## 7. Overige posten

**Representatie:** de methode “80% aftrek of drempel, wat gunstiger is” is bruikbaar voor IB-ondernemers, maar de jaarbedragen moeten per jaar uit de officiële tabel komen. Btw op horeca/relatiegeschenken kent aparte regels.

**Telefoon/internet:** een zakelijk percentage kan als gebruikersinschatting werken. Beter is privégebruik en werkelijk niet-aftrekbare btw bij de oorspronkelijke boeking te splitsen dan later circa 21% te reconstrueren.

**Werkruimte thuis:** vervang “bureau, stoel en kast mag je altijd aftrekken” door een feitelijke werkruimtetoets. Losse apparatuur kan afzonderlijk zakelijk worden beoordeeld.

**Meewerkaftrek:** de staffel in de code is passend; overige voorwaarden en partnervergoeding moeten expliciet worden bevestigd.

**AOV/lijfrente/pensioen:** gebruik “kan aftrekbaar zijn”, niet generiek “mag je aftrekken”.

**EIA/MIA/Vamil:** alleen signaleren is juist; geen recht claimen zonder actuele RVO-lijst en voorwaarden.

## 8. Toekomstige jaren

`rulesFor()` mag een eerdere tabel alleen als expliciete prognose/fallback gebruiken. Zet een jaar pas `checked=true` wanneer alle bedragen én formules van dat jaar tegen actuele primaire bronnen zijn geverifieerd.

## 9. Vereiste regressietests

1. KOR + 21%-inkoop: geen voorbelasting; btw in kosten/kostprijs.
2. KOR + verlegde buitenlandse dienst: correcte incidentele btw-route zonder automatische volledige 5b-aftrek.
3. Buiten-EU goederen versus B2B-dienst: alleen goederenroute naar 3a.
4. IB boven hoogste schijf: tariefbeperking.
5. Starter met lage winst: startersuitzondering en verlies correct.
6. Niet-gerealiseerde zelfstandigenaftrek over jaren.
7. Desinvestering rond de jaardrempel.
8. Representatie rond de officiële jaardrempel.
9. Alle Zvw-jaarparameters tegen officiële jaartabel.
10. ICP goederen/diensten apart en correctie onafhankelijk van btw-suppletie.
11. Auto-btw met uitzonderingen.
12. Afschrijving met latere ingebruiknamedatum.
13. KOR-investering: kostprijs inclusief niet-aftrekbare btw.

## 10. Primaire bronnen

Gebruik bij wijzigingen steeds de actuele primaire bronnen:
- Belastingdienst: KOR en btw-aftrek.
- Belastingdienst: diensten naar/buiten EU en opgaaf ICP.
- Belastingdienst: btw privégebruik auto.
- Belastingdienst: zelfstandigenaftrek, mkb-winstvrijstelling en tariefsaanpassing aftrekposten.
- Belastingdienst: box-1-tarieven, heffingskortingen en Zvw per jaar.
- Belastingdienst: KIA, voorwaarden investeringsregelingen en desinvesteringsbijtelling.
- Belastingdienst: beperkt aftrekbare zakelijke kosten en werkruimte thuis.
- RVO: actuele Energie- en Milieulijst voor EIA/MIA/Vamil.

## 11. Status

De architectuur is geschikt om fiscale regels betrouwbaar uit te voeren. De resterende risico's zitten hoofdzakelijk in fiscale beslislogica, uitzonderingen en ontbrekende feiten. Los eerst de P0/P1-punten op en laat daarna de volledige regressiesuite draaien voordat `checked=true` of een claim “fiscaal correct” wordt gebruikt.
