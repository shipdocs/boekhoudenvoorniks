import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ScannerPairing } from './pairing';
import type { ReceiptSpool } from './spool';
import { jpegInfo } from './jpeg-pdf';
import { normalizeRemote, sameSubnet, type LocalInterface } from './network';
import { CONTENT_TYPE, DIRECTION, ENDPOINT_PATH, HEADER_BYTES, LIMITS, PROTOCOL_VERSIONS, RULES_VERSION, TAG_BYTES, ProtocolError, openRequest, parseFrame, readHeader, sealResponse, toBase64Url, type ErrorCode } from './protocol';

export interface ReceiverOptions {
  pairing: ScannerPairing;
  spool: ReceiptSpool;
  /** de adressen waarop geluisterd wordt (alleen het lokale netwerk); tests geven hier 127.0.0.1 */
  interfaces: () => LocalInterface[];
  /** mag deze afzender? Standaard: alleen uit hetzelfde netwerk als het adres waarop hij binnenkomt. */
  peerAllowed?: (remote: string, local: LocalInterface) => boolean;
  now?: () => number;
  /** mag de locatie van een bon bewaard worden? (opt-in van #32; standaard niet) */
  keepLocation?: () => boolean;
  /** een bon is veilig opgeslagen en kan naar de inbox */
  onStored?: () => void;
  /** een telefoon heeft zich gemeld (gekoppeld, of laatst gezien bijgewerkt) */
  onActivity?: () => void;
  log?: (message: string) => void;
}

const MAX_INFLIGHT = 3;
const MAX_FAILURES = 20;
const FAILURE_WINDOW_MS = 60_000;

/**
 * Het ontvangstpunt van de bonnenscanner (#48): een klein HTTP-punt in het hoofdproces.
 *
 * - Het luistert alleen als er minstens één telefoon gekoppeld is (of een QR-code openstaat), alleen
 *   op de privé-adressen van deze computer, en neemt alleen verbindingen aan uit datzelfde netwerk.
 * - Het doet niets met een verzoek dat niet met de sleutel van een gekoppelde telefoon te ontsleutelen
 *   is, en geeft nooit iets uit de administratie terug: alleen "ontvangen" of een foutcode.
 * - Het begrijpt protocolversie 1 (hallo en bon) en, naast die, versie 2: daarbij zegt het
 *   hallo-antwoord van welke versie de btw-regeltabel is, en kan een telefoon een change-set
 *   (`wijziging`) sturen en om `stamgegevens` vragen. Die laatste twee worden in deze stap nog
 *   nergens bewaard of gesynchroniseerd; er gaat alleen een bevestiging terug.
 * - Alles wat binnenkomt is invoer van buiten: begrensd in grootte en op type gecontroleerd. De naam van
 *   het document maakt de app zelf; alleen het ID van de bon wordt (na controle dat het een UUID is) de
 *   naam van het tijdelijke bestand in de wachtrij.
 */
export class ScannerReceiver {
  private readonly servers = new Map<string, Server>();
  private readonly netmasks = new Map<string, string>();
  private currentPort: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** adressen waarvan nu een verzoek wordt ingelezen */
  private readonly inflight = new Set<string>();
  private readonly failures = new Map<string, { count: number; resetAt: number }>();
  private readonly now: () => number;

  constructor(private readonly opts: ReceiverOptions) {
    this.now = opts.now ?? Date.now;
  }

  get running(): boolean {
    return this.servers.size > 0;
  }

  /** De poort waarop geluisterd wordt, of null als het ontvangstpunt uit staat. */
  get port(): number | null {
    return this.running ? this.currentPort : null;
  }

  get addresses(): string[] {
    return [...this.servers.keys()];
  }

  /** De adressen waarop nu geluisterd wordt, met hun netmasker. */
  get interfaces(): LocalInterface[] {
    return this.addresses.map((address) => ({ address, netmask: this.netmasks.get(address) ?? '255.255.255.255' }));
  }

  /**
   * Zet het ontvangstpunt aan of uit naar de stand van nu: aan met minstens één telefoon, anders uit.
   * Ook na een nieuw IP-adres (router herstart): oude adressen dicht, nieuwe open.
   */
  sync(): Promise<void> {
    this.queue = this.queue.then(() => this.apply(this.opts.pairing.hasActive() ? this.opts.interfaces() : [])).catch((e) => this.opts.log?.(`Ontvangstpunt bijwerken mislukt: ${(e as Error).message}`));
    return this.queue;
  }

  stop(): Promise<void> {
    this.queue = this.queue.then(() => this.apply([])).catch(() => undefined);
    return this.queue;
  }

  private async apply(wanted: LocalInterface[]): Promise<void> {
    for (const [address, server] of this.servers) {
      if (wanted.some((w) => w.address === address)) continue;
      this.servers.delete(address);
      await close(server);
    }
    for (const iface of wanted) {
      if (this.servers.has(iface.address)) continue;
      const server = this.create(iface);
      // één vaste poort (staat in de QR-code); alleen als die bezet is en er nog niets luistert een andere
      const preferred = this.servers.size > 0 ? this.currentPort : (this.currentPort ?? this.opts.pairing.port());
      try {
        await listen(server, preferred ?? 0, iface.address);
      } catch (e) {
        if (this.servers.size > 0 || !preferred) {
          this.opts.log?.(`Ontvangstpunt op ${iface.address} starten mislukt: ${(e as Error).message}`);
          continue;
        }
        try {
          await listen(server, 0, iface.address);
        } catch (e2) {
          this.opts.log?.(`Ontvangstpunt op ${iface.address} starten mislukt: ${(e2 as Error).message}`);
          continue;
        }
      }
      const port = (server.address() as { port: number }).port;
      if (port !== this.opts.pairing.port()) this.opts.pairing.setPort(port);
      this.currentPort = port;
      this.servers.set(iface.address, server);
      this.netmasks.set(iface.address, iface.netmask);
    }
    if (this.servers.size === 0) this.failures.clear();
  }

  private create(iface: LocalInterface): Server {
    const allowed = this.opts.peerAllowed ?? sameSubnet;
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        // nooit details naar buiten; de melding staat alleen in het eigen logboek
        this.opts.log?.(`Fout bij een bericht van de bonnenscanner: ${(e as Error).message}`);
        if (!res.headersSent) this.plain(req, res, 500, 'opslaan-mislukt');
        else res.destroy();
      });
    });
    // een verbinding van buiten het eigen netwerk wordt meteen verbroken, vóór er iets gelezen is
    server.on('connection', (socket) => {
      if (!allowed(normalizeRemote(socket.remoteAddress), iface)) socket.destroy();
    });
    server.on('clientError', (_e, socket) => socket.destroy());
    // een fout van het besturingssysteem bij het aannemen van verbindingen mag de app niet laten vallen
    server.on('error', (e) => this.opts.log?.(`Ontvangstpunt op ${iface.address}: ${e.message}`));
    // een verbinding waar tien seconden niets over komt, wordt verbroken (houdt geen plek bezet)
    server.timeout = 10_000;
    server.headersTimeout = 10_000;
    server.requestTimeout = 120_000;
    server.keepAliveTimeout = 5_000;
    server.maxConnections = 8;
    server.maxHeadersCount = 40;
    return server;
  }

  private headers(type: string, length: number): Record<string, string | number> {
    return { 'content-type': type, 'content-length': length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close' };
  }

  /**
   * Fout zonder versleuteling: voor verzoeken die niet van een gekoppelde telefoon blijken te komen.
   * Het antwoord gaat pas weg als de rest van het verzoek binnen is (die wordt weggegooid, niet
   * bewaard), anders ziet de afzender een verbroken verbinding in plaats van de foutcode.
   */
  private plain(req: IncomingMessage, res: ServerResponse, status: number, fout: ErrorCode): void {
    const body = Buffer.from(JSON.stringify({ ok: false, fout }));
    const send = (): void => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, this.headers('application/json', body.length));
      res.end(body);
    };
    if (req.complete) return send();
    const giveUp = setTimeout(() => {
      send();
      setTimeout(() => req.socket.destroy(), 1_000).unref();
    }, 10_000);
    giveUp.unref();
    res.on('close', () => clearTimeout(giveUp));
    req.on('data', () => undefined);
    req.on('end', send);
    req.on('error', () => res.destroy());
  }

  private fail(remote: string): void {
    const now = this.now();
    const f = this.failures.get(remote);
    if (!f || f.resetAt <= now) this.failures.set(remote, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
    else f.count++;
    if (this.failures.size > 500) for (const [k, v] of this.failures) if (v.resetAt <= now) this.failures.delete(k);
  }

  private blocked(remote: string): boolean {
    const f = this.failures.get(remote);
    return !!f && f.resetAt > this.now() && f.count >= MAX_FAILURES;
  }

  /**
   * Leest de body, nooit meer dan aangekondigd. Zodra de kop binnen is, kijken we of het apparaat
   * bekend is; zo niet, dan wordt de rest (tot 20 MB) niet eens in het geheugen genomen.
   */
  private readBody(req: IncomingMessage, length: number): Promise<Buffer | ErrorCode> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let checked = false;
      let settled = false;
      const finish = (result: Buffer | ErrorCode) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      req.on('data', (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > length) return finish('ongeldig');
        chunks.push(chunk);
        if (!checked && total >= HEADER_BYTES + TAG_BYTES) {
          checked = true;
          const head = readHeader(Buffer.concat(chunks, total), DIRECTION.request);
          if (!head) return finish('ongeldig');
          try {
            if (!this.opts.pairing.key(toBase64Url(head.deviceId))) return finish('niet-gekoppeld');
          } catch {
            // de administratie gaat net dicht
            return finish('ongeldig');
          }
        }
      });
      req.on('end', () => finish(total === length ? Buffer.concat(chunks, total) : 'ongeldig'));
      req.on('error', () => finish('ongeldig'));
      req.on('close', () => finish('ongeldig'));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remote = normalizeRemote(req.socket.remoteAddress);
    if (req.url !== ENDPOINT_PATH) return this.plain(req, res, 404, 'onbekend');
    if (req.method !== 'POST') return this.plain(req, res, 405, 'onbekend');
    if (this.blocked(remote)) return this.plain(req, res, 429, 'te-druk');
    if ((req.headers['content-type'] ?? '').trim().toLowerCase() !== CONTENT_TYPE) return this.plain(req, res, 415, 'verkeerd-type');
    const rawLength = req.headers['content-length'];
    if (rawLength === undefined || !/^\d{1,12}$/.test(rawLength) || req.headers['transfer-encoding'] !== undefined) return this.plain(req, res, 411, 'lengte');
    const length = Number(rawLength);
    if (length > LIMITS.maxBodyBytes) return this.plain(req, res, 413, 'te-groot');
    if (length < HEADER_BYTES + TAG_BYTES) return this.plain(req, res, 400, 'ongeldig');
    // hooguit drie tegelijk, en van één adres één: een telefoon stuurt zijn bonnen na elkaar
    if (this.inflight.size >= MAX_INFLIGHT || this.inflight.has(remote)) return this.plain(req, res, 503, 'te-druk');

    this.inflight.add(remote);
    let body: Buffer | ErrorCode;
    try {
      body = await this.readBody(req, length);
    } finally {
      this.inflight.delete(remote);
    }
    if (typeof body === 'string') {
      // ook een afgebroken of ongeldig verzoek telt mee voor "te veel mislukte pogingen"
      this.fail(remote);
      return this.plain(req, res, body === 'niet-gekoppeld' ? 401 : 400, body);
    }

    const head = readHeader(body, DIRECTION.request);
    if (!head) return this.plain(req, res, 400, 'ongeldig');
    const deviceId = toBase64Url(head.deviceId);
    // onbekende telefoon, ingetrokken sleutel, verkeerde sleutel of een aangepast bericht: zelfde antwoord
    const key = this.opts.pairing.key(deviceId);
    const plaintext = key ? openRequest(body, key) : null;
    if (!key || !plaintext) {
      this.fail(remote);
      return this.plain(req, res, 401, 'niet-gekoppeld');
    }

    // Vanaf hier weten we dat het bericht van een gekoppelde telefoon komt: antwoorden gaan versleuteld terug,
    // in dezelfde protocolversie als het verzoek.
    const versie = head.versie;
    const reply = (status: number, json: Record<string, unknown>): void => {
      const out = sealResponse(head.deviceId, key, head.nonce, json, undefined, versie);
      res.writeHead(status, this.headers(CONTENT_TYPE, out.length));
      res.end(out);
    };
    const now = this.now();
    let msg;
    try {
      msg = parseFrame(plaintext, versie);
    } catch (e) {
      return reply(e instanceof ProtocolError && e.code === 'te-groot' ? 413 : 400, { ok: false, fout: e instanceof ProtocolError ? e.code : 'ongeldig' });
    }
    if (Math.abs(msg.tijd - now) > LIMITS.clockWindowMs) return reply(403, { ok: false, fout: 'klok', pcTijd: now });
    // Het bewerkmoment van een change-set (wijziging.tijd) mag willekeurig oud zijn — de wijziging kan
    // offline gemaakt zijn — maar niet verder in de toekomst dan het klokvenster. Dit is de enige
    // plek waar die regel staat; de kern controleert alleen de vorm van de tijd.
    if (msg.soort === 'wijziging' && msg.wijziging.tijd > now + LIMITS.clockWindowMs) return reply(400, { ok: false, fout: 'ongeldig' });
    if (!this.opts.pairing.useNonce(deviceId, head.nonce)) return reply(409, { ok: false, fout: 'herhaald' });

    if (msg.soort === 'hallo') {
      this.opts.pairing.seen(deviceId);
      this.opts.pairing.rename(deviceId, msg.naam);
      this.opts.onActivity?.();
      // Een telefoon van versie 2 krijgt ook de versie van de btw-regeltabel, de protocolversies die
      // deze pc begrijpt, en zijn apparaatcode; versie 1 krijgt precies het oude antwoord.
      const extra = versie >= 2 ? { regels: RULES_VERSION, protocollen: [...PROTOCOL_VERSIONS], apparaatcode: this.opts.pairing.code(deviceId) } : {};
      return reply(200, { ok: true, soort: 'hallo', pc: this.opts.pairing.pcId(), pcTijd: now, limieten: { fotos: LIMITS.maxPhotos, fotoBytes: LIMITS.maxPhotoBytes, notitie: LIMITS.maxNoteChars }, ...extra });
    }

    if (msg.soort === 'wijziging') {
      // Het formaat is gecontroleerd door de kern (change-set, met de idempotentieregel van
      // packages/core). Bewaren en synchroniseren volgt in een latere stap: er gaat niets uit de
      // administratie terug en er wordt niets weggeschreven.
      this.opts.pairing.seen(deviceId);
      this.opts.onActivity?.();
      return reply(200, { ok: true, soort: 'wijziging', entiteit: msg.wijziging.entiteit, uuid: msg.wijziging.uuid, revisie: msg.wijziging.revisie });
    }

    if (msg.soort === 'stamgegevens') {
      // Ook hier: alleen het bericht bestaat al. Welke stamgegevens de pc teruggeeft (klanten,
      // projecten) volgt in een latere stap; nu krijgt de telefoon alleen een bevestiging.
      this.opts.pairing.seen(deviceId);
      this.opts.onActivity?.();
      return reply(200, { ok: true, soort: 'stamgegevens' });
    }

    // alleen echte JPEG's (aan de inhoud gecontroleerd, niet aan een naam of type dat de telefoon opgeeft)
    if (msg.fotos.some((f) => !jpegInfo(f))) return reply(400, { ok: false, fout: 'ongeldig' });
    let outcome: 'nieuw' | 'al' | 'botst';
    try {
      outcome = this.opts.spool.accept(msg, deviceId, { keepLocation: this.opts.keepLocation?.() ?? false });
    } catch (e) {
      // niet opgeslagen: geen bevestiging, de telefoon bewaart de bon en probeert het later opnieuw
      this.opts.log?.(`Bon van de telefoon opslaan mislukt: ${(e as Error).message}`);
      return reply(500, { ok: false, fout: 'opslaan-mislukt' });
    }
    this.opts.pairing.seen(deviceId);
    this.opts.onActivity?.();
    if (outcome === 'botst') return reply(409, { ok: false, fout: 'id-botst', id: msg.id });
    reply(200, { ok: true, soort: 'bon', id: msg.id, al: outcome === 'al' });
    if (outcome === 'nieuw') this.opts.onStored?.();
  }
}

function listen(server: Server, port: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once('error', onError);
    server.listen(port, address, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
