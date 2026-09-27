import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { openDatabase, openReadonly } from '../src/db/database';
import { createServices, MemorySecretStore } from '../src/services';
import { bookkeepingTools, handleMessage, runStdio } from '../src/mcp/server';

const deps = { pdf: async () => Buffer.from(''), mailerFactory: async () => { throw new Error('x'); }, secrets: new MemorySecretStore(), fetch: async () => { throw new Error('x'); }, storeFile: async () => '/tmp/x' };

/** Een echte administratie op schijf, daarna alleen-lezen geopend: zoals bij Claude Code/Codex. */
function readonlyServices() {
  const file = join(mkdtempSync(join(tmpdir(), 'gb-mcp-')), 'boekhouding.sqlite');
  const rw = openDatabase(file);
  const s = createServices(rw, deps);
  s.settings.update({ onboardingDone: true, vatPeriod: 'kwartaal', company: { ...s.settings.get().company, name: 'Piet', address: 'Kalkweg 1', postcode: '1234 AB', city: 'Utrecht', kvkNumber: '12345678', vatNumber: 'NL123456789B01', iban: 'NL91ABNA0417164300' } });
  const klant = s.relations.create({ name: 'Bakkerij Jansen', country: 'NL', address: 'Dorpsstraat 1', postcode: '1234 AB', city: 'Utrecht' });
  s.invoices.finalize(s.invoices.createDraft({ relationId: klant.id, invoiceDate: '2026-09-10', lines: [{ description: 'Stucwerk', quantity: 1, unitPrice: 100000, vatCode: 'hoog' }] }).id);
  s.bank.import({ source: 'csv', warnings: [], transactions: [{ date: '2026-09-12', amount: -6050, description: 'Gamma', counterName: 'GAMMA' }] });
  rw.close();
  const ro = openReadonly(file);
  return { s: createServices(ro, deps), ro };
}

describe('koppeling voor Claude Code/Codex (MCP, alleen lezen)', () => {
  it('elk hulpmiddel werkt op een alleen-lezen database', () => {
    const { s } = readonlyServices();
    const tools = bookkeepingTools(s, () => '2026-09-27');
    for (const t of tools) {
      const res = handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: t.name, arguments: t.name === 'zoeken' ? { tekst: 'Jansen' } : t.name === 'btw_details' ? { vak: '1a' } : {} } }, tools, '0.3.8');
      const result = (res as { result: { isError?: boolean; content: { text: string }[] } }).result;
      expect(result.isError, `${t.name}: ${result.content[0]!.text}`).toBeFalsy();
    }
    const btw = JSON.parse((handleMessage({ id: 2, method: 'tools/call', params: { name: 'btw_periode', arguments: { periode: '2026-Q3' } } }, tools, 'x') as { result: { content: { text: string }[] } }).result.content[0]!.text);
    expect(btw.rubrieken.find((r: { code: string }) => r.code === '1a').omzet).toBe(100000);
  });

  it('kan echt niets schrijven', () => {
    const { s } = readonlyServices();
    expect(() => s.relations.create({ name: 'Nieuw' })).toThrow(/readonly/i);
  });

  it('protocol: initialize, tools/list, notificaties, onbekend', () => {
    const tools = bookkeepingTools(readonlyServices().s);
    const init = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, tools, '0.3.8') as { result: { serverInfo: { name: string }; instructions: string; capabilities: object } };
    expect(init.result.serverInfo.name).toBe('gratis-boekhouden');
    expect(init.result.instructions).toMatch(/alleen lezen/);
    expect(init.result.instructions).toMatch(/boekhouder/);
    expect(handleMessage({ method: 'notifications/initialized' }, tools, 'x')).toBeNull();
    const list = handleMessage({ id: 2, method: 'tools/list' }, tools, 'x') as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } };
    expect(list.result.tools.map((t) => t.name)).toContain('btw_periode');
    expect(list.result.tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
    expect((handleMessage({ id: 3, method: 'resources/list' }, tools, 'x') as { error: { code: number } }).error.code).toBe(-32601);
    expect((handleMessage({ id: 4, method: 'tools/call', params: { name: 'boeken' } }, tools, 'x') as { error: { code: number } }).error.code).toBe(-32602);
  });

  it('over stdin/stdout, regel voor regel', async () => {
    const tools = bookkeepingTools(readonlyServices().s);
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (d) => (out += d));
    const done = runStdio(input, output, tools, 'x');
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    input.write('kapot\n');
    input.end('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await done;
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Ongeldige JSON' } }]);
  });

  it('andere versie van de database: eerst de app openen', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gb-mcp-')), 'oud.sqlite');
    const rw = openDatabase(file);
    rw.pragma('user_version = 1');
    rw.close();
    expect(() => openReadonly(file)).toThrow(/Open Gratis Boekhouden eerst/);
  });
});
