import { safeStorage } from 'electron';
import type { Db } from '../db/database';
import type { SecretStore } from '../integrations/types';

/** Geheimen (SMTP-wachtwoord, API-sleutels) versleuteld met het OS-sleutelbeheer via Electron safeStorage. */
export class SafeStorageSecretStore implements SecretStore {
  constructor(private readonly db: Db) {}

  get available(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM secrets WHERE key = ?').get(key) as { value: Buffer } | undefined;
    if (!row) return null;
    try {
      return safeStorage.decryptString(row.value);
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    if (!this.available) throw new Error('Veilige opslag is niet beschikbaar op dit systeem (geen sleutelhanger gevonden)');
    this.db.prepare('INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, safeStorage.encryptString(value));
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM secrets WHERE key = ?').run(key);
  }
}
