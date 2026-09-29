import { existsSync } from 'node:fs';
import { openReadonly } from '../db/database';
import { createServices } from '../services';
import { bookkeepingTools, runStdio } from './server';

const readonlyError = async (): Promise<never> => {
  throw new Error('Dit kan alleen in de app zelf (de koppeling kan alleen lezen).');
};

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
  await runStdio(process.stdin, process.stdout, bookkeepingTools(services), version);
  db.close();
}
