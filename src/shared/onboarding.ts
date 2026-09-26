import type { AppSettings } from '../settings/settings';

/**
 * De stappen van de onboarding, met een versie per stap. De onboarding werkt zichzelf bij:
 * - een nieuwe stap in een nieuwe versie van de app → bestaande gebruikers krijgen alléén die stap
 *   te zien (met `whatsNew` als uitleg), niet de hele onboarding opnieuw;
 * - een stap inhoudelijk gewijzigd → verhoog `version`; wie de oude versie zag, krijgt hem opnieuw;
 * - in beide gevallen overgeslagen als `satisfied` zegt dat de gegevens al compleet zijn.
 * Het scherm (renderer/screens/Onboarding.tsx) heeft per id de inhoud; de volgorde staat hier.
 */
export interface OnboardingStep {
  id: string;
  version: number;
  title: string;
  /** uitleg voor bestaande gebruikers die deze stap (of versie) nog niet zagen */
  whatsNew?: string;
  /** al in orde bij een bestaande gebruiker? Dan hoeft de stap niet opnieuw. */
  satisfied?: (s: AppSettings) => boolean;
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  { id: 'welkom', version: 1, title: 'Welkom', satisfied: (s) => !!s.profile.trade },
  { id: 'alleen', version: 1, title: 'Werk je alleen?', satisfied: () => true },
  { id: 'bedrijf', version: 1, title: 'Je bedrijf', satisfied: (s) => !!(s.company.name && s.company.address && s.company.city) },
  { id: 'btw', version: 1, title: 'BTW', satisfied: (s) => s.kor || !!s.company.vatNumber },
  { id: 'bank', version: 1, title: 'Bank', satisfied: (s) => !!s.company.iban },
  {
    id: 'automatisch',
    version: 1,
    title: 'Hoeveel mag de app zelf doen?',
    whatsNew: 'Nieuw: je kiest nu zelf hoeveel de app automatisch mag verwerken.',
  },
  { id: 'nummering', version: 1, title: 'Factuurnummers en afspraken', satisfied: () => true },
];

/**
 * Stappen die bestonden voordat de onboarding versies kreeg. Wie toen de onboarding afrondde,
 * heeft deze gezien; alles wat later bijkwam, krijgt hij alsnog te zien.
 */
const LEGACY_SEEN: Record<string, number> = { welkom: 1, alleen: 1, bedrijf: 1, btw: 1, bank: 1, nummering: 1 };

type OnboardingState = Pick<AppSettings, 'onboardingDone' | 'onboardingSteps'> & Partial<AppSettings>;

export function seenSteps(s: OnboardingState): Record<string, number> {
  const seen = s.onboardingSteps ?? {};
  if (s.onboardingDone && Object.keys(seen).length === 0) return LEGACY_SEEN;
  return seen;
}

/** Welke stappen moet deze gebruiker (nog) zien? Nieuwe gebruiker: alles. */
export function pendingSteps(s: OnboardingState, steps: OnboardingStep[] = ONBOARDING_STEPS): OnboardingStep[] {
  if (!s.onboardingDone) return steps;
  const seen = seenSteps(s);
  return steps.filter((st) => {
    if ((seen[st.id] ?? 0) >= st.version) return false;
    // nieuwe of gewijzigde stap waarvan de gegevens al kloppen: niet lastigvallen
    return !st.satisfied?.(s as AppSettings);
  });
}

/** Het bijgewerkte `onboardingSteps`-record nadat deze stappen gezien zijn. */
export function markSeen(s: OnboardingState, ids: string[], steps: OnboardingStep[] = ONBOARDING_STEPS): Record<string, number> {
  const next: Record<string, number> = { ...seenSteps(s) };
  for (const st of steps) if (ids.includes(st.id)) next[st.id] = st.version;
  // stappen die al in orde waren tellen ook als gezien, zodat ze niet later alsnog opduiken
  if (s.onboardingDone) for (const st of steps) if ((next[st.id] ?? 0) < st.version && st.satisfied?.(s as AppSettings)) next[st.id] = st.version;
  return next;
}

/** Is er iets nieuws voor een bestaande gebruiker (update van de app)? */
export function hasOnboardingUpdate(s: OnboardingState): boolean {
  return s.onboardingDone && pendingSteps(s).length > 0;
}
