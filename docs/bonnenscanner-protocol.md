# Bonnenscanner: protocol tussen telefoon en pc

Dit document beschrijft precies hoe de scanner-app op de telefoon (issue #49) bonnen aflevert bij de
desktop-app (issue #48). Het is het contract: de app op de telefoon kan hiertegen gebouwd worden zonder
de code van de desktop te lezen. De uitvoerbare versie staat in `src/scanner/protocol.ts`; de tests in
`tests/bonnenscanner.test.ts` controleren het uitgewerkte voorbeeld onderaan byte voor byte. Versie 2
staat in hetzelfde bestand en wordt gedekt door `tests/bonnenscanner-v2.test.ts`.

Protocolversie: **1**; daarnaast bestaat **versie 2**, die niets aan versie 1 verandert (zie
*Versie 2* verderop).

**Stand:** de kant van de pc is gebouwd en getest, maar staat in de app nog uit tot de scanner-app er is.
De schakelaar is `PHONE_SCANNER` in `src/shared/phone-scanner.ts`; #49 zet hem aan. Zolang hij uit
staat is er in Instellingen niets van koppelen te zien, weigert de app te koppelen en luistert er
niets. De bonnenmap (onderaan dit document) werkt wel.

## In het kort

```text
pc:        Instellingen → Telefoon & bonnenmap → Telefoon koppelen → QR-code
telefoon:  scant de QR-code → bewaart adres, pc-ID, apparaat-ID en sleutel (versleutelde opslag)
telefoon:  POST http://<adres>:<poort>/v1/bericht   (hallo)   → de koppeling is rond
telefoon:  POST http://<adres>:<poort>/v1/bericht   (bon)     → de pc slaat op en bevestigt
telefoon:  ruimt de bon pas op na een bevestiging die met de sleutel te openen is
```

- Alles gaat over het lokale netwerk, van de telefoon rechtstreeks naar de pc. Geen server, geen cloud.
- Elk bericht is versleuteld en ondertekend met AES-256-GCM, met de sleutel uit de QR-code. De pc doet
  niets met een bericht dat hij niet kan ontsleutelen.
- De pc geeft nooit iets uit de administratie terug: alleen "ontvangen" of een foutcode.
- Het ontvangstpunt luistert alleen als er minstens één telefoon gekoppeld is (of een QR-code openstaat).

## Koppelen: de QR-code

De QR-code bevat één regel JSON (UTF-8, foutcorrectie M):

```json
{"bvn":"scanner","v":1,"pc":"oKGio6SlpqeoqaqrrK2urw","apparaat":"3q2-7wAAAAAAAAAAAAAAAQ","sleutel":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8","poort":51234,"adressen":["192.168.1.35"]}
```

| Veld | Betekenis |
|---|---|
| `bvn` | altijd `"scanner"`; zo herkent de app dat het een koppelcode van BoekhoudenVoorNiks is |
| `v` | protocolversie, nu `1`. Een andere waarde: niet koppelen, melden dat de app of de pc bijgewerkt moet worden |
| `pc` | pc-ID: 16 willekeurige bytes, base64url zonder opvulling (22 tekens). Hoort bij één administratie op één pc. Het zegt niets over de administratie zelf |
| `apparaat` | apparaat-ID van deze telefoon, door de pc bedacht: 16 willekeurige bytes, base64url (22 tekens) |
| `sleutel` | de geheime sleutel: 32 willekeurige bytes, base64url (43 tekens). Voor elke telefoon een eigen sleutel |
| `poort` | TCP-poort van het ontvangstpunt |
| `adressen` | IPv4-adressen van de pc op het lokale netwerk, het waarschijnlijkste eerst (hooguit vier) |

Regels:

- De code is voor **één telefoon** en **tien minuten** geldig. Meldt de telefoon zich niet binnen die
  tijd (of sluit de gebruiker het venster), dan vervalt de sleutel.
- De koppeling is rond zodra de pc het eerste geldige bericht van de telefoon ontvangt. Stuur daarom
  direct na het scannen een `hallo` (zie hieronder); daarmee komt ook de naam van de telefoon in de
  lijst op de pc.
- De telefoon bewaart `pc`, `apparaat`, `sleutel`, `poort` en `adressen` in versleutelde opslag
  (Android Keystore). De sleutel komt nooit in een logboek of een back-up.
- Ontkoppelen op de pc gooit de sleutel weg. Daarna krijgt de telefoon `niet-gekoppeld` (zie Antwoorden).
- Er kunnen meerdere telefoons gekoppeld zijn (hooguit tien), elk met een eigen apparaat-ID en sleutel.
- Bij het eerste geldige bericht kent de pc de telefoon een unieke apparaatcode toe (zie *De
  apparaatcode*).

## De apparaatcode

Elke gekoppelde telefoon krijgt van de pc een unieke **apparaatcode**: `M` met een oplopend volgnummer
(`M1`, `M2`, …). De code hoort bij de koppeling en is de basis voor de apparaatreeks van facturen. Ze
staat in de lijst gekoppelde telefoons op de pc en in het hallo-antwoord van versie 2 (zie *Versie 2*).

- De toekenning gebeurt bij het **eerste geldige bericht** van de telefoon (meestal de `hallo`), niet
  al bij het tonen van de QR-code. Een QR-code die niemand scant, krijgt dus geen code.
- Het volgnummer is het hoogste ooit uitgegeven nummer plus één. Een code wordt **nooit hergebruikt**,
  ook niet na ontkoppelen.
- Opnieuw installeren van de app is een **nieuwe koppeling** en krijgt altijd een nieuwe code. De pc
  kan een herinstallatie niet herkennen: de oude code staat open tot de gebruiker de oude koppeling
  ontkoppelt. Wat er daarna met de oude factuurreeks gebeurt (de reeks sluiten, ontbrekende nummers
  bewaken) volgt in een latere versie van dit document.
- Ontkoppelen **sluit de code af**: de code blijft in de administratie bewaard, maar wordt nooit meer
  uitgegeven. Codes worden nooit verwijderd.
- Bekende beperking: bij terugzetten van een oudere back-up valt het hoogste uitgegeven volgnummer
  terug, en kan een eerder uitgegeven code opnieuw worden toegekend.

## De pc vinden

1. Probeer de adressen uit de QR-code, op de poort uit de QR-code.
2. Lukt dat niet (bijvoorbeeld een nieuw IP-adres na een herstart van de router), zoek dan via mDNS /
   DNS-SD naar `_gratisboekhouden._tcp` (domein `local`).

Wat de pc via mDNS bekendmaakt, alleen zolang het ontvangstpunt aan staat:

| Record | Inhoud |
|---|---|
| PTR `_gratisboekhouden._tcp.local` | `BoekhoudenVoorNiks-<8 hex>._gratisboekhouden._tcp.local` |
| SRV | de poort, en de hostnaam `bvn-<8 hex>.local` |
| TXT | `v=1` en `id=<pc-ID>` |
| A | het IPv4-adres van de pc op dat netwerk |

`<8 hex>` zijn de eerste vier bytes van het pc-ID. Er staat geen computernaam of bedrijfsnaam in.
De pc antwoordt alleen op vragen uit hetzelfde netwerk, en altijd op het groepsadres (multicast),
nooit rechtstreeks naar de vrager. Gebruik dus gewone mDNS (bij Android: `NsdManager`).

De telefoon gebruikt alleen de dienst waarvan `id` gelijk is aan het pc-ID uit de QR-code, en bewaart
het gevonden adres en de poort voor de volgende keer. Staat er op de pc een andere administratie open,
dan is er geen dienst met dit pc-ID: dat is "pc niet gevonden", geen ingetrokken koppeling.

Alleen IPv4. Het ontvangstpunt luistert alleen op privé-adressen (10.x, 172.16–31.x, 192.168.x,
169.254.x) en neemt alleen verbindingen aan uit hetzelfde netwerk (subnet) als het adres waarop ze
binnenkomen. Op een gastnetwerk dat apparaten van elkaar scheidt werkt het dus niet.

## Transport

- `POST http://<adres>:<poort>/v1/bericht`
- `Content-Type: application/vnd.boekhoudenvoorniks.scanner` (precies zo, zonder parameters)
- `Content-Length` is verplicht; `Transfer-Encoding: chunked` wordt geweigerd.
- De body is de envelop hieronder, als ruwe bytes. Hooguit 20 MiB (20.971.520 bytes).
- Gewoon HTTP, geen TLS: de vertrouwelijkheid en de echtheid komen uit de envelop. Op Android moet
  onversleuteld verkeer naar het lokale netwerk daarvoor toegestaan zijn.
- Er zijn geen CORS-kopregels en `OPTIONS` wordt geweigerd. Een webpagina (of een WebView met `fetch`)
  kan het ontvangstpunt dus niet gebruiken: verstuur met de HTTP-functies van het toestel zelf
  (bij Capacitor: de native HTTP-plug-in).
- Eén bericht per verbinding; de pc sluit de verbinding na het antwoord. Stuur de berichten na elkaar:
  van één adres leest de pc één verzoek tegelijk in (een tweede krijgt `te-druk`).
- Komt er tien seconden niets over een verbinding, dan verbreekt de pc hem.
- Wacht tot 30 seconden op een antwoord. De pc antwoordt zodra de bon op schijf staat; het uitlezen
  van de bon gebeurt daarna en houdt het antwoord niet op.

## De envelop

Verzoek (telefoon → pc) en antwoord (pc → telefoon) hebben dezelfde opbouw. Alle getallen big-endian.

| Bytes | Lengte | Inhoud |
|---|---|---|
| 0–3 | 4 | `42 56 4E 53` (ASCII `BVNS`) |
| 4 | 1 | protocolversie: `01` |
| 5 | 1 | richting: `01` = verzoek, `02` = antwoord |
| 6–21 | 16 | apparaat-ID (de 16 bytes uit `apparaat`) |
| 22–33 | 12 | nonce: 12 willekeurige bytes, voor elk bericht nieuw |
| 34–… | n | cijfertekst |
| laatste 16 | 16 | controlecode (GCM-tag) |

Versleuteling: **AES-256-GCM**, sleutel = de 32 bytes uit `sleutel`, IV = de nonce (12 bytes), tag van
16 bytes direct achter de cijfertekst (zo levert WebCrypto het ook op).

Extra gecontroleerde gegevens (AAD):

- bij een **verzoek**: bytes 0–21 van het verzoek (`BVNS`, versie, richting, apparaat-ID);
- bij een **antwoord**: bytes 0–21 van het antwoord, gevolgd door de 12 bytes nonce van het verzoek
  waar het een antwoord op is (samen 34 bytes).

Daardoor hoort een antwoord bij precies één verzoek, en kan een verzoek niet als antwoord terugkomen
(of andersom).

De nonce doet twee dingen: hij is de IV van AES-GCM, en de pc onthoudt hem om herhaling te weigeren.
Gebruik dus voor elk bericht, ook voor elke nieuwe poging, 12 verse willekeurige bytes uit een veilige
bron (`crypto.getRandomValues`).

## De inhoud van een verzoek

Na ontsleutelen:

```text
lengte van de JSON (4 bytes, big-endian) | JSON (UTF-8) | foto 1 | foto 2 | …
```

De foto's staan direct achter elkaar, als ruwe JPEG-bytes, in de volgorde van het veld `fotos`. De
groottes in `fotos` moeten samen precies de rest van het bericht vullen. De JSON is hooguit 16 KiB
(alleen een `wijziging` uit versie 2 mag tot 128 KiB); daarboven volgt `te-groot`. Velden die de pc
niet kent, negeert hij.

### `hallo`: koppeling afmaken, of kijken of de pc er is

```json
{"soort":"hallo","tijd":1790848800000,"naam":"Pixel van Piet","app":"1.0.0"}
```

| Veld | Verplicht | Betekenis |
|---|---|---|
| `soort` | ja | `"hallo"` |
| `tijd` | ja | het moment van versturen, in milliseconden sinds 1-1-1970 UTC (geheel getal) |
| `naam` | ja | naam van de telefoon zoals de gebruiker hem op de pc ziet, hooguit 60 tekens |
| `app` | nee | versie van de scanner-app, hooguit 20 tekens |

Geen foto's. Antwoord:

```json
{"ok":true,"soort":"hallo","pc":"oKGio6SlpqeoqaqrrK2urw","pcTijd":1790848800123,"limieten":{"fotos":10,"fotoBytes":19922944,"notitie":1000}}
```

`pc` is het pc-ID; `pcTijd` de klok van de pc; `limieten` wat de pc per bon aanneemt.

### `bon`: een bon afleveren

```json
{"soort":"bon","tijd":1790848800000,"id":"3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b","betaalwijze":"contant","notitie":"Schroeven voor de klus bij Jansen","locatie":{"lat":52.0907,"lon":5.1214},"fotos":[{"grootte":412345},{"grootte":398112}]}
```

| Veld | Verplicht | Betekenis |
|---|---|---|
| `soort` | ja | `"bon"` |
| `tijd` | ja | het moment van **versturen** (niet van fotograferen), in milliseconden |
| `id` | ja | eigen ID van de telefoon voor deze bon: een UUID (`8-4-4-4-12` hexadecimale tekens), in kleine letters. Hetzelfde ID bij elke nieuwe poging. (Hoofdletters neemt de pc aan, maar hij rekent met kleine letters en geeft het `id` zo terug.) |
| `betaalwijze` | ja | `"pin"`, `"contant"`, `"prive"` of `"later"` |
| `notitie` | nee | vrije tekst. Hooguit 1000 tekens; wat langer is, kapt de pc af. Regeleinden mogen |
| `locatie` | nee | `{"lat": -90…90, "lon": -180…180}`. Alleen meesturen als de gebruiker locatie op de telefoon heeft aangezet |
| `fotos` | ja | 1 tot 10 foto's: per foto `{"grootte": <aantal bytes>}`, in de volgorde waarin ze achter de JSON staan |

Eisen aan de foto's:

- Alleen **JPEG**. De pc controleert de inhoud (begin `FF D8`, een geldige kop met afmetingen, 8 bits
  per kanaal, grijs of kleur). Iets anders weigert hij met `ongeldig`, de hele bon.
- Alle foto's samen hooguit 19 MiB (19.922.944 bytes).
- De pc comprimeert de foto niet opnieuw: het beeld blijft byte voor byte gelijk. Bij een bon van
  meerdere foto's (die samen één PDF worden) draait hij de pagina volgens de EXIF-oriëntatie 1, 3, 6 of
  8; gespiegelde standen (2, 4, 5, 7) kent hij niet. Stuur bij voorkeur foto's die al rechtop staan.
- Zet **geen GPS-gegevens in de EXIF** van de foto, tenzij de gebruiker locatie op de telefoon heeft
  aangezet. Staat locatie op de pc uit (#32), dan haalt de pc de positie er zelf ook uit voordat hij
  de foto bewaart: de GPS-map in de EXIF en een XMP-blok met een positie. De andere EXIF-gegevens
  (zoals de draairichting) blijven staan. Een EXIF-blok dat niet te lezen is, gaat in zijn geheel weg.
  Een positie in een merkeigen veld (MakerNote) of plaatsnamen in IPTC herkent de pc niet: laat die weg.

Antwoord:

```json
{"ok":true,"soort":"bon","id":"3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b","al":false}
```

`al` is `true` als de pc deze bon al had (zelfde `id`, zelfde inhoud). Ook dat is een bevestiging.

## Tijdstempel en nonce: een bericht kan niet opnieuw ingestuurd worden

- `tijd` mag hooguit **5 minuten** afwijken van de klok van de pc, vroeger of later. Anders: `klok`,
  met `pcTijd` in het antwoord. De telefoon mag het verschil onthouden en het bericht opnieuw maken
  met `tijd` gecorrigeerd (nieuwe nonce). Zet `tijd` dus bij het versturen, niet bij het in de
  wachtrij zetten.
- Een nonce die de pc binnen dat tijdvenster al zag van dezelfde telefoon, weigert hij: `herhaald`.
  De pc onthoudt nonces ook over een herstart van de app heen.
- Een nieuwe poging is altijd een **nieuw bericht**: zelfde `id` en inhoud, nieuwe `tijd`, nieuwe nonce.
  Verstuur nooit dezelfde bytes twee keer.

## Antwoorden

Er zijn twee soorten antwoorden. Het verschil is belangrijk.

**Versleuteld** (`Content-Type: application/vnd.boekhoudenvoorniks.scanner`): de pc kon het verzoek
ontsleutelen. De body is een envelop met richting `02`; de inhoud is JSON (UTF-8), zonder lengteveld.
Alleen zo'n antwoord, geopend met de eigen sleutel en de nonce van het eigen verzoek, mag de telefoon
vertrouwen.

**Onversleuteld** (`Content-Type: application/json`): `{"ok":false,"fout":"<code>"}`. De pc kon het
verzoek niet aan een gekoppelde telefoon toeschrijven. Iedereen op het netwerk kan zo'n antwoord
namaken; de telefoon gooit er daarom **nooit** een bon of de koppeling om weg.

| HTTP | `fout` | Versleuteld | Betekenis | Wat doet de telefoon |
|---|---|---|---|---|
| 200 | – (`ok: true`) | ja | ontvangen en opgeslagen | bon opruimen ("verstuurd ✓") |
| 400 | `ongeldig` | ja | ontsleuteld, maar de inhoud klopt niet (veld, geen JPEG) | niet opnieuw proberen; fout in de app |
| 403 | `klok` | ja | `tijd` buiten het venster; `pcTijd` staat erbij | klokverschil onthouden en opnieuw |
| 409 | `herhaald` | ja | deze nonce is al gebruikt | opnieuw met een nieuwe nonce |
| 409 | `id-botst` | ja | dit `id` hoort al bij een bon met een andere inhoud | niet opnieuw; de bon bewaren en melden |
| 413 | `te-groot` | ja | de foto's zijn samen groter dan 19 MiB | kleiner maken, of in twee bonnen |
| 413 | `te-groot` | ja | de JSON is te groot voor dit soort bericht (boven 16 KiB; een `wijziging` boven 128 KiB) | niet opnieuw; de inhoud kleiner maken of opsplitsen |
| 400 | `veld-ongeldig` | ja | een klantveld klopt niet; `veld` en `melding` staan erbij (zie *Wat de pc met een wijziging doet*) | niet opnieuw; fout in de app |
| 409 | `klant-onbekend` | ja | een klantwijziging zonder naam op een onbekende `uuid` | later opnieuw, na de klant met naam |
| 500 | `opslaan-mislukt` | ja | de pc kon de bon of de wijziging niet wegschrijven | bewaren, later opnieuw |
| 400 | `ongeldig` | nee | geen envelop van deze versie, of afgebroken | – |
| 401 | `niet-gekoppeld` | nee | onbekende telefoon, ingetrokken of verlopen sleutel, of niet te ontsleutelen | "koppeling ingetrokken" tonen; bonnen bewaren tot de gebruiker opnieuw koppelt |
| 404 / 405 | `onbekend` | nee | ander pad of andere methode | – |
| 411 | `lengte` | nee | geen `Content-Length`, of chunked | – |
| 413 | `te-groot` | nee | body groter dan 20 MiB | – |
| 415 | `verkeerd-type` | nee | verkeerde `Content-Type` | – |
| 429 | `te-druk` | nee | te veel mislukte of afgebroken pogingen vanaf dit adres (20 per minuut) | een minuut wachten |
| 503 | `te-druk` | nee | er wordt al een verzoek van dit adres ingelezen, of drie in totaal | even wachten en opnieuw |
| 500 | `opslaan-mislukt` | nee | onverwachte fout op de pc | bon bewaren, later opnieuw |

De pc controleert in deze volgorde: pad, methode, te veel mislukte pogingen, `Content-Type`,
`Content-Length`, envelop en apparaat-ID, ontsleutelen, inhoud (ook de grootte van de JSON),
`tijd`, bij een `wijziging` ook het bewerkmoment (zie *Versie 2*), nonce, foto's, `id`.

## Eén keer aankomen, en wanneer de telefoon mag opruimen

- De pc bevestigt (`ok: true`) pas **nadat** de bon op schijf staat. Geen bevestiging, om welke reden
  ook (geen verbinding, time-out, foutcode): de bon blijft in de wachtrij van de telefoon.
- Dezelfde bon nog een keer sturen is altijd veilig: op het `id` herkent de pc hem en antwoordt
  `ok: true, al: true`. Er komt geen tweede document in de inbox.
- De inhoud onder één `id` ligt vast vanaf de eerste poging: betaalwijze, notitie en foto's (daarop
  vergelijkt de pc; anders is het `id-botst`). De positie telt daarbij niet mee, ook niet die in de foto.
  Verandert de gebruiker daarna nog iets, gebruik dan een nieuw `id`. (Een bon met precies dezelfde
  foto herkent de pc dan nog aan de hash van het bestand.)
- De telefoon ruimt een bon alleen op na een **versleuteld** antwoord met `ok: true` en het eigen `id`.

## Wat de pc met een bon doet

- Eén foto wordt één document (jpg) in de inbox bij *Aankopen & bonnetjes*; meerdere foto's worden
  samen één PDF met een pagina per foto. De naam van het document maakt de pc zelf. Uit het bericht
  wordt alleen het `id` als naam gebruikt, na controle dat het een UUID is, en alleen voor het
  tijdelijke bestand in de wachtrij van de app.
- Er wordt nooit vanzelf geboekt: de bon wacht op controle, net als een bon uit de mail.
- Komt precies dezelfde foto nog eens binnen onder een ander `id`, dan komt er geen tweede document: de
  telefoon krijgt gewoon `ok: true`, en op de pc staat op Vandaag dat de bon er al in stond.
- `betaalwijze` wordt het voorstel bij "Hoe betaald?": `pin` en `later` → zakelijke rekening (de
  betaling volgt via de bank), `contant` → contant, `prive` → met privégeld.
- `notitie` staat bij het document.
- `locatie` wordt alleen bewaard als op de pc *Gebruik de locatie van foto's om bonnen aan klussen te
  koppelen* aan staat (#32). Anders gooit de pc het veld weg, ook uit de wachtrij, en haalt hij ook de
  GPS-gegevens uit de foto's zelf (zie de eisen aan de foto's), ook als ze samen een PDF worden.

## Uitgewerkt voorbeeld

Vaste waarden, zodat een eigen implementatie te controleren is. (Uitgerekend met een andere
AES-GCM-implementatie dan die van de desktop-app, en als test vastgelegd.)

```text
sleutel      000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
             (in de QR-code: AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8)
apparaat-ID  a0a1a2a3a4a5a6a7a8a9aaabacadaeaf
             (in de QR-code: oKGio6SlpqeoqaqrrK2urw)
nonce        101112131415161718191a1b
```

De JSON van een `hallo` (76 bytes):

```json
{"soort":"hallo","tijd":1790848800000,"naam":"Pixel van Piet","app":"1.0.0"}
```

De inhoud vóór versleutelen: `0000004c` gevolgd door de JSON.

```text
0000004c7b22736f6f7274223a2268616c6c6f222c2274696a64223a313739303834383830303030302c226e61616d
223a22506978656c2076616e2050696574222c22617070223a22312e302e30227d
```

AAD van het verzoek (22 bytes):

```text
42564e530101a0a1a2a3a4a5a6a7a8a9aaabacadaeaf
```

Het hele verzoek, de HTTP-body (130 bytes: 22 kop, 12 nonce, 80 cijfertekst, 16 tag):

```text
42564e530101a0a1a2a3a4a5a6a7a8a9aaabacadaeaf101112131415161718191a1b7dfe985a32eb49dca5077c3f355b
0132bb3c212c37e023d88d9dc05d6f636deb68dd6f3bc5965edf4e1ab03febf97e39299e171a9bee35d2ca7f5411a3fe
c11f27d41d4239ce290e4fb11bcef6f1cac3e176e4ee5617eb65598ce6d0b2cfabd8
```

Een antwoord van de pc op een verzoek met die nonce, met de eigen nonce `202122232425262728292a2b` en
de inhoud `{"ok":true,"soort":"bon","id":"3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b","al":false}`.
AAD (34 bytes: de kop van het antwoord, dan de nonce van het verzoek):

```text
42564e530102a0a1a2a3a4a5a6a7a8a9aaabacadaeaf101112131415161718191a1b
```

Het hele antwoord:

```text
42564e530102a0a1a2a3a4a5a6a7a8a9aaabacadaeaf202122232425262728292a2ba918c91b4ea26e7c6f196eecb277
9b8ba46bd6bee5ef0dcc40d405766bb07c3a13bc873ced1450f721995af3753d7afe8407d5efad5e0051ad531b2f2981
6ce9b913af29bab584faa9508f46d72e5c1cc57663598e11bca4052acb14be8b6763
```

### In code (WebCrypto)

```ts
const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function verstuur(koppeling, json: object, fotos: Uint8Array[] = []) {
  const sleutel = await crypto.subtle.importKey('raw', b64url(koppeling.sleutel), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const kop = new Uint8Array([0x42, 0x56, 0x4e, 0x53, 1, 1, ...b64url(koppeling.apparaat)]); // 22 bytes, ook de AAD
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  const tekst = new TextEncoder().encode(JSON.stringify(json));
  const inhoud = new Uint8Array(4 + tekst.length + fotos.reduce((n, f) => n + f.length, 0));
  new DataView(inhoud.buffer).setUint32(0, tekst.length); // big-endian
  inhoud.set(tekst, 4);
  let plek = 4 + tekst.length;
  for (const f of fotos) { inhoud.set(f, plek); plek += f.length; }

  const cijfer = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: kop }, sleutel, inhoud));
  const body = new Uint8Array(34 + cijfer.length); // kop (22) | nonce (12) | cijfertekst met de tag erachter
  body.set(kop, 0);
  body.set(nonce, 22);
  body.set(cijfer, 34);

  const antwoord = await nativePost(`http://${adres}:${poort}/v1/bericht`, 'application/vnd.boekhoudenvoorniks.scanner', body);
  if (antwoord.contentType !== 'application/vnd.boekhoudenvoorniks.scanner') return { vertrouwd: false, ...JSON.parse(antwoord.tekst) };

  const r = antwoord.bytes; // kop (22) | nonce (12) | cijfertekst | tag (16)
  const aad = new Uint8Array([...r.slice(0, 22), ...nonce]); // kop van het antwoord + de nonce van óns verzoek
  const open = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: r.slice(22, 34), additionalData: aad }, sleutel, r.slice(34));
  return { vertrouwd: true, ...JSON.parse(new TextDecoder().decode(open)) }; // decrypt gooit als er iets niet klopt
}

// koppelen, en daarna een bon
await verstuur(k, { soort: 'hallo', tijd: Date.now(), naam: 'Pixel van Piet', app: '1.0.0' });
await verstuur(k, { soort: 'bon', tijd: Date.now(), id, betaalwijze: 'contant', notitie, fotos: [{ grootte: foto.length }] }, [foto]);
```

Controleer bij een versleuteld antwoord ook dat bytes 0–5 `42 56 4E 53 01 02` zijn en bytes 6–21 het
eigen apparaat-ID (ze zitten in de AAD, dus een afwijking laat het ontsleutelen al mislukken).

## Versie 2: wijzigingen, stamgegevens en wat de pc kan

Versie 2 staat **naast** versie 1: zelfde endpoint (`/v1/bericht`), zelfde envelop, zelfde transport,
dezelfde regels voor `tijd` en nonce. Een telefoon kiest per bericht in welke versie hij de envelop
stopt (`PROTOCOL_VERSION`); het antwoord komt altijd in dezelfde versie terug. De koppelcode (QR) en
het TXT-record blijven `v:1`: welke berichten een pc begrijpt zegt hij zelf, in het hallo-antwoord.

Een nieuw versienummer voor nieuwe berichtsoorten, en niet gewoon nieuwe JSON-velden, omdat een pc
die een berichtsoort niet kent hem moet **afwijzen** (hij mag geen "ontvangen" zeggen over iets dat
hij niet gedaan heeft). Een telefoon moet dus vóór het sturen weten wat de pc begrijpt: het
hallo-antwoord van versie 2 noemt de ondersteunde protocolversies, en de envelop draagt per bericht
welke versie het is. Een `wijziging`, `stamgegevens` of `bevestigingen` in een envelop van versie 1 wordt geweigerd
(`ongeldig`); een `hallo` of `bon` mag in beide versies.

### Het hallo-antwoord in versie 2

Precies het oude antwoord, met erbij `regels`, `protocollen` en de `apparaatcode` van deze telefoon
(de voorbeelden in dit deel staan als tekst en worden gecontroleerd door `tests/bonnenscanner-v2.test.ts`;
het uitgewerkte voorbeeld van versie 1 hierboven blijft byte voor byte in `tests/bonnenscanner.test.ts`).

```text
{"ok":true,"soort":"hallo","pc":"oKGio6SlpqeoqaqrrK2urw","pcTijd":1790848800123,"limieten":{"fotos":10,"fotoBytes":19922944,"notitie":1000},"regels":1,"protocollen":[1,2]}
```

| Veld | Betekenis |
|---|---|
| `regels` | de regelsversie (in de code `rulesVersion`): het versienummer van de btw-regeltabel die bij deze pc hoort (nu 1). De tabel zelf staat in het stamgegevens-antwoord (veld `regeltabel`, eerste pagina) en heeft een eigen `versie` |
| `protocollen` | alle protocolversies die deze pc begrijpt, van laag naar hoog (nu `[1,2]`) |
| `apparaatcode` | de apparaatcode van deze telefoon (`M1`, `M2`, …), zoals bij *De apparaatcode* |

Een hallo in een envelop van versie 1 krijgt precies het oude antwoord, zonder deze velden.

### `wijziging`: een change-set sturen

De telefoon meldt precies één wijziging, in het gedeelde wijzigingsformaat. Dat formaat staat in
`packages/core`, zuiver en zonder Node, zodat de Android-app er dezelfde regels voor kan gebruiken:
`leesWijziging` controleert er het formaat, `besluitWijziging` is de idempotentieregel. Het bericht
heeft **precies** de sleutels `soort`, `tijd` en `wijziging`: precies één change-set per bericht,
dus geen reeks wijzigingen en geen extra sleutels ernaast. Dit is de enige soort waarbij de pc
onbekende bovenste velden níét negeert; een bericht zonder die precies drie sleutels geeft
`ongeldig`.

```text
{"soort":"wijziging","tijd":1790848800000,"wijziging":{"entiteit":"klant","uuid":"3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b","revisie":1,"tijd":1790848800000,"velden":{"naam":"Familie Jansen"}}}
```

Er staan twee tijden in zo'n bericht, met elk hun eigen betekenis. De `tijd` van het bericht is de
**verzendtijd** en moet binnen het klokvenster van de pc zitten (zie *Tijdstempel en nonce*). De
`tijd` ín de change-set is het **bewerkmoment**: wanneer deze revisie is gemaakt. Dat moment mag
willekeurig oud zijn — de telefoon kan een wijziging offline hebben gemaakt — maar ligt hooguit het
klokvenster in de toekomst; verder in de toekomst geeft `ongeldig`. Dit zijn de vijf velden van de
change-set:

| Veld | Verplicht | Betekenis |
|---|---|---|
| `entiteit` | ja | wat het is: `"klant"`, `"project"`, `"factuur"`, `"bon"` of `"foto"` |
| `uuid` | ja | het ID van die ene entiteit: een UUID in kleine letters (`8-4-4-4-12` hexadecimale tekens) |
| `revisie` | ja | hoe vaak deze entiteit al gewijzigd is: een geheel getal vanaf 1 |
| `tijd` | ja | wanneer deze revisie is gemaakt, in milliseconden sinds 1-1-1970 UTC (het bewerkmoment, niet de verzendtijd van het bericht) |
| `velden` | ja | wat er in deze revisie veranderd is: de veranderde velden met hun nieuwe waarde |

Regels; wat er niet aan voldoet wordt geweigerd met `ongeldig`, voordat er iets mee gebeurt:

- Precies deze vijf velden, niets erbij en niets eraf: wat de pc niet kent, kan hij ook niet
  synchroniseren.
- `velden` is een object met alleen waarden die in JSON passen (geen functies, geen `NaN`).
- `velden` is begrensd (de constanten `WIJZIGING_LIMIETEN` in `packages/core`): hooguit 64 sleutels
  per object, 6 niveaus diep, 4000 knopen in totaal, 500 elementen per array en 4000 tekens per
  string. Elke sleutel, op elk niveau, begint met een letter en is hooguit 40 tekens
  (`^[A-Za-z][A-Za-z0-9_]{0,39}$`). De namen `__proto__`, `constructor` en `prototype` zijn op elk
  niveau verboden — ook in objecten binnen arrays — zodat een valse sleutel nooit de
  prototypeketen in kan sluipen. (Een factuur van 200 regels met elk 12 velden, plus een
  momentopname van de klantgegevens, past ruim binnen deze grenzen.)
- Documenten (`factuur`, `bon`, `foto`) worden **nooit bewerkt**: zij hebben precies één revisie, dus
  alleen revisie 1. Klanten en projecten mogen vaker gewijzigd worden.
- **Idempotent**: de pc onthoudt per exacte sleutel (apparaat, entiteit, `uuid`, `revisie`) wat hij met
  een wijziging deed (zie *Wat de pc met een wijziging doet*). Dezelfde sleutel nog eens sturen verandert
  niets; een andere revisie van dezelfde `uuid` wordt toegepast, ook een lagere, per veld op tijd.

Geen foto's achter dit bericht, behalve bij de entiteiten `bon` en `foto`: die hebben JPEG's als bijlage (zie
*Een bon als wijziging, met bijlagen*). Bij elke andere entiteit (klant, project, factuur) is een bijlage een
vormfout (`ongeldig`). De JSON van een `wijziging` mag tot 128 KiB; elk ander bericht blijft
bij 16 KiB, en er bovenuit geeft `te-groot` (zie *Antwoorden*). Het basisantwoord bevestigt precies
deze change-set:

```text
{"ok":true,"soort":"wijziging","entiteit":"klant","uuid":"3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b","revisie":1}
```

Een pc die klantwijzigingen bewaart voegt daar `uitkomst` aan toe (en bij een afwijzing `fout`); zie het
volgende deel.

### `stamgegevens`: om de stamgegevens vragen

Dit is het enige bericht waarmee gegevens **uit de administratie** naar de telefoon gaan. Het werkt alleen
voor een gekoppelde telefoon, in een versleutelde envelop van versie 2 (in een envelop van versie 1 geeft
het `ongeldig`), en is **alleen lezen**: de pc schrijft er niets voor weg, behalve dat de telefoon als
"laatst gezien" geldt en bij zijn eerste bericht zijn apparaatcode krijgt.

```text
{"soort":"stamgegevens","tijd":1790848800000}
```

Verzoek: de sleutels `soort` en `tijd`, en optioneel `sinds` en `na`. Elke andere sleutel (ook `__proto__`)
geeft versleuteld `400 ongeldig`, net als een `sinds` die geen geheel getal van 0 of meer is, een `na` dat
geen tekst van hoogstens 200 tekens is, of een `null` voor een van beide (laat de sleutel dan weg). Geen
foto's. Het verzoek blijft binnen 16 KiB.

| Veld | Betekenis |
|---|---|
| `sinds` | een `seq` van de pc (zie hieronder): alleen items met een **strikt grotere** `seq`. Zonder `sinds` krijgt de telefoon alles |
| `na` | de `volgende` uit het vorige antwoord, onveranderd teruggestuurd, voor de volgende pagina. Een cursor die de pc niet zelf gemaakt kan hebben (verknoeid, aangepast, te lang) geeft `400 ongeldig` |

```jsonc
{"soort":"stamgegevens","tijd":1790848800000,"sinds":412,"na":"eyJzIjoicCIsInQiOjQ4MCwidSI6IjFhMmIzYzRkLTVlNmYtNDA3MS04MjkzLWE0YjVjNmQ3ZThmOSIsImIiOjUwMH0"}
```

Het antwoord is een pagina uit één stroom: **eerst alle klanten, dan alle projecten, dan de verbergmeldingen**, samen hoogstens
**100 items**. Binnen elke soort ligt de volgorde vast op (`seq`, `uuid`); er wordt nooit op bewerktijd of
met een positie-teller (OFFSET) gepagineerd, dus elk item komt precies één keer langs. Een pagina wordt
nooit afgekapt of dynamisch verkleind. Gemeten: 100 klanten met notities van 4000 tweebyte-tekens zijn
versleuteld ruim onder 1 MiB. Een pagina waarvan alle vrije tekstvelden tegelijk hun maximum hebben, met
tweebyte-tekens, is ongeveer 1,07 MiB en met driebyte-tekens in de notities ongeveer 1,5 MiB; een telefoon
moet dus tot `maxBodyBytes` (20 MiB) aankunnen en mag niet van 1 MiB uitgaan.

```text
{"ok":true,"soort":"stamgegevens","pcTijd":1790848800123,"apparaatcode":"M1","regels":1,"regeltabel":{"versie":"2026-1","geldig_vanaf":"2026-01-01","btw":[{"code":"hoog","label":"21% (hoog)","percentage":21,"rubriek":"1a","tekst":"21% btw"},{"code":"laag","label":"9% (laag)","percentage":9,"rubriek":"1b","tekst":"9% btw"},{"code":"nul","label":"0%","percentage":0,"rubriek":"1e","tekst":"0% btw"},{"code":"verlegd","label":"BTW verlegd","pickLabel":"Btw verlegd (je werkt als onderaannemer; je klant regelt de btw)","percentage":0,"rubriek":"1e","tekst":"btw verlegd"},{"code":"vrijgesteld","label":"Vrijgesteld / KOR","pickLabel":"Geen btw (vrijgesteld of KOR)","percentage":0,"rubriek":"-","tekst":"geen btw"},{"code":"icp","label":"Intracommunautaire levering (0%)","pickLabel":"Goederen naar een bedrijf in een ander EU-land (0%)","percentage":0,"rubriek":"3b","tekst":"goederen naar een bedrijf in de EU, 0% btw"},{"code":"icp-dienst","label":"Btw verlegd (dienst EU)","pickLabel":"Dienst aan een bedrijf in een ander EU-land (btw verlegd)","percentage":0,"rubriek":"3b","tekst":"dienst aan een bedrijf in de EU, btw verlegd"},{"code":"export","label":"Uitvoer goederen buiten de EU (0%)","pickLabel":"Goederen naar een klant buiten de EU (0%)","percentage":0,"rubriek":"3a","tekst":"goederen naar buiten de EU, 0% btw"},{"code":"dienst-buiten-eu","label":"Niet belast in Nederland","pickLabel":"Dienst aan een bedrijf buiten de EU (niet in de aangifte)","percentage":0,"rubriek":"-","tekst":"dienst aan een bedrijf buiten de EU, geen Nederlandse btw"}],"eu_landen":["AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI","FR","GR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK"],"eu_b2c_drempel":1000000,"teksten":{"icp":"Intracommunautaire levering, vrijgesteld van btw (art. 138 Btw-richtlijn)","icp_dienst":"Btw verlegd (reverse charge, art. 196 Btw-richtlijn)","buiten_eu_dienst":"Dienst niet belast in Nederland (plaats van dienst buiten de EU)","verlegd":"BTW verlegd"}},"klanten":[{"uuid":"7c9e6679-7425-40de-944b-e07fc1f90ae7","seq":5,"pc_revisie":1,"gearchiveerd":false,"velden":{"naam":{"waarde":"Familie Jansen","tijd":1790800000000,"bron":"pc"},"email":{"waarde":"jansen@example.nl","tijd":1790800000000,"bron":"pc"},"gearchiveerd":{"waarde":0,"tijd":1790800000000,"bron":"pc"}},"vies":{"gecontroleerd_op":"2026-09-30T08:15:00.000Z","geldig":true}}],"projecten":[{"uuid":"1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9","seq":9,"pc_revisie":2,"gearchiveerd":false,"velden":{"titel":{"waarde":"Stucwerk woonkamer","tijd":1790840000000,"bron":"M1"},"klant":{"waarde":"7c9e6679-7425-40de-944b-e07fc1f90ae7","tijd":1790800000000,"bron":"pc"}}}],"aliassen":[{"alias_uuid":"0b5f3a52-9d4e-4c1b-8a7e-2f6d1c9e8b34","klant":"7c9e6679-7425-40de-944b-e07fc1f90ae7"}],"verborgen":[{"uuid":"3f1d2c4b-6a7e-4b8c-9d0e-1f2a3b4c5d6e","seq":497,"soort":"klant"}],"volgende":null,"nieuwe_sinds":500}
```

(Het voorbeeld toont een deel van de velden; het echte antwoord heeft bij elk item **alle** velden.)

| Veld | Betekenis |
|---|---|
| `pcTijd` | de klok van de pc, zoals in het hallo-antwoord |
| `apparaatcode` | de apparaatcode van **deze** telefoon; een ander gekoppeld apparaat krijgt dezelfde gegevens maar zijn eigen code |
| `regeltabel` | de **btw-regeltabel** zelf, zie De regeltabel hieronder. **Alleen op de eerste pagina** (zonder `na`), altijd, ook bij een `sinds` en ook als de delta leeg is; een vervolgpagina heeft dit veld niet. (Het veld `regels` in het antwoord is op elke pagina het versienummer `rulesVersion`, zoals in het hallo-antwoord.) |
| `klanten`, `projecten` | de items van deze pagina, zie hieronder |
| `aliassen` | de samengevoegde klanten: `alias_uuid` (de oude uuid) en `klant` (de uuid van de klant die nu geldt). **Alleen op de eerste pagina** (zonder `na`), volledig, ook bij een `sinds`, en niet meegeteld in de 100 items; een vervolgpagina heeft een lege lijst |
| `verborgen` | items die voor de telefoon **niet meer zichtbaar** zijn, zie Verbergmeldingen hieronder. Elk is `{uuid, seq, soort}` met `soort` `"klant"` of `"project"`, en niets anders. Altijd aanwezig; bij `sinds` 0 leeg |
| `volgende` | de cursor voor de volgende pagina, of `null` als alles geleverd is |
| `nieuwe_sinds` | de bovengrens (`tot`) van deze **ronde**, in elk antwoord van de ronde gelijk. Na de laatste pagina (`volgende: null`) bewaart de telefoon dit getal als nieuwe `sinds`, **nooit** het hoogste `seq` van de ontvangen items (zie Ronde en delta) |

**Een item** heeft precies `uuid`, `seq`, `pc_revisie`, `gearchiveerd` en `velden`; een **klant** heeft daarnaast
`vies` (zie hieronder), een project niet. `velden` bevat voor
**elk** veld uit `KLANT_VELDEN` (klant) of `PROJECT_VELDEN` (project) in `packages/core` een object
`{waarde, tijd, bron}`; het project draagt zijn klant als `uuid` in het veld `klant` (of `null`). De veldnamen
komen uit de kern, niet uit dit document. `gearchiveerd` staat zowel als boolean op het item als (met zijn
eigen tijd en bron, `0` of `1`) in `velden`; gearchiveerde klanten en projecten worden **gewoon geleverd**,
want de pc verwijdert nooit iets.

- `vies` is `null` (de klant heeft geen btw-nummer, of dat nummer is nog nooit in VIES gecontroleerd) of
  precies `{gecontroleerd_op, geldig}`: `gecontroleerd_op` is het tijdstip van de **laatste** controle van het
  **huidige** btw-nummer van de klant (ISO 8601, UTC), `geldig` is `true`, `false` of `null` (geen uitslag,
  bijvoorbeeld omdat de dienst van een land niet bereikbaar was). Een controle van een eerder btw-nummer
  van de klant telt niet voor het nieuwe nummer. Alleen lezen: de naam, het adres en het bericht uit de
  VIES-uitslag verlaten de pc nooit. Een nieuwe controle geeft de klant een nieuwe `seq` (en zijn projecten
  dus ook, via het effectieve nummer), zodat hij in de volgende delta komt; dat is geen klantwijziging:
  `pc_revisie` en de `tijd` van de velden blijven gelijk.
- `seq` is de wijzigingsteller van de pc (`sync_seq`) van die rij. Elke echte wijziging op de pc, ook een
  die een telefoon heeft gemeld, geeft de rij een nieuwe, hogere `seq`; archiveren ook.
- `pc_revisie` is het revisienummer van de rij op de pc. Het is **informatief**: de telefoon past een
  pc-item per veld toe op (`tijd`, `bron`) en kijkt daarbij **nooit** naar de revisie. De revisie in een
  `wijziging` van de telefoon is iets anders (de eigen revisie van de telefoon).
- `tijd` en `bron` per veld zijn de opgeslagen waarden. Een veld waarvoor de pc niets heeft opgeslagen (een
  klant of project van vóór de sync) krijgt als `tijd` het aanmaakmoment van de rij (omgerekend van UTC naar
  milliseconden) en als `bron` `"pc"`: dus niet de wijzigingstijd en niet 0. Een veld dat de pc zelf al als
  "nog door niemand gezet" bewaart (`tijd` 0, lege `bron`) wordt zo doorgegeven, zodat elke latere wijziging wint.

**De regeltabel (`regeltabel`).** De tabel staat in `packages/core/src/shared/regeltabel.ts` (`REGELTABEL`) en
wordt **afgeleid** van de bestaande btw-constanten van de kern; de pc heeft dus geen tweede bron. Inhoud:
`versie` (tekst `JJJJ-n`, nu `2026-1`), `geldig_vanaf` (ISO-datum), `btw` (per verkoop-btw-soort: `code`,
`label`, eventueel `pickLabel`, `percentage`, `rubriek` en `tekst`), `eu_landen`, `eu_b2c_drempel` (centen) en
`teksten` (de vaste vermeldingen `icp`, `icp_dienst`, `buiten_eu_dienst` en `verlegd`). Verandert de
inhoud, dan gaat de `versie` omhoog; een test op een vingerafdruk van de inhoud dwingt dat af.
De telefoon haalt de tabel dus uit de stamgegevens, niet uit het hallo-antwoord, en bewaart haar met de
`versie`. Op een factuur zet hij als `regeltabel_versie` de `versie` van de tabel waarmee hij rekende.
Vergelijken doet hij als tekst, gelijk of ongelijk (geen getal): is de `versie` in een nieuwe eerste pagina
anders dan de bewaarde, dan vervangt hij de tabel voor **nieuwe** facturen. De pc dwingt gelijkheid van
`regeltabel_versie` niet af: een factuur gemaakt met een oudere tabel blijft geldig en wordt
gewoon overgenomen. (`rulesVersion` in het hallo-antwoord blijft het oude getal 1 en wordt hiervoor niet gebruikt.)

**Ronde en delta.** Een ronde is het doorlopen van alle pagina's, van de eerste vraag (zonder `na`) tot en met
de pagina met `volgende: null`. De pc legt bij de **eerste pagina** de bovengrens `tot` van de ronde vast:
de stand van haar wijzigingsteller op dat moment (`sync_teller`, de teller waaruit elk `seq` komt; elk
nieuw `seq` is groter dan de stand van dat moment). `tot` zit in de cursor en komt in elk antwoord terug als
`nieuwe_sinds`. Alleen items met `sinds` < `seq` <= `tot` horen bij de ronde, ook op vervolgpagina's. Een
klant of project dat tijdens de ronde wijzigt krijgt een `seq` boven `tot`, komt dus niet meer in deze ronde
en komt zeker in de volgende ronde: een wijziging kan nooit tussen twee rondes vallen, ook niet als de cursor
al bij de projecten stond toen een klant wijzigde.

- De telefoon bewaart na de laatste pagina **`nieuwe_sinds`** (dus `tot`) als `sinds` voor de volgende ronde.
  Het hoogste `seq` van de ontvangen items is **niet** geschikt: een klant die tijdens de ronde wijzigt kan een
  lager nummer hebben dan een project dat de telefoon al kreeg, en zou dan nooit meer aankomen.
- `sinds` is een getal van de pc, **nooit de klok van de telefoon en nooit `gewijzigd_op` of een bewerktijd**:
  een wijziging die een andere telefoon drie dagen geleden bewerkte maar nu pas aankomt, krijgt een nieuwe
  `seq` en komt dus gewoon in de delta. `sinds` levert items met een `seq` **strikt groter** dan `sinds`.
- Een item dat tijdens de ronde na levering opnieuw wijzigt komt in de volgende ronde nog eens; de telefoon
  past een pc-item per veld toe op (`tijd`, `bron`), dus dubbel leveren schaadt niet.
- **`sinds` boven `tot`** (de pc staat op een lager nummer, bijvoorbeeld na een teruggezette back-up):
  het antwoord is leeg (`volgende: null`, nog wel met de aliassen) en `nieuwe_sinds` is het lagere `tot`.
  De telefoon bewaart dat lagere nummer en begint daar opnieuw; items met een nummer boven dat `tot` komen
  dan alsnog mee. Wie zeker wil zijn dat hij gelijk is aan de pc, vraagt een ronde met `sinds` 0 (of zonder `sinds`).
- **`seq` van een project is het effectieve nummer**: het grootste van het eigen `sync_seq` van het project en
  dat van zijn klant. Wijzigt de klant (ook van type, bijvoorbeeld een leverancier die `beide` wordt, of
  archiveren), dan komen zijn projecten opnieuw mee in de delta, ook die nu pas zichtbaar worden. Een project
  zonder bekende klant heeft zijn eigen nummer.

**Verbergmeldingen (`verborgen`).** Wordt een klant op de pc een leverancier, dan verdwijnt hij met zijn
projecten uit `klanten` en `projecten`. Zonder verdere melding bleven ze op de telefoon staan; daarom
meldt de pc ze in `verborgen`.

- **Wanneer.** Een klant staat in `verborgen` als hij nu type leverancier is **en** ooit klant of beide was,
  en elk project van zo'n klant ook. De pc leidt dat af uit het wijzigingslogboek van de klant
  (`relation_changelog`, veld `type`: elke typewijziging schrijft daar het oude en nieuwe type, in dezelfde
  transactie als de wijziging zelf). Een relatie die altijd leverancier was komt **nooit** in `verborgen`: dat zou
  het bestaan van een leverancier verraden. Het huidige type beslist, dus een item staat nooit tegelijk in
  `klanten`/`projecten` en in `verborgen`. Wordt de relatie weer klant of beide, dan komt hij als gewone klant
  (met zijn projecten) terug in de delta en staat hij niet meer in `verborgen`.
- **Inhoud.** Alleen `uuid`, `seq` en `soort`; nooit een naam, type of veld. `seq` is hetzelfde
  effectieve nummer als bij klanten en projecten (een klant: zijn eigen `seq`; een project: het grootste van
  project en klant), dus de melding valt in de delta op het moment van de typewijziging.
- **Ronde en paginering.** Verbergmeldingen zijn de derde soort in dezelfde stroom (cursorsoort `v`), na alle
  klanten en projecten, met dezelfde bovengrens `tot`, dezelfde volgorde (`seq`, `uuid`) en dezelfde grens van
  100 items per pagina. Een typewijziging tijdens de ronde krijgt een `seq` boven `tot` en komt in de volgende ronde.
- **Wat de telefoon ermee doet.** Verberg (of verwijder lokaal) de klant of het project met die `uuid`. De pc
  verwijdert zelf nooit iets, en een lokale wijziging die de telefoon nog niet heeft verstuurd blijft staan
  tot de gebruiker beslist. Een melding voor een `uuid` die de telefoon niet kent negeer je. Verwerk binnen
  een pagina eerst `klanten` en `projecten`, dan `verborgen`; komt hetzelfde item later weer in `klanten` of
  `projecten`, dan is het weer zichtbaar.
- **`sinds` 0.** Bij `sinds` 0 (of zonder `sinds`) is `verborgen` leeg: de volledige export bevat alleen wat
  nu zichtbaar is. Een telefoon die opnieuw begint (nieuwe installatie, `sinds` 0 na een teruggezette pc) **wist
  eerst zijn lokale stamgegevens** en vult ze dan met de export, zodat er niets achterblijft. Een cursor van
  soort `v` bij `sinds` 0 geeft `400 ongeldig`.

**Zo doorloopt de Android-app een ronde.**

1. Lees de bewaarde `sinds` (nog niets bewaard: 0).
2. Stuur `stamgegevens` met `sinds` en **zonder** `na`. Is `sinds` 0 (of nog niets bewaard), wis dan eerst de lokale stamgegevens. Verwerk `klanten`, `projecten` en (alleen nu) `aliassen`, en `verborgen` (alleen bij `sinds` > 0).
3. Is `volgende` een tekst: stuur hetzelfde verzoek met dezelfde `sinds` en `na` = die tekst, onveranderd, en verwerk
   de pagina (inclusief `verborgen`); herhaal tot `volgende` `null` is. Onderweg wordt `sinds` niet gewijzigd en niets bewaard.
4. Pas als `volgende` `null` is en alles is verwerkt: bewaar `nieuwe_sinds` als `sinds`. Faalt de ronde
   halverwege, dan blijft de oude `sinds` staan en begint de volgende poging gewoon opnieuw.
5. Kreeg je `400 ongeldig` op een `na`, dan begin je de ronde opnieuw zonder `na`.

**Cursor.** `volgende` is base64url van JSON met precies de sleutels `s` (`"k"` klant, `"p"` project of `"v"` verbergmelding),
`t` (het `seq` van het laatste item, een geheel getal van 0 of meer), `u` (zijn `uuid`) en `b` (de bovengrens
`tot` van de ronde, minstens `t`), hooguit 200 tekens. Hij is alleen bedoeld om onveranderd terug te sturen als
`na`: de pc controleert hem streng en gebruikt hem nooit als SQL. Een `b` boven de stand van de teller van de
pc of onder `sinds` kan de pc niet gemaakt hebben en geeft `400 ongeldig`. `sinds` blijft bij elke volgende
pagina hetzelfde.

**Privacygrens.** Er gaat alleen deze whitelist uit de administratie: klanten van het type klant of beide
en projecten, met precies de velden hierboven. Nooit leveranciers, het type, `paid_with`, interne id's,
boekingen, facturen, bankgegevens van de administratie zelf, instellingen of geheimen. Een project dat aan
een leverancier hangt wordt **niet** geleverd; een project zonder bekende klant wel (`klant` is `null`).
(Het IBAN van een klant is een klantveld en gaat dus wel mee, het IBAN van de administratie zelf niet.)

### `bevestigingen`: horen wat er met een wachtende wijziging gebeurde

Een wijziging (klant, project of factuur) die de pc niet meteen kan toepassen, krijgt het antwoord `wacht`: de pc
bewaart hem in de **wachtrij** (`sync_wachtrij`) tot het object waar hij op wacht er is (bijvoorbeeld een factuur
voor een klant of project dat de pc nog niet kent). Met `bevestigingen` hoort de telefoon later wat er met zo'n
wijziging gebeurde. Een wijziging die direct een eindantwoord kreeg (`toegepast`, `overgeslagen` of `afgewezen`) heeft
**geen** bevestiging nodig en komt hier ook niet voor. Net als `stamgegevens` is dit bericht alleen **lezen**
(laatst gezien en de apparaatcode zijn het enige neveneffect), werkt het alleen voor een gekoppelde telefoon in een
envelop van versie 2 (in versie 1: `400 ongeldig`) en blijft het verzoek binnen 16 KiB.

```jsonc
{"soort":"bevestigingen","tijd":1790848800000,"na":41}
```

Verzoek: de sleutels `soort` en `tijd`, en optioneel `na`: het hoogste bevestigingsnummer dat de telefoon al heeft (een
geheel getal van 0 tot en met `Number.MAX_SAFE_INTEGER`; zonder `na` is het 0). Elke andere sleutel (ook `__proto__`) en
een `na` dat negatief, niet geheel, te groot, tekst of `null` is, geeft versleuteld `400 ongeldig`; er wordt dan niets gelezen.
Voor welk apparaat de pc antwoordt, volgt altijd uit de envelop, nooit uit het bericht.

```jsonc
{"ok":true,"soort":"bevestigingen","pcTijd":1790848800123,"apparaatcode":"M1","bevestigingen":[{"seq":42,"entiteit":"factuur","uuid":"5d2c8a14-7b3e-4f60-9a1d-3c4e5f6a7b8c","revisie":1,"uitkomst":"toegepast","fout":null},{"seq":43,"entiteit":"project","uuid":"1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9","revisie":1,"uitkomst":"afgewezen","fout":"veld-ongeldig"}],"volgende":null,"bevestigd_tot":43}
```

| Veld | Betekenis |
|---|---|
| `seq` | het **bevestigingsnummer** van deze bevestiging (zie onder) |
| `entiteit`, `uuid`, `revisie` | welke wijziging het is: de sleutel waarmee de telefoon hem verstuurde |
| `uitkomst` | `toegepast`, `overgeslagen` of `afgewezen` |
| `fout` | bij `afgewezen` de foutcode (bijvoorbeeld `nummer-bezet`, `geen-klant`, `veld-ongeldig`), anders `null` |
| `volgende` | het laatste `seq` van deze pagina als er meer volgt (vraag dan opnieuw met dat getal als `na`), anders `null` |
| `bevestigd_tot` | het laatste getoonde `seq`, of `na` als er niets is |

Een bevestiging hoort bij een rij in de wachtrij van **dit** apparaat die is afgehandeld en een bevestigingsnummer
heeft, met een nummer groter dan `na`. Een antwoord heeft hoogstens **100** bevestigingen, oplopend op `seq`. Per
bevestiging gaan precies deze zes velden mee; de bewaarde wijziging, het factuurnummer, de klant en alle andere
gegevens verlaten de pc niet.

**Het bevestigingsnummer.** Elke wachtrijrij krijgt een nummer uit een eigen teller op het moment dat hij wordt
afgehandeld (`verwerkt_seq`, in dezelfde transactie). Het nummer wordt nooit hergebruikt, een teruggedraaide afhandeling
geeft het terug, een rij die al is afgehandeld houdt zijn nummer, en de teller staat los van het wijzigingsnummer (`seq`)
van de stamgegevens. Rijen die al waren afgehandeld voordat deze teller bestond hebben geen nummer en worden niet getoond.
De pc verwijdert nooit bevestigingen. De telefoon bewaart het hoogste nummer dat hij verwerkt heeft zelf; een tweede
vraag met hetzelfde `na` geeft hetzelfde antwoord (lezen verandert niets).

**Stappen voor de Android-app.** De telefoon houdt een wijziging die het antwoord `wacht` kreeg bij, tot de pc hem
bevestigt:

1. Na elke sync (na de wijzigingen en de stamgegevens): stuur `bevestigingen` met `na` = het bewaarde hoogste
   bevestigingsnummer (0 als er nog niets is).
2. Verwerk de pagina: zoek per bevestiging de lokale wijziging op `entiteit`, `uuid` en `revisie`. Bij `toegepast` of
   `overgeslagen` is de wijziging aangekomen en kan de telefoon het wachtende deel opruimen; bij `afgewezen` toont de
   telefoon de `fout` aan de gebruiker en ruimt het wachtende deel ook op (de pc heeft de wijziging niet overgenomen).
3. Is `volgende` een getal: stuur opnieuw met `na` = dat getal, tot `volgende` `null` is.
4. Bewaar pas daarna `bevestigd_tot` als nieuw hoogste nummer. Faalt de ronde halverwege, dan blijft het oude nummer staan
   en begint de volgende poging gewoon opnieuw (een bevestiging twee keer verwerken doet geen kwaad).
5. Een wijziging die direct `toegepast`, `overgeslagen` of `afgewezen` terugkreeg, hoeft de telefoon niet te laten
   bevestigen.

### Wat de pc met een wijziging doet

Een wijziging van een **klant**, een **project**, een **factuur**, een **bon** of een **foto** wordt bewaard (een project is een klus op de pc; een bon gaat naar de spool, zie *Een bon als wijziging, met bijlagen*; een foto hoort bij een project, zie *Een foto bij een project*). De pc verwerkt elke wijziging in één
databasetransactie: de controle in het register, het opzoeken, het toepassen, het wijzigingsnummer, het
logboek en de registerrij lukken samen of helemaal niet. De pc **verwijdert nooit** iets en voegt
**nooit stil samen**: twee `uuid`'s met dezelfde KvK, hetzelfde btw-nummer, hetzelfde e-mailadres of
dezelfde naam blijven twee klanten. Een voorstel om dubbele klanten samen te voegen valt buiten deze
stap.

**Uitkomsten.** Het antwoord bevat het basisantwoord plus `uitkomst`:

| HTTP | `uitkomst` / `fout` | Registerrij | Betekenis | Wat doet de telefoon |
|---|---|---|---|---|
| 200 | `toegepast` | ja | minstens één veld is toegepast (of de klant is nieuw) | wijziging opruimen |
| 200 | `overgeslagen` | ja | alle velden waren ouder, of deze sleutel had de pc al | wijziging opruimen |
| 200 | `afgewezen`, `fout: "geen-klant"` | ja | inhoudelijk geweigerd: de `uuid` hoort bij een leverancier | wijziging opruimen en melden; opnieuw sturen geeft dezelfde afwijzing |
| 200 | `afgewezen`, `fout: "klus-gekoppeld"`, met `melding` | ja | inhoudelijk geweigerd: de klant van een project met een offerte, facturen, aankopen, ritten of werkbonregels kan niet wisselen; er is niets geschreven in het project | wijziging opruimen en melden; opnieuw sturen geeft dezelfde afwijzing |
| 200 | `wacht` | **nee** (wel een rij in `sync_wachtrij`) | een project dat naar een nog onbekende klant verwijst, of een **factuur** die naar een onbekende klant, een onbekend project of een onbekend origineel (creditnota) verwijst of nu niet geboekt kan worden (een periode die bij de boekhouder ligt); de pc bewaart de hele wijziging en past haar toe zodra het ontbrekende er is of de periode weer open is | wijziging opruimen: de pc heeft haar; iets dat nog niet is afgeleverd moet de telefoon alsnog sturen |
| 200 | `niet-ondersteund` | **nee** | een `foto` op een pc zonder administratiemap, of een `bon` op een pc zonder spool; er blijft niets achter | **niet** als afgeleverd beschouwen; bewaren |
| 200 | `afgewezen`, `fout: "id-botst"` | ja | een **bon** waarvan de `uuid` al in de spool staat met een andere inhoud (een andere foto of andere velden); de eerst opgeslagen bon blijft leidend | wijziging opruimen en melden; opnieuw sturen geeft dezelfde afwijzing |
| 200 | `afgewezen`, `fout: "nummer-bezet"`, met `melding` | ja | een **factuur** waarvan het nummer al bij een andere factuur hoort; er is geen factuur bijgekomen | wijziging opruimen en melden; opnieuw sturen geeft dezelfde afwijzing |
| 200 | `afgewezen`, `fout: "factuur-geweigerd"`, met `melding` | ja | een **factuur** die de pc inhoudelijk weigert (bijvoorbeeld een creditnota voor een andere klant dan het origineel); dit kan ook pas bij het verwerken uit de wachtrij blijken | wijziging opruimen en melden |
| 400 | `veld-ongeldig`, met `veld` en `melding` | nee | een veld buiten het schema, een ongeldige waarde, een te lange tekst, een lege naam of titel | niet opnieuw; fout in de app |
| 400 | `ongeldig` | nee | het formaat klopt niet, de apparaatcode in een factuurnummer is niet die van het apparaat, of het bewerkmoment ligt meer dan 5 minuten (het klokvenster) in de toekomst | niet opnieuw |
| 409 | `klant-onbekend` | nee | een onbekende `uuid` zonder `naam` (ook niet via een alias): er is geen klant om aan te vullen; een factuur met een onbekende klant wacht sinds stap 12b (200 `wacht`) | later opnieuw, nadat de klant met naam is afgeleverd |
| 409 | `project-onbekend` | nee | een onbekende project-`uuid` zonder titel of zonder klant, en er wacht ook niets voor dit project: er is geen project om aan te vullen | later opnieuw, nadat het project met titel en klant is afgeleverd |
| 500 | `opslaan-mislukt` | nee | de pc kon niet opslaan; er is niets achtergebleven | wijziging bewaren, later opnieuw |
| 503 | `wachtrij-vol` | nee | er wachten al 1000 wijzigingen van dit apparaat in `sync_wachtrij`; deze is niet opgeslagen | wijziging bewaren, later opnieuw (herhaalbaar); de pc wijst een geldige wijziging nooit af |

```jsonl
{"ok":true,"soort":"wijziging","entiteit":"klant","uuid":"3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b","revisie":1,"uitkomst":"toegepast"}
{"ok":true,"soort":"wijziging","entiteit":"factuur","uuid":"5b0f4e2a-8d1c-4a3e-9f6b-2c7d8e9f0a1b","revisie":1,"uitkomst":"afgewezen","fout":"nummer-bezet","melding":"Factuurnummer M1-2026-0001 bestaat al bij een andere factuur."}
{"ok":true,"soort":"wijziging","entiteit":"klant","uuid":"3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b","revisie":1,"uitkomst":"afgewezen","fout":"geen-klant"}
{"ok":false,"fout":"veld-ongeldig","veld":"email","melding":"Het veld email klopt niet: Dit e-mailadres klopt niet: geen-email"}
{"ok":false,"fout":"klant-onbekend"}
{"ok":true,"soort":"wijziging","entiteit":"project","uuid":"7c9e6679-7425-40de-944b-e07fc1f90ae7","revisie":1,"uitkomst":"wacht"}
{"ok":false,"fout":"project-onbekend"}
{"ok":false,"fout":"wachtrij-vol"}
```

**Een factuur ontvangen.** Een wijziging met entiteit `factuur` is een definitieve factuur van de telefoon,
met precies één revisie (de pc bewerkt een ontvangen factuur nooit). Per wijziging, in één databasetransactie:
(1) staat de registersleutel er al, dan herhaalt de pc de eerste uitkomst; (2) de velden worden gecontroleerd en
doorgerekend (`veld-ongeldig` met `veld` en `melding`, zonder rijen; ook een hoeveelheid met meer dan drie
decimalen); (3) de apparaatcode in het `nummer` moet gelijk zijn aan die van het apparaat (anders 400 `ongeldig`,
zonder rijen); (4) de klant wordt gezocht op `klant_uuid`, daarna via een alias van een samengevoegde klant,
en een gearchiveerde klant telt gewoon; de factuur verwijst naar de doelklant, de klantmomentopname blijft die uit de
wijziging; een onbekende klant of een leverancier wacht (zie hieronder); (5) bestaat de `uuid`
al als factuur, onder een andere revisie of met andere inhoud, dan is het antwoord `overgeslagen` en blijft de factuur
ongewijzigd; (6) wacht de factuur niet op iets (zie hieronder), dan wordt ze overgenomen: `toegepast` bij een nieuwe factuur, `overgeslagen` als de pc hem
al had, `afgewezen` met `nummer-bezet` als het nummer van een andere factuur is; (7) de registerrij staat in dezelfde
transactie (een wachtende factuur krijgt geen registerrij, wel een rij in `sync_wachtrij`). De pc-teller voor factuurnummers wordt niet gebruikt: het nummer is dat van de telefoon. Een
creditnota hoort bij de klant van het origineel. Een databasefout geeft 500 `opslaan-mislukt` zonder halve rijen.
De groottegrens van 128 KiB wordt op bytes getoetst (niet op tekens), nog voor de wijziging gelezen wordt.

**Weigercodes van de factuurdienst.** De pc bepaalt de foutcode van een geweigerde factuur uit de code die
`InvoiceService.importDefinitive` teruggeeft (`nummer-bezet`, `origineel-onbekend`, `periode`, `andere-klant`,
`creditnota-ongeldig`, `totalen`, `hoeveelheid`, `nummer-ongeldig`, `andere-weigering`), niet uit de Nederlandse tekst.
`periode` komt uit de Ledger of de writeGuard van de boekhouderskopie; die guard geldt ook voor telefoonfacturen, omdat
de app de eigen `InvoiceService` aan de ontvangst meegeeft. Naar de telefoon gaan alleen `nummer-bezet`,
`factuur-geweigerd` (alle overige codes); de tekst blijft de `melding`. `origineel-onbekend` en `periode` zijn geen afwijzing
meer: die factuur wacht (zie hieronder).

**Een factuur die wacht.** Per factuur bepaalt de pc in deze volgorde waar ze op wacht: een creditnota op haar origineel
(`wacht_op_entiteit` `factuur`, reden `origineel-onbekend`; dat origineel kan zelf nog wachten), daarna een onbekende klant of
een leverancier (`klant`, `klant-onbekend`), daarna een onbekend `project_uuid` (`project`, `project-onbekend`) en ten slotte
een afgesloten periode of de writeGuard van de boekhouderskopie (`periode`, reden `periode`; er is geen object om op te
wachten, `wacht_op_uuid` is dan een lege tekst, want de kolom mag geen NULL zijn). Een bekend project van dezelfde klant
geeft `invoices.job_id`; een project van een andere klant geeft een gewoon overgenomen factuur zonder `job_id`, nooit een
afwijzing. Het antwoord is 200 `wacht`, met een rij in `sync_wachtrij` (met het factuurnummer in `nummer`), zonder factuur,
boeking of registerrij. Is de wachtrij van het apparaat vol (1000 onverwerkte rijen), dan is het antwoord 503 `wachtrij-vol`
zonder iets op te slaan; een geldige factuur wordt nooit afgewezen omdat de wachtrij vol is.

**Hervatten.** Een wachtende factuur wordt opnieuw geprobeerd bij elke toegepaste klant, elk toegepast project en elke
toegepaste factuur (een cascade: klant, project, origineel, creditnota), na elke wijziging van hetzelfde apparaat
met onverwerkte facturen in de wachtrij, ongeacht de uitkomst of de statuscode (ook een die zelf wacht, 400, 409, 500, 503
`wachtrij-vol` of `niet-ondersteund`, en ook voor de entiteiten bon en foto), zodat een heropende periode altijd wordt
opgepikt, en bij het starten van de receiver. Het hervatten verandert het antwoord op de wijziging zelf nooit en laat het nooit
falen. Een ongeldige wijziging van een niet-gekoppeld apparaat bereikt de ontvanger niet en hervat dus niets. De wijziging wordt
dan opnieuw gelezen en gecontroleerd, ook de apparaatcode in het nummer; ze kan alsnog `afgewezen` worden (bijvoorbeeld een
creditnota voor een andere klant dan het origineel): de rij krijgt dan `verwerkt_uitkomst` `afgewezen` met de foutcode als
`verwerkt_reden` en een registerrij, en blijft niet hangen. Een ontkoppeld apparaat of een afgesloten apparaatcode is geen reden
om een al ontvangen wijziging weg te gooien. Hervatten is herhaalbaar en idempotent: factuur, boeking en registerrij komen
hoogstens één keer, en de wachtrijrij blijft altijd staan (alleen `verwerkt_op`, `verwerkt_uitkomst` en `verwerkt_reden`
worden gevuld, in dezelfde transactie als de factuur). Een fout bij één factuur laat die rij onverwerkt zonder halve rijen en
stopt de rest niet. De wachtrij bewaart de route van de eerste ontvangst (kolom `route`: `netwerk`, `map` of `mail`) en de
registerrij van een uit de wachtrij verwerkte wijziging (factuur of project) krijgt die route; een rij zonder route (van voor
die kolom) hervat met `netwerk`.

**Het register `sync_ontvangen`.** Idempotentie loopt uitsluitend via de exacte sleutel (`apparaat_id`
(het apparaat-ID uit de envelop), `entiteit`, `uuid`, `revisie`), niet via de hoogste revisie en niet
via de route waarlangs het bericht binnenkwam. Een rij bevat `tijd` (het bewerkmoment van de
telefoon), `ontvangen_op` (de klok van de pc), `uitkomst` (die van de **eerste** verwerking:
`toegepast`, `overgeslagen` of `afgewezen`), `fout` (bij `afgewezen`) en `route` (`netwerk`). Staat de
sleutel er al, dan schrijft de pc niets: hij antwoordt `overgeslagen`, of bij een eerder afgewezen sleutel
opnieuw `afgewezen` met dezelfde `fout` en zonder nieuwe rij. Is de sleutel nieuw, dan wordt de wijziging
toegepast, ook als de revisie lager is dan een die de pc al kent. Veldfouten, `klant-onbekend`, `project-onbekend`, `wacht`, `wachtrij-vol`, `niet-ondersteund`
en `opslaan-mislukt` laten geen registerrij achter, zodat dezelfde wijziging later gewoon opnieuw kan.

**Toegestane klantvelden.** Alleen deze, met hun naam in de wijziging (een ander veld, ook `type`,
`paid_with`, `id`, `uuid` of `revisie`, geeft `veld-ongeldig` met de veldnaam in de melding). Elk veld
wordt los gecontroleerd, nooit in samenhang met de rest van de rij, zodat de volgorde van aankomst
niets uitmaakt. Een optioneel veld mag `null` zijn; `naam` en `gearchiveerd` niet.

| Veld | Kolom | Regel |
|---|---|---|
| `naam` | naam | verplicht bij een nieuwe klant; in een wijziging niet leeg; hooguit 200 tekens |
| `contactpersoon`, `telefoon`, `plaats`, `postcode`, `land` | contactpersoon, telefoon, plaats, postcode, land | tekst, hooguit 200 tekens; `land` is twee letters (leeg wordt `NL`); een postcode wordt in hoofdletters bewaard |
| `adres` | adres | tekst, hooguit 500 tekens |
| `email` | e-mail | een geldig e-mailadres |
| `btw_nummer`, `iban` | btw-nummer, rekeningnummer | een geldig btw-nummer, een geldige IBAN |
| `kvk_nummer` | KvK-nummer | 8 cijfers bij Nederland, anders een geldig buitenlands handelsregisternummer; beoordeeld samen met `land` (zie hieronder) |
| `betaaltermijn_dagen` | betaaltermijn | een geheel getal van 0 tot en met 365 |
| `notities` | notities | tekst, hooguit 4000 tekens |
| `gearchiveerd` | gearchiveerd | `0` of `1`; archiveren is dit veld, er wordt nooit een klant verwijderd |

KvK-nummer en land: de telefoon volgt dezelfde regel als de pc. Bij Nederland (een leeg of ontbrekend
`land` telt als `NL`) is een `kvk_nummer` precies 8 cijfers (spaties worden weggehaald); bij een
buitenlands `land` is het een geldig buitenlands handelsregisternummer. Omdat de velden los van elkaar
winnen, wordt de regel gecontroleerd op de uiteindelijke combinatie van `land` en `kvk_nummer`, zoals die
na het toepassen van de winnende velden in de klant zou staan. Klopt die niet, dan wordt de hele wijziging
geweigerd met `veld-ongeldig` (veld `kvk_nummer`, of `land` als het land de oorzaak is), en blijft er niets
achter: geen klantrij, geen veldtijden, geen logboek, geen nieuw wijzigingsnummer, geen registerrij. De
telefoon bewaart dus nooit een stand die de pc zelf zou weigeren. Stuur `land` en `kvk_nummer` die samen
veranderen daarom in dezelfde wijziging; los gestuurd wordt een tussenstand die niet klopt geweigerd (een
buitenlands nummer bij een Nederlandse klant, of een land NL bij een buitenlands nummer), ook als de
andere wijziging later alsnog komt.

**Een nieuwe klant.** Een wijziging met `naam` op een onbekende `uuid` maakt een nieuwe klant met die
`uuid`: type klant en land `NL` tenzij het land is opgegeven. Een onbekende `uuid` zonder `naam` geeft
`klant-onbekend`. Een `uuid` die niet als klant bekend is maar wel als **alias** (de pc legt een alias
vast in `relation_aliases`) leidt naar de doelklant: die krijgt de
wijziging en er komt geen nieuwe klant. De pc leest aliassen alleen; hij maakt ze niet aan. Een
`uuid` van een leverancier wordt `afgewezen` (`geen-klant`); een klant van het type klant en van het
type beide mag wel.

**Samenvoegen per veld.** Elk veld heeft een tijd en een bron. De nieuwste `(tijd, bron)` wint: bij een
nieuwere tijd wint de wijziging, bij een gelijke tijd de lexicografisch grootste bron (`pc` wint van
`M1`, `M2` wint van `M1`), en bij gelijke tijd en bron de grootste waarde als tekst. Een veld met een
oudere tijd wordt overgeslagen, zonder logregel. Het bewerkmoment van de telefoon bepaalt dus alleen wie
per veld wint, nooit wat de telefoon ophaalt. Een veld dat wint wordt toegepast, ook als de waarde
gelijk is, omdat de tijd van het veld anders van de volgorde zou afhangen. De bron is de **apparaatcode**
(`M1`, `M2`, …, zie *De apparaatcode*), nooit het apparaat-ID. Een veld dat nog geen tijd heeft (een klant
van vóór de sync) geldt als gewijzigd op het moment dat de klant is aangemaakt, door de `pc`: de
**ondergrens**, `created_at` van de klant gelezen als UTC in milliseconden (`veldOndergrens` in
`src/sync/ondergrens.ts`). Daardoor overschrijft een oudere telefoonwijziging geen gegevens van de pc.
Bij een klant die de telefoon zelf aanmaakt krijgen de velden die hij niet meestuurt een lege tijd
(0, bron leeg): niemand heeft ze gezet, dus een latere wijziging wint altijd, ook een oudere revisie die
pas daarna aankomt. Van elke toegepaste wijziging gaat de revisie van de klant (de pc-revisie, alleen
informatief) met één omhoog, en elk toegepast veld komt in het logboek (`relation_changelog`) en in de
tijden per veld (`relation_field_rev`).

**Het nummer `sync_seq`.** Elke toepassing waarbij minstens één veld echt wordt toegepast, geeft de klant
een nieuw nummer uit de globale wijzigingsteller (`sync_teller`, rij `wijziging`), in dezelfde transactie.
Een overgeslagen, afgewezen of ongeldige wijziging verhoogt de teller niet. Dit nummer is de **enige basis
voor latere delta-sync**: een wijziging met een bewerkmoment van drie dagen geleden krijgt toch een
nieuw, hoger nummer, zodat een andere telefoon die vanaf een hoger nummer vraagt haar nog ophaalt. De
bewerktijd is nooit een cursor.

**Projecten.** Een project is een klus op de pc (tabel `jobs`). Dezelfde regels als bij klanten gelden:
idempotent op de registersleutel, per veld samengevoegd op (tijd, bron), een nieuw wijzigingsnummer
`sync_seq` bij elke echt toegepaste wijziging, en elke wijziging in één transactie. De pc **verwijdert
een project nooit**: archiveren is het veld `gearchiveerd`, en een gearchiveerd project blijft bestaan
(facturen blijven ernaar verwijzen) maar staat niet meer in de lijsten en voorstellen. Alleen deze velden;
elk ander veld (ook `quote_id`, `kosten`, `marge`, `lat`, `lon`, een kolomnaam, `__proto__`,
`constructor` en `prototype`) geeft `veld-ongeldig`, en meer dan 16 velden in één wijziging ook.
Een veld buiten het schema, een verkeerd type of een te lange tekst wordt nooit bewaard.

| Veld | Kolom | Regel |
|---|---|---|
| `titel` | titel | verplicht bij een nieuw project; niet leeg; hooguit 200 tekens |
| `adres` | adres | tekst of `null`, hooguit 300 tekens |
| `startdatum`, `einddatum` | startdatum, einddatum | een bestaande datum `JJJJ-MM-DD` of `null` |
| `notities` | notities | tekst of `null`, hooguit 4000 tekens |
| `status` | status | `gepland`, `bezig`, `klaar` of `geannuleerd`; `gefactureerd` is een veldfout: dat zet alleen de pc, door een factuur te maken |
| `klant` | klant | de `uuid` van een klant (kleine letters), ook als alias; niet `null` |
| `gearchiveerd` | gearchiveerd | `0` of `1` |

Een nieuw project (onbekende `uuid`) heeft `titel` en `klant` nodig. Een wijziging van een bestaand
project mag elk veld los sturen. Twee regels die de pc zelf ook volgt:

- Een `status` van de telefoon wordt, ongeacht de tijd, overgeslagen als het project de status
  `gefactureerd` heeft of een factuur heeft. Dat veld krijgt dan alleen een regel in het logboek
  (`job_changelog`); de overige velden van dezelfde wijziging worden gewoon verwerkt.
- De `klant` van een bestaand project kan alleen wisselen zolang er niets aan hangt: geen offerte (een
  klus uit een geaccepteerde offerte houdt de klant van die offerte, anders maakt de klus een factuur voor
  een andere klant), factuur, inkoopfactuur, rit of werkbonregel. Anders is de wijziging `afgewezen` met
  `fout: "klus-gekoppeld"` en een `melding` in het Nederlands, met een registerrij en zonder iets te
  schrijven in het project. Op de pc kan de klant van een offerte met een klus ook niet meer wijzigen.
- De `klant` moet een klant zijn (type klant of beide). Een `uuid` van een leverancier, ook via een alias, is
  `afgewezen` met `fout: "geen-klant"`, zoals bij klantwijzigingen. Dat geldt ook voor een wachtend project
  dat bij het verwerken blijkt naar een leverancier te verwijzen: de rij wordt gemarkeerd (`afgewezen`,
  reden `geen-klant`) en krijgt een registerrij, en niet verwijderd.

**De wachtrij `sync_wachtrij`.** Verwijst een project naar een klant die de pc nog niet kent (ook niet als
alias), dan antwoordt de pc `wacht`: de hele wijziging wordt als JSON in een rij van `sync_wachtrij`
bewaard (met `bron`, de tijd, en waar ze op wacht), zonder registerrij en zonder project. Staat er al een
onverwerkte rij voor dezelfde `uuid` van welk apparaat dan ook en bestaat het project nog niet, dan wacht
ook een latere revisie, ook zonder titel of klant. Zonder wachtende rij en zonder project geeft een
revisie zonder titel of klant `project-onbekend` (409). Dezelfde wijziging nog eens sturen blijft één rij.
**De eerst opgeslagen inhoud is leidend:** staat de sleutel (apparaat, entiteit, `uuid`, `revisie`) al in de
wachtrij, verwerkt of niet, dan wordt een herhaling met andere inhoud (ook met een inmiddels bekende
klant) niet toegepast; ze krijgt `wacht` zolang de rij onverwerkt is, en daarna het antwoord van de eerste
keer (`overgeslagen`, of dezelfde afwijzing).
Zodra de klant is toegepast (en na elk toegepast project, tot er geen voortgang meer is, en bij het
starten van de receiver) verwerkt de pc de rijen, per project in één transactie. Ook een klantwijziging die
als `overgeslagen` wordt beantwoord (een herhaling) probeert de wachtrij opnieuw, zodat een wachtend project
na een tijdelijke opslagfout alsnog wordt gemaakt. Als aanmaakrij kiest de pc een rij met titel en een
bekende, geldige klant (de laagste revisie eerst); een oudere rij die nog op een onbekende klant wacht houdt
een nieuwere niet tegen en blijft liggen tot die klant er is. Daarna gaat de rest in revisievolgorde, per
veld op (tijd, bron). Elke rij wordt dan
opnieuw gecontroleerd; een rij die niet meer klopt wordt `afgewezen` gemarkeerd, met een registerrij
`afgewezen`. Een rij wordt **nooit verwijderd**: afhandelen zet `verwerkt_op`, `verwerkt_uitkomst`
(`toegepast`, `overgeslagen` of `afgewezen`) en `verwerkt_reden`, en de registerrij komt in dezelfde
transactie. Een fout halverwege laat de rij onverwerkt. Per apparaat tellen alleen onverwerkte rijen mee
voor de limiet van 1000; is die bereikt, dan antwoordt de pc `wachtrij-vol` (503) zonder iets op te
slaan. De groottegrens van een wijziging (128 KiB) geldt ook voor de wachtrij.

**Wat nog niet.** `stamgegevens` bevat de btw-regeltabel en de VIES-controledatum nog niet. `bon` en `foto` worden niet opgeslagen en gelden niet
als afgeleverd (`niet-ondersteund`, zonder registerrij).

Open punten bij facturen (volgen in latere stappen): de bonnenmap- en e-mailroute voor facturen, en een scherm dat de wachtende wijzigingen toont (nu is een
wachtende factuur alleen in `sync_wachtrij` te zien). Ook versie 2 staat achter dezelfde schakelaar als de rest: zolang
`PHONE_SCANNER` uit staat, is er niets van te zien.

### Een bon als wijziging, met bijlagen

Naast het bericht `bon` (hierboven) kan een bon ook binnenkomen als `wijziging` met entiteit `bon`: de bonnenmap-
en e-mailroute van een volgende stap gebruiken dit formaat, en de pc legt er een registerrij voor vast. Het
`bon`-bericht blijft ongewijzigd werken, in versie 1 en 2. Een wijziging met entiteit `bon` of `foto` in een
envelop van versie 1 wordt geweigerd (`ongeldig`): versie 1 kent alleen `hallo` en `bon`.

De JSON is de gewone change-set (entiteit `bon`, `uuid` = het ID van de bon, revisie 1, bewerkmoment, `velden`).
Direct na de JSON, net als bij het bon-bericht, staan de **bijlagen**: de JPEG's in de volgorde van `velden.fotos`,
samen precies zo groot als de som van de `grootte`'s. Voorbeeld van de JSON (de bijlage is één JPEG van 751 bytes;
het voorbeeld wordt gecontroleerd door `tests/sync-bonnen.test.ts`):

```jsonc
{"soort":"wijziging","tijd":1790848800000,"wijziging":{"entiteit":"bon","uuid":"3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b","revisie":1,"tijd":1790848790000,"velden":{"betaalwijze":"contant","notitie":"Schroeven voor de klus bij Jansen","fotos":[{"grootte":751,"sha256":"e4e731cb4b43157668cf3fad52ee2aad283f0f23a19455907cb6ad6ae11d726c"}]}}}
```

| Veld in `velden` | Verplicht | Betekenis |
|---|---|---|
| `betaalwijze` | ja | `"pin"`, `"contant"`, `"prive"` of `"later"` |
| `notitie` | nee | tekst zonder stuurtekens (regeleinden mogen), hooguit 1000 tekens; langer is een fout (`veld-ongeldig`), de pc kapt hier niet af |
| `locatie` | nee | `{"lat": -90…90, "lon": -180…180}`, precies die twee sleutels |
| `fotos` | ja | 1 tot 10 objecten met precies `grootte` (bytes, vanaf 1) en `sha256` (64 kleine hexcijfers van die foto) |

Andere velden (ook `__proto__`) zijn een fout. De kern (`leesBonVelden` in `packages/core`) controleert de vorm
zuiver en zonder Node; de pc vergelijkt daarna de bijlagen met de velden: elke grootte en elke `sha256` moeten
kloppen met de echte bijlage, en elke bijlage moet aan de inhoud een JPEG zijn (zoals bij het bon-bericht).

**Uitkomsten.** De bon wordt opgeslagen via dezelfde spool als het bon-bericht (`ReceiptSpool.accept`): dezelfde
bestanden en rijen, met de `uuid` als ID van de bon, en de locatie (ook die in de JPEG zelf) alleen bewaard als de
gebruiker dat op de pc heeft toegestaan. Daarna loopt de bon door de inbox zoals elke andere bon. Er komt geen rij in
`sync_wachtrij`, en de wijzigingsteller en de factuurteller van de pc worden niet gebruikt. Een factuurwijziging
(of klant of project) met een bijlage is en blijft een vormfout.

| HTTP | `uitkomst` / `fout` | Registerrij | Betekenis |
|---|---|---|---|
| 200 | `toegepast` | ja (route `netwerk`) | de bon staat nu in de spool |
| 200 | `overgeslagen` | ja of al aanwezig | deze registersleutel had de pc al (ook via een andere route, `map` of `mail`; de route in het register blijft die van de eerste), of de spool had deze bon al met dezelfde inhoud |
| 200 | `afgewezen`, `fout: "id-botst"` | ja | de `uuid` is al gebruikt voor een andere bon (bijvoorbeeld eerder als `bon`-bericht); de eerst opgeslagen inhoud blijft |
| 400 | `ongeldig` | nee | revisie anders dan 1, een grootte of `sha256` die niet bij de bijlage past, te veel of te weinig bytes, meer dan 10 foto's, of een bijlage die geen JPEG is |
| 400 | `veld-ongeldig`, met `veld` en `melding` | nee | een veld buiten het schema, een ongeldige waarde, een lege lijst `fotos` |
| 413 | `te-groot` | nee | de foto's samen meer dan 19 MiB (19.922.944 bytes), zoals bij het bon-bericht; het hele bericht blijft binnen de 20 MiB van de envelop |
| 413 | `te-groot` | nee | de JSON van de wijziging (entiteit, uuid, revisie, tijd, velden) boven 128 KiB, of JSON plus bijlagen boven 20 MiB. Dit geldt op elke route, ook `map` en `mail`, en op de ruwe velden: een notitie van spaties, die de pc daarna zou trimmen, telt voluit mee |
| 500 | `opslaan-mislukt` | nee | de pc kon niet opslaan; er is geen rij, geen registerrij en geen los bestand achtergebleven; dezelfde wijziging opnieuw sturen werkt gewoon. Lukt het verwijderen van een neergezet bestand zelf niet, dan onthoudt de pc het, probeert het later opnieuw en maakt er nooit een bon van |

De registersleutel is (apparaat, entiteit, `uuid`, revisie): dezelfde sleutel met andere inhoud is dus een
herhaling (`overgeslagen`) en geen botsing; een botsing ontstaat bij hetzelfde ID via een andere weg (het
bon-bericht, of een ander apparaat).

**Atomair.** Het bestand in de spool en de databank zijn niet één transactie. De pc schrijft daarom het bestand
eerst, de rij in `scanner_documents` en de registerrij daarna samen in één databasetransactie; mislukt iets, dan wordt
de transactie teruggedraaid en haalt de pc het bestand weg dat hij zojuist neerzette (en een half geschreven tijdelijk
bestand). Een bestand van een eerdere, bevestigde bon blijft altijd staan.

**Entiteit `foto`.** Een wijziging met entiteit `foto` heeft dezelfde vorm, met `project_uuid` in plaats van
`betaalwijze`; wat de pc ermee doet staat in *Een foto bij een project*.

**Stappenlijst voor de Android-app.**

1. Kies het ID van de bon (UUID, kleine letters) en houd het gelijk bij elke nieuwe poging.
2. Bereken per JPEG de `sha256` (kleine hexcijfers) en de `grootte` in bytes; zet ze in `velden.fotos`, in volgorde.
3. Bouw de change-set: entiteit `bon`, `uuid`, revisie 1, het bewerkmoment en de `velden`.
4. Zet het bericht (`soort`, `tijd`, `wijziging`) in een frame met de JPEG's direct achter de JSON, in een envelop van
   versie 2, en stuur het.
5. `toegepast` en `overgeslagen` zijn bevestigingen: de bon mag van de telefoon. `afgewezen` met `id-botst`: melden.
   `niet-ondersteund` (alleen bij `foto`) en 500 of 503: bewaren en later opnieuw; 400 en 413: niet opnieuw.

### Een foto bij een project

Een foto van de telefoon (een of meer JPEG's) hoort bij een project en wordt bewaard bij die klus op de pc. De
wijziging heeft entiteit `foto`, revisie 1 en de bijlagen direct achter de JSON, precies zoals bij de bon (zie
*Een bon als wijziging, met bijlagen*). Voorbeeld van de JSON (de bijlage is één JPEG van 751 bytes; het voorbeeld
wordt gecontroleerd door `tests/sync-fotos.test.ts`):

```jsonc
{"soort":"wijziging","tijd":1790848800000,"wijziging":{"entiteit":"foto","uuid":"7c9e6679-7425-40de-944b-e07fc1f90ae7","revisie":1,"tijd":1790848790000,"velden":{"project_uuid":"3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b","notitie":"Muur voor het schilderen","fotos":[{"grootte":751,"sha256":"e4e731cb4b43157668cf3fad52ee2aad283f0f23a19455907cb6ad6ae11d726c"}]}}}
```

| Veld in `velden` | Verplicht | Betekenis |
|---|---|---|
| `project_uuid` | ja | het project (UUID, kleine letters) waar de foto's bij horen; een gearchiveerd project telt gewoon |
| `notitie` | nee | tekst zonder stuurtekens, hooguit 1000 tekens; hoort bij alle foto's van deze wijziging |
| `fotos` | ja | 1 tot 10 objecten met precies `grootte` en `sha256`, in de volgorde van de bijlagen |

De controles en de grenzen zijn die van de bon, op elke route (`netwerk`, `map` en `mail`) en op de ruwe velden: de
`grootte` en `sha256` moeten bij de bijlage passen, elke bijlage moet aan de inhoud een JPEG zijn, de bijlagen samen
hooguit 19 MiB, de JSON hooguit 128 KiB. Een foto heeft alleen revisie 1: een foto wordt nooit bewerkt en nooit
verwijderd, niet door de telefoon en niet door de pc.

**Bestanden.** De pc bewaart elke foto als `bijlagen/telefoon/<uuid van de wijziging>/<volgnummer>.jpg` in de
administratie, dus mee bij verhuizen en in de back-up, en legt een rij per foto vast bij het project (`job_photos`:
klus, wijziging, volgnummer, relatief pad, `sha256` en grootte van het bewaarde bestand, notitie, bewerkmoment van de
telefoon). Een bestand wordt exclusief aangemaakt: staat er al een bestand, dan moet de inhoud gelijk zijn. Het
beeld wordt niet opnieuw gecomprimeerd. **De locatie** (GPS in de EXIF en in een XMP-blok) gaat uit de JPEG, tenzij de
gebruiker op de pc heeft toegestaan locatie te bewaren. Daardoor kan de `sha256` van het bewaarde bestand verschillen van
die in de velden: de `sha256` in de velden is die van wat de telefoon stuurde (daarmee controleert de pc de bijlage),
die in de pc is die van wat is bewaard. De pc vergelijkt een herhaling met en zonder locatie als dezelfde foto, ook als de instelling tussentijds is veranderd: het al bewaarde bestand blijft leidend en de rijen
wijzen naar wat daadwerkelijk bewaard is.

**Zichtbaar op de pc.** De foto's van de telefoon zijn op de pc alleen lezen te bekijken bij de klus (onder *Foto's van de telefoon* in het klusscherm, op volgorde van het bewerkmoment, ook bij een gearchiveerde of gefactureerde klus), zonder pad, `sha256` of wijziging-uuid. Er is geen functie om een foto te wijzigen of te verwijderen, en een foto komt niet in een factuur of rapport.

**Een onbekend project wacht.** Kent de pc het project (nog) niet, dan antwoordt hij `wacht`, net als bij een
factuur voor een onbekend project: er komt een rij in de wachtrij (`sync_wachtrij`, wacht op het project, reden
`project-onbekend`, met de route van de eerste ontvangst), maar geen registerrij en geen foto. De bestanden staan dan al
op schijf, met per bestand een verwijzing in `sync_wachtrij_bijlagen`; de wachtrij bewaart nooit de bytes zelf. Zodra
het project er is, bij elk toegepast project of toegepaste klant en bij het starten van de pc, leest de pc de wijziging
opnieuw, controleert hij de bewaarde bestanden opnieuw (aantal, grootte, `sha256`, JPEG) en neemt hij de foto's over:
de bestanden blijven waar ze staan en `job_photos` wijst ernaar. Een project dat zelf nog op zijn klant wacht houdt de
foto ook wachtend; komt de klant, dan zijn project en foto beide toegepast. Is een bestand intussen beschadigd of weg,
dan is de uitkomst `afgewezen` met `ongeldig`. Een afgehandelde wachtende foto staat in de `bevestigingen` van die
telefoon (zes velden, nooit een pad), ook als de telefoon intussen is ontkoppeld. Een volle wachtrij (1000 onverwerkte
rijen per apparaat, of samen meer dan 256 MiB aan bestanden van onverwerkte wachtende foto's van dat apparaat) geeft
503 `wachtrij-vol`, zonder rij en zonder bestanden; de foto komt dan later opnieuw. Afgehandelde rijen tellen niet mee.
Is het project door de pc afgewezen (bijvoorbeeld de klant is een leverancier, `geen-klant`), dan wordt de wachtende foto
afgewezen met `project-afgewezen`; de bestanden blijven staan. Komt de foto pas na die afwijzing binnen (van hetzelfde
apparaat), dan wordt ze direct afgewezen met `project-afgewezen`, zonder wachtrijrij en zonder bestanden.

| HTTP | `uitkomst` / `fout` | Registerrij | Betekenis |
|---|---|---|---|
| 200 | `toegepast` | ja | de foto's staan nu bij het project |
| 200 | `overgeslagen` | ja of al aanwezig | deze registersleutel had de pc al (ook via een andere route), of dezelfde foto stond er al |
| 200 | `wacht` | nee | het project is nog onbekend; wacht op de `bevestigingen` |
| 200 | `afgewezen`, `fout: "id-botst"` | ja | dezelfde `uuid` met een andere inhoud dan de bewaarde foto; de eerst opgeslagen inhoud blijft |
| 200 | `afgewezen`, `fout: "ongeldig"` of `"veld-ongeldig"` | ja | alleen bij een wachtende foto die bij het verwerken niet meer klopt |
| 200 | `afgewezen`, `fout: "project-afgewezen"` | ja | alleen bij een wachtende foto waarvan het project door de pc is afgewezen; niet opnieuw sturen |
| 400 | `ongeldig`, `veld-ongeldig` | nee | revisie anders dan 1, een bijlage die niet klopt, of een veld dat niet klopt (zoals bij de bon) |
| 413 | `te-groot` | nee | de grenzen van de bon |
| 503 | `wachtrij-vol` | nee | de wachtrij van dit apparaat is vol; herhaalbaar |
| 500 | `opslaan-mislukt` | nee | de pc kon niet opslaan: geen rij, geen registerrij en geen los bestand; dezelfde wijziging opnieuw sturen werkt gewoon |

**Atomair.** Net als bij de bon draait de pc de rijen (`job_photos`, of de wachtrij met haar verwijzingen, en het
register) in een transactie en haalt hij de bestanden weg die hij net neerzette als er iets misgaat. Lukt het
verwijderen zelf niet, dan onthoudt de pc het bestand, probeert hij het later opnieuw en wordt het nooit een foto.
Zonder administratiemap in de ontvanger van de pc blijft `foto` `niet-ondersteund`.

**Stappenlijst voor de Android-app.**

1. Kies de `uuid` van de wijziging (UUID, kleine letters) en houd hem gelijk bij elke nieuwe poging.
2. Neem de `uuid` van het project (dat de pc kent uit de stamgegevens of dat de telefoon zelf maakte) als `project_uuid`.
3. Bereken per JPEG de `sha256` en de `grootte`; zet ze in `velden.fotos`, in volgorde (1 tot 10 foto's).
4. Bouw de change-set (entiteit `foto`, revisie 1, het bewerkmoment van de foto) en stuur hem met de JPEG's direct achter de
   JSON, in een envelop van versie 2.
5. `toegepast`, `overgeslagen` en `afgewezen` zijn eindantwoorden: de foto mag van de telefoon (bij `afgewezen` eerst melden).
   `wacht` is geen eindantwoord: bewaar de foto tot de `bevestigingen` een uitkomst geven. 500 en 503: bewaren en later
   opnieuw; 400 en 413: niet opnieuw.

### Reeksbewaking: gaten in de factuurnummers van een telefoon

De pc bewaakt de nummerreeks van de facturen van een telefoon. Een **reeks** is een apparaatcode met een
jaar (`M1-2026`) en loopt vanaf 1 tot het hoogste volgnummer van een factuur die de pc heeft overgenomen.
Een **gat** is een aaneengesloten bereik volgnummers in die reeks dat ontbreekt, bijvoorbeeld `M1-2026-0002`
tot en met `M1-2026-0004` als alleen 0001 en 0005 er zijn. Een gat is geen fout van de pc en geen
afwijzing: het is een vraag aan de gebruiker, want een nummer kan nog onderweg zijn (de telefoon heeft de
factuur nog niet gestuurd), nooit zijn gebruikt, of horen bij een concept dat is vervallen.

Een volgnummer telt als **bekend** als er een factuur met dat nummer is, als een onverwerkte rij in
`sync_wachtrij` dat nummer draagt (de factuur wacht dan op een klant of project) of als de gebruiker het
als vervallen heeft gemarkeerd. Wordt een wachtende rij afgewezen, dan is het nummer weer een gat. Komt een
ontbrekende factuur alsnog binnen, dan verdwijnt het gat vanzelf, ook als dat nummer eerder als vervallen
was gemarkeerd (die markering blijft als rij bestaan). Reeksen zijn onafhankelijk: een andere
apparaatcode of een ander jaar heeft zijn eigen gaten. Een gat is er ook bij een ontkoppelde telefoon
(`afgesloten_op` in `scanner_device_codes`); de melding zegt dan dat de telefoon niets meer stuurt.

**Op Vandaag** staat per gat precies een melding (soort `invoice-series-gap`, sleutel
`reeks-gat:<apparaatcode>-<jaar>-<van>-<tot>`, prioriteit 2). De berekening is idempotent: dezelfde stand
geeft dezelfde melding, en een gat zonder telefoonfacturen bestaat niet. Er zijn drie knoppen:

- **Nooit gebruikt** (`vervallen-niet-gebruikt`): het bereik wordt als vervallen bewaard met de reden
  `Nummer nooit gebruikt`.
- **Niet verstuurd of concept vervallen** (`vervallen-niet-verstuurd`): idem, met de reden
  `Factuur niet verstuurd of concept vervallen`.
- **Later** (`later`): er verandert niets en de melding blijft staan.

In de kopie bij de boekhouder (de Vandaag-lijst is daar leeg) komt de melding niet. De berekening
gebruikt SQL over bereiken en nooit een lijst van alle denkbare nummers: een telefoon die naar volgnummer
999999999 springt, geeft een gat en een melding, geen duizenden. Hetzelfde geldt voor het markeren: een
bereik van meer dan 10000 nummers in een keer wordt geweigerd, zodat de telefoon niet kan bepalen hoeveel
werk de pc heeft.

**Vervallen markeren** schrijft een rij per nummer in `factuur_reeks_vervallen` (apparaatcode, jaar,
volgnummer, reden, tijdstip), in een transactie: alles of niets. Een lege reden (ook alleen spaties), een
bereik dat een bestaande factuur, een wachtend nummer of een al vervallen nummer bevat, een bereik boven de
reeks en een bereik van meer dan 10000 nummers geven een Nederlandse foutmelding en bewaren niets. **Er
wordt nooit iets verwijderd of overschreven**: een markering is een rij erbij (`ON CONFLICT DO NOTHING`), en
een factuur die later binnenkomt verandert niets aan de rij die er al stond. Het sluiten van een reeks bij
ontkoppelen of herinstallatie bestaat al (`afgesloten_op`); de reeksbewaking leest dat alleen.

**Nog niet vastgesteld door een boekhouder:** of een tweede nummerreeks voor facturen van de telefoon (naast
die van de pc) fiscaal in orde is, is niet geverifieerd. Een boekhouder moet dat eerst bevestigen voordat
dit onderdeel voor gebruikers aan gaat. Zolang `PHONE_SCANNER` uit staat, is er niets van te zien.

### VIES-nacontrole van het btw-nummer: een melding op Vandaag, op verzoek

Een factuur van de telefoon met een `icp`- of `icp-dienst`-regel (levering of dienst aan een bedrijf in een
ander EU-land, zonder btw) is alleen juist als het btw-nummer van de klant geldig is. Daarom meldt de pc op
**Vandaag** een klant bij wie dat nummer nog niet in VIES is gecontroleerd, of bij wie VIES het nummer niet
kent.

**Wanneer de melding verschijnt.** Er is een telefoonfactuur (`apparaat_code` gevuld, geen concept, geen
creditnota) met minstens een regel `icp` of `icp-dienst`, en de laatste uitslag in `vies_checks` van het
(genormaliseerde) btw-nummer van de klant is niet "geldig". Een controle zonder uitslag (VIES onbereikbaar)
telt als nog niet gecontroleerd. Een gewone pc-factuur geeft deze melding niet; die valt onder de btw-controle
bij de aangifte. In de kopie bij de boekhouder komt de melding niet.

**Precies een melding per klant en btw-nummer**, niet per factuur: key `vies-klant:<klant>-<toestand>-<btw-nummer>`
met toestand `onbekend` of `ongeldig`. De tekst noemt het aantal en de nummers van de telefoonfacturen. Verandert
de toestand of het btw-nummer van de klant, dan is het een nieuwe melding. De lijst is begrensd: hoogstens 50
meldingen, de rest staat als telling in de laatste. De begrenzing komt pas nadat alles is weggelaten wat niet meer
telt: klanten met een geldige uitslag en meldingen die de gebruiker met **Gezien** heeft weggeklikt tellen niet mee,
dus ook de klanten daarna komen aan de beurt. Er is geen vaste grens op het aantal bekeken klanten.

**Er gaat niets automatisch naar VIES.** Vandaag opbouwen leest alleen de eigen databank. Een btw-nummer gaat
alleen naar ec.europa.eu als de gebruiker op de knop **Controleer in VIES** drukt; dan gaat precies dat nummer
mee. De uitslag met datum wordt bewaard als bewijs (zoals bij "Controleer nu in VIES" bij de klant) en komt bij
het volgende antwoord van `stamgegevens` bij de telefoon. Geeft VIES geen uitslag, dan toont de pc de reden en
blijft de melding staan.

**Wat de gebruiker doet.** Op **Controleer in VIES** drukken (bij een geldig nummer verdwijnt de melding), de
klant openen om het btw-nummer na te kijken of aan te passen, of op **Gezien** drukken om de melding voor dit
nummer te laten verdwijnen. Is het nummer ongeldig, vraag de klant dan om het juiste nummer en reken tot die tijd
Nederlandse btw. De pc haalt klant en btw-nummer bij elke knop opnieuw uit de databank; is de melding intussen
verouderd, dan volgt een nette foutmelding.

## Wat dit wel en niet beschermt

- **Meelezen en aanpassen op het netwerk**: niet mogelijk zonder de sleutel. De inhoud (foto's,
  notitie, locatie) is versleuteld; een aangepast bericht wordt geweigerd.
- **Opnieuw insturen** van een onderschept bericht: geweigerd op tijdstempel en nonce, en een bon komt
  op zijn `id` maar één keer binnen.
- **Een valse bevestiging**: een antwoord dat niet met de sleutel te openen is, of bij een ander
  verzoek hoort, telt niet. De telefoon gooit dan niets weg.
- **Zichtbaar voor iemand op hetzelfde netwerk**: dát er een ontvangstpunt is (mDNS, poort), het
  apparaat-ID, het pc-ID en de grootte en het moment van berichten. Niet de inhoud.
- **De QR-code is de sleutel.** Wie hem fotografeert terwijl hij op het scherm staat, kan zich als die
  telefoon voordoen en berichten van die telefoon lezen. Daarom staat hij alleen tijdens het koppelen
  op het scherm, verloopt hij na tien minuten en kan de gebruiker een telefoon ontkoppelen.
- **Geen forward secrecy**: lekt de sleutel later uit, dan zijn eerder onderschepte berichten van die
  telefoon te lezen. Voor bonnen op een thuisnetwerk is daar bewust voor gekozen; het houdt het
  protocol klein.
- **Een gekoppelde telefoon kan bonnen afleveren** (vanaf versie 2 ook klant- en projectwijzigingen melden,
  die per veld worden gecontroleerd en bewaard) **en de stamgegevens ophalen**: alleen de whitelist van
  *`stamgegevens`* hierboven, versleuteld en alleen lezen. Verder iets uit de administratie opvragen kan niet,
  en een telefoon kan nooit iets verwijderen.

## Versies

Een onverenigbare wijziging krijgt een nieuw versienummer: byte 4 van de envelop, `v` in de QR-code en
`v` in het TXT-record. Een pc met versie 1 weigert een envelop met een andere versie (`ongeldig`,
onversleuteld). Nieuwe, optionele JSON-velden zijn geen nieuwe versie: de pc negeert wat hij niet kent.

Versie 2 (zie hierboven) is de eerste uitbreiding: nieuwe berichtsoorten, met versie 1 precies zoals
hij was. Een telefoon van versie 1 werkt onveranderd, een hallo in een v1-envelop krijgt het oude
antwoord, en een pc die alleen versie 1 kent weigert de berichten van versie 2.

## De bonnenmap als uitwijk

Zonder wifi-koppeling kan de telefoon bonnen ook in een map zetten die met de pc gelijk wordt gehouden
(Syncthing, Google Drive). Op de pc kiest de gebruiker die map bij *Instellingen → Telefoon &
bonnenmap*. Daar is geen protocol voor nodig, wel deze afspraken:

- De pc pakt alleen bestanden direct in de map op (geen submappen), met de extensie `.jpg`, `.jpeg`,
  `.png`, `.pdf` of `.xml` (e-factuur, UBL), tot 20 MB. De inhoud moet bij de extensie passen.
- Een bestand wordt opgepakt als grootte en wijzigingstijd drie seconden gelijk zijn gebleven; lege
  bestanden en namen die met `.` of `~` beginnen of op `.tmp`, `.part`, `.partial`, `.crdownload` of
  `.download` eindigen, slaat de pc over.
- Na verwerking verplaatst de pc het bestand naar de submap `verwerkt/`. Bestaat de naam daar al, dan
  wordt het `naam (2).jpg`. De pc verwijdert of overschrijft nooit iets.
- Hetzelfde bestand twee keer (zelfde inhoud) geeft één document: de pc herkent het aan de hash.
- Betaalwijze, notitie en locatie gaan langs deze weg niet mee.
- Een bestand uit de bonnenmap verandert de pc niet: het is een eigen bestand van de gebruiker, net als
  een bestand dat hij in de app sleept. Wat erin staat (ook een positie in de EXIF) blijft dus staan, in
  de map `verwerkt` en bij de bijlagen. In de database komt de positie alleen met locatie aan (#32).
