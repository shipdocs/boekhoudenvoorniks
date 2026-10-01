/**
 * Telefoon koppelen voor de bonnenscanner (#48). De kant van de computer is af, maar de scanner-app voor
 * Android (#49) bestaat nog niet. Tot die er is staat koppelen uit: geen kaart of knop in Instellingen,
 * de api weigert te koppelen, en het ontvangstpunt en de mDNS-aankondiging starten nooit. De bonnenmap
 * staat hier los van en werkt gewoon.
 *
 * #49 zet dit op true. Een object, zodat de tests het kunnen omzetten (ze zetten het zelf aan).
 */
export const PHONE_SCANNER = { available: false };
