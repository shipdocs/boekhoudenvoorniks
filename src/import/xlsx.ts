import { inflateRawSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';

/**
 * Minimale .xlsx-lezer (alleen lezen, alleen waarden): genoeg voor exports uit boekhoudprogramma's
 * zoals een kolommenbalans. Een .xlsx is een zip met XML; formules, opmaak en datums als getal laten we
 * voor wat ze zijn. Geen extra afhankelijkheid nodig.
 */

export interface Workbook {
  sheets: { name: string; rows: string[][] }[];
  /** "gemaakt op" uit de bestandseigenschappen (ISO), als die er is */
  created: string | null;
}

/** De bestanden in een zip (alleen "stored" en "deflate", geen zip64). */
function unzip(data: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Dit is geen Excel-bestand (.xlsx)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Dit Excel-bestand is beschadigd');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => ['si', 'r', 'row', 'c', 'sheet', 'Relationship'].includes(name),
});

type X = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const text = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? String((v as X)['#text'] ?? '') : String(v));

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

export function readXlsx(data: Uint8Array): Workbook {
  const files = unzip(data);
  const xml = (path: string): X | null => {
    const f = files.get(path);
    return f ? (parser.parse(f.toString('utf8')) as X) : null;
  };
  const shared = ((xml('xl/sharedStrings.xml')?.sst?.si ?? []) as X[]).map((si) => (si.t !== undefined ? text(si.t) : ((si.r ?? []) as X[]).map((r) => text(r.t)).join('')));
  const rels = new Map((((xml('xl/_rels/workbook.xml.rels')?.Relationships?.Relationship ?? []) as X[]).map((r) => [String(r['@Id']), String(r['@Target'])])));
  const sheets = ((xml('xl/workbook.xml')?.workbook?.sheets?.sheet ?? []) as X[]).map((s) => {
    const target = rels.get(String(s['@id'] ?? s['@r:id'])) ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const rows: string[][] = [];
    for (const row of (xml(path)?.worksheet?.sheetData?.row ?? []) as X[]) {
      const r = Number(row['@r'] ?? rows.length + 1) - 1;
      const cells: string[] = [];
      for (const c of (row.c ?? []) as X[]) {
        const t = String(c['@t'] ?? '');
        const v = t === 's' ? shared[Number(text(c.v))] ?? '' : t === 'inlineStr' ? text(c.is?.t) : text(c.v);
        cells[colIndex(String(c['@r'] ?? ''))] = v.trim();
      }
      rows[r] = Array.from(cells, (x) => x ?? '');
    }
    return { name: String(s['@name'] ?? ''), rows: Array.from(rows, (x) => x ?? []) };
  });
  const created = /<dcterms:created[^>]*>([^<]+)</.exec(files.get('docProps/core.xml')?.toString('utf8') ?? '')?.[1] ?? null;
  return { sheets, created };
}
