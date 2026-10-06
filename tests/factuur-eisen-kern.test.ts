import { describe, expect, it } from 'vitest';
// Via het pakket (@gratis-boekhouden/kern): daar staat de zuivere functie die desktop en Android delen.
import { checkInvoiceRequirements, ValidationError } from '@gratis-boekhouden/kern';

const bedrijf = { name: 'Praktijk BV', address: 'Dorpsstraat 1', city: 'Amsterdam', kvkNumber: '12345678', vatNumber: 'NL123456789B01' };
const klant = { name: 'Klant BV', address: 'Kerkstraat 2', city: 'Utrecht', country: 'NL', vat_number: null };

/** Verwacht exact deze foutmelding (woordelijk, want de tekst is gedrag) van een ValidationError. */
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

  describe('1. bedrijfsgegevens', () => {
    it('faalt: bedrijfsnaam ontbreekt', () => {
      verwachtFout('Vul eerst je bedrijfsgegevens aan bij Instellingen: bedrijfsnaam', () =>
        checkInvoiceRequirements({ lines: [] }, klant, false, { ...bedrijf, name: '' }),
      );
    });

    it('faalt: adres of plaats van het bedrijf ontbreekt', () => {
      verwachtFout('Vul eerst je bedrijfsgegevens aan bij Instellingen: bedrijfsadres', () =>
        checkInvoiceRequirements({ lines: [] }, klant, false, { ...bedrijf, address: '' }),
      );
      verwachtFout('Vul eerst je bedrijfsgegevens aan bij Instellingen: bedrijfsadres', () =>
        checkInvoiceRequirements({ lines: [] }, klant, false, { ...bedrijf, city: '' }),
      );
    });

    it('faalt: KvK-nummer ontbreekt', () => {
      verwachtFout('Vul eerst je bedrijfsgegevens aan bij Instellingen: KvK-nummer', () =>
        checkInvoiceRequirements({ lines: [] }, klant, false, { ...bedrijf, kvkNumber: '' }),
      );
    });

    it('faalt: btw-nummer ontbreekt (zonder KOR)', () => {
      verwachtFout('Vul eerst je bedrijfsgegevens aan bij Instellingen: btw-nummer', () =>
        checkInvoiceRequirements({ lines: [] }, klant, false, { ...bedrijf, vatNumber: '' }),
      );
    });

    it('faalt: alle onderdelen in dezelfde melding, in vaste volgorde', () => {
      verwachtFout('Vul eerst je bedrijfsgegevens aan bij Instellingen: bedrijfsnaam, bedrijfsadres, KvK-nummer, btw-nummer', () =>
        checkInvoiceRequirements({ lines: [] }, klant, false, { name: '', address: '', city: '', kvkNumber: '', vatNumber: '' }),
      );
    });

    it('voldaan: volledige bedrijfsgegevens', () => {
      expect(() => checkInvoiceRequirements({ lines: [{ vat_code: 'hoog', vat_percentage: 21 }] }, klant, false, bedrijf)).not.toThrow();
    });

    it('overgeslagen: onder de KOR is een eigen btw-nummer geen vereiste', () => {
      expect(() =>
        checkInvoiceRequirements({ lines: [{ vat_code: 'vrijgesteld', vat_percentage: 0 }] }, klant, true, { ...bedrijf, vatNumber: '' }),
      ).not.toThrow();
    });
  });

  describe('2. adres van de klant', () => {
    it('faalt: adres of plaats van de klant ontbreekt', () => {
      verwachtFout('Adres van Klant BV ontbreekt (verplicht op een factuur)', () =>
        checkInvoiceRequirements({ lines: [] }, { ...klant, address: '' }, false, bedrijf),
      );
      verwachtFout('Adres van Klant BV ontbreekt (verplicht op een factuur)', () =>
        checkInvoiceRequirements({ lines: [] }, { ...klant, city: '' }, false, bedrijf),
      );
    });

    it('voldaan: compleet adres van de klant', () => {
      expect(() => checkInvoiceRequirements({ lines: [] }, klant, false, bedrijf)).not.toThrow();
    });
  });

  describe('3. KOR en een EU-dienst: eigen btw-nummer', () => {
    const regel = { vat_code: 'icp-dienst', vat_percentage: 0 };
    const duits = { ...klant, country: 'DE', vat_number: 'DE123456789' };

    it('faalt: KOR zonder eigen btw-nummer met een EU-dienst', () => {
      verwachtFout('Bij "btw verlegd" op een dienst aan een bedrijf in een ander EU-land moeten jouw btw-nummer én dat van de klant op de factuur. Vul het jouwe in bij Instellingen.', () =>
        checkInvoiceRequirements({ lines: [regel] }, duits, true, { ...bedrijf, vatNumber: '' }),
      );
    });

    it('voldaan: met een eigen btw-nummer mag de EU-dienst onder de KOR', () => {
      expect(() => checkInvoiceRequirements({ lines: [regel] }, duits, true, bedrijf)).not.toThrow();
    });

    it('overgeslagen: zonder KOR wordt er niet om je eigen btw-nummer gevraagd', () => {
      expect(() => checkInvoiceRequirements({ lines: [regel] }, duits, false, bedrijf)).not.toThrow();
    });
  });

  describe('4. btw verlegd: btw-nummer van de klant', () => {
    const regel = { vat_code: 'verlegd', vat_percentage: 0 };

    it('faalt: "Btw verlegd" zonder btw-nummer van de klant', () => {
      verwachtFout('Bij btw verlegd moet het btw-nummer van Klant BV op de factuur staan. Vul het in bij de klant.', () =>
        checkInvoiceRequirements({ lines: [regel] }, klant, false, bedrijf),
      );
    });

    it('voldaan: met het btw-nummer van de klant', () => {
      expect(() => checkInvoiceRequirements({ lines: [regel] }, { ...klant, vat_number: 'NL123456789B01' }, false, bedrijf)).not.toThrow();
    });

    it('overgeslagen: een gewone Nederlandse regel vraagt geen klant-btw-nummer', () => {
      expect(() => checkInvoiceRequirements({ lines: [{ vat_code: 'hoog', vat_percentage: 21 }] }, klant, false, bedrijf)).not.toThrow();
    });
  });

  describe('5. icp: alleen klanten in een ander EU-land', () => {
    const regel = { vat_code: 'icp', vat_percentage: 0 };

    it('faalt: icp met een Nederlandse klant', () => {
      verwachtFout('"Bedrijf in een ander EU-land" is alleen voor klanten in een ander EU-land. Vul bij Klant BV het land in (bv. DE of BE)', () =>
        checkInvoiceRequirements({ lines: [regel] }, { ...klant, vat_number: 'NL123456789B01' }, false, bedrijf),
      );
    });

    it('faalt: icp met een onbekend land', () => {
      verwachtFout('"Bedrijf in een ander EU-land" is alleen voor klanten in een ander EU-land. Vul bij Klant BV het land in (bv. DE of BE)', () =>
        checkInvoiceRequirements({ lines: [regel] }, { ...klant, country: '', vat_number: 'DE123456789' }, false, bedrijf),
      );
    });

    it('voldaan: icp met een Duitse klant', () => {
      expect(() => checkInvoiceRequirements({ lines: [regel] }, { ...klant, country: 'DE', vat_number: 'DE123456789' }, false, bedrijf)).not.toThrow();
    });

    it('overgeslagen: zonder icp-regels is het land niet relevant', () => {
      expect(() => checkInvoiceRequirements({ lines: [{ vat_code: 'hoog', vat_percentage: 21 }] }, klant, false, bedrijf)).not.toThrow();
    });
  });

  describe('6. export: alleen klanten buiten de EU', () => {
    const regel = { vat_code: 'export', vat_percentage: 0 };

    it('faalt: export met een klant in de EU', () => {
      verwachtFout('"Klant buiten de EU" is alleen voor klanten buiten de EU. Vul bij Klant BV het land in (bv. CH of US)', () =>
        checkInvoiceRequirements({ lines: [regel] }, { ...klant, country: 'DE' }, false, bedrijf),
      );
    });

    it('voldaan: export met een Zwitserse klant', () => {
      expect(() => checkInvoiceRequirements({ lines: [regel] }, { ...klant, country: 'CH' }, false, bedrijf)).not.toThrow();
    });

    it('overgeslagen: zonder export-regels is het land niet relevant', () => {
      // Duitsland zou bij een exportregel fout gaan, met een gewone regel is het gewoon goed
      expect(() => checkInvoiceRequirements({ lines: [{ vat_code: 'hoog', vat_percentage: 21 }] }, { ...klant, country: 'DE' }, false, bedrijf)).not.toThrow();
    });
  });

  describe('7. KOR rekent geen btw', () => {
    it('faalt: KOR met een regel van 21%', () => {
      verwachtFout('Je gebruikt de kleineondernemersregeling (KOR): je rekent geen btw. Kies bij elke regel "Geen btw".', () =>
        checkInvoiceRequirements({ lines: [{ vat_code: 'hoog', vat_percentage: 21 }] }, klant, true, bedrijf),
      );
    });

    it('voldaan: KOR met alleen regels zonder btw', () => {
      expect(() => checkInvoiceRequirements({ lines: [{ vat_code: 'nul', vat_percentage: 0 }] }, klant, true, bedrijf)).not.toThrow();
    });

    it('overgeslagen: zonder KOR is 21% gewoon toegestaan', () => {
      expect(() => checkInvoiceRequirements({ lines: [{ vat_code: 'hoog', vat_percentage: 21 }] }, klant, false, bedrijf)).not.toThrow();
    });
  });

  describe('8. KOR en binnenlandse verlegging', () => {
    const regel = { vat_code: 'verlegd', vat_percentage: 0 };
    const klantMetBtw = { ...klant, vat_number: 'NL123456789B01' };

    it('faalt: KOR met "Btw verlegd"', () => {
      verwachtFout('Je gebruikt de kleineondernemersregeling (KOR): dan lever je vrijgesteld van btw en kies je geen "Btw verlegd". Kies bij elke regel "Geen btw (vrijgesteld of KOR)".', () =>
        checkInvoiceRequirements({ lines: [regel] }, klantMetBtw, true, bedrijf),
      );
    });

    it('voldaan: KOR zonder verlegde regels', () => {
      expect(() => checkInvoiceRequirements({ lines: [{ vat_code: 'vrijgesteld', vat_percentage: 0 }] }, klant, true, bedrijf)).not.toThrow();
    });

    it('overgeslagen: zonder KOR is "Btw verlegd" toegestaan', () => {
      expect(() => checkInvoiceRequirements({ lines: [regel] }, klantMetBtw, false, bedrijf)).not.toThrow();
    });
  });

  describe('9. KOR en uitvoer van goederen', () => {
    const regel = { vat_code: 'export', vat_percentage: 0 };
    const zwitser = { ...klant, country: 'CH' };

    it('faalt: KOR met uitvoer van goederen buiten de EU', () => {
      verwachtFout('Je gebruikt de kleineondernemersregeling (KOR): ook bij goederen naar een land buiten de EU kies je "Geen btw (vrijgesteld of KOR)". De factuur noemt dan de KOR.', () =>
        checkInvoiceRequirements({ lines: [regel] }, zwitser, true, bedrijf),
      );
    });

    it('voldaan: KOR met een dienst aan een klant buiten de EU (geen uitvoer van goederen)', () => {
      expect(() => checkInvoiceRequirements({ lines: [{ vat_code: 'dienst-buiten-eu', vat_percentage: 0 }] }, zwitser, true, bedrijf)).not.toThrow();
    });

    it('overgeslagen: zonder KOR is uitvoer van goederen toegestaan', () => {
      expect(() => checkInvoiceRequirements({ lines: [regel] }, zwitser, false, bedrijf)).not.toThrow();
    });
  });

  describe('10. KOR en intracommunautaire levering van goederen', () => {
    const regel = { vat_code: 'icp', vat_percentage: 0 };
    const duits = { ...klant, country: 'DE', vat_number: 'DE123456789' };

    it('faalt: KOR met een levering van goederen naar een EU-bedrijf', () => {
      verwachtFout('Je gebruikt de kleineondernemersregeling (KOR): ook bij goederen naar een bedrijf in een ander EU-land kies je "Geen btw (vrijgesteld of KOR)". De factuur noemt dan de KOR en je doet geen opgaaf ICP.', () =>
        checkInvoiceRequirements({ lines: [regel] }, duits, true, bedrijf),
      );
    });

    it('voldaan: KOR met een EU-dienst (geen levering van goederen)', () => {
      expect(() => checkInvoiceRequirements({ lines: [{ vat_code: 'icp-dienst', vat_percentage: 0 }] }, duits, true, bedrijf)).not.toThrow();
    });

    it('overgeslagen: zonder KOR is een levering van goederen naar een EU-bedrijf toegestaan', () => {
      expect(() => checkInvoiceRequirements({ lines: [regel] }, duits, false, bedrijf)).not.toThrow();
    });
  });

  describe('volgorde van de controles', () => {
    it('bedrijfsgegevens winnen van alle latere controles', () => {
      // ook adres, KOR-percentage en verlegding zijn tegelijk fout; de bedrijfsgegevens winnen
      verwachtFout('Vul eerst je bedrijfsgegevens aan bij Instellingen: bedrijfsnaam, bedrijfsadres, KvK-nummer', () =>
        checkInvoiceRequirements({ lines: [{ vat_code: 'hoog', vat_percentage: 21 }] }, { ...klant, address: '' }, true, { name: '', address: '', city: '', kvkNumber: '', vatNumber: '' }),
      );
    });

    it('het adres van de klant komt vóór de KOR-controles', () => {
      // het adres is onvolledig én de KOR rekent 21% btw; het adres wordt eerst gemeld
      verwachtFout('Adres van Klant BV ontbreekt (verplicht op een factuur)', () =>
        checkInvoiceRequirements({ lines: [{ vat_code: 'hoog', vat_percentage: 21 }] }, { ...klant, address: '' }, true, bedrijf),
      );
    });
  });
});
