import type { Db } from '../db/database';
import { DEFAULT_HTML_TEMPLATE } from './default-template';
import { renderTemplate, textToHtml } from './render';
import { formatEuro } from '../shared/money';
import { formatDateNl } from '../shared/dates';
import { ICP_SERVICE_TEXT, ICP_TEXT, OUTSIDE_EU_SERVICE_TEXT, isIcp, type SalesVatCode } from '../shared/vat';
import { computeTotals, lineNet } from './totals';
import type { CompanySettings } from '../settings/settings';
import { formatIban } from '../shared/validation';
import { BEDRIJF_LIMIETEN } from '@gratis-boekhouden/kern';

export type TemplateType = 'factuur' | 'offerte';

export interface TemplateColors {
  primary: string;
  text: string;
  muted: string;
  accentBg: string;
}

export interface TextBlock {
  title: string;
  text: string;
}

export interface DocumentTemplate {
  id: number;
  name: string;
  type: TemplateType;
  /** null = standaard layout gebruiken */
  html_template: string | null;
  logo: string | null;
  colors: TemplateColors;
  font: string;
  text_blocks: TextBlock[];
  is_default: number;
}

export const DEFAULT_COLORS: TemplateColors = { primary: '#1f4e79', text: '#1d1d1f', muted: '#6b6b70', accentBg: '#f2f6fa' };

export const FONTS = ['Helvetica, Arial, sans-serif', 'Georgia, serif', '"Segoe UI", Roboto, sans-serif', '"Courier New", monospace', 'Verdana, sans-serif'];

interface Row extends Omit<DocumentTemplate, 'colors' | 'text_blocks'> {
  colors: string;
  text_blocks: string;
}

const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
// dezelfde grens als het blok bedrijf in de sync: één bron in de kern
const MAX_LOGO_BYTES = BEDRIJF_LIMIETEN.maxLogoBytes;

export class TemplateService {
  constructor(private readonly db: Db) {}

  seedDefaults(): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM templates').get() as { n: number }).n;
    if (count > 0) return;
    this.create({
      name: 'Standaard factuur',
      type: 'factuur',
      is_default: 1,
      text_blocks: [{ title: 'Voorwaarden', text: 'Op al onze werkzaamheden zijn onze algemene voorwaarden van toepassing.' }],
    });
    this.create({
      name: 'Standaard offerte',
      type: 'offerte',
      is_default: 1,
      text_blocks: [{ title: 'Voorwaarden', text: 'Deze offerte is vrijblijvend. Na akkoord plannen we de werkzaamheden in overleg in.' }],
    });
  }

  list(type?: TemplateType): DocumentTemplate[] {
    const rows = (type
      ? this.db.prepare('SELECT * FROM templates WHERE type = ? ORDER BY is_default DESC, name').all(type)
      : this.db.prepare('SELECT * FROM templates ORDER BY type, is_default DESC, name').all()) as Row[];
    return rows.map(parse);
  }

  get(id: number): DocumentTemplate {
    const row = this.db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error('Deze opmaak bestaat niet (meer)');
    return parse(row);
  }

  getDefault(type: TemplateType): DocumentTemplate {
    const row = this.db.prepare('SELECT * FROM templates WHERE type = ? ORDER BY is_default DESC, id LIMIT 1').get(type) as Row | undefined;
    if (!row) throw new Error(`Er is nog geen opmaak voor ${type}`);
    return parse(row);
  }

  create(input: Partial<Omit<DocumentTemplate, 'id'>> & { name: string; type: TemplateType }): DocumentTemplate {
    const clean = this.clean(input);
    const result = this.db
      .prepare('INSERT INTO templates (name, type, html_template, logo, colors, font, text_blocks, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, 0)')
      .run(clean.name, clean.type, clean.html_template, clean.logo, JSON.stringify(clean.colors), clean.font, JSON.stringify(clean.text_blocks));
    const id = Number(result.lastInsertRowid);
    if (input.is_default) this.setDefault(id);
    return this.get(id);
  }

  update(id: number, patch: Partial<Omit<DocumentTemplate, 'id' | 'type'>>): DocumentTemplate {
    const current = this.get(id);
    const clean = this.clean({ ...current, ...patch });
    this.db
      .prepare('UPDATE templates SET name = ?, html_template = ?, logo = ?, colors = ?, font = ?, text_blocks = ? WHERE id = ?')
      .run(clean.name, clean.html_template, clean.logo, JSON.stringify(clean.colors), clean.font, JSON.stringify(clean.text_blocks), id);
    if (patch.is_default) this.setDefault(id);
    return this.get(id);
  }

  setDefault(id: number): void {
    const t = this.get(id);
    this.db.transaction(() => {
      this.db.prepare('UPDATE templates SET is_default = 0 WHERE type = ?').run(t.type);
      this.db.prepare('UPDATE templates SET is_default = 1 WHERE id = ?').run(id);
    })();
  }

  delete(id: number): void {
    const t = this.get(id);
    if (t.is_default) throw new Error('De standaardopmaak kun je niet verwijderen');
    const used = this.db.prepare('SELECT (SELECT COUNT(*) FROM invoices WHERE template_id = ?) + (SELECT COUNT(*) FROM quotes WHERE template_id = ?) AS n').get(id, id) as { n: number };
    if (used.n > 0) throw new Error('Deze opmaak wordt gebruikt door facturen of offertes en kan niet weg');
    this.db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  }

  private clean(input: Partial<DocumentTemplate> & { name: string; type: TemplateType }) {
    if (!input.name.trim()) throw new Error('Naam is verplicht');
    if (!['factuur', 'offerte'].includes(input.type)) throw new Error('Type moet factuur of offerte zijn');
    const colors = { ...DEFAULT_COLORS, ...(input.colors ?? {}) };
    for (const [k, v] of Object.entries(colors)) if (!COLOR_RE.test(v)) throw new Error(`Ongeldige kleur voor ${k}: ${v}`);
    const logo = input.logo ?? null;
    if (logo && !/^data:image\/(png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)) throw new Error('Logo moet een PNG, JPG, SVG of WebP afbeelding zijn');
    if (logo && logo.length > MAX_LOGO_BYTES) throw new Error('Logo is te groot (max ~1 MB)');
    const font = input.font ?? FONTS[0]!;
    if (!/^[\w\s",.-]+$/.test(font)) throw new Error('Ongeldig lettertype');
    const blocks = (input.text_blocks ?? []).map((b) => ({ title: String(b.title ?? '').trim(), text: String(b.text ?? '') })).filter((b) => b.title || b.text);
    const html = input.html_template?.trim() ? input.html_template : null;
    if (html) renderTemplate(html, {}); // syntaxcontrole
    return { name: input.name.trim(), type: input.type, html_template: html, logo, colors, font, text_blocks: blocks };
  }
}

function parse(row: Row): DocumentTemplate {
  return { ...row, colors: { ...DEFAULT_COLORS, ...JSON.parse(row.colors) }, text_blocks: JSON.parse(row.text_blocks) };
}

// ---------- View-model voor rendering ----------

export interface RenderableLine {
  description: string;
  quantity: number;
  unit: string | null;
  unit_price: number;
  vat_code: string;
  vat_percentage: number;
}

export interface RenderableDocument {
  kind: TemplateType;
  number: string | null;
  date: string;
  dueDate?: string | null;
  /** datum van levering of dienst (of begin van de periode), ISO; leeg = de factuurdatum */
  deliveryDate?: string | null;
  deliveryDateTo?: string | null;
  validUntil?: string | null;
  reference?: string | null;
  intro?: string | null;
  notes?: string | null;
  creditOf?: string | null;
  lines: RenderableLine[];
}

export interface RenderableParty {
  name: string;
  contact_name?: string | null;
  address?: string | null;
  postcode?: string | null;
  city?: string | null;
  vat_number?: string | null;
}

function formatQuantity(q: number): string {
  return new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 3 }).format(q);
}

export function renderDocumentHtml(doc: RenderableDocument, customer: RenderableParty, company: CompanySettings, template: DocumentTemplate, opts: { kor?: boolean } = {}): string {
  const lines = doc.lines.map((l) => ({ ...l, vatCode: l.vat_code as SalesVatCode, unitPrice: l.unit_price, vatPercentage: l.vat_percentage }));
  const totals = computeTotals(lines);
  const isInvoice = doc.kind === 'factuur';
  const isCredit = totals.total < 0;
  // KOR-vrijstelling: alleen als er iets vrijgesteld geleverd is. Een dienst die elders belast is (EU-dienst met verlegging, klant buiten de EU) valt er niet onder.
  const elsewhere = (code: string) => code === 'icp-dienst' || code === 'dienst-buiten-eu';
  const korExempt = doc.lines.some((l) => l.vat_code === 'vrijgesteld') || (Boolean(opts.kor) && doc.lines.some((l) => !elsewhere(l.vat_code)));
  const view = {
    style: { ...template.colors, font: template.font, logo: template.logo },
    company: { ...company, iban: company.iban ? formatIban(company.iban) : '' },
    customer,
    doc: {
      title: isInvoice ? (isCredit ? 'Creditfactuur' : 'Factuur') : 'Offerte',
      numberLabel: isInvoice ? 'Factuurnummer' : 'Offertenummer',
      number: doc.number ?? 'CONCEPT',
      date: formatDateNl(doc.date),
      // gewone btw-facturen vermelden altijd de datum van levering of dienst; leeg = de factuurdatum. Onder de KOR en op een creditfactuur alleen als je hem zelf invult.
      delivery: doc.deliveryDate
        ? (doc.deliveryDateTo ? `${formatDateNl(doc.deliveryDate)} t/m ${formatDateNl(doc.deliveryDateTo)}` : formatDateNl(doc.deliveryDate))
        : isInvoice && !isCredit && !korExempt ? formatDateNl(doc.date) : null,
      deliveryLabel: doc.deliveryDateTo ? 'Periode levering/dienst' : 'Datum levering/dienst',
      dueDate: isInvoice && !isCredit && doc.dueDate ? formatDateNl(doc.dueDate) : null,
      validUntil: !isInvoice && doc.validUntil ? formatDateNl(doc.validUntil) : null,
      reference: doc.reference,
      creditOf: doc.creditOf,
      intro: doc.intro,
      introHtml: textToHtml(doc.intro),
      notes: doc.notes,
      notesHtml: textToHtml(doc.notes),
      verlegd: doc.lines.some((l) => l.vat_code === 'verlegd'),
      icp: doc.lines.some((l) => isIcp(l.vat_code)),
      // de wettelijke vermelding hangt af van goederen (art. 138) of diensten (art. 196)
      icpText: [doc.lines.some((l) => l.vat_code === 'icp') ? ICP_TEXT : null, doc.lines.some((l) => l.vat_code === 'icp-dienst') ? ICP_SERVICE_TEXT : null].filter(Boolean).join('; '),
      export: doc.lines.some((l) => l.vat_code === 'export'),
      outsideEuService: doc.lines.some((l) => l.vat_code === 'dienst-buiten-eu'),
      outsideEuServiceText: OUTSIDE_EU_SERVICE_TEXT,
      kor: korExempt,
      isInvoice,
      isCredit,
    },
    lines: doc.lines.map((l) => ({
      description: l.description,
      quantity: formatQuantity(l.quantity),
      unit: l.unit ?? '',
      unitPrice: formatEuro(l.unit_price),
      vatLabel: l.vat_code === 'verlegd' ? 'verlegd' : l.vat_code === 'icp' ? '0% ICP' : l.vat_code === 'icp-dienst' ? 'verlegd' : l.vat_code === 'export' ? '0% uitvoer' : l.vat_code === 'dienst-buiten-eu' ? 'n.v.t.' : l.vat_code === 'vrijgesteld' ? '—' : `${l.vat_percentage}%`,
      net: formatEuro(lineNet({ quantity: l.quantity, unitPrice: l.unit_price })),
    })),
    totals: {
      subtotal: formatEuro(totals.subtotal),
      total: formatEuro(totals.total),
      groups: totals.groups
        .filter((g) => g.percentage > 0)
        .map((g) => ({ label: `BTW ${g.percentage}%`, net: formatEuro(g.net), vat: formatEuro(g.vat) })),
    },
    blocks: template.text_blocks.map((b) => ({ title: b.title, html: textToHtml(b.text) })),
  };
  return renderTemplate(template.html_template ?? DEFAULT_HTML_TEMPLATE, view);
}
