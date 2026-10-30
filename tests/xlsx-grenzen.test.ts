import { deflateRawSync } from 'node:zlib';
import { XMLParser } from 'fast-xml-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readXlsx } from '../src/import/xlsx';
import { isTrialBalance } from '../src/import/trial-balance';
import { makeXlsx } from './fixtures/xlsx';
import { setup } from './helpers';

type Entry = { name: string; data: Buffer; declared?: number; stored?: boolean };

/** Minimale zip-schrijver: alle entries gedeflate, met een optioneel opgegeven (valse) uitgepakte grootte. */
function zip(files: Entry[]): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const method = f.stored ? 0 : 8;
    const packed = f.stored ? f.data : deflateRawSync(f.data);
    const name = Buffer.from(f.name);
    const declared = f.declared ?? f.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(packed.length, 18);
    lh.writeUInt32LE(declared, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(packed.length, 20);
    ch.writeUInt32LE(declared, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    local.push(lh, name, packed);
    central.push(ch, name);
    offset += 30 + name.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, cd, end]));
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
/** `sheetCount` > 1: alle sheets wijzen naar hetzelfde pad (herhaald sheetpad). */
const basis = (sheetData: string, extra: Entry[] = [], sheetCount = 1) =>
  zip([
    { name: 'xl/workbook.xml', data: Buffer.from(`<workbook ${NS} xmlns:r="x"><sheets>${Array.from({ length: sheetCount }, (_, i) => `<sheet name="Blad${i}" r:id="rId1"/>`).join('')}</sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<Relationships xmlns="y"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(`<worksheet ${NS}><sheetData>${sheetData}</sheetData></worksheet>`) },
    ...extra,
  ]);
const cel = (ref: string, v: string) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;

describe('xlsx-lezer: grenzen', () => {
  it('leest een gewoon klein bestand', () => {
    const wb = readXlsx(basis(`<row r="1">${cel('A1', 'a')}${cel('C1', 'c')}</row><row r="100">${cel('B100', 'x')}</row>`));
    expect(wb.sheets[0]!.rows[0]).toEqual(['a', '', 'c']);
    expect(wb.sheets[0]!.rows[99]).toEqual(['', 'x']);
    expect(wb.sheets[0]!.rows).toHaveLength(100);
  });

  it('behandelt een ongeldig rijnummer als volgnummer', () => {
    const wb = readXlsx(basis(`<row r="0">${cel('A1', 'a')}</row><row r="abc">${cel('A2', 'b')}</row>`));
    expect(wb.sheets[0]!.rows).toEqual([['a'], ['b']]);
  });

  it('weigert een rijnummer ver buiten de grens, zonder gigantische array', () => {
    expect(() => readXlsx(basis(`<row r="10000000">${cel('A1', 'x')}</row>`))).toThrow(/te veel rijen of kolommen/);
  });

  it('weigert een kolom ver buiten de grens', () => {
    expect(() => readXlsx(basis(`<row r="1">${cel('ZZZZ1', 'x')}</row>`))).toThrow(/te veel rijen of kolommen/);
    expect(() => readXlsx(basis(`<row r="1">${cel('ZZZZZZZZZZ1', 'x')}</row>`))).toThrow(/te veel rijen of kolommen/);
  });

  it('weigert een zip-bom: klein ingepakt, te groot uitgepakt', () => {
    const bom = Buffer.alloc(3 * 1024 * 1024); // nullen, comprimeert tot enkele KB
    const data = basis('', [{ name: 'xl/sharedStrings.xml', data: bom }]);
    expect(data.length).toBeLessThan(20_000);
    expect(() => readXlsx(data, { maxEntryBytes: 1024 * 1024 })).toThrow(/te groot of te sterk ingepakt/);
  });

  it('weigert een entry die in de opgegeven grootte liegt', () => {
    const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.alloc(2 * 1024 * 1024), declared: 10 }]);
    expect(() => readXlsx(data, { maxEntryBytes: 1024 * 1024 })).toThrow(/te groot of te sterk ingepakt/);
  });

  it('weigert een te grote opgegeven uitgepakte grootte', () => {
    const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from('<sst/>'), declared: 0xffffffff }]);
    expect(() => readXlsx(data)).toThrow(/te groot of te sterk ingepakt/);
  });

  it('weigert te veel uitgepakte bytes in totaal', () => {
    const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.alloc(600 * 1024) }]);
    expect(() => readXlsx(data, { maxTotalBytes: 500 * 1024 })).toThrow(/te groot of te sterk ingepakt/);
  });

  it('weigert te veel entries', () => {
    const extra = Array.from({ length: 20 }, (_, i) => ({ name: `rommel/${i}.txt`, data: Buffer.from('x') }));
    expect(() => readXlsx(basis('', extra), { maxEntries: 10 })).toThrow(/te groot of te sterk ingepakt/);
  });

  it('pakt entries die niet gebruikt worden niet uit', () => {
    const bom = Buffer.alloc(3 * 1024 * 1024);
    const wb = readXlsx(basis(`<row r="1">${cel('A1', 'ok')}</row>`, [{ name: 'media/groot.bin', data: bom, declared: 10 }]), { maxEntryBytes: 1024 * 1024 });
    expect(wb.sheets[0]!.rows).toEqual([['ok']]);
  });

  it('weigert een stored entry (methode 0) met een liegende grootte', () => {
    const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.alloc(2 * 1024 * 1024, 32), declared: 10, stored: true }]);
    expect(() => readXlsx(data, { maxEntryBytes: 1024 * 1024 })).toThrow(/te groot of te sterk ingepakt/);
  });

  it('telt uitgepakte bytes cumulatief over meerdere entries (totaalgrens)', () => {
    const half = Buffer.from(`<sst>${'<a/>'.repeat(100 * 1024)}</sst>`);
    const data = basis('', [
      { name: 'xl/sharedStrings.xml', data: half },
      { name: 'docProps/core.xml', data: half },
    ]);
    expect(() => readXlsx(data, { maxEntryBytes: 500 * 1024, maxTotalBytes: 600 * 1024 })).toThrow(/te groot of te sterk ingepakt/);
    expect(() => readXlsx(data, { maxEntryBytes: 500 * 1024, maxTotalBytes: 2 * 1024 * 1024 })).not.toThrow();
  });

  it('heeft een werkboekbreed budget: herhaalde sheetpaden met een hoge rij', () => {
    const data = basis('<row r="1000"/>', [], 5);
    expect(() => readXlsx(data, { maxCells: 4000 })).toThrow(/te veel rijen of kolommen/);
    expect(readXlsx(data, { maxCells: 6000 }).sheets).toHaveLength(5);
  });

  it('heeft een budget voor rijen met alleen een verre kolom', () => {
    const rows = Array.from({ length: 50 }, (_, i) => `<row r="${i + 1}">${cel(`ZZ${i + 1}`, 'x')}</row>`).join('');
    expect(() => readXlsx(basis(rows), { maxCells: 10_000 })).toThrow(/te veel rijen of kolommen/);
    expect(readXlsx(basis(rows), { maxCells: 100_000 }).sheets[0]!.rows).toHaveLength(50);
  });

  it('weigert te veel shared strings', () => {
    const sst = `<sst ${NS}>${'<si><t>a</t></si>'.repeat(50)}</sst>`;
    const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sst) }]);
    expect(() => readXlsx(data, { maxSharedStrings: 40 })).toThrow(/te groot of te sterk ingepakt/);
    expect(() => readXlsx(data, { maxSharedStrings: 50 })).not.toThrow();
  });

  it('weigert te veel sheets', () => {
    expect(() => readXlsx(basis('', [], 8), { maxSheets: 5 })).toThrow(/te groot of te sterk ingepakt/);
  });

  it('weigert te veel row-elementen in een sheet', () => {
    const rows = Array.from({ length: 30 }, () => `<row r="1"/>`).join('');
    expect(() => readXlsx(basis(rows), { maxRows: 20 })).toThrow(/te veel rijen of kolommen/);
  });

  it('behandelt rijen zonder r-attribuut als volgnummer', () => {
    const wb = readXlsx(basis(`<row>${cel('A1', 'a')}</row><row>${cel('B2', 'b')}</row>`));
    expect(wb.sheets[0]!.rows).toEqual([['a'], ['', 'b']]);
  });

  it('weigert een extreem lange kolomletterreeks zonder te hangen', () => {
    const t0 = Date.now();
    expect(() => readXlsx(basis(`<row r="1">${cel('A'.repeat(100_000) + '1', 'x')}</row>`))).toThrow(/te veel rijen of kolommen/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  describe('vóór objectopbouw', () => {
    afterEach(() => vi.restoreAllMocks());

    const sstMet = (inhoud: string) => basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(inhoud) }]);
    const decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const attrs = Array.from({ length: 1000 }, (_, i) => `a${i}=""`).join(' ');
    it.each([
      ['veel PI\'s', `<sst ${NS}>${Array.from({ length: 5000 }, (_, i) => `<?a${i}?>`).join('')}</sst>`],
      ['één PI met veel attributen', `<sst ${NS}><?a ${attrs}?></sst>`],
      ['PI aan het begin met veel attributen', `<?a ${attrs}?><sst ${NS}/>`],
      ['PI midden in het document', `${decl}<sst ${NS}><?a b?></sst>`],
      ['overlange declaratie', `<?xml version="1.0" ${'x'.repeat(200)}="1"?><sst ${NS}/>`],
      ['onafgesloten declaratie', `<?xml version="1.0"<sst ${NS}/>`],
    ])('weigert %s vóór parser.parse', (_naam, inhoud) => {
      const parse = vi.spyOn(XMLParser.prototype, 'parse');
      const data = sstMet(inhoud);
      parse.mockClear();
      expect(() => readXlsx(data)).toThrow(/onveilige XML/);
      expect(parse).not.toHaveBeenCalled();
    });

    it('weigert veel commentaar en CDATA vóór parser.parse (geteld als element)', () => {
      const parse = vi.spyOn(XMLParser.prototype, 'parse');
      const sst = `<sst ${NS}>${'<!--c--><![CDATA[x]]>'.repeat(2000)}</sst>`;
      const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sst) }]);
      parse.mockClear();
      expect(() => readXlsx(data, { maxXmlElements: 1000 })).toThrow(/te groot of te sterk ingepakt/);
      expect(parse).not.toHaveBeenCalled();
    });

    it.each(['<!DOCTYPE sst [<!ENTITY a "b">]>', '<!ENTITY a "b">'])('weigert %s vóór parser.parse', (decl) => {
      const parse = vi.spyOn(XMLParser.prototype, 'parse');
      const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(`${decl}<sst ${NS}><si><t>&a;</t></si></sst>`) }]);
      parse.mockClear();
      expect(() => readXlsx(data)).toThrow(/onveilige XML/);
      expect(parse).not.toHaveBeenCalled();
    });

    it('leest een gewone <?xml …?>-declaratie (ook met BOM) nog steeds', () => {
      const d = `${decl}\n`;
      const sst = `${d}<sst ${NS}><si><t>hoi</t></si></sst>`;
      const sheet = `\uFEFF${d}<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`;
      const wb = readXlsx(basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sst) }, { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) }]));
      expect(wb.sheets[0]!.rows).toEqual([['hoi']]);
    });

    it('weigert met standaardlimieten 1.000.000 <si> snel en vóór parser.parse', () => {
      const parse = vi.spyOn(XMLParser.prototype, 'parse');
      const sst = `<sst ${NS}>${'<si><t>x</t></si>'.repeat(1_000_000)}</sst>`;
      const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sst) }]);
      expect(data.length).toBeLessThan(100_000);
      parse.mockClear();
      const t0 = Date.now();
      expect(() => readXlsx(data)).toThrow(/te groot of te sterk ingepakt/);
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(parse).not.toHaveBeenCalled();
    });

    it('weigert met standaardlimieten 2.000.000 lege <a/> in sharedStrings vóór parser.parse', () => {
      const parse = vi.spyOn(XMLParser.prototype, 'parse');
      const sst = `<sst ${NS}>${'<a/>'.repeat(2_000_000)}</sst>`;
      const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sst) }]);
      expect(data.length).toBeLessThan(100_000);
      parse.mockClear();
      expect(() => readXlsx(data)).toThrow(/te groot of te sterk ingepakt/);
      expect(parse).not.toHaveBeenCalled();
    });

    it('maakt het elementbudget cumulatief over meerdere XML-onderdelen', () => {
      const rij = '<row r="1"/>'.repeat(10);
      expect(() => readXlsx(basis(rij, [], 1), { maxXmlElements: 40 })).not.toThrow();
      // elk sheet-onderdeel blijft apart onder de grens, samen niet
      expect(() => readXlsx(basis(rij, [], 4), { maxXmlElements: 40 })).toThrow(/te groot of te sterk ingepakt/);
    });

    it('telt geprefixte x:si, x:row en x:c ook vóór parser.parse', () => {
      const parse = vi.spyOn(XMLParser.prototype, 'parse');
      const sst = (n: number) => Buffer.from(`<x:sst xmlns:x="${NS.slice(7, -1)}">${'<x:si><t>x</t></x:si>'.repeat(n)}</x:sst>`);
      parse.mockClear();
      expect(() => readXlsx(basis('', [{ name: 'xl/sharedStrings.xml', data: sst(250_000) }]))).toThrow(/te groot of te sterk ingepakt/);
      expect(() => readXlsx(basis('<x:row r="1"/>'.repeat(110_000)))).toThrow(/te veel rijen of kolommen/);
      expect(() => readXlsx(basis(`<x:row r="1">${'<x:c/>'.repeat(2_000)}</x:row>`), { maxCells: 1_000 })).toThrow(/te veel rijen of kolommen/);
      expect(parse.mock.calls.every(([x]) => !String(x).includes('<sheetData>') && !String(x).includes('x:si'))).toBe(true);
    });

    it('telt rich-text-fragmenten <r> mee: één <si> met 1.000.000 runs wordt geweigerd vóór parser.parse', () => {
      const parse = vi.spyOn(XMLParser.prototype, 'parse');
      const sst = `<sst ${NS}><si>${'<r><t>x</t></r>'.repeat(1_000_000)}</si></sst>`;
      const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sst) }]);
      parse.mockClear();
      expect(() => readXlsx(data)).toThrow(/te groot of te sterk ingepakt/);
      expect(parse).not.toHaveBeenCalled();
      // si en r samen onder één grens
      const mix = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst ${NS}>${'<si><r><t>x</t></r></si>'.repeat(30)}</sst>`) }]);
      expect(() => readXlsx(mix, { maxSharedStrings: 50 })).toThrow(/te groot of te sterk ingepakt/);
      expect(() => readXlsx(mix, { maxSharedStrings: 60 })).not.toThrow();
    });

    it('weigert met standaardlimieten 1,1M verschillende elementnamen vóór parser.parse', () => {
      const parse = vi.spyOn(XMLParser.prototype, 'parse');
      const sst = `<sst ${NS}>${Array.from({ length: 1_100_000 }, (_, i) => `<a${i}/>`).join('')}</sst>`;
      const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sst) }]);
      parse.mockClear();
      expect(() => readXlsx(data)).toThrow(/te groot of te sterk ingepakt/);
      expect(parse).not.toHaveBeenCalled();
    });

    it('weigert met standaardlimieten 1,1M verschillende attribuutnamen vóór parser.parse', () => {
      const parse = vi.spyOn(XMLParser.prototype, 'parse');
      // elementen van 50 attributen (onder de limiet per element), samen 1,1M verschillende namen
      const sst = `<sst ${NS}>${Array.from({ length: 22_000 }, (_, e) => `<x ${Array.from({ length: 50 }, (_, i) => `a${e * 50 + i}=""`).join(' ')}/>`).join('')}</sst>`;
      const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sst) }]);
      parse.mockClear();
      expect(() => readXlsx(data)).toThrow(/te groot of te sterk ingepakt/);
      expect(parse).not.toHaveBeenCalled();
    });

    it('weigert heel veel (gelijke) attributen (kleinere limiet, anders >20 MB) vóór parser.parse', () => {
      const parse = vi.spyOn(XMLParser.prototype, 'parse');
      const sst = `<sst ${NS}>${'<a a="" b="" c="" d="" e=""/>'.repeat(200_000)}</sst>`;
      const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sst) }]);
      parse.mockClear();
      expect(() => readXlsx(data, { maxXmlAttributes: 500_000 })).toThrow(/te groot of te sterk ingepakt/);
      expect(parse).not.toHaveBeenCalled();
    });

    it('weigert een enorm tekstsegment (witruimte buiten celwaarden) met standaardlimieten vóór parser.parse', () => {
      const parse = vi.spyOn(XMLParser.prototype, 'parse');
      const sst = `<sst ${NS}><si><t>${' '.repeat(19 * 1024 * 1024)}x</t></si></sst>`;
      const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sst) }]);
      parse.mockClear();
      expect(() => readXlsx(data)).toThrow(/te groot of te sterk ingepakt/);
      expect(parse.mock.calls.every(([x]) => !String(x).includes('<sst'))).toBe(true);
      const buiten = `<sst ${NS}><si><t>a</t></si>${' '.repeat(300_000)}</sst>`;
      expect(() => readXlsx(basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(buiten) }]))).toThrow(/te groot of te sterk ingepakt/);
    });

    it('weigert een enorme tag (witruimte binnen de tag) met standaardlimieten vóór parser.parse', () => {
      const parse = vi.spyOn(XMLParser.prototype, 'parse');
      const groot = 19 * 1024 * 1024;
      const payloads = [
        '<sst' + '\t'.repeat(groot) + '/>',
        '<sst' + ' \n'.repeat(groot / 2) + '/>',
        `<sst a${' '.repeat(groot)}=${'\n'.repeat(10)}"1"/>`,
        `<sst a=${' '.repeat(groot)}"1"/>`,
      ];
      for (const sst of payloads) {
        const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sst) }]);
        parse.mockClear();
        expect(() => readXlsx(data)).toThrow(/te groot of te sterk ingepakt/);
        expect(parse.mock.calls.every(([x]) => !String(x).includes('<sst'))).toBe(true);
      }
      const attrs = Array.from({ length: 60 }, (_, i) => `a${i}="${i}"`).join(' ');
      const ok = `<sst ${NS} ${attrs}><si><t>a</t></si></sst>`;
      expect(() => readXlsx(basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(ok) }]))).not.toThrow();
    });

    it('telt tekst over commentaar, CDATA en processing instructions heen cumulatief (standaardlimieten)', () => {
      const parse = vi.spyOn(XMLParser.prototype, 'parse');
      const stuk = ' '.repeat(250_000); // elk stuk blijft onder de limiet, samen niet
      // een PI midden in het bestand wordt al eerder als onveilige XML geweigerd (zie weigerProcessingInstructions); dat blijft zo
      for (const [tussen, fout] of [['<!--x-->', /te groot of te sterk ingepakt/], ['<![CDATA[ ]]>', /te groot of te sterk ingepakt/], ['<?x y?>', /onveilige XML/]] as const) {
        const sst = `<sst ${NS}><si><t>${Array(20).fill(stuk).join(tussen)}</t></si></sst>`;
        const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sst) }]);
        parse.mockClear();
        expect(() => readXlsx(data)).toThrow(fout);
        expect(parse.mock.calls.every(([x]) => !String(x).includes('<sst'))).toBe(true);
      }
      // normaal commentaar tussen elementen blijft werken
      const ok = `<sst ${NS}><!-- a --><si><t>a</t></si><!-- b --><si><t><![CDATA[b]]></t></si></sst>`;
      expect(() => readXlsx(basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(ok) }]))).not.toThrow();
    });

    it('laat een cel van 32.767 tekens met entities nog toe', () => {
      const lang = '&amp;'.repeat(32_767); // 32.767 tekens, 163.835 ruwe tekens
      const sst = `<sst ${NS}><si><t>${lang}</t></si></sst>`;
      const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sst) }]);
      expect(() => readXlsx(data)).not.toThrow();
    });

    it('weigert namen met meer dan één dubbele punt vóór parser.parse', () => {
      const parse = vi.spyOn(XMLParser.prototype, 'parse');
      const probeer = (inhoud: string) => {
        const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst ${NS}>${inhoud}</sst>`) }]);
        parse.mockClear();
        expect(() => readXlsx(data)).toThrow(/te groot of te sterk ingepakt/);
        expect(parse.mock.calls.every(([x]) => !String(x).includes('<sst'))).toBe(true);
      };
      probeer('<x:a123:z/>');
      probeer('<si a:b:c="1"/>');
      // een enkel prefix blijft toegestaan
      expect(() => readXlsx(basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(`<x:sst xmlns:x="y" x:a="1"><x:si><x:t>ok</x:t></x:si></x:sst>`) }]))).not.toThrow();
    });

    it('telt de volledige gekwalificeerde naam: gelijke lokale namen met verschillende prefixen tellen apart', () => {
      const rij = Array.from({ length: 20 }, (_, i) => `<p${i}:a/>`).join('');
      const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst ${NS}>${rij}</sst>`) }]);
      expect(() => readXlsx(data, { maxXmlNames: 100 })).not.toThrow();
      expect(() => readXlsx(data, { maxXmlNames: 20 })).toThrow(/te groot of te sterk ingepakt/);
    });

    it('weigert een zeer lange elementnaam gevolgd door veel kinderen, snel en als onveilig', () => {
      const data = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst ${NS}><${'N'.repeat(1_000_000)}>${'<b/>'.repeat(500_000)}</${'N'.repeat(1_000_000)}></sst>`) }]);
      const t0 = Date.now();
      expect(() => readXlsx(data)).toThrow(/onveilige XML/);
      expect(Date.now() - t0).toBeLessThan(2000);
      // ook een lange attribuutnaam, en een naam precies op de grens
      const attr = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst ${NS} ${'a'.repeat(257)}="1"/>`) }]);
      expect(() => readXlsx(attr)).toThrow(/onveilige XML/);
      const grens = basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst ${NS} ${'a'.repeat(256)}="1"/>`) }]);
      expect(() => readXlsx(grens)).not.toThrow();
    });

    it('begrenst het aantal attributen per element en weigert dubbele attribuutnamen (vóór de parser)', () => {
      const sst = (el: string) => basis('', [{ name: 'xl/sharedStrings.xml', data: Buffer.from(el) }]);
      // reproductie in klein: veel attributen op één element (standaardlimieten)
      expect(() => readXlsx(sst('<sst' + ' a=""'.repeat(65) + '/>'))).toThrow(/onveilige XML/);
      expect(() => readXlsx(sst('<sst' + Array.from({ length: 65 }, (_, i) => ` a${i}=""`).join('') + '/>'))).toThrow(/onveilige XML/);
      expect(() => readXlsx(sst('<sst' + ' a=""'.repeat(30_000) + '/>'))).toThrow(/onveilige XML/);
      // dubbele attribuutnaam in één element
      expect(() => readXlsx(sst(`<sst ${NS} a="1" a="2"/>`))).toThrow(/onveilige XML/);
      // normaal element met veel (<= 64) verschillende attributen werkt; dezelfde naam in een ander element mag
      const veel = Array.from({ length: 64 }, (_, i) => ` a${i}="1"`).join('');
      expect(() => readXlsx(sst(`<sst ${NS}${Array.from({ length: 63 }, (_, i) => ` a${i}="1"`).join('')}><x a0="1"/><x a0="1"/></sst>`))).not.toThrow();
      expect(() => readXlsx(sst(`<sst${veel}/>`))).not.toThrow();
    });

    it('telt attributen en namen werkboekbreed, met instelbare limieten', () => {
      const rij = '<row r="1" ht="1" x="2"/>'.repeat(10); // 30 attributen, 4 namen (+ sheet-onderdelen)
      expect(() => readXlsx(basis(rij), { maxXmlAttributes: 100 })).not.toThrow();
      expect(() => readXlsx(basis(rij), { maxXmlAttributes: 20 })).toThrow(/te groot of te sterk ingepakt/);
      expect(() => readXlsx(basis(rij, [], 4), { maxXmlAttributes: 100 })).toThrow(/te groot of te sterk ingepakt/);
      expect(() => readXlsx(basis(rij), { maxXmlNames: 30 })).not.toThrow();
      expect(() => readXlsx(basis(rij), { maxXmlNames: 5 })).toThrow(/te groot of te sterk ingepakt/);
    });

    it('telt een = of > of < binnen een attribuutwaarde niet mee', () => {
      const rij = `<row r="1" v1="a=b e='f' &gt; x>y" v2='a=b c="d" &gt; x>y'/>`;
      const data = basis(rij.repeat(10));
      // 3 attributen per rij = 30, plus 4 in workbook.xml, 3 in de rels en 1 xmlns in het werkblad = 38
      expect(() => readXlsx(data, { maxXmlAttributes: 38 })).not.toThrow();
      expect(() => readXlsx(data, { maxXmlAttributes: 37 })).toThrow(/te groot of te sterk ingepakt/);
      // ... en de namen uit de waarden (a, c, e) tellen niet als naam: ruim onder de grens
      expect(() => readXlsx(data, { maxXmlNames: 20 })).not.toThrow();
      // een tag met > in een waarde loopt door: het attribuut erna telt wel
      expect(() => readXlsx(basis('<row r="1" v=">" w="2"/>'.repeat(10)), { maxXmlAttributes: 30 })).toThrow(/te groot of te sterk ingepakt/);
      expect(() => readXlsx(basis('<row r="1" v=">" w="2"/>'.repeat(10)), { maxXmlAttributes: 60 })).not.toThrow();
    });

    it('weigert aanhalingstekens in commentaar of CDATA die tellingen proberen te omzeilen', () => {
      const els = Array.from({ length: 300 }, (_, i) => `<a${i}/>`).join('');
      const sst = (inhoud: string): Entry[] => [{ name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst ${NS}>${inhoud}</sst>`) }];
      const commentaar = sst(`<!-- <a x=" -->${els}<!-- " > -->`);
      const cdata = sst(`<![CDATA[<a x="]]>${els}<![CDATA[" >]]>`);
      for (const extra of [commentaar, cdata]) {
        expect(() => readXlsx(basis('', extra), { maxXmlElements: 100 })).toThrow(/te groot of te sterk ingepakt/);
        expect(() => readXlsx(basis('', extra), { maxXmlNames: 50 })).toThrow(/te groot of te sterk ingepakt/);
      }
      // niet-afgesloten waarde, commentaar, CDATA en andere <!-constructies
      expect(() => readXlsx(basis('<row r="1" v="x/>'))).toThrow(/te groot of te sterk ingepakt/);
      expect(() => readXlsx(basis('<!-- open'))).toThrow(/te groot of te sterk ingepakt/);
      expect(() => readXlsx(basis('<![CDATA[ open'))).toThrow(/te groot of te sterk ingepakt/);
      expect(() => readXlsx(basis('<!FOO x>'))).toThrow(/te groot of te sterk ingepakt/);
    });

    it('leest gewoon commentaar en CDATA met < > en " erin', () => {
      const extra: Entry[] = [{ name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst ${NS}><!-- a < b > "c" 'd' --><si><t><![CDATA[x < y > "z"]]></t></si></sst>`) }];
      const wb = readXlsx(basis(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`, extra));
      expect(wb.sheets[0]!.rows[0]).toEqual(['x < y > "z"']);
    });

    it('telt een herhaald sheetpad elke keer opnieuw tegen het totale bytebudget', () => {
      const data = basis(`<row r="1">${cel('A1', 'x'.repeat(2000))}</row>`, [], 5);
      expect(() => readXlsx(data, { maxTotalBytes: 6000 })).toThrow(/te groot of te sterk ingepakt/);
      expect(readXlsx(data, { maxTotalBytes: 100_000 }).sheets).toHaveLength(5);
    });

    it('weigert te veel cellen en te veel XML-elementen vóór parser.parse', () => {
      const parse = vi.spyOn(XMLParser.prototype, 'parse');
      const cellen = Array.from({ length: 50 }, (_, i) => `<c r="A${i + 1}"/>`).join('');
      expect(() => readXlsx(basis(`<row r="1">${cellen}</row>`), { maxCells: 40 })).toThrow(/te veel rijen of kolommen/);
      expect(() => readXlsx(basis('<row r="1"/>'.repeat(50)), { maxXmlElements: 40 })).toThrow(/te groot of te sterk ingepakt/);
      expect(() => readXlsx(basis('<row r="1"/>'.repeat(30)), { maxRows: 20 })).toThrow(/te veel rijen of kolommen/);
      // workbook.xml, rels en sheet zijn de enige entries; alleen de eerste twee mogen geparsed zijn
      expect(parse.mock.calls.every(([x]) => !String(x).includes('<sheetData>'))).toBe(true);
    });

    it('telt <cols>, <col>, <cfRule>, <rowBreaks> en <sst> niet als cel of rij', () => {
      const wb = readXlsx(
        zip([
          { name: 'xl/workbook.xml', data: Buffer.from(`<workbook ${NS} xmlns:r="x"><sheets><sheet name="B" r:id="rId1"/></sheets></workbook>`) },
          { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<Relationships xmlns="y"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>') },
          {
            name: 'xl/worksheets/sheet1.xml',
            data: Buffer.from(`<worksheet ${NS}><cols>${'<col min="1" max="1"/>'.repeat(10)}</cols><sheetData><row r="1">${cel('A1', 'ok')}</row></sheetData><conditionalFormatting><cfRule type="x"/><cfRule type="y"/></conditionalFormatting><rowBreaks count="0"/></worksheet>`),
          },
        ]),
        { maxRows: 1, maxCells: 2 },
      );
      expect(wb.sheets[0]!.rows).toEqual([['ok']]);
    });

    it('leest een realistische export van 20.000 rijen x 8 kolommen met shared strings', () => {
      const n = 20_000;
      const strings = Array.from({ length: 500 }, (_, i) => `<si><t>Rekening ${i}</t></si>`).join('');
      const kol = 'ABCDEFGH';
      const rows = Array.from({ length: n }, (_, i) => `<row r="${i + 1}">${[...kol].map((k, j) => (j < 3 ? `<c r="${k}${i + 1}" t="s"><v>${(i + j) % 500}</v></c>` : `<c r="${k}${i + 1}"><v>${i * j}</v></c>`)).join('')}</row>`).join('');
      const wb = readXlsx(basis(rows, [{ name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst ${NS}>${strings}</sst>`) }]));
      expect(wb.sheets[0]!.rows).toHaveLength(n);
      expect(wb.sheets[0]!.rows[19_999]).toEqual(['Rekening 499', 'Rekening 0', 'Rekening 1', '59997', '79996', '99995', '119994', '139993']);
    });
  });

  it('trimt een herhaald verwezen shared string één keer (geen CPU-misbruik) met hetzelfde resultaat', () => {
    const n = 1000;
    const lang = ' '.repeat(16_000);
    const rij = Array.from({ length: n }, (_, i) => `<c r="${colNaam(i)}1" t="s"><v>0</v></c>`).join('');
    const data = basis(`<row r="1">${rij}</row>`, [{ name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst ${NS}><si><t xml:space="preserve">${lang}x${lang}</t></si></sst>`) }]);
    const trim = vi.spyOn(String.prototype, 'trim');
    const wb = readXlsx(data);
    const aantalLang = trim.mock.contexts.filter((c) => String(c).length > 10_000).length;
    expect(aantalLang).toBeLessThanOrEqual(5); // zonder fix: één per celverwijzing (1000)
    expect(wb.sheets[0]!.rows[0]).toHaveLength(n);
    expect(new Set(wb.sheets[0]!.rows[0])).toEqual(new Set(['x']));
  });
});

describe('xlsx-lezer: metadata', () => {
  it('leest de aanmaakdatum uit core.xml', () => {
    const core = '<cp:coreProperties xmlns:dcterms="d"><dcterms:created xsi:type="dcterms:W3CDTF">2026-03-01T10:00:00Z</dcterms:created></cp:coreProperties>';
    expect(readXlsx(basis('', [{ name: 'docProps/core.xml', data: Buffer.from(core) }])).created).toBe('2026-03-01T10:00:00Z');
  });

  it('verwerkt herhaalde onafgesloten metadata-tags in lineaire tijd', () => {
    const data = basis('', [{ name: 'docProps/core.xml', data: Buffer.from('<dcterms:created'.repeat(20_000)) }]);
    const t0 = performance.now();
    const wb = readXlsx(data);
    expect(performance.now() - t0).toBeLessThan(500); // zonder fix: ~4 s (kwadratisch)
    expect(wb.created).toBeNull();
  });
});

describe('xlsx via het analysepad: sparse sheets en tabelbudget', () => {
  it('bouwt geen tabel van lege tussenrijen: A1, ALL1 en A100000', () => {
    const { s } = setup();
    const data = basis(`<row r="1">${cel('A1', 'Rekening')}${cel('ALL1', 'Saldo')}</row><row r="100000">${cel('A100000', '1000')}</row>`);
    const t0 = performance.now();
    const r = s.xafImport.analyzeFile(data);
    expect(performance.now() - t0).toBeLessThan(2000); // zonder fix: ~100 miljoen posities
    expect(r.kind).toBe('saldibalans');
  });

  it('weigert netjes als rijen x breedte het budget overschrijdt', () => {
    const { s } = setup();
    const rijen = Array.from({ length: 3000 }, (_, i) => `<row r="${i + 2}">${cel(`A${i + 2}`, String(i + 1))}${cel(`B${i + 2}`, 'x')}</row>`).join('');
    const data = basis(`<row r="1">${cel('A1', 'Rekening')}${cel('B1', 'Saldo')}${cel('ALL1', 'Z')}</row>${rijen}`);
    expect(() => s.xafImport.analyzeFile(data)).toThrow('te veel rijen of kolommen');
  });
});

/** A..Z, AA.. (kolomletters voor de test) */
function colNaam(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

describe('tabelbudget over het hele bestand', () => {
  const FACTUREN = 14_000;
  const kop = ['Naam', 'Soort', 'Factuurnummer', 'Datum', 'Vervaldatum', 'Bedrag'];
  const factuur = (i: number) => [`Klant ${i % 50}`, 'klant', `2025-${String(i).padStart(5, '0')}`, '15-12-2025', '29-12-2025', `${100 + (i % 900)},00`];

  const overstapper = () => {
    const ctx = setup();
    ctx.s.switchover.setMode('overstapper', '2026-01-01');
    return ctx;
  };

  it('accepteert een gewone factuurlijst van 14.000 regels x 6 kolommen als CSV', () => {
    const { s } = overstapper();
    const csv = [kop, ...Array.from({ length: FACTUREN }, (_, i) => factuur(i))].map((r) => r.join(';')).join('\r\n');
    const r = s.xafImport.analyzeFile(csv);
    expect(r.kind).toBe('openstaande-posten');
  });

  it('accepteert dezelfde lijst als xlsx', () => {
    const { s } = overstapper();
    const rijen = [kop, ...Array.from({ length: FACTUREN }, (_, i) => factuur(i))];
    const data = makeXlsx([{ name: 'Facturen', rows: rijen }]);
    const r = s.xafImport.analyzeFile(data);
    expect(r.kind).toBe('openstaande-posten');
  });

  it('wijst 100 bladen naar hetzelfde sheetpad netjes af, met een begrensd aantal toegewezen rijen', () => {
    const { s } = setup();
    // per blad 1 miljoen posities (1000 rijen x 1000 kolommen): binnen een per-blad-budget, maar 100 bladen samen 100 miljoen
    const rijen = Array.from({ length: 1000 }, (_, i) => `<row r="${i + 2}">${cel(`A${i + 2}`, `n${i}`)}${cel(`B${i + 2}`, 'x')}</row>`).join('');
    const data = basis(`<row r="1">${cel('A1', 'Rekening')}${cel('B1', 'Saldo')}${cel('ALL1', 'Z')}</row>${rijen}`, [], 100);
    const van = vi.spyOn(Array, 'from');
    expect(() => s.xafImport.analyzeFile(data)).toThrow('te veel rijen of kolommen');
    const breed = van.mock.calls.filter((c) => (c[0] as { length?: number })?.length === 1000).length;
    // gedeeld budget: 2 miljoen / 1000 kolommen = 2000 tabelrijen, plus 100 kopregels uit de lezer; zonder fix ~100.000
    expect(breed).toBeLessThanOrEqual(2100);
  });

  it('begrenst de lengte van kopcellen: één shared string van 32.767 tekens in 1.000 kopcellen geeft geen RangeError', () => {
    const { s } = setup();
    const lang = `Rekening Saldo ${'x'.repeat(32_767 - 15)}`;
    const sst = `<sst ${NS}><si><t>${lang}</t></si></sst>`;
    const kop = Array.from({ length: 1000 }, (_, i) => `<c r="${colNaam(i)}1" t="s"><v>0</v></c>`).join('');
    const data = basis(`<row r="1">${kop}</row><row r="2">${cel('A2', '1000')}</row>`, [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sst) }]);
    const join = vi.spyOn(Array.prototype, 'join');
    let fout: unknown;
    try {
      s.xafImport.analyzeFile(data);
    } catch (e) {
      fout = e;
    }
    const langste = Math.max(0, ...join.mock.results.map((r) => (typeof r.value === 'string' ? r.value.length : 0)));
    join.mockRestore();
    expect(fout).not.toBeInstanceOf(RangeError);
    // 1.000 kopcellen x 200 tekens (+ scheidingstekens); zonder begrenzing ruim een miljard
    expect(langste).toBeLessThanOrEqual(1000 * 210);
  });

  const sstMet = (len: number) => [{ name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst ${NS}><si><t>${'x'.repeat(len)}</t></si></sst>`) }];
  const verwijzingen = (n: number) => Array.from({ length: n }, (_, i) => `<c r="${colNaam(i)}1" t="s"><v>0</v></c>`).join('');

  it('weigert een shared string langer dan 32.767 tekens, en een inline celwaarde ook', () => {
    expect(() => readXlsx(basis(`<row r="1">${verwijzingen(1)}</row>`, sstMet(32_768)))).toThrow('te groot');
    expect(() => readXlsx(basis(`<row r="1">${cel('A1', 'x'.repeat(32_768))}</row>`))).toThrow('te groot');
    expect(readXlsx(basis(`<row r="1">${cel('A1', 'x'.repeat(32_767))}</row>`)).sheets[0]!.rows[0]![0]).toHaveLength(32_767);
  });

  it('houdt een shared string van 32.767 tekens in 1.000 kopcellen binnen het tekenbudget, snel en netjes', () => {
    const { s } = setup();
    const data = basis(`<row r="1">${verwijzingen(1000)}</row><row r="2">${cel('A2', '1000')}</row>`, sstMet(32_767));
    const t0 = Date.now();
    let fout: unknown;
    try {
      s.xafImport.analyzeFile(data);
    } catch (e) {
      fout = e;
    }
    expect(fout).not.toBeInstanceOf(RangeError);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('houdt Debet/Credit-paren met lange groepsnamen (32.767 tekens) netjes af en herkent de kolommenbalans', () => {
    const lang = (kop: string) => kop + 'x'.repeat(32_767 - kop.length);
    const sst = `<sst ${NS}><si><t>${lang('Beginbalans')}</t></si><si><t>${lang('Eindbalans')}</t></si><si><t>Debet</t></si><si><t>Credit</t></si></sst>`;
    const sc = (ref: string, i: number) => `<c r="${ref}" t="s"><v>${i}</v></c>`;
    const groepen = Array.from({ length: 100 }, (_, i) => sc(`${colNaam(2 * i + 1)}1`, i % 2)).join('');
    const kop = Array.from({ length: 100 }, (_, i) => sc(`${colNaam(2 * i + 1)}2`, 2) + sc(`${colNaam(2 * i + 2)}2`, 3)).join('');
    const data = basis(`<row r="1">${groepen}</row><row r="2">${kop}</row><row r="3">${cel('A3', '0100 Kas')}</row>`, [{ name: 'xl/sharedStrings.xml', data: Buffer.from(sst) }]);
    const t0 = Date.now();
    expect(isTrialBalance(readXlsx(data))).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('weigert netjes als een shared string zo vaak verwezen wordt dat het tekenbudget overschreden wordt', () => {
    // 30.000 tekens x 1.000 verwijzingen = 30 miljoen: past; met een limiet van 20 miljoen niet
    const data = basis(`<row r="1">${verwijzingen(1000)}</row>`, sstMet(30_000));
    expect(readXlsx(data).sheets[0]!.rows[0]).toHaveLength(1000);
    expect(() => readXlsx(data, { maxTotalChars: 20_000_000 })).toThrow('te groot');
    // 4 rijen x 1.000 verwijzingen x 30.000 = 120 miljoen: boven het standaardbudget
    const veel = Array.from({ length: 4 }, (_, k) => `<row r="${k + 1}">${verwijzingen(1000)}</row>`).join('');
    const { s } = setup();
    expect(() => s.xafImport.analyzeFile(basis(veel, sstMet(30_000)))).toThrow('te groot');
  });
});
