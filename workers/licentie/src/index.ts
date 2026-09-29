import { handle, type Env } from './app';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, { fetch: (input, init) => fetch(input, init), today: () => new Date().toISOString().slice(0, 10) });
  },
} satisfies ExportedHandler<Env>;
