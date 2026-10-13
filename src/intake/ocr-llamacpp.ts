import type { FetchLike } from '../integrations/types';
import { ValidationError } from '../shared/validation';
import type { OcrOutput, OcrProvider } from './ocr';
import type { TextItem } from './types';
import { READ_CONNECTION_MESSAGE, READ_TIMEOUT_MESSAGE } from '../shared/reading';

/**
 * Hoe lang één leesverzoek (één foto) aan de ingebouwde herkenning mag duren. Daarna wordt het verzoek
 * afgebroken en krijgt de gebruiker een melding. Bewust korter dan de vijf minuten waarna fetch zelf
 * opgeeft (met alleen "fetch failed"), en ruim genoeg voor een grote foto op een computer zonder
 * snelle processor.
 */
export const OCR_REQUEST_TIMEOUT_MS = 4 * 60_000;

/** Het leesverzoek duurde langer dan de tijdslimiet en is afgebroken. */
export class OcrTimeoutError extends Error {
  constructor() {
    super(READ_TIMEOUT_MESSAGE);
    this.name = 'OcrTimeoutError';
  }
}

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
    private readonly timeoutMs = OCR_REQUEST_TIMEOUT_MS,
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
    // eigen tijdslimiet die het verzoek ook echt afbreekt; zonder zou fetch pas na vijf minuten opgeven
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.timeoutMs);
    let res: Awaited<ReturnType<FetchLike>>;
    let body: { choices?: { message?: { content?: string } }[] };
    try {
      res = await this.fetchImpl(this.url('/v1/chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abort.signal,
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
      body = res.ok ? ((await res.json()) as typeof body) : {};
    } catch {
      // afgebroken door de tijdslimiet, of de lokale server is weg: nooit de kale melding van fetch tonen
      if (timedOut) throw new OcrTimeoutError();
      throw new Error(READ_CONNECTION_MESSAGE);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`Slimme herkenning werkt nu niet (fout ${res.status}). Vul de gegevens zelf in.`);
    const content = body.choices?.[0]?.message?.content ?? '';
    return { items: textToItems(content) };
  }
}
