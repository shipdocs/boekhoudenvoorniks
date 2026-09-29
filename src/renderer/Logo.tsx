import primairKleur from './assets/logo-primair-kleur.svg';
import primairWit from './assets/logo-primair-wit.svg';
import gestapeldKleur from './assets/logo-gestapeld-kleur.svg';
import gestapeldWit from './assets/logo-gestapeld-wit.svg';

const VARIANTS = {
  /** beeldmerk met de naam op twee regels (zijbalk) */
  primair: { light: primairKleur, dark: primairWit, ratio: 165 / 632 },
  /** beeldmerk boven de naam (welkomstscherm) */
  gestapeld: { light: gestapeldKleur, dark: gestapeldWit, ratio: 0 },
} as const;

/** Het logo; in de donkere modus de witte variant. */
export function Logo({ variant = 'primair', width }: { variant?: keyof typeof VARIANTS; width: number }) {
  const v = VARIANTS[variant];
  return (
    <picture>
      <source srcSet={v.dark} media="(prefers-color-scheme: dark)" />
      <img src={v.light} alt="BoekhoudenVoorNiks" width={width} height={v.ratio ? Math.round(width * v.ratio) : undefined} style={{ display: 'block', height: 'auto' }} />
    </picture>
  );
}
