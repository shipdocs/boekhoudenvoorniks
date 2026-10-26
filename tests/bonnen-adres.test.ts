import { describe, expect, it } from 'vitest';
import { setup } from './helpers';
import { makePdf } from './pdf';
import { MemorySecretStore } from '../src/services';
import { BONNEN_PASSWORD_SECRET, BONNEN_TOKEN_SECRET, BonnenAdresService, BonnenServerError, httpBonnenServer, isPhoneEmpty, normalizeKvk, normalizePhone, type BonnenServer } from '../src/mail/bonnen-adres';
import { BONNEN_PREFIX, BONNEN_TARGET, mailFolderOf, type MailMessage, type MailSource } from '../src/mail/mail-intake';
import { sanitizeForExchange } from '../src/exchange/exchange';
import { BONNEN_CONSENT_VERSION } from '../src/shared/legal';

/** De licentieserver nagebootst: onthoudt wat de app vroeg en antwoordt zoals de echte. */
function fakeServer() {
  const calls: { op: string; token: string | null; body?: unknown }[] = [];
  let status = 'onbevestigd';
  let pw = 0;
  let aanmeldStatus: 'onbevestigd' | 'overnemen' = 'onbevestigd';
  const next: { op: string; error: BonnenServerError }[] = [];
  const fail = (op: string) => {
    const i = next.findIndex((n) => n.op === op);
    if (i >= 0) throw next.splice(i, 1)[0]!.error;
  };
  const server: BonnenServer = {
    async aanmelden(body, token) {
      calls.push({ op: 'aanmelden', token, body });
      fail('aanmelden');
      return { status: aanmeldStatus, installatie: `token-${calls.length}`, email: 'p***@voorbeeld.nl' };
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
  return { server, calls, setStatus: (s: string) => void (status = s), setAanmelden: (s: 'onbevestigd' | 'overnemen') => void (aanmeldStatus = s), failNext: (op: string, error: BonnenServerError) => void next.push({ op, error }) };
}

/** Een volledig aanvraagformulier; de tests overschrijven wat ze nodig hebben. */
const VELDEN = { email: 'piet@voorbeeld.nl', bedrijfsnaam: 'Bakkerij Piet', kvk: '1234 5678', voornaam: 'Piet', achternaam: 'Jansen', telefoon: '06 1234-5678', toestemming: BONNEN_CONSENT_VERSION };

function world() {
  const ctx = setup();
  const srv = fakeServer();
  const bonnen = new BonnenAdresService(ctx.db, ctx.s.settings, ctx.secrets, srv.server, () => new Date('2026-10-17T09:00:00Z'));
  const request = (extra: Partial<Parameters<BonnenAdresService['aanvragen']>[0]> = {}) => bonnen.aanvragen({ ...VELDEN, ...extra });
  return { ...ctx, srv, bonnen, request };
}

describe('bonnen-adres in de app', () => {
  it('aanvragen, bevestigen, goedkeuren: de stand volgt de server en de machtiging staat in de sleutelhanger', async () => {
    const w = world();
    expect(w.bonnen.view()).toMatchObject({ beschikbaar: true, status: 'geen' });
    const v = await w.request();
    expect(v).toMatchObject({ status: 'onbevestigd', email: 'p***@voorbeeld.nl' });
    expect(w.srv.calls[0]).toMatchObject({ op: 'aanmelden', token: null, body: { administratie: w.s.settings.administrationId(), email: 'piet@voorbeeld.nl', bedrijfsnaam: 'Bakkerij Piet', kvk: '12345678', voornaam: 'Piet', achternaam: 'Jansen', telefoon: '0612345678', toestemming: BONNEN_CONSENT_VERSION } });
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

  it('beëindigd bij de server (409 bij inloggegevens): de stand wordt bijgewerkt in plaats van "actief" te blijven', async () => {
    const w = world();
    await w.request();
    w.srv.setStatus('actief');
    await w.bonnen.verversen();
    w.srv.setStatus('verwijderd');
    w.srv.failNext('inloggegevens', new BonnenServerError('Het bonnen-adres is nog niet klaar', 409));
    await expect(w.bonnen.wachtwoord(true)).rejects.toThrow();
    expect(w.bonnen.view().status).toBe('verwijderd');
    expect(w.bonnen.actief()).toBe(false);
  });

  it('stoppen terwijl het adres al op een andere computer is overgenomen: "ingetrokken", niet "gestopt"', async () => {
    const w = world();
    await w.request();
    w.srv.failNext('stoppen', new BonnenServerError('Deze computer heeft geen toegang meer', 403, true));
    expect((await w.bonnen.stoppen()).status).toBe('ingetrokken');
    const v = world();
    await v.request();
    v.srv.failNext('stoppen', new BonnenServerError('Weg', 410));
    expect((await v.bonnen.stoppen()).status).toBe('gestopt');
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
    await expect(b.aanvragen({ ...VELDEN })).rejects.toThrow(/sleutelhanger/);
    expect(v.srv.calls).toHaveLength(0);
  });

  it('controleert de invoer en de toestemming vóór er iets naar de server gaat', async () => {
    const w = world();
    await expect(w.request({ toestemming: '2020-01-01' })).rejects.toThrow('Ga eerst akkoord met de afspraken voor het bonnen-adres');
    await expect(w.request({ email: 'geen' })).rejects.toThrow(/e-mailadres/);
    await expect(w.request({ bedrijfsnaam: ' ' })).rejects.toThrow(/bedrijfsnaam/);
    await expect(w.request({ kvk: '123' })).rejects.toThrow('Een KvK-nummer heeft 8 cijfers');
    expect(w.srv.calls).toHaveLength(0);
  });

  it('bij meerdere ongeldige velden is de eerste melding die van de server (e-mail, bedrijf, akkoord, KvK, namen, telefoon)', async () => {
    const w = world();
    const alles = { email: 'geen', bedrijfsnaam: ' ', kvk: '123', voornaam: ' ', achternaam: ' ', telefoon: '06-abc', toestemming: '2020-01-01' };
    const goed = { email: 'piet@voorbeeld.nl', bedrijfsnaam: 'B', toestemming: BONNEN_CONSENT_VERSION };
    const volgorde: [Partial<typeof alles>, string][] = [
      [{}, 'Vul een geldig e-mailadres in'],
      [{ email: goed.email }, 'Vul je bedrijfsnaam in'],
      [{ email: goed.email, bedrijfsnaam: 'B' }, 'Ga eerst akkoord met de afspraken voor het bonnen-adres'],
      [goed, 'Een KvK-nummer heeft 8 cijfers'],
      [{ ...goed, kvk: '12345678' }, 'Vul je voornaam in'],
      [{ ...goed, kvk: '12345678', voornaam: 'P' }, 'Vul je achternaam in'],
      [{ ...goed, kvk: '12345678', voornaam: 'P', achternaam: 'J' }, 'Vul een geldig telefoonnummer in, bijvoorbeeld 06 12345678 of +32 470 12 34 56'],
    ];
    for (const [fix, melding] of volgorde) await expect(w.bonnen.aanvragen({ ...alles, ...fix })).rejects.toThrow(melding);
    expect(w.srv.calls).toHaveLength(0);
  });

  it('voornaam, achternaam en KvK zijn verplicht, een ingevulde telefoon moet kloppen, met de meldingen van de server', async () => {
    const w = world();
    await expect(w.request({ voornaam: '  ' })).rejects.toThrow('Vul je voornaam in');
    await expect(w.request({ achternaam: '' })).rejects.toThrow('Vul je achternaam in');
    await expect(w.request({ voornaam: 'a'.repeat(101) })).rejects.toThrow('Je voornaam is te lang (hooguit 100 tekens)');
    await expect(w.request({ achternaam: 'a'.repeat(101) })).rejects.toThrow('Je achternaam is te lang (hooguit 100 tekens)');
    await expect(w.request({ telefoon: '06-abc' })).rejects.toThrow(/geldig telefoonnummer/);
    const kvkMelding = 'Vul je KvK-nummer in (8 cijfers). Zonder KvK-nummer kunnen we je geen bonnen-adres geven. Heb je geen KvK-nummer? Mail dan naar stacy@shipdocs.app.';
    await expect(w.request({ kvk: '' })).rejects.toThrow(kvkMelding);
    await expect(w.request({ kvk: '  ' })).rejects.toThrow(kvkMelding);
    await expect(w.request({ kvk: undefined })).rejects.toThrow(kvkMelding);
    await expect(w.request({ kvk: '1234567a' })).rejects.toThrow('Een KvK-nummer heeft 8 cijfers');
    await expect(w.request({ kvk: '123456789' })).rejects.toThrow('Een KvK-nummer heeft 8 cijfers');
    expect(w.srv.calls).toHaveLength(0);
    // precies 100 tekens mag, en wordt getrimd meegestuurd
    await w.request({ voornaam: ` ${'a'.repeat(100)} `, achternaam: ' Jansen ' });
    expect(w.srv.calls[0]!.body).toMatchObject({ voornaam: 'a'.repeat(100), achternaam: 'Jansen' });
  });

  it('stuurt telefoon en KvK in compacte vorm naar de server', async () => {
    const w = world();
    await w.request({ telefoon: '0031 6 1234-5678', kvk: ' 1234 5678 ' });
    expect(w.srv.calls[0]!.body).toMatchObject({ telefoon: '+31612345678', kvk: '12345678' });
  });

  it('telefoon mag leeg: leeg of alleen spaties en streepjes gaat als "" naar de server', async () => {
    for (const telefoon of ['', '   ', ' - - ', undefined]) {
      const w = world();
      await w.request({ telefoon });
      expect(w.srv.calls[0]!.body).toMatchObject({ telefoon: '', kvk: '12345678', voornaam: 'Piet' });
    }
  });

  it('telefoon volgt de server: null is leeg; getal, array, object en meer dan 50 tekens alleen spaties/streepjes zijn ongeldig', async () => {
    const w = world();
    await w.request({ telefoon: null as unknown as string });
    expect(w.srv.calls[0]!.body).toMatchObject({ telefoon: '' });
    const w50 = world();
    await w50.request({ telefoon: ' -'.repeat(25) });
    expect(w50.srv.calls[0]!.body).toMatchObject({ telefoon: '' });
    const melding = /geldig telefoonnummer/;
    const w2 = world();
    for (const telefoon of [612345678, [], {}, [' '], ' '.repeat(51), '-'.repeat(51), ' -'.repeat(25) + ' ']) {
      await expect(w2.request({ telefoon: telefoon as unknown as string })).rejects.toThrow(melding);
    }
    expect(w2.srv.calls).toHaveLength(0);
    expect([undefined, null, '', ' - ', ' '.repeat(50)].map(isPhoneEmpty)).toEqual([true, true, true, true, true]);
    expect([0, 612345678, [], {}, ' '.repeat(51), '06'].map(isPhoneEmpty)).toEqual([false, false, false, false, false, false]);
  });

  it('overnemen op een andere computer: geen kvk, namen of telefoon, wel overnemen: true', async () => {
    const w = world();
    await w.request();
    const elders = new BonnenAdresService(w.db, w.s.settings, new MemorySecretStore(), w.srv.server);
    w.srv.setAanmelden('overnemen');
    expect(elders.view().status).toBe('andere-computer');
    // ongeldige of ontbrekende kvk/namen/telefoon worden niet gevalideerd en niet meegestuurd
    const v = await elders.aanvragen({ email: 'piet@voorbeeld.nl', bedrijfsnaam: 'Bakkerij Piet', kvk: 'abc', voornaam: ' ', achternaam: '', telefoon: '06-abc', toestemming: BONNEN_CONSENT_VERSION, overnemen: true });
    const body = w.srv.calls.filter((c) => c.op === 'aanmelden')[1]!.body as Record<string, unknown>;
    expect(body).toEqual({ administratie: w.s.settings.administrationId(), email: 'piet@voorbeeld.nl', bedrijfsnaam: 'Bakkerij Piet', toestemming: BONNEN_CONSENT_VERSION, overnemen: true });
    expect(Object.keys(body)).not.toEqual(expect.arrayContaining(['kvk']));
    expect(v.status).toBe('overnemen');
    expect(v.email).toBe('p***@voorbeeld.nl');
    expect(elders.lopend()).toBe(true);
  });

  it('overnemen controleert wel e-mail, bedrijfsnaam en akkoord', async () => {
    const w = world();
    const o = { email: 'piet@voorbeeld.nl', bedrijfsnaam: 'B', toestemming: BONNEN_CONSENT_VERSION, overnemen: true };
    await expect(w.bonnen.aanvragen({ ...o, email: 'geen' })).rejects.toThrow('Vul een geldig e-mailadres in');
    await expect(w.bonnen.aanvragen({ ...o, bedrijfsnaam: ' ' })).rejects.toThrow('Vul je bedrijfsnaam in');
    await expect(w.bonnen.aanvragen({ ...o, toestemming: 'x' })).rejects.toThrow('Ga eerst akkoord met de afspraken voor het bonnen-adres');
    expect(w.srv.calls).toHaveLength(0);
  });

  it('overnemen terwijl de server het adres niet meer kent (409 geen_adres): lokale stand vergeten, melding blijft', async () => {
    const w = world();
    await w.request();
    const elders = new BonnenAdresService(w.db, w.s.settings, new MemorySecretStore(), w.srv.server);
    expect(elders.view().status).toBe('andere-computer');
    const melding = 'Dit bonnen-adres bestaat niet meer. Vraag een nieuw bonnen-adres aan.';
    w.srv.failNext('aanmelden', new BonnenServerError(melding, 409, false, 'geen_adres'));
    const err = await elders.aanvragen({ email: 'piet@voorbeeld.nl', bedrijfsnaam: 'B', toestemming: BONNEN_CONSENT_VERSION, overnemen: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BonnenServerError);
    expect(err).toMatchObject({ status: 409, code: 'geen_adres', message: melding });
    expect(elders.view().status).toBe('geen');
    // een andere 409 laat de stand staan
    const x = world();
    await x.request();
    const e2 = new BonnenAdresService(x.db, x.s.settings, new MemorySecretStore(), x.srv.server);
    x.srv.failNext('aanmelden', new BonnenServerError('Anders', 409, false, 'iets_anders'));
    await expect(e2.aanvragen({ email: 'piet@voorbeeld.nl', bedrijfsnaam: 'B', toestemming: BONNEN_CONSENT_VERSION, overnemen: true })).rejects.toThrow('Anders');
    expect(e2.view().status).toBe('andere-computer');
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

describe('telefoon en KvK normaliseren', () => {
  it('geldige telefoonnummers worden compact', () => {
    expect(normalizePhone('06-12345678')).toBe('0612345678');
    expect(normalizePhone('020-1234567')).toBe('0201234567');
    expect(normalizePhone('0612 345 678')).toBe('0612345678');
    expect(normalizePhone('+32 470 12 34 56')).toBe('+32470123456');
    expect(normalizePhone('0032 470 12 34 56')).toBe('+32470123456');
    expect(normalizePhone('+31612345678')).toBe('+31612345678');
    // 8 en 15 cijfers internationaal mag
    expect(normalizePhone('+1234567')).toBeNull();
    expect(normalizePhone('+12345678')).toBe('+12345678');
    expect(normalizePhone('+123456789012345')).toBe('+123456789012345');
  });

  it('ongeldige telefoonnummers', () => {
    for (const x of ['', '   ', '12345678', '0012345', '0001234567', '00 01234567', '+0123456789', '+1234567', '+1234567890123456', '0012345678901234567', '061234567', '06123456789', '(06) 12345678', '06.12345678', '06 1234 56 7a', '+', 'x'.repeat(51), '0'.repeat(10)]) {
      expect(normalizePhone(x), x).toBeNull();
    }
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone(612345678)).toBeNull();
    // 00 is nooit NL: 0001234567 is dus ongeldig, ook al zijn het 10 cijfers
    expect(normalizePhone('0001234567')).toBeNull();
  });

  it('KvK: 8 cijfers, spaties vallen weg, lange invoer wordt geweigerd', () => {
    expect(normalizeKvk('1234 5678')).toBe('12345678');
    expect(normalizeKvk('12345678')).toBe('12345678');
    for (const x of ['', '1234567', '123456789', '1234567a', 'x'.repeat(21), `${' '.repeat(15)}12345678`]) expect(normalizeKvk(x), x).toBeNull();
    expect(normalizeKvk(undefined)).toBeNull();
    expect(normalizeKvk(12345678)).toBeNull();
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
    await srv.aanmelden({ administratie: 'a', email: 'e', bedrijfsnaam: 'b', kvk: '12345678', voornaam: 'P', achternaam: 'J', telefoon: '0612345678', toestemming: 'v' }, 'oud');
    expect(seen[0]!.url).toBe('https://licentie.example/bonnen/aanmelden');
    expect(new Headers(seen[0]!.init.headers).get('authorization')).toBe('Bearer oud');
    const err = await srv.status('t').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BonnenServerError);
    expect(err).toMatchObject({ status: 403, ingetrokken: true, message: 'Deze computer heeft geen toegang meer' });
  });

  it('een weigering met code (app bijwerken) wordt een BonnenServerError met melding, status en code', async () => {
    const f = (async () => new Response(JSON.stringify({ fout: 'Werk de app bij naar de nieuwste versie om een bonnen-adres aan te vragen.', code: 'app_bijwerken' }), { status: 400 })) as unknown as typeof fetch;
    const srv = httpBonnenServer('https://licentie.example', f);
    const err = await srv.aanmelden({ administratie: 'a', email: 'e', bedrijfsnaam: 'b', kvk: '12345678', voornaam: 'P', achternaam: 'J', telefoon: '0612345678', toestemming: 'v' }, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BonnenServerError);
    expect(err).toMatchObject({ status: 400, code: 'app_bijwerken', ingetrokken: false, message: 'Werk de app bij naar de nieuwste versie om een bonnen-adres aan te vragen.' });
  });

  it('geen internet: een begrijpelijke melding', async () => {
    const srv = httpBonnenServer('https://licentie.example', (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch);
    await expect(srv.stoppen('t')).rejects.toThrow(/niet te bereiken/);
  });
});
