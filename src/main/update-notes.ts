import type { UpdateInfo } from 'electron-updater';

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
