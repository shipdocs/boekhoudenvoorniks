import type { Services } from '../services';

/** Het feedblok van de bestaande start-/zesuurstaak; geen eigen planning of lock. */
export async function runBackgroundFeeds(
  services: Pick<Services, 'integrations' | 'bankFeed'>,
  emit: (event: string, payload: unknown) => void,
  log: (...args: unknown[]) => void,
): Promise<void> {
  try {
    const results = await services.integrations.syncAllEnabled();
    if (Object.keys(results).length > 0) emit('integrations', results);
  } catch (e) {
    log('Synchronisatie mislukt', e);
  }
  try {
    await services.bankFeed.round();
  } catch {
    // Ook een onverwacht geworpen object of Error.message kan providerdata bevatten.
    log('Bankfeed ophalen mislukt', 'De bankfeedronde kon niet worden uitgevoerd.');
  }
}
