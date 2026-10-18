import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { createApi, type HostContext } from '../src/main/api';
import { directionIssue, directions, oneSided, parseCsv, previewCsv } from '../src/import/csv';

/**
 * Af en bij in een CSV-bankexport (#407): een gebruiker las een bestand in waarin alle regels als "bij"
 * binnenkwamen, en zag dat pas na het inlezen. De app herkent nu meer manieren om af en bij op te schrijven,
 * en laat vóór het inlezen zien hoeveel regels af en bij zijn.
 */
const amounts = (text: string) => {
  const preview = previewCsv(text);
  return parseCsv(text, preview.suggestedMapping!).transactions.map((t) => t.amount);
};

describe('af en bij herkennen', () => {
  it('Af/Bij met Af en Bij (zoals ING)', () => {
    expect(amounts('Datum;Bedrag;Af/Bij;Omschrijving\n01-10-2026;10,00;Af;x\n02-10-2026;20,00;Bij;y\n')).toEqual([-1000, 2000]);
  });
  it('Af/Bij met Afschrijving en Bijschrijving', () => {
    expect(amounts('Datum;Bedrag;Af/Bij;Omschrijving\n01-10-2026;10,00;Afschrijving;x\n02-10-2026;20,00;Bijschrijving;y\n')).toEqual([-1000, 2000]);
  });
  it('een kolom "Type" met Debit en Credit: herkend aan de waarden', () => {
    const text = 'Datum;Bedrag;Type;Omschrijving\n01-10-2026;10,00;Debit;x\n02-10-2026;20,00;Credit;y\n';
    expect(previewCsv(text).suggestedMapping!.debitCredit).toBe('Type');
    expect(amounts(text)).toEqual([-1000, 2000]);
  });
  it('een kolom "Richting" met Uitgaand en Inkomend', () => {
    expect(amounts('Datum;Bedrag;Richting;Omschrijving\n01-10-2026;10,00;Uitgaand;x\n02-10-2026;20,00;Inkomend;y\n')).toEqual([-1000, 2000]);
  });
  it('een kolom met andere waarden (bv. de soort betaling) is geen af/bij-kolom', () => {
    const text = 'Datum;Bedrag;Type;Omschrijving\n01-10-2026;-10,00;Overboeking;x\n02-10-2026;20,00;Incasso;y\n';
    expect(previewCsv(text).suggestedMapping!.debitCredit).toBeUndefined();
    expect(amounts(text)).toEqual([-1000, 2000]);
  });
  it('een onbekende waarde in de af/bij-kolom: het teken uit de bedragkolom blijft staan', () => {
    const text = 'Datum;Bedrag;Af/Bij;Omschrijving\n01-10-2026;-10,00;?;x\n02-10-2026;20,00;Bij;y\n';
    expect(amounts(text)).toEqual([-1000, 2000]);
  });
});

describe('alles één kant op', () => {
  it('telt af, bij en nul en ziet een bestand dat één kant op gaat', () => {
    expect(directions([{ amount: -1 }, { amount: 2 }, { amount: 0 }])).toEqual({ af: 1, bij: 1, nul: 1 });
    expect(oneSided({ af: 0, bij: 5, nul: 0 })).toBe('bij');
    expect(oneSided({ af: 3, bij: 0, nul: 1 })).toBe('af');
    expect(oneSided({ af: 3, bij: 1, nul: 0 })).toBeNull();
    // één regel zegt niets
    expect(oneSided({ af: 0, bij: 1, nul: 0 })).toBeNull();
  });

  it('alleen afschrijvingen met een goede af/bij-kolom is gewoon een rustige week: geen vraag', async () => {
    const { s, db } = setup();
    const api = createApi(s, { appVersion: () => 'test' } as unknown as HostContext);
    // Knab-indeling, drie keer "D": de app kent het formaat en vraagt niets
    const knab = 'Rekeningnummer;Transactiedatum;Valutacode;CreditDebet;Bedrag;Tegenrekeningnummer;Tegenrekeninghouder;Omschrijving;Betalingskenmerk\nNL91ABNA0417164300;08-09-2026;EUR;D;15,00;;KPN;Mobiel;\nNL91ABNA0417164300;15-09-2026;EUR;D;600,00;;;Verzamelbetaling;\nNL91ABNA0417164300;18-09-2026;EUR;D;20,00;;Gamma;Verf;\n';
    const p = await api.bank.previewFile('knab.csv', knab);
    expect(p.csv?.detectedBank).toBe('Knab');
    expect(p.direction).toEqual({ af: 3, bij: 0, nul: 0 });
    expect(p.issue).toBeNull();
    expect(p.oneSided).toBeNull();
    // een bedragkolom met minteken en geen af/bij-kolom: het teken komt uit het bestand
    expect(directionIssue('Datum;Bedrag;Omschrijving\n01-10-2026;-10,00;x\n02-10-2026;-20,00;y\n', { date: 'Datum', amount: 'Bedrag', dateFormat: 'DD-MM-YYYY', description: [] })).toBeNull();
    // wel een aanwijzing: een niet-gekozen kolom die alleen af en bij bevat
    expect(directionIssue('Datum;Bedrag;Soort;Omschrijving\n01-10-2026;10,00;Af;x\n02-10-2026;20,00;Bij;y\n', { date: 'Datum', amount: 'Bedrag', dateFormat: 'DD-MM-YYYY', description: [] })).toMatch(/"Soort".*niet gekozen/);
    // en: de gekozen kolom bevat waarden die de app niet kent
    expect(directionIssue('Datum;Bedrag;Soort;Omschrijving\n01-10-2026;10,00;Afgeschreven;x\n02-10-2026;20,00;Bij;y\n', { date: 'Datum', amount: 'Bedrag', debitCredit: 'Soort', dateFormat: 'DD-MM-YYYY', description: [] })).toMatch(/"Soort" bevat ook waarden.*"Afgeschreven"/);
    db.close();
  });

  it('previewFile zegt het vóór het inlezen bij een CSV die de app al kent', async () => {
    const { s, db } = setup();
    const api = createApi(s, { appVersion: () => 'test' } as unknown as HostContext);
    // de gebruiker wees de kolommen eerder aan, maar de af/bij-kolom staat verkeerd (op de omschrijving)
    const text = 'Datum;Bedrag;Soort;Omschrijving\n01-10-2026;10,00;Afschrijving;x\n02-10-2026;20,00;Bijschrijving;y\n03-10-2026;5,00;Afschrijving;z\n';
    const first = await api.bank.previewFile('bank.csv', text);
    expect(first.format).toBe('csv');
    expect(first.savedMapping).toBeNull();
    expect(first.direction).toBeNull();
    await api.bank.importFile('bank.csv', text, { date: 'Datum', amount: 'Bedrag', debitCredit: 'Omschrijving', dateFormat: 'DD-MM-YYYY', description: [] });
    const again = await api.bank.previewFile('bank.csv', text);
    expect(again.savedMapping?.debitCredit).toBe('Omschrijving');
    expect(again.direction).toEqual({ af: 0, bij: 3, nul: 0 });
    expect(again.issue).toMatch(/"Omschrijving" bevat alleen waarden/);
    expect(again.oneSided).toBe('bij');
    // met de juiste kolom laat de voorvertoning zien wat het wordt
    const fixed = api.bank.previewMapping(text, { ...again.savedMapping!, debitCredit: 'Soort' });
    expect(fixed.direction).toEqual({ af: 2, bij: 1, nul: 0 });
    expect(fixed.issue).toBeNull();
    expect(fixed.oneSided).toBeNull();
    expect(fixed.rows.map((r) => r.amount)).toEqual([-1000, 2000, -500]);
    expect(fixed.unreadable).toBe(0);
    db.close();
  });

  it('een MT940- of CAMT-bestand krijgt geen richting-check: daar staat af en bij vast', async () => {
    const { s, db } = setup();
    const api = createApi(s, { appVersion: () => 'test' } as unknown as HostContext);
    const r = await api.bank.previewFile('x.xml', '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt></BkToCstmrStmt></Document>');
    expect(r.format).toBe('camt');
    expect(r.direction).toBeNull();
    db.close();
  });
});
