import makeMdns from 'multicast-dns';
import type { MulticastDNS } from 'multicast-dns';
import type { Answer, Question } from 'dns-packet';
import { sameSubnet } from './network';
import { MDNS_SERVICE, PROTOCOL_VERSION, fromBase64Url, DEVICE_ID_BYTES } from './protocol';

/** Wat er op het lokale netwerk bekendgemaakt wordt: waar het ontvangstpunt te vinden is, verder niets. */
export interface Advertisement {
  pcId: string;
  port: number;
  /** het adres van deze computer op dit netwerk */
  address: string;
  /** het netmasker erbij: alleen vragen uit dit netwerk krijgen antwoord */
  netmask: string;
}

export interface Advertiser {
  /** maakt het ontvangstpunt vindbaar op deze adressen; een lege lijst = niets meer bekendmaken */
  update(ads: Advertisement[]): void;
  stop(): void;
}

const RETRY_MS = 5 * 60 * 1000;
const SERVICE = `${MDNS_SERVICE}.local`;
const DIRECTORY = '_services._dns-sd._udp.local';

/** De namen in mDNS: afgeleid van het willekeurige pc-ID, dus zonder computernaam of bedrijfsnaam. */
export function mdnsNames(pcId: string): { instance: string; host: string } {
  const short = (fromBase64Url(pcId, DEVICE_ID_BYTES) ?? Buffer.alloc(4)).subarray(0, 4).toString('hex');
  return { instance: `BoekhoudenVoorNiks-${short}.${SERVICE}`, host: `bvn-${short}.local` };
}

export function mdnsRecords(ad: Advertisement, ttl?: number): { ptr: Answer; directory: Answer; srv: Answer; txt: Answer; a: Answer } {
  const { instance, host } = mdnsNames(ad.pcId);
  return {
    ptr: { name: SERVICE, type: 'PTR', ttl: ttl ?? 4500, data: instance },
    directory: { name: DIRECTORY, type: 'PTR', ttl: ttl ?? 4500, data: SERVICE },
    srv: { name: instance, type: 'SRV', ttl: ttl ?? 120, flush: true, data: { priority: 0, weight: 0, port: ad.port, target: host } },
    txt: { name: instance, type: 'TXT', ttl: ttl ?? 4500, flush: true, data: [`v=${PROTOCOL_VERSION}`, `id=${ad.pcId}`] },
    a: { name: host, type: 'A', ttl: ttl ?? 120, flush: true, data: ad.address },
  };
}

/**
 * Het antwoord op een mDNS-vraag (DNS-SD, RFC 6763), of null als de vraag niet over ons gaat. Bij
 * de vraag "wie biedt _gratisboekhouden._tcp aan?" gaan poort, tekst en adres meteen mee, zodat de
 * telefoon niet nog drie keer hoeft te vragen.
 */
export function mdnsAnswer(questions: Pick<Question, 'name' | 'type'>[], ad: Advertisement): { answers: Answer[]; additionals: Answer[] } | null {
  const r = mdnsRecords(ad);
  const { instance, host } = mdnsNames(ad.pcId);
  const answers = new Set<Answer>();
  const additionals = new Set<Answer>();
  for (const q of questions) {
    const name = q.name.toLowerCase();
    const any = (q.type as string) === 'ANY';
    if (name === DIRECTORY && (q.type === 'PTR' || any)) answers.add(r.directory);
    if (name === SERVICE && (q.type === 'PTR' || any)) {
      answers.add(r.ptr);
      for (const x of [r.srv, r.txt, r.a]) additionals.add(x);
    }
    if (name === instance.toLowerCase()) {
      if (q.type === 'SRV' || any) answers.add(r.srv);
      if (q.type === 'TXT' || any) answers.add(r.txt);
      if (q.type === 'SRV' || any) additionals.add(r.a);
    }
    if (name === host && (q.type === 'A' || any)) answers.add(r.a);
  }
  if (answers.size === 0) return null;
  return { answers: [...answers], additionals: [...additionals].filter((x) => !answers.has(x)) };
}

/**
 * Maakt het ontvangstpunt vindbaar via mDNS (`_gratisboekhouden._tcp`), zodat een nieuw IP-adres na een
 * herstart van de router geen probleem is. Per netwerkadres een eigen socket: het antwoord op een
 * netwerk noemt alleen het adres op dát netwerk. Lukt mDNS niet (poort 5353 bezet of geblokkeerd),
 * dan werkt het ontvangen via de adressen uit de QR-code gewoon door.
 *
 * Alleen vragen uit het eigen netwerk krijgen antwoord, en altijd op het groepsadres van dat netwerk
 * (nooit rechtstreeks naar een afzender): zo is het ontvangstpunt van buiten dat netwerk niet uit te
 * vragen en niet te misbruiken om verkeer naar een ander te sturen.
 */
export class MdnsAdvertiser implements Advertiser {
  private readonly active = new Map<string, { mdns: MulticastDNS; ad: Advertisement }>();
  /** lukte mDNS op een adres niet, dan pas na een tijd opnieuw proberen (niet bij elke ronde) */
  private readonly retryAfter = new Map<string, number>();

  constructor(private readonly log: (message: string) => void = () => undefined) {}

  update(ads: Advertisement[]): void {
    const key = (ad: Advertisement) => `${ad.address}|${ad.port}|${ad.pcId}`;
    const wanted = new Map(ads.map((ad) => [key(ad), ad]));
    for (const k of [...this.active.keys()]) if (!wanted.has(k)) this.close(k);
    for (const [k, ad] of wanted) if (!this.active.has(k) && (this.retryAfter.get(k) ?? 0) <= Date.now()) this.open(k, ad);
  }

  stop(): void {
    for (const k of [...this.active.keys()]) this.close(k);
  }

  private open(k: string, ad: Advertisement): void {
    let mdns: MulticastDNS;
    try {
      mdns = makeMdns({ interface: ad.address, bind: '0.0.0.0', reuseAddr: true });
    } catch (e) {
      this.log(`mDNS starten mislukt: ${(e as Error).message}`);
      return;
    }
    this.active.set(k, { mdns, ad });
    mdns.on('error', (e: Error) => {
      this.log(`mDNS werkt niet op ${ad.address}: ${e.message}`);
      this.retryAfter.set(k, Date.now() + RETRY_MS);
      this.active.delete(k);
      mdns.destroy();
    });
    mdns.on('warning', () => undefined);
    mdns.on('query', (query: { questions: Question[] }, rinfo: { address: string; port: number }) => {
      if (!sameSubnet(rinfo.address, ad)) return;
      const answer = mdnsAnswer(query.questions ?? [], ad);
      if (answer) mdns.respond(answer);
    });
    const announce = () => {
      if (this.active.get(k)?.mdns !== mdns) return;
      const r = mdnsRecords(ad);
      mdns.respond({ answers: [r.ptr, r.srv, r.txt, r.a] });
    };
    mdns.on('ready', () => {
      announce();
      setTimeout(announce, 1_000).unref();
    });
  }

  private close(k: string): void {
    const entry = this.active.get(k);
    if (!entry) return;
    this.active.delete(k);
    const { mdns, ad } = entry;
    try {
      // afmelden: looptijd 0, zodat telefoons de oude plek meteen vergeten
      mdns.respond({ answers: [mdnsRecords(ad, 0).ptr] }, () => mdns.destroy());
    } catch {
      mdns.destroy();
    }
  }
}
