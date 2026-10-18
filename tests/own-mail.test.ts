import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildThunderbirdArgs,
  buildXdgEmailArgs,
  handOverToOwnMailProgram,
  mapMapiResult,
  pruneOldPdfs,
  writeTempPdf,
  sendWithMapi,
  spawnXdgEmail,
  webmailUrl,
  type ChildProcessLike,
  type HandoverResult,
  type MapiSender,
  type OwnMailMessage,
  type SpawnFn,
} from '../src/documents/own-mail';
import { setup } from './helpers';

const msg: OwnMailMessage = {
  to: 'jansen@example.nl',
  subject: 'Factuur 2026-001 "test" & co',
  body: 'Beste Zoë,\nde factuur staat in de bijlage.',
  attachmentPath: '/tmp/boekhoudenvoorniks/factuur-1/Factuur 2026-001 é.pdf',
};

/** Een nagebootste xdg-email: slaat de aanroep op en eindigt met de gevraagde code of fout. */
function fakeSpawn(outcome: { code: number } | { error: string }) {
  const calls: { cmd: string; args: string[] }[] = [];
  const spawn: SpawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    const handlers: { error?: (e: NodeJS.ErrnoException) => void; close?: (c: number | null) => void } = {};
    const child: ChildProcessLike = {
      on(event: 'error' | 'close', cb: never) {
        handlers[event] = cb;
        return child;
      },
    };
    queueMicrotask(() => {
      if ('error' in outcome) handlers.error?.(Object.assign(new Error('spawn'), { code: outcome.error }));
      else handlers.close?.(outcome.code);
    });
    return child;
  };
  return { spawn, calls };
}

describe('Linux: xdg-email', () => {
  it('geeft alles als losse argumenten mee, zonder shell en byte voor byte', async () => {
    const { spawn, calls } = fakeSpawn({ code: 0 });
    const r = await spawnXdgEmail(msg, spawn);
    expect(r).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('xdg-email');
    expect(calls[0]!.args).toEqual(['--subject', msg.subject, '--body', msg.body, '--attach', msg.attachmentPath, msg.to]);
    // het onderwerp met aanhalingstekens en & komt als één argument aan
    expect(calls[0]!.args[1]).toBe('Factuur 2026-001 "test" & co');
    expect(buildXdgEmailArgs(msg)[0]).toBe('xdg-email');
  });

  it('spawnfout ENOENT is "geen mailprogramma"', async () => {
    expect(await spawnXdgEmail(msg, fakeSpawn({ error: 'ENOENT' }).spawn)).toEqual({ ok: false, reason: 'no-handler' });
  });

  it('een andere fout of een eindcode ongelijk aan 0 is "mislukt"', async () => {
    expect(await spawnXdgEmail(msg, fakeSpawn({ error: 'EACCES' }).spawn)).toEqual({ ok: false, reason: 'failed' });
    expect(await spawnXdgEmail(msg, fakeSpawn({ code: 3 }).spawn)).toEqual({ ok: false, reason: 'failed' });
    expect(await spawnXdgEmail(msg, fakeSpawn({ code: 1 }).spawn)).toEqual({ ok: false, reason: 'failed' });
  });

  it('een spawn die meteen een uitzondering geeft, loopt niet vast', async () => {
    const spawn: SpawnFn = () => {
      throw Object.assign(new Error('x'), { code: 'ENOENT' });
    };
    expect(await spawnXdgEmail(msg, spawn)).toEqual({ ok: false, reason: 'no-handler' });
  });
});

describe('Windows: Simple MAPI', () => {
  it('vertaalt de retourcodes', () => {
    expect(mapMapiResult(0)).toEqual({ ok: true });
    expect(mapMapiResult(1)).toEqual({ ok: false, reason: 'cancelled' });
    expect(mapMapiResult(2)).toEqual({ ok: false, reason: 'failed' });
    expect(mapMapiResult(3)).toEqual({ ok: false, reason: 'no-handler' });
    expect(mapMapiResult(999)).toEqual({ ok: false, reason: 'failed' });
  });

  it('geeft ontvanger, onderwerp, tekst en pad ongewijzigd door (met é en spaties)', async () => {
    const send = vi.fn(async () => 0);
    const mapi: MapiSender = { send };
    expect(await sendWithMapi(msg, mapi)).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith(msg);
  });

  it('geen te laden MAPI of koffi is "geen mailprogramma"; een fout tijdens de aanroep is "mislukt"', async () => {
    expect(await sendWithMapi(msg, null)).toEqual({ ok: false, reason: 'no-handler' });
    const kapot: MapiSender = { send: async () => { throw new Error('boem'); } };
    expect(await sendWithMapi(msg, kapot)).toEqual({ ok: false, reason: 'failed' });
  });

  it('kiest per platform de juiste route', async () => {
    const send = vi.fn(async () => 0);
    const { spawn, calls } = fakeSpawn({ code: 0 });
    await handOverToOwnMailProgram(msg, { platform: 'win32', spawn, mapi: { send } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
    await handOverToOwnMailProgram(msg, { platform: 'linux', spawn, mapi: { send } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });
});

describe('webmail', () => {
  it('Gmail en Outlook krijgen ontvanger, onderwerp en tekst netjes in de link', () => {
    const g = new URL(webmailUrl('gmail', msg));
    expect(g.origin).toBe('https://mail.google.com');
    expect(g.searchParams.get('to')).toBe(msg.to);
    expect(g.searchParams.get('su')).toBe(msg.subject);
    expect(g.searchParams.get('body')).toBe(msg.body);
    const o = new URL(webmailUrl('outlook', msg));
    expect(o.origin).toBe('https://outlook.office.com');
    expect(o.searchParams.get('to')).toBe(msg.to);
    expect(o.searchParams.get('subject')).toBe(msg.subject);
    expect(o.searchParams.get('body')).toBe(msg.body);
  });

  it('een heel lange tekst maakt de link niet onbruikbaar lang', () => {
    const url = webmailUrl('gmail', { ...msg, body: 'x'.repeat(50000) });
    expect(url.length).toBeLessThan(4000);
  });
});

/** Een administratie met een definitieve factuur, een eigen map voor de PDF en een nagebootste handler. */
function eigenMail(result: HandoverResult = { ok: true }) {
  const dir = mkdtempSync(join(tmpdir(), 'bvn-ownmail-'));
  const calls: OwnMailMessage[] = [];
  const t = setup({ ownMail: { pdfDir: dir, handOver: async (m) => (calls.push(m), result) } });
  const draft = t.s.invoices.createDraft({
    relationId: t.klant.id,
    invoiceDate: '2026-01-01',
    lines: [{ description: 'Stucwerk', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }],
  });
  return { ...t, calls, invoiceId: draft.id };
}

const sentAt = (t: ReturnType<typeof eigenMail>) => t.s.invoices.get(t.invoiceId).sent_at;

describe('versturen met je eigen mailprogramma: status en herinneringen', () => {
  it('geeft de mail door, laat de PDF staan en markeert niets als verzonden', async () => {
    const t = eigenMail({ ok: true });
    const r = await t.s.ownMail.sendInvoice(t.invoiceId);
    expect(r).toEqual({ ok: true });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.to).toBe('jansen@example.nl');
    expect(existsSync(t.calls[0]!.attachmentPath)).toBe(true); // niet meteen verwijderd
    expect(sentAt(t)).toBeNull();
    expect(t.s.invoices.get(t.invoiceId).reminder_count).toBe(0);
    expect(t.sent).toHaveLength(0); // niets via SMTP
  });

  it.each([
    [{ ok: false, reason: 'no-handler' }],
    [{ ok: false, reason: 'failed' }],
    [{ ok: false, reason: 'cancelled' }],
  ] as [HandoverResult][])('bij %j blijft de factuur ongemarkeerd en de PDF staan', async (result) => {
    const t = eigenMail(result);
    expect(await t.s.ownMail.sendInvoice(t.invoiceId)).toEqual(result);
    expect(sentAt(t)).toBeNull();
    expect(t.s.invoices.get(t.invoiceId).reminder_count).toBe(0);
    expect(existsSync(t.calls[0]!.attachmentPath)).toBe(true);
  });

  it('ook de webmail-route markeert niets; pas "Ja" doet dat', async () => {
    const t = eigenMail();
    const w = await t.s.ownMail.webmailInvoice(t.invoiceId, 'gmail');
    expect(w.url).toContain('mail.google.com');
    expect(existsSync(w.pdfPath)).toBe(true);
    expect(sentAt(t)).toBeNull();
    t.s.ownMail.confirmInvoiceSent(t.invoiceId);
    expect(sentAt(t)).not.toBeNull();
  });

  it('een offerte wordt ook pas na "Ja" verzonden', async () => {
    const t = eigenMail();
    const q = t.s.quotes.create({ relationId: t.klant.id, lines: [{ description: 'Stucwerk', quantity: 1, unitPrice: 10000, vatCode: 'hoog' }] });
    expect(await t.s.ownMail.sendQuote(q.id)).toEqual({ ok: true });
    expect(t.s.quotes.get(q.id).status).not.toBe('verzonden');
    t.s.ownMail.confirmQuoteSent(q.id);
    expect(t.s.quotes.get(q.id).status).toBe('verzonden');
  });

  it('de kopie bij de boekhouder en de demo blokkeren dit net als elke uitgaande mail', async () => {
    const t = eigenMail();
    t.s.settings.markOfficeCopy({ office: 'Kantoor De Vries', exchange: 3, endDate: '2026-09-30' });
    await expect(t.s.ownMail.sendInvoice(t.invoiceId)).rejects.toThrow(/Kantoor De Vries/);
    expect(() => t.s.ownMail.confirmInvoiceSent(t.invoiceId)).toThrow(/Kantoor De Vries/);
    expect(t.calls).toHaveLength(0);
    expect(sentAt(t)).toBeNull();
  });
});

describe('automatische herinneringen en het eigen mailprogramma', () => {
  function teLaat(t: ReturnType<typeof eigenMail>) {
    t.s.settings.update({ remindersEnabled: true, reminderDays: [7, 21] });
    t.s.invoices.finalize(t.invoiceId);
    t.s.invoices.markSent(t.invoiceId);
  }

  it('zonder SMTP gaat er niets uit, opent er nooit een mailvenster en staat de herinnering als taak op Vandaag', async () => {
    const t = eigenMail();
    teLaat(t);
    const r = await t.s.sender.runAutomaticReminders('2026-01-22');
    expect(r).toEqual({ sent: 0, failed: [] });
    expect(t.calls).toHaveLength(0); // handler nooit aangeroepen
    expect(t.sent).toHaveLength(0);
    expect(t.s.invoices.get(t.invoiceId).reminder_count).toBe(0);
    expect(t.s.sender.remindersNeedingYou('2026-01-22').map((i) => i.id)).toEqual([t.invoiceId]);
    const taak = t.s.inbox.tasks('2026-01-22').find((x) => x.key === `overdue-${t.invoiceId}`);
    expect(taak?.question).toMatch(/geen e-mailserver/);
    expect(taak?.actions.map((a) => a.id)).toEqual(['open']);
  });

  it('met SMTP gaat de herinnering via SMTP en nooit via het mailprogramma', async () => {
    const t = eigenMail();
    teLaat(t);
    t.s.settings.update({ smtp: { ...t.s.settings.get().smtp, host: 'smtp.example.nl' } });
    const r = await t.s.sender.runAutomaticReminders('2026-01-22');
    expect(r.sent).toBe(1);
    expect(t.sent).toHaveLength(1);
    expect(t.calls).toHaveLength(0);
    expect(t.s.sender.remindersNeedingYou('2026-01-22')).toEqual([]);
  });
});

describe('tijdelijke PDF in een map die ook een snap of flatpak ziet', () => {
  it('ruimt alleen mapjes op die ouder zijn dan 30 dagen, en laat verse staan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bvn-prune-'));
    const nu = Date.now();
    mkdirSync(join(dir, 'oud'));
    mkdirSync(join(dir, 'vers'));
    const veertigDagenGeleden = new Date(nu - 40 * 24 * 3600 * 1000);
    utimesSync(join(dir, 'oud'), veertigDagenGeleden, veertigDagenGeleden);
    pruneOldPdfs(dir, nu);
    expect(existsSync(join(dir, 'oud'))).toBe(false);
    expect(existsSync(join(dir, 'vers'))).toBe(true);
  });

  it('een map die nog niet bestaat geeft geen fout, en het schrijven maakt hem aan', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'bvn-nieuw-')), 'Documenten', 'Te versturen');
    expect(() => pruneOldPdfs(dir)).not.toThrow();
    const pad = writeTempPdf(dir, 'factuur-1', 'Factuur é 1.pdf', Buffer.from('x'));
    expect(existsSync(pad)).toBe(true);
  });
});

describe('Thunderbird als standaardmailprogramma (xdg-email laat daar de bijlage vallen)', () => {
  const tbMsg: OwnMailMessage = { ...msg, attachmentPath: '/home/piet/Documents/BoekhoudenVoorNiks/Te versturen/factuur-1/Factuur é.pdf' };

  it('geeft de bijlage als file://-adres mee, met alles gecodeerd', () => {
    const [flag, compose] = buildThunderbirdArgs(tbMsg);
    expect(flag).toBe('-compose');
    expect(compose).toContain("to='jansen@example.nl'");
    expect(compose).toContain(`subject='${msg.subject}'`);
    expect(compose).toContain(`body='${msg.body}'`);
    // het adres zoals Node het maakt (op Windows met een stationsletter; dit pad wordt alleen op Linux gebruikt)
    expect(compose).toContain(`attachment='${pathToFileURL(tbMsg.attachmentPath).href}'`);
    expect(compose).toContain('/Te%20versturen/factuur-1/Factuur%20%C3%A9.pdf');
  });

  it('kiest Thunderbird (ook als snap) rechtstreeks en xdg-email voor een ander standaardprogramma', async () => {
    const tb = fakeSpawn({ code: 0 });
    const r1 = await handOverToOwnMailProgram(tbMsg, { platform: 'linux', spawn: tb.spawn, mapi: null, mailHandler: async () => 'thunderbird_thunderbird.desktop' });
    expect(r1).toEqual({ ok: true });
    expect(tb.calls).toHaveLength(1);
    expect(tb.calls[0]!.cmd).toBe('thunderbird');
    expect(tb.calls[0]!.args[0]).toBe('-compose');

    const ice = fakeSpawn({ code: 0 });
    await handOverToOwnMailProgram(tbMsg, { platform: 'linux', spawn: ice.spawn, mapi: null, mailHandler: async () => 'icedove.desktop' });
    expect(ice.calls[0]!.cmd).toBe('icedove');

    const evo = fakeSpawn({ code: 0 });
    await handOverToOwnMailProgram(tbMsg, { platform: 'linux', spawn: evo.spawn, mapi: null, mailHandler: async () => 'org.gnome.Evolution.desktop' });
    expect(evo.calls).toHaveLength(1);
    expect(evo.calls[0]!.cmd).toBe('xdg-email');
  });

  it('is Thunderbird niet te starten, dan alsnog xdg-email; een onbekend standaardprogramma gaat ook naar xdg-email', async () => {
    const calls: string[] = [];
    const spawn: SpawnFn = (cmd, args) => {
      calls.push(cmd);
      return fakeSpawn(cmd === 'thunderbird' ? { error: 'ENOENT' } : { code: 0 }).spawn(cmd, args);
    };
    expect(await handOverToOwnMailProgram(tbMsg, { platform: 'linux', spawn, mapi: null, mailHandler: async () => 'thunderbird.desktop' })).toEqual({ ok: true });
    expect(calls).toEqual(['thunderbird', 'xdg-email']);

    const kapot = fakeSpawn({ code: 0 });
    await handOverToOwnMailProgram(tbMsg, { platform: 'linux', spawn: kapot.spawn, mapi: null, mailHandler: async () => { throw new Error('xdg-mime ontbreekt'); } });
    expect(kapot.calls[0]!.cmd).toBe('xdg-email');
  });

  it('een mailprogramma dat open blijft, telt als gelukt in plaats van de app te laten wachten', async () => {
    const spawn: SpawnFn = () => ({ on: function () { return this; } }) as ChildProcessLike;
    expect(await spawnXdgEmail(tbMsg, spawn, 20)).toEqual({ ok: true });
  });
});
