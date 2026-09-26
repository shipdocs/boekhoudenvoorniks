# Lokale OCR-sidecar (contract)

De app bevat zelf geen OCR-model. Tekstherkenning voor foto's en scans komt van een **lokale
OCR-dienst** die op dezelfde computer draait (alleen `localhost` is toegestaan; documenten
verlaten de computer niet). Welke engine erachter zit (GLM-OCR, PaddleOCR-VL, GRM-OCR, …) maakt
voor de app niet uit: alle engines leveren hetzelfde formaat, dat de app normaliseert naar één
`DocumentResult`.

Instellen: *Instellingen → Slimme herkenning → Lokale tekstherkenning*, bijvoorbeeld `http://127.0.0.1:8765`.

## Endpoints

`GET /health` → HTTP 200 als de dienst klaar is.

`POST /ocr`

```json
{ "mime_type": "image/jpeg", "filename": "bon.jpg", "data_base64": "…" }
```

Antwoord:

```json
{
  "pages": [{ "width": 1240, "height": 1754 }],
  "lines": [
    { "text": "BOUWMAAT UTRECHT", "page": 1, "bbox": [102, 88, 610, 130], "confidence": 0.99 },
    { "text": "Totaal 121,00", "page": 1, "bbox": [810, 1210, 1050, 1280], "confidence": 0.998 }
  ]
}
```

- `bbox` is `[x1, y1, x2, y2]` in pixels van de pagina, oorsprong linksboven. De app gebruikt dit om
  in het controlescherm het oorspronkelijke stukje document te markeren.
- `confidence` 0..1 per regel. De app combineert dit met andere signalen (validatie, bankmatch,
  leveranciersgeheugen) tot HIGH / MEDIUM / LOW.
- Een PDF zonder tekstlaag (scan) wordt als PDF gestuurd; de dienst rendert de pagina's zelf.
- Optioneel `items`: artikelregels, als de engine tabellen herkent. Bedragen in euro's (getal of
  tekst met punt als decimaalteken):

  ```json
  "items": [
    { "description": "Knauf Goldband 25 kg", "quantity": 4, "unit_price": 12.95, "amount": 51.80, "vat_rate": 21, "page": 1, "bbox": [100, 420, 1050, 450], "confidence": 0.97 }
  ]
  ```

  Zonder `items` haalt de app de regels zelf uit `lines`. Regels worden alleen gebruikt (bijvoorbeeld
  om een bon over categorieën te splitsen) als ze precies optellen tot het totaal of subtotaal.

## Pijplijn in de app

1. UBL/XML (e-factuur, of als bijlage in een PDF) → gestructureerd, zekerheid 1.0
2. PDF met tekstlaag → tekstparser (geen OCR)
3. Anders → deze OCR-dienst

OCR bepaalt alleen *wat er staat*. Classificatie (*wat is dit?*) en de boeking (*hoe boeken we
dit?*) gebeuren daarna, de boeking altijd met vaste regels in code.

## Benchmark

```bash
npm run build:main
node dist/main/tools/ocr-benchmark.js ./benchmark-documenten http://127.0.0.1:8765 glm-ocr
```

Zie de uitleg bovenin `src/tools/ocr-benchmark.ts` voor het formaat van de juiste waarden (`.json` per document).
