import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { isPathInside } from '../src/main/path-security';

describe('bijlagepad', () => {
  it('laat alleen echte kinderen van de bijlagenmap toe', () => {
    const root = join('/tmp', 'administratie', 'bijlagen');
    expect(isPathInside(root, join(root, '2026', 'bon.pdf'))).toBe(true);
    expect(isPathInside(root, root)).toBe(false);
    expect(isPathInside(root, join('/tmp', 'administratie', 'bijlagen-oud', 'bon.pdf'))).toBe(false);
    expect(isPathInside(root, join(root, '..', 'boekhouding.sqlite'))).toBe(false);
  });

  it('telt op Windows hoofdlettergebruik niet mee, elders wel', () => {
    const root = 'C:\\Users\\Piet\\BoekhoudenVoorNiks\\bijlagen';
    expect(isPathInside(root, 'c:\\users\\piet\\boekhoudenvoorniks\\Bijlagen\\2026\\bon.pdf', 'win32')).toBe(true);
    expect(isPathInside(root, 'C:\\Users\\Piet\\BoekhoudenVoorNiks\\bijlagen-oud\\bon.pdf', 'win32')).toBe(false);
    expect(isPathInside(root, 'C:\\Users\\Piet\\BoekhoudenVoorNiks\\bijlagen\\..\\boekhouding.sqlite', 'win32')).toBe(false);
    expect(isPathInside(root, 'D:\\Users\\Piet\\BoekhoudenVoorNiks\\bijlagen\\bon.pdf', 'win32')).toBe(false);
    expect(isPathInside('/home/piet/BoekhoudenVoorNiks/bijlagen', '/home/piet/boekhoudenvoorniks/bijlagen/bon.pdf', 'linux')).toBe(false);
  });
});
