## Antwoorden fiscale review — 5 oktober 2026

Uitgangspunt van Martin: **invullen en verwerken volgens de normale boekhoudkundige en fiscale regels; de GUI maakt dat vervolgens makkelijk en simpel.** Vereenvoudiging van de bediening mag de journaalposten, btw-grondslagen, aangifterubrieken en voorwaarden voor aftrek niet veranderen.

Hieronder de oorspronkelijke vragen **1–16, inclusief 10a**, uit `docs/fiscale-review.md` en het aanvullende XBRL-punt van dit issue. Getoetst aan main vóór de correcties van 5 oktober 2026 en de onderstaande officiële bronnen. De codebevindingen hieronder beschrijven die uitgangssituatie; de gerealiseerde wijzigingen staan bij ‘Uitvoering in deze branch’. Dit is een bronnen- en codecontrole, geen verklaring van een externe boekhouder dat de gehele applicatie is goedgekeurd.

### Btw: vragen 1–10a

**1. Binnenlandse verlegde verkoop → 1e: klopt, onder voorwaarden.** De leverancier vermeldt de vergoeding bij 1e, zonder verschuldigde btw. De afnemer verwerkt de binnenlandse verlegging in 2a, met aftrek in 5b voor zover toegestaan. Er moet een toepasselijke verleggingsregeling zijn; alleen een btw-nummer maakt verleggen niet toegestaan. De GUI kan bijvoorbeeld “Onderaanneming bouw: btw naar opdrachtgever verlegd” aanbieden, met controle op de voorwaarden. Bron: [toelichting btw-aangifte 2026, rubriek 1e/2a][OB].

**2. B2B-diensten buiten de EU → meestal niet in de Nederlandse aangifte.** Als de plaats van dienst buiten de EU ligt, komt die dienst niet in 3a en niet in 1e. De code `dienst-buiten-eu` is daarvoor passend. `export`/3a blijft voor uitgevoerde goederen met de vereiste uitvoerbewijzen. Het klantland alleen is onvoldoende: met name werkzaamheden aan onroerend goed hebben een eigen plaats-van-dienstregel. Voor de bouwdoelgroep moet de GUI dus ook kunnen vragen waar het pand staat. Buiten Nederland belast is bovendien iets anders dan btw-vrijgesteld; dat onderscheid kan gevolgen hebben voor aftrek. Bron: [diensten leveren buiten de EU][DIENST].

**3. ICP-goederen/diensten/driehoek: onderscheid in de administratie is nodig; afzonderlijke codes zijn een goede uitvoering.** Goederen en diensten kunnen op het gewone ICP-formulier in dezelfde hoofdrubriek staan; er is dus geen algemene wettelijke eis dat elk een eigen grootboekrekening heeft. Ze moeten intern wél onderscheidbaar zijn voor het juiste tijdvak en de maandgrens. De bestaande `icp` en `icp-dienst` zijn daarom zinvol. De vereenvoudigde ABC-regeling heeft een aparte ICP-rubriek en correctierubriek: afzonderlijk ondersteunen of expliciet als niet ondersteund markeren, nooit stil als gewone ICP verwerken. De €50.000-kwartaalgrens geldt voor goederen, niet voor diensten. Bij overschrijding in de tweede maand mag de eerste opgaaf over twee maanden gaan; bij overschrijding in de derde maand nog over het hele kwartaal. Bron: [ICP-toelichting 2026][ICP] en [tijdvakken ICP][ICP-TIJD].

**4. Factuurtekst: splitsen per prestatie.** Voor gewone intracommunautaire goederenlevering: eigen en klant-btw-id, 0% en een verwijzing naar de vrijstelling/grondslag voor de intracommunautaire levering, bijvoorbeeld art. 138 Btw-richtlijn. Voor een intracommunautaire dienst: beide btw-id’s en “btw verlegd”, eventueel art. 196. De gecombineerde tekst “levering/dienst, art. 138 / art. 196” is onvoldoende specifiek. Ook in UBL moeten goederen en diensten hun passende categorie krijgen; geen gemeenschappelijke categorie K voor beide. Bron: [extra factuureisen goederen][FACT-G] en [diensten][FACT-D]. De btw-behandeling onder de KOR moet afzonderlijk worden bepaald.

**5. Verlegde inkoop en 5b: voorbeeld klopt bij volledig aftrekrecht.** Voor een belaste Ierse advertentiedienst van €100: debet reclamekosten €100 en voorbelasting €21; credit verlegde btw EU €21 en bank/crediteur €100. Aangifte: grondslag 4b €100, verschuldigde btw €21, aftrek 5b €21. Geen of gedeeltelijk aftrekrecht betekent geen of gedeeltelijke 5b; de verschuldigde btw verdwijnt daardoor niet.

De keuze 2a/4a/4b mag **niet uitsluitend uit btw-id of IBAN-land** volgen. Een buitenlandse leverancier kan Nederlandse binnenlandse btw verleggen; de officiële toelichting noemt bij 4b expliciet dat diensten aan onroerende zaken in 2a thuishoren. Invoergoederen uit derde landen komen bij 4a bij toepassing van art. 23 of de toepasselijke verplichte invoerverlegging; gewone invoer met btw bij de Douane is niet automatisch 4a. Dit raakt juist bouwbedrijven. Bron: [OB, 4a/4b/5b][OB], [EU-inkoop][INK-EU], [diensteninkoop buiten EU][INK-BUITEN].

**6. Stripe: de onvoorwaardelijke 4b-automatisering is niet goedgekeurd.** Stripe bevestigt levering vanuit Ierland en doorgaans geen door Stripe berekende btw voor Nederlandse accounts. Stripe bevestigt daarmee niet dat *elke* kostenregel aan Nederlandse verlegde btw is onderworpen. Een financiële betalingsdienst kan vrijgesteld zijn, maar technische kaartverwerking is niet automatisch vrijgesteld; zie de uitspraak Bookit. Verschillende producten en prestaties moeten worden beoordeeld.

Daarom: niet alles automatisch vrijgesteld maken, en ook niet alles automatisch 21% verlegd maken. De huidige hardcoded `feesReverseCharge: 'eu'` in `src/integrations/stripe.ts` moet worden vervangen door een onderbouwde, instelbare behandeling per kostensoort/prestatie:
- vastgestelde belaste B2B-dienst uit Ierland: 4b, 5b voor zover aftrekbaar;
- vastgestelde vrijgestelde financiële dienst: kosten zonder verlegde btw;
- onvoldoende gegevens: kosten fiscaal “te beoordelen”, zichtbaar bij de aangiftecontrole.

Vraag in de eenvoudige GUI één keer om de kostenfactuur en een bevestigde indeling, onthoud die voor dezelfde prestatie, en laat gemengde facturen splitsen. Een payout-bedrag met alleen totale fees is geen bewijs van de btw-kwalificatie. **De precieze vrijstelling van de concrete Stripe-betaaldienst blijft een gerichte beoordeling van factuur en contract; de geraadpleegde openbare bronnen geven geen uniforme uitkomst voor alle Stripe-fees.** Bronnen: [Stripe zelf][STRIPE], [financiële vrijstelling][FIN], [HvJ EU Bookit][BOOKIT].

**7. Google/Microsoft standaard 21%: alleen als voorlopig voorstel, niet als boekingsregel.** Een correcte factuur met Nederlandse btw kan tot 5b leiden; een belaste Ierse B2B-dienst met verlegging tot 4b en eventueel 5b. Controleer de contracterende entiteit, prestatie en de btw op het document. Ten onrechte berekende btw is niet aftrekbaar door haar simpelweg als `hoog` te boeken. Buitenlandse btw hoort evenmin in Nederlandse 5b. De GUI kan automatisch herkennen en voorstellen, maar bij ontbrekend of tegenstrijdig bewijs moet de boeking te controleren blijven. Bron: [OB, 5b][OB] en [EU-inkoop][INK-EU].

**8. OSS: mag als functionaliteit buiten scope blijven, maar normale verwerking blijft vereist.** Mijn aanbeveling voor de huidige doelgroep is: geen OSS-aangiftemodule als voorwaarde voor deze release. Dat is een productadvies, geen nieuwe beslissing namens Martin. Verkopen met buitenlandse btw mogen niet als Nederlandse 21%/9%-omzet in de Nederlandse aangifte verdwijnen. Leg daarvoor de correcte omzet en buitenlandse btw-verplichting vast en bied een extern afhandelingspad; ontbreekt dat, blokkeer alleen de onjuiste fiscale verwerking en toon de benodigde vervolgstap.

De gezamenlijke €10.000-drempel betreft intracommunautaire afstandsverkopen en digitale B2C-diensten onder de voorwaarden van die regeling, met controle op huidig én vorig kalenderjaar. Het is geen algemene veilige grens voor alle buitenlandse B2C-diensten. Bijvoorbeeld werkzaamheden aan een buitenlands pand kunnen vanaf de eerste euro buitenlands belast zijn. OSS is facultatief als alternatief voor lokale registratie; EU-KOR kan onder eigen voorwaarden relevant zijn. Bron: [EU-consumenten goederen][B2C-G] en [diensten][B2C-D]. GUI: eerst klanttype, soort prestatie en relevante locatie; daarna de juiste vervolgstap.

**9. Suppletiegrens: klopt.** Een btw-correctie tot en met €1.000 mag in de eerstvolgende aangifte bij de betreffende rubriek; meer dan €1.000 via suppletie. Het gaat om het btw-verschil, niet de omzet. Correcties niet kunstmatig opdelen om beneden de grens te blijven. De actuele Belastingdienst-pagina noemt voor correcties boven €1.000 “zo snel mogelijk, maar in elk geval binnen 8 weken” na ontdekking; de app moet die termijn consequent tonen, niet uitsluitend bij een positieve correctie. Bron: [btw-aangifte corrigeren][SUPP].

**10. Afronding: voorgestelde methode is bruikbaar, ook bij negatieve btw-bedragen.** Houd de boekhouding in centen. Rond pas de geaggregeerde aangifterubrieken af: verschuldigde btw met `floor`, voorbelasting met `ceil`. Dat werkt ook met negatieve tekens: verschuldigde btw −€100,20 → −€101; negatieve voorbelasting −€100,20 → −€100. Dit is gunstig in het uiteindelijke saldo. Gebruik geen afkappen richting nul als vervanger. 5a = som van de afgeronde verschuldigde rubrieken; vervolgens het saldo minus afgeronde 5b, zonder nieuwe zelfstandige afronding. Controleer daarnaast de aansluiting van het afgeronde ICP-overzicht op 3b; afronden per klant en afronden van het totaal zijn niet vanzelf gelijk. Bron: [OB, “Bedragen afronden”][OB]. Deze uitleg over floor/ceil is de rekenkundige uitwerking van de toegestane afronding.

**10a. ICP-correctie en suppletie: afzonderlijke processen, met een belangrijk extra onderscheid.** Een fout in een eerdere ICP-opgaaf corrigeer je in de correctierubriek van de volgende opgaaf, met verwijzing naar de oorspronkelijke periode en het verschilbedrag. Een nieuwe creditnota wegens annulering of prijsvermindering hoort volgens de toelichting juist in rubriek 3 “Gegevens ICP”. Dat is dus niet hetzelfde als het herstellen van een eerder verkeerd opgegeven bedrag. Afzonderlijke correctiestatus voor ICP en btw is goed; maar classificeer ook *foutherstel* versus *nieuwe creditnota*. De huidige tekst “verbeteren in de opgaaf van die periode” moet worden verduidelijkt. Bron: [ICP-toelichting 2026, pagina 9][ICP].

### Inkomstenbelasting: vragen 11–16

**11. Lineair doortrekken: bruikbaar als indicatieve prognose, niet als gegarandeerd toereikende reserve.** Er is geen fiscale verplichting deze voorspelmethode te gebruiken. Mijn beoordeling: geschikt bij een stabiel patroon en volledige administratie, maar begin/einde onderneming, seizoenen, incidentele omzet, eenmalige kosten en bijzondere correcties vragen aanpassing. Jaarafschrijving mag niet zowel geboekt in de tussentijdse winst zitten als nogmaals volledig worden afgetrokken. Tel incidentele fiscale correcties niet zonder meer lineair op.

Een “veilige” uitkomst niet bereiken door belastingregels te wijzigen of fictieve btw te boeken. Bied desgewenst een afzonderlijke, instelbare reservebuffer en een handmatig verwachte jaarwinst. Verreken vooruitbetaalde aanslagen en al gereserveerd geld alleen bij het advies “nog opzijzetten”; houd dat apart van de geschatte jaarbelasting.

De disclaimer moet concreet de **scope onder AOW-leeftijd, Nederlands belasting-/verzekeringsregime en uitsluitend ondernemingswinst** noemen. “Nog niet gecontroleerd” is bovendien iets anders dan “gecontroleerde parameters”: geen algemene fiscale goedkeuring suggereren met `checked`.

**12. Grondslagen heffingskortingen: klopt binnen de beperkte situatie.** De algemene heffingskorting wordt vanaf 2025 gebaseerd op het **verzamelinkomen**, niet algemeen alleen op box 1. Bij uitsluitend ondernemingswinst zonder andere inkomsten/aftrekposten valt dit hier samen met de belastbare winst. Arbeidskorting gebruikt winst vóór ondernemersaftrek en mkb-winstvrijstelling. De huidige keuze `fiscal` is voor die afbakening passend. Zvw gebruikt het toepasselijke bijdrage-inkomen; met uitsluitend deze ondernemingswinst kan de belastbare winst daarvoor worden gebruikt, maar loon/pensioen en reeds gebruikte bijdragegrenzen vragen een uitgebreidere berekening. Bronnen: [AHK 2025][AHK25], [AHK 2026][AHK26], [arbeidsinkomen][ARBEID], [Zvw][ZVW].

**13. Eerst ondernemersaftrek, daarna mkb-winstvrijstelling: klopt.** De mkb-vrijstelling is 12,7% van de winst na ondernemersaftrek; voor die vrijstelling is geen urencriterium nodig. Ondernemerschap is een afzonderlijke voorwaarde. Bij hoog inkomen de tariefsaanpassing toepassen: maximaal 37,48% aftrekvoordeel in 2025 en 37,56% in 2026 voor de betreffende faciliteiten. Bij verlies verkleint de mkb-vrijstelling het fiscale verlies. Bron: [mkb-vrijstelling][MKB] en [tariefsaanpassing][TARIEF].

**14. Startersaftrek: meenemen bij recht daarop, niet als vrijblijvende fiscale keuze.** Het bedrag is €2.123 in 2025/2026 onder de hier gehanteerde leeftijdsscope. Beoordeel de voorafgaande vijf kalenderjaren, het gebruik van zelfstandigenaftrek en overige voorwaarden. Bij recht op startersaftrek wordt de zelfstandigenaftrek niet tot de winst beperkt; samen kunnen ze een verrekenbaar verlies geven. Zonder die uitzondering kan niet-gerealiseerde zelfstandigenaftrek ontstaan, met een afzonderlijke beschikking en negenjaarstermijn. Dat is iets anders dan een startersverlies. Bron: [startersaftrek][START] en [zelfstandigenaftrek 2025][ZA25].

**Concrete correctie in de huidige code bij 11–14:** `assumptionsFor()` presenteert 1.225 uur en het meer-dan-de-helftcriterium als nodig om IB-ondernemer te zijn. Dat klopt niet. Ondernemerschap, urencriterium en starteruitzondering moeten afzonderlijk worden vastgesteld. Voor starters geldt de meer-dan-de-helfteis niet wanneer zij in één van de vijf voorafgaande jaren geen ondernemer waren; de 1.225 uur blijft gelden, ook bij starten in de loop van het jaar. `ibConfirmed` komt momenteel niet als voorwaarde in `estimateIncomeTax()` terecht: de code berekent dus nog ondernemersfaciliteiten terwijl ondernemerschap alleen als onbevestigde aanname wordt getoond. Laat de GUI deze feiten simpel uitvragen en laat de engine de bijbehorende voorwaarden werkelijk toepassen. Bron: [IB-ondernemerschap][ONDERNEMER] en [urencriterium][UREN].

**15. Gevraagde tariefparameters 2025 én 2026: bevestigd voor onder AOW-leeftijd.**

| Parameter | 2025 | 2026 |
|---|---|---|
| Box 1 schijf 1 | t/m €38.441: 35,82% | t/m €38.883: 35,75% |
| Box 1 schijf 2 | t/m €76.817: 37,48% | t/m €78.426: 37,56% |
| Schijf 3 | 49,50% | 49,50% |
| Zelfstandigenaftrek | €2.470 | €1.200 |
| Mkb-vrijstelling | 12,7% | 12,7% |
| AHK maximum / afbouw vanaf / percentage | €3.068 / €28.406 / 6,337% | €3.115 / €29.736 / 6,398% |
| Arbeidskorting opbouwgrenzen | €12.169 / €26.288 / €43.071 | €11.965 / €25.845 / €45.592 |
| Arbeidskorting opbouwpercentages | 8,053% / 30,030% / 2,258% | 8,324% / 31,009% / 1,950% |
| Arbeidskorting maximum / afbouw | €5.599 / 6,510% vanaf €43.071 | €5.685 / 6,510% vanaf €45.592 |
| Zvw | 5,26%, maximum €75.864 | 4,85%, maximum €79.409 |

Bronnen: [box 1][BOX], [AHK25][AHK25], [AHK26][AHK26], [arbeidskorting 2025][AK25], [heffingskortingen 2026][HK26], [Zvw][ZVW], [ZA25][ZA25], [ondernemersaftrek 2026][OA26], [MKB][MKB].

Ook aanvullende parameters uit de huidige 2025-tabel zijn nagelopen: KIA €2.901–€70.602 28%, vervolgens €19.769 t/m €130.744, daarna afbouw 7,56% t/m €392.230; minimum per middel €450; desinvesteringsdrempel €2.900; representatiedrempel €5.700/alternatief 80%; privévervoer €0,23/km; meewerkaftrek 1,25/2/3/4% bij 525/875/1.225/1.750 uur. Bronnen: [KIA25][KIA25], [minimumbedrag][KIA-MIN], [representatie25][REPR25], [kilometers25][KM25], [meewerkaftrek25][MW25], [desinvesteringsbijtelling][DESINV].

De arbeidskortingformule in de code telt percentages doorlopend op; de gepubliceerde tabellen gebruiken afgeronde vaste beginbedragen (€980/€5.220 in 2025; €996/€5.300 in 2026). Dat kan euroverschillen geven. Voor aansluiting op de publicatietabel die beginbedragen expliciet modelleren. De bedragen zijn bevestigd; `checked: true` mag niet impliceren dat ook alle prognose-, leeftijds- en aftrekvoorwaarden zijn afgedekt. Hernoemen naar bijvoorbeeld “tariefparameters gecontroleerd” maakt dit helder.

**16. Rekenvoorbeeld €50.000 winst in 2026: het document moet worden gecorrigeerd.** Aannames: uitsluitend deze winst, onder AOW-leeftijd, IB-ondernemer, urencriterium, geen startersaftrek, KIA, meewerkaftrek of overige correcties.

| Stap | Bedrag |
|---|---:|
| Winst | €50.000,00 |
| Zelfstandigenaftrek | −€1.200,00 |
| Mkb-vrijstelling: 12,7% × €48.800 | −€6.197,60 |
| Belastbare winst | €42.602,40 |
| Box 1 vóór kortingen | €15.297,68 |
| Algemene heffingskorting | −€2.291,81 |
| Arbeidskorting bij €50.000 arbeidsinkomen | −€5.398,04 |
| IB/premies na kortingen | €7.607,83 |
| Zvw 4,85% × €42.602,40 | €2.066,22 |
| Totaal indicatief | **€9.674,05 → circa €9.674** |

De genoemde €9.445 en €7.919 heffingskortingen in het document kloppen dus niet. Definitieve fiscale afrondingen kunnen enkele euro's afwijken. De bovenstaande berekening gebruikt de officiële grondslagen en tabelwaarden uit vraag 15.

### XBRL: exact gecontroleerd tegen NT20 voor OB 2026

De officiële **NT20_BD_20251210-taxonomie en voorbeeldberichten** zijn gedownload en vergeleken met `src/btw/xbrl.ts`. De namen in de code zijn op dit punt niet juist:

| Rubriek | Correct concept vergoeding/grondslag | Correct concept btw |
|---|---|---|
| 3a | `SuppliesToCountriesOutsideTheEC` | — |
| 3b | `SuppliesToCountriesWithinTheEC` | — |
| 4a | `TurnoverFromTaxedSuppliesFromCountriesOutsideTheEC` | `ValueAddedTaxOnSuppliesFromCountriesOutsideTheEC` |
| 4b | `TurnoverFromTaxedSuppliesFromCountriesWithinTheEC` | `ValueAddedTaxOnSuppliesFromCountriesWithinTheEC` |

Ook bij 1a/1b moet de omzetnaam `TaxedTurnoverSuppliesServicesGeneralTariff` / `TaxedTurnoverSuppliesServicesReducedTariff` zijn; bij 1e `SuppliesServicesNotTaxed`.

Entrypoint OB 2026:
`http://www.nltaxonomie.nl/nt20/bd/20251210/entrypoints/bd-rpt-ob-aangifte-2026.xsd`

Namespace `bd-i`:
`http://www.nltaxonomie.nl/nt20/bd/20251210/dictionary/bd-data`

De huidige `20XX`-paden zijn placeholders. Bovendien moet de entity-identifier bij scheme `www.belastingdienst.nl/omzetbelastingnummer` het **omzetbelastingnummer** bevatten; de huidige code neemt `company.vatNumber` en noemt dat een btw-identificatienummer. Die nummers kunnen bij een eenmanszaak verschillen. Bewaar ze apart en gebruik elk voor zijn eigen doel. De juiste conceptnamen alleen maken nog geen geldig indieningsbericht: ook metadata, contexten en de Reporting Rules moeten worden gevalideerd. Het bestaande testlabel blijft nodig totdat dat traject is afgerond.

Bronbestanden: [NT20 taxonomie-ZIP][NT-ZIP], [officiële voorbeeldberichten-ZIP][NT-VB], [documentatie/filter OB 2026][NT-DOC]. Gecontroleerd in `dictionary/bd-data.xsd` en `OB-2026/VB-01_bd-rpt-ob-aangifte-2026.xbrl`.

### Uitwerking voor de app

1. De engine legt normale, gebalanceerde journaalposten en fiscale classificaties vast, met controleerbare grondslagen en originele bewijsstukken.
2. De GUI vraagt in gewone woorden om de feiten die de uitkomst bepalen: goederen/dienst, klanttype, relevante locatie, btw op factuur/verlegging, aftrekrecht en eventueel zakelijk deel.
3. Automatische herkenning en leveranciersgeheugen doen voorstellen; ontbrekende essentiële gegevens blijven zichtbaar als te beoordelen.
4. Eenvoudige schermen tonen bedragen en vervolgstappen; de boekhouder kan rubrieken, berekening en journaalpost openen.
5. Een werkelijk niet ondersteunde fiscale route wordt expliciet afgehandeld buiten de app of krijgt een gerichte blokkade. Een disclaimer vervangt geen correcte verwerking.

### Uitvoering in deze branch

- **IB:** de GUI vraagt ondernemerschap, 1.225 uur en de tweede urenvoorwaarde afzonderlijk uit. Zonder bevestigd ondernemerschap rekent de schatting geen ondernemersaftrek, mkb-vrijstelling of KIA; zonder volledige bevestiging van het urencriterium geen zelfstandigenaftrek. Het jaaroverzicht gebruikt dezelfde voorwaarden. De arbeidskorting gebruikt nu de vaste beginbedragen. De parametercontrole van 2025 is vastgelegd; het label noemt uitsluitend tariefparameters.
- **Stripe:** bij Instellingen → Koppelingen kiest de gebruiker na controle van de kostenfactuur ‘alle kosten EU-verlegd’, ‘alle kosten vrijgesteld’ of ‘onbekend/gemengd’. De oude configuratie valt op onbekend. Onbekende/gemengde kosten houden de synchronisatie tegen zonder boeking; de fout blijft zichtbaar en een volgende poging kan dezelfde uitbetalingen opnieuw lezen. Vrijgestelde kosten krijgen geen fictieve verlegde btw; bevestigde EU-verlegging blijft 4b met aftrek voor zover toegestaan.
- **Buitenlandse brongegevens:** een buitenlandse factuur zonder btw bewijst geen verlegging. Buitenlandse btw, onzekere herkomst en werkzaamheden aan onroerend goed kunnen ook met leveranciersgeheugen niet automatisch worden geboekt; de gebruiker ziet waarom controle nodig is. Een bekende leverancier overschrijft een expliciet gekozen binnenlandse verlegging niet meer.
- **OSS-keuze:** deze branch implementeert geen OSS-aangifte of buitenlandse btw-rekeningen. Buitenlandse webshop- en Mollie-orders wachten op Vandaag om zelf correct te verwerken. De koppeling boekt ze niet als Nederlandse 21%/9%/0%-omzet. Het signaal voor EU-particulieren kijkt naar het lopende én vorige kalenderjaar en zegt dat het toepasselijke soort prestatie moet worden gecontroleerd. De €10.000-toets is een signaal over bekende omzet met Nederlandse btw, geen volledige OSS-aangiftecontrole.
- **ICP:** gewone goederen en diensten blijven intern gescheiden, maar de GUI beweert niet meer dat het officiële formulier steeds twee velden vraagt. Een late nieuwe creditfactuur komt bij de gewone prestaties; herstel van een eerdere fout blijft als correctie met het oude tijdvak apart zichtbaar. De tekst verwijst daarvoor naar de volgende ICP-opgaaf. De maandgrens noemt de juiste overgang bij overschrijding in maand 1/2/3.
- **Diensttijdstip:** een ingevulde datum/einddatum van een EU-dienst bepaalt het btw- en ICP-tijdvak; de documentdatum blijft bewaard. De fiscale datum wordt in de gebeurtenis vastgelegd en blijft bij hercompileren en tegenboeken behouden. Bij een combinatie van EU-diensten en andere regels met verschillende maanden vraagt de app om aparte facturen, zodat één tijdstip niet op alle regels wordt toegepast. Goederen blijven de factuurdatum volgen. Zonder ingevulde leverdatum geldt de expliciet in het scherm genoemde aanname dat de prestatie op de factuurdatum geleverd is.
  *Bevestigd (5 oktober 2026):* de Belastingdienst schrijft in [Opgaaf ICP][ICP-OPGAAF]: "Intracommunautaire leveringen geeft u aan in het tijdvak van de factuurdatum. Intracommunautaire diensten geeft u aan in het tijdvak waarin u de dienst hebt geleverd", en het totaal van de opgaaf ICP moet gelijk zijn aan rubriek 3b van de btw-aangifte. Een factuur vóór het verrichten van de dienst (voorschot) verschuift het tijdvak dus niet; art. 13 Wet OB laat bij verlegging het tijdstip van het verrichten gelden. Dezelfde pagina bevestigt de correctieroute: een fout herstel je door in de volgende opgaaf ICP de juiste gegevens in te vullen. Niet uit een primaire bron vastgesteld: welke datum telt bij een dienst die over meerdere dagen loopt (de app neemt de einddatum).
- **Suppletie:** de termijntekst noemt acht weken bij zowel te weinig als te veel aangegeven btw; de bestaande €1.000-grens blijft gelden.
- **XBRL:** de concrete NT20-namen, namespace en entrypoint zijn hersteld. Het omzetbelastingnummer is een apart veld; er wordt niets afgeleid van het btw-id. De testexport weigert een ontbrekend nummer en andere jaren dan 2026. Volledige SBR/Reporting Rules-validatie en Digipoort-aansluiting blijven nodig vóór indiening.

Regressies staan in `tests/fiscale-review-44.test.ts` en `e2e/fiscale-review-44.spec.ts`, naast de bijgewerkte bestaande tests. Bestaande journaalposten en bevroren compilers worden niet herschreven.

**Afbakening:** deze antwoorden behandelen de oorspronkelijke vragen 1–16 inclusief 10a en de genoemde XBRL-punten. De later toegevoegde vragen 17–33 worden hiermee niet collectief als goedgekeurd aangemerkt. Een externe review van volledige praktijksituaties en de volledige XBRL-instance blijft een afzonderlijk vervolg; issue #44 blijft daarom open.

[OB]: https://download.belastingdienst.nl/belastingdienst/docs/toelichting_bij_btw_aangifte_ob0731t62fd.pdf
[DIENST]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/zakendoen_met_het_buitenland/zakendoen_buiten_de_eu/aangifte_doen_als_u_zakendoet_buiten_de_eu/aangifte_doen_als_u_diensten_levert_aan_afnemers_in_niet_eu_landen
[ICP]: https://download.belastingdienst.nl/belastingdienst/docs/toelichting-digitale-opgaaf-intracomm-pres-ob1291t62fd.pdf
[ICP-TIJD]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/zakendoen_met_het_buitenland/goederen_en_diensten_naar_andere_eu_landen/opgaaf_icp/tijdvak_opgaaf_icp/
[FACT-G]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/zakendoen_met_het_buitenland/goederen_en_diensten_naar_andere_eu_landen/factureren/extra_factuureisen_bij_goederen
[FACT-D]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/zakendoen_met_het_buitenland/goederen_en_diensten_naar_andere_eu_landen/factureren/extra_factuureisen_bij_diensten
[INK-EU]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/zakendoen_met_het_buitenland/goederen_en_diensten_afnemen_uit_andere_eu_landen/aangifte_doen/aangifte-doen-van-goederen-en-diensten-uit-andere-eu-landen
[INK-BUITEN]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/zakendoen_met_het_buitenland/zakendoen_buiten_de_eu/aangifte_doen_als_u_zakendoet_buiten_de_eu/aangifte_doen_als_u_diensten_afneemt_van_leveranciers_uit_niet_eu_landen
[STRIPE]: https://support.stripe.com/questions/global-taxation-of-stripe-fees?locale=nl-NL
[FIN]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/tarieven_en_vrijstellingen/vrijstellingen/financiele_diensten_en_verzekeringen/
[BOOKIT]: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex%3A62014CJ0607
[B2C-G]: https://www.belastingdienst.nl/wps/wcm/connect/nl/btw/content/btw-goederen-eu-particulieren
[B2C-D]: https://www.belastingdienst.nl/wps/wcm/connect/nl/btw/content/btw-diensten-particulieren
[SUPP]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/btw_aangifte_doen_en_betalen/aangifte_corrigeren/
[BOX]: https://www.belastingdienst.nl/wps/wcm/connect/nl/werk-en-inkomen/content/hoeveel-inkomstenbelasting-betalen
[AHK25]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/prive/inkomstenbelasting/heffingskortingen_boxen_tarieven/heffingskortingen/algemene_heffingskorting/tabel-algemene-heffingskorting-2025
[AHK26]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/prive/inkomstenbelasting/heffingskortingen_boxen_tarieven/heffingskortingen/algemene_heffingskorting/tabel-algemene-heffingskorting-2026
[ARBEID]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/prive/inkomstenbelasting/heffingskortingen_boxen_tarieven/heffingskortingen/arbeidskorting/inkomen_uit_werk
[ZVW]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/prive/werk_en_inkomen/zorgverzekeringswet/veranderingen-bijdrage-zvw/
[MKB]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/inkomstenbelasting/inkomstenbelasting_voor_ondernemers/mkb_winstvrijstelling
[TARIEF]: https://www.belastingdienst.nl/wps/wcm/connect/nl/aftrek-en-kortingen/content/afbouw-tarief-aftrekposten-bij-hoog-inkomen
[START]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/inkomstenbelasting/inkomstenbelasting_voor_ondernemers/ondernemersaftrek/startersaftrek
[ZA25]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/inkomstenbelasting/verandering_inkomstenbelasting_vorige_jaren/veranderingen-inkomstenbelasting-2025/ondernemersaftrek-2025/zelfstandigenaftrek-2025
[OA26]: https://www.belastingdienst.nl/wps/wcm/connect/fisin/fisin2026/ondernemersaftrek_en_investeringsaftrek
[ONDERNEMER]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/inkomstenbelasting/wanneer_bent_u_ondernemer_voor_de_inkomstenbelasting/
[UREN]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/inkomstenbelasting/inkomstenbelasting_voor_ondernemers/voorwaarden_urencriterium
[AK25]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/prive/inkomstenbelasting/heffingskortingen_boxen_tarieven/heffingskortingen/arbeidskorting/tabel-arbeidskorting-2025
[HK26]: https://www.belastingdienst.nl/wps/wcm/connect/fisin/fisin2026/heffingskortingen
[KIA25]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/inkomstenbelasting/verandering_inkomstenbelasting_vorige_jaren/veranderingen-inkomstenbelasting-2025/investeringsaftrek-2025/kleinschaligheidsinvesteringsaftrek-2025
[KIA-MIN]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/inkomstenbelasting/inkomstenbelasting_voor_ondernemers/investeringsaftrek_en_desinvesteringsbijtelling/geen_recht_op_investeringsaftrek
[REPR25]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/inkomstenbelasting/verandering_inkomstenbelasting_vorige_jaren/veranderingen-inkomstenbelasting-2025/drempel-beperkt-aftrekbare-kosten-2025
[KM25]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/inkomstenbelasting/verandering_inkomstenbelasting_vorige_jaren/veranderingen-inkomstenbelasting-2025/zakelijk-gebruik-privevervoermiddel-2025
[MW25]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/inkomstenbelasting/verandering_inkomstenbelasting_vorige_jaren/veranderingen-inkomstenbelasting-2025/ondernemersaftrek-2025/meewerkaftrek-2025
[NT-ZIP]: https://www.sbr-nl.nl/sites/default/files/bestanden/taxonomie/NT20_BD_20251210%20Taxonomie_.zip
[NT-VB]: https://www.sbr-nl.nl/sites/default/files/bestanden/taxonomie/NT20_20251210%20Voorbeeldberichten.zip
[NT-DOC]: https://www.sbr-nl.nl/werken-met-sbr/taxonomie/documentatie-nederlandse-taxonomie?organisatie=481

[DESINV]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/winst/inkomstenbelasting/inkomstenbelasting_voor_ondernemers/investeringsaftrek_en_desinvesteringsbijtelling/desinvesteringsbijtelling

**Rekenvoorbeeld € 50.000 (vraag 16), nagelopen op officiële bronnen (5 oktober 2026):** het voorbeeld klopt. Arbeidsinkomen is volgens de Belastingdienst ([inkomen uit werk][ARBEID]) de winst *vóór* ondernemersaftrek en mkb-winstvrijstelling, dus € 50.000: arbeidskorting € 5.685 − 6,51% × (€ 50.000 − € 45.592) = € 5.398. De algemene heffingskorting rekent met het verzamelinkomen (€ 42.602): € 3.115 − 6,398% × (€ 42.602 − € 29.736) = € 2.292. Samen € 7.690. Box 1: 35,75% × € 38.883 + 37,56% × (€ 42.602 − € 38.883) = € 15.298; er is geen tariefsaanpassing omdat het tweede tarief (37,56%) gelijk is aan de aftrekgrens van 2026. Zvw: 4,85% over de belastbare winst na ondernemersaftrek en mkb-winstvrijstelling (€ 42.602) = € 2.066. Totaal € 15.298 − € 7.690 + € 2.066 = € 9.674. De percentages van de Zvw en het maximumbijdrage-inkomen (€ 79.409) staan op de [Zvw-pagina][ZVW]; dat het bijdrage-inkomen van een ondernemer de belastbare winst na deze aftrekposten is, volgt uit meerdere secundaire bronnen en niet uit een pagina van de Belastingdienst die het letterlijk zegt.
[ICP-OPGAAF]: https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/zakendoen_met_het_buitenland/goederen_en_diensten_naar_andere_eu_landen/opgaaf_icp/opgaaf_icp
