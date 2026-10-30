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

/**
 * Grenzen tegen kwaadaardig of per ongeluk enorme bestanden (ruim boven echte exports).
 * De XML wordt volledig geparsed (geen streaming); de heap is ruwweg een factor 5-10 van de XML-grootte,
 * dus 20 MB per entry en 60 MB in totaal houdt het geheugen in de orde van honderden MB. Echte
 * boekhoud-exports zijn enkele MB. Begrenzing tijdens het parsen (SAX/worker) is een mogelijke vervolgstap.
 */
const MAX_ENTRIES = 1000;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_ROWS = 100_000;
const MAX_COLS = 1000;
const MAX_SHEETS = 100;
/** Telt `<si>` en rich-text-run `<r>` samen. */
const MAX_SHARED_STRINGS = 200_000;
/**
 * Werkboekbreed aantal openende elementen (alle geparste XML-onderdelen samen, zoals het celbudget),
 * gecontroleerd vóór parse; vangrail naast de tellingen per elementsoort. Een cel is ~2 elementen
 * (`c` + `v`), dus een export van ~500.000 cellen (50.000 rijen x 10 kolommen) past nog net, terwijl
 * bv. 2M lege `<a/>` in sharedStrings vóór de parse wordt geweigerd. Worst case heap ruwweg 150 MB.
 */
const MAX_XML_ELEMENTS = 1_200_000;
/** Werkboekbreed aantal gealloceerde posities (rijen en cellen, gaten meegeteld, alle sheets samen). */
const MAX_CELLS = 2_000_000;
/**
 * Werkboekbreed aantal VERSCHILLENDE namen (elementen en attributen samen, volledig gekwalificeerd zoals in de XML; namen
 * met meer dan één dubbele punt worden geweigerd). De parser bewaart elke naam als
 * objecteigenschap; 1M verschillende namen kost al ~860 MB heap. Echte onderdelen gebruiken er tientallen tot honderden.
 */
const MAX_XML_NAMES = 2_000;
/** Werkboekbreed aantal attributen (cumulatief); een cel heeft er ~1-3. */
const MAX_XML_ATTRIBUTES = 3 * MAX_XML_ELEMENTS;
/** Attributen per element; OOXML-elementen hebben er hooguit enkele tientallen. Begrenst ook de parseropbouw van één element. */
const MAX_ATTRIBUTEN_PER_ELEMENT = 64;

/** Excel staat maximaal 32.767 tekens per cel toe. */
const MAX_CEL_TEKENS = 32_767;
/** Werkboekbreed totaal aantal tekens in cellen; een shared string telt per verwijzing. */
const MAX_TOTAAL_TEKENS = 64_000_000;

export interface XlsxLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxRows: number;
  maxCols: number;
  maxSheets: number;
  maxSharedStrings: number;
  maxCells: number;
  /** Tekens per celwaarde (inline of shared). */
  maxCellChars: number;
  /** Tekens in alle cellen samen; een shared string telt per verwijzing. */
  maxTotalChars: number;
  maxXmlElements: number;
  /** Aantal verschillende element- en attribuutnamen, werkboekbreed. */
  maxXmlNames: number;
  /** Aantal attributen, werkboekbreed. */
  maxXmlAttributes: number;
}

const DEFAULT_LIMITS: XlsxLimits = {
  maxEntries: MAX_ENTRIES,
  maxEntryBytes: MAX_ENTRY_BYTES,
  maxTotalBytes: MAX_TOTAL_BYTES,
  maxRows: MAX_ROWS,
  maxCols: MAX_COLS,
  maxSheets: MAX_SHEETS,
  maxSharedStrings: MAX_SHARED_STRINGS,
  maxCells: MAX_CELLS,
  maxCellChars: MAX_CEL_TEKENS,
  maxTotalChars: MAX_TOTAAL_TEKENS,
  maxXmlElements: MAX_XML_ELEMENTS,
  maxXmlNames: MAX_XML_NAMES,
  maxXmlAttributes: MAX_XML_ATTRIBUTES,
};

/** Herkenbare fout met een Nederlandse melding die direct aan de gebruiker getoond mag worden. */
export class XlsxFout extends Error {}

const TE_GROOT = 'Dit Excel-bestand is te groot of te sterk ingepakt om in te lezen';
const ONVEILIG = 'Dit Excel-bestand bevat onveilige XML en is niet ingelezen';
const TE_VEEL_CELLEN = 'Dit Excel-bestand heeft te veel rijen of kolommen om in te lezen';

/** De bestanden in een zip (alleen "stored" en "deflate", geen zip64). Uitpakken gebeurt pas bij gebruik. */
function unzip(data: Uint8Array, limits: XlsxLimits): (name: string) => Buffer | undefined {
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
  if (count > limits.maxEntries) throw new XlsxFout(TE_GROOT);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, { method: number; raw: Buffer; size: number }>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Dit Excel-bestand is beschadigd');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const uncompressed = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    entries.set(name, { method, raw: buf.subarray(start, start + size), size: uncompressed });
    p += 46 + nameLen + extraLen + commentLen;
  }
  let total = 0;
  return (name) => {
    const e = entries.get(name);
    if (!e || (e.method !== 0 && e.method !== 8)) return undefined;
    // Eerst de opgegeven grootte controleren, daarna het echte uitpakken begrenzen (die opgave kan liegen).
    if (e.size > limits.maxEntryBytes) throw new XlsxFout(TE_GROOT);
    let out: Buffer;
    if (e.method === 0) out = e.raw;
    else {
      try {
        out = inflateRawSync(e.raw, { maxOutputLength: limits.maxEntryBytes });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new XlsxFout(TE_GROOT);
        throw err;
      }
    }
    if (out.length > limits.maxEntryBytes) throw new XlsxFout(TE_GROOT);
    total += out.length;
    if (total > limits.maxTotalBytes) throw new XlsxFout(TE_GROOT);
    return out;
  };
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: false,
  // Commentaar en CDATA staan standaard uit (commentPropName/cdataPropName niet gezet: commentaar valt weg,
  // CDATA wordt tekst). Processing instructions worden vóór de parse geweigerd (zie `controleerPi`), want de
  // parser verwerkt hun attributen al vóór ignorePiTags; ignorePiTags blijft alleen over voor de toegestane declaratie.
  ignorePiTags: true,
  // Geen pad per element bijhouden: bij een zeer lange elementnaam kost het opnieuw opbouwen van het pad per kind kwadratisch veel tijd.
  // isArray gebruikt alleen de naam.
  jPath: false,
  isArray: (name) => ['si', 'r', 'row', 'c', 'sheet', 'Relationship'].includes(name),
});

const MAX_XML_DECLARATIE = 200;
/** Langste toegestane element- of attribuutnaam (inclusief prefix); echte xlsx-onderdelen gebruiken korte namen. */
const MAX_XML_NAAMLENGTE = 256;

/**
 * Weigert elke processing instruction behalve één korte XML-declaratie (`<?xml …?>`) helemaal aan het begin
 * (na een eventuele BOM). Echte xlsx-onderdelen bevatten geen andere PI's; de parser bouwt de attributen van
 * een PI op vóór hij die negeert, dus dat moet vóór parse. Ook `<?` in CDATA of commentaar wordt geweigerd (conservatief).
 */
function controleerPi(raw: string): void {
  let pi = raw.indexOf('<?');
  if (pi < 0) return;
  const begin = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
  const einde = raw.indexOf('?>', pi + 2);
  if (pi !== begin || !/^<\?xml[ \t\r\n]/.test(raw.slice(pi, pi + 6)) || einde < 0 || einde - pi > MAX_XML_DECLARATIE) throw new XlsxFout(ONVEILIG);
  pi = raw.indexOf('<?', einde + 2);
  if (pi >= 0) throw new XlsxFout(ONVEILIG);
}

/** Werkboekbrede telling van namen en attributen; gedeeld door alle onderdelen. */
interface XmlBudget {
  names: Set<string>;
  attrs: number;
  maxNames: number;
  maxAttrs: number;
  /** Ruwe tekens per tekstsegment (tussen `>` en `<`, ook witruimte); begrenst parseropbouw vóór parser.parse. */
  maxText: number;
}

const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isNameChar = (c: number) => isNameStart(c) || (c >= 48 && c <= 57) || c === 46 || c === 45;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
/** Positie van de dubbele punt in de laatst gelezen naam (of -1). */
let laatsteDubbelePunt = -1;

/** Einde van een naam vanaf `p` volgens `[prefix:]naam` (ASCII, begint met letter of `_`), of -1 als het geen geldige naam is. */
function naamEinde(xml: string, p: number): number {
  laatsteDubbelePunt = -1;
  const begin = p;
  for (let part = 0; part < 2; part++) {
    if (!isNameStart(xml.charCodeAt(p))) return -1;
    while (isNameChar(xml.charCodeAt(++p))) { /* lineair doorlopen */ }
    if (part === 0 && xml.charCodeAt(p) === 58) {
      laatsteDubbelePunt = p++;
      continue;
    }
    break;
  }
  if (p - begin > MAX_XML_NAAMLENGTE) throw new XlsxFout(ONVEILIG);
  return p;
}

/**
 * Telt vóór het parsen (en dus vóór objectopbouw) goedkoop de elementen in de XML-tekst: lineair, geen regex.
 * De scan is bewust STRIKT, zodat onze tokenizer niet kan afwijken van die van de parser: elke element- en
 * attribuutnaam is `[prefix:]naam` (ASCII, begint met letter of `_`, verder letters, cijfers, `_`, `.`, `-`);
 * na een elementnaam volgt alleen witruimte, `>` of `/>`; een attribuut is witruimte + naam + `=` + waarde in '…' of "…";
 * `/` staat alleen direct vóór de afsluitende `>`; een sluittag is `</naam>` (witruimte vóór `>` mag). Al het andere
 * geeft `over`. De parser gebruikt removeNSPrefix, dus `<x:si` telt als `si`. `<c` telt alleen exact als `c` (niet `<cols`).
 * Verschillende (volledige) namen en het aantal attributen komen in `budget`. Ook de lengte van elk ruw tekstsegment
 * (gerekend vanaf de laatste echte element-tag; commentaar, CDATA en PI's tellen cumulatief mee) is begrensd (`budget.maxText`), zodat een enorme tekst of witruimte de parser niet bereikt. Dezelfde grens geldt voor de ruwe lengte van één tag (`<` tot `>`).
 */
function countElements(xml: string, budget: XmlBudget): { tags: number; si: number; r: number; row: number; c: number; over: boolean } {
  const n = { tags: 0, si: 0, r: 0, row: 0, c: 0, over: false };
  const len = xml.length;
  const { names } = budget;
  const weiger = () => {
    n.over = true;
    return n;
  };
  let seg = 0; // begin van het huidige tekstsegment
  for (let i = xml.indexOf('<'); i >= 0; i = xml.indexOf('<', i + 1)) {
    if (i - seg > budget.maxText) return weiger();
    const first = xml.charCodeAt(i + 1);
    if (first === 47) {
      // Sluittag: </naam> met optionele witruimte vóór `>`.
      let k = naamEinde(xml, i + 2);
      if (k < 0) return weiger();
      while (isSpace(xml.charCodeAt(k))) k++;
      if (xml.charCodeAt(k) !== 62) return weiger();
      i = k;
      seg = i + 1;
      continue;
    }
    n.tags++; // ook <? en <! (commentaar, CDATA) tellen mee, zodat ze niet gratis zijn
    if (first === 63) continue; // PI: `seg` blijft ook hier staan
    if (first === 33) {
      // Commentaar en CDATA zijn één blok: de inhoud (met < > " ') wordt niet gescand. Elke andere `<!` of een ontbrekend einde: weigeren.
      const comment = xml.startsWith('<!--', i);
      if (!comment && !xml.startsWith('<![CDATA[', i)) return weiger();
      const end = xml.indexOf(comment ? '-->' : ']]>', i + 4);
      if (end < 0 || end - i > budget.maxText) return weiger();
      i = end + 2; // de volgende indexOf('<', i + 1) begint na het sluitteken; `seg` blijft: de parser voegt tekst over commentaar/CDATA heen samen
      continue;
    }
    let k = naamEinde(xml, i + 1);
    if (k < 0) return weiger();
    const start = laatsteDubbelePunt >= 0 ? laatsteDubbelePunt + 1 : i + 1;
    names.add(xml.slice(i + 1, k)); // volledige naam: elke parser-eigenschapnaam komt van een geteld verschil
    const a = xml.charCodeAt(start);
    switch (k - start) {
      case 1:
        if (a === 99) n.c++;
        else if (a === 114) n.r++;
        break;
      case 2:
        if (a === 115 && xml.charCodeAt(start + 1) === 105) n.si++;
        break;
      case 3:
        if (a === 114 && xml.charCodeAt(start + 1) === 111 && xml.charCodeAt(start + 2) === 119) n.row++;
        break;
    }
    // Attributen: elk begint met witruimte en heeft `=` en een waarde tussen aanhalingstekens.
    const attrNamen = new Set<string>();
    for (;;) {
      const ws = k;
      while (isSpace(xml.charCodeAt(k))) k++;
      const ch = xml.charCodeAt(k);
      if (ch === 62) break;
      if (ch === 47) {
        if (xml.charCodeAt(k + 1) !== 62) return weiger();
        k++;
        break;
      }
      if (k === ws) return weiger(); // geen witruimte voor het attribuut
      const nameEnd = naamEinde(xml, k);
      if (nameEnd < 0) return weiger();
      budget.attrs++;
      const attrNaam = xml.slice(k, nameEnd);
      // Dubbele naam of te veel attributen: weigeren vóór de parser er een enorm object van bouwt.
      if (attrNamen.size >= MAX_ATTRIBUTEN_PER_ELEMENT || attrNamen.has(attrNaam)) throw new XlsxFout(ONVEILIG);
      attrNamen.add(attrNaam);
      names.add(attrNaam);
      k = nameEnd;
      while (isSpace(xml.charCodeAt(k))) k++;
      if (xml.charCodeAt(k) !== 61) return weiger();
      k++;
      while (isSpace(xml.charCodeAt(k))) k++;
      const q = xml.charCodeAt(k);
      if (q !== 34 && q !== 39) return weiger();
      const end = xml.indexOf(q === 34 ? '"' : "'", k + 1);
      if (end < 0) return weiger();
      k = end + 1;
      if (names.size > budget.maxNames || budget.attrs > budget.maxAttrs) return weiger();
    }
    if (names.size > budget.maxNames || k >= len || k - i > budget.maxText) return weiger(); // ook de ruwe tag zelf (witruimte, waarden) is begrensd
    i = k; // verder na deze tag; `<` binnen waarden telt niet als element
    seg = i + 1;
  }
  if (len - seg > budget.maxText) return weiger();
  return n;
}

type X = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const text = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? String((v as X)['#text'] ?? '') : String(v));

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

export function readXlsx(data: Uint8Array, limits: Partial<XlsxLimits> = {}): Workbook {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const file = unzip(data, lim);
  let elements = 0; // cumulatief over alle geparste onderdelen
  const xmlBudget: XmlBudget = { names: new Set(), attrs: 0, maxNames: lim.maxXmlNames, maxAttrs: lim.maxXmlAttributes, maxText: lim.maxCellChars * 8 };
  const xml = (path: string): X | null => {
    const f = file(path);
    if (!f) return null;
    const raw = f.toString('utf8');
    // Komt in echte xlsx niet voor; voorkomt entity-expansie.
    if (/<!(DOCTYPE|ENTITY)/i.test(raw)) throw new XlsxFout(ONVEILIG);
    controleerPi(raw);
    const n = countElements(raw, xmlBudget);
    elements += n.tags;
    if (n.over || elements > lim.maxXmlElements || n.si + n.r > lim.maxSharedStrings) throw new XlsxFout(TE_GROOT);
    if (n.row > lim.maxRows || n.c > lim.maxCells) throw new XlsxFout(TE_VEEL_CELLEN);
    return parser.parse(raw) as X;
  };
  const si = (xml('xl/sharedStrings.xml')?.sst?.si ?? []) as X[];
  if (si.length > lim.maxSharedStrings) throw new XlsxFout(TE_GROOT);
  // Eénmaal trimmen: per celverwijzing opnieuw trimmen laat een lange string vaak herhalen (CPU-misbruik).
  const shared = si.map((e) => {
    const v = (e.t !== undefined ? text(e.t) : ((e.r ?? []) as X[]).map((r) => text(r.t)).join('')).trim();
    if (v.length > lim.maxCellChars) throw new XlsxFout(TE_GROOT);
    return v;
  });
  const rels = new Map((((xml('xl/_rels/workbook.xml.rels')?.Relationships?.Relationship ?? []) as X[]).map((r) => [String(r['@Id']), String(r['@Target'])])));
  const sheetList = (xml('xl/workbook.xml')?.workbook?.sheets?.sheet ?? []) as X[];
  if (sheetList.length > lim.maxSheets) throw new XlsxFout(TE_GROOT);
  let budget = lim.maxCells; // nog toegestane posities; altijd controleren vóór de allocatie
  const claim = (n: number) => {
    if (n > 0 && (budget -= n) < 0) throw new XlsxFout(TE_VEEL_CELLEN);
  };
  let tekens = lim.maxTotalChars; // resterend tekenbudget over alle cellen
  const sheets = sheetList.map((s) => {
    const target = rels.get(String(s['@id'] ?? s['@r:id'])) ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const rows: string[][] = [];
    const xmlRows = (xml(path)?.worksheet?.sheetData?.row ?? []) as X[];
    if (xmlRows.length > lim.maxRows) throw new XlsxFout(TE_VEEL_CELLEN);
    for (const row of xmlRows) {
      const given = Number(row['@r']);
      // Een ongeldig rijnummer (ontbreekt, NaN, 0, negatief) telt als volgnummer.
      const r = (Number.isInteger(given) && given >= 1 ? given : rows.length + 1) - 1;
      if (r >= lim.maxRows) throw new XlsxFout(TE_VEEL_CELLEN);
      const cells: string[] = [];
      for (const c of (row.c ?? []) as X[]) {
        const t = String(c['@t'] ?? '');
        const v = t === 's' ? shared[Number(text(c.v))] ?? '' : (t === 'inlineStr' ? text(c.is?.t) : text(c.v)).trim();
        if (v.length > lim.maxCellChars || (tekens -= v.length) < 0) throw new XlsxFout(TE_GROOT);
        const col = colIndex(String(c['@r'] ?? ''));
        if (!(col >= 0 && col < lim.maxCols)) throw new XlsxFout(TE_VEEL_CELLEN);
        claim(col + 1 - cells.length);
        cells[col] = v;
      }
      claim(r + 1 - rows.length);
      rows[r] = Array.from(cells, (x) => x ?? '');
    }
    return { name: String(s['@name'] ?? ''), rows: Array.from(rows, (x) => x ?? []) };
  });
  return { sheets, created: createdDate(file('docProps/core.xml')) };
}

/** "gemaakt op" uit core.xml: lineair (indexOf) en met grootte-limiet; een regex met backtracking is hier kwadratisch. */
function createdDate(f: Buffer | null | undefined): string | null {
  if (!f || f.length > 64 * 1024) return null;
  const raw = f.toString('utf8');
  const open = raw.indexOf('<dcterms:created');
  const start = open < 0 ? -1 : raw.indexOf('>', open);
  const end = start < 0 ? -1 : raw.indexOf('<', start + 1);
  return end > start + 1 ? raw.slice(start + 1, end) : null;
}
