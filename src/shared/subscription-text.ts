import { formatDateNl, type IsoDate } from './dates';

/**
 * De tekst van het abonnement, op één plek: voor het abonnementsblok (renderer/screens/Exchange.tsx) en voor de
 * melding bij versturen zonder abonnement (license/license.ts).
 *
 * `phone`: is telefoon koppelen beschikbaar (shared/phone-scanner.ts)? Zo niet, dan noemt de tekst de telefoon
 * niet. Wie de tekst toont, geeft de schakelaar mee: het hoofdproces leest hem zelf, het scherm krijgt hem via
 * app.meta().
 */
export interface SubscriptionText {
  /** wat het abonnement vraagt, in één zin */
  lead: string;
  /** wat je ervoor krijgt, en wat altijd kan */
  body: string;
  /** de melding bij versturen naar de boekhouder zonder abonnement */
  refused: string;
  /** de melding bij versturen naar de boekhouder na een verlopen abonnement */
  expired: (validUntil: IsoDate) => string;
  /** bij de vraag "Abonnement opzeggen?": wat nog kan tot het eind van de betaalde periode */
  cancelling: string;
  /** de regel bij een opgezegd abonnement */
  cancelled: (validUntil: IsoDate) => string;
  /** de melding na het opzeggen */
  cancelledToast: (validUntil: IsoDate) => string;
}

const LEAD = 'Versturen naar je boekhouder is een extra functie van het abonnement.';
const LEAD_WITH_PHONE = 'Versturen naar je boekhouder, een telefoon koppelen en het bijwerken van klanten, projecten en btw-regels op je telefoon zijn extra functies van het abonnement.';

const WITHOUT_PHONE: SubscriptionText = {
  lead: LEAD,
  body: 'Met het abonnement steun je de verdere ontwikkeling en krijg je de extra functies. Koppelen, een antwoord inlezen en het pakket voor je boekhouder blijven gratis; alleen het versturen vraagt een abonnement.',
  refused: `${LEAD} Neem een abonnement, of haal je licentie op als je al betaald hebt; een antwoord inlezen kan altijd, en het pakket voor je boekhouder kun je altijd zelf sturen.`,
  expired: (validUntil) => `Je abonnement liep tot ${formatDateNl(validUntil)}. Verleng het om weer naar je boekhouder te versturen; een antwoord inlezen kan altijd.`,
  cancelling: 'Er wordt daarna niets meer afgeschreven. Je kunt nog naar je boekhouder versturen tot het eind van de maand waarvoor je betaald hebt; een antwoord inlezen kan altijd.',
  cancelled: (validUntil) => `Abonnement opgezegd: je kunt versturen t/m ${formatDateNl(validUntil)}; er wordt niets meer afgeschreven.`,
  cancelledToast: (validUntil) => `Opgezegd; versturen kan nog t/m ${formatDateNl(validUntil)}`,
};

const WITH_PHONE: SubscriptionText = {
  lead: LEAD_WITH_PHONE,
  body: 'Met het abonnement steun je de verdere ontwikkeling en krijg je de extra functies. Koppelen aan je boekhouder, een antwoord inlezen en het pakket voor je boekhouder blijven gratis, en wat een gekoppelde telefoon stuurt, komt altijd aan.',
  refused: `${LEAD_WITH_PHONE} Neem een abonnement, of haal je licentie op als je al betaald hebt; een antwoord inlezen kan altijd, wat een gekoppelde telefoon stuurt komt altijd aan, en het pakket voor je boekhouder kun je altijd zelf sturen.`,
  expired: (validUntil) =>
    `Je abonnement liep tot ${formatDateNl(validUntil)}. Verleng het om weer naar je boekhouder te versturen, een telefoon te koppelen en klanten, projecten en btw-regels op je telefoon bij te werken; een antwoord inlezen kan altijd, en wat een gekoppelde telefoon stuurt, komt altijd aan.`,
  cancelling:
    'Er wordt daarna niets meer afgeschreven. Je kunt nog naar je boekhouder versturen, een telefoon koppelen en klanten, projecten en btw-regels op je telefoon bijwerken tot het eind van de maand waarvoor je betaald hebt; een antwoord inlezen kan altijd, en wat een gekoppelde telefoon stuurt, komt altijd aan.',
  cancelled: (validUntil) => `Abonnement opgezegd: de extra functies werken t/m ${formatDateNl(validUntil)}; er wordt niets meer afgeschreven.`,
  cancelledToast: (validUntil) => `Opgezegd; de extra functies werken nog t/m ${formatDateNl(validUntil)}`,
};

export function subscriptionText(phone: boolean): SubscriptionText {
  return phone ? WITH_PHONE : WITHOUT_PHONE;
}
