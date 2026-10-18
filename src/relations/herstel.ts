import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database';
import { volgendeSyncSeq } from '../sync/teller';

/**
 * Vult klanten aan die na de migratie zijn aangemaakt door een oudere app-versie: zonder uuid en met
 * sync_seq 0. Dat gebeurt bij elke keer openen en niet in een migratie, omdat een migratie één keer
 * draait terwijl een oudere versie van de app de administratie daarna nog kan openen en schrijven.
 *
 * Per rij zonder uuid komt een willekeurige versie-4-uuid; per rij met sync_seq 0 een volgend nummer uit
 * de wijzigingsteller. Alles gebeurt in één transactie. Zonder zulke rijen wordt er niets geschreven.
 * Een fout wordt alleen gelogd: de administratie gaat dan toch open en de volgende keer wordt het
 * opnieuw geprobeerd.
 */
export function herstelRelatieUuids(db: Db, log: (message: string) => void = console.warn): void {
  try {
    const zonderUuid = db.prepare('SELECT id FROM relations WHERE uuid IS NULL ORDER BY id').all() as { id: number }[];
    const zonderVolgnummer = db.prepare('SELECT id FROM relations WHERE sync_seq = 0 ORDER BY id').all() as { id: number }[];
    if (zonderUuid.length === 0 && zonderVolgnummer.length === 0) return;
    db.transaction(() => {
      const zetUuid = db.prepare('UPDATE relations SET uuid = ? WHERE id = ? AND uuid IS NULL');
      for (const r of zonderUuid) zetUuid.run(randomUUID(), r.id);
      const zetSeq = db.prepare('UPDATE relations SET sync_seq = ? WHERE id = ? AND sync_seq = 0');
      for (const r of zonderVolgnummer) zetSeq.run(volgendeSyncSeq(db), r.id);
    })();
    log(`${zonderUuid.length} klant(en) een uuid en ${zonderVolgnummer.length} klant(en) een wijzigingsnummer gegeven`);
  } catch (e) {
    log(`Klanten aanvullen met uuid en wijzigingsnummer is niet gelukt: ${(e as Error).message}`);
  }
}
