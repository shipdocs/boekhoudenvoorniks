import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { makePdf } from './pdf';
import { MemorySecretStore } from '../src/services';
import { BONNEN_PASSWORD_SECRET, BONNEN_TOKEN_SECRET, BonnenAdresService, BonnenServerError, httpBonnenServer, type BonnenServer } from '../src/mail/bonnen-adres';
import { BONNEN_PREFIX, BONNEN_TARGET, mailFolderOf, type MailMessage, type MailSource } from '../src/mail/mail-intake';
import { sanitizeForExchange } from '../src/exchange/exchange';
import { BONNEN_CONSENT_VERSION } from '../src/shared/legal';

/** De licentieserver nagebootst: onthoudt wat de app vroeg en antwoordt zoals de echte (privé-repo, src/bonnen.ts). */
function fakeServer() {
  const calls: { op: string; token: string | null; body?: unknown }[] = [];
  let status = 'onbevestigd';
  let pw = 0;
  const next: { op: string; error: BonnenServerError }[] = [];
  const fail = (op: string) => {
    const i = next.findIndex((n) => n.op === op);
    if (i >= 0) throw next.splice(i, 1)[0]!.error;
  };
  const server: BonnenServer = {
    async aanmelden(body, token) {
      calls.push({ op: 'aanmelden', token, body });
      fail('aanmelden');
      return { status: 'onbevestigd', installatie: `token-${calls.length}`, email: 'p***@voorbeeld.nl' };
    },
    async status(token) {
      calls.push({ op: 'status', token });
      fail('status');
      return { status, ...(status === 'actief' ? { adres: 'bakkerijpi-k7m2q@post.boekhoudenvoorniks.nl' } : {}) };
    },
    async inloggegevens(token) {
      calls.push({ op: 'inloggegevens', token });
      fail('inloggegevens');
      pw += 1;
      return { adres: 'bakkerijpi-k7m2q@post.boekhoudenvoorniks.nl', server: 'mx.post.boekhoudenvoorniks.nl', poort: 993, gebruiker: 'bakkerijpi-k7m2q@post.boekhoudenvoorniks.nl', wachtwoord: `pw${pw}` };
    },
    async stoppen(token) {
      calls.push({ op: 'stoppen', token });
      fail('stoppen');
      status = 'gestopt';
      return { ok: true, status: 'gestopt' };
    },
  };
  return { server, calls, setStatus: (s: string) => void (status = s), failNext: (op: string, error: BonnenServerError) => void next.push({ op, error }) };
}

function world() {
  const ctx = setup();
  const srv = fakeServer();
  const bonnen = new BonnenAdresService(ctx.db, ctx.s.settings, ctx.secrets, srv.server, () => new Date('2026-10-17T09:00:00Z'));
  const request = () => bonnen.aanvragen({ email: 'piet@voorbeeld.nl', bedrijfsnaam: 'Bakkerij Piet', kvk: '1234 5678', toestemming: BONNEN_CONSENT_VERSION });
  return { ...ctx, srv, bonnen, request };
}

describe('bonnen-adres in de app', () => {
  it('aanvragen, bevestigen, goedkeuren: de stand volgt de server en de machtiging staat in de sleutelhanger', async () => {
    const w = world();
    expect(w.bonnen.view()).toMatchObject({ beschikbaar: true, status: 'geen' });
    const v = await w.request();
    expect(v).toMatchObject({ status: 'onbevestigd', email: 'p***@voorbeeld.nl' });
    expect(w.srv.calls[0]).toMatchObject({ op: 'aanmelden', token: null, body: { administratie: w.s.settings.administrationId(), email: 'piet@voorbeeld.nl', bedrijfsnaam: 'Bakkerij Piet', kvk: '12345678', toestemming: BONNEN_CONSENT_VERSION } });
    expect(w.secrets.get(BONNEN_TOKEN_SECRET)).toBe('token-1');
    expect(w.bonnen.lopend()).toBe(true);
    expect(w.bonnen.actief()).toBe(false);
    // de machtiging staat nooit leesbaar in de instellingen
    expect(JSON.stringify(w.db.prepare('SELECT value FROM settings').all())).not.toContain('token-1');

    w.srv.setStatus('wacht');
    expect((await w.bonnen.verversen()).status).toBe('wacht');
    w.srv.setStatus('actief');
    const actief = await w.bonnen.verversen();
    expect(actief).toMatchObject({ status: 'actief', adres: 'bakkerijpi-k7m2q@post.boekhoudenvoorniks.nl' });
    expect(w.bonnen.actief()).toBe(true);
    expect(w.bonnen.mailSettings()).toMatchObject({ host: 'mx.post.boekhoudenvoorniks.nl', port: 993, secure: true, user: 'bakkerijpi-k7m2q@post.boekhoudenvoorniks.nl', folder: 'INBOX' });
  });

  it('het wachtwoord wordt alleen opgevraagd als het er niet is of als inloggen mislukte', async () => {
    const w = world();
    await w.request();
    w.srv.setStatus('actief');
    await w.bonnen.verversen();
    expect(await w.bonnen.wachtwoord()).toBe('pw1');
    expect(await w.bonnen.wachtwoord()).toBe('pw1');
    expect(w.srv.calls.filter((c) => c.op === 'inloggegevens')).toHaveLength(1);
    expect(await w.bonnen.wachtwoord(true)).toBe('pw2');
    expect(w.secrets.get(BONNEN_PASSWORD_SECRET)).toBe('pw2');
  });

  it('opnieuw aanvragen stuurt de oude machtiging mee (de server mag dan de eigen aanvraag vervangen)', async () => {
    const w = world();
    await w.request();
    await w.request();
    expect(w.srv.calls[1]).toMatchObject({ op: 'aanmelden', token: 'token-1' });
    expect(w.secrets.get(BONNEN_TOKEN_SECRET)).toBe('token-2');
  });

  it('ingetrokken (overgenomen op een andere computer): niets meer ophalen, geheimen weg', async () => {
    const w = world();
    await w.request();
    w.srv.setStatus('actief');
    await w.bonnen.verversen();
    await w.bonnen.wachtwoord();
    w.srv.failNext('inloggegevens', new BonnenServerError('Deze computer heeft geen toegang meer', 403, true));
    await expect(w.bonnen.wachtwoord(true)).rejects.toThrow(/geen toegang/);
    expect(w.bonnen.view().status).toBe('ingetrokken');
    expect(w.bonnen.actief()).toBe(false);
    expect(w.secrets.get(BONNEN_TOKEN_SECRET)).toBeNull();
    expect(w.secrets.get(BONNEN_PASSWORD_SECRET)).toBeNull();
  });

  it('een back-up op een andere computer: de machtiging is daar niet te lezen, dus "andere computer"', async () => {
    const w = world();
    await w.request();
    w.srv.setStatus('actief');
    await w.bonnen.verversen();
    // de andere computer kan de versleutelde geheimen niet lezen: alsof ze er niet zijn
    const elders = new BonnenAdresService(w.db, w.s.settings, new MemorySecretStore(), w.srv.server);
    expect(elders.view()).toMatchObject({ status: 'andere-computer', adres: 'bakkerijpi-k7m2q@post.boekhoudenvoorniks.nl' });
    expect(elders.actief()).toBe(false);
    expect(elders.lopend()).toBe(false);
  });

  it('stoppen: bij de server, dan de geheimen weg; daarna kan het opnieuw', async () => {
    const w = world();
    await w.request();
    w.srv.setStatus('actief');
    await w.bonnen.verversen();
    await w.bonnen.wachtwoord();
    // zonder internet: een fout, en alles blijft zoals het was
    w.srv.failNext('stoppen', new BonnenServerError('De server is niet te bereiken', 0));
    await expect(w.bonnen.stoppen()).rejects.toThrow();
    expect(w.bonnen.actief()).toBe(true);
    expect((await w.bonnen.stoppen()).status).toBe('gestopt');
    expect(w.secrets.get(BONNEN_TOKEN_SECRET)).toBeNull();
    expect(w.bonnen.vergeten().status).toBe('geen');
  });

  it('vergeten kan niet zolang het adres nog loopt', async () => {
    const w = world();
    await w.request();
    expect(() => w.bonnen.vergeten()).toThrow(/Stop/);
  });

  it('niet in de demo, niet in de kopie bij de boekhouder, niet zonder sleutelhanger', async () => {
    const w = world();
    w.s.settings.update({ demoMode: true });
    expect(w.bonnen.view()).toMatchObject({ beschikbaar: false });
    await expect(w.request()).rejects.toThrow(/demo/);
    w.s.settings.update({ demoMode: false });
    w.s.settings.markOfficeCopy({ office: 'Kantoor', exchange: 1, endDate: '2026-12-31' });
    await expect(w.request()).rejects.toThrow(/Kantoor/);

    const v = world();
    const noKeyring = Object.assign(new MemorySecretStore(), {});
    Object.defineProperty(noKeyring, 'available', { get: () => false });
    const b = new BonnenAdresService(v.db, v.s.settings, noKeyring, v.srv.server);
    expect(b.view()).toMatchObject({ beschikbaar: false });
    expect(b.view().reden).toMatch(/Bonnenmap/);
    await expect(b.aanvragen({ email: 'a@b.nl', bedrijfsnaam: 'X', toestemming: BONNEN_CONSENT_VERSION })).rejects.toThrow(/sleutelhanger/);
    expect(v.srv.calls).toHaveLength(0);
  });

  it('controleert de invoer en de toestemming vóór er iets naar de server gaat', async () => {
    const w = world();
    await expect(w.bonnen.aanvragen({ email: 'piet@voorbeeld.nl', bedrijfsnaam: 'X', toestemming: '2020-01-01' })).rejects.toThrow(/toestemming/);
    await expect(w.bonnen.aanvragen({ email: 'geen', bedrijfsnaam: 'X', toestemming: BONNEN_CONSENT_VERSION })).rejects.toThrow(/e-mailadres/);
    await expect(w.bonnen.aanvragen({ email: 'a@b.nl', bedrijfsnaam: ' ', toestemming: BONNEN_CONSENT_VERSION })).rejects.toThrow(/bedrijfsnaam/);
    await expect(w.bonnen.aanvragen({ email: 'a@b.nl', bedrijfsnaam: 'X', kvk: '123', toestemming: BONNEN_CONSENT_VERSION })).rejects.toThrow(/KvK/);
    expect(w.srv.calls).toHaveLength(0);
  });

  it('de export naar de boekhouder bevat het bonnen-adres en de geheimen niet', async () => {
    const w = world();
    await w.request();
    sanitizeForExchange(w.db);
    expect(w.db.prepare(`SELECT 1 FROM settings WHERE key = 'bonnenAdres'`).get()).toBeUndefined();
  });
});

describe('ophalen per mailbox', () => {
  /** Twee mailboxen met allebei een INBOX, met dezelfde UID's. */
  class Box implements MailSource {
    moved: string[] = [];
    constructor(private readonly messages: MailMessage[]) {}
    async open(folder: string) {
      return folder === 'INBOX' ? { uidValidity: '1' } : null;
    }
    async list(afterUid: number) {
      return this.messages.map((m) => m.uid).filter((u) => u > afterUid);
    }
    async fetch(uid: number) {
      return this.messages.find((m) => m.uid === uid) ?? null;
    }
    async move(uid: number, target: string) {
      this.moved.push(`${uid}->${target}`);
    }
  }
  const msg = (uid: number, id: string): MailMessage => ({ uid, messageId: `<${id}@x>`, fromAddress: 'facturen@leverancier.example', fromName: 'Leverancier', subject: 'Factuur', date: '2026-10-01', text: '', attachments: [{ filename: `${id}.pdf`, content: makePdf([id, `Factuurnummer ${id}`, 'Totaal € 12,10']), contentType: 'application/pdf', inline: false }] });

  it('de ophaalstand van het bonnen-adres staat los van die van de eigen mailserver', async () => {
    const { s, db } = setup();
    s.settings.update({ onboardingDone: true, mailIn: { enabled: true, host: 'imap.example.nl', port: 993, secure: true, user: 'a@piet.nl', folder: 'INBOX', extraFolders: [], processedFolder: 'Verwerkt', since: '' } });
    const own = new Box([msg(1, 'eigen-1'), msg(2, 'eigen-2')]);
    const bon = new Box([msg(1, 'bon-1')]);
    expect((await s.mail.poll(own)).documents).toBe(2);
    // dezelfde map en UID 1 in de andere mailbox: toch nieuw
    expect((await s.mail.poll(bon, undefined, BONNEN_TARGET)).documents).toBe(1);
    expect(bon.moved).toEqual(['1->Verwerkt']);
    const folders = (db.prepare('SELECT folder, last_uid FROM mail_folders ORDER BY folder').all() as { folder: string; last_uid: number }[]);
    expect(folders).toEqual([
      { folder: 'INBOX', last_uid: 2 },
      { folder: `${BONNEN_PREFIX}INBOX`, last_uid: 1 },
    ]);
  });

  it('mailFolderOf haalt het voorvoegsel eraf', () => {
    expect(mailFolderOf(`${BONNEN_PREFIX}INBOX`, { folder: 'INBOX' })).toEqual({ folder: 'INBOX', main: true, bonnen: true });
    expect(mailFolderOf('Archief', { folder: 'INBOX' })).toEqual({ folder: 'Archief', main: false, bonnen: false });
  });
});

describe('licentieserver via fetch', () => {
  it('stuurt de machtiging als Bearer en geeft de fout van de server door', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (url.endsWith('/bonnen/status')) return new Response(JSON.stringify({ fout: 'Deze computer heeft geen toegang meer', ingetrokken: true }), { status: 403 });
      return new Response(JSON.stringify({ status: 'onbevestigd', installatie: 't', email: 'p***@x.nl' }), { status: 200 });
    }) as unknown as typeof fetch;
    const srv = httpBonnenServer('https://licentie.example', f);
    await srv.aanmelden({ administratie: 'a', email: 'e', bedrijfsnaam: 'b', kvk: '', toestemming: 'v' }, 'oud');
    expect(seen[0]!.url).toBe('https://licentie.example/bonnen/aanmelden');
    expect(new Headers(seen[0]!.init.headers).get('authorization')).toBe('Bearer oud');
    const err = await srv.status('t').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BonnenServerError);
    expect(err).toMatchObject({ status: 403, ingetrokken: true, message: 'Deze computer heeft geen toegang meer' });
  });

  it('geen internet: een begrijpelijke melding', async () => {
    const srv = httpBonnenServer('https://licentie.example', (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch);
    await expect(srv.stoppen('t')).rejects.toThrow(/niet te bereiken/);
  });
});
