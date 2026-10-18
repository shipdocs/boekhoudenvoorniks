import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

/**
 * De boekhouding voor de boekhouder aanzetten (#409): pas na een bewuste bevestiging. Wie hem al aan had
 * voordat die bevestiging bestond, houdt hem en kan gewoon andere instellingen blijven opslaan.
 */
describe('boekhouding voor de boekhouder aanzetten', () => {
  it('gaat niet aan zonder vastgelegd akkoord', () => {
    const { s } = setup();
    expect(() => s.settings.update({ advancedMode: true })).toThrow(/Bevestig eerst/);
    expect(s.settings.get().advancedMode).toBe(false);
  });

  it('gaat aan met het akkoord, en daarna uit en weer aan zonder nieuw akkoord', () => {
    const { s } = setup();
    s.settings.update({ advancedMode: true, advancedModeAgreedAt: '2026-10-15' });
    expect(s.settings.get()).toMatchObject({ advancedMode: true, advancedModeAgreedAt: '2026-10-15' });
    s.settings.update({ advancedMode: false });
    s.settings.update({ advancedMode: true });
    expect(s.settings.get().advancedMode).toBe(true);
  });

  it('een administratie die hem al aan had, houdt hem en kan andere instellingen opslaan', () => {
    const { s, db } = setup();
    // zoals een oudere versie het opsloeg: aan, zonder akkoord
    db.prepare("INSERT INTO settings (key, value) VALUES ('advancedMode', 'true')").run();
    expect(s.settings.get()).toMatchObject({ advancedMode: true, advancedModeAgreedAt: null });
    s.settings.update({ paymentTermDays: 14 });
    expect(s.settings.get().advancedMode).toBe(true);
    // ook aan laten staan in een bredere wijziging (zoals het instellingenscherm alles tegelijk opslaat) mag
    s.settings.update({ advancedMode: true, kor: false });
    expect(s.settings.get().advancedMode).toBe(true);
  });
});
