import type { TextItem } from './types';


export interface PdfExtraction {
  items: TextItem[];
  pageSizes: { width: number; height: number }[];
  attachments: { filename: string; content: Uint8Array }[];
  textLength: number;
}

/** Leest de tekstlaag (met posities) en bijlagen uit een PDF. Geen OCR. */
export async function extractPdf(data: Uint8Array, maxPages = 5): Promise<PdfExtraction> {
  // pdfjs-dist is ESM-only; tsconfig.main gebruikt module Node16 zodat dit een echte import() blijft
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(data), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const items: TextItem[] = [];
    const pageSizes: { width: number; height: number }[] = [];
    for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      pageSizes.push({ width: viewport.width, height: viewport.height });
      const content = await page.getTextContent();
      for (const it of content.items as { str: string; transform: number[]; width: number; height: number }[]) {
        if (!it.str?.trim()) continue;
        const x = it.transform[4]!;
        const h = it.height || Math.abs(it.transform[3]!) || 10;
        const top = viewport.height - it.transform[5]! - h;
        items.push({ text: it.str, page: p, bbox: [x, top, x + it.width, top + h], confidence: 1 });
      }
    }
    const rawAttachments = ((await doc.getAttachments()) ?? {}) as Record<string, { filename: string; content: Uint8Array }>;
    const attachments = Object.values(rawAttachments).map((a) => ({ filename: a.filename, content: a.content }));
    return { items, pageSizes, attachments, textLength: items.reduce((s, i) => s + i.text.trim().length, 0) };
  } finally {
    await task.destroy();
  }
}
