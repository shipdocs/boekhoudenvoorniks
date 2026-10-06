# Wijzigingen

## Nog niet uitgebracht

### Verbeterd
- **Uren alleen zichtbaar als je op het urencriterium rekent.** Het tabblad Uren en de urenkaart in Aftrek & investeringen verschijnen alleen als je bij Instellingen hebt aangegeven dat je de 1.225 uur claimt (zelfstandigenaftrek/startersaftrek). Al ingevoerde uren blijven bewaard en komen terug zodra je de instelling aanzet. Werkbonuren op klussen blijven gewoon werken (#319).
- **Verlegde btw: tarief 9% of 21%.** Bij een inkoop met verlegde btw (Nederlandse verlegging, EU of buiten de EU) kies je nu het tarief van wat je kocht: 21% (standaard) of 9% als het onder het verlaagde tarief valt, bijvoorbeeld boeken, e-books of voedingsmiddelen. Rubriek 2a/4a/4b en de aftrek in 5b volgen het gekozen tarief. Bij software, advertenties en advies blijft het 21%. Bestaande boekingen en eerdere jaren veranderen niet. De keuze staat bij Aankoop toevoegen en bij het controleren van een bon of factuur; bij een betaling die je rechtstreeks vanuit de bank boekt is hij er nog niet (#316).
- **Bijtelling auto ouder dan 15 of 16 jaar.** Tot en met 2025 gold de bijtelling van 35% van de waarde in het economisch verkeer voor een auto ouder dan 15 jaar, vanaf 2026 voor een auto ouder dan 16 jaar. De app rekende voor alle jaren met 16 jaar; nu per belastingjaar het juiste aantal.
- **Extra aftrek voor zuinige en milieuvriendelijke aankopen (EIA/MIA/Vamil): juiste termijn.** Je vraagt dit aan binnen 3 maanden na de dag dat je bestelde, niet na de factuur- of betaaldatum. De app telt nu drie kalendermaanden vanaf de aankoopdatum (was 91 dagen) en zegt erbij dat je minder tijd hebt als je eerder bestelde.
- **Startersaftrek 2027 en later is een voorstel.** In het overzicht voor 2027 en later staat nu dat de verlaging van de startersaftrek naar € 10 (2027) en € 0 (2028) een voorstel in het Belastingplan 2027 is dat nog niet is aangenomen.
- **Uren per week of maand invoeren.** Bij Belasting → Uren kies je nu "Per week" of "Per maand" (eerder ingevoerde losse dagen blijven staan). Regels kun je bewerken, en je kunt er meerdere selecteren om in één keer weg te halen. Zo leg je ook uren vast uit de tijd voordat je de app gebruikte, bijvoorbeeld 120 uur voor een hele maand; eerder gaf de app "tussen 0 en 24" aan. Je kunt een regel laten herhalen (elke week of elke maand tot een datum). Een week over de jaargrens wordt netjes verdeeld over twee jaren. De app waarschuwt als er in die periode al uren staan (ook op werkbonnen), of als het gemiddeld meer dan 16 uur per dag zou zijn, en toont hoeveel uur per week je nog nodig hebt voor de 1.225 en wanneer je dat op je tempo haalt (#311).
- **Mail en bank ophalen vanaf Vandaag.** Bovenaan Vandaag staan knoppen om je mail en je bank (Ponto) op te halen, alleen voor wat is ingesteld. Na afloop blijft een melding staan met het tijdstip, wat het opleverde of waarom het niet lukte. Bij Bank → Ponto geldt hetzelfde voor Nu bijwerken en Nu ophalen, en de foutcode bij een rekening is nu uitgeschreven.
- **Schatting inkomstenbelasting: voorwaarden apart bevestigen.** Ondernemerschap, het urencriterium (1.225 uur) en de tweede voorwaarde (meer tijd aan je bedrijf dan aan ander werk, of de starteruitzondering) bevestig je nu afzonderlijk bij Instellingen. Zolang dat niet is gedaan, rekent de schatting zonder mkb-winstvrijstelling, KIA en ondernemersaftrek: **je ziet daardoor na deze update een hoger bedrag dan eerst**, met een melding wat je moet bevestigen. De arbeidskorting rekent met de vaste beginbedragen van de Belastingdienst; de tabel van 2025 is gecontroleerd.
- **Buitenlandse btw is niet meer automatisch verlegd.** Een buitenlandse factuur zonder btw krijgt geen verlegde btw en geen 21% voorbelasting meer als voorstel: de btw blijft leeg tot je kiest. Webshoporders van buiten Nederland boek je zelf. Stripe-uitbetalingen worden pas geboekt als je bij Instellingen → Koppelingen aangeeft welke btw voor je Stripe-kosten geldt (bestaande Stripe-gebruikers krijgen tot dan een melding).
- **EU-diensten volgen de leverdatum.** Voor btw en ICP telt de dienst- of einddatum van een EU-dienst; de factuurdatum blijft bewaard. Een EU-dienst in een ander tijdvak dan de overige regels moet op een aparte factuur. Het onderscheid met een creditnota en een correctie van een eerdere periode in de ICP-opgaaf is aangepast.
- **Controles en uitleg.** De OSS-signalering kijkt ook naar het vorige kalenderjaar, de ICP-maandgrens en de suppletietermijn (acht weken) zijn aangepast, en de XBRL-testexport gebruikt de taxonomie voor 2026 met een apart omzetbelastingnummer.
- **Saldocontrole bij een overboeking tussen eigen rekeningen.** Staat een overboeking al in je boekhouding via de andere rekening, maar is het afschrift van deze rekening nog niet ingelezen, dan telt dat bedrag mee en staat het apart vermeld in het bankoverzicht. De saldocontrole meldt dan geen verschil meer. De btw-controle op de rekening-courant met de Belastingdienst legt nu ook uit wat het verschil betekent bij een teruggave die nog niet is uitbetaald.
- **Mollie: duidelijkere foutmelding.** Geeft de server van een aanbieder een foutpagina (HTML) terug, dan zegt de app dat het aan de aanbieder ligt en dat je het later kunt proberen, in plaats van een stuk paginacode te tonen. Bij Mollie heet het veld nu "Advanced-access-token" met de scope "settlements.read".

## 1.3.0 — fiscale controles en jaarafsluiting voor je boekhouder

Deze versie komt uit een review door een boekhouder-expert: meer controles op btw en inkomstenbelasting, een begeleide jaarafsluiting, en een betere aansluiting op wat de Belastingdienst vraagt.

### Nieuw
- **KOR: bewaking van de omzetgrens van € 20.000.** Gebruik je de kleineondernemersregeling, dan waarschuwt de app op Vandaag en bij Belasting zodra je omzet dit jaar bij € 16.000 komt, en nogmaals zodra hij boven € 20.000 komt: dan vervalt de KOR per direct. De omzet wordt geteld zoals de Belastingdienst het doet (omzet tegen 21%, 9% en 0%, uitvoer, leveringen naar andere EU-landen, nationale verlegging en wat onder de KOR valt; niet: diensten die elders belast zijn, zoals EU-diensten aan bedrijven).

- **Datum van levering of dienst op je factuur.** Een gewone btw-factuur moet de datum noemen waarop je leverde of de dienst verrichtte. In de factuureditor staat nu "Datum levering of dienst" (en "t/m" voor een periode, bijvoorbeeld bij een klus van meerdere weken). Laat je het leeg, dan staat de factuurdatum erop. Onder de KOR hoeft het niet: daar staat het er alleen als je het zelf invult. In de e-factuur (UBL) gaat een eigen datum mee als leveringsdatum en een periode als factuurperiode.

- **KOR en diensten of goederen naar het buitenland.** Onder de KOR kies je bij uitvoer buiten de EU de KOR-vrijstelling (niet "0% uitvoer"). Een dienst aan een bedrijf in een ander EU-land kun je wel met "btw verlegd" factureren: die valt buiten de Nederlandse KOR en vraagt jouw btw-nummer én dat van de klant. De factuur noemt dan niet de KOR, en de app waarschuwt dat daar btw-aangifte en ICP-opgaaf bij horen.
- **VIES-verwijzing bij EU-klanten.** Bij een bedrijf in een ander EU-land en op het Belasting-scherm staat nu een link naar de EU-controle van btw-nummers (VIES). Bij de klant kun je ook op "Controleer nu in VIES" klikken: dan stuurt de app dat ene btw-nummer naar de gratis EU-dienst en bewaart de uitslag met datum. Dat gebeurt nooit vanzelf.
- **Bijtelling auto van de zaak in je inkomstenbelasting.** Rijd je privé in een auto van de zaak, dan telt de app 22% van de cataloguswaarde (maximaal de autokosten) bij je winst, in het Belastingoverzicht, de schatting en de belastingreserve. Ontbreken er gegevens, dan staat dat er duidelijk bij: de schatting is dan te laag. Het percentage kun je aanpassen bij Instellingen → Btw.
- **Verlegde btw in een correctieboeking.** Bij een memoriaalboeking kun je per regel de btw-code kiezen (verlegd binnenland, EU of buiten de EU). De grondslag komt dan in rubriek 2a, 4a of 4b van de aangifte. De app controleert dat de verschuldigde btw (21% of 9%) er ook bij staat. Dit werkt ook in een antwoord van je boekhouder.
- **Oninbare facturen: btw terugvragen.** Staat een factuur een jaar na de vervaldatum nog open, dan meldt de app bij de btw-controle dat je de btw mag terugvragen. Bij de factuur kies je "Afboeken als oninbaar": de omzet en de btw over het openstaande deel gaan terug in de aangifte van die periode (rubriek 1a of 1b). Komt er later alsnog betaling, dan geeft de app de btw over dat deel opnieuw aan. Een inkoop die je een jaar na de vervaldatum nog niet betaalde, kun je met "Btw terugnemen" afhandelen: de afgetrokken btw over het openstaande deel gaat terug in de aangifte, en betaal je later alsnog, dan trekt de app die btw weer af.
- **Schatting inkomstenbelasting: rechtsvorm en ondernemerschap.** Bij Instellingen geef je je rechtsvorm op en bevestig je dat je ondernemer voor de inkomstenbelasting bent (urencriterium en meer dan de helft van je werktijd). Zolang dat niet is bevestigd, staat er bij de schatting wat ze veronderstelt. Bij een vof of maatschap rekent de schatting met jouw deel van de winst; bij een bv maakt de app geen schatting.
- **Beoordelingstaken bij bijzondere investeringen.** De btw-controle meldt nu drie situaties die de app niet zelf beoordeelt: je gebruikt de KOR en hebt bedrijfsmiddelen van de laatste 5 jaar (herziening btw-aftrek: de app rekent een vijfde van de afgetrokken btw per jaar uit en past de grens van € 500 toe, zoals de Belastingdienst het voorrekent), een bedrijfsmiddel is naar privé gegaan (btw over de onttrekking), en een creditnota hoort bij een bedrijfsmiddel uit een eerder jaar (afschrijving en investeringsaftrek van dat jaar). De app boekt of herrekent niets stilzwijgend.
- **Begeleide jaarafsluiting.** Sluit je een jaar af (t/m 31 december), dan vraagt de app naar vooruitbetaalde kosten, nog te betalen kosten, voorraad en onderhanden werk, de posten die je winst veranderen zonder dat er een bon bij hoort. Bij "Posten invullen" vul je soort, omschrijving en bedrag in; de app boekt het op 31 december en draait het op 1 januari automatisch om. Heb je niets van dit alles, dan bevestig je dat bij het afsluiten. De waardering (vooral van onderhanden werk) bepaal je zelf of met je boekhouder.
- **Bijtelling auto: meerdere auto's en oude auto's.** Bij Instellingen → Btw kun je de eerste tenaamstelling, de einddatum en een extra auto van de zaak opgeven. De bijtelling gaat dan per maand naar rato, en een auto ouder dan 16 jaar telt 35% van de dagwaarde in plaats van 22% van de cataloguswaarde, vanaf de maand waarin hij 16 jaar wordt.
- **Waarschuwing bij EU-verkoop zonder VIES-controle.** Een levering zonder btw naar een bedrijf in een ander EU-land (of verlegde btw) vraagt een geldig btw-nummer. De btw-controle meldt nu verkopen waarvan het nummer niet in VIES is gecontroleerd, en sterker als VIES het nummer niet kent.
- **Openstaande facturen naar ouderdom.** Op "Hoe gaat het?" staat bij "Wie moet nog betalen?" de indeling: nog niet vervallen, 1-30, 31-60, 61-90 en meer dan 90 dagen te laat.
- **Waarschuwing bij de factuurdatum.** In de factuureditor meldt de app een datum in de toekomst, of een datum vóór die van de vorige definitieve factuur. Alleen een signaal; vooruit of terugdateren mag.
- **Kosten die opvallen tegenover vorig jaar.** Op "Hoe gaat het?" staan kostensoorten die dit jaar tot nu minstens € 250 en minstens de helft meer of minder zijn dan dezelfde periode vorig jaar.
- **Privé bij het afsluiten.** Bij een periode afsluiten zie je de stand van privé-opnamen en -stortingen dit jaar, met grote stortingen (vanaf € 1.000), want de Belastingdienst vraagt waar dat geld vandaan komt. Het blokkeert niets.
- **Afwijkend bedrag bij een leverancier.** Staat er een bon of factuur met een bedrag dat minstens drie keer en € 100 boven het gebruikelijke bedrag van die leverancier ligt (na minstens drie eerdere aankopen), dan controleert de app hem eerst en boekt hem niet vanzelf.

### Verbeterd
- **KOR: goederen aan een EU-bedrijf.** Onder de KOR kies je ook hier "Geen btw (vrijgesteld of KOR)": de factuur noemt de KOR, niet "Intracommunautaire levering", en de levering komt niet in rubriek 3b of de opgaaf ICP. De omzet telt wel mee voor de KOR-grens.
- **KOR: "Btw verlegd" is niet meer te kiezen.** Met de kleineondernemersregeling lever je vrijgesteld van btw; je kiest dan "Geen btw (vrijgesteld of KOR)" en de factuur noemt de KOR. De app weigert nu "Btw verlegd" bij een factuur of een verkoop via de bank onder de KOR.
- **Inkomstenbelasting 2026: bedragen gecontroleerd.** Alle bedragen van 2026 (schijven, heffingskortingen, Zvw, zelfstandigen- en startersaftrek, MKB-winstvrijstelling, KIA, representatie, kilometervergoeding) zijn nagelopen op belastingdienst.nl. De app meldt daarom voor 2026 niet meer dat de tabel nog niet is nagekeken.

## 1.2.0 — je bank automatisch ophalen met Ponto

Deze versie voegt een optionele koppeling met Ponto toe. Je afschriften blijven de basis en de terugval.

### Nieuw
- **Bank automatisch ophalen met Ponto (optioneel).** Naast het inlezen van afschriften kun je je zakelijke bank laten ophalen via Ponto, een afzonderlijke zakelijke dienst waar je zelf een overeenkomst mee sluit. Een wizard op Bank (en in Instellingen onder Koppelingen) leidt je in vijf stappen langs Ponto: account, bank, een eigen koppeling met alleen rekeninginformatie, en het plakken en testen van je Client ID en Client Secret. Wat Ponto kost, welke banken het ondersteunt en of je bedrijf wordt toegelaten, bepaalt Ponto. Per rekening kies je waar die in je administratie hoort; de app zegt erbij tot welke datum de betalingen bewezen aansluiten op je afschriften en vraagt een ontbrekende periode te onderbouwen met een afschrift of openingssaldo. Een betaling die al uit een afschrift is ingelezen, komt niet dubbel binnen. Client ID en Client Secret staan versleuteld in de veilige opslag van je computer en gaan nooit mee in een pakket of kopie voor je boekhouder. Gewoon ophalen gaat rechtstreeks tussen de app en Ponto; ShipDocs ziet niets. Alleen als je op *Nu bijwerken* klikt, vraagt de app eerst je publieke IP-adres op bij Cloudflare en stuurt het aan Ponto (dat vereist Ponto); de app bewaart en logt het niet, en daarna kan het 30 minuten niet opnieuw. Loopt je toestemming bij Ponto binnen 14 dagen af, of is die verlopen, dan staat er een taak op Vandaag. Ontkoppelen wist de inloggegevens op je computer en laat je betalingen staan. Stappenplan: `docs/bank-ophalen-ponto.md`.
- **Al betaald, via je bank: de app onthoudt het nu.** Kies je bij een aankoop "Via <je zakelijke rekening>", dan blijft de aankoop open, maar Vandaag zegt niet meer dat hij te laat betaald is zolang het afschrift van die rekening nog niet tot die dag is ingelezen: je ziet "wacht op het afschrift van …". Lees je het afschrift in en komt de betaling erin, dan koppelt de app hem (of vraagt hij of ze bij elkaar horen). Staat hij er na een compleet afschrift niet in, dan telt de aankoop weer als gewoon open. Er wordt niets geboekt, dus ook niets dubbel (#239).

## 1.1.1 — een oudere versie opent geen administratie van een nieuwere versie meer

Deze versie beschermt je administratie: opent een oudere versie van het programma een administratie die met een nieuwere versie is gemaakt, dan stopt hij eerst en wijzigt hij niets.

### Nieuw
- **Een administratie van een nieuwere versie wordt niet meer stil geopend**: de app meldt dat de administratie met een nieuwere versie is gemaakt en laat je kiezen: het programma bijwerken, een andere administratie openen of afsluiten. De administratie zelf blijft ongewijzigd, ook bij het overzetten naar de Store-versie en bij wisselen van administratie. Dit werkt in deze versie en nieuwer; oudere versies kunnen dit niet meer leren.
- **Al betaald, via je bank**: bij een aankoop die je al van je zakelijke rekening betaalde, kies je nu die rekening. De aankoop blijft open tot je het afschrift inleest en je ziet tot wanneer elk afschrift compleet is. Zo wordt de betaling nooit dubbel geboekt.

### Verbeterd
- **Btw: waarom wijkt het bedrag af?** Verschilt het bedrag in de samenvatting van het vak "te betalen of terug te vragen" in de aangifte, dan legt de app uit dat de bedragen per vak op hele euro's worden afgerond, in jouw voordeel, en dus niet het totaal.

## 1.1.0 — bank en bonnen horen bij elkaar: geen dubbele kosten meer

Deze versie zorgt dat een betaling op je bank en de bon of factuur ervan niet meer los van elkaar in je boeken komen. Past iets bij elkaar, dan vraagt de app het eerst.

### Nieuw

- Een betaling die bij een aankoop hoort die er al staat, boekt de app niet meer vanzelf als losse kosten, ook niet als het bedrag door de koers iets anders is. Je krijgt eerst de vraag of ze bij elkaar horen (#221).
- Staat een aankoop op privé of contant betaald en komt de afschrijving daarna toch op je rekening binnen, dan vraagt de app eerst of het dezelfde betaling is, ook als het bedrag een paar cent afwijkt (#222).
- Staat een aankoop op "weet ik nog niet" en komt de betaling binnen, dan vraagt de app eerst of ze bij elkaar horen. Bij "Ja" sluit de betaling de aankoop af en komt er geen tweede post bij (#223).
- Bij een betaling aan je eigen bedrijf stelt de app Privé voor, ook als je hem via de gewone bankindeling verwerkt. Staat er al een aankoop die erbij past, dan vraagt de app eerst of ze bij elkaar horen (#230).
- Een bon en de factuur van dezelfde aankoop worden niet meer twee aankopen als het bedrag een paar cent verschilt of de leverancier net anders geschreven is: bij hetzelfde nummer vraagt de app eerst of het dezelfde aankoop is, met beide bedragen erbij. Dat gebeurt nu ook als je een aankoop met de hand invoert of bij het controleren van een bon zelf het nummer of de leverancier verbetert, en bij een bon met een datum in de toekomst krijg je een waarschuwing. Zet een leverancier op elke factuur hetzelfde nummer, dan blijft die vraag weg (#224).
- Dezelfde betaling uit twee afschriften die hem net anders opschrijven (bijvoorbeeld "Card Payment: Printhuis" en "Printhuis") komt er niet meer twee keer in. Staat hij er al dubbel in, ook met een dag verschil tussen de twee afschriften, dan meldt de app dat op Vandaag en deel je de dubbele regel pas in na je antwoord. Een regel die je als dubbel negeert telt niet meer mee in de saldocontrole; dat kan nu ook bij een regel die je eerder al had genegeerd (#225).
- "Bank bijgewerkt t/m" telt een dag pas mee als je het afschrift ná die dag hebt ingelezen: een afschrift van vandaag mist wat er later vandaag nog bij komt. Sluit je een periode af met alleen een afschrift van de laatste dag zelf, dan vraagt de app eerst om een later afschrift of om je bevestiging. Begint je volgende afschrift pas een dag later, dan telt die dag nog steeds niet mee: de app zegt welke dag er nog in een afschrift moet staan. Een betaling van vandaag staat er meteen in, maar vanzelf boeken doet de app pas een dag later (#226).
- Krijg je geld terug van een leverancier en staat de creditnota al in de app, dan vraagt de app of ze bij elkaar horen in plaats van "Waar is dit geld voor?"; het telt dan niet als omzet. Ook PayPal, Adyen, SumUp en Klarna worden nu als betaaldienst herkend, en staan de verkopen daarvan al in de app, dan stelt de app bij de uitbetaling geen tweede verkoop meer voor. Het rekeningnummer op een factuur telt mee bij het koppelen van de betaling, maar passen er meer aankopen of meer betalingen bij elkaar, dan koppelt de app niet vanzelf en kies jij. Op het scherm van een betaling kun je geld dat binnenkomt zelf bij een open creditnota zetten (ook bij een andere naam of een deel van het bedrag) of als uitbetaling van de betaaldienst verwerken, en past een creditnota precies, dan beantwoord je eerst die vraag voordat het omzet kan worden. Creditnota's die door een eerdere versie op betaald stonden terwijl er nog geld terug moest komen, staan weer open. Je kunt bij een aankoop niet meer betalen dan er open staat, en een vaste last boekt de app pas vanzelf als je die leverancier al drie keer hetzelfde hebt ingedeeld; de knop "Ja, vaste last" zegt het erbij als dat zo is (#227).
- Stuur je een mail met een factuur nog eens door naar je administratie-mailbox terwijl die factuur er al in staat, dan komt er geen "Mail van …" meer op Vandaag en maakt de app er geen tweede bon van. Staat er in de doorgestuurde mail een andere bon of factuur (een ander bedrag of nummer, of een andere afzender), dan verwerkt de app die gewoon, ook als het onderwerp hetzelfde is. Een mail van je eigen adres telt nooit als mail van een klant, ook niet als je eigen bedrijf als klant in de app staat (#229).
- Een verkoop aan je eigen bedrijf die via een koppeling binnenkomt (Mollie Facturen, WooCommerce of Shopify), bijvoorbeeld een proefabonnement op je eigen dienst, boekt de app niet meer vanzelf als omzet. Je krijgt op Vandaag de vraag wat het was: geen omzet (dan komt er geen omzet en geen btw bij en telt het geld van de betaaldienst als privé-storting) of toch een echte verkoop. Staat er al geld op je bank dat de betaling kan zijn, dan kies je erbij of dat dit geld is; alleen met het nummer van de verkoop in de omschrijving weet de app dat zelf. Komt de uitbetaling van de betaaldienst binnen terwijl de vraag nog open staat, dan zegt de app dat je die eerst beantwoordt. Koos je per ongeluk "Geen omzet", draai dan de boeking terug: de vraag komt dan terug (#231).
- Mollie Facturen: een factuur met prijzen inclusief btw kwam te hoog binnen, omdat de app de btw er nog eens bovenop zette (€ 10,89 werd € 13,18). De app leest nu of de prijzen inclusief of exclusief btw zijn, en het bedrag bij de betaaldienst is wat je klant betaalde. Weet de app niet zeker hoe de prijzen bedoeld zijn, dan boekt hij niets en vraagt hij het op Vandaag, met alleen de keuze die bij het betaalde bedrag past. Een korting op de factuur leest de app mee. Komt hij met de regels toch niet op het betaalde bedrag uit, of kan hij een btw-tarief niet lezen, dan boekt hij niets en staat dat op Vandaag (ook als de app vanzelf bijwerkt), met de knop "Ik boek hem zelf". Een factuur die al te hoog is ingelezen verbeter je door hem terug te draaien en de creditfactuur definitief te maken: bij het volgende bijwerken vraagt de app of hij hem opnieuw mag inlezen, zodat de omzet er maar één keer in staat. De melding dat je klant te veel betaalde zegt in de tussentijd niet dat je het moet terugbetalen, maar verwijst naar het bijwerken (#228).

## 1.0.1 — klaar voor de Microsoft Store

Voor de gewone Windows-versie (`Setup.exe`) en Linux verandert er in deze versie niets; het is de eerste versie die ook als Store-pakket is gebouwd.

### Techniek
- **Pakket voor de Microsoft Store (binnenkort in de Store)**: de app kan nu ook als Store-pakket (MSIX/appx) gebouwd worden, in een eigen job die het pakket alleen als artefact bewaart; het komt nooit bij de GitHub-release. Voor de gewone Windows-versie (`Setup.exe`) en voor Linux verandert er niets. In de Store-versie gaat een aantal dingen anders:
  - **Updates** komen via de Store; de app zoekt of downloadt zelf niets, en Instellingen legt dat uit.
  - **Bonnen lezen op deze computer** staat standaard uit. Aanzetten kan pas nadat je er uitdrukkelijk ja op zegt; de app downloadt dan altijd dezelfde, gecontroleerde versie van het leesprogramma (llama.cpp b11146) en start het niet als het bestand afwijkt.
  - **Koppeling met Claude Code of Codex** gebruikt een vaste naam (`boekhoudenvoorniks.exe`) die bij een update niet verandert.
  - **Lukt het overzetten van je gegevens niet**, dan werkt de app niet verder in de oude map: je kiest opnieuw proberen, zelf een map kiezen, of je administratie alleen bekijken. Een zelf gekozen map wordt net zo beoordeeld als bij Instellingen → Administraties → *Waar je gegevens staan* (een lege map, met een waarschuwing bij OneDrive, Dropbox, iCloud en Google Drive); een map onder AppData kan in de Store-versie niet.
  - **Staat er een oude installatie van de website naast**, dan vraagt de app bij het starten of die weg mag, met een knop die het verwijderprogramma van die versie opent (Windows vraagt zelf om toestemming). Er wordt nooit vanzelf iets verwijderd en je administratie blijft staan. Met *Niet meer vragen* is het afgedaan. Staat er niets naast, dan komt er geen melding.
  - **De oude map in AppData wordt niet meer hernoemd** (dat mag een Store-app niet); hij blijft staan onder zijn eigen naam, met een duidelijke uitleg.
  - Werkt het lezen van bonnen of de koppeling niet, dan verwijst de melding naar de gewone Windows-versie op GitHub.
  - Het pakket heeft hetzelfde versienummer als de app (app 1.0.0 → pakket 1.0.0.0).
  - Staan je gegevens in een map onder AppData (een eerder zelf gekozen map), dan waarschuwt de Store-versie bij het starten: wat hij daar neerzet, verdwijnt als je de app verwijdert.

## 1.0.0 — geen dubbele bonnen of betalingen meer, je gegevens waar jij wilt

Versie 1.0: de app is de afgelopen maanden uitgegroeid tot een complete administratie. Deze versie maakt het inlezen van bonnen en bankafschriften betrouwbaarder en laat je zelf kiezen waar je gegevens staan.

### Nieuw
- **Dezelfde bon twee keer toevoegen kan niet meer ongemerkt**: voeg je precies hetzelfde bestand nog een keer toe, dan zegt de app *Dit document stond er al in* en kun je met *Bestaand document bekijken* het document openen dat er al was. Er komt niets bij en er verandert niets. Dat geldt overal: bij Aankopen & bonnetjes, bij *Bon toevoegen* bij een aankoop of betaling, en bij bijlagen uit je mail (dan staat de melding op Vandaag).
- **Eerst vragen, dan pas koppelen**: was de betaling van een bon al rechtstreeks als kosten geboekt, dan koppelde de app de bon stil als bewijs. Nu vraagt hij het: *Deze betaling is al geboekt. Wil je deze bon alleen als bewijsstuk koppelen?* Ja: alleen het bewijs komt erbij, er komt geen nieuwe kosten- of btw-boeking. Nee: de bon controleer je als een nieuwe aankoop. Later: er verandert niets.
- **Mogelijk dubbel: beide naast elkaar**: lijkt een bon op iets dat er al staat, dan zie je de nieuwe bon en de bestaande naast elkaar (of, als er geen bon bij zit, leverancier, datum, bedrag en nummer van de aankoop). Je kiest *Ja, dezelfde aankoop*, *Nee, andere aankoop* of *Later*. Zolang je niet gekozen hebt, wordt de bon niet geboekt. Zeg je nee, dan stelt de app dezelfde aankoop niet opnieuw voor, tenzij leverancier, datum, bedrag of nummer van de bon verandert.
- **Koppeling ongedaan maken**: een bon die als bewijs of als kopie ergens bij hoort, kun je daar weer afhalen. Hij gaat terug naar *Nog controleren*; de aankoop of de geboekte betaling zelf (kosten, btw en boeking) blijft precies zoals hij is. Een bon die al ergens bij hoort kun je pas bij iets anders zetten nadat je dat gedaan hebt.
- **Zelf kiezen waar je gegevens staan** (Instellingen → Administraties → *Waar je gegevens staan*): wil je je administratie op een andere schijf of in een andere map, kies dan een lege map. De app start opnieuw, kopieert je administraties, bijlagen en back-ups erheen en controleert de kopie voordat hij hem gebruikt; je ziet de voortgang en kunt stoppen. De map die je gebruikte blijft staan, er wordt niets gewist. Lukt het niet (bijvoorbeeld door te weinig ruimte), dan verandert er niets en werk je verder vanuit de oude map.
- **Een map met een administratie openen**: kies je een map waarin al een complete administratie van BoekhoudenVoorNiks staat, dan opent de app die; je huidige gegevens gaan dan niet mee en blijven staan. Een map met andere bestanden, of met een administratie die niet compleet is, wordt geweigerd met een duidelijke melding. De app opent nooit stil een lege administratie.
- **Waarschuwing bij OneDrive, Dropbox, iCloud en Google Drive**: zo'n dienst kopieert bestanden terwijl de app ermee werkt, en daar kan je administratie van beschadigen. De app waarschuwt als je zo'n map kiest; je kunt hem dan toch gebruiken, maar alleen als je dat bewust aanvinkt.
- **Terug naar de standaardmap**: met één knop gaan je gegevens terug naar `BoekhoudenVoorNiks` in je thuismap. Wat daar nog stond, wordt bewaard in een aparte map.
- **Opgeslagen wachtwoorden blijven werken** na het wisselen (e-mail en andere koppelingen), en de koppeling met Claude Code of Codex leest dezelfde map als de app; start dat programma na het wisselen één keer opnieuw. Laat de standaardmap staan, ook als je een andere map gebruikt: de app bewaart daar de sleutel van je opgeslagen wachtwoorden.
- **Bonnenmap** (Instellingen → Bonnenmap; standaard uit): kies een map op je computer, bijvoorbeeld een map die Syncthing of Google Drive gelijk houdt met je telefoon. Nieuwe bestanden in die map (jpg, png, pdf en e-facturen in xml) komen vanzelf bij *Aankopen & bonnetjes* en wachten daar op je controle; er wordt niets vanzelf geboekt. Daarna verplaatst de app ze naar de submap `verwerkt`. Er wordt nooit iets verwijderd of overschreven. Een bestand dat nog geschreven wordt, pakt de app pas op als het een paar seconden niet meer verandert, en een bestand dat je al had, komt er niet dubbel in.
- **Afschriften uit je downloadmap** (gratis, standaard uit; Bank → *Afschriften vanzelf inlezen*): zet het aan en de app kijkt in je Downloads-map, of een map die je zelf kiest, naar nieuwe bankafschriften. Je downloadt het afschrift bij je bank zoals je gewend bent; op Vandaag staat dan "Nieuw afschrift gevonden: Knab zakelijk, 1 t/m 29 september" met *Inlezen* en *Niet nu*. Er gaat niets vanzelf je boekhouding in. *Niet nu* vraagt het de volgende dag opnieuw, en na drie keer niet meer voor dat bestand. De app kijkt alleen naar afschriften van rekeningen die al in je administratie staan (CAMT.053, MT940, of een CSV van een bank die de app kent), en bij het aanzetten ook naar die van de afgelopen 14 dagen. Alles gebeurt op je eigen computer: de app opent in die map alleen bestanden die eindigen op .xml, .sta, .940, .txt of .csv, onthoudt van andere bestanden alleen dat het geen afschrift is, en verplaatst of verwijdert er nooit iets.
- **De app raakt je verplaatste administratie niet stil kwijt**: staan je gegevens in een map die je zelf koos, dan onthoudt de standaardmap waarheen ze zijn gegaan en wanneer. Raakt de verwijzing naar je eigen map weg (bijvoorbeeld na een nieuwe gebruikersmap of het opruimen van bestanden), dan opent de app niet meer stil de oudere kopie in de standaardmap, maar vraagt hij *Waar staat je administratie?* Je kiest dan: de verplaatste map weer gebruiken, bewust verder met de oudere kopie (wat je na het verplaatsen hebt ingevoerd staat daar niet in), of afsluiten. Staat de map op een usb-schijf of netwerkschijf die niet is aangesloten, dan zegt de app dat en kun je het opnieuw proberen. Er wordt niets geopend en niets gewist tot je gekozen hebt; de koppeling met Claude Code of Codex wacht daar ook op. Had je al gewisseld vóór deze versie, dan legt de app dit bij de eerstvolgende start vast.
- **Bonnenmap** (Instellingen → Telefoon & bonnenmap; standaard uit): kies een map op je computer, bijvoorbeeld een map die Syncthing of Google Drive gelijk houdt met je telefoon. Nieuwe bestanden in die map (jpg, png, pdf en e-facturen in xml) komen vanzelf bij *Aankopen & bonnetjes* en wachten daar op je controle; er wordt niets vanzelf geboekt. Daarna verplaatst de app ze naar de submap `verwerkt`. Er wordt nooit iets verwijderd of overschreven. Een bestand dat nog geschreven wordt, pakt de app pas op als het een paar seconden niet meer verandert, en een bestand dat je al had, komt er niet dubbel in.
- **Telefoon koppelen voor de bonnenscanner** (Instellingen → Telefoon & bonnenmap; standaard uit): de kant van de computer voor de scanner-app voor Android, die nog in de maak is. Je koppelt een telefoon met een QR-code; daarna kan die telefoon bonnen sturen over je eigen wifi, versleuteld en rechtstreeks naar je computer, zonder cloud. Per telefoon zie je de naam en wanneer hij voor het laatst iets stuurde, en met **Ontkoppelen** trek je de toegang in. Zonder gekoppelde telefoon luistert de computer nergens naar. Op Windows legt de app de eerste keer uit dat je bij de melding van de firewall op *Toestaan* klikt. Het protocol staat in [docs/bonnenscanner-protocol.md](docs/bonnenscanner-protocol.md).
- **Betaalwijze en notitie bij een bon van je telefoon**: wat je op de telefoon kiest (pin, contant, privé of later) is het voorstel bij "Hoe betaald?", ook bij "Ja" op Vandaag, en je notitie staat bij de bon. De locatie wordt alleen bewaard als je dat bij *Automatisch & herkenning* hebt aangezet.
- **Factuur van je eigen bedrijf** (bijvoorbeeld een abonnement op je eigen dienst): de app herkent een factuur waarop jouw bedrijf zowel verkoper als koper is, en boekt die nooit vanzelf en nooit als kosten met btw-aftrek. Je ziet waarom het geen gewone aankoop is en kiest *Privé* of *Weet ik nog niet: vraag mijn boekhouder*. Is de app er niet zeker van, dan vraagt hij eerst of het een factuur van je eigen bedrijf is. De betaling met je eigen bedrijfsnaam op het afschrift hoort erbij: op Vandaag krijg je één vraag voor de factuur en de betaling samen, welke van de twee er ook het eerst is. Stond de factuur al op "weet ik nog niet", dan komt de betaling daarbij in plaats van een tweede onbekende post.

### Verbeterd
- **Je ziet wat er met een bon gebeurd is**: in plaats van "Verwerkt" staat er bij een bon nu *Nieuwe aankoop geboekt*, *Bewijs gekoppeld — niet opnieuw geboekt*, *Dubbel document — niet geboekt* of *Nog controleren*. Na het toevoegen staat dat ook per bestand onder het sleepvak.
- **Zeker dezelfde factuur: beide bestanden blijven bewaard**: komt dezelfde factuur nog een keer binnen als ander bestand (zelfde leverancier, bedrag en nummer, en geen andere datum), dan wordt er niets opnieuw geboekt en blijven beide bestanden bij de aankoop bewaard. Het best leesbare bestand is het hoofdbewijsstuk: een PDF gaat voor een losse e-factuur (XML), die wel bewaard blijft. Een creditnota wordt nooit vanzelf met een factuur samengevoegd, en bij een andere datum of een slecht gelezen nummer vraagt de app het.
- **Van bon naar aankoop of betaling en terug**: bij een bon staat waar hij bij hoort, met welke bestanden er nog meer bij horen; bij een betaling op de bank staat de bon; zoeken vindt beide kanten op.
- **Pakket voor je boekhouder**: per aankoop of betaling gaat alleen het hoofdbewijsstuk mee. De andere bestanden blijven in de app.
- **Bijlagen uit je mail**: de mail gaat pas naar de map *Verwerkt* als elke bijlage bewaard en beoordeeld is.
- **Bijlagen blijven te openen als je administratie verhuist**: de app onthoudt van een bon of factuur voortaan alleen waar hij binnen je administratie staat (bijvoorbeeld `bijlagen/2026/bon.pdf`), niet meer de volledige map op je computer. Verplaats je de gegevensmap, zet je een back-up terug op een andere computer of opent je boekhouder je export, dan openen de bijlagen meteen; er hoeft niets meer aangepast te worden. Bestaande administraties zet de app om zodra je ze opent, en ook back-ups uit een oudere versie kun je gewoon terugzetten. Aan de bestanden zelf verandert niets. Ga je hierna terug naar versie 0.7.6 of ouder, dan opent die oudere versie je bijlagen niet; ze staan er nog wel, en in deze versie openen ze weer.
- **Bon bij "weet ik nog niet" meteen indelen**: in het venster dat laat zien wat er nog bij "weet ik nog niet" staat (op Vandaag en bij Belasting) heeft een bon nu een knop *Indelen*. Je hoeft hem niet meer bij Aankopen op te zoeken.
- **Wisselen van soort bankafschrift geeft geen dubbele betalingen meer**: lees je eerst een CSV in en daarna een CAMT.053 of MT940 over dezelfde dagen (of andersom, of een CSV met andere kolommen), dan herkent de app dezelfde betaling aan rekening, bedrag, tegenrekening en datum (hooguit drie werkdagen verschil, zoals bij een kaartbetaling van vrijdag die op maandag wordt geboekt). Na het inlezen zie je hoeveel betalingen nieuw zijn, hoeveel er al stonden en uit welk afschrift. Met *Bekijken* staat elke overgeslagen regel naast de betaling die er al stond; waren het toch twee betalingen, dan kies je *Toch toevoegen*. Een betaling die in je eerdere afschrift ontbrak, komt er gewoon bij. Wat je al had ingelezen en verwerkt, blijft zoals het was.
- **Klopt het saldo?** Staat er een beginsaldo in de app en heeft je afschrift een eindsaldo (CAMT.053, MT940, Revolut), dan vergelijkt de app die twee. Klopt het niet, dan staat het op Vandaag: wat de bank zegt, wat de app heeft en hoe groot het verschil is, met de overgeslagen betaling van dat bedrag als die er is. Je leest het ontbrekende afschrift in, of zegt dat het klopt.
- **De vraag om een nieuw afschrift** zegt nu ook welk soort je het beste kiest (CAMT.053 als je bank dat heeft: daar staat je saldo in).

### Opgelost
- **Verzamelbetaling als één regel én als deelposten telde dubbel**: je bank toont een verzamelbetaling (bijvoorbeeld lonen of een batch aan leveranciers) in CAMT.053 als losse deelposten en in CSV of MT940 als één regel met het totaal. Las je beide soorten afschrift in, dan stond het bedrag er twee keer in. Nu herkent de app dat het hetzelfde geld is: staat de ene regel er al, dan komen de deelposten er niet naast, en andersom. Wat er al stond blijft zoals het was; wat is overgeslagen vind je bij *Bekijken* en kun je met *Toch toevoegen* alsnog toevoegen. Stond zo'n bedrag er al dubbel in uit eerdere afschriften, of weet de app het niet zeker (de datums liggen te ver uit elkaar), dan staat op Vandaag en bij Bank dat het bedrag er waarschijnlijk twee keer in staat. Je ziet de ene regel en de deelposten naast elkaar met hun som en kiest welke kant blijft. De andere kant haalt de app uit je boekhouding; die blijft bewaard en is terug te zetten. Wat je al verwerkt had, haalt de app er niet zelf uit: je kiest dan de andere kant, of maakt eerst die verwerking ongedaan. Het saldo volgens je afschriften klopt daarna weer.
- **Bon bij een bankbetaling stond alleen als tekst vast**: welke bon bij welke betaling hoorde, stond in de uitleg bij de bon. Dat is nu een echte koppeling. Bestaande bonnen worden bij het bijwerken omgezet als de betaling er nog is en nog zo geboekt staat. Is dat niet zeker, dan koppelt de app niets en komt de bon met uitleg bij *Nog controleren*. Staat de betaling nog als kosten geboekt, of hoort ze intussen bij een aankoop, dan vraagt de app eerst of de bon daarbij hoort; tot je geantwoord hebt, is de bon niet als nieuwe aankoop te boeken. Aan je boekhouding verandert daarbij niets.
- **Twee keer hetzelfde bestand tegelijk slepen**: gaf soms een foutmelding of een los bestand in de bijlagenmap. Het wordt nu één document.
- **Bonnen lezen op deze computer weer te installeren**: het installeren van de ingebouwde herkenning eindigde met "Geen passende runtime gevonden", omdat het onderdeel dat de app daarvoor downloadt (llama.cpp) zijn releases anders is gaan aanbieden. Wie het al geïnstalleerd had, merkte er niets van.
- **Bon in dollars of een andere munt alsnog omgerekend**: kon de koers bij het binnenkomen van de bon niet opgehaald worden, dan probeert de app het opnieuw zodra je de bon opent. Een datum die per ongeluk in de toekomst is gelezen (bijvoorbeeld een Amerikaanse datum) houdt het omrekenen niet meer tegen.
- **Koppeling met Claude Code of Codex op Windows**: de koppeling startte wel, maar las de vragen van Claude Code of Codex niet en gaf dus nooit antwoord. Op Windows werkt hij nu net als op Linux.
- **Deelposten van een verzamelboeking in CAMT.053**: van een boeking met meerdere deelposten (bijvoorbeeld een batch met betalingen) kwam alleen de eerste erin; de rest telde als "al bekend". Nu komen ze er allemaal in. Lees je het oude afschrift opnieuw in, dan komen alleen de ontbrekende deelposten erbij.

## 0.7.6 — je gegevens in een vaste map buiten de app

### Verbeterd
- **Je administratie staat voortaan in een vaste map**: `BoekhoudenVoorNiks` in je thuismap (op Windows `C:\Users\<jij>\BoekhoudenVoorNiks`). Daar blijft hij staan als je de app verwijdert of opnieuw installeert. Bij de eerste start van deze versie zet de app je gegevens over door ze te kopiëren en te controleren; je ziet de voortgang en kunt stoppen. De oude map wordt nooit gewist, maar bewaard onder een naam die eindigt op `.gemigreerd-<datum>`. Lukt het overzetten niet (bijvoorbeeld door te weinig ruimte), dan verandert er niets en probeert de app het bij de volgende start opnieuw.
- **Twee oude mappen? Jij kiest**: staat er zowel een map van vóór als van na de naamswijziging met een administratie, dan vraagt de app welke je wilt gebruiken, met de datum van de laatste wijziging erbij. De app start daarna één keer opnieuw.
- **Opgeslagen wachtwoorden gaan mee**: het wachtwoord van je e-mail en andere koppelingen blijft na het overzetten werken.
- **Koppeling met Claude Code of Codex**: leest dezelfde map als de app. Start dat programma na het overzetten één keer opnieuw.

### Opgelost
- **Bijlagen na de naamswijziging weer te openen**: bijlagepaden die nog naar de oude map `gratis-boekhouden` wezen, worden bij het overzetten omgezet naar de nieuwe gegevensmap (voor alle administraties). Er verandert niets aan de bestanden zelf.
- **Oude losse databaseback-up terugzetten**: de bijlagen die er al staan zijn daarna weer te openen; ook een back-up uit een heel oude versie gaat goed.

## 0.7.5 — bekende leveranciers voorgesteld, eenvoudiger uitleg online hulp

### Verbeterd
- **Leverancier invullen stelt bekende leveranciers voor**: typ je bij een bon (of bij *Bonnetje zonder foto*) de naam van de winkel of leverancier, dan zie je de leveranciers die de app al kent uit je relaties en eerdere bonnen.
- **Uitleg van de online hulp eenvoudiger**: in Instellingen heet het nu *Online hulp bij het indelen van bonnen*, in gewone woorden, met erbij dat er niets meegaat waaraan jij of je klanten te herkennen zijn.

## 0.7.4 — online hulp bij categorievoorstellen, vraagposten bij bonnen

### Nieuw
- **Online hulp bij categorievoorstellen** (extra functie van het abonnement, standaard uit; Instellingen → Automatisch & herkenning): weet de app bij een onbekende winkel niet waar een bon voor was, dan kiest onze online hulp een categorie uit jouw categorieën. Er gaan alleen de winkelnaam en maximaal 15 artikelomschrijvingen (zonder bedragen) naar buiten. Op Vandaag zie je dat het voorstel van de online hulp komt; "Ja" of "Aanpassen" blijft jouw keuze, en wat je kiest onthoudt de app op je eigen computer. Er wordt nooit automatisch geboekt op alleen dit voorstel. In onze meting: van 28% naar 88% goed ingedeeld, en bij onbekende winkels van 16% naar 100%.
- **Vragen en feedback per mail**: in de app bij Instellingen → Over de knop *Vraag of feedback mailen*, en op de site verwijst "Vragen en feedback" naar info@shipdocs.app in plaats van naar GitHub.
- **Bon op "weet ik nog niet: vraag mijn boekhouder"**: past een bon in geen enkele categorie (of weet je het gewoon niet), zet hem dan apart op *vraagposten*, zonder btw-aftrek. Hij komt terug als controle vóór je btw-aangifte en in het pakket voor je boekhouder. Weet je het later wel, dan deel je hem in bij Aankopen met de knop *Indelen*; dan krijg je ook de btw terug.

### Opgelost
- **PDF-facturen van Mollie werden niet gelezen**: het streepje in de datum en het factuurnummer zit in die PDF als eigen teken van het lettertype, waardoor de datum ontbrak en "Betaald op: …" als leverancier werd gezien. Nu worden datum, vervaldatum, factuurnummer en leverancier goed gelezen; ook een datum die aan elkaar geplakt is ("30092026") achter een kopje als "Datum" wordt herkend. Onze eigen factuur wordt herkend als software-abonnement.

## 0.7.3 — het abonnement: steun de ontwikkeling en krijg de extra functies

### Nieuw
- **Voorwaarden en privacyverklaring (versie 2026-09-30)**: het abonnement heet nu wat het is: je steunt de verdere ontwikkeling en krijgt de extra functies, nu de uitwisseling met je boekhouder; daar kunnen er meer bij komen, en wat je hebt houd je zolang je abonnement loopt. Alles wat gratis is blijft gratis; het pakket voor je boekhouder en je back-ups kun je altijd zelf versturen. Artikel 9 is rechtgezet: wij zijn niet aansprakelijk voor schade; bij een storing lossen we het op, en lukt dat niet binnen een maand, dan een maand gratis erbij. Het minimumbedrag dat er per abuis in stond, is weg. Je geeft opnieuw akkoord.

## 0.7.2 — nieuwe voorwaarden, akkoord bij het afsluiten

### Nieuw
- **Nieuwe voorwaarden (versie 2026-10-02)**: duidelijkere aansprakelijkheid (artikel 9), het abonnement uitsluitend voor ondernemers, afspraken over terugboekingen, storingen, misbruik, overmacht en wat er gebeurt als wij de dienst stoppen, en een preciezere forumkeuze. Je geeft opnieuw akkoord. De voorwaarden zijn ook als PDF te downloaden.
- **Privacyverklaring bijgewerkt**: al je rechten onder de AVG, per soort gegeven een concrete bewaartermijn (die de licentieserver nu ook echt elke dag toepast), de grondslag per doel, en doorgifte buiten de EU.
- **Abonnement afsluiten**: je bevestigt eerst dat je het voor je bedrijf afsluit en akkoord gaat met de voorwaarden (met een link naar de PDF). Welke versie je accepteerde en wanneer, wordt bij je abonnement vastgelegd.

### Verbeterd
- **Pakket voor je boekhouder**: meldt de controle dat er inkopen zonder bon zijn, dan klik je op *Bonnen erbij zoeken*. Je ziet die aankopen in een lijst en voegt de bon meteen toe (foto, PDF of e-factuur) of opent de aankoop.

### Techniek
- De licentie- en assistent-Worker staan nu in een aparte, privé-repo (`shipdocs/boekhoudenvoorniks-server`). De app blijft open source; de website staat hier nog, met een eigen `wrangler` in `workers/site`.

## 0.7.1 — meer bekende winkels, back-up terugzetten bij het begin

### Nieuw
- **Back-up terugzetten vanaf het welkomstscherm**: heb je al een administratie (nieuwe computer, herinstallatie), dan zet je meteen je back-up terug in plaats van opnieuw te beginnen. Het keuzevenster opent in de map met de automatische back-ups van elke dag.
- **Meer bekende winkels en leveranciers**: de app kent nu zo'n 3300 winkelketens uit Nederland, Europa en Noord-Amerika (bouwmarkten, verfwinkels, tankstations en laadpalen, garages, verhuur van gereedschap, elektronica, kantoorartikelen, telefoonwinkels, horeca en verzekeraars), uit de lijst van OpenStreetMap. Bij een bon of betaling van zo'n keten staat de categorie al klaar; jij bevestigt of past aan. Voor horeca rekent de app geen btw-aftrek, want de btw op eten en drinken is niet aftrekbaar. Ook software en hosting (bv. Adobe, TransIP, GitHub) en Nederlandse verzekeraars worden herkend.

### Opgelost
- **Linux: het icoon van de app ontbrak** in het menu en de taakbalk. Het pakket bevat nu het icoon in alle gangbare formaten.

## 0.7.0 — uitwisseling met je boekhouder

### Nieuw
- "Ja" op Vandaag boekt alleen het voorstel dat je zag: is het intussen veranderd, dan vraagt de app je de bon opnieuw te bekijken.
- **Nieuw logo**: in de zijbalk (wit in de donkere modus), op het welkomstscherm en als app-icoon.
- **Abonnement op de uitwisseling**: versturen naar je boekhouder hoort bij een abonnement van € 9 per maand exclusief btw (€ 10,89 inclusief), per maand opzegbaar. Een eerste abonnement is de eerste 4 maanden gratis; je betaalt dan alleen € 0,01 met iDEAL voor de machtiging. Afsluiten gaat via Mollie, met een factuur op naam van je bedrijf bij elke betaalde maand, en opzeggen in de app. Opgezegd? Dan kun je versturen tot het eind van de betaalde maand. Koppelen en een antwoord van je boekhouder inlezen kan altijd, ook zonder abonnement; de rest van de app blijft gratis.
- **Nieuwe voorwaarden**: artikel 8 over het abonnement (prijs inclusief btw, per maand opzegbaar, geen terugbetaling van een lopende maand). Je geeft opnieuw akkoord.
- **Uitwisseling met je boekhouder** (Hoe gaat het? > Uitwisseling met je boekhouder), naar het voorbeeld van de periode-uitwisseling in SnelStart:
  - Je boekhouder stuurt je een uitnodiging. Open die, vergelijk de controlecode met hem, en je bent gekoppeld.
  - Stuur een periode (t/m het eind van een kwartaal) per e-mail of als bestand. Alleen het kantoor van je boekhouder kan hem openen; wachtwoorden en koppelingen gaan niet mee. Tot zijn antwoord binnen is, ligt die periode vast; daarna werk je gewoon door.
  - Lees zijn antwoord in: zijn correcties komen in de periode, wat je intussen deed blijft staan, en de periode is daarna afgesloten.
  - Voor boekhouders (Instellingen > Administraties): je kantoor instellen, klanten uitnodigen, hun export inlezen als aparte administratie, corrigeren (correctieboeking, terugdraaien, grootboekrekening toevoegen) en een antwoord maken.
  - Er gaat niets via een server van ons: alles loopt via je eigen e-mail of een bestand.
  - Draait je boekhouder een factuur of inkoop terug waarop al betaald is, dan zie je dat na het inlezen op Vandaag, zodat je het met hem kunt afhandelen.
  - Kantoren met meer medewerkers delen de kantoorsleutel via een bestand met wachtwoord (Instellingen > Administraties > Met collega's werken). In de kopie van een klant zie je zijn takenlijst niet.
- **Periode afsluiten** (Hoe gaat het? > Periode afsluiten): klaar met een kwartaal of een jaar? Sluit het af, dan verandert er niets meer aan. De app laat eerst zien wat er nog moet (betalingen verwerken, bonnen controleren, afschriften t/m de einddatum) en maakt een back-up voordat hij afsluit. Afsluiten kan niet ongedaan gemaakt worden.
  - Komt er daarna nog een bon of factuur van daarvóór binnen, dan komt die in de eerste open periode, met de echte datum erbij. De btw hoort bij de periode van de bon, zolang je die aangifte nog niet gedaan hebt.
  - Een betaling of correctieboeking in een afgesloten periode kan niet meer. Iets uit die periode terugdraaien kan wel: de correctie komt dan in de open periode.
  - De btw-aangifte van een afgesloten kwartaal kun je gewoon nog doen.
- **Meerdere administraties** (Instellingen > Administraties): heb je meer dan één bedrijf, bijvoorbeeld een bv en een eenmanszaak, maak dan voor elk een eigen administratie. Ze staan helemaal los van elkaar, met eigen bijlagen en back-ups. De app opent de laatst gebruikte; met meer dan één administratie zie je onder de naam van de app welke open is.

### Nieuwe naam: BoekhoudenVoorNiks
- **Gratis Boekhouden heet nu BoekhoudenVoorNiks**, met een eigen site op [boekhoudenvoorniks.nl](https://boekhoudenvoorniks.nl). De app blijft gratis en open source.
- **Je hoeft niets te doen.** De update gaat gewoon over de oude installatie heen. Je administratie wordt bij de eerste start verplaatst naar de nieuwe map (`boekhoudenvoorniks` in plaats van `gratis-boekhouden`); je wachtwoorden en koppelingen blijven werken.
- **Vragen stellen via Claude Code of Codex:** de koppeling heet nu `boekhoudenvoorniks`. Had je hem al toegevoegd, dan zet de app hem vanzelf om naar het nieuwe programma. Lukt dat niet (bijvoorbeeld omdat Claude Code of Codex niet gevonden wordt), voeg hem dan opnieuw toe in Instellingen > Automatisch & herkenning.
- De broncode staat op [github.com/shipdocs/boekhoudenvoorniks](https://github.com/shipdocs/boekhoudenvoorniks); oude links sturen door.

### Verbeterd
- **Privé-opnamen en -stortingen beginnen elk boekjaar bij nul.** Wat je in eerdere jaren privé opnam of stortte, zit in de beginbalans nu in het eigen vermogen, zoals een boekhouder dat verwacht. Dat geldt voor de auditfile (XAF), de kolommenbalans in het pakket voor je boekhouder en de rapporten in de app.
- **De rapporten in de app hebben dezelfde beginbalans als het pakket voor je boekhouder.** De kolommenbalans, grootboekkaarten, periodebalans en de balans in de expertmodus telden het resultaat van eerdere jaren niet bij het eigen vermogen, waardoor de beginbalans bij een administratie van meer dan één jaar niet op nul uitkwam. Een beginbalansboeking op de eerste dag (overstap) staat nu ook in de app in de kolom beginbalans in plaats van bij de mutaties.

### Techniek
- De website staat op Cloudflare (`workers/site`: Worker met static assets), met https; http en www gaan naar https://boekhoudenvoorniks.nl. De workflow `site.yml` publiceert bij elke wijziging (vraagt de secrets CLOUDFLARE_API_TOKEN en CLOUDFLARE_ACCOUNT_ID); GitHub Pages is niet meer in gebruik.
- Licentie voor het versturen naar de boekhouder voorbereid (`src/license/`, `workers/licentie/`): offline gecontroleerde, ondertekende licentie en een Worker voor afrekenen via Mollie (opslag in D1, idempotente en herstelbare webhook). De licentie-Worker staat live (`licentie.boekhoudenvoorniks.nl`) en de publieke sleutel zit in de app.
- Uitwisselingspakket (`src/exchange/`): X25519 + HKDF + AES-256-GCM naar de sleutel van het kantoor, het antwoord met een sleutel die alleen in de export zat; kopregel met administratie, uitwisselingsnummer en versie als AAD. Het antwoord is een lijst handelingen die de app van de klant opnieuw uitvoert (migratie 23). Getest met de hele cyclus: na het inlezen is de proefbalans van de periode bij klant en boekhouder gelijk.
- Periodeslot in de database (migratie 22): geen nieuwe boekingen t/m een afgesloten periode, afgedwongen in `Ledger.post` en met triggers. Een afgesloten periode kan niet heropend worden. Voorbereiding op de uitwisseling met de boekhouder: een periode kan ook tijdelijk vastliggen zolang hij bij de boekhouder is.
- Elke administratie heeft een vaste identiteit (UUID, migratie 21) en er is een kantoormodus voor de kopie van een klant bij de boekhouder: geen e-mail, geen koppelingen, geen post ophalen en niets automatisch boeken. Voorbereiding op de uitwisseling met de boekhouder (`docs/uitwisseling.md`).
- Eén functie voor de beginbalans (`src/reports/opening-balance.ts`) voor de rapporten in de app, de auditfile en het pakket.
- Technisch ontwerp voor de uitwisseling met de boekhouder: `docs/uitwisseling.md`.

## 0.6.15 — pakket voor je boekhouder

### Nieuw
- **Pakket voor je boekhouder** (Hoe gaat het? en Boekhouding > Exports): één ZIP per boekjaar die je boekhouder in zijn eigen pakket inleest. Hij hoeft niet in Gratis Boekhouden te werken. Erin:
  - `auditfile-2026-xaf32.xaf`: XAF 3.2 met grootboek (RGS), relaties, beginbalans en alle journaalposten; gevalideerd tegen het officiële schema.
  - `kolommenbalans.csv`, `grootboekkaarten.csv`, `journaalposten.csv`, `openstaande-debiteuren.csv` en `openstaande-crediteuren.csv` (per factuur), `rgs-brugstaat.csv`, `btw-overzicht.csv` en `relaties.csv`. Excel (NL) opent ze direct.
  - `rapporten-2026.xlsx`: dezelfde overzichten als Excel-werkmap, één tabblad per overzicht, bedragen als getal en datums als datum.
  - `importprofielen/`: bestanden in het eigen importformaat van SnelStart (Excel met `Fld…`-kolommen: klanten, leveranciers, boekingen met beginbalans), Yuki (historische mutaties en openstaande posten) en AFAS (saldibalans), volgens de importdocumentatie van die pakketten.
  - `documenten/`: verkoopfacturen als PDF en je bonnen, met `index.csv` die elk bestand aan het boekstuk koppelt en noemt wat ontbreekt.
  - `LEES-MIJ.pdf`: periode, aansluiting (begin, mutaties, eind, resultaat), btw per periode, openstaande posten, controles en hoe je het inleest in Caseware, AFAS, Visionplanner, Twinfield, Exact Online, Yuki en SnelStart.
- **Controles vóór het maken**: de app laat zien of beginbalans, mutaties en eindsaldi aansluiten, of openstaande posten optellen tot het grootboek, of elke rekening een RGS-code heeft, bij welke inkopen een bon ontbreekt en welke btw-aangiftes nog open staan.
- Duidelijk gelabeld als **overdracht, geen back-up**: instellingen en koppelingen gaan niet mee.
- **Pagina voor boekhouders** op de site met een voorbeeldpakket om zelf in te lezen.

### Techniek
- Alle bestanden gebruiken dezelfde selectie als de auditfile (beginbalansboeking op dag één als beginbalans, resultaat eerdere jaren in het eigen vermogen), zodat ze onderling aansluiten; getest door de auditfile terug te lezen.
- Eigen ZIP- en Excel-schrijver zonder extra afhankelijkheid (`src/shared/zip.ts`, `src/shared/xlsx.ts`); de werkmap is getest met LibreOffice.
- `npm run voorbeeldpakket` maakt `site/voorbeeld/voorbeeldpakket-boekhouder-2025.zip` uit de demo-administratie.

## 0.6.14 — rapporten voor de boekhouder

### Nieuw
- **Rapporten in het scherm Boekhouding** (Instellingen > Voor de boekhouder aanzetten), zonder je gegevens ergens te uploaden:
  - **Kolommenbalans**: beginbalans, mutaties debet en credit en eindsaldo per rekening, met controle of debet en credit gelijk zijn. Filter op balans of winst en verlies, zoeken, en klikken op een rekening opent de kaart.
  - **Grootboekkaarten**: alle boekingen op een rekening met beginsaldo, oplopend saldo, wederpartij en een knop naar de factuur, aankoop of betaling erachter.
  - **Relatiekaarten**: per klant of leverancier wat er is geboekt en wat er nog openstaat.
  - **Periodebalans**: alle mutaties per maand of per kwartaal, met beginbalans en eindstand.
  - Voor het doorgeven aan je boekhouder gebruik je de bestaande exports (auditfile).

## 0.6.13 — zakelijk deel: zie en bevestig wat er verandert

### Opgelost
- **RGS-codes in de auditfile (XAF)**: de export zette de RGS-code alleen in een eigen blok, waardoor de online XAF-viewer "22 van 22 rekeningen missen een RGS-code" meldde. De code staat nu ook in het standaardveld `leadReference` (zoals DigiBoox dat doet), en het inlezen leest hem daar weer uit.

### Verbeterd
- **Eerst een lijst, dan pas aanpassen.** In Instellingen > Categorieën > Gemengd gebruik opent "Boekingen bekijken" een lijst met alle geboekte uitgaven van die leverancier. Per boeking zie je het bedrag, het zakelijke deel nu en straks, en wat er met de kosten en de btw-aftrek gebeurt. Je kunt per boeking een ander percentage invullen of een boeking uitvinken, en er verandert pas iets als je bevestigt. Na het bevestigen zie je in dezelfde lijst het nieuwe percentage. Vervangt de knop die eerder alles in één keer aanpaste.
- **Het zakelijke deel staat in de lijst met aankopen**: "25% zakelijk, 75% privé", de btw die je echt terugkrijgt (met het bedrag op de factuur eronder) en wat zakelijk is. Met de knop % pas je het per aankoop aan.
- **In het overzicht van je bank** staat bij een betaling nu "40% zakelijk" in plaats van een aparte post Privé-opnamen.

## 0.6.12 — zakelijk deel per leverancier

### Nieuw
- **Gemengd gebruik: zakelijk deel per leverancier.** Gebruik je iets ook privé, zoals Dropbox, Google One of je telefoon? Bij een betaling of bon vraagt de app nu "Hoeveel daarvan is zakelijk?" (standaard 100%). Het privédeel telt niet als kosten en de btw erover trek je niet af: het gaat naar je privé-opnamen. De app onthoudt het percentage per leverancier en gebruikt het voor de volgende betaling of bon. Bij verlegde btw (buitenlandse abonnementen) geven we ook alleen het zakelijke deel aan en trekken we dat af.
- **Instellingen > Categorieën > Gemengd gebruik**: overzicht van je afspraken per leverancier. "Ook eerdere boekingen" schrijft de al geboekte uitgaven van die leverancier opnieuw weg (tegenboeking + nieuwe post). Is de aangifte al ingediend, dan komt het verschil vanzelf in je volgende aangifte.

### Techniek
- Boekingsregels: `businessPct` op inkoop- en bankboekingen (ontbreekt = 100%, bestaande boekingen veranderen niet). Nieuwe tabel `supplier_business_share`.

## 0.6.11 — geen dubbele omzet bij Mollie-orders

### Opgelost
- **Geen dubbele omzet meer bij Mollie- en webshoporders die al op de bank staan**: staat de betaling van een order al op je bankafschrift, dan wordt de nieuwe factuur direct met die bankregel verrekend in plaats van via de tussenrekening betaalprovider. Was die bankregel al als verkoop geboekt, dan slaat het inlezen de order over met een melding, zodat de omzet niet twee keer meetelt.

### Verbeterd
- **Bij een bon zie je nu waar de tekst vandaan komt**: Claude Code, lokale herkenning of de tekst uit de PDF, zodat je kunt controleren welke herkenning het document echt gelezen heeft.

### Techniek
- **Vaste proefadministratie**: een samenhangende XAF-startpositie, UBL-inkopen, verkoopfacturen en een CAMT-bankafschrift worden periodiek door de echte boekingsservices verwerkt. De test vergelijkt daarna alle niet-nulle grootboeksaldi, bankaansluiting, btw-aangifte, winst, openstaande posten en ontdubbeling met een apart, handmatig doorgerekend verwacht resultaat.

## 0.6.10 — voortgang bij updates, menubalk uit het zicht

### Techniek
- **Voortgangsbalk bij het downloaden van een update**: bovenin verschijnt een balk met het percentage zodra de app een nieuwe versie op de achtergrond binnenhaalt. Voorheen kwam er pas een melding zodra de update helemaal klaarstond, en was tussentijds niet te zien of er iets gebeurde.
- **Menubalk van het venster** (Bestand/Bewerken/Beeld/Venster) staat voortaan standaard uit het zicht; op Windows en Linux verschijnt hij tijdelijk met de Alt-toets.

## 0.6.9 — Mollie Facturen inlezen

### Koppelingen
- **Mollie Facturen**: een nieuwe koppeling (Instellingen → Koppelingen) die betaalde facturen uit [Mollie Facturen](https://www.mollie.com/producten/facturen) inleest en er automatisch gewone facturen van maakt, met de klant en de btw erbij. Je blijft de factuur zelf in Mollie maken en versturen; deze app boekt hem alleen. Werkt samen met de bestaande Mollie-koppeling voor uitbetalingen (settlements): die trekt het bedrag er later weer vanaf, met de transactiekosten, zodat de bijschrijving op je bank vanzelf klopt — net als bij een webshopkoppeling.
- Het btw-nummer van een klant uit een webshop-order of Mollie-factuur wordt voortaan ook echt bij de klant opgeslagen (eerder werd het wel gelezen, maar niet bewaard).
- Bij elke koppeling (Instellingen → Koppelingen) staat nu duidelijker wat hij wel en niet doet: een **omzetbron** (WooCommerce, Shopify, Mollie Facturen) boekt de omzet zelf; een **betaalprovider** (Mollie, Stripe) boekt alleen de uitbetaling en de kosten, en heeft dus een omzetbron nodig om te kloppen.

## 0.6.8 — zoeken, en zien waar alles geboekt staat

### Zoeken
- **Zoekscherm** (Zoeken in het menu): dezelfde zoekopdracht als Ctrl+K, maar per resultaat met van welke rekening, waar het geboekt staat (grootboekrekening en btw-vak, bv. "Software & abonnementen · btw verlegd, buiten EU (4a)"), in welke btw-aangifte (en of die al is gedaan), de status, of er een bon is, en of de app het automatisch verwerkte. Filter op soort en op "nog aandacht nodig"; het totaalbedrag staat erboven.
- **Ctrl+K** blijft het snelle zoekvenster, nu met dezelfde korte info per resultaat en "Alle resultaten bekijken" (Shift+Enter).
- **Zoeken in Bank, Aankopen en Klussen**. Bank toont per betaling ook de rekening en "Geboekt als"; Aankopen hoe hij betaald is (rekening, privé of contant).

### Bonnen
- **Bon toevoegen** bij "uitgaven zonder bonnetje of factuur" (Belasting en Vandaag): direct aan die betaling of aankoop. De omschrijving van de betaling staat erbij, bv. "FACTUUR F0000.2607.0000.1394", zodat je de goede factuur vindt.
- Past de bon niet bij de betaling (andere maand of ander bedrag), dan zegt de app dat meteen.
- Een factuur van vóór je instapdatum wordt geen nieuwe open aankoop meer, maar een vraag met uitleg.
- **Weghalen**: een aankoop die er niet hoort en nog niet betaald is, haal je weg bij Aankopen. De bon blijft bewaard.

## 0.6.7 — zien waar verlegde btw vandaan komt

### Belasting
- **"Btw die naar jou is verlegd" heeft een vergrootglas**: je ziet welke aankopen erin zitten (vak 2a, 4a en 4b samen), met een korte uitleg: bij een dienst van een buitenlandse leverancier of een onderaannemer met btw verlegd reken je de btw zelf uit, en krijg je hetzelfde bedrag in vak 5b meteen terug.
- In de details van vak 2a, 4a en 4b heet de kolom met bedragen nu "Aankoop" in plaats van "Omzet".

## 0.6.6 — dubbele aankopen: eerst vragen

### Aankopen
- **Eerst vragen, niet zelf weghalen**: lijkt een aankoop dubbel met een afschrijving op je rekening, dan vraagt de app het eerst:
  - bij **Al betaald**: "Op Revolut staat op 20 juli al € 17,28 aan Moonshot AI, geboekt als kosten. Is dat dezelfde betaling?";
  - in **Vandaag**, voor aankopen die al op privé of contant betaald staan: "Staat deze aankoop dubbel?", met *Ja, dezelfde betaling* of *Nee, twee aankopen*.
- Vanzelf herstellen doet de app alleen als het zeker is: een leverancier op "voortaan privé" waarvan dezelfde betaling toch als kosten op je rekening staat (het geval uit 0.6.4). Contant betaald is nooit zeker, want dat staat niet op de bank.
- **Alleen als kosten geboekt telt**: een afschrijving die als privé-opname of eigen overboeking staat, telt niet als "deze betaling staat al op je rekening". Dat geldt ook bij het inlezen van bonnen.
- Bij **voortaan altijd** blijft een andere open rekening waarvan de betaling mogelijk al op je rekening staat open, en gaat de leverancier niet op privé.

## 0.6.5 — privé betaald, zonder dubbele kosten

### Aankopen
- **"Al betaald" kijkt eerst op je rekeningen**: staat dezelfde betaling al als kosten op een van je rekeningen (bv. een abonnement via Revolut, automatisch verwerkt)? Dan is de aankoop dubbel. De app haalt hem weg en de bon wordt het bewijsstuk bij die betaling. Bij "voortaan altijd" gaat die leverancier dan niet op privé.

### Hersteld
- **Dubbele kosten na "Al betaald" in 0.6.4**: een aankoop die privé betaald werd gezet terwijl de betaling al op een van je rekeningen als kosten stond, telde twee keer. De app herstelt dit vanzelf bij het opstarten en na het inlezen van de bank: de privé-betaling wordt teruggedraaid, de aankoop vervalt, de bon wordt het bewijsstuk, en "voortaan privé" gaat uit voor die leverancier. Is de btw-aangifte van die periode al gedaan, dan gaat het verschil mee in je volgende aangifte. Je ziet het terug in het overzicht van wat automatisch ging.

## 0.6.4 — rekeningen die je privé betaalt

### Aankopen
- **Al betaald**: een open aankoop die niet van je zakelijke rekening betaald is, zet je met één klik op betaald.
  - **Met privégeld**: van je privérekening, via je telefoonrekening (bv. Google) of met een privé-creditcard (bv. via Stripe of PayPal). De app boekt Crediteuren aan Privé-stortingen; de kosten en de btw die je terugkrijgt blijven staan.
  - **Contant uit de zaak**: Crediteuren aan Kas.
- **Voortaan altijd zo bij deze leverancier** (bv. een abonnement met incasso op je privérekening): de andere open rekeningen van die leverancier gaan in één keer op betaald, en nieuwe bonnen staan meteen op betaald als er geen betaling van je zakelijke rekening bij hoort.

## 0.6.3 — Revolut, facturen van Stripe, en Claude Code of Codex die gewoon werken

### Bonnen en facturen
- **Facturen van Stripe goed gelezen** (de meeste software-abonnementen: Vercel, Render, Supabase, Moonshot, ElevenLabs, Cloudflare, ...):
  - De leverancier is de verkoper naast "Bill to" (met de handelsnaam), niet een adres of een kopje als "Account ID".
  - "Paid via Stripe" maakt Stripe niet meer de leverancier.
  - Het factuurnummer is compleet ("P6ARUBNL-0001", niet meer "P6ARUBNL").
  - "Amount paid" op een betaalbewijs is het totaal.
- **Btw bij buitenlandse leveranciers**:
  - De app leest het land uit het adres. Een Amerikaanse leverancier zonder btw op de factuur is verlegd (4a) en niet meer 21%.
  - Bij "reverse charge" telt je eigen btw-nummer onder "Bill to" niet meer als dat van de leverancier.
  - "21% on $5.00" en "(Includes VAT of € 1,73)" worden goed gelezen.
- **Factuur bij een betaling die al geboekt is**: de factuur wordt het bewijsstuk, ook als de naam anders gespeld is ("Eleven Labs Inc." en "Elevenlabs") en als je hem tot 20 dagen later met de kaart betaalde.

### Bank
- **Revolut-export inlezen**:
  - Alleen voltooide betalingen, op de boekdatum. Teruggedraaide betalingen komen er niet in.
  - Kosten staan als aparte regel "Kosten: …", zodat je ze als bankkosten kunt boeken.
  - Het eindsaldo uit het bestand, voor de saldocontrole en het beginsaldo.
  - Het bestand komt op je rekening "Revolut", niet meer op je eerste rekening.
- **Overboeking naar je spaarrekening zonder IBAN** (Knab noemt alleen het korte nummer): beide kanten horen nu bij één boeking. Eerst bleef de kant van je betaalrekening als vraag staan, en met "Zakelijk" werd hij dubbel geboekt. Wat al zo in je administratie stond, herstelt de app vanzelf.

### Claude Code en Codex
- **Werken ook als je de app vanuit het menu start**: de app vindt Node.js nu ook als dat via nvm, fnm, volta, asdf of mise is geïnstalleerd, en "Zoek op deze computer" vindt claude/codex daar ook.
- **Duidelijke meldingen**: Node.js niet gevonden, programma weg, of een verouderde versie (met de opdracht om bij te werken).
- **Afgeschermd en zuiniger**:
  - Voor een bon gebruikt de app geen MCP-servers, instellingen of hooks van jezelf. Claude Code krijgt alleen het hulpmiddel Read.
  - Bonnen lezen gaat met Sonnet: ongeveer een derde van het verbruik van Opus.

### Onboarding
- **Nieuw beroep: Webdeveloper / ICT**, met factuurregels voor ontwikkeling, hosting en onderhoud, en licenties.
- **Kostenposten per beroep**: een nieuwe stap "Waar geef je geld aan uit?" stelt categorieën voor die bij je vak horen, allemaal aangevinkt. Voor webdevelopers bv. AI-tools en developer-tools (standaard: leverancier buiten de EU, geen btw op de factuur), hosting, domeinnamen, computerspullen, cursussen en flexplek; voor de bouw steiger- en machinehuur en stortkosten. Wat je vak niet gebruikt (materiaal, werkkleding, onderaannemer bij webdev) stelt de app voor te verbergen. Bestaande gebruikers krijgen deze stap één keer te zien; wat je al hebt wordt niet dubbel aangemaakt.

## 0.6.2 — elke vraag begrijpelijk: details, uitleg per keuze, rente en refunds

### Vandaag
- **Zien waar een vraag over gaat**: klik op de naam van een taak.
  - Bij een betaling (bv. "PAYPAL EUROPE … € 13,11") zie je wat de bank gaf: datum, tegenpartij, rekeningnummer, volledige omschrijving en kenmerk, plus eerdere betalingen aan dezelfde partij en hoe je die verwerkte.
  - Bij een voorgestelde koppeling zie je de factuur of aankoop: datum, bedrag, wat nog open staat en het verschil.
  - Bij een bon zie je de bon zelf, en bij een mogelijk dubbele bon de andere ernaast.
  - Bij een aankoop (investering, klus) zie je de aankoop, met een knop om de bon te openen.
- **Wat gebeurt er als ik dit kies?** Per knop staat wat die in je boekhouding doet, bijvoorbeeld "Zakelijk: wordt geboekt als software, telt mee als kosten, de btw krijg je terug" of "Privé: geen kosten en geen btw".
- **Btw-controles noemen de posten**: bij "uitgaven zonder bonnetje", "mogelijk dubbele aankopen", "betalingen nog uitzoeken" en "btw verlegd zonder btw-nummer" zie je welke het zijn, met een knop om elk te openen (ook op het Belasting-scherm).
- **Uitzoeken** bij geld dat binnenkwam opent meteen het scherm om de betaling in te delen.
- Een verlopen offerte noemt nummer, datum, bedrag en geldigheid, met **Bekijken**. Bij een vaste last zie je welke betalingen de app zag en wanneer de laatste was; bij "voortaan automatisch" de laatste betalingen; bij mail afzender en datum.

### Bank
- **Rente ontvangen**: nieuwe keuze bij geld dat binnenkomt. Telt mee in je winst, niet als omzet en zonder btw.
- **Geld terug van een aankoop (refund)**: kies de categorie en btw van de oorspronkelijke aankoop; de app verlaagt je kosten en de btw die je terugkreeg. Was het een privé-aankoop, dan boekt de app het als privé.
- Bij het indelen van een betaling zie je alle gegevens van de bank en eerdere betalingen aan dezelfde partij. Uitleg bij elke keuze (btw, overboeking, privé, weet ik nog niet, negeren), bij de gekozen categorie en bij "Stond er btw op?".
- Voorstellen ("Hoort dit hierbij?") tonen het openstaande bedrag en de datum.
- **Rekeningen uit je vorige administratie**: dezelfde bank wordt ook onder een andere naam herkend ("Bank Knab" en "KNAB", "Rabo" en "Rabobank"), en een rekening die bij het inlezen wordt aangemaakt is een gewone rekening, geen potje. Bij **Rekening wijzigen** zet je een rekening zonder nummer op potje of gewone rekening, en haal je een lege rekening weg.

### Overstappen
- **Instapdatum vóór je auditfiles** (bijvoorbeeld 1 januari 2024 terwijl je administratie toen begon): de app legt uit dat hij de stand óp de instapdatum overneemt, niet elke boeking, en stelt de dag na je laatste boeking voor. Met één knop kies je die datum en leest de app de bestanden opnieuw in.
- Voorstellen uit je bankafschriften zeggen waarom en wat "Ja" doet, met alle gegevens van de betaling. Bij "betalingen van vóór je instapdatum" zie je welke het zijn en wat overslaan betekent.

### Bonnetjes en instellen
- Bij een mogelijk dubbele bon bekijk je met **Bekijk de andere** de bon die erop lijkt.
- Uitleg bij "Hoe vaak doe je aangifte?".

## 0.6.1 — overstappen vanuit DigiBoox en betrouwbaardere updates

### Hersteld
- **Auditfiles zonder beginbalans (bv. DigiBoox)**: de app telt de jaren nu bij elkaar op. Voorheen gebruikte hij alleen het jaar van de instapdatum, waardoor banksaldi, openstaande rekeningen en btw uit de jaren ervoor ontbraken. Bij één bestand zonder beginbalans waarschuwt de app dat eerdere jaren erbij horen. Btw-rekeningen met de code `BSchBtw` en de "Overboekingsrekening winst" worden goed herkend.
- **Zoeken naar updates direct na een nieuwe release**: de release werd al openbaar terwijl de installers nog werden geüpload, waardoor de app kort een foutmelding gaf ("Cannot find latest-linux.yml"). Een release staat nu als concept klaar tot alle bestanden voor Linux en Windows er zijn. Lukt zoeken naar updates niet, dan zegt de app in gewone taal waarom.

### Website
- Nieuwe pagina *Wat is er nieuw* met de release notes per versie, een sectie over overstappen, en de fiscale verbeteringen uit 0.5.0 bij de functies.

## 0.6.0 — overstappen met een auditfile per jaar

### Overstappen
- **Een auditfile per jaar?** Zet ze allemaal tegelijk neer (bijvoorbeeld 2024, 2025 en 2026). De app kiest het jaar dat bij je instapdatum hoort, legt uit wat hij met de andere doet, en haalt de echte aankoopdatums van je bus en gereedschap uit de oudere jaren. Heb je ook een bestand van na je instapdatum, dan noemt de app de instapdatum waarmee je die periode niet opnieuw hoeft in te boeken.

## 0.5.0 — fiscale review verwerkt en makkelijker overstappen

### Overstappen makkelijker
- De overstap-hulp begint met één vraag: **hoe stap je over?** Met een boekhoudprogramma (auditfile), met een overzicht van je boekhouder, of zelf invullen. Het lijstje "wat heb je nodig" staat ingeklapt eronder.
- Lege hoofdstukken vink je af met één knop ("Er stond niets open", "Heb ik niet"), en **Verder** springt naar het eerstvolgende hoofdstuk dat nog open staat.
- Na het inlezen van een auditfile zie je meteen wat je nog moet nalopen.
- Een bankrekening die je niet meer gebruikt (bijvoorbeeld de rekening van het instellen, terwijl je vorige programma een andere had) zet je met "Deze rekening gebruik ik niet" op € 0, zonder dat de app om afschriften blijft vragen.
- De voortgang telt wat echt klaar is ("4 van 9 klaar") in plaats van waar je bent.

### Fiscale review verwerkt
- **KOR**: btw op inkopen en investeringen wordt niet meer als voorbelasting geboekt maar bij de kosten of de prijs van de investering. Verlegde btw (bijvoorbeeld van Google of een onderaannemer) moet je met de KOR wél betalen; het btw-scherm toont die per kwartaal.
- **Buitenland**: nieuwe keuzes *Dienst aan een bedrijf buiten de EU* (niet in de aangifte) en *Dienst aan een bedrijf in een ander EU-land* naast de goederenvarianten. De ICP-opgaaf splitst goederen en diensten, en correcties op een eerdere opgaaf staan apart, los van een btw-suppletie.
- **OSS**: de waarschuwing bij verkopen aan particulieren in andere EU-landen noemt de € 10.000 alleen nog voor spullen en digitale diensten.
- **Inkomstenbelasting**: tariefsaanpassing bij een hoog inkomen, startersaftrek zonder beperking tot de winst, fiscaal verlies, en niet-gerealiseerde zelfstandigenaftrek uit eerdere jaren.
- **Drempels**: representatie € 5.700 (2025 en 2026), desinvesteringsbijtelling pas boven € 2.900.
- **Investeringen**: afschrijven vanaf ingebruikname, meenemen naar privé telt als verkoop, en de KIA van een afgesloten jaar wordt vastgelegd.
- **Auto van de zaak**: de btw over privégebruik (forfait) pas na bevestiging dat er btw is afgetrokken; ook werkelijk privégebruik kan.
- Teksten over werkruimte thuis, AOV en meewerkaftrek zijn minder stellig.

### Hersteld
- Btw-rubrieken 5a, 5b, 5c en 5g sluiten na afronding altijd op elkaar aan; het ICP-overzicht gebruikt bij correcties en suppleties voortaan dezelfde boekingen als rubriek 3b.
- Auditfiles volgen nu de XAF 3.2-volgorde en taxonomiestructuur en zijn tegen het XAF-schema gevalideerd.
- Handmatige, dagelijkse en versleutelde back-ups bevatten voortaan ook alle bijlagen, met controlesommen en padherstel bij terugzetten op een andere computer. Oude `.sqlite`-back-ups blijven leesbaar met een waarschuwing dat ze geen bijlagen bevatten.
- Een terugbetaling aan een klant kan vanuit een negatieve bankmutatie aan de open creditfactuur worden gekoppeld.
- Na een mislukte eerste factuurmail wordt niet meer automatisch een betalingsherinnering verstuurd.
- Op Linux worden SMTP- en API-geheimen niet opgeslagen wanneer Electron alleen de onveilige `basic_text`-opslag kan aanbieden.
- Bijlagepaden, instellingen, browserrechten en het verpakte Electron-programma zijn verder afgeschermd.

### Techniek
- PDF.js wordt alleen geladen wanneer een PDF wordt bekeken; de renderer is daardoor opgesplitst in kleinere bundles.
- De Vite- en Vitest-configuratie gebruikt expliciete ESM-bestanden en geeft geen toekomstige config-loaderwaarschuwing meer.

## 0.4.0 — overstappen met een lopende administratie

- **Overstap-hulp** (#82, #83, #84): had je al een administratie, in een ander programma, in Excel of bij je
  boekhouder? Bij het begin vraagt de app "Heb je al een administratie?". Kies dan een instapdatum: 1 januari is
  aangeraden, maar elke datum kan, en de app zegt erbij wat dat betekent. Daarna vraagt de overstap-hulp in gewone
  taal, hoofdstuk voor hoofdstuk, wat er toen al was:
  - **wat je nodig hebt**: een lijstje om klaar te leggen (ook af te drukken);
  - **bankrekeningen**: het saldo aan het begin (uit het eindsaldo van je CAMT/MT940-afschrift berekend), je
    afschriften vanaf de instapdatum, en betalingen van vóór die datum met één klik overslaan;
  - **klanten die nog moesten betalen** en **rekeningen die jij nog moest betalen**: komt het geld later binnen,
    dan koppelt de app de betaling aan de oude factuur. Omzet en btw tellen niet nog eens;
  - **bus, auto en gereedschap**: verder afschrijven vanaf de waarde op 1 januari. Weet je die niet, dan rekent de
    app hem uit;
  - **btw** van de vorige aangifte die nog open stond, en bij instappen midden in een btw-periode het stuk van die
    periode, zodat de aangifte straks klopt;
  - **omzet en kosten tot nu toe** bij instappen midden in het jaar;
  - **leningen, borg en andere schulden**;
  - **je startpositie**: wat er van jou in de zaak zit (eigen vermogen), met controles: sluit het banksaldo aan,
    ontbreken er afschriften, klopt het met de balans van je boekhouder.
  Stoppen mag: alles is meteen bewaard, en "Je vorige administratie overzetten" staat op Vandaag tot het klaar is.
- **Uit je vorige programma inlezen**: sleep een bestand erop en de app vult de startbalans in. Jij kijkt het na
  en vinkt aan wat klopt:
  - een **auditfile** (XAF) uit bv. SnelStart, e-Boekhouden, Moneybird, Exact of Jortt: saldi, openstaande facturen
    per klant en leverancier, bus en gereedschap, btw, omzet en kosten tot de instapdatum, klanten en leveranciers;
  - een **kolommenbalans** als Excel (bv. uit DigiBoox) of een **saldibalans** (Excel of CSV);
  - een **lijst met openstaande facturen** (Excel of CSV): losse facturen in plaats van één totaal, zodat betalingen
    vanzelf koppelen. De app controleert of het totaal aansluit op je startbalans.
  De app herkent zelf wat voor bestand het is en welke kolom wat is. Lukt dat niet, dan stelt hij hooguit drie korte
  vragen en onthoudt hij het antwoord. Er is een voorbeeldbestand om in te vullen. Openstaande facturen kun je ook
  als **e-factuur** (UBL) erop slepen. Betalingen kort na de overstap die bij een oude factuur of de vorige
  btw-aangifte lijken te horen, stelt de app voor.
- Bedragen uit de overstap mogen voorlopig zijn (bv. als de jaarrekening nog niet klaar is). Aanpassen kan later
  altijd. Laat je startbalans nakijken door je boekhouder.

- **Bonnen in dollars die er al in stonden** (#74): oudere versies lazen "$ 90,00" als € 90,00. De app vindt die
  bonnen nu en rekent ze om:
  - een bon die je nog moet controleren wordt vanzelf opnieuw beoordeeld (er was nog niets geboekt);
  - een geboekte aankoop zie je op Vandaag en bij Aankopen ("staat als euro's in je boekhouding"). Bij **Nakijken**
    zie je wat er verandert: het bedrag dat van je rekening is afgeschreven komt in de boekhouding en de betaling
    wordt gekoppeld; zonder betaling de ECB-koers. **Alles omrekenen** doet ze in één keer. De oude boeking krijgt
    een tegenboeking; is de btw-aangifte van dat kwartaal al gedaan, dan gaat het verschil mee in de volgende;
  - staat de betaling al rechtstreeks als kosten geboekt, dan was de aankoop dubbel: die haalt de app weg en de
    bon wordt het bewijsstuk bij die betaling;
  - een aankoop zonder bon (of met een ander bedrag) reken je om met 💱 in de lijst met aankopen.
- **Niet meer dubbel**: een nieuwe bon in dollars bij een betaling die je al als kosten boekte, wordt het bewijsstuk
  in plaats van een tweede aankoop; en dezelfde bon nog eens toevoegen wordt herkend, ook als die eerder als euro's
  geboekt is.
- **Bon als PDF van meerdere pagina's** (#80): bij het nakijken zie je nu alle pagina's onder elkaar.
- **Doorgestuurde mail als bon** (#79): de tekst van de oorspronkelijke mail komt mee, ook uit een doorgestuurde
  .eml, en je eigen tekst erboven overstemt die niet meer.

## 0.3.9 — aankopen in vreemde valuta (dollars, ponden, …)

- **Aankopen in dollars (en andere munten)** (#74): de app herkent een bon of factuur in een andere munt ($, USD,
  £, CHF, …) en boekt hem in euro's, zonder extra velden:
  - staat de betaling al op de bank, dan telt **het bedrag dat de bank afschreef** (de echte koers). Bank en bon
    worden gekoppeld, ook al verschilt het bedrag door de koers van je bank;
  - nog geen betaling: omgerekend met de **dagkoers van de Europese Centrale Bank** op de factuurdatum (alleen
    de munt en de datum gaan naar de ECB; de koers wordt bewaard). Komt de betaling later, dan koppelt de app hem
    en boekt het kleine verschil als **koersverschil**;
  - geen internet: de app gokt niets en vraagt het bedrag in euro's zoals afgeschreven.
  Bij de bon en in de lijst met aankopen staat het oorspronkelijke bedrag en de koers erbij. Btw van een
  leverancier buiten de EU (verlegd, rubriek 4a) gaat over het bedrag in euro's. Laat de koers en de btw altijd
  controleren door je boekhouder.

## 0.3.8 — bonnen lezen naar keuze, vragen stellen via Claude Code/Codex, btw-termijn en potjes

- **Verbeteringen na de review**: een potje zonder IBAN wordt nu apart bijgehouden, zodat een afschrift met een
  nieuw rekeningnummer nooit op een potje terechtkomt en alleen echte potjes als "Naar potje" verschijnen;
  twee rekeningen met dezelfde naam kan niet meer; het btw-bedrag dat je bij een bon ziet is wat er geboekt
  wordt, en kan niet hoger zijn dan het tarief toelaat; "Payment date" wordt niet meer als factuurdatum gezien.
- **Kiezen hoe de app bonnen leest**: bij de eerste foto van een bon (en in Instellingen → Automatisch &
  herkenning) kies je, met uitleg:
  - **op deze computer**: eenmalig ± 1,5 GB downloaden, daarna zonder internet; alles blijft op je computer;
  - **met je eigen Claude Code** (Anthropic) of **Codex** (OpenAI), als je dat hebt: geen download, maar de foto
    gaat naar Anthropic of OpenAI. De assistent krijgt alleen die ene foto (in een lege map), mag verder niets
    (alleen lezen, geen andere hulpmiddelen) en heeft een tijdslimiet;
  - **zelf invullen**.
  De app installeert Claude Code of Codex niet en zoekt er pas naar als jij op **Zoek op deze computer** klikt
  (of het programma zelf aanwijst met **Kies zelf…**); wat gevonden is wordt onthouden. **Inloggen** opent een
  terminal met het programma erin; **Controleer** stuurt een heel klein proefbericht om te zien of het werkt.
  Bonnen die nog klaarlagen worden na het kiezen vanzelf gelezen. Wat de app leest is een voorstel: jij klikt
  op "Klopt", er wordt niets geboekt zonder dat je het ziet.
- **Vragen stellen over je boekhouding met Claude Code of Codex**: in Instellingen → Automatisch & herkenning
  voeg je met één klik (of een opdracht voor de terminal) een koppeling toe. Daarna vraag je bv. "Waarom is mijn
  btw dit kwartaal zo hoog?". De koppeling kan **alleen lezen**: de administratie wordt alleen-lezen geopend en
  er zijn alleen hulpmiddelen die iets opzoeken (overzicht, Vandaag, btw per periode en per vak, facturen,
  aankopen, bank, klanten, zoeken, inkomstenbelasting). Je vraag en wat de assistent opzoekt gaan naar
  Anthropic of OpenAI. Uitleg over btw of belasting is geen advies: laat het controleren door je boekhouder.

- **Btw-aangifte na de uiterste datum**: Vandaag bleef om de aangifte van een vorig kwartaal vragen, ook als je
  die al buiten de app deed. Nu vraagt de app na de uiterste datum eerst "Al gedaan, bv. via Mijn
  Belastingdienst of je boekhouder?" met de knop **Al ingediend** (die kan ook bij openstaande controles). Ook
  vóór de uiterste datum staat *Al ingediend* erbij. Op het Belasting-scherm zie je bij een lopend kwartaal
  wanneer je de aangifte doet.
- **Potje zonder eigen rekeningnummer** (bv. een Knab-potje voor de btw): een rekening toevoegen kan nu ook
  zonder IBAN. Bij een betaling kies je dan "Naar potje …" of "Uit potje …": geen kosten, niets "onderweg".
- **Bon controleren**: het formulier past weer binnen de kaart; het factuur- of bonnummer en het btw-bedrag kun
  je nu zelf aanpassen. Engelse facturen: datums als "May 6, 2026" worden herkend en een kopje als "Date of
  issue" wordt niet meer als leverancier gezien. Anthropic is een bekende leverancier (software, btw verlegd
  van buiten de EU). Datumvelden staan in het Nederlands (dd-mm-jjjj), ook op een Engelstalige computer.

## 0.3.7 — verkoop via een ander systeem (Mollie, webshop, kassa)

- **"Verkoop via een ander systeem"** (bij geld dat binnenkomt; heette "Omzet zonder factuur (contant/pin)"):
  voor een klant die je betaalde via bv. Mollie, je webshop, kassa, pin of contant, of voor een factuur die je
  ergens anders maakte. Zonder koppeling:
  - Je kiest nu zelf de btw; voorheen was dit altijd 21%, ook bij een klant in het buitenland. De app doet een
    voorstel op basis van de klant (herkend op IBAN of naam) of het land van de rekening; bij een klant buiten
    de EU is dat 0%. Het bedrag komt dan in de juiste rubriek van de aangifte.
  - Je kunt de naam van het systeem (bv. "Mollie") en het nummer van de factuur of bon erbij zetten; het
    nummer haalt de app zo mogelijk al uit de omschrijving van de bank. Je boekhouder vindt de factuur zo terug.
  - **De app onthoudt het**: bij de volgende betaling van dezelfde betaler vraagt Vandaag "Weer een verkoop via
    Mollie, net als vorige keer (klant buiten de EU, 0% btw)?" en is één klik op *Klopt* genoeg.

## 0.3.6 — automatisch bijwerken, zichtbaar en uit te zetten

- **Automatisch bijwerken, maar zichtbaar**: staat standaard aan. De app kijkt nu elke 4 uur (niet alleen bij
  het opstarten), downloadt op de achtergrond en installeert als je de app sluit. Bovenaan verschijnt
  "Versie … staat klaar" met *Wat is er nieuw?* en *Nu herstarten*; de app herstart nooit vanzelf midden in je
  werk. Bij de eerste start van een nieuwe versie maakt de app eerst een kopie van je administratie. Tevreden
  met wat je hebt? Zet het uit bij Instellingen → Back-up, demo & updates; *Zoek naar updates* werkt dan nog wel.

## 0.3.5 — mail doorsturen, bonnen in de mail en controles oplossen

- **Bon in de mail zelf** (geen bijlage), bijvoorbeeld van een webshop, Uber of een app: staat er een woord als
  factuur, bon of bestelling in én een bedrag, dan bewaart de app de mail als PDF-bon bij Aankopen & bonnetjes,
  om te controleren. Alleen de tekst: plaatjes, links en scripts uit de mail komen er niet in. Mist de app er
  een? Bij Instellingen → E-mail → Laatste berichten staat *Als bon bewaren*, en bij "factuur staat online" op
  Vandaag *Mail als bon bewaren*.

- **Facturen doorsturen naar je administratie-mailbox werkt nu**: mail vanaf je eigen adres werd overgeslagen
  (bedoeld voor kopieën van je eigen facturen), dus ook een factuur die je zelf doorstuurde. Nu wordt alleen
  een kopie van je eigen factuur of offerte overgeslagen (herkend aan je factuur- of offertenummer). Ook een
  mail die je "als bijlage" doorstuurt, wordt uitgepakt. Mail die eerder zo is overgeslagen, wordt na de
  update nog één keer bekeken.
- **"Nu ophalen"** zegt nu ook hoeveel mail er zonder factuur of bon was.

- **"Oplossen" laat nu zien welke betalingen het zijn**: bij "… staat nog bij *weet ik nog niet*", geld
  "onderweg", geld bij je betaalprovider, contant geld onder nul of een spaarrekening onder nul opent een
  lijst met de boekingen die samen dat bedrag vormen. Met *Opnieuw indelen* ga je naar die betaling. Voorheen
  kwam je alleen op het bankscherm en moest je zelf zoeken.
- **Ongedaan maken bij een betaling**: je blijft op dezelfde pagina en kiest meteen wat het wel was, in plaats
  van terug naar de lijst te gaan.

## 0.3.4 — getest in de browser: kleine verbeteringen

- **Factuur of offerte meteen versturen**: bij een nieuwe factuur of offerte staat *Versturen* er nu meteen
  (de app slaat eerst op). Voorheen moest je eerst op *Opslaan* klikken voordat die knop verscheen.
- **Versturen: het e-mailadres van de klant staat er weer in**, ook als je direct na het opslaan verstuurt.
- **Esc in een venster binnen een venster** (bv. *+ Eigen categorie* bij een bonnetje) sluit nu alleen dat
  venster. Voorheen ging het bonnetje-venster ook dicht en was je ingevulde gegevens kwijt.
- **Kleiner laptopscherm**: de lijst met aankopen past weer zonder opzij te schuiven.
- **Schermlezers**: de velden in de factuurregels en lege kolomkoppen hebben nu een naam.
- **End-to-end tests** (Playwright): de belangrijkste dingen die je in de app doet, worden bij elke wijziging
  automatisch in een echte browser doorlopen, met een controle op toegankelijkheid. Zie `e2e/README.md`.

## 0.3.3 — bonnetjes per mail, eigen categorieën en btw-details

- **Waar komt dit bedrag vandaan?** Bij Belasting klik je op Omzet, ontvangen btw of terug te krijgen btw
  (of op 🔍 details bij een vak van de aangifte) en je ziet welke boekingen erin zitten: datum, klant of
  leverancier, en of het uit een factuur, een bankbetaling, een bonnetje of een handmatige boeking komt. Met
  *Bekijken* ga je er meteen heen. Omzet zonder factuur die van de bank komt, wordt apart uitgelegd.

- **Bonnetjes per mail**: geef je administratie een eigen mailadres (bijvoorbeeld administratie@jouwbedrijf.nl)
  en vul het in bij Instellingen → E-mail → Inkomende post. De app kijkt bij het opstarten en elk kwartier
  (of met *Nu ophalen*) en zet facturen en bonnen uit de bijlagen klaar bij Aankopen & bonnetjes. Er wordt
  niets vanzelf geboekt: alles wacht op je controle. Veilig:
  - alleen echte PDF's, foto's en e-facturen (gecontroleerd op de inhoud, niet op de naam), geen logo's,
    hoogstens 10 MB per bijlage;
  - mail wordt nooit verwijderd; mail met een opgehaalde bijlage gaat naar de map "Verwerkt";
  - gelezen of gearchiveerde mail gaat niet mis en komt niet dubbel binnen: de app onthoudt welke berichten
    hij al zag, en kan desgewenst ook je archiefmap doorzoeken (daar wordt niets verplaatst);
  - mail van een klant blijft ongelezen en onaangeroerd; je krijgt een seintje op Vandaag, bij de klant en
    op de factuur;
  - "je factuur staat online" zonder bijlage wordt een taak op Vandaag, met alleen de naam van de website
    (geen link om op te klikken: nep-mails met links zijn een bekende truc);
  - andere mail blijft gewoon staan.
  Met een kant-en-klare tekst om naar je leveranciers te sturen.
- **Antwoorden gaan naar**: bij de uitgaande mail kun je instellen waar klanten op antwoorden, bijvoorbeeld
  je gewone mailadres.

- **Eigen categorieën** bij "Was dit zakelijk?" en bij bonnetjes: met *+ Eigen categorie* voeg je er een toe
  (bijvoorbeeld Vakliteratuur of Steigerhuur), met *✎ Aanpassen* verander je naam, uitleg en btw van alle
  categorieën, of verberg je wat je niet gebruikt. Ook onder Instellingen → Categorieën. Veilig: er wordt nooit
  iets verwijderd, eerdere boekingen veranderen niet mee, en een eigen categorie boekt op de rekening van een
  vaste soort kosten ("hoort bij"), zodat je boekhouder alles terugvindt. Een aangepaste vaste categorie kan
  terug naar de standaard.

- **Offerte ziet er niet meer uit als een factuur**: uitleg bovenaan (een prijsvoorstel, nog niets in je
  boekhouding; bij "ja" wordt het met één klik een factuur), "Wat ga je doen?" in plaats van "Wat heb je
  gedaan?", en voorbeeldteksten die bij een offerte passen.
- **Geen opmaak-keuze meer in beeld** bij factuur en offerte: de standaard is goed. Wie zelf een opmaak
  heeft gemaakt, kiest die onder "Andere opmaak kiezen".
- **Omschrijving van een regel is weer breed**: een lang btw-label drukte het veld eerder samen.

- **E-mail testen**: *Test verbinding* gebruikt nu wat je hebt ingevuld, ook een ingetypt wachtwoord dat
  nog niet was opgeslagen (na een geslaagde test wordt het meteen bewaard). Voorheen kwam dan de melding
  'Missing credentials for "PLAIN"'. Foutmeldingen van de mailserver staan nu in gewone taal (wachtwoord
  ontbreekt, inloggen lukt niet, server niet gevonden, poort en beveiliging passen niet). Een waarschuwing
  als het afzenderadres een ander domein heeft dan je gebruikersnaam (tikfout?).
- **Buitenlandse klant met eigen bedrijfsnummer**: bij een klant buiten Nederland heet het veld
  "Handelsregisternummer" en hoeft het geen 8-cijferig KvK-nummer te zijn (bijvoorbeeld een Zwitserse UID
  `CHE-253.742.182`). Een Zwitsers btw-nummer mag met streepjes, punten en "MWST". Op de e-factuur komt een
  buitenlands nummer niet meer als Nederlands KvK-nummer te staan.

## 0.3.2 — buitenlandse klanten en te veel betaald

- **Land bij een klant**: het klantformulier (ook "Nieuwe klant" vanuit een factuur) heeft nu een landkeuze,
  met het btw-nummer erbij voor een buitenlandse klant. Voorheen kon je het land niet invullen, waardoor
  "Bedrijf in een ander EU-land (0%)" en "Klant buiten de EU (0%)" niet te gebruiken waren.
- **Btw bij buitenlandse klanten**: bij een klant buiten Nederland legt de factuur uit welke btw meestal
  hoort (bedrijf in de EU: verleggen; particulier in de EU: Nederlandse btw; buiten de EU: 0%), met een
  knop om alle regels goed te zetten. Vóór de btw-aangifte een signaal bij 21% op een factuur aan een
  bedrijf in een ander EU-land, en boven € 10.000 per jaar aan particulieren in andere EU-landen (OSS).
- **Klant heeft te veel betaald** (bijvoorbeeld een factuur twee keer betaald): een taak op Vandaag. Een
  terugbetaling aan die klant herkent de app aan het rekeningnummer en boekt hem niet als kosten.
## 0.3.1 — extra bankrekeningen en controles

- **Btw over privégebruik van een auto van de zaak** (vak 1d). Bij Instellingen → Btw vul je in of je er
  ook privé mee rijdt, de cataloguswaarde en sinds wanneer je de auto gebruikt. In de laatste aangifte van
  het jaar staat dan een controle met het bedrag (2,7% van de cataloguswaarde, vanaf het 5e jaar 1,5%, in het
  eerste jaar naar rato) en een knop *Neem op in deze aangifte*. Het jaaroverzicht heeft een notitie voor de boekhouder (ook over de
  bijtelling voor de inkomstenbelasting, die de app niet uitrekent).
- **Nieuwe controles vóór de btw-aangifte**: geld dat nog "onderweg" is tussen je eigen rekeningen, geld van
  een betaalprovider (Mollie, Stripe) dat nog niet op je bank staat, en een spaarrekening of potje dat onder
  nul staat. Zo merk je dat er een afschrift of beginsaldo ontbreekt.
- **Extra bankrekeningen** (Bank → Rekeningen → *Rekening toevoegen*): een spaarrekening, een btw-potje of
  een gewone tweede rekening. Naam en IBAN zijn te wijzigen, en elke rekening heeft een eigen beginsaldo
  (opnieuw invoeren vervangt het oude bedrag).
- **Overboekingen tussen eigen rekeningen** herkent de app aan het rekeningnummer. Ze tellen niet als omzet
  of kosten. Lees je van beide rekeningen het afschrift in, dan wordt de overboeking één keer geboekt en
  koppelt de app de andere kant eraan. Ongedaan maken draait beide kanten terug. Bij "voorzichtig" staat
  het als vraag op Vandaag, anders gebeurt het vanzelf.
- Releases krijgen de tekst uit deze CHANGELOG. De controlegetallen (`SHA256SUMS-*.txt`) gebruiken de
  bestandsnamen zoals ze op GitHub staan, zodat `sha256sum -c` de AppImage ook echt controleert.
## 0.3.0 — aftrekposten, demo en gewone taal

### Duidelijker
- **Alle teksten in gewone taal nagelopen** (meldingen, knoppen, foutmeldingen, taken op Vandaag). Vaktaal
  is vervangen of in één regel uitgelegd. Wat echt voor de boekhouder is, staat bij *Notities voor je
  boekhouder* in het jaaroverzicht en gaat mee met "Kopieer voor je boekhouder".
- Interne boekhoudfouten verschijnen niet meer als vaktaal, maar als een gewone melding.
- Overal "btw" (zoals de Belastingdienst het schrijft).
- Btw-overzicht: "Min: btw die je terugkrijgt" staat nu als positief bedrag; verlegde btw noemt ook buitenlandse leveranciers.
- Zoeken of filteren zonder resultaat toont "Geen facturen gevonden" in plaats van "Nog geen facturen".
- E-mail: bij SSL/TLS springt de poort mee naar 465 (STARTTLS: 587); "Verbinding testen" meldt als server of afzender ontbreekt.

### Nieuw
- **Aftrekposten** (Belasting → Aftrekposten, bedrijfsmiddelen en kilometers):
  - **Bedrijfsmiddelen en afschrijving**: aankopen vanaf € 450 worden bedrijfsmiddelen. De app schrijft ze
    lineair af (minstens 5 jaar) en boekt de afschrijving na afloop van het jaar. Verkopen verwerkt de app met
    de boekwaarde.
  - **Kleinschaligheidsinvesteringsaftrek (KIA)** en de desinvesteringsbijtelling (tabellen 2025 en 2026).
  - **Privéauto**: € 0,25 per zakelijke km (2025: € 0,23). Tanken en parkeren worden dan als privé
    voorgesteld en nooit automatisch als kosten geboekt.
  - **Etentjes, borrels & relatiegeschenken**: nieuwe categorie. De app telt 20% bij (of de drempel, als die lager is).
  - **Startersaftrek** en een **urenteller** voor het urencriterium (werkbonnen + losse uren).
  - **Voor je aangifte**: jaaroverzicht met per regel het bedrag, de uitleg en waar het in de aangifte hoort.
    Plus een signaal voor mogelijke EIA/MIA/Vamil, met de RVO-termijn.
  - **Investering of kosten?** Vanaf € 450 excl. btw vraagt de app bij het invoeren "Gaat dit langer dan
    een jaar mee?". Op Vandaag staat een vangnet voor wat toch als kosten is geboekt. Ook laptops, telefoons en
    aanhangers worden herkend. De grens rekent nu met het bedrag excl. btw.
  - **Telefoon, internet en werkplek thuis**: het zakelijke deel instellen (het privédeel telt bij de winst,
    met de btw-correctie), plus uitleg over de werkplek.
  - **Meewerkaftrek** voor een partner die onbetaald meewerkt.
  - **AOV en pensioen**: uitleg dat ze privé zijn, maar wel aftrekbaar in de aangifte.
  - **2027**: zelfstandigenaftrek € 900, startersaftrek € 10; vanaf 2028 geen startersaftrek.
  - **Altijd laten controleren**: bij elke IB-berekening de melding dat een boekhouder of accountant moet
    meekijken, eens per jaar bevestigen, en een knop "Kopieer voor je boekhouder".
  - De schatting van de inkomstenbelasting rekent dit allemaal mee.
  - Bestaande gebruikers krijgen één nieuwe onboardingstap: *Auto en startjaar*.
- **Demo**: bij de eerste start (of via Instellingen → Back-up, demo & updates) de app bekijken met een
  voorbeeldbedrijf: klanten, offertes, facturen (betaald, open, vervallen), een klus, bonnetjes en een
  bankafschrift. In de demo gaat er geen e-mail naar buiten; een balk bovenaan toont dat je in de demo zit.
- **Wissen en echt beginnen**: de demo met één klik wissen, of de hele administratie leegmaken (met
  bevestiging "WISSEN" en eerst automatisch een veiligheidskopie in de back-upmap). Daarna start de
  onboarding opnieuw.
- **Onboarding die zichzelf bijwerkt**: de stappen hebben een versie. Na een update zien bestaande
  gebruikers alléén de nieuwe of gewijzigde stappen (met "Later"), niet de hele onboarding. Nieuwe stap:
  "Hoeveel mag de app zelf doen?" (voorzichtig / normaal / maximaal).
- **Aan de slag** op Vandaag: een lijstje (bedrijfsgegevens, IBAN, eerste klant, factuur, bankafschrift,
  bonnetje, e-mail) dat zichzelf afvinkt op basis van wat er in je administratie staat.

## 0.2.0 — slimme automatisering

Uitgangspunt: niet invoeren, maar uitzonderingen afhandelen. Boekingen komen altijd uit vaste,
uitlegbare regels; herkenning en AI doen alleen voorstellen.

### Nieuw
- **Gebeurtenissen als bron van waarheid** (#19): elke boeking wordt "gecompileerd" uit wat er gebeurd
  is. Corrigeren = de gebeurtenis aanpassen; de app maakt de tegenboeking en de nieuwe boeking.
- **Autopilot met zekerheid per beslissing** (#21, #29): voorzichtig / normaal / maximaal. Alles wat
  automatisch ging staat op Vandaag, met de reden ("Waarom?", #28) en een knop "Klopt niet".
- **Eén "Nog te doen"-lijst met controles vóór de btw-aangifte** (#20): onverwerkte bank, uitgaven
  zonder bewijs, dubbele aankopen, verlegd zonder btw-nummer, negatieve kas, vraagposten.
- **Leveranciersregels leren**, ook van correcties, pas automatisch na jouw ja (#22).
- **Dubbele documenten** herkennen op inhoud (#31); **btw-correcties** op al aangegeven periodes, met
  suppletie boven € 1.000 (#27).
- **Vaste lasten en abonnementen** (#30): herkenning na drie betalingen, melding bij een ontbrekende
  factuur of afschrijving, factuur direct aan de afschrijving koppelen, "gestopt?".
- **Betalen met een betaal-QR** (EPC, #25) met waarschuwing als het IBAN anders is dan vorige keer.
- **Belastingpotje** (#33): opzijgezet / nog te reserveren, en "vrij te besteden".
- **E-factuur (UBL, Peppol BIS 3.0)** standaard als bijlage bij de factuurmail (#24); uit te zetten in
  Instellingen. Ontbreken er gegevens voor de e-factuur, dan gaat de PDF alleen mee.
- **Factuurregels herkennen** en een gemengde bon per soort boeken (materiaal, gereedschap, werkkleding,
  privé), met btw per deel (#23).
- **Zoeken over alles** met Ctrl+K, met bedrag- en periodefilters en garantie per aankoop (#26).
- **Klussendossier** (#32): resultaat per klus uit het grootboek, werkbon die de factuur vult, "Was dit
  voor de klus bij …?". Locatie van bonfoto's alleen na toestemming (standaard uit, alleen lokaal).
- **Buitenland** (#16): verkoop aan EU-bedrijven (3b, met ICP-overzicht), uitvoer (3a) en verlegde btw
  op diensten uit/buiten de EU (4a/4b, bv. Stripe, Google, Meta). Met disclaimer; OSS zit er niet in.
- **Schatting inkomstenbelasting** (#33): zelfstandigenaftrek, mkb-winstvrijstelling, geversioneerde
  tarieven; altijd als schatting gemarkeerd en uit te zetten.
- **Ingebouwde tekstherkenning** (#8, #9): één knop in Instellingen downloadt GLM-OCR (MIT) en
  llama.cpp (± 1,4 GB, controle via sha256). Daarna volledig lokaal op de CPU.
- **Synthetische OCR-benchmark** met Nederlandse bonnen en facturen (#8).

### Belangrijk om te weten
- De buitenland-rubrieken en de tarieventabel van de inkomstenbelasting zijn nog niet door een
  fiscalist gecontroleerd; de app zegt dat erbij. Zie #44 en `docs/fiscale-review.md`.
- De database wordt bij de eerste start automatisch bijgewerkt. Maak voor de
  zekerheid eerst een back-up (Instellingen → Back-up & updates).

## 0.1.0 — eerste release

MVP, V2 en V3 uit het technisch plan: facturen en offertes, bonnetjes met herkenning, bankimport en
koppelen, btw-aangifte, koppelingen met webshops en betaalproviders, en exports voor de boekhouder.
