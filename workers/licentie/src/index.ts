import { handle, type Env, type LicenseDb } from './app';

// De echte D1-binding moet passen op wat app.ts gebruikt (en wat de tests nabootsen).
type D1Fits = D1Database extends LicenseDb ? true : never;
const d1Fits: D1Fits = true;
void d1Fits;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, { fetch: (input, init) => fetch(input, init), today: () => new Date().toISOString().slice(0, 10) });
  },
} satisfies ExportedHandler<Env>;
