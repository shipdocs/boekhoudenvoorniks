import { randomBytes } from 'node:crypto';
import type { Db } from '../db/database';
import type { SecretStore } from '../integrations/types';
import { DEVICE_ID_BYTES, KEY_BYTES, LIMITS, toBase64Url, fromBase64Url } from './protocol';

export interface ScannerDevice {
  id: string;
  name: string;
  /** de telefoon heeft de QR-code nog niet gescand (of zich nog niet gemeld) */
  pending: boolean;
  /** tot wanneer de QR-code geldig is (ms); alleen bij `pending` */
  expiresAt: number | null;
  pairedAt: string | null;
  lastSeenAt: string | null;
  /** de sleutel is nog te openen (niet meer na bv. een andere sleutelhanger of een teruggezette back-up) */
  usable: boolean;
}

interface Row {
  id: string;
  name: string;
  expires_at: number | null;
  paired_at: string | null;
  last_seen_at: string | null;
}

/** Zo lang blijft een QR-code geldig als de telefoon hem niet scant. */
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const MAX_DEVICES = 10;

const secretName = (deviceId: string) => `scanner:key:${deviceId}`;

/**
 * Gekoppelde telefoons van de bonnenscanner (#48). Elke telefoon heeft een eigen sleutel; die staat
 * alleen in de versleutelde geheimenopslag (zoals het SMTP-wachtwoord), nooit leesbaar in de database
 * of in een logboek. Ontkoppelen gooit de sleutel weg: daarna is geen bericht van die telefoon meer
 * te ontsleutelen.
 */
export class ScannerPairing {
  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly now: () => number = Date.now,
  ) {}

  private config(): { pcId?: string; port?: number; firewallSeen?: boolean } {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'scanner'`).get() as { value: string } | undefined;
    try {
      return row ? (JSON.parse(row.value) as { pcId?: string; port?: number; firewallSeen?: boolean }) : {};
    } catch {
      return {};
    }
  }

  private saveConfig(patch: { pcId?: string; port?: number; firewallSeen?: boolean }): void {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES ('scanner', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify({ ...this.config(), ...patch }));
  }

  /**
   * Willekeurig ID van de ontvanger in deze administratie. Zegt niets over de administratie zelf
   * (het is niet het administratie-ID) en mag dus in de QR-code en op het netwerk (mDNS) staan.
   */
  pcId(): string {
    const existing = this.config().pcId;
    if (existing && fromBase64Url(existing, DEVICE_ID_BYTES)) return existing;
    const pcId = toBase64Url(randomBytes(DEVICE_ID_BYTES));
    this.saveConfig({ pcId });
    return pcId;
  }

  port(): number | null {
    const p = this.config().port;
    return typeof p === 'number' && Number.isInteger(p) && p > 0 && p < 65536 ? p : null;
  }

  setPort(port: number): void {
    this.saveConfig({ port });
  }

  firewallSeen(): boolean {
    return this.config().firewallSeen === true;
  }

  markFirewallSeen(): void {
    this.saveConfig({ firewallSeen: true });
  }

  /** Verlopen QR-codes opruimen: de sleutel verdwijnt, het ontvangstpunt kan weer uit. */
  private expire(): void {
    const stale = this.db.prepare('SELECT id FROM scanner_devices WHERE paired_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?').all(this.now()) as { id: string }[];
    for (const d of stale) this.remove(d.id);
  }

  private remove(deviceId: string): void {
    this.secrets.delete(secretName(deviceId));
    this.db.prepare('DELETE FROM scanner_nonces WHERE device_id = ?').run(deviceId);
    this.db.prepare('DELETE FROM scanner_devices WHERE id = ?').run(deviceId);
  }

  list(): ScannerDevice[] {
    this.expire();
    const rows = this.db.prepare('SELECT id, name, expires_at, paired_at, last_seen_at FROM scanner_devices ORDER BY created_at, rowid').all() as Row[];
    return rows.map((r) => ({ id: r.id, name: r.name, pending: r.paired_at === null, expiresAt: r.paired_at === null ? r.expires_at : null, pairedAt: r.paired_at, lastSeenAt: r.last_seen_at, usable: this.key(r.id) !== null }));
  }

  /** Is er (minstens) één telefoon waarvoor het ontvangstpunt aan moet staan? */
  hasActive(): boolean {
    return this.list().some((d) => d.usable);
  }

  /**
   * Begin van het koppelen: een nieuw apparaat-ID en een nieuwe sleutel van 32 willekeurige bytes. De
   * sleutel gaat alleen de QR-code in en de geheimenopslag; lukt veilig opslaan niet, dan wordt er
   * niet gekoppeld.
   */
  begin(): { deviceId: string; key: Buffer; expiresAt: number } {
    this.expire();
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM scanner_devices').get() as { n: number }).n;
    if (count >= MAX_DEVICES) throw new Error(`Er zijn al ${MAX_DEVICES} telefoons gekoppeld. Ontkoppel er eerst een.`);
    const deviceId = toBase64Url(randomBytes(DEVICE_ID_BYTES));
    const key = randomBytes(KEY_BYTES);
    const expiresAt = this.now() + PAIRING_TTL_MS;
    // eerst de sleutel: gooit als er geen veilige opslag is, en dan staat er ook geen telefoon in de lijst
    this.secrets.set(secretName(deviceId), key.toString('base64'));
    const number = (this.db.prepare('SELECT COUNT(*) AS n FROM scanner_devices WHERE paired_at IS NOT NULL').get() as { n: number }).n + 1;
    this.db.prepare('INSERT INTO scanner_devices (id, name, created_at, expires_at) VALUES (?, ?, ?, ?)').run(deviceId, `Telefoon ${number}`, new Date(this.now()).toISOString(), expiresAt);
    return { deviceId, key, expiresAt };
  }

  /** De QR-code is gesloten voordat de telefoon zich meldde: de sleutel weer weg. */
  cancel(deviceId: string): void {
    const row = this.db.prepare('SELECT paired_at FROM scanner_devices WHERE id = ?').get(String(deviceId)) as { paired_at: string | null } | undefined;
    if (row && row.paired_at === null) this.remove(String(deviceId));
  }

  /** Ontkoppelen: de sleutel wordt ingetrokken. */
  unpair(deviceId: string): void {
    this.remove(String(deviceId));
  }

  /** De sleutel van een telefoon, of null als die niet (meer) gekoppeld is of de QR-code verlopen is. */
  key(deviceId: string): Buffer | null {
    const row = this.db.prepare('SELECT paired_at, expires_at FROM scanner_devices WHERE id = ?').get(deviceId) as { paired_at: string | null; expires_at: number | null } | undefined;
    if (!row) return null;
    if (row.paired_at === null && row.expires_at !== null && row.expires_at <= this.now()) return null;
    const stored = this.secrets.get(secretName(deviceId));
    if (!stored) return null;
    const key = Buffer.from(stored, 'base64');
    return key.length === KEY_BYTES ? key : null;
  }

  /**
   * Een nonce mag één keer. Waar = nieuw (en nu onthouden), onwaar = al gezien. De lijst staat in de
   * database, zodat opnieuw starten van de app geen gat geeft; nonces ouder dan het tijdvenster kunnen
   * weg, want zo'n bericht wordt al op zijn tijdstempel geweigerd.
   */
  useNonce(deviceId: string, nonce: Buffer): boolean {
    const now = this.now();
    this.db.prepare('DELETE FROM scanner_nonces WHERE seen_at < ?').run(now - 2 * LIMITS.clockWindowMs);
    return this.db.prepare('INSERT OR IGNORE INTO scanner_nonces (device_id, nonce, seen_at) VALUES (?, ?, ?)').run(deviceId, toBase64Url(nonce), now).changes === 1;
  }

  /** Een geldig bericht van deze telefoon: laatst gezien, en een telefoon die nog wachtte is nu gekoppeld. */
  seen(deviceId: string): void {
    const at = new Date(this.now()).toISOString();
    this.db.prepare('UPDATE scanner_devices SET last_seen_at = ?, paired_at = COALESCE(paired_at, ?), expires_at = NULL WHERE id = ?').run(at, at, deviceId);
  }

  rename(deviceId: string, name: string): void {
    this.db.prepare('UPDATE scanner_devices SET name = ? WHERE id = ?').run(name, deviceId);
  }
}
