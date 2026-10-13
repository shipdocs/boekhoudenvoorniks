# Onderzoek: buitenlandse inkoopfacturen als websitefunctie

Onderzocht op 13 oktober 2026. Doel: de bestaande verwerking van buitenlandse facturen en eurobetalingen vindbaar maken, vooral voor ondernemers met Amerikaanse leveranciers van software, hosting en AI-tools.

## Conclusie en positionering

Dit is een nuttige functie die op de homepage nauwelijks zichtbaar was. De combinatie van factuurherkenning, omrekening, bankmatching, koersverschillen en btw-voorstellen verdient een eigen pagina. De claim dat weinig pakketten dit kunnen, is met dit onderzoek niet onderbouwd. Moneybird documenteert expliciet omrekening én automatische koersverschillen. Btw-verlegging is ook bij de andere onderzochte pakketten aanwezig.

De verdedigbare boodschap is: **factuur in dollars, betaling in euro’s, omrekening en klein koersverschil geregeld — gratis en lokaal**. Het voordeel voor de gebruiker is minder terugkerend uitzoekwerk bij buitenlandse abonnementen, niet de belofte dat geen concurrent dit kan. De pagina richt zich op inkoop van diensten en eurobetalingen; niet op volledige multivaluta-administraties, dollarrekeningen, invoer/douane of OSS.

## Vergelijking met andere pakketten

Dit is een vergelijking van openbaar beschreven werkwijzen, geen praktijktest met accounts. Versies en workflows verschillen; een handmatige handleiding bewijst niet dat een pakket geen automatische route heeft. Niet aangetoond betekent hier onbekend, niet afwezig. Er zijn geen conclusies over marktaandeel, zoekvolume of de snelheid van concurrenten getrokken.

| Pakket en onderzochte workflow | Omrekening en betaling | Buitenlandse btw | Betekenis voor onze boodschap |
| --- | --- | --- | --- |
| **BoekhoudenVoorNiks**, huidige desktopcode | Herkent valuta op documenten; ECB-koers op of vlak vóór factuurdatum. Bij een passende al aanwezige bankbetaling wordt het eurobedrag gebruikt. Bij latere koppeling aan een geboekte aankoop wordt een klein verschil automatisch als koersverschil geboekt. Hoge zekerheid kan automatische documentverwerking geven; anders controle. | Voorstel uit document, leveranciersregels en bevestigde keuzes; controle bij twijfel. Verlegde inkoop in 4a/4b en aftrek voor zover toegestaan in 5b. Onder de KOR geen aftrek. | Gratis desktopfunctie met lokale administratie. De combinatie en concrete workflow uitlichten. Niet iedere factuur automatisch beloven. |
| **Moneybird**, inkomend document en betalingsregistratie [1–3] | Valuta per inkomend document; omrekening met Open Exchange Rates. Bij betaling worden eurobedrag en bedrag in factuurvaluta gebruikt. Koersverschillen worden automatisch geboekt. Documentatie noemt automatische herkoppeling bij maximaal 5% verschil en handmatig invullen bij grotere verschillen. | Gebruiker activeert en kiest het relevante btw-tarief Binnen/Buiten EU. KOR heeft eigen tarieven. | Een directe functionele concurrent: omrekening en koersverschillen zijn niet uniek. Hun documentatie over automatische *herkoppeling* bewijst niet dat elke initiële match automatisch gaat. |
| **SnelStart 12**, buitenlandse inkoop [4] | De onderzochte handleiding beschrijft het invullen van datum, bedrag, leverancier en factuurnummer. Automatische valutaherkenning of koersverschillen wordt in deze bron niet vastgesteld. | Gebruiker koppelt een grootboekrekening met de juiste EU/niet-EU-functie en tarief. Daarmee worden 4a/4b en 5a/5b gevuld. | Het verschil in de beschreven bediening zit in werken met een document en voorstel versus grootboekfuncties kiezen. Geen claim over alle SnelStart-producten: deze bron gaat over versie 12. |
| **Rompslomp**, valuta op verkoopfactuur en verlegde inkoop [5–7] | Verkoopfactuur wordt vanuit euro’s in een andere valuta weergegeven. De bron waarschuwt voor koers- en betalingsverschillen; de aparte handleiding voor betalingsverschillen beschrijft handmatige stappen. Dit bewijst geen ontbrekende valutafunctie voor inkoop. | Bij uitgave kiest gebruiker Verlegd of buitenland, leverancier/land en tarief of btw-bedrag. | Buitenlandse btw is aanwezig. Onze inkoopworkflow is relevanter dan uitsluitend een buitenlandse valuta op een verkoopfactuur tonen. Geen blanketclaim dat Rompslomp geen vreemde valuta ondersteunt. |
| **e-Boekhouden.nl**, btw-verlegging [8] | De geraadpleegde openbare bronnen stellen automatische valutaherkenning, bankmatching en koersverschillen niet vast. Deze onderdelen blijven onbekend. | Documenteert btw-codes en automatische verwerking in de aangifte na keuze van de juiste code; aftrek alleen waar toegestaan. | Niet gebruiken als bewijs dat andere pakketten buitenlandse btw missen. |

## Wat onze code en tests aantonen

- `src/intake/text-parser.ts` en `packages/core/src/shared/currency.ts`: herkenning van valuta, waaronder USD, GBP en CHF. Geen garantie dat elk document of elk valutasymbool altijd juist wordt gelezen.
- `src/fx/fx.ts`: ECB-koersen ophalen en lokaal bewaren; meest recente beschikbare koers op of vóór de gevraagde datum. Bij ontbreken van een bruikbare koers geen verzonnen bedrag. Verzoek bevat valuta en datum, geen factuurgegevens.
- `src/intake/intake.ts`: omrekening van documentbedragen, bewaren van origineel, bankbedrag gebruiken bij passende aanwezige betaling. Zonder bankmatch ontstaat een waarschuwing en een te controleren omrekening. Automatische bevestiging alleen bij hoge zekerheid voor alle benodigde keuzes.
- `src/import/matching.ts`, `src/import/bank.ts` en `src/documents/purchases.ts`: matching met koersmarge en afhandeling van kleine koersverschillen. `withinFx` hanteert 5% met minimaal € 0,50; dit is een matchmarge, geen universele garantie op automatische afhandeling. Grote afwijkingen en deelbetalingen niet als vanzelf geregeld presenteren.
- `src/intake/classify.ts`: geen btw op een buitenlandse factuur is geen bewijs voor verlegging. Land, documentgegevens, aankoop en bevestigde keuzes tellen. Buitenlandse btw niet als Nederlandse voorbelasting behandelen.
- `src/btw/btw.ts`: rubrieken 4a/4b en aftrek/KOR. De bestaande waarschuwing dat buitenlandse verwerking nog niet door een belastingexpert is nagekeken, wordt op de nieuwe pagina behouden.
- `src/import/csv.ts`: bankverwerking in euro’s; vreemdevalutaregels worden overgeslagen met waarschuwing. De nieuwe pagina belooft geen dollarrekening.
- `tests/vreemde-valuta.test.ts`: document van $ 90,00 met voorbeeldkoers 1,08 → € 83,33; latere betaling € 84,00 → € 0,67 koersverschil en crediteur voldaan. Ook bankbetaling vóór factuur, afronding, ontbrekende koers en hernieuwd ophalen getest.
- `tests/vreemde-valuta-bestaand.test.ts` en `tests/buitenland.test.ts`: herstel van oudere valutagegevens en buitenlandse btw-rubrieken. De wisselkoerstests gebruiken vaste testdata; ze bewijzen de verwerking, niet de live bereikbaarheid van de ECB.

## Zoekintentie en pagina

Eén hoofdpagina: `/buitenlandse-facturen.html`. Begrijpelijke termen: buitenlandse facturen verwerken/boeken, factuur in dollars, eurobetaling, koersverschillen en btw op Amerikaanse software. Er zijn geen zoekvolumes gemeten; dit zijn aannemelijke zoekintenties uit het probleem van de gebruiker, geen beloofde rankings.

De pagina toont de workflow en een duidelijk als voorbeeld aangeduide berekening. Ze gebruikt het bestaande ontwerp, downloadknoppen, eigen canonical en Open Graph-metagegevens, WebPage/BreadcrumbList/FAQPage-JSON-LD. FAQ-structured data beschrijft de zichtbare antwoorden; dit garandeert geen FAQ-rich-result in Google.

Vindbaarheid via homepagefunctie en FAQ, webdevelopers, bank- en btw-pagina’s, gedeelde footer, sitemap en beide LLM-beschrijvingen. De footer wordt gegenereerd vanuit `scripts/site-menu.cjs`; daarom wijzigt de link ook op overige publieke pagina’s. `android-review.html` heeft geen gedeelde footer en blijft ongemoeid.

De te stellige bestaande developertekst “geen btw = verlegd” en “je krijgt hem weer terug” is zowel zichtbaar als in JSON-LD gecorrigeerd. Verlegging en aftrek zijn voorwaarden, geen gevolg van alleen de valuta of de afwezigheid van btw.

## Bronnen

Openbare leveranciersbronnen gelezen op 13 oktober 2026:

1. Moneybird: [Inkoopfacturen uit het buitenland](https://helpcenter.moneybird.nl/nl/articles/207144-inkoopfacturen-uit-het-buitenland).
2. Moneybird: [Betaling registreren met vreemde valuta](https://helpcenter.moneybird.nl/nl/articles/223747-betaling-registreren-met-vreemde-valuta).
3. Moneybird: [Vreemde valuta toevoegen](https://helpcenter.moneybird.nl/nl/articles/223746-vreemde-valuta-toevoegen).
4. SnelStart: [Een inkoopfactuur uit het buitenland boeken in SnelStart 12](https://kennisplein.snelstart.nl/klanten/s/article/boekhouden-inkoop-uit-het-buitenland-boeken-zonder-btw).
5. Rompslomp: [Factuur maken met vreemde valuta](https://rompslomp.nl/support/facturen/vreemde-valuta). Gaat over verkoop, niet over automatische inkoopverwerking.
6. Rompslomp: [Uitgave met btw verlegd aanmaken](https://rompslomp.nl/support/uitgaven/btw-verlegd).
7. Rompslomp: [Betalingsverschil inboeken](https://rompslomp.nl/support/betalingen/betalingsverschil-inboeken). Geen bewijs dat alle koersverschillen handmatig moeten.
8. e-Boekhouden.nl: [Btw verlegd](https://www.e-boekhouden.nl/boekhoudtermen/btw-verlegd) en [veelgestelde vragen](https://www.e-boekhouden.nl/veelgestelde-vragen).

Primaire fiscale bron: [Belastingdienst — diensten afnemen uit het buitenland](https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/belastingdienst/zakelijk/btw/zakendoen_met_het_buitenland/goederen_en_diensten_afnemen_uit_andere_landen/diensten_afnemen_uit_het_buitenland/). Live ophalen gaf tijdens onderzoek HTTP 502; die bron is niet als live geverifieerde inhoud aangemerkt. De tekst beperkt zich tot voorwaardelijke uitleg die aansluit bij de code/tests en de bovenstaande geraadpleegde documentatie. Dit onderzoek is geen fiscale review van de toepassing.

## Validatie van deze wijziging

- 38 tests geslaagd in de drie bestaande suites `vreemde-valuta.test.ts`, `vreemde-valuta-bestaand.test.ts` en `buitenland.test.ts`.
- Website-Worker: `npm run check` (Wrangler dry-run) geslaagd; nieuwe HTML wordt als asset meegenomen. Er is niets gedeployd.
- Chromium: nieuwe pagina op desktop en op 390/320 pixels gecontroleerd; geen horizontale overflow, werkende mobiele navigatie, downloadlinks, voorbeeldanker en uitklapbare FAQ.
- Nieuwe pagina in lichte en donkere modus: axe-controle voor WCAG A/AA-tags gaf geen overtredingen. Dit is een geautomatiseerde controle, geen volledige toegankelijkheidsaudit.
- De controle ontdekte een bestaand contrastprobleem bij witte knoptekst op lichtblauwe knoppen in donkere modus. Een gedeelde `--on-primary`-kleur verhelpt dit ook voor de nieuwe pagina; lichte modus blijft wit op donkerblauw.
- Zes zichtbare FAQ-antwoorden komen overeen met de nieuwe JSON-LD. Alle JSON-LD op de site is parsebaar. De homepage, developer-, bank- en btw-pagina hebben inhoudelijke links; alle 21 pagina’s met de gedeelde footer linken naar de nieuwe pagina.
- Sitemap-URLs corresponderen met bestaande HTML-bestanden. `npm run site:menu` is opnieuw gedraaid en wijzigde toen nul pagina’s. `git diff --check` slaagt.

Publicatie en indexatie zijn niet uitgevoerd of aangetoond. De wijzigingen staan lokaal klaar voor review en deployment.
