import type { Api } from '../main/api';

type Fn = (...args: never[]) => unknown;
type Remote<T> = {
  [NS in keyof T]: { [M in keyof T[NS]]: T[NS][M] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never };
};

declare global {
  interface Window {
    bridge: {
      call(method: string, args: unknown[]): Promise<unknown>;
      onEvent(listener: (event: string, payload: unknown) => void): () => void;
    };
  }
}

function cleanError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(msg.replace(/^Error invoking remote method 'api': (\w*Error: )?/, ''));
}

/** Getypeerde client: api.invoices.list(...) → IPC → main/api.ts */
export const api = new Proxy({} as Remote<Api>, {
  get(_t, ns: string) {
    return new Proxy({}, {
      get(_u, method: string) {
        return async (...args: unknown[]) => {
          try {
            return await window.bridge.call(`${ns}.${method}`, args);
          } catch (e) {
            throw cleanError(e);
          }
        };
      },
    });
  },
});

export type { Api };
export type Unused = Fn;
