/**
 * Standaard grootboekschema voor zzp/kleine ondernemers, gekoppeld aan RGS (Referentie GrootboekSchema).
 *
 * Twee soorten codes:
 *  - `rgs` (kolom `rgs_code`): de INTERNE, vaste sleutel van een rekening. Historisch lijken deze op
 *    RGS-codes, maar het zijn geen officiële codes. Nooit wijzigen: de code verwijst ernaar.
 *  - `ref` (kolom `rgs_ref`): de OFFICIËLE RGS-referentiecode (RGS-taxonomie release 20251210,
 *    zie `rgs-codes.json`). Deze gaat mee in exports (auditfile, CSV) en wordt getest tegen de
 *    officiële lijst (tests/rgs.test.ts).
 */
export type AccountCategory = 'activa' | 'passiva' | 'omzet' | 'kosten' | 'btw';

export interface AccountSeed {
  code: string;
  rgs: string;
  /** officiële RGS-referentiecode */
  ref: string;
  name: string;
  category: AccountCategory;
  vatCode?: string;
  system?: boolean;
}

/** Vaste sleutels die de app intern gebruikt; nooit hernoemen. */
export const ACCOUNTS = {
  kas: 'BLiqKas',
  bank: 'BLiqBanRba',
  kruisposten: 'BLiqKru',
  tussenrekeningPsp: 'BLiqKruPsp',
  debiteuren: 'BVorDebHad',
  crediteuren: 'BSchCreHac',
  eigenVermogen: 'BEivKap',
  priveOpnamen: 'BEivPriPrv',
  priveStortingen: 'BEivPriStr',
  btwAfdragenHoog: 'BSchBepBtwAfdHoo',
  btwAfdragenLaag: 'BSchBepBtwAfdLaa',
  btwAfdragenVerlegd: 'BSchBepBtwAfdVer',
  btwAfdragenEu: 'BSchBepBtwAfdEu',
  btwAfdragenBuitenEu: 'BSchBepBtwAfdBui',
  btwVoorbelasting: 'BSchBepBtwVoo',
  btwAfrekening: 'BSchBepBtwAfr',
  omzetHoog: 'WOmzNopOlh',
  omzetLaag: 'WOmzNopOll',
  omzetNul: 'WOmzNopOln',
  omzetVerlegd: 'WOmzNopOlv',
  omzetVrijgesteld: 'WOmzNopOvr',
  omzetIcp: 'WOmzNopOic',
  omzetExport: 'WOmzNopOex',
  inkoopMaterialen: 'WKprInkMat',
  bankkosten: 'WFbeBan',
  betalingsverschillen: 'WBedAlkBev',
  vraagposten: 'BSchOvsVrp',
  uitbesteedWerk: 'WKprKuwKuw',
} as const;

export const DEFAULT_ACCOUNTS: AccountSeed[] = [
  // Activa
  { code: '1000', rgs: ACCOUNTS.kas, ref: 'BLimKasKas', name: 'Kas', category: 'activa', system: true },
  { code: '1100', rgs: ACCOUNTS.bank, ref: 'BLimBanRba', name: 'Bank', category: 'activa', system: true },
  { code: '1190', rgs: ACCOUNTS.kruisposten, ref: 'BLimKruSto', name: 'Kruisposten', category: 'activa', system: true },
  { code: '1195', rgs: ACCOUNTS.tussenrekeningPsp, ref: 'BVorTusTonTcv', name: 'Tussenrekening betaalprovider', category: 'activa', system: true },
  { code: '1300', rgs: ACCOUNTS.debiteuren, ref: 'BVorDebHad', name: 'Debiteuren', category: 'activa', system: true },
  { code: '0200', rgs: 'BMvaTraVrt', ref: 'BMvaTevVvp', name: 'Vervoermiddelen', category: 'activa' },
  { code: '0300', rgs: 'BMvaBedIna', ref: 'BMvaBeiVvp', name: 'Inventaris en gereedschap', category: 'activa' },

  // Passiva
  { code: '0500', rgs: ACCOUNTS.eigenVermogen, ref: 'BEivKapOnd', name: 'Eigen vermogen', category: 'passiva', system: true },
  { code: '0510', rgs: ACCOUNTS.priveOpnamen, ref: 'BEivKapProOvp', name: 'Privé-opnamen', category: 'passiva', system: true },
  { code: '0520', rgs: ACCOUNTS.priveStortingen, ref: 'BEivKapPrsOps', name: 'Privé-stortingen', category: 'passiva', system: true },
  { code: '1600', rgs: ACCOUNTS.crediteuren, ref: 'BSchCreHac', name: 'Crediteuren', category: 'passiva', system: true },
  { code: '1690', rgs: ACCOUNTS.vraagposten, ref: 'BSchTusTovTvp', name: 'Vraagposten (nog uitzoeken)', category: 'passiva', system: true },

  // BTW
  { code: '1710', rgs: ACCOUNTS.btwAfdragenHoog, ref: 'BSchBepBtwOla', name: 'Af te dragen BTW hoog', category: 'btw', vatCode: 'hoog', system: true },
  { code: '1720', rgs: ACCOUNTS.btwAfdragenLaag, ref: 'BSchBepBtwOlt', name: 'Af te dragen BTW laag', category: 'btw', vatCode: 'laag', system: true },
  { code: '1730', rgs: ACCOUNTS.btwAfdragenVerlegd, ref: 'BSchBepBtwOlw', name: 'Af te dragen BTW verlegd (inkoop)', category: 'btw', vatCode: 'verlegd', system: true },
  { code: '1735', rgs: ACCOUNTS.btwAfdragenEu, ref: 'BSchBepBtwOlu', name: 'Af te dragen BTW verlegd uit de EU (4b)', category: 'btw', vatCode: 'eu', system: true },
  { code: '1736', rgs: ACCOUNTS.btwAfdragenBuitenEu, ref: 'BSchBepBtwOlb', name: 'Af te dragen BTW verlegd van buiten de EU (4a)', category: 'btw', vatCode: 'buiten-eu', system: true },
  { code: '1740', rgs: ACCOUNTS.btwVoorbelasting, ref: 'BSchBepBtwVoo', name: 'Voorbelasting', category: 'btw', vatCode: 'voorbelasting', system: true },
  { code: '1750', rgs: ACCOUNTS.btwAfrekening, ref: 'BSchBepBtwAfo', name: 'Af te dragen omzetbelasting (aangifte)', category: 'btw', system: true },

  // Omzet
  { code: '8000', rgs: ACCOUNTS.omzetHoog, ref: 'WOmzNodOdh', name: 'Omzet 21%', category: 'omzet', vatCode: 'hoog', system: true },
  { code: '8010', rgs: ACCOUNTS.omzetLaag, ref: 'WOmzNodOdl', name: 'Omzet 9%', category: 'omzet', vatCode: 'laag', system: true },
  { code: '8020', rgs: ACCOUNTS.omzetNul, ref: 'WOmzNodOdg', name: 'Omzet 0%', category: 'omzet', vatCode: 'nul', system: true },
  { code: '8030', rgs: ACCOUNTS.omzetVerlegd, ref: 'WOmzNodOdg', name: 'Omzet BTW verlegd', category: 'omzet', vatCode: 'verlegd', system: true },
  { code: '8040', rgs: ACCOUNTS.omzetVrijgesteld, ref: 'WOmzNodNod', name: 'Omzet vrijgesteld / KOR', category: 'omzet', vatCode: 'vrijgesteld', system: true },
  { code: '8050', rgs: ACCOUNTS.omzetIcp, ref: 'WOmzNodOdi', name: 'Omzet EU-bedrijven (ICP, 3b)', category: 'omzet', vatCode: 'icp', system: true },
  { code: '8060', rgs: ACCOUNTS.omzetExport, ref: 'WOmzNodOdb', name: 'Omzet uitvoer buiten de EU (3a)', category: 'omzet', vatCode: 'export', system: true },

  // Kosten
  { code: '7000', rgs: ACCOUNTS.inkoopMaterialen, ref: 'WKprInpInp', name: 'Inkoop materialen', category: 'kosten', system: true },
  { code: '7100', rgs: ACCOUNTS.uitbesteedWerk, ref: 'WKprKuwKuw', name: 'Uitbesteed werk (onderaannemers)', category: 'kosten', system: true },
  { code: '4000', rgs: 'WBedHuiHur', ref: 'WBedHuiBeh', name: 'Huur bedrijfsruimte', category: 'kosten' },
  { code: '4100', rgs: 'WBedAutBra', ref: 'WBedAutBra', name: 'Autokosten (brandstof)', category: 'kosten' },
  { code: '4110', rgs: 'WBedAutOnd', ref: 'WBedAutRoa', name: 'Autokosten (onderhoud & verzekering)', category: 'kosten' },
  { code: '4200', rgs: 'WBedKanKan', ref: 'WBedKanKan', name: 'Kantoorkosten', category: 'kosten' },
  { code: '4210', rgs: 'WBedKanTel', ref: 'WBedKanTef', name: 'Telefoon & internet', category: 'kosten' },
  { code: '4220', rgs: 'WBedKanSof', ref: 'WBedKanSof', name: 'Software & abonnementen', category: 'kosten' },
  { code: '4300', rgs: 'WBedVkkRec', ref: 'WBedVkkRea', name: 'Reclame & marketing', category: 'kosten' },
  { code: '4400', rgs: 'WBedAlkGer', ref: 'WBedEemGsk', name: 'Klein gereedschap', category: 'kosten' },
  { code: '4410', rgs: 'WBedAlkVer', ref: 'WBedAssOva', name: 'Verzekeringen', category: 'kosten' },
  { code: '4420', rgs: 'WBedAlkAdv', ref: 'WBedAeaAdv', name: 'Advieskosten (boekhouder)', category: 'kosten' },
  { code: '4430', rgs: 'WBedAlkWkl', ref: 'WBedOvpWkv', name: 'Werkkleding', category: 'kosten' },
  { code: '4490', rgs: 'WBedAlkOvr', ref: 'WBedAlkOal', name: 'Overige algemene kosten', category: 'kosten' },
  { code: '4495', rgs: ACCOUNTS.betalingsverschillen, ref: 'WBedAdlBet', name: 'Betalingsverschillen', category: 'kosten', system: true },
  { code: '4500', rgs: ACCOUNTS.bankkosten, ref: 'WBedAdlBan', name: 'Bankkosten', category: 'kosten', system: true },
];

/** Welke omzet- en BTW-rekening hoort bij een verkoop-BTW-code. */
export const SALES_ACCOUNTS: Record<string, { revenue: string; vat?: string }> = {
  hoog: { revenue: ACCOUNTS.omzetHoog, vat: ACCOUNTS.btwAfdragenHoog },
  laag: { revenue: ACCOUNTS.omzetLaag, vat: ACCOUNTS.btwAfdragenLaag },
  nul: { revenue: ACCOUNTS.omzetNul },
  verlegd: { revenue: ACCOUNTS.omzetVerlegd },
  vrijgesteld: { revenue: ACCOUNTS.omzetVrijgesteld },
  icp: { revenue: ACCOUNTS.omzetIcp },
  export: { revenue: ACCOUNTS.omzetExport },
};

/** Op welke rekening de verlegde btw (af te dragen) komt, per inkoop-btw-code. */
export const REVERSE_CHARGE_ACCOUNTS: Record<'verlegd' | 'eu' | 'buiten-eu', string> = {
  verlegd: ACCOUNTS.btwAfdragenVerlegd,
  eu: ACCOUNTS.btwAfdragenEu,
  'buiten-eu': ACCOUNTS.btwAfdragenBuitenEu,
};
