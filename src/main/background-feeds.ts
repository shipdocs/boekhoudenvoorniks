import type { Services } from '../services';
import { BANK_FEED } from '../shared/bank-feed';

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
  // De releasevlag blijft uit tot de echte-bankproef klaar is. In die toestand doet de
  // bestaande achtergrondtaak niets met Ponto en produceert zij ook geen verwachte foutlog.
  if (BANK_FEED.available) {
    try {
      await services.bankFeed.round();
    } catch {
      // Ook een onverwacht geworpen object of Error.message kan providerdata bevatten.
      log('Bankfeed ophalen mislukt', 'De bankfeedronde kon niet worden uitgevoerd.');
    }
  }
}
