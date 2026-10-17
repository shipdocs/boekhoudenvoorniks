---
titel: Bonnetjes en aankopen
omschrijving: Een bon toevoegen (foto, pdf, e-factuur, per mail of via je telefoon), nakijken wat de app ervan maakte, en wat je doet met een bon die niet klopt.
hoofdstuk: Dagelijks werk
volgorde: 20
---

## Een bon toevoegen

Ga naar *Aankopen & bonnetjes*. Je kunt een bon op vijf manieren toevoegen:

- **Slepen**: sleep een foto, pdf of e-factuur (UBL/XML) in het scherm.
- **Per mail**: laat leveranciers hun facturen naar je gratis bonnen-adres sturen, of stuur een bon zelf door. De app haalt ze op. Zie [Bonnen per mail](#bonnen-per-mail).
- **Telefoon**: scan de bon met de app voor Android; hij staat meteen in de lijst. Zie [Telefoon](telefoon.html).
- **Bonnenmap**: zet bonnen in een map op je computer; de app leest ze vanzelf. Instellen bij *Instellingen → Telefoon & bonnenmap*.
- **Zonder foto**: *Bonnetje zonder foto* voor een bon die je kwijt bent of een uitgave zonder bon. Vul in wat je weet.

E-facturen en pdf's met tekst leest de app altijd zelf. Een foto wordt gelezen door tekstherkenning op je eigen computer (de app vraagt de eerste keer of hij die mag downloaden), of door een hulpdienst die je zelf kiest bij *Instellingen → Automatisch & herkenning*.

## Bonnen per mail

Veel facturen komen per mail. De app kan ze zelf ophalen, op twee manieren.

### Het bonnen-adres (gratis)

Je krijgt een eigen mailadres voor je bonnen, bijvoorbeeld *bakkerijpi-k7m2q@post.boekhoudenvoorniks.nl*. Het begin is je bedrijfsnaam; de letters erachter zorgen dat niemand het adres kan raden. Je hoeft niets in te stellen.

1. Ga naar *Instellingen → E-mail* en klik bij *Bonnen-adres (gratis)* op *Bonnen-adres aanvragen*.
2. Kijk je e-mailadres, bedrijfsnaam en KvK-nummer na, lees wat er met je gegevens gebeurt en vink *Ik ga hiermee akkoord* aan. Klik op *Bonnen-adres aanvragen*.
3. Je krijgt een mail met een link. Open de link en klik op *Bevestigen*. Geen mail? Kijk ook bij ongewenste mail. De link werkt 24 uur.
4. Wij bekijken je aanvraag, meestal binnen een werkdag. Je krijgt een mail zodra je bonnen-adres klaar is, en de app ziet het vanzelf.
5. Geef het adres aan je leveranciers. Bij het adres staat een tekst die je kunt kopiëren en doorsturen.

Vanaf dan kijkt de app bij het opstarten en elk kwartier of er mail is. Op *Vandaag* staat ook de knop *Mail ophalen*. Met het bonnen-adres kun je alleen ontvangen, niet versturen. Mail die de app heeft verwerkt, staat op de server in de map *Verwerkt*. Alle mail op het bonnen-adres wordt 60 dagen na binnenkomst verwijderd; de bonnen zelf staan in je administratie. Haalt de app 30 dagen lang niets op (bijvoorbeeld omdat je de app niet opent), dan krijg je een mail.

Het bonnen-adres kan niet zonder sleutelhanger om de inloggegevens veilig te bewaren. Op sommige Linux-computers ontbreekt die; de app zegt het dan. Gebruik daar de Bonnenmap.

**Op een andere computer.** Zet je een back-up terug op een andere computer, dan zegt de app *Dit bonnen-adres hoort bij een andere computer*. Klik op *Hier gebruiken*. Je krijgt een link op het e-mailadres waarmee je het adres aanvroeg. Na bevestigen werkt het bonnen-adres op de nieuwe computer, en haalt de oude computer niets meer op.

**Stoppen.** Klik bij het bonnen-adres op *Stoppen*. Het adres ontvangt dan meteen niets meer en wordt na 30 dagen met alle mail verwijderd. De bonnen die al in je administratie staan, blijven. Haal je een administratie weg bij *Instellingen → Administraties*, dan stopt de app het bonnen-adres van die administratie eerst zelf. Vraag je later opnieuw aan, dan krijg je een nieuw adres; een oud adres wordt nooit opnieuw uitgedeeld.

### Je eigen mailbox koppelen

Heb je al een eigen mailadres voor je administratie, bijvoorbeeld *administratie@jouwbedrijf.nl*? Koppel het bij *Instellingen → E-mail → Je eigen mailbox koppelen*. Vul de server, de gebruikersnaam en het wachtwoord in (zoek bij je provider op *IMAP-instellingen*) en klik op *Test verbinding*. Dit blijft gratis en kan naast het bonnen-adres.

### Wat de app met de mail doet

- **Een factuur of bon als bijlage** (pdf, foto of e-factuur): komt bij *Aankopen & bonnetjes* en wacht op jouw controle. Er wordt niets vanzelf geboekt. De mail gaat naar de map *Verwerkt*.
- **"Je factuur staat online"** zonder bijlage: een taak op *Vandaag* om hem te downloaden.
- **Een bon in de mail zelf** (een webshop of app zonder pdf): de app bewaart de tekst als bon.
- **Mail van een klant**: blijft ongelezen en onaangeroerd; je krijgt een seintje op *Vandaag*.
- **Andere mail**: blijft gewoon staan. Is het toch een bon, klik dan bij *Laatste berichten* op *Als bon bewaren*.

## Nakijken

Bij een duidelijke bon vult de app alles in en verwerkt hij hem, afhankelijk van hoeveel de app van jou zelf mag doen. Twijfelt hij, dan staat de bon bij *Even controleren* en op *Vandaag*. Open hem en kijk de velden na:

- **Winkel / leverancier**, **Datum**, **Factuur- of bonnummer**.
- **Wat heb je gekocht?** De categorie bepaalt in welke kostensoort het komt. Typ een paar letters; de app leert van je keuzes.
- **Btw op de bon**: het bedrag zoals het op de bon staat. Staat er geen btw op (bijvoorbeeld een bon uit het buitenland of een particulier), zet dan *geen*.
- **Hoe betaald?** Via de bank, contant, privé, of *later* (dan is het een rekening die nog open staat).
- **Was dit zakelijk?** Helemaal, of een deel (bijvoorbeeld 50% bij een telefoon die je ook privé gebruikt). Het percentage onthoudt de app per leverancier; later aanpassen kan met de knop *%*.

Klopt alles? *Boeken*. Hoort de bon hier niet (dubbel, privé, van een ander bedrijf)? *Negeren*. De bon blijft bewaard, maar telt nergens mee.

## Grote aankopen: investering of kosten?

Bij een bedrag boven de grens voor investeringen vraagt de app *Even controleren*: *Ja, het is een investering* of *Nee, gewone kosten*. Een investering (bus, machine, laptop) schrijft de app over meerdere jaren af en telt mee voor de investeringsaftrek; dat regelt hij zelf. Kies je verkeerd, open de aankoop dan en zet het om.

## Al betaald, of nog betalen

- Een bon die je al betaald hebt via de bank: de app koppelt hem vanzelf aan de betaling op je afschrift. Is het afschrift er nog niet, dan wacht hij.
- Een rekening die je nog moet betalen: bij de aankoop staat *Betaal*. Die knop toont een betaal-QR of de gegevens; de app controleert daarbij of het rekeningnummer hetzelfde is als wat je eerder van deze leverancier kende.
- Heb je al betaald, maar niet via je zakelijke bank (contant, privé)? Kies *Al betaald* en zeg hoe.

## Garantie en klussen

Bij een aankoop kun je invullen hoeveel maanden garantie je hebt; later vind je dan terug of je nog garantie hebt. Hoort de aankoop bij een klus, klik dan op het hamertje (🔨) en kies de klus. Zie [Klussen](klussen.html).

## Een bon die niet klopt

- **Dubbel ingelezen**: de app herkent een kopie meestal zelf en zet hem op *Negeren* met de melding dat hij er al stond. Zie je hem toch dubbel, open de kopie en kies *Negeren*.
- **Verkeerde aankoop geboekt, nog niet betaald**: bij *Aankopen* staat *Weghalen*. De kosten en de btw gaan eruit; de bon zelf blijft bewaard en komt terug bij *Even controleren*.
- **Verkeerd gekoppeld aan een betaling**: open de betaling bij *Bank* en kies *Ongedaan maken*, of bij de bon *Koppeling ongedaan maken*. De aankoop zelf blijft staan.
- **Al betaald en al verwerkt**: maak eerst de betaling ongedaan bij *Bank*, dan kun je de aankoop weghalen.

> Bonnen van vóór je instapdatum horen in je vorige administratie. Voeg je er per ongeluk een toe, haal hem dan weg.
