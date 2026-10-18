import { deflateRawSync } from 'node:zlib';

/** Een minimaal .xlsx (zip met XML) voor tests: tekst als inlineStr, getallen als getal. */
export function makeXlsx(sheets: { name: string; rows: (string | number | null)[][] }[], created?: string): Uint8Array {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const col = (i: number) => String.fromCharCode(65 + i);
  const files: [string, string][] = [
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['xl/workbook.xml', `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml" Type="x"/>`).join('')}</Relationships>`],
    ...sheets.map((s, i): [string, string] => [
      `xl/worksheets/sheet${i + 1}.xml`,
      `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${s.rows
        .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => (v === null ? '' : typeof v === 'number' ? `<c r="${col(c)}${r + 1}"><v>${v}</v></c>` : `<c r="${col(c)}${r + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`)).join('')}</row>`)
        .join('')}</sheetData></worksheet>`,
    ]),
  ];
  if (created) files.push(['docProps/core.xml', `<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dcterms="y"><dcterms:created>${created}</dcterms:created></cp:coreProperties>`]);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  files.forEach(([name, content], i) => {
    const raw = Buffer.from(content, 'utf8');
    const deflate = i % 2 === 1;
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    local.push(lh, nameBuf, data);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  });
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, cd, end]));
}

/** Kolommenbalans zoals DigiBoox hem als Excel geeft (verzonnen bedragen). */
export function kolommenbalans(year = 2026): Uint8Array {
  const r = (name: string, ...n: number[]): (string | number | null)[] => [null, name, ...n];
  return makeXlsx(
    [
      { name: 'Winst- en verliesrekening', rows: [[], [null, 'Klusbedrijf Test']] },
      {
        name: 'Kolommenbalans',
        rows: [
          [],
          [null, 'Klusbedrijf Test'],
          [null, 'Kolommenbalans'],
          [null, `01-01-${year} - 31-12-${year}`],
          [],
          [null, '', 'Beginbalans', '', 'Mutaties', '', '', '', '', 'Eindbalans', ''],
          [null, 'Categorie', 'Debet', 'Credit', 'Debet', 'Credit', 'Debet', 'Credit', 'Mutaties', 'Debet', 'Credit'],
          r('0100 Bestelbus', 5000, 0, 0, 0, 0, 0, 0, 5000, 0),
          r('0110 Afschrijving bestelbus', 0, 2000, 0, 100, 0, 0, -100, 0, 2100),
          r('0720 Winstreserves', 0, 2000, 0, 700, 0, 0, -700, 0, 2700),
          r('1000 Privé-stortingen en -opnames', 0, 500, 0, 200, 0, 0, -200, 0, 700),
          r('1002 Bank Knab', 1500, 0, 1700, 2000, 0, 0, -300, 1200, 0),
          r('1005 Mollie', 0, 0, 100, 100, 0, 0, 0, 0, 0),
          r('1400 Crediteuren', 0, 1000, 300, 250, 0, 0, 50, 0, 950),
          r('1800 Te betalen btw', 0, 400, 0, 0, 0, 0, 0, 0, 400),
          r('1802 Te vorderen btw', 300, 0, 0, 0, 0, 0, 0, 300, 0),
          r('2000 Kruisposten / Spaartransactie', 0, 900, 1000, 0, 0, 0, 1000, 100, 0),
          r('2010 Vraagposten', 0, 0, 250, 0, 0, 0, 250, 250, 0),
          r('4401 Hosting', 0, 0, 0, 0, 400, 0, 400, 400, 0),
          r('4412 Bankkosten', 0, 0, 0, 0, 50, 0, 50, 50, 0),
          r('4500 Afschrijvingen', 0, 0, 0, 0, 100, 0, 100, 100, 0),
          r('7200 Gereedschap klein', 0, 0, 0, 0, 250, 0, 250, 250, 0),
          r('8000 Omzet', 0, 0, 0, 0, 0, 1500, -1500, 0, 1500),
          r('9999 Overboekingsrekening winst', 0, 0, 0, 0, 700, 0, 700, 700, 0),
        ],
      },
    ],
    `${year}-09-27T17:01:39Z`,
  );
}
