import { networkInterfaces } from 'node:os';

/** Een adres van deze computer op een lokaal netwerk. */
export interface LocalInterface {
  address: string;
  netmask: string;
}

function ipv4ToInt(address: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/** Privé-adressen (RFC 1918) en link-local: alleen die horen bij een thuis- of kantoornetwerk. */
export function isPrivateIpv4(address: string): boolean {
  const n = ipv4ToInt(address);
  if (n === null) return false;
  const a = n >>> 24;
  const b = (n >>> 16) & 0xff;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Node geeft een IPv4-afzender op een dual-stack socket als ::ffff:1.2.3.4. */
export function normalizeRemote(address: string | undefined): string {
  return (address ?? '').replace(/^::ffff:/i, '');
}

/** Zit de afzender in hetzelfde netwerk als het adres waarop het verzoek binnenkwam? */
export function sameSubnet(remote: string, local: LocalInterface): boolean {
  const r = ipv4ToInt(normalizeRemote(remote));
  const l = ipv4ToInt(local.address);
  const m = ipv4ToInt(local.netmask);
  if (r === null || l === null || m === null) return false;
  return ((r & m) >>> 0) === ((l & m) >>> 0);
}

/** Virtuele netwerken (Docker, virtuele machines, VPN): daar zit geen telefoon op. */
const VIRTUAL = /^(docker|br-|virbr|veth|vmnet|vboxnet|tun|tap|wg|zt|tailscale|proton|utun|ppp)|vethernet|virtualbox|vmware|hyper-v|wsl|loopback|bluetooth/i;

/**
 * De adressen waarop het ontvangstpunt luistert: alleen IPv4, alleen privé-adressen, geen virtuele
 * netwerken en geen VPN. Het waarschijnlijkste thuisnetwerk (192.168.x.x) eerst.
 */
export function localInterfaces(all: ReturnType<typeof networkInterfaces> = networkInterfaces()): LocalInterface[] {
  const out: LocalInterface[] = [];
  for (const [name, addrs] of Object.entries(all)) {
    if (VIRTUAL.test(name)) continue;
    for (const a of addrs ?? []) {
      const v4 = a.family === 'IPv4' || (a.family as unknown) === 4;
      // een /32 is een tunnel (VPN), geen netwerk met andere apparaten
      if (!v4 || a.internal || !isPrivateIpv4(a.address) || a.netmask === '255.255.255.255') continue;
      if (!out.some((o) => o.address === a.address)) out.push({ address: a.address, netmask: a.netmask });
    }
  }
  const rank = (a: string) => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : a.startsWith('172.') ? 2 : 3);
  return out.sort((x, y) => rank(x.address) - rank(y.address) || x.address.localeCompare(y.address));
}
