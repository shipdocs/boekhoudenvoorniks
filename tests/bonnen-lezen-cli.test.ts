import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { CliAiProvider, extractJson, findCli, toOcrOutput, type CliRunner, type Workspace } from '../src/intake/ocr-cli';
import { setup } from './helpers';

const ANSWER = {
  tekst: ['GAMMA Zwolle', 'Datum 12-09-2026', 'Totaal 121,00'],
  soort: 'bon',
  leverancier: 'Gamma',
  btw_nummer: 'NL001234567B01',
  factuurnummer: 'B-123',
  datum: '2026-09-12',
  valuta: 'EUR',
  totaal: 121,
  subtotaal: 100,
  btw: [{ tarief: 21, grondslag: 100, bedrag: 21 }, { tarief: 17, bedrag: 3 }],
  btw_verlegd: false,
  regels: [{ omschrijving: 'Schroeven', aantal: 2, prijs: 10, bedrag: 20, tarief: 21 }, { omschrijving: '', bedrag: 5 }],
};

function fakeWorkspace(files: Record<string, string> = {}): Workspace & { removed: number; created: { name: string; data: Uint8Array }[] } {
  const ws = {
    removed: 0,
    created: [] as { name: string; data: Uint8Array }[],
    async create(f: { name: string; data: Uint8Array }[]) { ws.created.push(...f); return '/tmp/gb-test'; },
    async read(_dir: string, name: string) { return files[name] ?? null; },
    async remove() { ws.removed++; },
  };
  return ws;
}

describe('bonnen lezen met Claude Code of Codex', () => {
  it('antwoord naar het vaste formaat: streng, alleen wat klopt', () => {
    const out = toOcrOutput(ANSWER, 'ocr:claude-code');
    expect(out.items.map((i) => i.text)).toEqual(ANSWER.tekst);
    expect(out.structured?.supplier?.value).toBe('Gamma');
    expect(out.structured?.invoiceDate?.value).toBe('2026-09-12');
    expect(out.structured?.total?.value).toBe(12100);
    expect(out.structured?.vat?.value).toEqual([{ rate: 21, base: 10000, amount: 2100 }]); // 17% bestaat niet in NL
    expect(out.structured?.lines?.map((l) => l.value.description)).toEqual(['Schroeven']);
    expect(out.structured?.documentType?.value).toBe('receipt');
    expect(toOcrOutput({ datum: '2026-02-30', totaal: 'veel' }, 'ocr:codex').structured?.invoiceDate).toBeUndefined();
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('geen json')).toBeNull();
  });

  it('Claude Code: alleen lezen, opdracht via stdin, werkmap opgeruimd', async () => {
    let call: { cmd: string; args: string[]; input: string } | null = null;
    const runner: CliRunner = async (cmd, args, opts) => {
      call = { cmd, args, input: opts.input };
      return { code: 0, stdout: JSON.stringify({ type: 'result', is_error: false, result: `Hier is het:\n${JSON.stringify(ANSWER)}` }), stderr: '', timedOut: false };
    };
    const ws = fakeWorkspace();
    const p = new CliAiProvider('claude-code', '/usr/bin/claude', runner, ws);
    const out = await p.recognize({ data: new Uint8Array([1, 2]), mimeType: 'image/jpeg', filename: 'bon.jpg' });
    expect(out.structured?.total?.value).toBe(12100);
    expect(call!.args).toContain('--allowedTools');
    expect(call!.args[call!.args.indexOf('--allowedTools') + 1]).toBe('Read');
    expect(call!.args).toContain('--strict-mcp-config');
    expect(call!.args).toContain('Bash'); // expliciet verboden
    expect(call!.input).toContain('document.jpg');
    expect(ws.created.map((f) => f.name)).toEqual(['document.jpg']);
    expect(ws.removed).toBe(1);
  });

  it('Codex: sandbox read-only, antwoord uit het bestand; geen PDF', async () => {
    let args: string[] = [];
    const runner: CliRunner = async (_cmd, a) => { args = a; return { code: 0, stdout: 'log…', stderr: '', timedOut: false }; };
    const p = new CliAiProvider('codex', '/usr/bin/codex', runner, fakeWorkspace({ 'antwoord.txt': JSON.stringify(ANSWER) }));
    const out = await p.recognize({ data: new Uint8Array([1]), mimeType: 'image/png', filename: 'bon.png' });
    expect(out.structured?.supplier?.value).toBe('Gamma');
    expect(args.slice(0, 5)).toEqual(['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--color']);
    expect(args).toContain('--image');
    await expect(p.recognize({ data: new Uint8Array([1]), mimeType: 'application/pdf', filename: 'scan.pdf' })).rejects.toThrow(/alleen foto/);
  });

  it('fouten in gewone taal', async () => {
    const fail = (stderr: string, timedOut = false): CliRunner => async () => ({ code: timedOut ? null : 1, stdout: '', stderr, timedOut });
    const read = (r: CliRunner) => new CliAiProvider('claude-code', '/x/claude', r, fakeWorkspace()).recognize({ data: new Uint8Array([1]), mimeType: 'image/jpeg', filename: 'b.jpg' });
    await expect(read(fail('Invalid API key · Please run /login'))).rejects.toThrow(/niet ingelogd/);
    await expect(read(fail('', true))).rejects.toThrow(/te lang/);
    await expect(read(fail('usage limit reached'))).rejects.toThrow(/limiet/);
    await expect(read(fail('iets anders'))).rejects.toThrow(/kon deze bon niet lezen/);
  });

  it('vinden: PATH en gebruikelijke plekken; Windows .cmd', () => {
    const exists = (p: string) => p === join('/home/jan', '.local', 'bin', 'claude') || p === join('C:\\npm', 'codex.cmd');
    expect(findCli('claude-code', { PATH: '/usr/bin', HOME: '/home/jan' }, 'linux', exists)).toBe(join('/home/jan', '.local', 'bin', 'claude'));
    expect(findCli('codex', { PATH: '/usr/bin', HOME: '/home/jan' }, 'linux', exists)).toBeNull();
    expect(findCli('codex', { PATH: 'C:\\npm', USERPROFILE: 'C:\\Users\\jan' }, 'win32', exists)).toBe(join('C:\\npm', 'codex.cmd'));
  });

  it('bonnen die nog niet gelezen zijn: opnieuw lezen na het kiezen, nooit zelf boeken', async () => {
    const { s } = setup();
    s.settings.update({ onboardingDone: true, autopilot: 'maximaal' });
    const doc = await s.intake.add('bon.jpg', new Uint8Array([9, 9, 9]), '2026-09-20');
    expect(doc.extraction_source).toBe('geen');
    expect(s.intake.unread().map((d) => d.id)).toEqual([doc.id]);
    s.intake.setOcrProvider({ id: 'claude-code', label: 'test', available: async () => true, recognize: async () => toOcrOutput(ANSWER, 'ocr:claude-code') });
    const after = await s.intake.reread(doc.id, new Uint8Array([9, 9, 9]), '2026-09-20');
    expect(after.extraction_source).toBe('ocr:claude-code');
    expect(after.result?.supplier?.value).toBe('Gamma');
    expect(after.status).not.toBe('verwerkt');
    expect(s.intake.unread()).toEqual([]);
  });
});
