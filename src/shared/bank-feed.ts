/**
 * Ponto-bankfeed (WP1, #243). De kant van de app is nog niet af: tot de koppeling zelf er is
 * (WP2 en verder) staat de vlag uit. Zolang hij uit staat: geen kaart of knop in het scherm,
 * en `bank_feed_accounts` blijft leeg. WP2 zet dit op true. Een object, zodat de tests het
 * kunnen omzetten (ze zetten het zelf aan).
 */
export const BANK_FEED = { available: false };

/**
 * De sleutels van de Ponto-credentials in de veilige opslag, hier alleen als contract gereserveerd
 * (WP2 leest en schrijft ze). Beide zijn geheimen: ze komen nooit in `integrations.config` en
 * nooit in een klantkopie (`sanitizeForExchange` wist de hele `secrets`-tabel).
 */
export const BANK_FEED_SECRET_KEYS = {
  clientId: 'bankfeed:ponto:clientId',
  clientSecret: 'bankfeed:ponto:clientSecret',
} as const;
