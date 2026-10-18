import {
  EU_B2C_THRESHOLD,
  EU_COUNTRIES,
  ICP_SERVICE_TEXT,
  ICP_TEXT,
  OUTSIDE_EU_SERVICE_TEXT,
  SALES_VAT_RATES,
  VERLEGD_TEXT,
  saleVatText,
  type SalesVatCode,
} from './vat';

/**
 * De btw-regeltabel die de pc aan de telefoon meegeeft (eerste pagina van het stamgegevens-antwoord).
 * Zuiver data, zonder Node of database, zodat pc en Android-app dezelfde regels gebruiken.
 *
 * Er is GEEN tweede bron van waarheid: de tabel wordt bij het laden afgeleid van de bestaande
 * constanten in vat.ts (SALES_VAT_RATES, EU_COUNTRIES, EU_B2C_THRESHOLD, de vaste teksten en
 * saleVatText). De pc rekent met die constanten; de tabel spiegelt wat de pc nu al doet.
 *
 * Versie: vorm JJJJ-n. Verandert de inhoud van de tabel (ook doordat een constante in vat.ts
 * verandert), dan hoort de versie omhoog; de vingerafdruk-test in tests/sync-regels.test.ts dwingt dat
 * af. De telefoon zet deze versie als regeltabel_versie op zijn facturen. De pc dwingt gelijkheid NIET
 * af: een factuur van een oudere telefoon blijft geldig.
 */
export const REGELTABEL_VERSIE = '2026-1';

/** Vanaf wanneer deze tabel geldt (ISO-datum, vast; hangt niet af van de dag van vandaag). */
export const REGELTABEL_GELDIG_VANAF = '2026-01-01';

export interface RegelBtwSoort {
  code: SalesVatCode;
  /** de tekst op de factuur */
  label: string;
  /** de keuze in gewone taal, alleen als die bestaat */
  pickLabel?: string;
  percentage: number;
  /** rubriek op de btw-aangifte ('-': niet in de aangifte) */
  rubriek: string;
  /** korte uitleg in gewone taal (saleVatText) */
  tekst: string;
}

export interface Regeltabel {
  versie: string;
  geldig_vanaf: string;
  btw: RegelBtwSoort[];
  /** EU-landcodes, alfabetisch */
  eu_landen: string[];
  /** drempel voor verkoop aan particulieren in andere EU-landen, in centen */
  eu_b2c_drempel: number;
  /** de vaste teksten die op de factuur komen */
  teksten: {
    icp: string;
    icp_dienst: string;
    buiten_eu_dienst: string;
    verlegd: string;
  };
}

function afleiden(): Regeltabel {
  const btw = (Object.keys(SALES_VAT_RATES) as SalesVatCode[]).map((code): RegelBtwSoort => {
    const r = SALES_VAT_RATES[code];
    return {
      code,
      label: r.label,
      ...(r.pickLabel === undefined ? {} : { pickLabel: r.pickLabel }),
      percentage: r.percentage,
      rubriek: r.rubriek,
      tekst: saleVatText(code),
    };
  });
  return {
    versie: REGELTABEL_VERSIE,
    geldig_vanaf: REGELTABEL_GELDIG_VANAF,
    btw,
    eu_landen: [...EU_COUNTRIES].sort(),
    eu_b2c_drempel: EU_B2C_THRESHOLD,
    teksten: { icp: ICP_TEXT, icp_dienst: ICP_SERVICE_TEXT, buiten_eu_dienst: OUTSIDE_EU_SERVICE_TEXT, verlegd: VERLEGD_TEXT },
  };
}

export const REGELTABEL: Regeltabel = afleiden();
