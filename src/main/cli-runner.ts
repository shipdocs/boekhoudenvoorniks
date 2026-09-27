import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliRunner, Workspace } from '../intake/ocr-cli';

/** Start Claude Code of Codex zonder venster; stopt het na de tijdslimiet. */
export const nodeCliRunner: CliRunner = (cmd, args, { cwd, input, timeoutMs, env }) =>
  new Promise((resolve) => {
    // Windows: een .cmd (npm) kan alleen via de shell; de argumenten zijn eenvoudige woorden zonder spaties
    const viaShell = process.platform === 'win32' && /\.cmd$/i.test(cmd);
    // via de shell: een argument met spaties (bv. het pad naar de app) tussen aanhalingstekens
    const shellArgs = viaShell ? args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
    const child = spawn(viaShell ? `"${cmd}"` : cmd, shellArgs, { cwd, env, shell: viaShell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const limit = 5_000_000;
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < limit) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < limit) stderr += d.toString('utf8'); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${e.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });

/** Een lege map in de tijdelijke map van het systeem, met alleen het document erin. */
export const tempWorkspace: Workspace = {
  async create(files) {
    const dir = await mkdtemp(join(tmpdir(), 'gb-bon-'));
    for (const f of files) await writeFile(join(dir, f.name), f.data);
    return dir;
  },
  async read(dir, name) {
    try {
      return await readFile(join(dir, name), 'utf8');
    } catch {
      return null;
    }
  },
  async remove(dir) {
    await rm(dir, { recursive: true, force: true });
  },
};
