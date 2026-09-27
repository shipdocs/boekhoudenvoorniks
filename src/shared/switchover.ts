import { addDays, formatDateNl, periodFor, type IsoDate, type PeriodType } from './dates';
import type { Cents } from './money';

/**
 * Hulpjes voor de overstap-wizard die zowel het scherm als de service gebruikt (geen database).
 */

/** Hoofdstukken van de overstap-hulp die je kunt afvinken met "had ik niet". */
export const SKIPPABLE_SECTIONS = ['import', 'klanten', 'leveranciers', 'bezit', 'overig'] as const;

export interface StartDateOption {
  key: 'jaar' | 'periode';
  date: IsoDate;
  label: string;
  hint: string;
  recommended: boolean;
}

/** De instapdatums die we voorstellen: 1 januari (aangeraden) en het begin van de lopende btw-periode. */
export function startDateOptions(today: IsoDate, vatPeriod: PeriodType, kor: boolean): StartDateOption[] {
  const year = today.slice(0, 4);
  const jan1 = `${year}-01-01`;
  const out: StartDateOption[] = [
    {
      key: 'jaar',
      date: jan1,
      label: `Vanaf 1 januari ${year}`,
      hint: 'Je leest je bankafschriften vanaf 1 januari in. Dan klopt je jaaroverzicht voor de belasting vanzelf.',
      recommended: true,
    },
  ];
  const period = periodFor(today, kor ? 'kwartaal' : vatPeriod);
  if (period.start !== jan1) {
    out.push({
      key: 'periode',
      date: period.start,
      label: `Vanaf ${formatDateNl(period.start)}`,
      hint: `Begin van ${kor ? 'dit kwartaal' : `je btw-periode (${period.label})`}. Minder afschriften inlezen, maar we vragen dan je omzet en kosten van 1 januari tot ${formatDateNl(period.start)}.`,
      recommended: false,
    });
  }
  return out;
}

/** Wat een instapdatum betekent: welke extra gegevens de app dan nodig heeft. */
export function startDateConsequences(date: IsoDate, vatPeriod: PeriodType, kor: boolean): string[] {
  const out: string[] = [`Je leest je bankafschriften vanaf ${formatDateNl(date)} in.`];
  out.push(`We vragen wat er op ${formatDateNl(addDays(date, -1))} nog open stond: saldo, facturen, rekeningen en je bus of gereedschap.`);
  if (!date.endsWith('-01-01')) out.push(`We vragen ook je omzet en kosten van 1 januari tot ${formatDateNl(date)}: anders klopt je jaaroverzicht voor de inkomstenbelasting niet.`);
  const period = periodFor(date, vatPeriod);
  if (!kor && period.start !== date) out.push(`Je stapt midden in ${period.label} over. Dan vragen we ook de omzet en btw van ${formatDateNl(period.start)} tot ${formatDateNl(date)}, zodat de aangifte compleet is.`);
  return out;
}

/**
 * Boekwaarde op 1 januari van het instapjaar als je boekhouder die niet gaf: lineair afgeschreven in
 * 5 jaar (zoals de app zelf doet), vanaf de maand van aankoop. Dit jaar gekocht: de aankoopprijs.
 */
export function defaultBookValue(cost: Cents, acquiredOn: IsoDate, startDate: IsoDate): { bookValue: Cents; remainingYears: number } {
  const year = Number(startDate.slice(0, 4));
  const acquiredMonth = Number(acquiredOn.slice(0, 4)) * 12 + Number(acquiredOn.slice(5, 7)) - 1;
  const months = year * 12 - acquiredMonth;
  if (months <= 0) return { bookValue: cost, remainingYears: 5 };
  const bookValue = Math.max(0, cost - Math.round((cost * months) / 60));
  return { bookValue, remainingYears: Math.max(1, Math.round((60 - months) / 12)) };
}
