import type { Db } from '../db/database';
import { EXPENSE_CATEGORIES, type CategoryLookup, type ExpenseCategory } from '../shared/categories';
import { ValidationError } from '../shared/validation';
import { isPurchaseVatCode, type PurchaseVatCode } from '../shared/vat';

/** Een categorie zoals de gebruiker hem ziet, met wat er aan veranderd is. */
export interface CategoryView extends ExpenseCategory {
  builtIn: boolean;
  hidden: boolean;
  /** ingebouwde categorie met een eigen naam, uitleg of btw */
  changed: boolean;
  /** eigen categorie: de ingebouwde categorie waarvan hij de grootboekrekening gebruikt */
  groupKey: string | null;
}

interface Row {
  key: string;
  built_in: number;
  label: string | null;
  hint: string | null;
  default_vat: string | null;
  group_key: string | null;
  hidden: number;
}

const MAX_CUSTOM = 50;
/** Nooit verbergen: de categorie waar alles op terugvalt. */
const ALWAYS_VISIBLE = new Set(['overig']);
/** Hier kan een eigen categorie niet onder vallen: een investering wordt apart afgeschreven. */
const NO_GROUP = new Set(['investering']);

const BUILT_IN = new Map(EXPENSE_CATEGORIES.map((c) => [c.key, c]));

function cleanText(value: unknown, field: string, max: number, required: boolean): string {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  if (required && !text) throw new ValidationError(`Vul een ${field} in`);
  if (text.length > max) throw new ValidationError(`De ${field} is te lang (hoogstens ${max} tekens)`);
  return text;
}

/**
 * Kostencategorieën ("Wat heb je gekocht?"): de ingebouwde lijst plus wat de gebruiker zelf
 * toevoegt of aanpast. Veilig: een categorie verdwijnt nooit (alleen verbergen), en een eigen
 * categorie boekt op de rekening van een ingebouwde, zodat de boekhouder alles terugvindt.
 * Oude boekingen veranderen nooit: die staan op een grootboekrekening, niet op een categorie.
 */
export class CategoryService implements CategoryLookup {
  constructor(private readonly db: Db) {}

  private rows(): Map<string, Row> {
    const rows = this.db.prepare('SELECT * FROM expense_categories ORDER BY rowid').all() as Row[];
    return new Map(rows.map((r) => [r.key, r]));
  }

  /** Alle categorieën, ook verborgen (voor het beheerscherm). */
  all(): CategoryView[] {
    const rows = this.rows();
    const out: CategoryView[] = [];
    for (const base of EXPENSE_CATEGORIES) {
      const r = rows.get(base.key);
      const view: CategoryView = {
        ...base,
        label: r?.label ?? base.label,
        hint: r?.hint ?? base.hint,
        defaultVat: r?.default_vat && isPurchaseVatCode(r.default_vat) ? r.default_vat : base.defaultVat,
        builtIn: true,
        hidden: Boolean(r?.hidden),
        changed: Boolean(r && (r.label !== null || r.hint !== null || r.default_vat !== null)),
        groupKey: null,
      };
      // eigen categorieën vóór "Overige kosten", zodat die als laatste keuze blijft staan
      if (base.key === 'overig') out.push(...this.custom(rows));
      out.push(view);
    }
    return out;
  }

  private custom(rows: Map<string, Row>): CategoryView[] {
    return [...rows.values()]
      .filter((r) => !r.built_in)
      .map((r) => {
        const group = BUILT_IN.get(r.group_key ?? '') ?? BUILT_IN.get('overig')!;
        return {
          key: r.key,
          label: r.label ?? r.key,
          hint: r.hint ?? '',
          account: group.account,
          defaultVat: r.default_vat && isPurchaseVatCode(r.default_vat) ? r.default_vat : group.defaultVat,
          builtIn: false,
          hidden: Boolean(r.hidden),
          changed: false,
          groupKey: group.key,
        };
      });
  }

  /** Wat je kunt kiezen (zonder verborgen categorieën). */
  list(): ExpenseCategory[] {
    return this.all().filter((c) => !c.hidden).map(({ key, label, hint, account, defaultVat }) => ({ key, label, hint, account, defaultVat }));
  }

  /** Ook een verborgen categorie wordt gevonden: eerder geleerde leveranciers blijven werken. */
  find(key: string): ExpenseCategory | undefined {
    const c = this.all().find((x) => x.key === key);
    return c ? { key: c.key, label: c.label, hint: c.hint, account: c.account, defaultVat: c.defaultVat } : undefined;
  }

  /** "materiaal", "privé" of de key zelf als de categorie niet (meer) bestaat. */
  label(key: string): string {
    return this.find(key)?.label.toLowerCase() ?? key;
  }

  /** Ingebouwde categorieën waar een eigen categorie onder kan vallen. */
  groups(): { key: string; label: string }[] {
    return EXPENSE_CATEGORIES.filter((c) => !NO_GROUP.has(c.key)).map((c) => ({ key: c.key, label: c.label }));
  }

  private assertUniqueLabel(label: string, exceptKey: string | null): void {
    const clash = this.all().find((c) => c.key !== exceptKey && !c.hidden && c.label.toLowerCase() === label.toLowerCase());
    if (clash) throw new ValidationError(`Er is al een categorie "${clash.label}"`);
  }

  private assertVat(code: unknown): asserts code is PurchaseVatCode {
    if (typeof code !== 'string' || !isPurchaseVatCode(code)) throw new ValidationError('Kies de btw die meestal op de bon staat');
  }

  private assertGroup(key: unknown): asserts key is string {
    if (typeof key !== 'string' || !BUILT_IN.has(key) || NO_GROUP.has(key)) throw new ValidationError('Kies bij welke soort kosten deze categorie hoort');
  }

  /** Nieuwe eigen categorie. Hij boekt op de rekening van de gekozen ingebouwde categorie. */
  add(input: { label: string; hint?: string; groupKey: string; defaultVat?: string }): CategoryView {
    const label = cleanText(input.label, 'naam', 60, true);
    const hint = cleanText(input.hint ?? '', 'uitleg', 200, false);
    this.assertGroup(input.groupKey);
    const defaultVat = input.defaultVat ?? BUILT_IN.get(input.groupKey)!.defaultVat;
    this.assertVat(defaultVat);
    this.assertUniqueLabel(label, null);
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM expense_categories WHERE built_in = 0').get() as { n: number }).n;
    if (count >= MAX_CUSTOM) throw new ValidationError(`Je hebt al ${MAX_CUSTOM} eigen categorieën. Verberg of hergebruik er een.`);
    let n = count + 1;
    while (this.db.prepare('SELECT 1 FROM expense_categories WHERE key = ?').get(`eigen-${n}`)) n++;
    const key = `eigen-${n}`;
    this.db.prepare('INSERT INTO expense_categories (key, built_in, label, hint, default_vat, group_key) VALUES (?, 0, ?, ?, ?, ?)').run(key, label, hint, defaultVat, input.groupKey);
    return this.all().find((c) => c.key === key)!;
  }

  /**
   * Naam, uitleg en btw aanpassen. Bij een eigen categorie ook "hoort bij". Geldt voor wat je
   * vanaf nu boekt; bestaande boekingen blijven zoals ze zijn.
   */
  update(key: string, input: { label?: string; hint?: string; defaultVat?: string; groupKey?: string }): CategoryView {
    const current = this.all().find((c) => c.key === key);
    if (!current) throw new ValidationError('Deze categorie bestaat niet');
    const label = input.label === undefined ? current.label : cleanText(input.label, 'naam', 60, true);
    const hint = input.hint === undefined ? current.hint : cleanText(input.hint, 'uitleg', 200, false);
    const defaultVat = input.defaultVat ?? current.defaultVat;
    this.assertVat(defaultVat);
    this.assertUniqueLabel(label, key);
    if (current.builtIn) {
      if (input.groupKey !== undefined) throw new ValidationError('Bij een vaste categorie blijft de grootboekrekening hetzelfde, zodat je boekhouder alles terugvindt');
      const base = BUILT_IN.get(key)!;
      // alleen afwijkingen bewaren: zo komt een verbetering van de standaardtekst gewoon door
      const diff = (v: string, b: string) => (v === b ? null : v);
      this.db
        .prepare(
          `INSERT INTO expense_categories (key, built_in, label, hint, default_vat) VALUES (?, 1, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET label = excluded.label, hint = excluded.hint, default_vat = excluded.default_vat, updated_at = datetime('now')`,
        )
        .run(key, diff(label, base.label), diff(hint, base.hint), diff(defaultVat, base.defaultVat));
    } else {
      const groupKey = input.groupKey ?? current.groupKey!;
      this.assertGroup(groupKey);
      this.db.prepare(`UPDATE expense_categories SET label = ?, hint = ?, default_vat = ?, group_key = ?, updated_at = datetime('now') WHERE key = ?`).run(label, hint, defaultVat, groupKey, key);
    }
    return this.all().find((c) => c.key === key)!;
  }

  /** Verbergen in plaats van verwijderen: eerdere boekingen en geleerde leveranciers blijven kloppen. */
  setHidden(key: string, hidden: boolean): CategoryView {
    const current = this.all().find((c) => c.key === key);
    if (!current) throw new ValidationError('Deze categorie bestaat niet');
    if (hidden && ALWAYS_VISIBLE.has(key)) throw new ValidationError(`"${current.label}" blijft altijd staan: daar valt alles op terug`);
    if (!hidden) this.assertUniqueLabel(current.label, key);
    this.db
      .prepare(
        `INSERT INTO expense_categories (key, built_in, hidden) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET hidden = excluded.hidden, updated_at = datetime('now')`,
      )
      .run(key, hidden ? 1 : 0);
    return this.all().find((c) => c.key === key)!;
  }

  /** Ingebouwde categorie terug naar de standaard naam, uitleg en btw (en weer zichtbaar). */
  reset(key: string): CategoryView {
    const base = BUILT_IN.get(key);
    if (!base) throw new ValidationError('Alleen een vaste categorie kan terug naar de standaard');
    this.assertUniqueLabel(base.label, key);
    this.db.prepare('DELETE FROM expense_categories WHERE key = ? AND built_in = 1').run(key);
    return this.all().find((c) => c.key === key)!;
  }
}
