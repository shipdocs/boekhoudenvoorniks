import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import type { OcrOutput, OcrProvider } from './ocr';
import type { DocumentResult, DocumentType, Field, LineItem, VatLine } from './types';

/**
 * Bonnen lezen met een AI-assistent die de gebruiker zelf al heeft: Claude Code (`claude -p`) of
 * Codex (`codex exec`). Geen API-sleutel in de app: de assistent gebruikt het eigen abonnement.
 *
 * Belangrijk verschil met de lokale herkenning: de foto gaat naar Anthropic of OpenAI. Daarom
 * alleen als de gebruiker dat zelf kiest, met uitleg. De assistent krijgt zo weinig mogelijk:
 * - een lege tijdelijke map met alleen deze ene foto als werkmap;
 * - Claude Code: alleen het hulpmiddel Read, geen MCP-servers, hooguit een paar beurten;
 * - Codex: sandbox read-only;
 * - een tijdslimiet.
 * Het antwoord is alleen een voorstel (winkel, datum, bedragen); de gebruiker controleert, en de
 * boeking maken de vaste regels van de app.
 */

export type CliKind = 'claude-code' | 'codex';

export const CLI_LABELS: Record<CliKind, { name: string; company: string }> = {
  'claude-code': { name: 'Claude Code', company: 'Anthropic' },
  codex: { name: 'Codex', company: 'OpenAI' },
};

export interface CliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Start een programma; `input` gaat naar stdin. Uitgevoerd door het hoofdproces (Node). */
export type CliRunner = (cmd: string, args: string[], opts: { cwd: string; input: string; timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<CliRunResult>;

/** Tijdelijke werkmap met alleen het document; wordt na afloop opgeruimd. */
export interface Workspace {
  create(files: { name: string; data: Uint8Array }[]): Promise<string>;
  read(dir: string, name: string): Promise<string | null>;
  remove(dir: string): Promise<void>;
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf' };

/**
 * Waar staat `claude` of `codex`? Een app die vanuit het menu start, krijgt niet altijd het PATH
 * van de terminal; daarom ook de gebruikelijke installatieplekken.
 */
export function findCli(kind: CliKind, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, exists: (p: string) => boolean = existsSync): string | null {
  const base = kind === 'claude-code' ? 'claude' : 'codex';
  const names = platform === 'win32' ? [`${base}.exe`, `${base}.cmd`] : [base];
  const home = env.HOME ?? env.USERPROFILE ?? '';
  const sep = platform === 'win32' ? ';' : delimiter;
  const dirs = [
    ...(env.PATH ?? env.Path ?? '').split(sep).filter(Boolean),
    ...(platform === 'win32'
      ? [env.APPDATA && join(env.APPDATA, 'npm'), env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', base), home && join(home, '.local', 'bin')]
      : [home && join(home, '.local', 'bin'), home && join(home, '.claude', 'local'), home && join(home, '.npm-global', 'bin'), home && join(home, '.bun', 'bin'), home && join(home, '.volta', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']),
  ].filter((d): d is string => Boolean(d));
  for (const d of dirs) for (const n of names) {
    const p = join(d, n);
    if (exists(p)) return p;
  }
  return null;
}

export const RECEIPT_PROMPT = `Je leest een document voor een Nederlandse boekhouding: een kassabon, factuur of creditnota.
Het document staat in het bestand FILE in de huidige map. Lees alleen dat bestand; doe verder niets.
Antwoord met ALLEEN één JSON-object, zonder uitleg en zonder markdown, precies in deze vorm:
{"tekst":["elke regel van het document, van boven naar beneden"],"soort":"bon|factuur|creditnota|onbekend","leverancier":null,"btw_nummer":null,"iban":null,"factuurnummer":null,"datum":"JJJJ-MM-DD of null","vervaldatum":null,"valuta":"EUR","totaal":null,"subtotaal":null,"btw":[{"tarief":21,"grondslag":null,"bedrag":0}],"btw_verlegd":false,"regels":[{"omschrijving":"","aantal":null,"prijs":null,"bedrag":0,"tarief":null}]}
Bedragen als getal in euro's met een punt (12.50), totaal inclusief btw. Onbekend = null. Verzin niets: wat je niet kunt lezen is null.`;

/** Een getal in euro's naar centen; alles wat geen redelijk bedrag is wordt null. */
function cents(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 10_000_000) return null;
  return Math.round(n * 100);
}

function str(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

function isoDate(v: unknown): string | null {
  const s = str(v, 10);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

/** Het eerste JSON-object in een antwoord (soms staat er toch ```json omheen). */
export function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Het antwoord van de assistent naar het vaste formaat van de app. Streng: alleen wat klopt. */
export function toOcrOutput(answer: Record<string, unknown>, source: `ocr:${string}`, confidence = 0.85): OcrOutput {
  const f = <T>(value: T): Field<T> => ({ value, confidence, source });
  const lines = Array.isArray(answer.tekst) ? answer.tekst.map((l) => str(l, 300)).filter((l): l is string => l !== null).slice(0, 400) : [];
  const soort = ({ bon: 'receipt', factuur: 'purchase_invoice', creditnota: 'credit_note' } as Record<string, DocumentType>)[String(answer.soort)] ?? 'unknown';
  const vat: VatLine[] = (Array.isArray(answer.btw) ? answer.btw : [])
    .map((v) => {
      const o = (v ?? {}) as Record<string, unknown>;
      const rate = typeof o.tarief === 'number' && [0, 9, 21].includes(o.tarief) ? o.tarief : null;
      const amount = cents(o.bedrag);
      return rate === null || amount === null ? null : { rate, base: cents(o.grondslag), amount };
    })
    .filter((v): v is VatLine => v !== null);
  const items: Field<LineItem>[] = (Array.isArray(answer.regels) ? answer.regels : [])
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      const description = str(o.omschrijving);
      const amount = cents(o.bedrag);
      if (!description || amount === null) return null;
      return f<LineItem>({ description, quantity: typeof o.aantal === 'number' ? o.aantal : null, unitPrice: cents(o.prijs), amount, vatRate: typeof o.tarief === 'number' ? o.tarief : null });
    })
    .filter((x): x is Field<LineItem> => x !== null)
    .slice(0, 100);
  const total = cents(answer.totaal);
  const subtotal = cents(answer.subtotaal);
  const structured: Partial<DocumentResult> = {
    documentType: f(soort),
    currency: f(str(answer.valuta, 3)?.toUpperCase() ?? 'EUR'),
    vat: f(vat),
    reverseCharge: answer.btw_verlegd === true,
    lineDescriptions: items.map((i) => i.value.description),
  };
  const set = <K extends keyof DocumentResult>(key: K, value: DocumentResult[K] | null | undefined) => {
    if (value !== null && value !== undefined) structured[key] = value;
  };
  const text = (v: unknown, max?: number) => (str(v, max) === null ? null : f(str(v, max)!));
  set('supplier', text(answer.leverancier));
  set('supplierVatNumber', text(answer.btw_nummer, 30));
  set('supplierIban', text(answer.iban, 40));
  set('invoiceNumber', text(answer.factuurnummer, 60));
  const date = isoDate(answer.datum);
  if (date) structured.invoiceDate = f(date);
  const due = isoDate(answer.vervaldatum);
  if (due) structured.dueDate = f(due);
  if (total !== null) structured.total = f(total);
  if (subtotal !== null) structured.subtotal = f(subtotal);
  if (items.length) structured.lines = items;
  return { items: lines.map((text) => ({ text, page: 1, confidence })), structured };
}

/** Foutmelding van de assistent in gewone taal. */
export function friendlyCliError(kind: CliKind, r: CliRunResult): Error {
  const { name } = CLI_LABELS[kind];
  const out = `${r.stderr}\n${r.stdout}`;
  if (r.timedOut) return new Error(`${name} deed er te lang over. Probeer het nog eens, of vul de bon zelf in.`);
  if (/log ?in|logged in|authenticat|unauthori[sz]ed|api key|credit|subscription|401|403/i.test(out)) {
    return new Error(`${name} is niet ingelogd of je abonnement laat het niet toe. Open een terminal, typ "${kind === 'claude-code' ? 'claude' : 'codex'}" en log in. Vul deze bon nu zelf in.`);
  }
  if (/rate.?limit|usage limit|429|overloaded/i.test(out)) return new Error(`${name} heeft even geen ruimte (limiet van je abonnement bereikt). Probeer het later, of vul de bon zelf in.`);
  return new Error(`${name} kon deze bon niet lezen. Vul de gegevens zelf in.`);
}

export class CliAiProvider implements OcrProvider {
  readonly id: string;
  readonly label: string;

  constructor(
    readonly kind: CliKind,
    private readonly command: string,
    private readonly runner: CliRunner,
    private readonly workspace: Workspace,
    private readonly timeoutMs = 180_000,
  ) {
    this.id = kind;
    this.label = `${CLI_LABELS[kind].name} (${CLI_LABELS[kind].company})`;
  }

  async available(): Promise<boolean> {
    return existsSync(this.command);
  }

  /** Programma en argumenten; de opdracht zelf gaat via stdin (geen lastige aanhalingstekens). */
  args(file: string): { args: string[]; answerFile: string | null } {
    if (this.kind === 'claude-code') {
      return {
        args: ['-p', '--output-format', 'json', '--max-turns', '4', '--strict-mcp-config', '--allowedTools', 'Read', '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
        answerFile: null,
      };
    }
    return { args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--image', file, '--output-last-message', 'antwoord.txt', '-'], answerFile: 'antwoord.txt' };
  }

  async recognize(input: { data: Uint8Array; mimeType: string; filename: string }): Promise<OcrOutput> {
    const ext = EXT[input.mimeType];
    if (!ext) throw new Error(`${CLI_LABELS[this.kind].name} kan dit soort bestand niet lezen. Vul de gegevens zelf in.`);
    if (this.kind === 'codex' && ext === 'pdf') throw new Error('Codex leest alleen foto\'s, geen gescande PDF\'s. Vul de gegevens zelf in, of kies de lokale herkenning of Claude Code.');
    const file = `document.${ext}`;
    const dir = await this.workspace.create([{ name: file, data: input.data }]);
    try {
      const { args, answerFile } = this.args(file);
      // de map van het programma vooraan in PATH: dan vindt een npm-installatie ook "node"
      const env = { ...process.env, PATH: [dirname(this.command), process.env.PATH ?? ''].join(delimiter) };
      const r = await this.runner(this.command, args, { cwd: dir, input: RECEIPT_PROMPT.replace('FILE', file), timeoutMs: this.timeoutMs, env });
      if (r.timedOut || r.code !== 0) throw friendlyCliError(this.kind, r);
      let text = r.stdout;
      if (this.kind === 'claude-code') {
        const wrapper = extractJson(r.stdout) as { result?: unknown; is_error?: boolean } | null;
        if (!wrapper || wrapper.is_error || typeof wrapper.result !== 'string') throw friendlyCliError(this.kind, r);
        text = wrapper.result;
      } else if (answerFile) {
        text = (await this.workspace.read(dir, answerFile)) ?? r.stdout;
      }
      const answer = extractJson(text);
      if (!answer) throw friendlyCliError(this.kind, r);
      return toOcrOutput(answer, `ocr:${this.kind}`);
    } finally {
      await this.workspace.remove(dir).catch(() => undefined);
    }
  }
}
