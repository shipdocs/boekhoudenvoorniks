# Fiscale review: voor de boekhouder

Dit document is bedoeld om voor te leggen aan een boekhouder of fiscalist (issue #44). Het beschrijft
hoe Gratis Boekhouden boekt en rekent op de punten die nog niet gecontroleerd zijn. Per punt staat de
vraag die we beantwoord willen hebben. Graag per vraag: **klopt** / **klopt niet, want …**.

De app is voor zzp'ers en kleine bouwbedrijven (stukadoor, schilder, timmerman, loodgieter,
elektricien). Alle bedragen in de voorbeelden zijn in euro's.

**Code-audit (peildatum 27 september 2026, `main` @ `9970c62`).** De vragenlijst is bijgewerkt met
een audit van de code zelf. Per onderdeel staat onder **Bevinding code-audit** wat de code nu
werkelijk doet en waar we denken dat het fout gaat. Die bevindingen zijn nog niet door een fiscalist
bevestigd; ze staan er juist zodat u ze kunt toetsen. De vraagnummers 1–26 zijn ongewijzigd gebleven,
nieuwe vragen beginnen bij 27.

Legenda: **OK** = lijkt juist binnen de scope, **LET OP** = alleen juist onder voorwaarden,
**FOUT** = vermoedelijk correctie nodig in de code.

### Samenvatting van de audit

De dubbele boekhouding (centen, alleen gebalanceerde posten, onveranderlijke journaalregels,
correcties via tegenboekingen) en de standaard-btw-rubrieken zijn degelijk. Op de volgende punten
is de app vermoedelijk nog niet fiscaal juist:

| Prio | Onderwerp | Waar | Vraag |
|---|---|---|---|
| P0 | Onder de KOR kan een inkoop met 21%/9% toch voorbelasting boeken | `src/core-ledger/rules.ts` `expenseLines()` | 27 |
| P0 | Diensten aan bedrijven buiten de EU komen altijd in 3a | `src/btw/btw.ts` (`export`) | 2 |
| P0 | Geen tariefsaanpassing voor zelfstandigenaftrek en mkb-winstvrijstelling in de hoogste schijf | `src/tax/income-tax.ts` `estimateIncomeTax()` | 28 |
| P1 | Zelfstandigenaftrek wordt ook bij recht op startersaftrek op de winst afgekapt; geen niet-gerealiseerde zelfstandigenaftrek | idem | 29 |
| P1 | Bij verlies geeft de schatting overal nul (geen fiscaal verlies) | idem | 30 |
| P1 | Desinvesteringsdrempel € 2.500 vast in de tabel; historisch KIA-percentage wordt uit het huidige register gereconstrueerd | `src/tax/income-tax.ts`, `src/tax/overview.ts` | 20, 31 |
| P1 | Representatiedrempels 2025/2026 nog niet tegen de jaartabel vastgezet | `src/tax/income-tax.ts` | 22 |
| P1 | ICP: één code voor goederen en diensten; ICP-correctie gekoppeld aan btw-suppletie | `src/shared/vat.ts`, `src/btw/btw.ts` | 3, 4, 10a |
| P1 | Auto van de zaak: 2,7%/1,5%-forfait wordt te automatisch toegepast | `src/btw/car.ts` | 32 |
| P1 | OSS-waarschuwing van € 10.000 geldt niet voor elk soort B2C-prestatie | `src/btw/checks.ts` | 8 |
| P1 | Tekst werkruimte thuis: "bureau, stoel en kast mag je altijd aftrekken" is te stellig | `src/tax/overview.ts` | 33 |
| P2 | Afschrijving start op aankoopdatum in plaats van ingebruikname | `src/tax/assets.ts` | 17 |

---

## 1. Btw-codes en rubrieken

### 1.1 Verkoop

| Code in de app | Wat de gebruiker kiest | Tarief | Rubriek | Grootboek (RGS) |
|---|---|---|---|---|
| `hoog` | 21% | 21% | 1a | WOmzNodOdh |
| `laag` | 9% | 9% | 1b | WOmzNodOdl |
| `nul` | 0% | 0% | 1e | WOmzNodOdg |
| `verlegd` | Btw verlegd (NL, bv. onderaanneming bouw) | 0% | 1e | WOmzNodOdg |
| `vrijgesteld` | Vrijgesteld / KOR | – | geen | WOmzNodNod |
| `icp` | Bedrijf in de EU (0%, ICP) | 0% | 3b + ICP-opgaaf | WOmzNodOdi |
| `export` | Uitvoer buiten de EU (0%) | 0% | 3a | WOmzNodOdb |

**Controles die de app afdwingt**
- Bij `verlegd` en `icp` moet het btw-nummer van de klant bekend zijn.
- Bij `icp` moet de klant in een ander EU-land zitten. Bij `export` moet de klant buiten de EU zitten.
- Op de factuur staat bij `icp`: *"Intracommunautaire levering/dienst, btw verlegd (art. 138 / art. 196 Btw-richtlijn)"* met het btw-nummer van de afnemer.
- In de e-factuur (UBL, Peppol BIS 3.0) wordt `icp` categorie K (VATEX-EU-IC) en `export` categorie G (VATEX-EU-G).

**Vragen**
1. Klopt de indeling van `verlegd` (NL) in rubriek 1e?
2. Diensten aan een **bedrijf buiten de EU**: nu kan de gebruiker alleen `export` (3a) kiezen. Horen die diensten in 3a, in 1e, of niet in de aangifte?
3. `icp` is één code voor zowel goederen als diensten. Voor de ICP-opgaaf moet de gebruiker dat per klant zelf aangeven. Is een aparte code nodig?
4. Is de tekst op de factuur bij ICP juist en volledig?

**Bevinding code-audit**
- `hoog`/1a, `laag`/1b en `nul`/1e: **OK**. `verlegd`/1e: **OK mits** er een wettelijke
  verleggingsgrond is (bijv. onderaanneming in de bouw). Alleen een btw-nummer van de klant is niet
  genoeg; de app controleert nu alleen of er een btw-nummer is.
- `export`/3a: **FOUT** voor diensten. 3a past bij uitvoer van goederen (mits aan de voorwaarden
  is voldaan). Een B2B-dienst die volgens de plaats-van-dienstregels buiten de EU belast is, hoort
  volgens de Belastingdienst niet in de Nederlandse aangifte. Voorstel: `export` splitsen in
  `buiten-eu-goederen` (3a) en `buiten-eu-dienst` (niet in de aangifte).
- `icp`: **LET OP**. Rubriek 3b klopt op hoofdlijn, maar de ICP-opgaaf vraagt goederen en diensten
  apart en de ICP-CSV bevat nu geen prestatietype. De factuurtekst "art. 138 / art. 196" noemt beide
  grondslagen tegelijk; per prestatie zou de juiste grondslag moeten staan. Voorstel: aparte codes
  `icp-goederen` en `icp-dienst`.
- `vrijgesteld` betekent nu zowel "echte vrijstelling" als "KOR". Die twee hebben andere gevolgen
  (zie vraag 27) en horen semantisch gescheiden te worden.

### 1.2 Inkoop

| Code in de app | Wat de gebruiker kiest | Rubriek | Boeking |
|---|---|---|---|
| `hoog` / `laag` | 21% / 9% | 5b | kosten + voorbelasting |
| `verlegd` | Btw verlegd naar mij (NL, bv. onderaannemer) | 2a + 5b | zie voorbeeld |
| `eu` | Verlegd, leverancier in de EU | 4b + 5b | zie voorbeeld |
| `buiten-eu` | Verlegd, leverancier buiten de EU | 4a + 5b | zie voorbeeld |
| `nul` / `geen` | 0% / geen btw | – | alleen kosten |

**Voorbeeld verlegde inkoop**: advertentiekosten bij Meta Platforms Ireland van € 100 (geen btw op de factuur).

| Rekening | Debet | Credit |
|---|---|---|
| Reclamekosten | 100,00 | |
| Voorbelasting | 21,00 | |
| Af te dragen btw verlegd uit de EU (4b) | | 21,00 |
| Bank | | 100,00 |

De aangifte toont dan: 4b omzet 100 / btw 21 en 5b 21. Per saldo betaalt de ondernemer niets.

**Hoe de app 2a/4a/4b kiest**: op de factuur staat "btw verlegd" (of reverse charge). Het land komt
uit het btw-nummer van de leverancier (IE, DE, … = 4b; GB, CHE, … = 4a; NL = 2a). Zonder btw-nummer
kijkt de app naar het land van het IBAN. Bekende partijen zijn standaard 4b: Meta, Stripe en LinkedIn.

**Vragen**
5. Klopt de boeking van 4a/4b hierboven, inclusief de volledige aftrek in 5b?
6. **Stripe-transactiekosten** worden als 4b geboekt (21% verlegd). Of zijn ze vrijgesteld (financiële dienst), en horen ze dan niet in de aangifte?
7. Google en Microsoft staan standaard op 21% (`hoog`), omdat ze zakelijke klanten zonder geregistreerd btw-nummer Nederlandse btw rekenen. Staat op de factuur "reverse charge", dan wordt het 4b. Is dat een verstandige standaard?

**Bevinding code-audit**
- Boeking verlegde inkoop (kosten + voorbelasting tegen verlegde btw + bank/crediteur): **OK** voor
  een ondernemer met volledig recht op aftrek. De volledige aftrek in 5b geldt alleen voor zover
  dat recht bestaat; onder de KOR of bij (gedeeltelijk) vrijgestelde omzet niet.
- **KOR: FOUT.** De verkoopkant houdt rekening met `kor=true`, maar de inkoopkant niet:
  `expenseLines()` boekt bij `hoog`/`laag` altijd voorbelasting, ook als de KOR aan staat. Onder de
  KOR mag btw op kosten en investeringen niet worden afgetrokken. Die btw hoort dan in de kosten of
  in de kostprijs van het bedrijfsmiddel.
- Het leveranciersgeheugen (Stripe, Meta, Google, …) mag alleen een voorstel doen. De factuur, de
  contracterende entiteit, het land en de vermelding "reverse charge" gaan altijd voor.

**Nieuwe vraag**
27. **KOR en inkoop.** Wij willen onder de KOR: (a) Nederlandse factuur-btw niet meer als
    voorbelasting boeken maar in de kosten/kostprijs; (b) verlegde en buitenlandse btw apart
    behandelen, omdat daarvoor mogelijk toch een (incidentele) aangifte nodig is zonder aftrek in 5b;
    (c) bij in- of uittreden uit de KOR waarschuwen voor herziening van eerder afgetrokken btw op
    investeringen. Klopt deze aanpak, en wat is de juiste route voor verlegde btw onder de KOR?

### 1.3 Buiten scope (bewust)

- **OSS** (webshopverkopen aan EU-consumenten) zit niet in de app. De app waarschuwt daarvoor. Vraag 8: vindt u dat verantwoord voor deze doelgroep, of moet de app zulke verkopen blokkeren?
- **Suppletie**: correcties boven € 1.000 btw gaan via een suppletie, correcties tot en met € 1.000 gaan mee in de volgende aangifte. Vraag 9: klopt deze grens?

**Bevinding code-audit**
- OSS: **te breed.** De app waarschuwt bij meer dan € 10.000 aan particulieren in andere EU-landen
  (`src/btw/checks.ts`). Die drempel geldt niet voor elk soort B2C-dienst (bijv. diensten met een
  eigen plaats-van-dienstregel). Zonder prestatietype kan de app beter algemeen waarschuwen dat de
  plaats van heffing en OSS gecontroleerd moeten worden.
- Suppletie: de hoofdregel van € 1.000 lijkt **OK**. Houd daarnaast rekening met de termijn waarbinnen
  een correctie moet worden gedaan.

### 1.4 Afronding

De aangifte wordt per rubriek in hele euro's ingevuld. De app past consequent afronding per rubriek
in het voordeel van de ondernemer toe: omzet en af te dragen btw naar beneden, voorbelasting naar
boven. Rubriek 5a is de som van de afgeronde verschuldigde rubrieken; 5c en 5g zijn daarna exact
5a min 5b. Dit voorkomt dat een tweede afronding van het cententotaal een ander subtotaal oplevert.
Vraag 10: klopt deze vaste methode voor alle positieve bedragen, creditcorrecties en negatieve saldi?

Het ICP-overzicht gebruikt voor correcties op eerdere periodes dezelfde selectie als rubriek 3b:
kleine correcties staan in beide overzichten van de volgende aangifte; boekingen die via een aparte
suppletie lopen of al met een suppletie zijn afgehandeld staan in geen van beide. Vraag 10a: klopt
deze koppeling tussen de gewone btw-aangifte, suppletie en ICP-opgaaf?

**Bevinding code-audit**
- Afronding 5a/5b/5c/5g: rekenkundig **OK**.
- ICP-correcties: **LET OP.** De btw-suppletie en de correctie van de ICP-opgaaf zijn afzonderlijke
  processen; een correctie op de ICP-opgaaf hangt niet af van de vraag of de btw via suppletie loopt.
  Voorstel: een aparte correctiestatus voor btw en voor ICP bijhouden in plaats van één gedeelde.

---

## 2. Schatting inkomstenbelasting

Dit is **altijd een schatting**, zo staat het ook in de app. De app kent alleen de winst uit de
onderneming.

### 2.1 Methode

1. Winst tot nu (omzet − kosten volgens de boekhouding), lineair doorgetrokken naar het hele jaar.
2. − zelfstandigenaftrek, alleen als de gebruiker aangeeft aan het urencriterium te voldoen, en nooit meer dan de winst.
3. − mkb-winstvrijstelling over (winst − zelfstandigenaftrek).
4. = belastbaar inkomen. Daarover gaat box 1 (tarief onder de AOW-leeftijd).
5. − algemene heffingskorting over het belastbaar inkomen; − arbeidskorting over de fiscale
   winst vóór ondernemersaftrek en mkb-winstvrijstelling (het arbeidsinkomen).
6. \+ inkomensafhankelijke bijdrage Zvw over het belastbaar inkomen (tot het maximum).
7. "Nu opzij zetten" = de jaarschatting × het verstreken deel van het jaar.

**Niet meegenomen** (dit staat ook in de app):
- fiscaal partner, hypotheek en andere aftrekposten;
- ander inkomen en box 2/3;
- voorlopige aanslagen;
- willekeurige afschrijving en EIA/MIA/Vamil.

Sinds de aftrekposten (hoofdstuk 3) rekent de schatting wél met: de verwachte afschrijving van het
hele jaar, de KIA over wat al gekocht is, de bijtelling voor representatie (doorgetrokken naar het
jaar), de desinvesteringsbijtelling en de startersaftrek.

**Vragen**
11. Is deze methode verantwoord als "grove reservering"? Moet de schatting eerder aan de veilige kant (hoger) uitvallen?
12. De algemene heffingskorting wordt over het belastbaar inkomen berekend. De arbeidskorting wordt
    sinds de fiscale controle van september 2026 over het arbeidsinkomen berekend. Is deze afbakening
    voor ondernemers met uitsluitend winst uit onderneming juist?
13. Klopt de volgorde: eerst de zelfstandigenaftrek, dan de mkb-winstvrijstelling?
14. Moet de startersaftrek als optie erbij?

**Bevinding code-audit**
- **Tariefsaanpassing: FOUT.** Bij inkomen in de hoogste schijf levert de zelfstandigenaftrek en de
  mkb-winstvrijstelling maximaal 37,48% (2025) / 37,56% (2026) voordeel op. `estimateIncomeTax()`
  trekt ze volledig af tegen 49,50%. Daardoor valt de reservering bij hoge winst te laag uit
  (bij € 150.000 winst in 2026 grofweg € 2.400).
- **Startersaftrek en lage winst: FOUT.** De code kapt de zelfstandigenaftrek af op de winst en de
  startersaftrek op wat daarna overblijft. Volgens de Belastingdienst geldt die beperking niet als er
  recht is op startersaftrek. Niet-gerealiseerde zelfstandigenaftrek (te verrekenen in de 9 jaar
  daarna) ontbreekt helemaal.
- **Verlies: FOUT.** Bij een fiscale winst van nul of minder geeft de schatting overal nul terug. De
  mkb-winstvrijstelling verkleint ook een verlies, en een verlies (inclusief ondernemersaftrek bij
  starters) is verrekenbaar. Voorstel: "te reserveren belasting" en "fiscale winst/verlies" apart
  tonen.
- `isStarter()` leidt eerder gebruik van de startersaftrek af uit het startjaar en een teller, met
  de aanname "sinds opgeven elk jaar gebruikt" (vraag 23).
- De startersaftrek werd al meegenomen (vraag 14 is daarmee achterhaald); de vraag is nu of de
  berekening juist is (vraag 29).

**Nieuwe vragen**
28. Klopt het dat voor een reserveringsschatting de tariefsaanpassing op zelfstandigenaftrek en
    mkb-winstvrijstelling moet worden toegepast (voordeel maximaal tegen het tarief van schijf 2)?
29. Klopt het dat bij recht op startersaftrek de zelfstandigenaftrek niet tot de winst wordt beperkt,
    en dat het niet-gerealiseerde deel in latere jaren verrekend kan worden? Moet de app dat
    niet-gerealiseerde deel per jaar bijhouden?
30. Is het juist om bij verlies de mkb-winstvrijstelling op het verlies toe te passen en het
    fiscale verlies te tonen, in plaats van overal nul?

### 2.2 Tarieventabel (`src/tax/income-tax.ts`)

Graag per waarde controleren tegen de publicaties van de Belastingdienst.

| | 2025 | 2026 |
|---|---|---|
| Schijf 1 tot | € 38.441 à 35,82% | € 38.883 à 35,75% |
| Schijf 2 tot | € 76.817 à 37,48% | € 78.426 à 37,56% |
| Schijf 3 daarboven | 49,50% | 49,50% |
| Zelfstandigenaftrek | € 2.470 | € 1.200 |
| Mkb-winstvrijstelling | 12,70% | 12,70% |
| Algemene heffingskorting max. | € 3.068, afbouw 6,337% vanaf € 28.406 | € 3.115, afbouw 6,398% vanaf € 29.736 |
| Arbeidskorting opbouw | 8,053% tot € 12.169; 30,030% tot € 26.288; 2,258% tot € 43.071 | 8,324% tot € 11.965; 31,009% tot € 25.845; 1,950% tot € 45.592 |
| Arbeidskorting max. / afbouw | € 5.599; 6,51% vanaf € 43.071 | € 5.685; 6,51% vanaf € 45.592 |
| Zvw-bijdrage ondernemer | 5,26% tot € 75.860 | 4,85% tot € 79.409 |

15. Kloppen deze waarden? Na akkoord zet ik per jaar `checked: true`. De app toont dan niet langer "nog niet gecontroleerd".

**Rekenvoorbeeld 2026**: winst € 50.000, urencriterium ja.
- zelfstandigenaftrek € 1.200
- mkb-winstvrijstelling 12,7% × € 48.800 = € 6.198
- belastbaar € 42.602
- box 1 ≈ € 15.298
- heffingskortingen ≈ € 7.919
- Zvw ≈ € 2.066
- **schatting ≈ € 9.445**

16. Komt dit ongeveer overeen met wat u voor zo'n ondernemer (zonder partner en zonder ander inkomen) zou verwachten?

**Bevinding code-audit**
- De schijven, de zelfstandigenaftrek (€ 2.470 / € 1.200), de mkb-winstvrijstelling (12,7%), de
  startersaftrek (€ 2.123), de kilometervergoeding en het urencriterium (1.225 uur) in de code komen
  overeen met de jaarinformatie die wij hebben gebruikt.
- Beide jaren staan nog op `checked: false`. Een jaar gaat pas op `checked: true` als **alle** waarden
  (ook heffingskortingen, Zvw, drempels) én de formules (vraag 28–30) tegen de officiële jaartabel
  zijn gecontroleerd.
- Voor latere jaren gebruikt `rulesFor()` de laatst bekende tabel. Dat mag alleen als duidelijk
  gemarkeerde prognose, en de app toont dat nu ook zo.

---

## 3. Aftrekposten en bedrijfsmiddelen

Code: `src/tax/assets.ts`, `src/tax/mileage.ts`, `src/tax/overview.ts`; bedragen per jaar in
`src/tax/income-tax.ts`. In de app: Belasting → *Aftrekposten, bedrijfsmiddelen en kilometers*.

### 3.1 Bedrijfsmiddelen en afschrijving

- Alles wat op *Inventaris en gereedschap* of *Vervoermiddelen* wordt geboekt (debet), wordt een
  bedrijfsmiddel. De app stelt zo'n boeking voor bij aankopen vanaf € 450 excl. btw per stuk (categorie
  "Groot gereedschap / machine").
- Lineair, per maand, vanaf de maand van aanschaf. Standaard 5 jaar en restwaarde € 0; de gebruiker kan
  dat aanpassen, maar niet korter dan 5 jaar (max. 20% per jaar).
- Na afloop van een jaar boekt de app de afschrijving automatisch op 31 december:
  *Afschrijving inventaris* (WAfsAmvBei) aan *Cumulatieve afschrijving inventaris* (BMvaBeiCae). Voor
  vervoermiddelen WAfsAmvTev / BMvaTevCae.
- Verkoop of buiten gebruik: eerst de afschrijving tot en met de maand vóór de verkoop. Daarna gaat de
  boekwaarde naar *Boekresultaat* (WAfsRvmBei). De opbrengst komt binnen via een gewone verkoopfactuur (met btw)
  en staat dus op omzet.
- Wordt de aankoop later teruggedraaid (andere categorie), dan vervalt het bedrijfsmiddel en wordt de
  geboekte afschrijving teruggenomen.

**Vragen**
17. Is afschrijven per maand vanaf de aanschafmaand, met standaard 5 jaar en restwaarde 0, een verantwoorde standaard?
18. Is de verkoopopbrengst op omzet (via de factuur) en de boekwaarde op boekresultaat acceptabel, of moet de opbrengst ook op boekresultaat?

**Bevinding code-audit**
- Minimaal 5 jaar sluit aan bij maximaal 20% afschrijving per jaar voor gewone bedrijfsmiddelen: **OK**.
- **LET OP:** de afschrijving start op de aankoopdatum. Fiscaal telt de **ingebruikname**. Voorstel: een
  veld `in_use_on` toevoegen dat standaard gelijk is aan de aankoopdatum.
- Restwaarde € 0 is alleen verantwoord als aanpasbare standaard.
- De grens van € 450 excl. btw werkt alleen als de btw aftrekbaar is. Onder de KOR (vraag 27) hoort de
  niet-aftrekbare btw bij de kostprijs, dus ook bij de toets aan € 450 en bij de KIA.

### 3.2 Investeringsaftrek (KIA) en desinvesteringsbijtelling

| | 2025 | 2026 |
|---|---|---|
| Geen aftrek tot en met | € 2.900 | € 2.900 |
| 28% tot en met | € 70.602 | € 71.683 |
| Vast bedrag tot en met | € 130.744: € 19.769 | € 132.746: € 20.072 |
| Afbouw 7,56% tot en met | € 392.230 | € 398.236 |

- Alleen bedrijfsmiddelen vanaf € 450 per stuk tellen mee. De gebruiker kan een bedrijfsmiddel uitsluiten,
  bijvoorbeeld een personenauto.
- Desinvesteringsbijtelling: verkoop binnen 5 jaar na het begin van het investeringsjaar, alleen als de
  verkopen in dat jaar samen boven € 2.500 komen. Bijtelling = het effectieve KIA-percentage van het
  investeringsjaar × de verkoopprijs, en nooit meer dan dat percentage × de aanschafprijs.

**Vragen**
19. Kloppen de tabellen?
20. Klopt de berekening van de desinvesteringsbijtelling met het effectieve percentage van het investeringsjaar?

**Bevinding code-audit**
- De KIA-staffels 2025/2026 en de grens van € 450 per bedrijfsmiddel komen overeen met de officiële
  KIA-tabellen: **OK**.
- Desinvesteringsdrempel: de code gebruikt voor beide jaren € 2.500 (`desinvesteringDrempel`). In een
  eerdere versie van de audit stond dat dit voor 2026 € 2.900 zou zijn; daar hebben we geen bron voor
  gevonden en het lijkt een verwarring met de KIA-ondergrens (€ 2.900/€ 2.901). Zie vraag 31.
- **LET OP:** het KIA-percentage van het investeringsjaar wordt achteraf gereconstrueerd uit het
  huidige register. Als er sindsdien bedrijfsmiddelen zijn toegevoegd, verwijderd of uitgesloten,
  klopt dat percentage niet meer. Voorstel: de werkelijk toegepaste KIA per investeringsjaar opslaan.
- Fictieve vervreemdingen (overbrengen naar privé, bepaalde verhuur, niet tijdig in gebruik nemen)
  herkent de app niet.

**Nieuwe vraag**
31. Is de drempel van € 2.500 voor de desinvesteringsbijtelling in 2025 en 2026 juist? Welke
    fictieve vervreemdingen zijn voor deze doelgroep relevant genoeg om in de app te signaleren?

### 3.3 Privéauto, representatie, startersaftrek en uren

- **Privéauto** (instelling): € 0,23 (2025) of € 0,25 (2026) per zakelijke km. Per rit wordt
  *Kilometervergoeding* (WBedAutKil) geboekt aan *Privé-stortingen*. Tanken en parkeren worden dan
  als privé voorgesteld en nooit automatisch als zakelijke kosten geboekt. Staat er toch brandstof op de
  kosten, dan waarschuwt het jaaroverzicht. Een auto van de zaak met bijtelling rekent de app niet uit.
- **Representatie**: nieuwe categorie *Etentjes, borrels & relatiegeschenken* (WBedVkkRep, standaard
  zonder btw-aftrek). Bijtelling = min(20% van het totaal, drempel € 5.600 (2025) / € 5.700 (2026)).
- **Startersaftrek** € 2.123: als het startjaar minder dan 5 jaar geleden is, en de aftrek minder dan 3 keer
  is gebruikt. De app neemt aan dat de gebruiker hem sinds het opgeven elk jaar gebruikt. Niet meer
  vanaf 2028.
- **Urencriterium**: uren op werkbonnen (eenheid "uur") plus losse uren. Dit is alleen een teller: de
  gebruiker zet het vinkje "urencriterium" zelf.
- **EIA/MIA/Vamil**: alleen een signaal bij bedrijfsmiddelen waarvan de naam lijkt op iets van de
  Energie- of Milieulijst, met de meldtermijn van 3 maanden (gerekend vanaf de aankoopdatum).

- **Investering of kosten**: bij € 450 of meer excl. btw in de categorieën gereedschap, kantoor, telefoon,
  auto of overig vraagt de app al bij de invoer: "Gaat dit langer dan een jaar mee?". Op Vandaag staat daarna
  nog een vangnet: "Was dit een investering?". Bij "ja" wordt de kostenregel omgeboekt naar Inventaris. De
  bonherkenning gebruikt nu het bedrag excl. btw (subtotaal, of het totaal teruggerekend).
- **Telefoon & internet**: de gebruiker geeft een zakelijk percentage op. Het privédeel van de kosten
  (WBedKanTel) telt bij de winst. De btw daarover (± 21% van het privédeel van de kosten tegen 21%) wordt als
  correctie genoemd voor de laatste btw-aangifte van het jaar (minder voorbelasting, 5b). Die boekt de
  app nog niet automatisch.
- **Werkplek thuis**: alleen uitleg. Een niet-zelfstandige werkruimte is niet aftrekbaar (inrichting wel).
  Een zelfstandige werkruimte kan aftrekbaar zijn (inkomenseis 70%/30%); de app rekent dat niet uit.
- **Meewerkaftrek**: vanaf 525 uur 1,25%, vanaf 875 uur 2%, vanaf 1.225 uur 3%, vanaf 1.750 uur 4% van de
  winst. Alleen met urencriterium, en de app gaat ervan uit dat de partner minder dan € 5.000 krijgt.
- **AOV, lijfrente en pensioen**: altijd de uitleg dat dit geen bedrijfskosten zijn, maar wel aftrekbaar in
  de aangifte. De categorie *Verzekeringen* noemt de AOV niet langer.
- **Latere jaren**: 2027 rekent met zelfstandigenaftrek € 900 en startersaftrek € 10; vanaf 2028 geen
  startersaftrek. De overige bedragen zijn die van 2026, en dat staat erbij.
- **Controle door een deskundige**: bij elke IB-berekening staat de melding dat een boekhouder of
  accountant de aangifte moet controleren. Eén keer per jaar moet de gebruiker dat bevestigen voordat het
  overzicht opent. Er is een knop om het overzicht als tekst naar de boekhouder te sturen.

**Vragen**
21. Is "tanken met een privéauto = privé" juist? De btw-aftrek op brandstof naar rato van zakelijk gebruik laten we nu liggen.
22. Is 80% of de drempel voor representatie correct toegepast voor IB-ondernemers?
23. Mag de aanname "elk jaar gebruikt" bij de startersaftrek, of moet de gebruiker per jaar aangeven of hij hem gebruikt?
24. Is het privédeel van telefoon & internet als bijtelling, met een btw-correctie aan het eind van het jaar, een goede werkwijze? Of moet het per boeking worden gesplitst?
25. Kloppen de percentages van de meewerkaftrek voor 2025 en 2026?
26. Zijn de categorieën voor de investeringsvraag (gereedschap, kantoor, telefoon, auto, overig) goed gekozen?

**Bevinding code-audit**
- **Privéauto:** € 0,23 (2025) / € 0,25 (2026) per km is **OK**; brandstof, verzekering, tol en parkeren
  mogen dan voor de IB niet ook als autokosten worden afgetrokken. Voor de **btw** kan bij een privéauto
  wél aftrek naar rato van zakelijk gebruik mogelijk zijn. De huidige aanpak (vraag 21) is veilig, maar
  mist mogelijk rechtmatige voorbelasting.
- **Auto van de zaak: LET OP.** De btw-correctie privégebruik met het forfait van 2,7% / 1,5%
  (`src/btw/car.ts`) is geen universele berekening. Werkelijk privégebruik, het recht op aftrek bij
  aanschaf, een eigen bijdrage en de historie van de auto kunnen de uitkomst veranderen. De IB-bijtelling
  blijft terecht buiten scope.
- **Representatie:** de methode "80% aftrekbaar of de drempel, wat gunstiger is" is **OK** voor
  IB-ondernemers. De drempels in de code (€ 5.600 voor 2025, € 5.700 voor 2026) moeten per jaar tegen
  de officiële tabel worden vastgezet. Btw op horeca en relatiegeschenken kent eigen regels.
- **Telefoon & internet:** een zakelijk percentage van de gebruiker is werkbaar. Beter is het
  privédeel en de niet-aftrekbare btw al bij de oorspronkelijke boeking te splitsen, in plaats van
  achteraf ± 21% te reconstrueren (vraag 24).
- **Werkruimte thuis: FOUT (tekst).** De app zegt "Je bureau, stoel en kast mag je altijd aftrekken".
  Dat is te stellig. Losse apparatuur en inventaris kunnen zakelijk zijn, maar dat hangt af van
  het gebruik.
- **Meewerkaftrek:** de staffel is **OK**; de overige voorwaarden (o.a. geen of een lage vergoeding aan
  de partner) moet de gebruiker expliciet bevestigen.
- **AOV, lijfrente, pensioen:** formuleer als "kan aftrekbaar zijn", niet "mag je aftrekken".
- **EIA/MIA/Vamil:** alleen signaleren is **OK**; de app claimt geen recht zonder actuele RVO-lijst.

**Nieuwe vragen**
32. Wanneer mag de app het forfait van 2,7% / 1,5% voor de btw-correctie privégebruik van een auto
    van de zaak als standaard voorstellen, en welke vragen moet de gebruiker eerst beantwoorden?
33. Wat is een juiste, korte tekst voor de app over werkruimte thuis en inrichting (bureau, stoel,
    kast) bij een niet-zelfstandige werkruimte?

---

## 4. Regressietests na de antwoorden

Zodra de antwoorden binnen zijn, leggen we de uitkomst vast in tests:

1. KOR + inkoop met 21%: geen voorbelasting, btw in kosten/kostprijs (27).
2. KOR + verlegde buitenlandse dienst: juiste route, geen automatische volledige aftrek in 5b (27).
3. Buiten-EU goederen versus B2B-dienst: alleen goederen naar 3a (2).
4. IB boven de hoogste schijf: tariefsaanpassing (28).
5. Starter met lage winst: geen afkapping op de winst, verlies juist (29, 30).
6. Niet-gerealiseerde zelfstandigenaftrek over meerdere jaren (29).
7. Desinvestering rond de jaardrempel (31).
8. Representatie rond de drempel, voor 2025 én 2026 (22).
9. Alle Zvw- en heffingskortingparameters per jaar tegen de officiële tabel (15).
10. ICP goederen en diensten apart, correctie los van btw-suppletie (3, 10a).
11. Btw-correctie auto met uitzonderingen (32).
12. Afschrijving met een latere ingebruiknamedatum (17).
13. Investering onder de KOR: kostprijs inclusief niet-aftrekbare btw (27).

Pas daarna gaat een jaar op `checked: true`, en pas daarna gebruikt de app ergens de claim
"fiscaal gecontroleerd".

## 5. Bronnen

Bij het beantwoorden en bij latere wijzigingen: steeds de actuele pagina's van de Belastingdienst
(KOR en btw-aftrek; diensten naar het buitenland en de ICP-opgaaf; btw privégebruik auto;
ondernemersaftrek en tariefsaanpassing; box 1, heffingskortingen en Zvw per jaar; KIA en
desinvesteringsbijtelling; beperkt aftrekbare kosten en werkruimte thuis) en van RVO (Energielijst en
Milieulijst). Graag bij elk antwoord de bron en de datum van raadplegen noemen.

## 6. Hoe terugkoppelen

Het liefst per vraagnummer in issue #44 op GitHub, of per e-mail. Wijzigingen verwerk ik in de code en
de tests (`tests/btw.test.ts`, `tests/buitenland.test.ts`, `tests/belastingvoordelen.test.ts`), zodat ze
niet ongemerkt terugkomen.
