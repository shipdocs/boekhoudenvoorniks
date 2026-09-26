# Fiscale review: voor de boekhouder

Dit document is bedoeld om voor te leggen aan een boekhouder of fiscalist (issue #44). Het beschrijft
hoe Gratis Boekhouden boekt en rekent op de punten die nog niet gecontroleerd zijn. Per punt staat de
vraag die we beantwoord willen hebben. Graag per vraag: **klopt** / **klopt niet, want …**.

De app is voor zzp'ers en kleine bouwbedrijven (stukadoor, schilder, timmerman, loodgieter,
elektricien). Alle bedragen in de voorbeelden zijn in euro's.

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

### 1.3 Buiten scope (bewust)

- **OSS** (webshopverkopen aan EU-consumenten) zit niet in de app. De app waarschuwt daarvoor. Vraag 8: vindt u dat verantwoord voor deze doelgroep, of moet de app zulke verkopen blokkeren?
- **Suppletie**: correcties boven € 1.000 btw gaan via een suppletie, correcties tot en met € 1.000 gaan mee in de volgende aangifte. Vraag 9: klopt deze grens?

### 1.4 Afronding

De aangifte wordt per rubriek in hele euro's ingevuld. Omzet en af te dragen btw worden naar beneden
afgerond, voorbelasting naar boven (in het voordeel van de ondernemer). Rubriek 5g is de som van de
afgeronde vakken. Vraag 10: klopt dit?

---

## 2. Schatting inkomstenbelasting

Dit is **altijd een schatting**, zo staat het ook in de app. De app kent alleen de winst uit de
onderneming.

### 2.1 Methode

1. Winst tot nu (omzet − kosten volgens de boekhouding), lineair doorgetrokken naar het hele jaar.
2. − zelfstandigenaftrek, alleen als de gebruiker aangeeft aan het urencriterium te voldoen, en nooit meer dan de winst.
3. − mkb-winstvrijstelling over (winst − zelfstandigenaftrek).
4. = belastbaar inkomen. Daarover gaat box 1 (tarief onder de AOW-leeftijd).
5. − algemene heffingskorting − arbeidskorting, beide berekend over het belastbaar inkomen.
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
12. Heffingskortingen worden over het belastbaar inkomen berekend, niet over het verzamelinkomen of arbeidsinkomen. Acceptabel voor een schatting?
13. Klopt de volgorde: eerst de zelfstandigenaftrek, dan de mkb-winstvrijstelling?
14. Moet de startersaftrek als optie erbij?

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

---

## 4. Hoe terugkoppelen

Het liefst per vraagnummer in issue #44 op GitHub, of per e-mail. Wijzigingen verwerk ik in de code en
de tests (`tests/btw.test.ts`, `tests/buitenland.test.ts`, `tests/belastingvoordelen.test.ts`), zodat ze
niet ongemerkt terugkomen.
