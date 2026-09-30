import { handle, type Env } from './app';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env, { today: () => new Date().toISOString().slice(0, 10), now: () => Date.now() });
  },
} satisfies ExportedHandler<Env>;
