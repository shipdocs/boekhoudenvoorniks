import type { Db } from '../db/database';
import type { SettingsService } from '../settings/settings';

export interface ChecklistItem {
  key: string;
  label: string;
  hint: string;
  done: boolean;
  /** scherm waar je het regelt */
  screen: 'instellingen' | 'klant' | 'factuur' | 'bank' | 'aankopen';
}

/**
 * "Aan de slag" op Vandaag. Wordt elke keer uit de administratie zelf afgeleid, dus werkt
 * zichzelf bij: een eerste factuur of bankimport vinkt het punt vanzelf af, ook als je het
 * ergens anders in de app deed. Een nieuw punt in een nieuwe versie verschijnt vanzelf.
 */
export class ChecklistService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  items(): ChecklistItem[] {
    const s = this.settings.get();
    const has = (sql: string) => this.db.prepare(`SELECT EXISTS(${sql}) AS x`).get() as { x: number };
    const c = s.company;
    return [
      { key: 'bedrijf', label: 'Bedrijfsgegevens invullen', hint: 'naam, adres en KvK komen op je facturen', done: !!(c.name && c.address && c.city && c.kvkNumber), screen: 'instellingen' },
      { key: 'iban', label: 'Rekeningnummer toevoegen', hint: 'zodat klanten weten waar ze moeten betalen', done: !!c.iban, screen: 'instellingen' },
      { key: 'klant', label: 'Eerste klant toevoegen', hint: '', done: !!has(`SELECT 1 FROM relations WHERE type IN ('klant','beide') AND archived = 0`).x, screen: 'klant' },
      { key: 'factuur', label: 'Eerste factuur maken', hint: '', done: !!has('SELECT 1 FROM invoices WHERE number IS NOT NULL').x, screen: 'factuur' },
      { key: 'bank', label: 'Bankafschrift inlezen', hint: 'dan zien we wie er betaald heeft', done: !!has('SELECT 1 FROM bank_transactions').x, screen: 'bank' },
      { key: 'bon', label: 'Eerste bonnetje of factuur van een leverancier toevoegen', hint: '', done: !!(has('SELECT 1 FROM purchase_invoices').x || has('SELECT 1 FROM documents').x), screen: 'aankopen' },
      { key: 'email', label: 'E-mail instellen', hint: 'om facturen direct vanuit de app te versturen', done: !!(s.smtp.host && s.smtp.fromEmail), screen: 'instellingen' },
    ];
  }
}
