import { accountOpenItems } from '../core-ledger/open-items';
import { ACCOUNTS } from '../core-ledger/accounts';
import type { Db } from '../db/database';
import { tx } from '../db/database';
import type { Ledger } from '../core-ledger/ledger';
import { PeriodLockedError } from '../core-ledger/ledger';
import type { BankService } from '../import/bank';
import { addDays, assertIsoDate, formatDateNl, today, type IsoDate } from '../shared/dates';
import { ValidationError } from '../shared/validation';
import { formatEuro, type Cents } from '../shared/money';

/** Een privé-storting vanaf dit bedrag noemen we bij het afsluiten. */
export const PRIVE_DEPOSIT_NOTICE: Cents = 100000;

/**
 * Periodes afsluiten: afgewerkt is afgewerkt (docs/uitwisseling.md, "Periodeslot"). Wat t/m de
 * einddatum geboekt is, ligt daarna vast; het slot zelf zit in de database (migratie 22) en in
 * `Ledger.post`. Hier: wat er vóór het afsluiten klaar moet zijn, en het slot zetten.
 *
 * Een uitwisseling met de boekhouder is hetzelfde slot, maar tijdelijk: het wordt definitief als zijn
 * antwoord is ingelezen, en vervalt als de uitwisseling wordt afgebroken.
 */
export interface CloseCheck {
  key: string;
  /** blokkeert: eerst oplossen; bevestigen: mag door, als de gebruiker het bevestigt; info: ter kennis */
  level: 'blokkeert' | 'bevestigen' | 'info';
  title: string;
  detail: string;
  /** scherm om het op te lossen */
  screen?: 'bank' | 'aankopen' | 'werk' | 'jaarafsluiting';
}

export interface PeriodStatus {
  closedUntil: IsoDate | null;
  exchange: { until: IsoDate; no: number | null } | null;
  /** eerste dag die nog open is, of null zonder slot */
  firstOpen: IsoDate | null;
}

export class PeriodCloseService {
  constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly bank: BankService,
  ) {}

  status(): PeriodStatus {
    return { ...this.ledger.periodLock(), firstOpen: this.ledger.firstOpenDate() };
  }

  /**
   * Einddatums die je kunt kiezen: het eind van elk kwartaal na het huidige slot, t/m het laatste
   * afgelopen kwartaal. Nieuwste eerst.
   */
  suggestedDates(asOf: IsoDate = today()): IsoDate[] {
    const from = this.ledger.firstOpenDate();
    const out: IsoDate[] = [];
    let year = Number(asOf.slice(0, 4));
    let q = Math.floor((Number(asOf.slice(5, 7)) - 1) / 3); // kwartaal vóór het lopende
    for (let i = 0; i < 12; i++) {
      if (q === 0) {
        year--;
        q = 4;
      }
      const end = `${year}-${['03-31', '06-30', '09-30', '12-31'][q - 1]}`;
      if (from && end < from) break;
      out.push(end);
      q--;
    }
    return out;
  }

  /** Wat er t/m deze datum nog moet gebeuren (of bevestigd moet worden) voordat hij vast kan. */
  checks(until: IsoDate): CloseCheck[] {
    assertIsoDate(until);
    const out: CloseCheck[] = [];
    const open = this.db
      .prepare(`SELECT COUNT(*) AS n FROM bank_transactions WHERE status = 'nieuw' AND transaction_date <= ?`)
      .get(until) as { n: number };
    if (open.n > 0) {
      out.push({ key: 'bank-open', level: 'blokkeert', title: `${open.n} ${open.n === 1 ? 'betaling' : 'betalingen'} t/m ${formatDateNl(until)} nog niet verwerkt`, detail: 'Verwerk ze eerst: na het afsluiten kan een betaling in deze periode niet meer geboekt worden.', screen: 'bank' });
    }
    const docs = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM documents WHERE status IN ('nieuw', 'controle')
           AND COALESCE(json_extract(result, '$.invoiceDate.value'), date(created_at)) <= ?`,
      )
      .get(until) as { n: number };
    if (docs.n > 0) {
      out.push({ key: 'documenten', level: 'blokkeert', title: `${docs.n} ${docs.n === 1 ? 'bon of factuur' : 'bonnen of facturen'} t/m ${formatDateNl(until)} nog niet gecontroleerd`, detail: 'Controleer ze eerst, dan tellen ze mee in deze periode. Wat later nog binnenkomt, komt in de volgende periode.', screen: 'aankopen' });
    }
    const questions = accountOpenItems(this.db, ACCOUNTS.vraagposten, until);
    if (questions.length) out.push({ key: 'vraagposten', level: 'bevestigen', title: `${questions.length} boekingen staan nog bij "weet ik nog niet"`, detail: 'Deel deze boekingen eerst in, of bevestig dat je ze met je boekhouder hebt besproken. Na het afsluiten worden correcties in de volgende open periode geboekt.', screen: 'aankopen' });
    for (const st of this.bank.importStatus()) {
      // een dag is pas gedekt als het afschrift ná die dag is ingelezen (#226): een export van de laatste dag
      // zelf mist wat er later die dag nog bij kwam
      const covered = st.completeTo;
      if (!covered) continue; // rekening zonder afschriften: niets te controleren
      if (covered >= until) continue;
      const statementTo = (this.db.prepare('SELECT MAX(period_to) AS d FROM import_batch_accounts WHERE bank_account_id = ?').get(st.bankAccountId) as { d: string | null }).d;
      // loopt het laatste afschrift wel t/m de einddatum, dan is het op die dag zelf gemaakt
      const sameDay = [st.coverageTo, statementTo].some((d) => d !== null && d >= until);
      // een dag in deze periode die alleen op de dag zelf is ingelezen, terwijl het volgende afschrift later begint
      const { gap } = st;
      out.push({
        key: `bank-afschrift-${st.bankAccountId}`,
        level: 'bevestigen',
        title: gap || sameDay ? `${st.name}: afschriften compleet t/m ${formatDateNl(covered)}` : `${st.name}: afschriften t/m ${formatDateNl(covered)}`,
        detail: gap
          ? `Er is een afschrift op ${formatDateNl(gap)} zelf ingelezen, en het afschrift daarna begint pas later: wat er op die dag later nog bij kwam, staat er niet in. Lees een afschrift in waar ${formatDateNl(gap)} ook in staat en dat je daarna hebt gedownload. Is er die dag echt niets meer op deze rekening gebeurd? Dan kun je dat bevestigen.`
          : sameDay
            ? `Het laatste afschrift is op ${formatDateNl(until)} zelf ingelezen: wat er later die dag nog bij kwam, staat er niet in. Lees een afschrift in dat je daarna hebt gedownload. Is er die dag echt niets meer op deze rekening gebeurd? Dan kun je dat bevestigen.`
            : `Lees een afschrift in dat t/m ${formatDateNl(until)} loopt. Is er na ${formatDateNl(covered)} echt niets meer op deze rekening gebeurd? Dan kun je dat bevestigen.`,
        screen: 'bank',
      });
    }
    // Privé: de Belastingdienst vraagt bij stortingen waar het geld vandaan komt, een boekhouder kijkt daarom naar de stand
    const prive = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN a.rgs_code = ? THEN l.debit - l.credit ELSE 0 END), 0) AS opnames,
                COALESCE(SUM(CASE WHEN a.rgs_code = ? THEN l.credit - l.debit ELSE 0 END), 0) AS stortingen
         FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
         WHERE a.rgs_code IN (?, ?) AND e.entry_date BETWEEN ? AND ?`,
      )
      .get(ACCOUNTS.priveOpnamen, ACCOUNTS.priveStortingen, ACCOUNTS.priveOpnamen, ACCOUNTS.priveStortingen, `${until.slice(0, 4)}-01-01`, until) as { opnames: number; stortingen: number };
    if (prive.opnames !== 0 || prive.stortingen !== 0) {
      const big = this.db
        .prepare(
          `SELECT e.entry_date AS date, SUM(l.credit - l.debit) AS amount FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN chart_of_accounts a ON a.id = l.account_id
           WHERE a.rgs_code = ? AND e.entry_date BETWEEN ? AND ? AND e.reverses_entry_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = e.id)
           GROUP BY e.id HAVING SUM(l.credit - l.debit) >= ? ORDER BY e.entry_date`,
        )
        .all(ACCOUNTS.priveStortingen, `${until.slice(0, 4)}-01-01`, until, PRIVE_DEPOSIT_NOTICE) as { date: IsoDate; amount: number }[];
      out.push({
        key: 'prive',
        level: 'info',
        title: `Privé dit jaar: ${formatEuro(prive.opnames)} opgenomen, ${formatEuro(prive.stortingen)} gestort`,
        detail:
          `Dat is ${formatEuro(prive.opnames - prive.stortingen)} per saldo uit je bedrijf (opnames min stortingen).` +
          (big.length ? ` Grote stortingen: ${big.map((b) => `${formatDateNl(b.date)} ${formatEuro(b.amount)}`).join('; ')}. De Belastingdienst vraagt bij zo'n storting waar het geld vandaan komt: bewaar daar een bewijs van (bijvoorbeeld een afschrift van je spaarrekening).` : ''),
      });
    }
    // Jaarafsluiting: posten zonder bon of betaling die de winst van het jaar veranderen (boekhoudkundig: overlopende posten, voorraad, onderhanden werk)
    if (until.slice(5) === '12-31') {
      const year = Number(until.slice(0, 4));
      const items = this.db.prepare(`SELECT kind, amount FROM year_end_items WHERE year = ? AND removed = 0`).all(year) as { kind: string; amount: Cents }[];
      if (items.length === 0) {
        out.push({
          key: 'jaarafsluiting',
          level: 'bevestigen',
          title: `Jaarafsluiting ${year}: heb je aan vooruitbetaalde kosten, nog te betalen kosten, voorraad en onderhanden werk gedacht?`,
          detail: 'Vooruitbetaald: een verzekering of abonnement dat deels bij volgend jaar hoort. Nog te betalen: kosten van dit jaar waarvan je de factuur nog niet hebt (bv. energie van december). Voorraad: materialen die je op 31 december nog hebt. Onderhanden werk: werk waar je kosten aan maakte maar dat je nog niet factureerde; dat kan je winst flink veranderen, vooral in de bouw. Vul ze in vóór je afsluit, of bevestig dat ze er niet zijn.',
          screen: 'jaarafsluiting',
        });
      } else {
        out.push({ key: 'jaarafsluiting', level: 'info', title: `Jaarafsluiting ${year}: ${items.length} ${items.length === 1 ? 'post' : 'posten'} verwerkt`, detail: `Totaal ${formatEuro(items.reduce((n, i) => n + i.amount, 0))}. Ze worden op 1 januari automatisch omgekeerd, zodat ze alleen in ${year} meetellen.`, screen: 'jaarafsluiting' });
      }
    }
    const drafts = this.db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE status = 'concept' AND invoice_date <= ?`).get(until) as { n: number };
    if (drafts.n > 0) {
      out.push({ key: 'concepten', level: 'info', title: `${drafts.n} ${drafts.n === 1 ? 'conceptfactuur' : 'conceptfacturen'} met een datum t/m ${formatDateNl(until)}`, detail: 'Maak je ze later definitief, dan tellen ze mee in de eerste open periode.', screen: 'werk' });
    }
    return out;
  }

  /** Definitief afsluiten t/m deze datum. Kan niet ongedaan gemaakt worden. */
  close(until: IsoDate, confirmed: string[] = [], asOf: IsoDate = today()): PeriodStatus {
    return tx(this.db, () => {
      this.assertCanLock(until, confirmed, asOf);
      this.db.prepare(`INSERT INTO ledger_locks (until_date, kind, closed_at) VALUES (?, 'afgesloten', datetime('now'))`).run(until);
      return this.status();
    });
  }

  /** De periode t/m `until` gaat naar de boekhouder (uitwisseling `no`): tijdelijk vast. */
  startExchange(until: IsoDate, no: number, confirmed: string[] = [], asOf: IsoDate = today()): PeriodStatus {
    if (!Number.isInteger(no) || no < 1) throw new ValidationError('Ongeldig uitwisselingsnummer');
    return tx(this.db, () => {
      this.assertCanLock(until, confirmed, asOf);
      this.db.prepare(`INSERT INTO ledger_locks (until_date, kind, exchange_no) VALUES (?, 'uitwisseling', ?)`).run(until, no);
      return this.status();
    });
  }

  /** Het antwoord van de boekhouder is ingelezen: de periode is definitief afgesloten. */
  finishExchange(no: number): PeriodStatus {
    return tx(this.db, () => {
      const ex = this.ledger.periodLock().exchange;
      if (!ex || ex.no !== no) throw new ValidationError(`Er loopt geen uitwisseling ${no}`);
      this.db.prepare(`UPDATE ledger_locks SET kind = 'afgesloten', closed_at = datetime('now') WHERE kind = 'uitwisseling'`).run();
      return this.status();
    });
  }

  /** De uitwisseling afbreken (bv. de boekhouder reageert niet): de periode is weer open. */
  abortExchange(): PeriodStatus {
    return tx(this.db, () => {
      this.db.prepare(`DELETE FROM ledger_locks WHERE kind = 'uitwisseling'`).run();
      return this.status();
    });
  }

  /**
   * Voert fn uit zonder slot: alleen voor het inlezen van het antwoord van de boekhouder, dat juist in
   * de vergrendelde periode boekt. Alles in één transactie; daarna geldt het slot weer.
   */
  withoutLock<T>(fn: () => T): T {
    return tx(this.db, () => {
      const added = this.db.prepare('INSERT OR IGNORE INTO ledger_lock_bypass (id) VALUES (1)').run().changes > 0;
      try {
        return fn();
      } finally {
        if (added) this.db.prepare('DELETE FROM ledger_lock_bypass').run();
      }
    });
  }

  private assertCanLock(until: IsoDate, confirmed: string[], asOf: IsoDate): void {
    assertIsoDate(until);
    if (until >= asOf) throw new ValidationError(`Je kunt alleen een periode afsluiten die voorbij is (t/m ${formatDateNl(addDays(asOf, -1))})`);
    const { closedUntil, exchange } = this.ledger.periodLock();
    if (exchange) throw new PeriodLockedError(`De periode t/m ${formatDateNl(exchange.until)} ligt nog bij je boekhouder. Lees eerst zijn antwoord in, of breek de uitwisseling af.`);
    if (closedUntil && until <= closedUntil) throw new ValidationError(`Alles t/m ${formatDateNl(closedUntil)} is al afgesloten`);
    const checks = this.checks(until);
    const blocking = checks.filter((c) => c.level === 'blokkeert');
    if (blocking.length > 0) throw new ValidationError(`Eerst oplossen: ${blocking.map((c) => c.title).join('; ')}`);
    const unconfirmed = checks.filter((c) => c.level === 'bevestigen' && !confirmed.includes(c.key));
    if (unconfirmed.length > 0) throw new ValidationError(`Eerst bevestigen: ${unconfirmed.map((c) => c.title).join('; ')}`);
  }
}
