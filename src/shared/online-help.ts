/**
 * Online hulp bij categorievoorstellen (JEV via de assistent-Worker in de privé-repo boekhoudenvoorniks-server, #132). Uit tot de JEV-meting klaar
 * is en de assistent-Worker draait (docs/jev-assistent.md, "Activeren"): anders kan een klant met een
 * abonnement iets aanzetten dat stil niets doet. Uit = de instelling is onzichtbaar, niet aan te zetten,
 * en een eerder aangezette instelling wordt genegeerd. Een object, zodat de tests het kunnen omzetten.
 */
export const ONLINE_HELP = { available: false };
