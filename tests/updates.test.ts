import { describe, expect, it } from 'vitest';
import { notesAsText } from '../src/main/update-notes';
import { setup } from './helpers';

describe('automatisch bijwerken', () => {
  it('staat standaard aan, en is uit te zetten', () => {
    const { s } = setup();
    expect(s.settings.get().autoUpdate).toBe(true);
    s.settings.update({ autoUpdate: false });
    expect(s.settings.get().autoUpdate).toBe(false);
  });

  it('"Wat is er nieuw?" toont platte tekst, nooit HTML uit de releasetekst', () => {
    const text = notesAsText('<ul><li><strong>Bon in de mail</strong> wordt bewaard</li><li>Fix &amp; meer</li></ul><script>alert(1)</script><img src="x" onerror="y">');
    expect(text).toBe('• Bon in de mail wordt bewaard\n• Fix & meer');
    expect(notesAsText([{ version: '0.3.6', note: '<p>Nieuw</p>' }])).toBe('0.3.6\nNieuw');
    expect(notesAsText(null)).toBeNull();
  });
});
