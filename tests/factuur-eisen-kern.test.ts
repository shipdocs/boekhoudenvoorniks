import { describe, expect, it } from 'vitest';
// Via het pakket (@gratis-boekhouden/kern): daar staat de zuivere functie die desktop en Android delen.
import { checkInvoiceRequirements, ValidationError } from '@gratis-boekhouden/kern';

const bedrijf = { name: 'Praktijk BV', address: 'Dorpsstraat 1', city: 'Amsterdam', kvkNumber: '12345678', vatNumber: 'NL123456789B01' };
const klant = { name: 'Klant BV', address: 'Kerkstraat 2', city: 'Utrecht', country: 'NL', vat_number: null };

/** Verwacht exact deze foutmelding (woordelijk, want de tekst is gedrag). */
function verwachtFout(melding: string, aanroep: () => void): void {
  try {
    aanroep();
    expect.unreachable('Verwacht een ValidationError');
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as Error).message).toBe(melding);
  }
}

describe('checkInvoiceRequirements (gedeelde kern)', () => {
  it('geeft niets bij een volledige Nederlandse factuur', () => {
    expect(() => checkInvoiceRequirements({ lines: [{ vat_code: 'hoog', vat_percentage: 21 }] }, klant, false, bedrijf)).not.toThrow();
  });

  it('1. bedrijfsgegevens: elk ontbrekend onderdeel komt in dezelfde melding, in vaste volgorde', () => {
    verwachtFout('Vul eerst je bedrijfsgegevens aan bij Instellingen: bedrijfsnaam', () =>
      checkInvoiceRequirements({ lines: [] }, klant, false, { ...bedrijf, name: '' }),
    );
    verwachtFout('Vul eerst je bedrijfsgegevens aan bij Instellingen: bedrijfsadres', () =>
      checkInvoiceRequirements({ lines: [] }, klant, false, { ...bedrijf, address: '' }),
    );
    verwachtFout('Vul eerst je bedrijfsgegevens aan bij Instellingen: bedrijfsadres', () =>
      checkInvoiceRequirements({ lines: [] }, klant, false, { ...bedrijf, city: '' }),
    );
    verwachtFout('Vul eerst je bedrijfsgegevens aan bij Instellingen: KvK-nummer', () =>
      checkInvoiceRequirements({ lines: [] }, klant, false, { ...bedrijf, kvkNumber: '' }),
    );
    verwachtFout('Vul eerst je bedrijfsgegevens aan bij Instellingen: btw-nummer', () =>
      checkInvoiceRequirements({ lines: [] }, klant, false, { ...bedrijf, vatNumber: '' }),
    );
    verwachtFout('Vul eerst je bedrijfsgegevens aan bij Instellingen: bedrijfsnaam, bedrijfsadres, KvK-nummer, btw-nummer', () =>
      checkInvoiceRequirements({ lines: [] }, klant, false, { name: '', address: '', city: '', kvkNumber: '', vatNumber: '' }),
    );
    // onder de KOR is een eigen btw-nummer geen vereiste
    expect(() => checkInvoiceRequirements({ lines: [{ vat_code: 'vrijgesteld', vat_percentage: 0 }] }, klant, true, { ...bedrijf, vatNumber: '' })).not.toThrow();
  });

  it('2. adres van de klant is verplicht op een factuur', () => {
    verwachtFout('Adres van Klant BV ontbreekt (verplicht op een factuur)', () =>
      checkInvoiceRequirements({ lines: [] }, { ...klant, address: '' }, false, bedrijf),
    );
    verwachtFout('Adres van Klant BV ontbreekt (verplicht op een factuur)', () =>
      checkInvoiceRequirements({ lines: [] }, { ...klant, city: '' }, false, bedrijf),
    );
    expect(() => checkInvoiceRequirements({ lines: [] }, klant, false, bedrijf)).not.toThrow();
  });

  it('3. KOR met een EU-dienst (icp-dienst) vereist een eigen btw-nummer', () => {
    const regel = { vat_code: 'icp-dienst', vat_percentage: 0 };
    const duits = { ...klant, country: 'DE', vat_number: 'DE123456789' };
    verwachtFout('Bij "btw verlegd" op een dienst aan een bedrijf in een ander EU-land moeten jouw btw-nummer én dat van de klant op de factuur. Vul het jouwe in bij Instellingen.', () =>
      checkInvoiceRequirements({ lines: [regel] }, duits, true, { ...bedrijf, vatNumber: '' }),
    );
    expect(() => checkInvoiceRequirements({ lines: [regel] }, duits, true, bedrijf)).not.toThrow();
  });

  it('4. btw verlegd: het btw-nummer van de klant moet op de factuur', () => {
    const regel = { vat_code: 'verlegd', vat_percentage: 0 };
    verwachtFout('Bij btw verlegd moet het btw-nummer van Klant BV op de factuur staan. Vul het in bij de klant.', () =>
      checkInvoiceRequirements({ lines: [regel] }, klant, false, bedrijf),
    );
    expect(() => checkInvoiceRequirements({ lines: [regel] }, { ...klant, vat_number: 'NL123456789B01' }, false, bedrijf)).not.toThrow();
  });

  it('5. icp is alleen voor klanten in een ander EU-land', () => {
    const regel = { vat_code: 'icp', vat_percentage: 0 };
    verwachtFout('"Bedrijf in een ander EU-land" is alleen voor klanten in een ander EU-land. Vul bij Klant BV het land in (bv. DE of BE)', () =>
      checkInvoiceRequirements({ lines: [regel] }, { ...klant, vat_number: 'NL123456789B01' }, false, bedrijf),
    );
    verwachtFout('"Bedrijf in een ander EU-land" is alleen voor klanten in een ander EU-land. Vul bij Klant BV het land in (bv. DE of BE)', () =>
      checkInvoiceRequirements({ lines: [regel] }, { ...klant, country: '', vat_number: 'DE123456789' }, false, bedrijf),
    );
    expect(() => checkInvoiceRequirements({ lines: [regel] }, { ...klant, country: 'DE', vat_number: 'DE123456789' }, false, bedrijf)).not.toThrow();
  });

  it('6. export is alleen voor klanten buiten de EU', () => {
    const regel = { vat_code: 'export', vat_percentage: 0 };
    verwachtFout('"Klant buiten de EU" is alleen voor klanten buiten de EU. Vul bij Klant BV het land in (bv. CH of US)', () =>
      checkInvoiceRequirements({ lines: [regel] }, { ...klant, country: 'DE' }, false, bedrijf),
    );
    expect(() => checkInvoiceRequirements({ lines: [regel] }, { ...klant, country: 'CH' }, false, bedrijf)).not.toThrow();
  });

  it('7. KOR rekent geen btw: een regel met percentage is fout', () => {
    verwachtFout('Je gebruikt de kleineondernemersregeling (KOR): je rekent geen btw. Kies bij elke regel "Geen btw".', () =>
      checkInvoiceRequirements({ lines: [{ vat_code: 'hoog', vat_percentage: 21 }] }, klant, true, bedrijf),
    );
    expect(() => checkInvoiceRequirements({ lines: [{ vat_code: 'vrijgesteld', vat_percentage: 0 }] }, klant, true, bedrijf)).not.toThrow();
  });

  it('8. KOR past niet bij binnenlandse verlegging', () => {
    const regel = { vat_code: 'verlegd', vat_percentage: 0 };
    const klantMetBtw = { ...klant, vat_number: 'NL123456789B01' };
    verwachtFout('Je gebruikt de kleineondernemersregeling (KOR): dan lever je vrijgesteld van btw en kies je geen "Btw verlegd". Kies bij elke regel "Geen btw (vrijgesteld of KOR)".', () =>
      checkInvoiceRequirements({ lines: [regel] }, klantMetBtw, true, bedrijf),
    );
    expect(() => checkInvoiceRequirements({ lines: [regel] }, klantMetBtw, false, bedrijf)).not.toThrow();
  });

  it('9. KOR past niet bij uitvoer van goederen buiten de EU', () => {
    const regel = { vat_code: 'export', vat_percentage: 0 };
    const zwitser = { ...klant, country: 'CH' };
    verwachtFout('Je gebruikt de kleineondernemersregeling (KOR): ook bij goederen naar een land buiten de EU kies je "Geen btw (vrijgesteld of KOR)". De factuur noemt dan de KOR.', () =>
      checkInvoiceRequirements({ lines: [regel] }, zwitser, true, bedrijf),
    );
    expect(() => checkInvoiceRequirements({ lines: [regel] }, zwitser, false, bedrijf)).not.toThrow();
  });

  it('10. KOR past niet bij een intracommunautaire levering van goederen', () => {
    const regel = { vat_code: 'icp', vat_percentage: 0 };
    const duits = { ...klant, country: 'DE', vat_number: 'DE123456789' };
    verwachtFout('Je gebruikt de kleineondernemersregeling (KOR): ook bij goederen naar een bedrijf in een ander EU-land kies je "Geen btw (vrijgesteld of KOR)". De factuur noemt dan de KOR en je doet geen opgaaf ICP.', () =>
      checkInvoiceRequirements({ lines: [regel] }, duits, true, bedrijf),
    );
    expect(() => checkInvoiceRequirements({ lines: [regel] }, duits, false, bedrijf)).not.toThrow();
  });

  it('de controles blijven in vaste volgorde: bedrijfsgegevens eerst', () => {
    // ook adres, KOR-percentage en verlegding zijn tegelijk fout; de bedrijfsgegevens winnen
    verwachtFout('Vul eerst je bedrijfsgegevens aan bij Instellingen: bedrijfsnaam, bedrijfsadres, KvK-nummer', () =>
      checkInvoiceRequirements({ lines: [{ vat_code: 'hoog', vat_percentage: 21 }] }, { ...klant, address: '' }, true, { name: '', address: '', city: '', kvkNumber: '', vatNumber: '' }),
    );
    // daarna het adres van de klant, vóór de KOR-controles
    verwachtFout('Adres van Klant BV ontbreekt (verplicht op een factuur)', () =>
      checkInvoiceRequirements({ lines: [{ vat_code: 'hoog', vat_percentage: 21 }] }, { ...klant, address: '' }, true, bedrijf),
    );
  });
});
