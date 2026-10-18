import type { UpdateInfo } from 'electron-updater';

/**
 * Foutmelding van electron-updater in gewone taal. Een nieuwe release staat al op GitHub terwijl de
 * bestanden nog geüpload worden (latest*.yml ontbreekt dan), en zonder internet komt er een netwerkfout.
 */
export function updateErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Cannot find latest[\w-]*\.yml|\b404\b/i.test(msg)) return 'De nieuwe versie wordt nog klaargezet. Probeer het over een kwartier opnieuw.';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|net::ERR_/i.test(msg)) return 'Geen verbinding met GitHub. Controleer je internetverbinding en probeer het later opnieuw.';
  return `Zoeken naar updates lukte niet: ${msg.split('\n')[0]}`;
}

/** Releasetekst van GitHub (HTML of lijst per versie) als platte tekst: nooit HTML in de app zetten. */
export function notesAsText(notes: UpdateInfo['releaseNotes']): string | null {
  if (!notes) return null;
  const html = typeof notes === 'string' ? notes : notes.map((n) => `${n.version}\n${n.note ?? ''}`).join('\n\n');
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|li|h\d|div)>|<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
