# Bonnenscanner: protocol tussen telefoon en pc

Dit document beschrijft precies hoe de scanner-app op de telefoon (issue #49) bonnen aflevert bij de
desktop-app (issue #48). Het is het contract: de app op de telefoon kan hiertegen gebouwd worden zonder
de code van de desktop te lezen. De uitvoerbare versie staat in `src/scanner/protocol.ts`; de tests in
`tests/bonnenscanner.test.ts` controleren het uitgewerkte voorbeeld onderaan byte voor byte.

Protocolversie: **1**.

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
groottes in `fotos` moeten samen precies de rest van het bericht vullen. De JSON is hooguit 16 KiB.
Velden die de pc niet kent, negeert hij.

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
| 400 | `ongeldig` | ja | ontsleuteld, maar de inhoud klopt niet (veld, grootte, geen JPEG) | niet opnieuw proberen; fout in de app |
| 403 | `klok` | ja | `tijd` buiten het venster; `pcTijd` staat erbij | klokverschil onthouden en opnieuw |
| 409 | `herhaald` | ja | deze nonce is al gebruikt | opnieuw met een nieuwe nonce |
| 409 | `id-botst` | ja | dit `id` hoort al bij een bon met een andere inhoud | niet opnieuw; de bon bewaren en melden |
| 413 | `te-groot` | ja | de foto's zijn samen groter dan 19 MiB | kleiner maken, of in twee bonnen |
| 500 | `opslaan-mislukt` | ja | de pc kon de bon niet wegschrijven | bon bewaren, later opnieuw |
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
`Content-Length`, envelop en apparaat-ID, ontsleutelen, inhoud, `tijd`, nonce, foto's, `id`.

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
- **Een gekoppelde telefoon kan alleen bonnen afleveren.** Er is geen bericht waarmee iets uit de
  administratie op te vragen is.

## Versies

Een onverenigbare wijziging krijgt een nieuw versienummer: byte 4 van de envelop, `v` in de QR-code en
`v` in het TXT-record. Een pc met versie 1 weigert een envelop met een andere versie (`ongeldig`,
onversleuteld). Nieuwe, optionele JSON-velden zijn geen nieuwe versie: de pc negeert wat hij niet kent.

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
