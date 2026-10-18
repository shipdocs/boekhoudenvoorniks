import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/database';
import { setup } from './helpers';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const smtp = { host: 'smtp.example.nl', port: 587, secure: false, user: 'u', fromName: 'Piet', fromEmail: 'piet@example.nl', bcc: '', replyTo: '' };
const copy = { office: 'Kantoor De Vries', exchange: 3, endDate: '2026-09-30' };

describe('identiteit van de administratie', () => {
  it('elke administratie krijgt één vaste UUID', () => {
    const a = setup().s;
    const b = setup().s;
    expect(a.settings.administrationId()).toMatch(UUID_V4);
    expect(a.settings.administrationId()).toBe(a.settings.administrationId());
    expect(a.settings.administrationId()).not.toBe(b.settings.administrationId());
  });

  it('opnieuw migreren verandert hem niet, en hij is niet via de instellingen te wijzigen', () => {
    const db = new Database(':memory:');
    migrate(db);
    const id = (db.prepare(`SELECT value FROM settings WHERE key = 'administrationId'`).get() as { value: string }).value;
    migrate(db);
    expect((db.prepare(`SELECT value FROM settings WHERE key = 'administrationId'`).get() as { value: string }).value).toBe(id);

    const { s } = setup();
    const before = s.settings.administrationId();
    s.settings.update({ administrationId: 'iets anders' } as never);
    expect(s.settings.administrationId()).toBe(before);
  });
});

describe('kantoormodus: de kopie bij de boekhouder', () => {
  it('een gewone administratie mag naar buiten', () => {
    const { s } = setup();
    expect(s.settings.officeCopy()).toBeNull();
    expect(s.settings.outboundBlocked()).toBeNull();
  });

  it('verstuurt geen e-mail', async () => {
    const { s, klant, sent } = setup();
    s.settings.update({ smtp });
    s.settings.markOfficeCopy(copy);
    expect(s.settings.outboundBlocked()).toMatch(/Kantoor De Vries.*uitwisseling 3/);
    const d = s.invoices.createDraft({ relationId: klant.id, lines: [{ description: 'Stucwerk', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] });
    await expect(s.sender.sendInvoice(d.id)).rejects.toThrow(/Kantoor De Vries/);
    expect(sent).toHaveLength(0);
  });

  it('koppelingen halen niets op', async () => {
    const calls: string[] = [];
    const { s } = setup({ fetch: async (url) => { calls.push(String(url)); throw new Error('mag niet gebeuren'); } });
    s.integrations.configure('woocommerce', { url: 'https://winkel.example.nl', consumerKey: 'ck_x', consumerSecret: 'cs_y' }, true);
    s.settings.markOfficeCopy(copy);
    await expect(s.integrations.sync('woocommerce')).rejects.toThrow(/Kantoor De Vries/);
    expect(calls).toEqual([]);
  });

  it('de kantoormodus is niet via de instellingen uit te zetten', () => {
    const { s } = setup();
    s.settings.markOfficeCopy(copy);
    s.settings.update({ officeCopy: null } as never);
    expect(s.settings.officeCopy()).toEqual(copy);
  });
});
