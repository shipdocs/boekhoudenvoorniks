import { createReadStream, existsSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { openReadonly } from '../db/database';
import { createServices } from '../services';
import { bookkeepingTools, runStdio } from './server';

const readonlyError = async (): Promise<never> => {
  throw new Error('Dit kan alleen in de app zelf (de koppeling kan alleen lezen).');
};

/**
 * Waar de berichten van Claude Code/Codex binnenkomen. Op Windows is `process.stdin` in het hoofdproces
 * van Electron een lege stroom die meteen eindigt (de app is een vensterprogramma); het kanaal zelf
 * (fd 0) is wel gewoon de pijp van het programma dat de koppeling startte.
 */
export function mcpInput(platform: NodeJS.Platform = process.platform): Readable {
  return platform === 'win32' ? createReadStream('', { fd: 0 }) : process.stdin;
}

/**
 * Start de koppeling voor Claude Code/Codex op stdin/stdout. Alles wat anders naar stdout zou gaan
 * (console.log) gaat naar stderr: stdout is alleen voor het protocol.
 */
export async function startMcp(dbFile: string, version: string): Promise<void> {
  console.log = console.info = console.warn = (...a: unknown[]) => process.stderr.write(`${a.map(String).join(' ')}\n`);
  if (!existsSync(dbFile)) throw new Error('Nog geen administratie gevonden. Open BoekhoudenVoorNiks eerst één keer.');
  const db = openReadonly(dbFile);
  const services = createServices(db, {
    pdf: readonlyError,
    mailerFactory: readonlyError,
    secrets: { get: () => null, set: () => undefined, delete: () => undefined },
    fetch: readonlyError as never,
    storeFile: readonlyError,
  });
  await runStdio(mcpInput(), process.stdout, bookkeepingTools(services), version);
  db.close();
}
