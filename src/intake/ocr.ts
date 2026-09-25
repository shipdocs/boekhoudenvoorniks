import type { DocumentResult, TextItem } from './types';
import type { FetchLike } from '../integrations/types';

/**
 * Modulaire OCR. De rest van de app kent alleen dit contract; welk model erachter zit
 * (GLM-OCR, PaddleOCR-VL, GRM-OCR, …) is uitwisselbaar. Keuze volgt uit de benchmark (zie issue).
 */
export interface OcrOutput {
  items: TextItem[];
  pageSizes?: { width: number; height: number }[];
  /** Sommige modellen leveren direct gestructureerde velden; die worden dan genormaliseerd. */
  structured?: Partial<DocumentResult>;
}

export interface OcrProvider {
  readonly id: string;
  readonly label: string;
  available(): Promise<boolean>;
  recognize(input: { data: Uint8Array; mimeType: string; filename: string }): Promise<OcrOutput>;
}

/**
 * Generieke lokale OCR-sidecar via HTTP (bv. een lokaal draaiende GLM-OCR / PaddleOCR server).
 * Contract (docs/ocr-sidecar.md):
 *   POST {url}/ocr   { "mime_type": "...", "filename": "...", "data_base64": "..." }
 *   → { "pages": [{ "width": n, "height": n }], "lines": [{ "text": "...", "page": 1, "bbox": [x1,y1,x2,y2], "confidence": 0.98 }] }
 * Alleen localhost is toegestaan: documenten verlaten de computer niet.
 */
export class HttpOcrProvider implements OcrProvider {
  readonly label: string;
  constructor(
    readonly id: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike,
    label?: string,
  ) {
    const u = new URL(baseUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('OCR-sidecar moet lokaal draaien (localhost)');
    this.label = label ?? `Lokale OCR (${id})`;
  }

  async available(): Promise<boolean> {
    try {
      const r = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/health`, { method: 'GET' });
      return r.ok;
    } catch {
      return false;
    }
  }

  async recognize(input: { data: Uint8Array; mimeType: string; filename: string }): Promise<OcrOutput> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mime_type: input.mimeType, filename: input.filename, data_base64: Buffer.from(input.data).toString('base64') }),
    });
    if (!res.ok) throw new Error(`OCR mislukt (HTTP ${res.status})`);
    const body = (await res.json()) as { pages?: { width: number; height: number }[]; lines?: { text: string; page?: number; bbox?: [number, number, number, number]; confidence?: number }[] };
    return {
      pageSizes: body.pages,
      items: (body.lines ?? []).map((l) => ({ text: l.text, page: l.page ?? 1, bbox: l.bbox, confidence: l.confidence ?? 0.8 })),
    };
  }
}
