# Wijzigingen

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
