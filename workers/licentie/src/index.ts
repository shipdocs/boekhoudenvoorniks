import { WorkerEntrypoint } from 'cloudflare:workers';
import { authorizeAssistant, handle, type AssistantAuthorization, type Env, type LicenseDb } from './app';

// De echte D1-binding moet passen op wat app.ts gebruikt (en wat de tests nabootsen).
type D1Fits = D1Database extends LicenseDb ? true : never;
const d1Fits: D1Fits = true;
void d1Fits;

/**
 * Alleen bereikbaar via een Service Binding (workers/assistent), niet via internet: controleert of een
 * administratie de online hulp mag gebruiken en telt de aanroep mee voor het dagquotum.
 */
export class Controle extends WorkerEntrypoint<Env> {
  assistent(input: { administratie: string; managementKey: string; today: string; dailyLimit: number }): Promise<AssistantAuthorization> {
    return authorizeAssistant(this.env, input);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, { fetch: (input, init) => fetch(input, init), today: () => new Date().toISOString().slice(0, 10) });
  },
} satisfies ExportedHandler<Env>;
