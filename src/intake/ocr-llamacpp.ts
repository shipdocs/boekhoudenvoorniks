import type { FetchLike } from '../integrations/types';
import { ValidationError } from '../shared/validation';
import type { OcrOutput, OcrProvider } from './ocr';
import type { TextItem } from './types';

/** Afbeeldingen die llama.cpp (stb_image) kan lezen. */
const SUPPORTED = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/gif'];

/**
 * Zet de tekst die een OCR-model teruggeeft (platte tekst of markdown, soms met tabellen of HTML)
 * om naar regels voor de tekstparser. Tabelcellen worden met spaties samengevoegd, zodat een
 * artikelregel "| Gipsplaat | 2 | 8,95 | 17,90 |" gewoon "Gipsplaat 2 8,95 17,90" wordt.
 */
export function textToItems(content: string, confidence = 0.85): TextItem[] {
  const text = content
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/<\/(tr|p|div|h\d|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
  const out: TextItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(raw)) continue; // markdown-tabelscheiding
    const line = raw
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/\*\*|__/g, '')
      .replace(/^\s*[-*]\s+/, '')
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (line) out.push({ text: line, page: 1, confidence });
  }
  return out;
}

/**
 * OCR via een lokale llama.cpp-server (OpenAI-compatibele chat-API) met een vision-OCR-model
 * zoals GLM-OCR. Geen posities (bbox) per regel: het controlescherm toont dan het hele document.
 */
export class LlamaCppOcrProvider implements OcrProvider {
  readonly label: string;
  constructor(
    readonly id: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike,
    private readonly prompt = 'Text Recognition:',
    label?: string,
  ) {
    const u = new URL(baseUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw new Error('Slimme herkenning moet op deze computer draaien (localhost)');
    this.label = label ?? `Ingebouwde herkenning (${id})`;
  }

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  async available(): Promise<boolean> {
    try {
      return (await this.fetchImpl(this.url('/health'), { method: 'GET' })).ok;
    } catch {
      return false;
    }
  }

  async recognize(input: { data: Uint8Array; mimeType: string; filename: string }): Promise<OcrOutput> {
    if (!SUPPORTED.includes(input.mimeType)) {
      throw new ValidationError(
        input.mimeType === 'application/pdf'
          ? 'Deze PDF is een scan zonder tekst. Maak een foto van het document (jpg of png), dan leest de ingebouwde herkenning hem wel.'
          : 'Dit soort afbeelding kan de ingebouwde herkenning niet lezen. Gebruik jpg of png (op een iPhone: Instellingen → Camera → Formaten → "Meest compatibel").',
      );
    }
    const res = await this.fetchImpl(this.url('/v1/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${input.mimeType};base64,${Buffer.from(input.data).toString('base64')}` } },
              { type: 'text', text: this.prompt },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 4096,
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`Slimme herkenning werkt nu niet (fout ${res.status}). Vul de gegevens zelf in.`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content ?? '';
    return { items: textToItems(content) };
  }
}
