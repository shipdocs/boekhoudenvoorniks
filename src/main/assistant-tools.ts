import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter } from 'node:path';
import { CLI_LABELS, claudeBaseArgs, cliEnv, codexBaseArgs, extractJson, friendlyCliError, type CliKind } from '../intake/ocr-cli';
import { cliEnvFor, nodeCliRunner, tempWorkspace } from './cli-runner';

/** Bestaat dit programma nog (de gebruiker kan het verwijderd of verplaatst hebben)? */
export function programExists(path: string | null | undefined): path is string {
  if (!path) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Werkt het? Een heel klein proefverzoek ("antwoord met ok"): dan weten we dat het programma start,
 * de gebruiker is ingelogd en het abonnement het toelaat. Kost een fractie van een bericht.
 */
export async function checkCli(kind: CliKind, cli: string): Promise<string> {
  const dir = await tempWorkspace.create([]);
  try {
    const args = kind === 'claude-code'
      ? [...claudeBaseArgs('haiku', ''), '--max-turns', '1']
      : [...codexBaseArgs(), '-'];
    const r = await nodeCliRunner(cli, args, { cwd: dir, input: 'Antwoord alleen met het woord: ok', timeoutMs: 90_000, env: cliEnv(cli) });
    if (r.timedOut || r.code !== 0) throw friendlyCliError(kind, r);
    if (kind === 'claude-code') {
      const w = extractJson(r.stdout) as { is_error?: boolean } | null;
      if (!w || w.is_error) throw friendlyCliError(kind, r);
    }
    return `${CLI_LABELS[kind].name} werkt ✓`;
  } finally {
    await tempWorkspace.remove(dir).catch(() => undefined);
  }
}

/**
 * Een terminal openen met Claude Code of Codex erin, om in te loggen. Per systeem anders; lukt het
 * niet, dan zegt de melding wat de gebruiker zelf kan typen.
 */
export async function openLoginTerminal(kind: CliKind, cli: string, platform: string = process.platform): Promise<string> {
  const { name } = CLI_LABELS[kind];
  const manual = `Open zelf een terminal en typ: ${kind === 'claude-code' ? 'claude' : 'codex'}`;
  const env = await cliEnvFor(cli);
  const detached = (cmd: string, args: string[], opts: { shell?: boolean } = {}) =>
    new Promise<boolean>((resolve) => {
      try {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env, shell: opts.shell ?? false, windowsHide: false });
        child.once('error', () => resolve(false));
        child.once('spawn', () => {
          child.unref();
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });
  let ok = false;
  if (platform === 'win32') {
    ok = await detached('cmd.exe', ['/c', 'start', '""', 'cmd', '/k', `"${cli}"`], { shell: false });
  } else if (platform === 'darwin') {
    const script = `tell application "Terminal" to do script "${cli.replace(/(["\\\\])/g, '\\\\$1')}"`;
    ok = await detached('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate']);
  } else {
    // Linux: de eerste terminal die er is
    const candidates: [string, string[]][] = [
      ['x-terminal-emulator', ['-e', cli]],
      ['gnome-terminal', ['--', cli]],
      ['konsole', ['-e', cli]],
      ['xfce4-terminal', ['-x', cli]],
      ['kitty', [cli]],
      ['alacritty', ['-e', cli]],
      ['xterm', ['-e', cli]],
    ];
    const pathDirs = (env.PATH ?? '').split(delimiter);
    for (const [term, args] of candidates) {
      if (!pathDirs.some((d) => existsSync(`${d}/${term}`))) continue;
      ok = await detached(term, args);
      if (ok) break;
    }
  }
  if (!ok) throw new Error(`Een terminal openen lukte niet. ${manual}`);
  return `${name} is geopend in een terminal. Log daar in (volg de stappen in je browser) en klik daarna hier op "Controleer".`;
}
