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
  { key: 'investering', label: 'Investering (vanaf € 450, gaat jaren mee)', hint: 'bus, machine, laptop, steiger: kosten verdeeld over 5 jaar, plus extra aftrek', account: 'BMvaBedIna', defaultVat: 'hoog' },
  { key: 'brandstof', label: 'Brandstof & parkeren (bus/auto van de zaak)', hint: 'rij je met je eigen auto? Dan is dit privé en trek je per kilometer af', account: 'WBedAutBra', defaultVat: 'hoog' },
  { key: 'auto', label: 'Auto: onderhoud & verzekering', hint: 'garage, banden, wegenbelasting', account: 'WBedAutOnd', defaultVat: 'hoog' },
  { key: 'telefoon', label: 'Telefoon & internet', hint: 'abonnementen', account: 'WBedKanTel', defaultVat: 'hoog' },
  { key: 'software', label: 'Software & abonnementen', hint: 'apps, website, hosting', account: 'WBedKanSof', defaultVat: 'hoog' },
  { key: 'kantoor', label: 'Kantoorartikelen', hint: 'printer, papier, porto', account: 'WBedKanKan', defaultVat: 'hoog' },
  { key: 'werkkleding', label: 'Werkkleding', hint: 'met logo of beschermend', account: 'WBedAlkWkl', defaultVat: 'hoog' },
  { key: 'verzekering', label: 'Verzekeringen', hint: 'bv. bedrijfsaansprakelijkheid. Niet je arbeidsongeschiktheidsverzekering (AOV): die is privé', account: 'WBedAlkVer', defaultVat: 'geen' },
  { key: 'representatie', label: 'Etentjes, borrels & relatiegeschenken', hint: 'zakelijk; je mag 80% aftrekken, de btw op eten en drinken krijg je niet terug', account: 'WBedVkkRep', defaultVat: 'geen' },
  { key: 'reclame', label: 'Reclame', hint: 'drukwerk, advertenties, bestickering', account: 'WBedVkkRec', defaultVat: 'hoog' },
  { key: 'boekhouder', label: 'Boekhouder / advies', hint: '', account: 'WBedAlkAdv', defaultVat: 'hoog' },
  { key: 'huur', label: 'Huur werkplaats / opslag', hint: '', account: 'WBedHuiHur', defaultVat: 'hoog' },
  { key: 'bank', label: 'Bankkosten', hint: '', account: 'WFbeBan', defaultVat: 'geen' },
  { key: 'onderaannemer', label: 'Onderaannemer (btw verlegd)', hint: 'iemand die werk voor jou doet en geen btw rekent ("btw verlegd" op de factuur)', account: 'WKprKuwKuw', defaultVat: 'verlegd' },
  { key: 'overig', label: 'Overige kosten', hint: '', account: 'WBedAlkOvr', defaultVat: 'hoog' },
];

/** Opzoeken van categorieën: de vaste lijst plus eigen en aangepaste (zie settings/categories.ts). */
export interface CategoryLookup {
  /** zichtbare categorieën, om uit te kiezen */
  list(): ExpenseCategory[];
  /** ook verborgen categorieën, zodat eerder geleerde leveranciers blijven werken */
  find(key: string): ExpenseCategory | undefined;
  /** naam in kleine letters, of de key als de categorie niet bestaat */
  label(key: string): string;
}

/** Voor banktransacties zonder factuur: bestemmingen die geen kosten zijn. */
/** Met een privéauto niet aftrekbaar (zit in het bedrag per km): tanken, parkeren, onderhoud, verzekering. */
export const PRIVATE_CAR_CATEGORIES = ['brandstof', 'auto'];

export const OTHER_DESTINATIONS = [
  { key: 'prive-opname', label: 'Privé opgenomen (naar mezelf)', hint: 'Geld van de zaak naar je eigen rekening of een privé-uitgave: geen kosten', account: 'BEivPriPrv' },
  { key: 'prive-storting', label: 'Privé gestort (van mezelf)', hint: 'Eigen geld dat je in de zaak stopt: geen omzet', account: 'BEivPriStr' },
  { key: 'btw', label: 'Btw betaald aan / terug van de Belastingdienst', hint: 'De betaling of teruggave van je btw-aangifte: geen kosten en geen omzet', account: 'BSchBepBtwAfr' },
  { key: 'overboeking', label: 'Overboeking tussen eigen rekeningen', hint: 'Geld verplaatst naar of van je eigen spaar- of andere zakelijke rekening', account: 'BLiqKru' },
  { key: 'omzet', label: 'Verkoop via een ander systeem', hint: 'Een klant betaalde je via bv. Mollie, je webshop, kassa, pin of contant, of voor een factuur die je ergens anders maakte', account: 'WOmzNopOlh' },
  { key: 'rente', label: 'Rente ontvangen', hint: 'Rente van de bank op je zakelijke rekening. Geen omzet en geen btw, wel winst', account: 'WFbeRlmObr' },
  { key: 'onbekend', label: 'Weet ik nog niet (later uitzoeken)', hint: 'Staat apart en komt terug als controle vóór je btw-aangifte', account: 'BSchOvsVrp' },
];
