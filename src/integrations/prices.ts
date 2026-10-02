import { roundHalfAwayFromZero, type Cents } from '../shared/money';
import type { ExternalOrder } from './types';

type OrderLine = ExternalOrder['lines'][number];

/** Het bedrag van een regel: aantal × prijs per stuk, in hele centen. */
export function lineAmount(l: Pick<OrderLine, 'quantity' | 'unitPriceExVat'>): Cents {
  return roundHalfAwayFromZero(l.quantity * l.unitPriceExVat);
}

/** Som van de regels zoals ze er staan: bij prijzen inclusief btw is dat wat de klant betaalt. */
export function linesTotal(lines: OrderLine[]): Cents {
  return lines.reduce((s, l) => s + lineAmount(l), 0);
}

/** Het totaal als de prijzen exclusief btw zijn: de regels, met per tarief de btw erbovenop (zoals op de factuur in de app). */
export function linesTotalWithVat(lines: OrderLine[]): Cents {
  const perRate = new Map<number, Cents>();
  for (const l of lines) perRate.set(l.vatPercentage, (perRate.get(l.vatPercentage) ?? 0) + lineAmount(l));
  return [...perRate].reduce((s, [rate, net]) => s + net + roundHalfAwayFromZero((net * rate) / 100), 0);
}

/**
 * Het bedrag exclusief btw bij een bedrag inclusief btw, voor één tarief. De btw is wat er in het bedrag zit
 * (bedrag × tarief / (100 + tarief)), zoals op de factuur met prijzen inclusief btw. Een factuur in de app
 * rekent de btw uit over het netto; komt dat op dezelfde btw uit, dan klopt het totaal precies. Voor ongeveer
 * één op de zes bedragen bij 21% bestaat zo'n netto niet (€ 10,00: € 8,26 geeft € 1,73 en € 8,27 geeft € 1,74):
 * dan het netto waarbij de btw klopt. Het totaal is dan één cent anders dan wat er betaald is; dat boekt de
 * app bij het inlezen als afrondingsverschil.
 */
function netOfGross(gross: Cents, rate: number): Cents {
  const base = roundHalfAwayFromZero((gross * 100) / (100 + rate));
  const vat = gross - base;
  return [base, base + 1, base - 1].find((net) => roundHalfAwayFromZero((net * rate) / 100) === vat) ?? base;
}

/**
 * Regels met prijzen inclusief btw terugrekenen naar exclusief btw (#228). Per btw-tarief over het totaal van
 * dat tarief, niet per regel afgerond en opgeteld: zo ontstaat er geen verschil van een cent per regel. Wat er
 * per regel bij het afronden overblijft, gaat naar de regels die het meest zijn afgerond. Past het bedrag van
 * een regel niet in hele centen per stuk, dan wordt het één regel met het aantal in de omschrijving.
 * Een regel zonder leesbaar btw-tarief blijft zoals hij is: daar valt niets uit terug te rekenen.
 */
export function linesFromInclusive(lines: OrderLine[]): OrderLine[] {
  const gross = lines.map(lineAmount);
  const net = [...gross];
  for (const rate of new Set(lines.map((l) => l.vatPercentage))) {
    if (!Number.isFinite(rate) || rate <= 0) continue;
    const group = lines.map((_, i) => i).filter((i) => lines[i]!.vatPercentage === rate);
    const exact = new Map(group.map((i) => [i, (gross[i]! * 100) / (100 + rate)]));
    for (const i of group) net[i] = roundHalfAwayFromZero(exact.get(i)!);
    let rest = netOfGross(group.reduce((s, i) => s + gross[i]!, 0), rate) - group.reduce((s, i) => s + net[i]!, 0);
    // nooit eindeloos verdelen: zonder regels of zonder heel aantal centen valt er niets te verdelen
    if (group.length === 0 || !Number.isInteger(rest)) continue;
    const step = Math.sign(rest);
    // eerst de regels die het verst naar de andere kant zijn afgerond
    const order = [...group].sort((a, b) => step * (exact.get(b)! - net[b]! - (exact.get(a)! - net[a]!)) || a - b);
    for (let k = 0; rest !== 0; k++, rest -= step) net[order[k % order.length]!]! += step;
  }
  return lines.map((l, i) => {
    const perUnit = net[i]! / l.quantity;
    return Number.isInteger(perUnit) ? { ...l, unitPriceExVat: perUnit } : { ...l, description: `${l.quantity} × ${l.description}`, quantity: 1, unitPriceExVat: net[i]! };
  });
}
