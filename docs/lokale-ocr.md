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

## Draaien

De server start pas bij de eerste foto en stopt na 10 minuten zonder foto's. Zo gebruikt hij geen
werkgeheugen als je hem niet nodig hebt. Hij draait op een vrije poort op 127.0.0.1, met temperatuur 0
(geen "creatieve" antwoorden) en de prompt `Text Recognition:` uit de modelkaart. De tekst die
terugkomt gaat door dezelfde parser, validatie en zekerheidsinschatting als elk ander document. OCR
bepaalt alleen *wat er staat*; boeken gebeurt altijd met vaste regels.

Niet ondersteund door de ingebouwde herkenning, met een duidelijke melding:

- gescande PDF's zonder tekstlaag: maak een foto;
- HEIC: zet de iPhone-camera op "Meest compatibel" of gebruik jpg/png.

PDF's met tekst en e-facturen hebben geen OCR nodig.

## Hardware

- 64-bit Windows 10/11, macOS 12+ (Apple Silicon of Intel) of Linux x64.
- Minstens 4 GB werkgeheugen (8 GB aanbevolen) en 2 GB vrije schijfruimte.
- Een videokaart is niet nodig. Op een gewone laptop duurt een bon enkele seconden tot een halve minuut.

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
