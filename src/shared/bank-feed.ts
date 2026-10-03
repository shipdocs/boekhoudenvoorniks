/**
 * Ponto-bankfeed (WP1, #243). Aan sinds versie 1.2.0, na de geslaagde proef van #252. Staat hij
 * uit (de tests zetten hem om): geen kaart of knop in het scherm, geen netwerk en
 * `bank_feed_accounts` blijft leeg. Ook met de vlag aan blijven demo-modus, een geblokkeerd
 * netwerk, alleen-bekijken en een kantoorkopie de bankfeed buiten beeld houden. Een object, zodat
 * de tests het kunnen omzetten.
 */
export const BANK_FEED = { available: true };

/**
 * De sleutels van de Ponto-credentials in de veilige opslag, hier alleen als contract gereserveerd
 * (WP4A, #246 leest en schrijft ze later). Beide zijn geheimen: ze komen nooit in
 * `integrations.config` en nooit in een klantkopie (`sanitizeForExchange` wist de hele
 * `secrets`-tabel).
 */
export const BANK_FEED_SECRET_KEYS = {
  clientId: 'bankfeed:ponto:clientId',
  clientSecret: 'bankfeed:ponto:clientSecret',
} as const;
