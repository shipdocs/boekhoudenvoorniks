import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { Services } from '../services';
import { periodFor, today } from '../shared/dates';
import { MCP_NAME } from '../shared/brand';

/**
 * Vragen over je eigen boekhouding vanuit Claude Code of Codex (MCP, via stdin/stdout).
 *
 * ALLEEN LEZEN: de database is read-only geopend, en er zijn alleen hulpmiddelen die iets opzoeken.
 * Niets boeken, niets wijzigen, niets versturen. De assistent legt uit; beslissingen over btw en
 * belasting laat de gebruiker controleren door een boekhouder.
 */

export const MCP_INSTRUCTIONS = `Je kijkt mee in de boekhouding van een Nederlandse ondernemer (app "BoekhoudenVoorNiks").
Je kunt alleen lezen: niets boeken of wijzigen. Bedragen zijn in centen (12100 = € 121,00), datums JJJJ-MM-DD.
Leg uit in gewone taal, in het Nederlands. Wat je zegt over btw of inkomstenbelasting is een uitleg, geen advies:
zeg erbij dat de gebruiker het laat controleren door een boekhouder of accountant.`;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run(args: Record<string, unknown>): unknown;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown, def: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(1, Math.floor(v)), max) : def);

export function bookkeepingTools(s: Services, asOf: () => string = today): McpTool[] {
  const period = (v: unknown) => str(v) ?? s.vat.currentPeriod(asOf()).key;
  return [
    {
      name: 'overzicht',
      description: 'Stand van zaken: op de bank, nog te ontvangen van klanten, apart te houden voor btw, omzet en kosten dit jaar en per maand.',
      inputSchema: { type: 'object', properties: {} },
      run: () => s.dashboard.get(asOf()),
    },
    {
      name: 'vandaag',
      description: 'De takenlijst van het scherm Vandaag: wat nog uitgezocht of gedaan moet worden (betalingen indelen, bonnen controleren, btw-aangifte, …).',
      inputSchema: { type: 'object', properties: {} },
      run: () => s.inbox.tasks(asOf()).map((t) => ({ soort: t.kind, titel: t.title, vraag: t.question, bedrag: t.amount ?? null, waarom: t.why ?? null })),
    },
    {
      name: 'btw_periode',
      description: 'Btw-berekening van een periode met alle vakken (rubrieken) van de aangifte en de controles vooraf. Periode als "2026-Q3" (kwartaal), "2026-09" (maand) of "2026" (jaar); leeg = de huidige.',
      inputSchema: { type: 'object', properties: { periode: { type: 'string' } } },
      run: (a) => {
        const key = period(a.periode);
        return { ...s.vat.calculate(key), controles: s.vat.checks(key) };
      },
    },
    {
      name: 'btw_details',
      description: 'De boekingen achter één vak van de btw-aangifte, bv. "1a", "4a", "5b" of "omzet". Handig voor "waarom is dit bedrag zo hoog?".',
      inputSchema: { type: 'object', properties: { periode: { type: 'string' }, vak: { type: 'string' } }, required: ['vak'] },
      run: (a) => s.vat.rubriekDetails(period(a.periode), str(a.vak) ?? 'omzet'),
    },
    {
      name: 'btw_periodes',
      description: 'Alle btw-periodes van een jaar met status (open, concept, ingediend) en het te betalen of terug te krijgen bedrag.',
      inputSchema: { type: 'object', properties: { jaar: { type: 'number' } } },
      run: (a) => s.vat.listPeriods(num(a.jaar, Number(asOf().slice(0, 4)), 2100)),
    },
    {
      name: 'winst_en_verlies',
      description: 'Omzet, kosten en balans over een periode (van/tot als JJJJ-MM-DD); leeg = dit jaar tot vandaag.',
      inputSchema: { type: 'object', properties: { van: { type: 'string' }, tot: { type: 'string' } } },
      run: (a) => s.dashboard.reports(str(a.van) ?? periodFor(asOf(), 'jaar').start, str(a.tot) ?? asOf()),
    },
    {
      name: 'facturen',
      description: 'Verkoopfacturen. Status: concept, openstaand, vervallen, betaald (leeg = alle). Zoektekst optioneel.',
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['concept', 'openstaand', 'vervallen', 'betaald'] }, zoek: { type: 'string' } } },
      run: (a) => s.invoices.list({ status: str(a.status) as never, search: str(a.zoek) }, asOf()),
    },
    {
      name: 'aankopen',
      description: 'Inkoopfacturen en bonnetjes. Status: open of betaald (leeg = alle).',
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'betaald'] } } },
      run: (a) => s.purchases.list({ status: str(a.status) as never }),
    },
    {
      name: 'bank',
      description: 'Banktransacties (nieuwste eerst). Status: nieuw (nog niet ingedeeld), gematcht of genegeerd. Zoektekst optioneel.',
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['nieuw', 'gematcht', 'genegeerd'] }, zoek: { type: 'string' }, aantal: { type: 'number' } } },
      run: (a) => s.bank.list({ status: str(a.status) as never, search: str(a.zoek), limit: num(a.aantal, 100, 1000) }),
    },
    {
      name: 'klanten_en_leveranciers',
      description: 'Klanten en leveranciers met adres, land en btw-nummer.',
      inputSchema: { type: 'object', properties: { soort: { type: 'string', enum: ['klant', 'leverancier'] }, zoek: { type: 'string' } } },
      run: (a) => s.relations.list({ type: str(a.soort) as never, search: str(a.zoek) }),
    },
    {
      name: 'zoeken',
      description: 'Zoek door de hele administratie: facturen, bonnen, betalingen, klanten.',
      inputSchema: { type: 'object', properties: { tekst: { type: 'string' } }, required: ['tekst'] },
      run: (a) => s.search.search(str(a.tekst) ?? ''),
    },
    {
      name: 'inkomstenbelasting',
      description: 'Voorlopige berekening van de winst en fiscale posten van een jaar (ondernemersaftrek, investeringen, kilometers). Een schatting: altijd laten controleren door een boekhouder.',
      inputSchema: { type: 'object', properties: { jaar: { type: 'number' } } },
      run: (a) => s.taxOverview.year(num(a.jaar, Number(asOf().slice(0, 4)), 2100), asOf()),
    },
  ];
}

type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/** Eén JSON-RPC-bericht afhandelen; null = geen antwoord (notificatie). */
export function handleMessage(msg: JsonRpc, tools: McpTool[], version: string): Record<string, unknown> | null {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: MCP_NAME, version },
        instructions: MCP_INSTRUCTIONS,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true } })) });
    case 'tools/call': {
      const name = msg.params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(-32602, `Onbekend hulpmiddel: ${String(name)}`);
      try {
        const args = (msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {}) as Record<string, unknown>;
        const result = tool.run(args);
        return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] });
      } catch (e) {
        const m = (e as Error).message ?? String(e);
        // een schrijfpoging op de read-only database: dat hoort hier niet te gebeuren
        const text = /readonly|read-only|attempt to write/i.test(m) ? 'Dit kan alleen in de app zelf (de koppeling kan alleen lezen).' : m;
        return reply({ content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      if (isNotification) return null; // bv. notifications/initialized
      return fail(-32601, `Niet ondersteund: ${String(msg.method)}`);
  }
}

/** Newline-JSON over stdin/stdout, zoals Claude Code en Codex het verwachten. */
export function runStdio(input: Readable, output: Writable, tools: McpTool[], version: string): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Ongeldige JSON' } })}\n`);
      return;
    }
    // geldige JSON maar geen bericht (null, een getal, een lijst): netjes weigeren, nooit vastlopen
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Ongeldig verzoek' } })}\n`);
      return;
    }
    const res = handleMessage(msg as JsonRpc, tools, version);
    if (res) output.write(`${JSON.stringify(res)}\n`);
  });
  return new Promise((resolve) => rl.on('close', () => resolve()));
}
