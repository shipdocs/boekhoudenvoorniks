# Handmatige test: werken zonder internet (#458)

De site belooft dat het dagelijkse werk zonder internet werkt (`site/offline-boekhoudprogramma.html`,
`site/zonder-abonnement.html`, de FAQ op `site/index.html`). De rekenkern is daarop geautomatiseerd
getest: de relevante unittests slagen in een omgeving zonder netwerk (zie
`docs/onderzoek/458-offline-boekhouden.md`, §5). Wat die tests níet dekken, is de echte installatie en
de echte Electron-app zonder netwerk. Dat staat in dit stappenplan. Voer het één keer uit op Windows
(NSIS-installer) en één keer op Linux (AppImage of .deb), en opnieuw als er een netwerkfunctie bij komt.

## Voorbereiding

1. Download de installer en `SHA256SUMS-…txt` van `downloaden.html` **terwijl je nog internet hebt**.
2. Gebruik bij voorkeur een schone gebruiker of virtuele machine, zodat er geen oude gegevensmap is.
3. Leg een paar testbestanden klaar op de computer zelf (niet in de cloud):
   - een bankafschrift (CAMT.053 of MT940; een CSV van je eigen bank mag ook);
   - een bon als **pdf met tekst** of e-factuur (UBL) — die leest de app zonder download;
   - een bon als **foto** — om te zien wat de app zegt zonder tekstherkenning.
4. Zet het netwerk uit:
   - Windows: vliegtuigmodus aan, of de netwerkadapter uitschakelen. Controleer in een browser dat
     een website niet laadt.
   - Linux: `nmcli networking off` (of de kabel/wifi uit). Controleer met `ping -c1 1.1.1.1`.

Vul per stap het resultaat in. Noteer bij een afwijking de versie (Instellingen → Over) en wat er op
het scherm stond.

## 1. Installeren en eerste start

1. Installeer de app (Windows: dubbelklik de `.exe`; Linux: `chmod +x` de AppImage of `sudo apt install ./….deb`).
   Verwacht: de installatie lukt zonder netwerk (de NSIS-installer is volledig, geen webinstaller).
2. Start de app en doorloop het eerste scherm (bedrijfsgegevens, eerste administratie).
   Verwacht: geen foutmelding en geen wachten op een verbinding; er wordt geen account gevraagd.
3. Controleer dat de gegevensmap bestaat: `%USERPROFILE%\BoekhoudenVoorNiks` (Windows) of
   `~/BoekhoudenVoorNiks` (Linux), met `boekhouding.sqlite` erin.

   Resultaat: installeren en eerste start zonder netwerk
   ☐ geslaagd ☐ niet geslaagd — bevinding: ______________________________

## 2. Factureren

1. Maak een klant aan en een factuur (*Werk & facturen* → *+ Nieuwe factuur*), definitief maken.
2. Bewaar de pdf en de e-factuur (UBL) als bestand.
   Verwacht: beide bestanden worden gemaakt; de pdf ziet er normaal uit (geen ontbrekend lettertype of logo).
3. Probeer de factuur te mailen.
   Verwacht: een duidelijke melding dat versturen niet lukt; de factuur blijft bewaard en er gaat
   niets verloren. Bij *Versturen met je eigen mailprogramma* opent het mailprogramma gewoon (het
   versturen zelf wacht dan in je outbox).

   Resultaat: factuur maken, pdf en UBL bewaren zonder netwerk
   ☐ geslaagd ☐ niet geslaagd — bevinding: ______________________________

## 3. Bankafschrift inlezen

1. Sleep het afschrift op het Bank-scherm.
   Verwacht: de regels komen erin; betalingen die bij de factuur van stap 2 passen, worden voorgesteld
   of gekoppeld. Lees hetzelfde afschrift nog eens in: verwacht "stonden er al", geen dubbele regels.

   Resultaat: afschrift inlezen en opnieuw inlezen zonder netwerk
   ☐ geslaagd ☐ niet geslaagd — bevinding: ______________________________

## 4. Bonnen

1. Voeg de pdf-bon of e-factuur toe.
   Verwacht: bedrag, datum en leverancier worden gelezen; de bon staat klaar om te controleren.
2. Voeg de foto-bon toe.
   Verwacht: de bon staat erin om zelf in te vullen en er verschijnt geen vastloper. Noteer wat de app
   zegt over de tekstherkenning: is die nog niet geïnstalleerd, dan kan dat nu niet (de download van
   ongeveer 1,5 GB vraagt internet). De melding moet dat duidelijk maken.
3. (Alleen als je een bon in een andere munt hebt) Voeg die toe.
   Verwacht: de app vraagt het bedrag in euro's in te vullen, omdat de koers niet opgehaald kan worden.

   Resultaat: bonnen toevoegen zonder netwerk
   ☐ geslaagd ☐ niet geslaagd — bevinding: ______________________________

## 5. Btw-overzicht en pakket voor je boekhouder

1. Open het btw-overzicht van het kwartaal.
2. Maak het pakket voor je boekhouder (auditfile en overzichten) en bewaar het als bestand.
   Verwacht: beide werken; het pakket bevat een `.xaf` en de CSV-overzichten.

   Resultaat: btw-overzicht en pakket zonder netwerk
   ☐ geslaagd ☐ niet geslaagd — bevinding: ______________________________

## 6. Back-up maken en terugzetten

1. Instellingen → *Back-up, demo & updates* → *Back-up maken*. Bewaar hem bijvoorbeeld op een USB-stick.
2. Maak ook een versleutelde back-up met een wachtwoord.
3. Wijzig iets herkenbaars (bijvoorbeeld de naam van de klant).
4. *Back-up terugzetten…* met de eerste back-up.
   Verwacht: de wijziging van stap 3 is weg, de factuur en de bijlagen zijn er nog.
5. Zet de versleutelde back-up terug (wachtwoord invullen).
   Verwacht: idem; met een verkeerd wachtwoord een duidelijke melding.

   Resultaat: back-up maken en terugzetten (gewoon en versleuteld) zonder netwerk
   ☐ geslaagd ☐ niet geslaagd — bevinding: ______________________________

## 7. Herstarten en achtergrondtaken

1. Laat de app minstens vijf minuten open staan (de achtergrondtaak draait kort na het starten).
2. Sluit de app en start hem opnieuw.
   Verwacht: geen foutvensters of meldingen die blijven terugkomen. Bij Instellingen → *Back-up, demo
   & updates* mag bij updates staan dat er geen verbinding met GitHub is; verder werkt alles.
3. Is het abonnement actief (of de proefperiode), controleer dan dat de extra functies blijven werken
   zonder netwerk (de licentie wordt op de computer zelf gecontroleerd).

   Resultaat: herstarten zonder netwerk, geen terugkerende foutmeldingen
   ☐ geslaagd ☐ niet geslaagd — bevinding: ______________________________

## 8. Netwerk weer aan

1. Zet het netwerk weer aan en wacht een paar minuten (of kies *Zoek naar updates*).
   Verwacht: updates, e-mail en eventuele koppelingen werken weer, zonder dat je iets opnieuw hoeft in te stellen.

   Resultaat: na het aanzetten van het netwerk werkt alles weer
   ☐ geslaagd ☐ niet geslaagd — bevinding: ______________________________

## Afronden

Klopt een stap niet met wat de site belooft, maak dan een issue met de bevinding en verwijs naar #458.
Getest door: ____________ · Datum: ____________ · Versie: ____________ · Windows / Linux (doorhalen)
