# OCR-benchmark

## Synthetische set (standaard)

Echte bonnen zijn privacygevoelig. Daarom maakt de app een **synthetische set**: Nederlandse
bonnen en facturen met bekende juiste waarden, reproduceerbaar met een seed.

- Soorten: bouwmarkten, tankstations, groothandels, telecom en webshops.
- Datumnotaties: `12-09-2026`, `12/09/26` en `12 september 2026`.
- Btw: 21% en 9%, ook gemengd.
- Verder: aantallen, kortingen, bonnen en A4-facturen.
- "Slechte foto"-effecten: scheef, wazig, weinig contrast, gekreukt, afgesneden.

```bash
# 200 documenten (jpg + json) maken
npm run benchmark:maak -- ./benchmark-synthetisch 200

# ingebouwde herkenning meten (llama.cpp + GLM-OCR)
llama-server -hf ggml-org/GLM-OCR-GGUF:Q8_0 --port 8080
npm run benchmark:ocr -- ./benchmark-synthetisch http://127.0.0.1:8080 llamacpp:glm-ocr

# of een eigen OCR-dienst volgens docs/ocr-sidecar.md
npm run benchmark:ocr -- ./benchmark-synthetisch http://127.0.0.1:8765 paddleocr-vl
```

De uitvoer geeft de nauwkeurigheid per veld (leverancier, datum, totaal, btw), de gemiddelde tijd
per document en per document de afwijkingen.

In de tests (`tests/benchmark-synthetisch.test.ts`) draait dezelfde set als basislijn met
"perfect gelezen" tekst. Die meet dus de parser, los van de OCR. De basislijn vond meteen een fout:
een kolom "21%" in de artikeltabel van een factuur werd als btw-regel gelezen.

**Beperking:** synthetisch is niet echt. Handschrift, vervaagde thermische bonnen en echte kreukels
worden benaderd, niet nagebootst. Gebruik de uitkomst om engines onderling te vergelijken.

## Eigen documenten

Werkt ook met echte documenten: per document een bestand (jpg/png/pdf/xml) en een gelijknamig
`.json`:

```json
{ "supplier": "Bouwmaat", "date": "2026-09-23", "total": 121.00, "vat": [{ "rate": 21, "amount": 21.00 }] }
```
