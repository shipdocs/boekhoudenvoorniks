import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { protocolOnderwerpen, protocolVoorbeelden } from './fixtures/protocol';

// Optionele controle: de vaste testgegevens in tests/fixtures/protocol/ tegen de volledige technische beschrijving
// van het protocol. Ze draait alleen als de omgevingsvariabele BVN_PROTOCOL_DOC naar dat bestand wijst:
//
//   BVN_PROTOCOL_DOC=<pad naar de volledige technische beschrijving> npx vitest run tests/protocol-document.test.ts
//
// Zonder de variabele wordt ze overgeslagen; de gewone tests hebben het document niet nodig.
const pad = process.env.BVN_PROTOCOL_DOC ?? '';
const aan = pad !== '';
const leesbaar = aan && existsSync(pad) && statSync(pad).isFile();
// op Windows kan het bestand met \r\n uitgecheckt zijn
const doc = leesbaar ? readFileSync(pad, 'utf8').replace(/\r\n/g, '\n') : '';
const blokken = (taal: string) => [...doc.matchAll(/```([a-z]*)\n([\s\S]*?)```/g)].filter((m) => m[1] === taal).map((m) => m[2]!.trim());

describe('protocol: de testgegevens en de volledige technische beschrijving (overgeslagen zonder BVN_PROTOCOL_DOC)', () => {
  it.skipIf(!aan)('BVN_PROTOCOL_DOC wijst naar een bestaand bestand', () => {
    expect(leesbaar, `BVN_PROTOCOL_DOC wijst niet naar een bestand: ${pad}`).toBe(true);
  });

  it.skipIf(!aan)('er zijn testgegevens voor elk onderwerp', () => {
    expect(protocolOnderwerpen()).toEqual(['bedrijf', 'bon', 'foto', 'projecten', 'stamgegevens-vervolg', 'versie-1', 'versie-2']);
  });

  for (const onderwerp of protocolOnderwerpen()) {
    it.skipIf(!aan)(`${onderwerp}: elk testgegeven staat letterlijk in het document`, () => {
      const voorbeelden = Object.entries(protocolVoorbeelden(onderwerp));
      expect(voorbeelden.length).toBeGreaterThan(0);
      for (const [sleutel, tekst] of voorbeelden) expect(doc.includes(tekst), `${onderwerp}.txt, ${sleutel}`).toBe(true);
    });
  }

  // Andersom: een voorbeeldbericht dat in het document staat en niet in de testgegevens, wordt door geen test
  // gecontroleerd. De json-blokken zijn de berichten van versie 1, de tekstblokken met JSON die van versie 2.
  it.skipIf(!aan)('elk json-blok van het document staat in de testgegevens van versie 1, in dezelfde volgorde', () => {
    expect(blokken('json')).toEqual(Object.values(protocolVoorbeelden('versie-1')).filter((tekst) => tekst.startsWith('{')));
  });

  it.skipIf(!aan)('elk tekstblok met JSON van het document staat in de testgegevens van versie 2, in dezelfde volgorde', () => {
    expect(blokken('text').filter((tekst) => tekst.startsWith('{'))).toEqual(Object.values(protocolVoorbeelden('versie-2')));
  });

  it.skipIf(!aan)('de vervallen zin over het IBAN van de administratie staat niet meer in het document', () => {
    expect(doc).not.toContain('het IBAN van de administratie zelf niet');
  });
});
