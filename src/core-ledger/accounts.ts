/**
 * Standaard grootboekschema, gebaseerd op RGS (Referentie GrootboekSchema).
 *
 * De RGS-codes hieronder volgen de RGS-naamgeving (B = balans, W = winst & verlies) maar zijn
 * een subset voor zzp/kleine ondernemers. Ze MOETEN vóór livegang geverifieerd worden tegen de
 * officiële RGS-release (zie GitHub-issue "RGS-codes verifiëren").
 */
export type AccountCategory = 'activa' | 'passiva' | 'omzet' | 'kosten' | 'btw';

export interface AccountSeed {
  code: string;
  rgs: string;
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
  btwVoorbelasting: 'BSchBepBtwVoo',
  btwAfrekening: 'BSchBepBtwAfr',
  omzetHoog: 'WOmzNopOlh',
  omzetLaag: 'WOmzNopOll',
  omzetNul: 'WOmzNopOln',
  omzetVerlegd: 'WOmzNopOlv',
  omzetVrijgesteld: 'WOmzNopOvr',
  inkoopMaterialen: 'WKprInkMat',
  bankkosten: 'WFbeBan',
  betalingsverschillen: 'WBedAlkBev',
  vraagposten: 'BSchOvsVrp',
} as const;

export const DEFAULT_ACCOUNTS: AccountSeed[] = [
  // Activa
  { code: '1000', rgs: ACCOUNTS.kas, name: 'Kas', category: 'activa', system: true },
  { code: '1100', rgs: ACCOUNTS.bank, name: 'Bank', category: 'activa', system: true },
  { code: '1190', rgs: ACCOUNTS.kruisposten, name: 'Kruisposten', category: 'activa', system: true },
  { code: '1195', rgs: ACCOUNTS.tussenrekeningPsp, name: 'Tussenrekening betaalprovider (Mollie/Stripe)', category: 'activa', system: true },
  { code: '1300', rgs: ACCOUNTS.debiteuren, name: 'Debiteuren', category: 'activa', system: true },
  { code: '0200', rgs: 'BMvaTraVrt', name: 'Vervoermiddelen', category: 'activa' },
  { code: '0300', rgs: 'BMvaBedIna', name: 'Inventaris en gereedschap', category: 'activa' },

  // Passiva
  { code: '0500', rgs: ACCOUNTS.eigenVermogen, name: 'Eigen vermogen', category: 'passiva', system: true },
  { code: '0510', rgs: ACCOUNTS.priveOpnamen, name: 'Privé-opnamen', category: 'passiva', system: true },
  { code: '0520', rgs: ACCOUNTS.priveStortingen, name: 'Privé-stortingen', category: 'passiva', system: true },
  { code: '1600', rgs: ACCOUNTS.crediteuren, name: 'Crediteuren', category: 'passiva', system: true },
  { code: '1690', rgs: ACCOUNTS.vraagposten, name: 'Vraagposten (nog uitzoeken)', category: 'passiva', system: true },

  // BTW
  { code: '1710', rgs: ACCOUNTS.btwAfdragenHoog, name: 'Af te dragen BTW hoog', category: 'btw', vatCode: 'hoog', system: true },
  { code: '1720', rgs: ACCOUNTS.btwAfdragenLaag, name: 'Af te dragen BTW laag', category: 'btw', vatCode: 'laag', system: true },
  { code: '1730', rgs: ACCOUNTS.btwAfdragenVerlegd, name: 'Af te dragen BTW verlegd (inkoop)', category: 'btw', vatCode: 'verlegd', system: true },
  { code: '1740', rgs: ACCOUNTS.btwVoorbelasting, name: 'Voorbelasting', category: 'btw', vatCode: 'voorbelasting', system: true },
  { code: '1750', rgs: ACCOUNTS.btwAfrekening, name: 'Af te dragen omzetbelasting (aangifte)', category: 'btw', system: true },

  // Omzet
  { code: '8000', rgs: ACCOUNTS.omzetHoog, name: 'Omzet 21%', category: 'omzet', vatCode: 'hoog', system: true },
  { code: '8010', rgs: ACCOUNTS.omzetLaag, name: 'Omzet 9%', category: 'omzet', vatCode: 'laag', system: true },
  { code: '8020', rgs: ACCOUNTS.omzetNul, name: 'Omzet 0%', category: 'omzet', vatCode: 'nul', system: true },
  { code: '8030', rgs: ACCOUNTS.omzetVerlegd, name: 'Omzet BTW verlegd', category: 'omzet', vatCode: 'verlegd', system: true },
  { code: '8040', rgs: ACCOUNTS.omzetVrijgesteld, name: 'Omzet vrijgesteld / KOR', category: 'omzet', vatCode: 'vrijgesteld', system: true },

  // Kosten
  { code: '7000', rgs: ACCOUNTS.inkoopMaterialen, name: 'Inkoop materialen', category: 'kosten', system: true },
  { code: '4000', rgs: 'WBedHuiHur', name: 'Huur bedrijfsruimte', category: 'kosten' },
  { code: '4100', rgs: 'WBedAutBra', name: 'Autokosten (brandstof)', category: 'kosten' },
  { code: '4110', rgs: 'WBedAutOnd', name: 'Autokosten (onderhoud & verzekering)', category: 'kosten' },
  { code: '4200', rgs: 'WBedKanKan', name: 'Kantoorkosten', category: 'kosten' },
  { code: '4210', rgs: 'WBedKanTel', name: 'Telefoon & internet', category: 'kosten' },
  { code: '4220', rgs: 'WBedKanSof', name: 'Software & abonnementen', category: 'kosten' },
  { code: '4300', rgs: 'WBedVkkRec', name: 'Reclame & marketing', category: 'kosten' },
  { code: '4400', rgs: 'WBedAlkGer', name: 'Klein gereedschap', category: 'kosten' },
  { code: '4410', rgs: 'WBedAlkVer', name: 'Verzekeringen', category: 'kosten' },
  { code: '4420', rgs: 'WBedAlkAdv', name: 'Advieskosten (boekhouder)', category: 'kosten' },
  { code: '4430', rgs: 'WBedAlkWkl', name: 'Werkkleding', category: 'kosten' },
  { code: '4490', rgs: 'WBedAlkOvr', name: 'Overige algemene kosten', category: 'kosten' },
  { code: '4495', rgs: ACCOUNTS.betalingsverschillen, name: 'Betalingsverschillen', category: 'kosten', system: true },
  { code: '4500', rgs: ACCOUNTS.bankkosten, name: 'Bankkosten', category: 'kosten', system: true },
];

/** Welke omzet- en BTW-rekening hoort bij een verkoop-BTW-code. */
export const SALES_ACCOUNTS: Record<string, { revenue: string; vat?: string }> = {
  hoog: { revenue: ACCOUNTS.omzetHoog, vat: ACCOUNTS.btwAfdragenHoog },
  laag: { revenue: ACCOUNTS.omzetLaag, vat: ACCOUNTS.btwAfdragenLaag },
  nul: { revenue: ACCOUNTS.omzetNul },
  verlegd: { revenue: ACCOUNTS.omzetVerlegd },
  vrijgesteld: { revenue: ACCOUNTS.omzetVrijgesteld },
};
