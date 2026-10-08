/**
 * Online hulp bij categorievoorstellen (JEV via de assistent-Worker in de privé-repo boekhoudenvoorniks-server, #132).
 * Aan sinds 0.7.4 (meting in issue #168). Zet op false als de assistent-Worker uit moet en de
 * instelling niet te zien mag zijn; de kill switch van de Worker (ENABLED) is de snelle weg. Uit = de instelling is onzichtbaar, niet aan te zetten,
 * en een eerder aangezette instelling wordt genegeerd. Een object, zodat de tests het kunnen omzetten.
 */
export const ONLINE_HELP = { available: true };
