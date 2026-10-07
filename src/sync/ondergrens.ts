/**
 * De gedeelde ondergrens voor velden zonder rij in relation_field_rev (of job_field_rev): klanten en
 * klussen van vóór de sync hebben geen tijd per veld. Hun velden gelden als gewijzigd op het moment
 * dat de rij is aangemaakt, door de pc. Zo overschrijft een oudere wijziging van een telefoon geen
 * gegevens die al op de pc stonden. Dit is de enige plek waar die ondergrens wordt afgeleid.
 *
 * created_at is de tekst die SQLite zelf schrijft (datetime('now')): UTC, in de vorm
 * JJJJ-MM-DD UU:MM:SS, zonder T of Z. Date.parse leest zo'n tekst als lokale tijd; daarom wordt hier
 * expliciet als UTC gelezen. Het resultaat is in milliseconden sinds 1-1-1970 UTC.
 */
export function veldOndergrens(createdAt: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z?$/.exec(createdAt.trim());
  if (!m) throw new Error(`Dit aanmaakmoment is geen UTC-tijd van SQLite (JJJJ-MM-DD UU:MM:SS): ${createdAt}`);
  const [jaar, maand, dag, uur, minuut, seconde] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  return Date.UTC(jaar, maand - 1, dag, uur, minuut, seconde);
}
