import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
 * - Claude Code: alleen het hulpmiddel Read, geen MCP-servers, geen eigen instellingen of hooks,
 *   hooguit een paar beurten;
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
export function findCli(kind: CliKind, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, exists: (p: string) => boolean = existsSync, list: (dir: string) => string[] = listDir): string | null {
  const base = kind === 'claude-code' ? 'claude' : 'codex';
  const names = platform === 'win32' ? [`${base}.exe`, `${base}.cmd`] : [base];
  const home = env.HOME ?? env.USERPROFILE ?? '';
  const sep = platform === 'win32' ? ';' : delimiter;
  const dirs = [
    ...(env.PATH ?? env.Path ?? '').split(sep).filter(Boolean),
    ...(platform === 'win32'
      ? [env.APPDATA && join(env.APPDATA, 'npm'), env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', base), home && join(home, '.local', 'bin')]
      : [home && join(home, '.local', 'bin'), home && join(home, '.claude', 'local'), home && join(home, '.npm-global', 'bin'), home && join(home, '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']),
    // npm install -g onder nvm/fnm/volta: het programma staat naast die Node
    ...nodeDirs(env, platform, list),
  ].filter((d): d is string => Boolean(d));
  for (const d of dirs) for (const n of names) {
    const p = join(d, n);
    if (exists(p)) return p;
  }
  return null;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** "v24.15.0" > "v22.1.0": nieuwste versie eerst */
const byVersionDesc = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });

/**
 * Waar Node staat bij de gebruikelijke versiebeheerders (nvm, fnm, volta, asdf, mise), nieuwste
 * eerst. Claude Code en Codex via npm zijn scripts die "node" nodig hebben; een app die vanuit het
 * menu start, krijgt het PATH uit .bashrc/.zshrc niet mee en vindt Node dan niet.
 */
export function nodeDirs(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, list: (dir: string) => string[] = listDir): string[] {
  if (platform === 'win32') return [];
  const home = env.HOME ?? '';
  if (!home) return [];
  const versions = (dir: string, sub: string[]) => list(dir).sort(byVersionDesc).map((v) => join(dir, v, ...sub));
  const fnm = env.FNM_DIR ?? (platform === 'darwin' ? join(home, 'Library', 'Application Support', 'fnm') : join(home, '.local', 'share', 'fnm'));
  return [
    ...versions(join(env.NVM_DIR ?? join(home, '.nvm'), 'versions', 'node'), ['bin']),
    ...versions(join(fnm, 'node-versions'), ['installation', 'bin']),
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.local', 'share', 'mise', 'shims'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

/**
 * De omgeving om Claude Code of Codex te starten: de map van het programma vooraan (daar staat bij
 * een npm-installatie vaak ook "node"), daarna het PATH van de app, `extraPath` (het PATH van de
 * login-shell) en de plekken van de Node-versiebeheerders.
 */
export function cliEnv(cli: string, base: NodeJS.ProcessEnv = process.env, extraPath = '', platform: string = process.platform, list: (dir: string) => string[] = listDir): NodeJS.ProcessEnv {
  const sep = platform === 'win32' ? ';' : delimiter;
  const parts = [dirname(cli), ...(base.PATH ?? base.Path ?? '').split(sep), ...extraPath.split(sep), ...nodeDirs(base, platform, list)];
  return { ...base, PATH: [...new Set(parts.filter(Boolean))].join(sep) };
}

/**
 * Codex start ook de MCP-servers uit de eigen config.toml van de gebruiker (en eventueel de
 * koppeling met deze app zelf). Voor een bon is dat niet nodig: allemaal uit, per naam.
 */
export function codexMcpOff(configToml: string): string[] {
  const names = new Set<string>();
  for (const m of configToml.matchAll(/^\s*\[mcp_servers\.(?:"([A-Za-z0-9_-]+)"|([A-Za-z0-9_-]+))\]\s*$/gm)) names.add(m[1] ?? m[2] ?? '');
  return [...names].flatMap((n) => ['-c', `mcp_servers.${n}.enabled=false`]);
}

function readCodexConfig(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME ?? join(env.HOME ?? env.USERPROFILE ?? '', '.codex');
  try {
    return readFileSync(join(home, 'config.toml'), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Claude Code afgeschermd: alleen de genoemde hulpmiddelen (ook een kortere opdracht vooraf, dus
 * minder verbruik), geen MCP-servers, geen instellingen of hooks van de gebruiker, geen skills en
 * geen opgeslagen gesprek.
 */
export function claudeBaseArgs(model: string, tools: string): string[] {
  return ['-p', '--output-format', 'json', '--model', model, '--tools', tools, '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence'];
}

/** Codex: niets schrijven, geen MCP-servers van de gebruiker. */
export function codexBaseArgs(configToml: string = readCodexConfig()): string[] {
  return ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', ...codexMcpOff(configToml)];
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
  if (/env: .?node|node: (No such file|not found)|node.*(niet gevonden|is not recognized)/i.test(out)) {
    return new Error(`${name} start niet: het heeft Node.js nodig, en de app vindt Node niet. Installeer Node.js (nodejs.org), of installeer ${name} met het installatieprogramma van ${CLI_LABELS[kind].company} (dan is Node niet nodig).`);
  }
  if (r.code === 127 || (r.code === null && /ENOENT/.test(out))) {
    return new Error(`${name} start niet: het programma is niet (meer) te vinden. Zoek het opnieuw in Instellingen, of kies het zelf.`);
  }
  if (/requires a newer version|newer version of|please (update|upgrade) to the latest|update (codex|claude) to|unknown option|unexpected argument/i.test(out)) {
    return new Error(`${name} is verouderd. Werk het bij: open een terminal en typ "${kind === 'claude-code' ? 'claude update' : 'npm install -g @openai/codex@latest'}". Probeer het daarna opnieuw.`);
  }
  if (/log ?in|logged in|authenticat|unauthori[sz]ed|api key|credit|subscription|401|403/i.test(out)) {
    return new Error(`${name} is niet ingelogd of je abonnement laat het niet toe. Open een terminal, typ "${kind === 'claude-code' ? 'claude' : 'codex'}" en log in. Vul deze bon nu zelf in.`);
  }
  if (/rate.?limit|usage limit|429|overloaded/i.test(out)) return new Error(`${name} heeft even geen ruimte (limiet van je abonnement bereikt). Probeer het later, of vul de bon zelf in.`);
  // de laatste foutregel erbij: dan is te zien wat er misging
  const detail = r.stderr.trim().split('\n').filter((l) => /error|fout|failed/i.test(l)).pop()?.trim().slice(0, 200);
  return new Error(`${name} kon deze bon niet lezen. Vul de gegevens zelf in.${detail ? ` (Melding: ${detail})` : ''}`);
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
        // Sonnet: leest bonnen even goed als Opus, voor een derde van het verbruik
        args: [...claudeBaseArgs('sonnet', 'Read'), '--max-turns', '4', '--allowedTools', 'Read'],
        answerFile: null,
      };
    }
    return { args: [...codexBaseArgs(), '--image', file, '--output-last-message', 'antwoord.txt', '-'], answerFile: 'antwoord.txt' };
  }

  async recognize(input: { data: Uint8Array; mimeType: string; filename: string }): Promise<OcrOutput> {
    const ext = EXT[input.mimeType];
    if (!ext) throw new Error(`${CLI_LABELS[this.kind].name} kan dit soort bestand niet lezen. Vul de gegevens zelf in.`);
    if (this.kind === 'codex' && ext === 'pdf') throw new Error('Codex leest alleen foto\'s, geen gescande PDF\'s. Vul de gegevens zelf in, of kies de lokale herkenning of Claude Code.');
    const file = `document.${ext}`;
    const dir = await this.workspace.create([{ name: file, data: input.data }]);
    try {
      const { args, answerFile } = this.args(file);
      const r = await this.runner(this.command, args, { cwd: dir, input: RECEIPT_PROMPT.replace('FILE', file), timeoutMs: this.timeoutMs, env: cliEnv(this.command) });
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
