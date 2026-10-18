import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

describe('instellingenvalidatie', () => {
  it('weigert ongeldige financiële en SMTP-instellingen', () => {
    const { s } = setup();
    expect(() => s.settings.update({ paymentTermDays: -1 })).toThrow(/Betaaltermijn/);
    expect(() => s.settings.update({ quoteValidityDays: 0 })).toThrow(/Geldigheid/);
    expect(() => s.settings.update({ smtp: { port: 70000 } as never })).toThrow(/SMTP-poort/);
    expect(() => s.settings.update({ reminderDays: [7, 366] })).toThrow(/Herinneringsdagen/);
    expect(() => s.settings.update({ smtp: { fromEmail: 'geen-email' } as never })).toThrow(/afzenderadres/);
  });
});
