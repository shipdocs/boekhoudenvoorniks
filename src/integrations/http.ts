import type { FetchLike } from './types';

export async function getJson<T>(fetchImpl: FetchLike, url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json', ...headers } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} bij ${new URL(url).host}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}
