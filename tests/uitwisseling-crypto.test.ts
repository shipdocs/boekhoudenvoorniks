import { describe, expect, it } from 'vitest';
import { checkCode, generateOfficeKeys, newExchangeKey, openAsOffice, openWithKey, readHeader, sealForOffice, sealWithKey } from '../src/exchange/crypto';

const header = { administratie: '2c5bf9f4-1bd5-4fc9-a3b4-da8784765123', uitwisseling: 3, einddatum: '2026-09-30', appVersie: '0.7.0' };

describe('versleuteling van de uitwisseling', () => {
  it('alleen het kantoor van de uitnodiging kan de export openen', () => {
    const office = generateOfficeKeys();
    const other = generateOfficeKeys();
    const pkg = sealForOffice(office.publicKey, header, Buffer.from('Stukadoorsbedrijf Piet'));
    expect(readHeader(pkg)).toMatchObject({ ...header, richting: 'naar-boekhouder' });
    expect(openAsOffice(office, pkg).plain.toString()).toBe('Stukadoorsbedrijf Piet');
    expect(() => openAsOffice(other, pkg)).toThrow(/niet geopend worden/);
    // niet leesbaar in het bestand zelf
    expect(pkg.includes(Buffer.from('Stukadoorsbedrijf'))).toBe(false);
  });

  it('een gewijzigde kopregel of inhoud maakt het pakket onbruikbaar', () => {
    const office = generateOfficeKeys();
    const pkg = sealForOffice(office.publicKey, header, Buffer.from('administratie'));
    const otherAdmin = Buffer.from(pkg.toString('latin1').replace('2c5bf9f4', '2c5bf9f5'), 'latin1');
    expect(readHeader(otherAdmin).administratie).toMatch(/^2c5bf9f5/);
    expect(() => openAsOffice(office, otherAdmin)).toThrow(/niet geopend worden/);
    const flipped = Buffer.from(pkg);
    flipped[flipped.length - 1]! ^= 1;
    expect(() => openAsOffice(office, flipped)).toThrow(/niet geopend worden/);
    expect(() => readHeader(Buffer.from('iets anders'))).toThrow(/geen uitwisselingspakket/);
  });

  it('het antwoord opent alleen met de sleutel uit de export', () => {
    const k = newExchangeKey();
    const answer = sealWithKey(k, header, Buffer.from('correcties'));
    expect(readHeader(answer).richting).toBe('naar-klant');
    expect(openWithKey(k, answer).plain.toString()).toBe('correcties');
    expect(() => openWithKey(newExchangeKey(), answer)).toThrow(/niet geopend worden/);
    // een export is geen antwoord
    const office = generateOfficeKeys();
    expect(() => openAsOffice(office, answer)).toThrow(/geen export/);
  });

  it('controlecode: kort, leesbaar en per sleutel anders', () => {
    const a = generateOfficeKeys();
    expect(checkCode(a.publicKey)).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(checkCode(a.publicKey)).toBe(checkCode(a.publicKey));
    expect(checkCode(a.publicKey)).not.toBe(checkCode(generateOfficeKeys().publicKey));
  });
});
