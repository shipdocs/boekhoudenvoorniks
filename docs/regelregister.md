# Regelregister

Dit register is de **inventaris van regels die de applicatie daadwerkelijk toepast**. Het is niet de
bewering dat alle Nederlandse fiscale regels bekend of beoordeeld zijn. Dat onderscheid is belangrijk:
eerst maken we de gebruikte regels vindbaar, daarna controleren we ze één voor één bij een officiële
bron en, waar interpretatie nodig is, bij een fiscalist.

De machineleesbare versie staat in [`regelregister.json`](regelregister.json). De bestaande uitgebreide
analyse blijft in [`fiscale-review.md`](fiscale-review.md); het register is de korte index voor onderhoud
en periodieke controles.

## Waar is dit voor?

Het register vormt de koppeling tussen drie zaken die anders los van elkaar staan:

1. **Wat de app doet:** de implementatiebestanden beschrijven waar een regel wordt toegepast.
2. **Waarom dat juist zou zijn:** de bron en controledatum maken het fiscale bewijs controleerbaar.
3. **Hoe we afwijkingen merken:** de regressietests leggen het verwachte gedrag van de app vast.

Daardoor kan een periodieke onderzoekstaak gericht vragen: “is regel `BvN-BTW-004` sinds de laatste
controle gewijzigd?” Een bevinding kan vervolgens direct worden omgezet in een onderhoudstaak met de
betrokken code en tests. Zonder register ontstaat alleen algemeen belastingnieuws en is niet duidelijk
of een wijziging de applicatie raakt.

Dit register is nog **geen automatische fiscale goedkeuring** en ook geen vervanging voor advies aan de
gebruiker. De eerste versie is de structuur en een startinventaris. De vervolgstap is de nulmeting:
alle beslissingen in de huidige code toevoegen, de brede clusters opsplitsen tot afzonderlijk
controleerbare regels en pas daarna de periodieke broncontrole automatiseren.

## Betekenis van een status

- `te-controleren`: de implementatie is gevonden, maar de regel is nog niet volgens het vaste proces
  tegen de genoemde officiële bron gecontroleerd.
- `bron-gecontroleerd`: bron, publicatie- én ingangsdatum zijn gecontroleerd en `checkedOn` is gevuld.
- `extern-te-beoordelen`: de bron alleen is onvoldoende; een fiscalist of boekhouder moet de toepassing
  op de ondersteunde doelgroep beoordelen.

Een regel wordt dus nooit alleen door een geslaagde test `bron-gecontroleerd`. Tests bewijzen wat de
software doet, niet dat dit juridisch juist is.

## Werkwijze voor de nulmeting

1. Zoek alle beslissingen, percentages, grensbedragen, termijnen, aangifterubrieken en verplichte
   documentteksten in de code. Voeg iedere zelfstandige regel met een stabiel id toe.
2. Beschrijf de ondersteunde situatie en expliciete uitzonderingen. Splits regels als geldigheidsperiode,
   rechtsvorm of soort transactie verschilt.
3. Leg minimaal één implementatiebestand en één testbestand vast. Ontbreekt een test, voeg die eerst toe.
4. Controleer primair bij Belastingdienst, wetten.overheid.nl, officiële bekendmakingen of ODB. Noteer
   publicatiedatum en ingangsdatum afzonderlijk; een voorstel is nog geen geldende regel.
5. Laat interpretaties en uitzonderingen extern beoordelen. Bewaar die beoordeling als reviewbewijs en
   verwijs ernaar vanuit `notes`.
6. Voer `npm run regels:controle` uit. Pas daarna mag de status naar `bron-gecontroleerd`.

## Wanneer is de nulmeting klaar?

Niet wanneer “alle belastingregels” zijn beschreven—dat is voor deze applicatie geen eindige of nuttige
scope. De nulmeting is klaar wanneer iedere fiscale of boekhoudkundige beslissing die de huidige app
neemt een register-id, scope, codeverwijzing, regressietest en verificatiestatus heeft. Regels die de app
niet ondersteunt horen in een apart scope-/risicoregister, niet als stilzwijgende aanname in dit bestand.

De eerste inventaris in JSON is bewust een startset van de grootste regelclusters: btw-tarieven en
rubrieken, KOR, suppletie, ICP/OSS, privégebruik auto, inkomstenbelasting, KIA/desinvestering,
afschrijving en factuureisen. `te-controleren` betekent dat zij onderdeel zijn van de nulmeting; het is
geen oordeel dat de huidige uitwerking fout is.

## Wijzigen en periodiek onderzoeken

Iedere wijziging krijgt hetzelfde verslag: **oude regel → nieuwe regel → juridische status →
publicatiedatum → ingangsdatum → gevolg voor de app → tests**. Een wekelijkse signalering vergelijkt
nieuwe publicaties met de ids; een maandelijkse ronde controleert alle regels opnieuw. Een releasecheck
controleert daarnaast of gewijzigde codepaden nog naar het register verwijzen.

Voeg bij een nieuwe regel eerst een JSON-item toe. Gebruik geen ongedateerde zoekresultaten of
secundaire bron als eindbewijs. Een onbereikbare bron en “geen wijziging gevonden” worden beide als
resultaat vastgelegd, inclusief de werkelijk gecontroleerde bronnen.
