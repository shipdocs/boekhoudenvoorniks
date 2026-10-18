import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { cliEnv, type CliRunner, type Workspace } from '../intake/ocr-cli';

let shellPath: Promise<string> | null = null;

/**
 * Het PATH zoals de gebruiker het in een terminal heeft (uit .bashrc/.zshrc/.profile: nvm, Homebrew…).
 * Een app die vanuit het menu start, krijgt dat niet mee. Eén keer gevraagd; lukt het niet, dan leeg.
 */
export function loginShellPath(): Promise<string> {
  if (process.platform === 'win32') return Promise.resolve('');
  shellPath ??= new Promise((resolve) => {
    execFile(process.env.SHELL || '/bin/sh', ['-ilc', 'env'], { timeout: 5_000, maxBuffer: 1_000_000, env: process.env }, (_e, stdout) => {
      // "env" werkt in elke shell (ook fish); een .bashrc die zelf iets print, staat er gewoon omheen
      const lines = String(stdout ?? '').split('\n').filter((l) => l.startsWith('PATH='));
      resolve(lines.pop()?.slice(5).trim() ?? '');
    });
  });
  return shellPath;
}

/** Een omgeving voor dit programma: ook het PATH van de login-shell, zodat "node" te vinden is. */
export async function cliEnvFor(cli: string): Promise<NodeJS.ProcessEnv> {
  return cliEnv(cli, process.env, await loginShellPath());
}

/** Start Claude Code of Codex zonder venster; stopt het na de tijdslimiet. */
export const nodeCliRunner: CliRunner = async (cmd, args, opts) => {
  // het PATH van de login-shell erachter: dan vindt "#!/usr/bin/env node" ook een Node uit nvm
  const extra = await loginShellPath();
  const env = extra ? { ...opts.env, PATH: [opts.env.PATH ?? '', extra].filter(Boolean).join(delimiter) } : opts.env;
  return run(cmd, args, { ...opts, env });
};

const run: CliRunner = (cmd, args, { cwd, input, timeoutMs, env }) =>
  new Promise((resolve) => {
    // Windows: een .cmd (npm) kan alleen via de shell; de argumenten zijn eenvoudige woorden zonder spaties
    const viaShell = process.platform === 'win32' && /\.cmd$/i.test(cmd);
    // via de shell: een leeg argument of een met spaties (bv. het pad naar de app) tussen aanhalingstekens
    const shellArgs = viaShell ? args.map((a) => (a === '' || /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
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
