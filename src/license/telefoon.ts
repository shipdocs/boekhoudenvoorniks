import { formatDateNl, type IsoDate } from '../shared/dates';
import { ValidationError } from '../shared/validation';
import type { LicenseStatus } from './license';

/**
 * De koppeling met de telefoon en het abonnement: de regel staat hier, op één plek.
 *
 * Een nieuwe telefoon koppelen en gegevens naar de telefoon sturen (klanten, projecten, de btw-regels en de
 * bedrijfsgegevens) horen bij het abonnement. Wat een gekoppelde telefoon stuurt (bonnen, foto's, klanten,
 * projecten en facturen) wordt altijd aangenomen en bevestigd, met of zonder abonnement: dat vraagt deze regel
 * nooit op.
 *
 * De toets is offline: ze kijkt alleen naar de toestand van de licentie zoals LicenseService.status() die
 * afleidt uit wat al in de administratie staat. Hier wordt nooit een verbinding gemaakt.
 */
export interface TelefoonAbonnement {
  /** mogen een nieuwe telefoon koppelen en gegevens naar de telefoon sturen? */
  toegestaan: boolean;
  /** bij een verlopen abonnement: de laatste dag waarop het gold; anders null */
  verlopenOp: IsoDate | null;
}

/**
 * Toegestaan bij een actief abonnement, en als licenties uit staan (er is geen sleutel om ze te controleren,
 * zoals in tests en ontwikkelbuilds). Niet toegestaan zonder abonnement, bij een verlopen abonnement en bij een
 * licentie die niet klopt.
 */
export function telefoonAbonnement(status: LicenseStatus): TelefoonAbonnement {
  return {
    toegestaan: status.state === 'uit' || status.state === 'actief',
    verlopenOp: status.state === 'verlopen' ? status.validUntil : null,
  };
}

/** De uitleg bij een niet toegestaan abonnement (voor de weigering bij het koppelen); null als het is toegestaan. */
export function telefoonAbonnementMelding(a: TelefoonAbonnement): string | null {
  if (a.toegestaan) return null;
  const altijd = 'Wat een gekoppelde telefoon stuurt, komt altijd aan.';
  if (a.verlopenOp) return `Je abonnement liep tot ${formatDateNl(a.verlopenOp)}. Verleng het om een telefoon te koppelen en om klanten, projecten en btw-regels op je telefoon bij te werken. ${altijd}`;
  return `Een telefoon koppelen en het bijwerken van klanten, projecten en btw-regels op je telefoon horen bij het abonnement. Neem een abonnement, of haal je licentie op als je al betaald hebt. ${altijd}`;
}

/** Voor een nieuwe koppeling: gooit met de uitleg als het abonnement dat niet toestaat. */
export function eisTelefoonAbonnement(a: TelefoonAbonnement): void {
  const melding = telefoonAbonnementMelding(a);
  if (melding) throw new ValidationError(melding);
}
