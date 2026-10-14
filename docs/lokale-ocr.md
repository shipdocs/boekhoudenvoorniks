# Ingebouwde tekstherkenning (GLM-OCR, lokaal)

Foto's van bonnetjes worden gelezen door **GLM-OCR**, een klein OCR-model (0,9 miljard parameters)
dat op je eigen computer draait via **llama.cpp**. Er gaat niets naar internet: de server luistert
alleen op `127.0.0.1`.

## Installeren: bij eerste gebruik

Het model zit niet in de installer, zodat die klein blijft. In *Instellingen → Slimme herkenning*
staat de knop **Slimme herkenning installeren**. Daarna downloadt de app:

| Onderdeel | Bron | Grootte | Controle |
|---|---|---|---|
| GLM-OCR Q8_0 | `huggingface.co/ggml-org/GLM-OCR-GGUF` | 950 MB | vaste sha256 in `src/ocr-runtime/manifest.ts` |
| Vision-projector (mmproj) Q8_0 | idem | 484 MB | vaste sha256 |
| llama.cpp `llama-server` (CPU-build voor jouw systeem) | GitHub-release van `ggml-org/llama.cpp` | ± 30 MB | sha256 uit de release (`digest`) |

- Een afgebroken download gaat verder waar hij was.
- Een bestand met een verkeerd controlegetal wordt weggegooid en niet gebruikt.
- Alles komt in de gegevensmap van de app (`ocr/`). Via **Verwijderen** is het in één klik weer weg.

## Versie uit de Microsoft Store

In de versie uit de Microsoft Store staat de ingebouwde herkenning standaard uit. Aanzetten kan pas
nadat de gebruiker er in een eigen venster uitdrukkelijk ja op zegt (Store-beleid 10.2.2: wat de app
downloadt en uitvoert, ligt vast en staat in de Store-beschrijving). Daarna geldt:

- De app haalt niet "de nieuwste" llama.cpp op, maar altijd één vaste build: `STORE_LLAMA_CPP` in
  `src/ocr-runtime/manifest.ts` (tag, bestand, grootte, sha256 van het zip-bestand en sha256 van
  `llama-server.exe`).
- `llama-server.exe` wordt na het uitpakken en vóór elke start tegen dat controlegetal gehouden; wijkt
  het af, dan start het niet.
- Een runtime die de gewone versie eerder in dezelfde gegevensmap zette, telt niet: eerst toestemming,
  dan de vaste build.
- De toestemming staat in `ocr/toestemming.json` en geldt voor die ene build. **Verwijderen** haalt hem weg.
- Lukt het niet, dan verwijst de foutmelding naar de gewone Windows-versie op GitHub.

De gewone Windows-versie en Linux werken zoals hierboven beschreven.

## Draaien

De server start pas bij de eerste foto en stopt na 10 minuten zonder foto's. Zo gebruikt hij geen
werkgeheugen als je hem niet nodig hebt. Hij draait op een vrije poort op 127.0.0.1, met temperatuur 0
(geen "creatieve" antwoorden) en de prompt `Text Recognition:` uit de modelkaart. De tekst die
terugkomt gaat door dezelfde parser, validatie en zekerheidsinschatting als elk ander document. OCR
bepaalt alleen *wat er staat*; boeken gebeurt altijd met vaste regels.

Eén leesverzoek (één foto) mag vier minuten duren; daarna breekt de app het af, stopt de server en
staat bij de bon dat het lezen te lang duurde. Bonnen van de telefoon en uit de bonnenmap staan meteen
in de inbox en worden daarna op de achtergrond gelezen, één tegelijk.

De server stopt als je het programma afsluit. Welk proces de app startte staat in `ocr/llama-server.pid`,
met het moment waarop dat proces begon en welk programma het startte. Draait dat proces bij een volgende
start nog (het programma is bijvoorbeeld hard afgebroken), dan stopt de app het alsnog, maar alleen als
alles klopt:

- het programma achter dat proces-ID is de `llama-server` uit de eigen `ocr/`-map;
- het proces begon precies op het moment dat is vastgelegd, zonder marge (een proces-ID wordt opnieuw
  uitgegeven, het begin niet);
- het proces is van dezelfde gebruiker;
- er bestaat geen proces meer met het proces-ID van het programma dat de server startte. Bestaat dat
  nog, dan gebeurt er niets.

Is een van deze dingen niet vast te stellen, dan gebeurt er niets.

**Hergebruikt proces-ID van de starter.** Is het programma dat de server startte weg, maar heeft een ander
programma intussen hetzelfde proces-ID gekregen (te zien aan een ander begin), dan stopt de app de server
bewust niet: liever een achterblijver laten staan dan de server van een programma dat nog draait stoppen op
een meetverschil. De achterblijver blijft dan draaien zolang dat andere programma draait. De app probeert
het opnieuw op twee momenten: bij het starten van het programma (niet als de administratie alleen-lezen open is), en telkens vlak voordat de ingebouwde
herkenning een server start (bij de eerste bon na het starten van het programma, of nadat de server gestopt was, bijvoorbeeld na tien minuten zonder bonnen).
Tussendoor is er geen periodieke controle. Na het opnieuw opstarten van de computer is de achterblijver weg.
Hoeveel achterblijvers er bij de laatste poging zijn blijven staan, staat in de status van de runtime
(`skippedLeftovers`); is dat meer dan nul, dan staat er bij Instellingen → Automatisch & herkenning, onder
"Foto's van bonnen laten lezen", één regel over. De server van een programma dat aantoonbaar nog draait
(zelfde proces-ID en zelfde begin) telt niet mee.

**Het stoppen zelf.** Vlak vóór het stoppen vraagt de app het proces nog een keer op. Stoppen gaat op
proces-ID; dat het proces-ID tussen die laatste controle en het stoppen opnieuw wordt uitgegeven, is niet
uit te sluiten:

- Linux: de controle leest `/proc` en het signaal volgt direct; het venster is de tijd tussen die twee
  stappen in het programma.
- macOS: de controle gaat via `ps`; het venster is de looptijd van `ps` nadat het het proces bekeek. Het
  begin van een proces is daar alleen in hele seconden bekend.
- Windows: het stoppen gaat met `taskkill /PID <pid> /F /FI "IMAGENAME eq llama-server.exe"`. Die opdracht
  kijkt op het moment van beëindigen zelf of het proces `llama-server.exe` heet en doet anders niets; de
  duur van de PowerShell-opvraag telt dus niet mee. Een andere `llama-server.exe` die precies dan hetzelfde
  proces-ID kreeg, wordt niet onderscheiden.

Het begin en de eigenaar komen op Linux
uit `/proc`, op macOS uit `ps` en op Windows uit PowerShell (`Win32_Process`). Een pid-bestand van een
eerdere versie (zonder het begin van het proces) wordt niet gebruikt. Opruimen en starten gebeuren na
elkaar, nooit door elkaar; stopt het programma terwijl de server nog aan het starten is, dan komt er
geen server meer bij.

Niet ondersteund door de ingebouwde herkenning, met een duidelijke melding:

- gescande PDF's zonder tekstlaag: maak een foto;
- HEIC: zet de iPhone-camera op "Meest compatibel" of gebruik jpg/png.

PDF's met tekst en e-facturen hebben geen OCR nodig.

## Hardware

- 64-bit Windows 10/11, macOS 12+ (Apple Silicon of Intel) of Linux x64.
- Minstens 4 GB werkgeheugen (8 GB aanbevolen) en 2 GB vrije schijfruimte.
- Een videokaart is niet nodig. Reken op ongeveer een minuut per foto (gemeten op een gewone pc met 8 kernen: 58 tot 73 seconden voor een kassabon); de bon staat er meteen en wordt op de achtergrond gelezen.

## Licenties

| Onderdeel | Licentie | Commercieel gebruik / verspreiden |
|---|---|---|
| GLM-OCR (zai-org) | MIT | ja |
| GGUF-conversie (ggml-org) | volgt het model (MIT) | ja |
| llama.cpp | MIT | ja |

De app zelf verspreidt deze bestanden niet (de gebruiker downloadt ze rechtstreeks van de bron).
Beide licenties staan het ook toe om ze mee te leveren, mocht dat later gewenst zijn. De volledige
GLM-OCR-pijplijn van zai-org gebruikt ook PP-DocLayoutV3 (Apache 2.0); die gebruiken wij niet.

## Eigen OCR-dienst

Wie een andere engine wil (PaddleOCR-VL, een GPU-server, …) kan in de geavanceerde instellingen een
eigen lokale dienst opgeven volgens [ocr-sidecar.md](ocr-sidecar.md).
