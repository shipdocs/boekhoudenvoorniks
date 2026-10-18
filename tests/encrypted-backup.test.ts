import { describe, expect, it } from 'vitest';
import { decryptBackup, encryptBackup, isEncryptedBackup } from '../src/main/encrypted-backup';

describe('versleutelde back-up (#17)', () => {
  const data = Buffer.from('SQLite format 3\u0000' + 'x'.repeat(5000));
  it('versleutelt en ontsleutelt met het juiste wachtwoord', () => {
    const enc = encryptBackup(data, 'correct horse battery');
    expect(isEncryptedBackup(enc)).toBe(true);
    expect(enc.includes(Buffer.from('SQLite format 3'))).toBe(false);
    expect(decryptBackup(enc, 'correct horse battery').equals(data)).toBe(true);
  });
  it('weigert een fout wachtwoord, gewijzigde data en een te kort wachtwoord', () => {
    const enc = encryptBackup(data, 'correct horse battery');
    expect(() => decryptBackup(enc, 'verkeerd wachtwoord')).toThrow(/Onjuist wachtwoord/);
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => decryptBackup(tampered, 'correct horse battery')).toThrow(/Onjuist wachtwoord of beschadigd/);
    expect(() => encryptBackup(data, 'kort')).toThrow(/minimaal/);
    expect(() => decryptBackup(data, 'x')).toThrow(/geen versleutelde/);
  });
});
