import { describe, expect, it } from 'vitest';
import { notesAsText, updateErrorText } from '../src/main/update-notes';
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

  it('foutmeldingen van de updater in gewone taal', () => {
    const halfKlaar = new Error('Cannot find latest-linux.yml in the latest release artifacts (https://github.com/…/latest-linux.yml): HttpError: 404 "method: GET"\n\nPlease double check…');
    expect(updateErrorText(halfKlaar)).toBe('De nieuwe versie wordt nog klaargezet. Probeer het over een kwartier opnieuw.');
    expect(updateErrorText(new Error('net::ERR_INTERNET_DISCONNECTED'))).toMatch(/^Geen verbinding met GitHub/);
    expect(updateErrorText(new Error('iets anders\nmet stacktrace'))).toBe('Zoeken naar updates lukte niet: iets anders');
  });
});
