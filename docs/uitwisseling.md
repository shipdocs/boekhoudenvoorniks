# Uitwisseling met de boekhouder: technisch ontwerp

Status: stap 1 t/m 4 van de bouwvolgorde zijn **gebouwd** (zie onderaan); de licentie (stap 4) staat
nog uit tot de licentie-Worker live is. Per onderdeel staat wat gebouwd is en waar het afwijkt van het oorspronkelijke ontwerp.
Code: `src/exchange/` (versleuteling, uitwisseling), `src/closing/` (periodeslot),
`src/main/administrations.ts`. Tests: `tests/uitwisseling.test.ts` (de hele cyclus met echte
bestanden), `tests/uitwisseling-crypto.test.ts`, `tests/periodeslot.test.ts`, `e2e/uitwisseling.spec.ts`.

Dit document beschrijft hoe een klant een deel van zijn administratie naar zijn boekhouder stuurt,
de boekhouder die in BoekhoudenVoorNiks controleert en corrigeert, en de klant het antwoord weer
inleest zonder dat werk van tussendoor verloren gaat. Het bestaande **pakket voor je boekhouder**
(ZIP met XAF, zie [boekhouders.md](boekhouders.md)) blijft bestaan voor boekhouders die in hun eigen
software werken; dat gaat maar één kant op.

## Uitgangspunten

1. **De administratie van de klant is de echte.** De kopie van de boekhouder is een werkkopie; er
   worden nooit twee databases samengevoegd.
2. **De boekhouder werkt in BoekhoudenVoorNiks**, in de kantoormodus. Er is geen terugweg uit andere
   boekhoudsoftware.
3. **Niets dat wij beheren.** Geen server, geen portaal, geen account. Transport gaat via e-mail
   (eigen SMTP), een gedeelde map (OneDrive, Dropbox, Nextcloud, …) of een los bestand.
4. **De beveiliging zit in het pakket, niet in het transport.** Een onderschept pakket is onleesbaar,
   en een vervalst of verkeerd pakket wordt geweigerd.
5. **De werkwijze volgt de periode-uitwisseling van SnelStart**, die boekhouders al kennen: één
   uitwisseling tegelijk, met een nummer; de klant werkt door na de einddatum; het antwoord moet het
   nummer van de laatste export hebben; klant en boekhouder gebruiken dezelfde versie van de app.

## Werkwijze

```
boekhouder                                   klant
──────────                                   ─────
Klant uitnodigen ──── uitnodiging.gbuitnod ───▶ Uitnodiging openen
  (kantoornaam, e-mail, publieke sleutel)         → gekoppeld, e-mailadres boekhouder ingesteld

                                             Naar boekhouder sturen (t/m einddatum)
                                               controles: bank sluit aan, niets open
                                               periode t/m einddatum op slot
                 ◀──── export-17.gbpakket ────
Inlezen → werkkopie (kantoormodus)
Controleren, corrigeren, vragen
Antwoord maken ──── antwoord-17.gbpakket ────▶ Antwoord inlezen
                                               samenvatting "7 aanpassingen", inlezen
                                               periode t/m einddatum afgesloten
```

Het uitwisselingsnummer (hier 17) loopt per administratie op.

## Spelregels

| # | Regel | Waarom |
|---|---|---|
| 1 | Er loopt hooguit **één uitwisseling** per administratie. | Het antwoord past altijd op precies één export. |
| 2 | Exporteren kan alleen als **de bank tot en met de einddatum aansluit** (alle afschriften ingelezen, saldo gelijk) en er in de periode **niets open staat** (geen onverwerkte bankregels of bonnen). | Een bankmutatie kan niet naar een latere periode verschoven worden; een late mutatie in een vergrendelde periode is een fout (ontbrekend afschrift), geen late post. |
| 3 | Na het versturen ligt alles **tot en met de einddatum vast**. De klant werkt door na de einddatum. | De periode van de klant blijft precies gelijk aan wat de boekhouder heeft; daardoor hoeft niets samengevoegd te worden. |
| 4 | Tijdens de uitwisseling kan de klant **geen grootboekrekeningen** toevoegen, hernoemen of archiveren. | De handelingen van de boekhouder verwijzen naar rekeningen. |
| 5 | Het antwoord wordt alleen ingelezen als het **uitwisselingsnummer** en het **administratie-ID** kloppen en **de app-versie gelijk** is. Anders: eerst updaten. | Dezelfde versie betekent dezelfde boekingsregels (`RULES_VERSION`), dus dezelfde uitkomst bij het opnieuw uitvoeren. |
| 6 | Een nieuwe export kan pas na het inlezen van het antwoord. De klant kan een uitwisseling **afbreken** (bijvoorbeeld als de boekhouder niet reageert); een antwoord op een afgebroken uitwisseling wordt daarna geweigerd. | De klant zit nooit vast. |
| 7 | Na het inlezen is de periode **afgesloten**. Correcties daarna komen in een open periode, met een verwijzing. | Afgewerkt is afgewerkt. |

## Periodeslot

**Gebouwd** (stap 2 van de bouwvolgorde; migratie 22, `Ledger`, `src/closing/period-close.ts`).

Tot dan vergrendelde alleen een ingediende btw-periode, en alleen de btw: een late post kreeg een
`vat_date` in de volgende open periode, maar de boeking zelf kwam op de echte datum. Het periodeslot
vergrendelt de hele boekhouding.

**Opslag.** `ledger_locks` met één rij per slot (`until_date`, `kind` = `afgesloten` of `uitwisseling`,
`exchange_no`). Alles t/m de hoogste `until_date` ligt vast. Een afgesloten slot kan niet verwijderd of
gewijzigd worden (trigger); een uitwisseling wordt `afgesloten` als het antwoord is ingelezen
(`finishExchange`) of verdwijnt bij afbreken (`abortExchange`).

**Afdwingen.** Op twee plekken, zodat geen route er omheen kan (automatisch verwerken, vaste lasten,
afschrijvingen, koppelingen, "Klopt niet"):

- `Ledger.post` bepaalt de boekingsdatum:
  - open periode: de eigen datum;
  - afgesloten, en het is een bon, factuur of koppeling (`inkoop`, `factuur`, `integratie`): de eerste
    open dag, met "(documentdatum …)" in de omschrijving. Het document en de gebeurtenis houden hun
    echte datum; de btw volgt de documentdatum (`vatDateFor`), dus hoort bij de btw-periode van het
    document zolang die niet is aangegeven;
  - afgesloten, en het is een betaling (`bank`), memoriaalpost (`handmatig`) of beginbalans: geweigerd
    (`PeriodLockedError`, een gewone melding en geen interne boekhoudfout);
  - bij de boekhouder: altijd geweigerd.

  Een tegenboeking volgt dezelfde regels, dus iets uit een afgesloten periode corrigeren komt vanzelf
  in de open periode.
- Triggers in de database als vangnet: geen `INSERT` in `journal_entries` t/m het slot, en tijdens een
  uitwisseling geen statuswijziging (terugdraaien, vervangen) van posten en gebeurtenissen in de periode.

Uitzonderingen: posten met `source = 'btw'` (de aangifte wordt op de laatste dag van de btw-periode
geboekt, dus binnen het slot) en alles binnen `PeriodCloseService.withoutLock()` (het inlezen van het
antwoord van de boekhouder; een rij in `ledger_lock_bypass` voor de duur van de transactie). Ook
migraties draaien zonder slot (`migrate()`).

**Afwijkingen van het eerdere ontwerp:**

- Na het **afsluiten** mag de status van een oude post nog veranderen (terugdraaien), omdat de
  tegenboeking in de open periode komt en het afgesloten kwartaal zelf dus niet verandert. Alleen
  tijdens een **uitwisseling** is dat geblokkeerd, zodat de handelingen van de boekhouder passen.
- Het **rekeningschema** wordt tijdens een uitwisseling in `Ledger` beschermd (toevoegen, hernoemen,
  RGS-code, archiveren), niet met een trigger: een trigger zou ook migraties en het aanvullen van
  standaardrekeningen tegenhouden.
- **"De bank sluit aan"** is: geen onverwerkte betalingen t/m de einddatum (blokkeert), en afschriften
  die t/m de einddatum lopen. Dat laatste moet de gebruiker bevestigen als het niet zo is, want een CSV
  zonder betalingen bestaat niet: een rekening waar in december niets gebeurde, heeft geen afschrift
  van december. Een saldovergelijking met het afschrift zit er niet in.

**Controles vóór het afsluiten** (`PeriodCloseService.checks`):

| Controle | Niveau |
|---|---|
| Betalingen t/m de einddatum nog niet verwerkt | blokkeert |
| Bonnen of facturen t/m de einddatum nog niet gecontroleerd | blokkeert |
| Afschriften van een rekening lopen niet t/m de einddatum | bevestigen |
| Conceptfacturen met een datum t/m de einddatum | ter info (worden bij definitief maken een late post) |

**Late bankmutaties** met een datum in een vergrendelde periode worden niet automatisch verwerkt en
staan niet als vraag op Vandaag, maar als één melding: "3 betalingen in de afgesloten periode", met het
advies de boekhouder te vragen hoe ze verwerkt worden.

**Scherm.** *Hoe gaat het?* > *Periode afsluiten*: kies het eind van een afgelopen kwartaal (of het
jaar), zie de controles, bevestig wat bevestigd moet worden, en sluit af. Vóór het afsluiten maakt de app
een complete back-up in de back-upmap van de administratie. Afsluiten kan niet ongedaan gemaakt worden.

**De btw-aangifte blijft mogelijk** voor een afgesloten periode en tijdens een uitwisseling. Het maakt
niet uit of de aangifte vóór of na het inlezen van het antwoord gedaan wordt: correcties van de
boekhouder in een al aangegeven periode krijgen via `vatDateFor` een btw-datum in de eerstvolgende open
periode (boven € 1.000 btw: een suppletie). Let op bij het **vierde kwartaal**: is dat al aangegeven,
dan komen de btw-correcties van de jaarafsluiting in het eerste kwartaal van het nieuwe jaar. Winst en
verlies blijven wel in het oude jaar, omdat de boeking zelf haar eigen datum houdt.

## Sleutels en pakketformaat

**Gebouwd** (`src/exchange/crypto.ts`), zoals hieronder, met deze details:

- De kantoorsleutel staat niet in een administratie maar in `kantoor.json` in de gegevensmap, want
  hij hoort bij het kantoor en niet bij één klant. De privésleutel is versleuteld met `safeStorage`;
  zonder sleutelhanger (Linux zonder keyring) weigert de app hem op te slaan.
- Uitnodiging: `{ "type": "boekhoudenvoorniks-uitnodiging", "versie": 1, "kantoor", "email",
  "publiekeSleutel" }`, bestand `uitnodiging-<kantoor>.gbuitnodiging`.
- HKDF-SHA256 met als salt de eenmalige plus de publieke sleutel van het kantoor en als info
  `boekhoudenvoorniks-pakket-v1`.
- Bestandsnamen: `export-<8 tekens administratie-ID>-<nr>.gbpakket` en `antwoord-…-<nr>.gbpakket`.
- De app-versie moet gelijk zijn bij het openen van de export (kantoor) én bij het inlezen van het
  antwoord (klant).
- **Kantoorsleutel delen** (besluit 3): *Instellingen > Administraties > Met collega's werken*. Een
  bestand `kantoorsleutel-<kantoor>.gbkantoor` (MAGIC `GBKANTOR`, scrypt + AES-256-GCM, wachtwoord van
  minimaal 10 tekens, apart doorgeven). Bij het inlezen controleert de app of de privésleutel bij de
  publieke hoort; een eigen sleutel wordt vervangen, met een waarschuwing.
- Is de kantoorsleutel niet te openen (geen sleutelhanger, andere sleutelhanger), dan meldt de app dat en
  biedt hij expliciet een nieuwe sleutel aan; klanten koppelen dan opnieuw.

Er is geen wachtwoord. Een sleutel die in de app zit, beschermt niets, want de broncode is openbaar.

### Koppelen: de uitnodiging

De kantoormodus maakt één keer een sleutelpaar voor het kantoor (X25519, `node:crypto`). De
privésleutel staat in de sleutelopslag van het besturingssysteem (`safeStorage`, zoals andere geheimen).

*Klant uitnodigen* maakt een uitnodigingsbestand, niet versleuteld (niets erin is geheim):

```json
{ "type": "gb-uitnodiging", "versie": 1, "kantoor": "Kantoor X", "email": "info@kantoorx.nl",
  "publiekeSleutel": "<base64>", "transport": "mail" }
```

De klant opent het bestand. De app bewaart kantoornaam, e-mailadres en publieke sleutel bij de
administratie, en toont een **controlecode** van 8 tekens (afgeleid van de publieke sleutel). Die kunnen
klant en boekhouder één keer vergelijken om een verwisselde uitnodiging uit te sluiten; dat is
aanbevolen, niet verplicht. Een nieuwe uitnodiging vervangt de koppeling; naar het oude kantoor
exporteren kan dan niet meer.

### Export (klant → boekhouder)

1. De app maakt een willekeurige sleutel **K** (32 bytes) voor deze uitwisseling en bewaart die in de
   sleutelopslag tot het antwoord is ingelezen of de uitwisseling is afgebroken.
2. De inhoud (zie hieronder) wordt versleuteld naar de publieke sleutel van het kantoor: een
   eenmalig X25519-sleutelpaar, ECDH met de kantoorsleutel, HKDF-SHA256 naar een AES-256-GCM-sleutel.
3. K zit in de versleutelde inhoud. Alleen het kantoor kan K dus lezen.

### Antwoord (boekhouder → klant)

AES-256-GCM met K. Alleen de klant heeft K, dus alleen de klant kan het antwoord openen. Omdat alleen
het kantoor K uit de export kon halen, is een antwoord dat met K opent ook echt van dat kantoor. Na
het inlezen wordt K verwijderd; een oud antwoord past daarna nergens meer.

### Kopregel

Beide pakketten gebruiken hetzelfde formaat, met een eigen MAGIC zodat een pakket nooit met een
back-up (`GBBACKUP`) verward wordt:

```
MAGIC "GBPAKKET" | kopregel-lengte (u32) | kopregel (JSON, onversleuteld) | nonce (12) | tag (16) | versleutelde inhoud
```

De kopregel is leesbaar, zodat de app zonder sleutel kan zeggen *waarom* hij een pakket weigert, en
is als **AAD** aan de versleuteling gebonden: een gewijzigde kopregel maakt het pakket onleesbaar.

```json
{ "richting": "naar-boekhouder", "administratie": "<uuid>", "uitwisseling": 17,
  "einddatum": "2026-09-30", "appVersie": "0.7.0", "ephemeral": "<base64, alleen bij export>" }
```

De app weigert een pakket met de verkeerde richting (de eigen export "terug" inlezen), een onbekend
administratie-ID, een ander uitwisselingsnummer dan de lopende uitwisseling, of een andere app-versie.

Bestandsnamen bevatten geen klantnaam: `gb-<eerste 8 tekens administratie-ID>-17-export.gbpakket`.

### Inhoud

- **Export:** de complete back-upbundel (`createBackupBundle`, dus database en bijlagen) plus K, de
  einddatum en de koppelgegevens. De bijlagepaden in de database zijn relatief aan de map van de
  administratie (`bijlagen/2026/…`), dus ze kloppen ook in de kopie bij de boekhouder. Dus ook wat de klant na de einddatum al geboekt had: de boekhouder
  ziet dat (handig voor bv. betalingen na balansdatum bij dubieuze debiteuren), maar zijn handelingen
  moeten t/m de einddatum blijven, en hij kan geen post van na de einddatum terugdraaien. Het scherm zegt
  dat zo tegen de klant (besluit 4). **Zonder de tabel `secrets`** en zonder instellingen voor
  SMTP, IMAP en koppelingen. Dat geldt ook voor de Ponto-bankkoppeling: Client ID en Client Secret staan
  als geheim in `secrets`, en `sanitizeForExchange` wist ook `bank_feed_accounts`. Er gaat dus geen
  credential en geen feed-koppeling mee naar de boekhouder of het kantoor; de al ingelezen
  banktransacties wel, zoals alle betalingen. De eerste export is groot (bijlagen); de grens van mailservers ligt vaak
  rond 10–25 MB. Is het pakket groter, dan raadt de app de gedeelde map of een bestand aan. Pakketten
  met alleen de wijzigingen sinds de vorige uitwisseling zijn een latere uitbreiding.
- **Antwoord:** een lijst handelingen (zie hieronder) en een samenvatting voor de klant. Geen vragen:
  bij vragen belt of mailt de boekhouder.

## Het antwoord is een lijst handelingen

**Gebouwd** (`src/exchange/exchange.ts`), met een kleinere lijst handelingen dan hieronder:
**correctieboeking** (memoriaal), **terugdraaien** en **grootboekrekening toevoegen**. Anders indelen,
afschrijving en investering zitten er nog niet in; de boekhouder doet die met terugdraaien en een
correctieboeking. De handelingen worden niet via de IPC-whitelist vastgelegd maar in de dienst
(`ExchangeService.act`, tabel `exchange_actions`, migratie 23); de API leidt correctieboeking,
terugdraaien en rekening toevoegen in de kopie daarheen. In de kopie kan verder niets geboekt worden
(`Ledger.setWriteGuard`), zodat alles wat de boekhouder boekt ook in het antwoord zit. Wat hij buiten
het grootboek wijzigt (bv. een relatie), gaat niet mee.

**Conflict bij openstaande posten.** Draait de boekhouder een factuur of inkoop terug waarop de klant
intussen betaald heeft gekregen of betaald heeft, dan wordt het antwoord gewoon ingelezen, maar legt de
app het vast (`exchangeConflicts`) en staat er een taak op Vandaag ("Factuur 2026-0012: teruggedraaid door
…"), af te vinken als het met de boekhouder is afgehandeld. Een correctieboeking op debiteuren of
crediteuren zonder verwijzing naar een factuur is niet te herkennen en geeft geen taak.

**In de kopie** zijn de takenlijst, "Aan de slag" en het automatisch verwerken van de klant uitgezet: die
vragen zijn niet aan de boekhouder.

**Transport.** De klant mailt de export (eigen SMTP, tot 20 MB; groter of mislukt: bewaren als
bestand) of bewaart hem als bestand. Wordt er niets gemaild en niets bewaard, dan gaat de periode niet
op slot. De boekhouder bewaart het antwoord als bestand en stuurt het zelf; de kopie mailt niet. Een
export die al is ingelezen, opent de bestaande kopie in plaats van een nieuwe te maken.

**Schermen.** Klant: *Hoe gaat het? > Uitwisseling met je boekhouder* (uitnodiging openen met
controlecode, versturen t/m een kwartaaleinde, antwoord inlezen, afbreken). Kantoor: *Instellingen >
Administraties > Voor boekhouders: je kantoor* (naam en e-mail, uitnodiging maken, export inlezen). In
de kopie: een balk met de aanpassingen en de knop *Antwoord maken*.

Terugdraaien (`Ledger.reverse`) en vervangen (`EventService.replace`) voegen niet alleen rijen toe,
maar zetten ook de status van bestaande posten en gebeurtenissen (`teruggedraaid`, `vervangen`).
Anders indelen raakt ook tabellen buiten het grootboek, zoals de koppeling van een bankmutatie of het
leveranciersgeheugen. Het antwoord bevat daarom geen rijen, maar **de handelingen die de boekhouder
deed**, en de app van de klant voert ze opnieuw uit via dezelfde services.

- **Vastleggen.** In de werkkopie legt de kantoormodus elke aanroep uit een vaste lijst toegestane
  handelingen vast, met argumenten en wat de handeling aanmaakte. De IPC-whitelist in
  `src/main/api.ts` is het natuurlijke punt: dezelfde lijst, met een vlag per handeling of hij in een
  antwoord mag.
- **Toegestaan:** correctieboeking (memoriaal), terugdraaien, anders indelen (bank, aankoop), afschrijving
  en investering, grootboekrekening toevoegen.
- **Niet toegestaan:** facturen en offertes (nummering, en ze gaan naar de klant van de klant), bank
  inlezen, instellingen, relaties verwijderen, btw-aangifte indienen.
- **Alleen binnen de periode:** elke handeling moet een datum tot en met de einddatum hebben. Zo raakt
  de boekhouder nooit de open periode van de klant.
- **Nummers vertalen.** Bestaande posten hebben aan beide kanten hetzelfde nummer, omdat de periode
  vastlag. Wat de boekhouder zelf aanmaakt, krijgt bij de klant een ander nummer, omdat de klant na de
  einddatum doorwerkte. Een handeling die naar iets verwijst dat de boekhouder eerder in hetzelfde
  antwoord maakte (bijvoorbeeld zijn eigen correctie terugdraaien), verwijst daarom naar
  "resultaat van handeling 3" en niet naar een nummer. Bij het inlezen houdt de app een vertaaltabel bij.
- **Alles of niets.** Het inlezen gebeurt in één transactie. Mislukt één handeling, dan wordt niets
  ingelezen en ziet de klant welke handeling en waarom.

**Het antwoord wordt als juist overgenomen.** De klant ziet een samenvatting en leest in; er is geen
goedkeuring per correctie en geen keuze om een deel te weigeren.

**Het enige conflict dat overblijft: openstaande posten.** Een factuur van vóór de einddatum kan na de
einddatum betaald zijn. Boekt de boekhouder die factuur af als oninbaar, dan wordt het antwoord
gewoon ingelezen. Daarna staat er een taak in "Vandaag": er is een betaling op een afgeboekte factuur,
die in de open periode verwerkt moet worden.

## Kantoormodus en meerdere administraties

**Gebouwd** (stap 1 van de bouwvolgorde):

- **Meerdere administraties** (`src/main/administrations.ts`). De eerste administratie blijft in de
  gegevensmap zelf staan; extra administraties staan in `administraties/<sleutel>/`, elk met een eigen
  database, bijlagen en back-ups. Het OCR-model is gedeeld. De app opent de laatst gebruikte
  administratie (`administratie.json`); wisselen en aanmaken gaat via *Instellingen > Administraties*,
  en met meer dan één administratie staat de open administratie onder de naam van de app. Een apart
  keuzescherm bij het opstarten is er (nog) niet. Alleen de open administratie haalt mail op, verstuurt
  herinneringen en maakt de dagelijkse back-up. De MCP-koppeling leest de open administratie.
- **Administratie-ID:** een UUID (versie 4) in `settings` (migratie 21, `SettingsService.administrationId()`),
  niet te wijzigen via de instellingen. Gaat mee in back-ups; een teruggezette back-up houdt hetzelfde ID.
- **Kantoormodus** (`SettingsService.officeCopy()` / `markOfficeCopy()`): een instelling in de
  administratie zelf, niet via de gewone instellingen uit te zetten. In de kopie:
  - geen e-mail (afgedwongen in de mailer van de services), geen koppelingen (webshop, Mollie,
    Stripe: afgedwongen in de `fetch` van de koppelingen), geen post ophalen (API en achtergrond);
  - de achtergrondtaken doen alleen de back-up: geen afschrijvingen, geen automatisch verwerken, geen
    omrekening van vreemde valuta, geen herinneringen (`main.ts`);
  - een balk bovenaan: "Kopie voor … (uitwisseling …, t/m …)".

**Nog te doen:** standaard de expertmodus in de kopie, en per klant de stand van de uitwisseling
("export 17 ontvangen op 3 oktober, nog geen antwoord"). Dat hoort bij stap 3 (uitwisseling), omdat
de kantoormodus pas ontstaat bij het inlezen van een export.

## Jaarafsluiting

Een jaarafsluiting is een uitwisseling tot en met 31 december; na het inlezen is het jaar afgesloten.
De boekhouder boekt de correcties aan het eind van het jaar (afschrijvingen, overlopende posten,
onderhanden werk, privégebruik auto, KIA).

Sinds versie 1.3.0 kan de klant zelf de overlopende posten invullen vóór het afsluiten: vooruitbetaalde
kosten, nog te betalen kosten, voorraad en onderhanden werk (bij het afsluiten t/m 31 december, "Posten
invullen"). Ze staan als gewone memoriaalboekingen op 31 december met een omkering op 1 januari, dus de
boekhouder ziet ze in de export; de waardering blijft aan hem of de klant.

De app **rekent** het resultaat en de privérekeningen van eerdere jaren door naar het eigen vermogen
(`openingBalance` in `src/reports/opening-balance.ts`, gebruikt door de rapporten in de app én het
pakket voor de boekhouder); er is geen echte afsluitboeking. Een correctieboeking die
winst en verlies of de privérekeningen naar het eigen vermogen boekt, zou dan dubbel tellen. De app
herkent en weigert zo'n boeking, met uitleg.

Een klant zonder boekhouder kan een jaar zelf afsluiten: hetzelfde slot, zonder uitwisseling.

## Licentie

**Gebouwd, nog niet actief** (`src/license/license.ts`; de Worker in de privé-repo `shipdocs/boekhoudenvoorniks-server`).

- Alleen **versturen naar de boekhouder** vraagt een licentie. Een antwoord inlezen werkt altijd, zodat
  een klant nooit met een vergrendelde periode blijft zitten. Koppelen en alles aan de kant van het
  kantoor is gratis.
- De licentie is een token dat de licentie-Worker ondertekent (Ed25519) met administratie-ID,
  e-mailadres en "geldig tot" (betaalde periode plus 7 dagen marge). De app controleert het offline met
  de publieke sleutel in `LICENSE_PUBLIC_KEY`. **Zolang die leeg is, staan licenties uit** en is alles vrij.
- Afrekenen via Mollie: eerste betaling (`sequenceType: first`) voor de machtiging, daarna een
  maandabonnement. De Worker verwerkt de webhook (haalt de betaling zelf op, idempotent) en verlengt
  per betaalde maand. De prijs staat in de Worker (`PRICE_EUR`), niet in de app.
- De app haalt de licentie op na *Ik heb betaald*, vóór het versturen als hij ontbreekt of verlopen is,
  en op de achtergrond als hij binnen 7 dagen verloopt. Wie nooit een licentie had, maakt geen
  verbinding.
- Opzetten en deployen: `licentie/README.md` in de privé-repo `shipdocs/boekhoudenvoorniks-server`.

## Buiten de scope van de eerste versie

Nog niet gebouwd, maar wel bedoeld: anders indelen en afschrijvingen als eigen handeling.

Bewust niet in de eerste versie:

- Correcties inlezen uit andere boekhoudsoftware (memoriaal-CSV of XAF).
- Pakketten met alleen de wijzigingen sinds de vorige uitwisseling.
- Meerdere uitwisselingen tegelijk.
- Goedkeuren per correctie; de klant leest het antwoord in zijn geheel in.
- De btw-aangifte indienen vanuit de app.

## Besluiten

1. **Btw-aangifte tijdens een uitwisseling:** maakt niet uit wie of wanneer; correcties in een
   aangegeven periode gaan naar de volgende periode. Aandachtspunt is alleen het vierde kwartaal
   (zie Periodeslot).
2. **Geen vragen in het antwoord.** De boekhouder belt of mailt; zijn antwoord wordt als juist
   overgenomen.
3. **Medewerkers van één kantoor delen de kantoorsleutel**, via een versleutelde export van de
   sleutel (met wachtwoord, alleen aan de kant van het kantoor).
4. **De export bevat de hele administratie**, niet alleen t/m de einddatum. Alleen de correcties zijn
   beperkt tot de periode.

## Bouwvolgorde

1. **Fundament** (gebouwd): administratie-ID, meerdere administraties, kantoormodus.
2. **Periodeslot** (gebouwd): `ledger_locks`, de triggers, late documenten en late bankmutaties,
   periode afsluiten.
3. **Uitwisseling** (gebouwd): uitnodiging en controlecode, export, vastleggen van handelingen, antwoord
   maken en inlezen met vertaaltabel.
4. **Licentie** (gebouwd, nog niet actief): alleen op versturen; aan zodra `LICENSE_PUBLIC_KEY` gevuld is.
