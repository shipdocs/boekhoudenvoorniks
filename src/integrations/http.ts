import type { FetchLike } from './types';

export async function getJson<T>(fetchImpl: FetchLike, url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json', ...headers } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const host = new URL(url).host;
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Koppeling met ${host} mislukt: controleer de sleutel of het wachtwoord (fout ${res.status})`);
    }
    if (/^\s*<(!doctype|html)/i.test(body)) {
      const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1]?.trim();
      throw new Error(`Koppeling met ${host} mislukt (fout ${res.status}): de server van de aanbieder geeft een foutpagina${title ? ` ("${title}")` : ''}. Dit ligt meestal aan de aanbieder; probeer het later opnieuw.`);
    }
    throw new Error(`Koppeling met ${host} mislukt (fout ${res.status}): ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export function basicAuth(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}
