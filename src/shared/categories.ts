import type { PurchaseVatCode } from './vat';

/**
 * Gebruikersvriendelijke categorieën ("Wat heb je gekocht?") → grootboekrekening + standaard BTW.
 * De gebruiker ziet nooit rekeningnummers; de boekhouder ziet keurige RGS-rekeningen.
 */
export interface ExpenseCategory {
  key: string;
  label: string;
  hint: string;
  account: string;
  defaultVat: PurchaseVatCode;
}

export const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  { key: 'materiaal', label: 'Materiaal', hint: 'gips, verf, stuc, kit, tape…', account: 'WKprInkMat', defaultVat: 'hoog' },
  { key: 'gereedschap', label: 'Klein gereedschap', hint: 'tot € 450 per stuk', account: 'WBedAlkGer', defaultVat: 'hoog' },
  { key: 'investering', label: 'Investering (vanaf € 450, gaat jaren mee)', hint: 'bus, machine, laptop, steiger — afschrijven + investeringsaftrek', account: 'BMvaBedIna', defaultVat: 'hoog' },
  { key: 'brandstof', label: 'Brandstof & parkeren (bus/auto van de zaak)', hint: 'rijd je privé? dan telt dit als privé en krijg je € per km', account: 'WBedAutBra', defaultVat: 'hoog' },
  { key: 'auto', label: 'Auto: onderhoud & verzekering', hint: 'garage, banden, wegenbelasting', account: 'WBedAutOnd', defaultVat: 'hoog' },
  { key: 'telefoon', label: 'Telefoon & internet', hint: 'abonnementen', account: 'WBedKanTel', defaultVat: 'hoog' },
  { key: 'software', label: 'Software & abonnementen', hint: 'apps, website, hosting', account: 'WBedKanSof', defaultVat: 'hoog' },
  { key: 'kantoor', label: 'Kantoorartikelen', hint: 'printer, papier, porto', account: 'WBedKanKan', defaultVat: 'hoog' },
  { key: 'werkkleding', label: 'Werkkleding', hint: 'met logo of beschermend', account: 'WBedAlkWkl', defaultVat: 'hoog' },
  { key: 'verzekering', label: 'Verzekeringen', hint: 'AVB, bedrijfsaansprakelijkheid. Niet je AOV: die is privé (wel aftrekbaar in je aangifte)', account: 'WBedAlkVer', defaultVat: 'geen' },
  { key: 'representatie', label: 'Etentjes, borrels & relatiegeschenken', hint: 'zakelijk; voor 80% aftrekbaar, btw op eten en drinken niet', account: 'WBedVkkRep', defaultVat: 'geen' },
  { key: 'reclame', label: 'Reclame', hint: 'drukwerk, advertenties, bestickering', account: 'WBedVkkRec', defaultVat: 'hoog' },
  { key: 'boekhouder', label: 'Boekhouder / advies', hint: '', account: 'WBedAlkAdv', defaultVat: 'hoog' },
  { key: 'huur', label: 'Huur werkplaats / opslag', hint: '', account: 'WBedHuiHur', defaultVat: 'hoog' },
  { key: 'bank', label: 'Bankkosten', hint: '', account: 'WFbeBan', defaultVat: 'geen' },
  { key: 'onderaannemer', label: 'Onderaannemer (btw verlegd)', hint: 'factuur met "btw verlegd"', account: 'WKprKuwKuw', defaultVat: 'verlegd' },
  { key: 'overig', label: 'Overige kosten', hint: '', account: 'WBedAlkOvr', defaultVat: 'hoog' },
];

/** Voor banktransacties zonder factuur: bestemmingen die geen kosten zijn. */
/** Met een privéauto niet aftrekbaar (zit in het bedrag per km): tanken, parkeren, onderhoud, verzekering. */
export const PRIVATE_CAR_CATEGORIES = ['brandstof', 'auto'];

export const OTHER_DESTINATIONS = [
  { key: 'prive-opname', label: 'Privé opgenomen (naar mezelf)', account: 'BEivPriPrv' },
  { key: 'prive-storting', label: 'Privé gestort (van mezelf)', account: 'BEivPriStr' },
  { key: 'btw', label: 'BTW betaald aan / terug van Belastingdienst', account: 'BSchBepBtwAfr' },
  { key: 'overboeking', label: 'Overboeking tussen eigen rekeningen', account: 'BLiqKru' },
  { key: 'omzet', label: 'Omzet zonder factuur (contant/pin)', account: 'WOmzNopOlh' },
  { key: 'onbekend', label: 'Weet ik nog niet (vraagpost)', account: 'BSchOvsVrp' },
];
