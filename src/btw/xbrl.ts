import type { VatReport } from './btw';
import type { CompanySettings } from '../settings/settings';
import { escapeHtml } from '../documents/render';

/**
 * Genereert een XBRL-instance voor de aangifte omzetbelasting (SBR / Nederlandse Taxonomie).
 *
 * STATUS: voorbereiding voor fase 3 (directe aangifte via Digipoort). De elementnamen volgen de
 * NT20-concepten en het entrypoint voor OB 2026 (issue #44). De volledige instance MOET gevalideerd
 * worden tegen de actuele NT-release en de Belastingdienst-testomgeving voordat dit gebruikt wordt
 * (zie GitHub-issue "Digipoort/SBR aansluiting"). Tot die tijd: alleen export, niet indienen.
 */
export const NT_VERSION = 'NT20-BD-20251210 (OB 2026, testexport)';
const NAMESPACE = 'http://www.nltaxonomie.nl/nt20/bd/20251210/dictionary/bd-data';
const ENTRYPOINT = 'http://www.nltaxonomie.nl/nt20/bd/20251210/entrypoints/bd-rpt-ob-aangifte-2026.xsd';

const CONCEPTS: Record<string, { omzet?: string; btw?: string }> = {
  '1a': { omzet: 'TaxedTurnoverSuppliesServicesGeneralTariff', btw: 'ValueAddedTaxSuppliesServicesGeneralTariff' },
  '1b': { omzet: 'TaxedTurnoverSuppliesServicesReducedTariff', btw: 'ValueAddedTaxSuppliesServicesReducedTariff' },
  '1d': { btw: 'ValueAddedTaxPrivateUse' },
  '1e': { omzet: 'SuppliesServicesNotTaxed' },
  '2a': { omzet: 'TurnoverSuppliesServicesByWhichVATTaxationIsTransferred', btw: 'ValueAddedTaxSuppliesServicesByWhichVATTaxationIsTransferred' },
  '3a': { omzet: 'SuppliesToCountriesOutsideTheEC' },
  '3b': { omzet: 'SuppliesToCountriesWithinTheEC' },
  '4a': { omzet: 'TurnoverFromTaxedSuppliesFromCountriesOutsideTheEC', btw: 'ValueAddedTaxOnSuppliesFromCountriesOutsideTheEC' },
  '4b': { omzet: 'TurnoverFromTaxedSuppliesFromCountriesWithinTheEC', btw: 'ValueAddedTaxOnSuppliesFromCountriesWithinTheEC' },
  '5a': { btw: 'ValueAddedTaxOwed' },
  '5b': { btw: 'ValueAddedTaxOnInput' },
  '5g': { btw: 'ValueAddedTaxOwedToBePaidBack' },
};

export function buildVatXbrl(report: VatReport, company: CompanySettings): string {
  if (report.period.start.slice(0, 4) !== '2026' || report.period.end.slice(0, 4) !== '2026') throw new Error('Deze XBRL-testexport ondersteunt alleen de gecontroleerde taxonomie voor 2026');
  const vatId = company.omzetbelastingNumber?.replace(/\s/g, '').toUpperCase();
  if (!vatId || !/^\d{9}B\d{2}$/.test(vatId)) throw new Error('Vul je omzetbelastingnummer in bij Instellingen (9 cijfers, B en 2 cijfers; zonder NL). Gebruik het nummer voor de Belastingdienst, niet je btw-id op facturen.');
  const facts: string[] = [];
  for (const r of report.rubrieken) {
    const c = CONCEPTS[r.code];
    if (!c) continue;
    if (c.omzet && r.omzetEuro !== null) facts.push(`  <bd-i:${c.omzet} contextRef="Msg" unitRef="EUR" decimals="INF">${r.omzetEuro}</bd-i:${c.omzet}>`);
    if (c.btw && r.btwEuro !== null) facts.push(`  <bd-i:${c.btw} contextRef="Msg" unitRef="EUR" decimals="INF">${r.btwEuro}</bd-i:${c.btw}>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Gegenereerd door BoekhoudenVoorNiks — ${NT_VERSION}: NIET INDIENEN zonder validatie -->
<xbrli:xbrl xml:lang="nl"
  xmlns:xbrli="http://www.xbrl.org/2003/instance"
  xmlns:link="http://www.xbrl.org/2003/linkbase"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
  xmlns:bd-i="${NAMESPACE}">
  <link:schemaRef xlink:type="simple" xlink:href="${ENTRYPOINT}"/>
  <xbrli:context id="Msg">
    <xbrli:entity><xbrli:identifier scheme="www.belastingdienst.nl/omzetbelastingnummer">${escapeHtml(vatId)}</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>${report.period.start}</xbrli:startDate><xbrli:endDate>${report.period.end}</xbrli:endDate></xbrli:period>
  </xbrli:context>
  <xbrli:unit id="EUR"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>
${facts.join('\n')}
</xbrli:xbrl>
`;
}

/** Interface voor de toekomstige Digipoort-koppeling; implementatie volgt na ODB-aanmelding + PKIoverheid-certificaat. */
export interface VatSubmissionChannel {
  submit(xbrl: string): Promise<{ reference: string }>;
  status(reference: string): Promise<'ontvangen' | 'verwerkt' | 'afgekeurd'>;
}
