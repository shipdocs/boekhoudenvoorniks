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
});
