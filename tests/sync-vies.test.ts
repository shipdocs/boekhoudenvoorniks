import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computeTotals, type LineInput } from '@gratis-boekhouden/kern';
import { setup } from './helpers';
import { createApi, type HostContext } from '../src/main/api';
import { RelationsService } from '../src/relations/relations';
import { SyncOntvangst } from '../src/sync/ontvangst';
import { VIES_API } from '../src/btw/vies';
import type { Task } from '../src/inbox/inbox';

// De VIES-nacontrole op Vandaag (s14c): een melding met een knop, nooit een automatische controle. Echte databank,
// echte SyncOntvangst, InvoiceService, ViesService en api; alleen het netwerk van VIES is nagebootst (met een teller).
// Datums zijn relatief aan nu; de btw-taak 'vat-due' hangt van de datum van vandaag af en wordt dus nooit verwacht.

type Fetch = NonNullable<Parameters<typeof setup>[0]>['fetch'];

const DAG = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DATUM = iso(Date.now() - 10 * DAG);
const JAAR = Number(DATUM.slice(0, 4));
const BEDRIJF = { name: 'Jansen Klus', address: 'Werfstraat 2', city: 'Zwolle', kvkNumber: '87654321', vatNumber: 'NL987654321B01', kor: false };

/** VIES nagebootst per landcode: DE geldig, FR ongeldig, IT geen uitslag, ES onbereikbaar; elk verzoek wordt geteld. */
function maakFetch() {
  const urls: string[] = [];
  const fetch: Fetch = async (url) => {
    urls.push(url);
    const land = /\/ms\/([A-Z]{2})\//.exec(url)?.[1];
    if (land === 'ES') throw new Error('netwerk');
    if (land === 'IT') return { ok: true, status: 200, json: async () => ({ userError: 'MS_UNAVAILABLE' }), text: async () => '' };
    const body = { isValid: land !== 'FR', name: 'Naam BV', address: 'Straat 1' };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { urls, fetch };
}

function omgeving() {
  const net = maakFetch();
  const t = setup({ fetch: net.fetch });
  const sync = new SyncOntvangst(t.db, new RelationsService(t.db), { now: () => Date.now(), invoices: t.s.invoices });
  let volgnr = 0;
  const api = () => createApi(t.s, { appVersion: () => 'test' } as unknown as HostContext);
  /** een klant via de telefoonroute, met btw-nummer; geeft id en uuid */
  const klant = (naam: string, btw?: string) => {
    const uuid = randomUUID();
    expect(sync.verwerk('apparaat-1', 'M1', { entiteit: 'klant', uuid, revisie: 1, tijd: Date.now() - 5 * DAG, velden: { naam, ...(btw ? { btw_nummer: btw } : {}) } })).toMatchObject({ status: 200, uitkomst: 'toegepast' });
    const id = (t.db.prepare('SELECT id FROM relations WHERE uuid = ?').get(uuid) as { id: number }).id;
    return { id, uuid };
  };
  /** een telefoonfactuur voor deze klant, met de gegeven btw-soort op de regel */
  const factuur = (klantUuid: string, btw: 'icp' | 'icp-dienst' | 'hoog' = 'icp') => {
    volgnr += 1;
    const nummer = `M1-${JAAR}-${String(volgnr).padStart(4, '0')}`;
    const totalen = computeTotals([{ description: 'Montage', quantity: 2, unitPrice: 4550, vatCode: btw } as LineInput]);
    const uitkomst = sync.verwerk('apparaat-1', 'M1', {
      entiteit: 'factuur', uuid: randomUUID(), revisie: 1, tijd: Date.now() - DAG,
      velden: {
        nummer, datum: DATUM, vervaldatum: iso(Date.parse(DATUM) + 30 * DAG), klant_uuid: klantUuid,
        klant_momentopname: { name: 'Klant', address: 'Straat 1', city: 'Berlijn', country: 'DE', vat_number: 'DE123456789', kvk_number: '12345678', email: 'info@klant.example' },
        bedrijf_momentopname: { ...BEDRIJF },
        regels: [{ omschrijving: 'Montage', hoeveelheid: 2, prijs: 4550, btw_soort: btw, eenheid: 'uur' }],
        totalen: { subtotaal: totalen.subtotal, btw: totalen.vatTotal, totaal: totalen.total },
        verzonden_op: `${DATUM} 10:30:00`, regeltabel_versie: '2026-1',
      },
    });
    expect(uitkomst, JSON.stringify(uitkomst)).toMatchObject({ status: 200, uitkomst: 'toegepast' });
    return nummer;
  };
  const taken = () => t.s.inbox.tasks().filter((x) => x.kind === 'vies-nacontrole');
  const uitslagen = () => (t.db.prepare('SELECT vat_number, relation_id, valid, message FROM vies_checks ORDER BY id').all() as { vat_number: string; relation_id: number | null; valid: number | null; message: string | null }[]);
  return { ...t, net, sync, klant, factuur, taken, uitslagen, api };
}

describe('VIES-nacontrole op Vandaag', () => {
  it('VIESN-01 niets te melden: zonder telefoonfacturen, en met een telefoonfactuur zonder icp- of icp-dienst-regel, komt er geen taak en verandert Vandaag niet.', () => {
    const o = omgeving();
    const k = o.klant('Duitse Klant', 'DE123456789');
    const voor = o.s.inbox.tasks().map((x) => x.key);
    expect(o.taken()).toEqual([]);
    o.factuur(k.uuid, 'hoog');
    expect(n(o.db, `SELECT COUNT(*) AS n FROM invoices WHERE apparaat_code IS NOT NULL`)).toBe(1);
    expect(o.taken()).toEqual([]);
    expect(o.s.inbox.tasks().filter((x) => x.kind !== 'vat-due').map((x) => x.key)).toEqual(voor.filter((x) => !x.startsWith('vat-due')));
    expect(o.net.urls).toEqual([]);
  });

  it('VIESN-02 ongecontroleerd: een geimporteerde telefoonfactuur met een icp- of icp-dienst-regel naar een klant met btw-nummer zonder uitslag geeft precies een taak per klant en btw-nummer, ook bij meerdere facturen; berekenen herhalen geeft dezelfde ene taak (idempotent).', () => {
    const o = omgeving();
    const k = o.klant('Duitse Klant', 'de 123.456-789');
    const nr1 = o.factuur(k.uuid, 'icp');
    const nr2 = o.factuur(k.uuid, 'icp-dienst');
    expect(n(o.db, `SELECT COUNT(*) AS n FROM invoices WHERE apparaat_code = 'M1' AND status <> 'concept' AND credit_of_invoice_id IS NULL`)).toBe(2);
    const eerste = o.taken();
    expect(eerste).toHaveLength(1);
    expect(eerste[0]).toMatchObject({ key: `vies-klant:${k.id}-onbekend-DE123456789`, kind: 'vies-nacontrole', priority: 2, ref: { relationId: k.id } });
    expect(eerste[0]!.question).toContain('2 telefoonfacturen');
    expect(eerste[0]!.question).toContain(nr1);
    expect(eerste[0]!.question).toContain(nr2);
    expect(eerste[0]!.title).toContain('nog niet in VIES gecontroleerd');
    expect(o.taken()).toEqual(eerste);
    expect(o.taken()).toEqual(eerste);
    expect(o.s.inbox.home().tasks.filter((x) => x.kind === 'vies-nacontrole')).toEqual(eerste);
    // begrensd: bij veel klanten hoogstens 50 taken, de rest in een telling in de laatste taak
    for (let i = 0; i < 55; i++) o.factuur(o.klant(`Klant ${i}`, `DE5000000${String(i).padStart(2, '0')}`).uuid);
    const veel = o.taken();
    expect(veel).toHaveLength(50);
    expect(new Set(veel.map((x) => x.key)).size).toBe(50);
    expect(veel[49]!.question).toContain('nog 6 andere klanten');
    expect(veel[0]!.question).not.toContain('andere klanten');
  });

  it('VIESN-03 pc-factuur: dezelfde situatie met een gewone pc-factuur (zonder apparaat_code) geeft geen taak (de bestaande btw-aangiftecontrole in src/btw/checks.ts dekt die).', () => {
    const o = omgeving();
    const k = o.klant('Duitse Klant', 'DE123456789');
    o.s.relations.update(k.id, { address: 'Hauptstrasse 1', city: 'Berlijn', country: 'DE' });
    const f = o.s.invoices.finalize(o.s.invoices.createDraft({ relationId: k.id, invoiceDate: DATUM, lines: [{ description: 'Montage', quantity: 1, unitPrice: 10000, vatCode: 'icp' }] }).id);
    expect(n(o.db, `SELECT COUNT(*) AS n FROM invoices WHERE id = ? AND apparaat_code IS NULL AND status <> 'concept'`, f.id)).toBe(1);
    expect(n(o.db, `SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ? AND vat_code = 'icp'`, f.id)).toBe(1);
    expect(o.taken()).toEqual([]);
  });

  it('VIESN-04 uitslag: een geldige uitslag haalt de taak weg; een ongeldige uitslag houdt de taak met een andere titel en tekst (VIES kent het nummer niet); een controle zonder uitslag (valid null) telt als nog niet gecontroleerd.', async () => {
    const o = omgeving();
    const de = o.klant('Duitse Klant', 'DE123456789');
    const fr = o.klant('Franse Klant', 'FR12345678901');
    const it = o.klant('Italiaanse Klant', 'IT12345678901');
    for (const k of [de, fr, it]) o.factuur(k.uuid);
    expect(o.taken()).toHaveLength(3);
    await o.s.vies.check('DE123456789', de.id);
    await o.s.vies.check('FR12345678901', fr.id);
    await o.s.vies.check('IT12345678901', it.id);
    expect(o.uitslagen().map((u) => u.valid)).toEqual([1, 0, null]);
    const na = o.taken();
    expect(na.map((x) => x.key).sort()).toEqual([`vies-klant:${fr.id}-ongeldig-FR12345678901`, `vies-klant:${it.id}-onbekend-IT12345678901`].sort());
    const ongeldig = na.find((x) => x.ref.relationId === fr.id)!;
    expect(ongeldig.title).toContain('kent');
    expect(ongeldig.title).not.toContain('nog niet');
    expect(ongeldig.question).toContain('VIES kent het btw-nummer FR12345678901 niet');
    expect(na.find((x) => x.ref.relationId === it.id)!.title).toContain('nog niet in VIES gecontroleerd');
  });

  it('VIESN-05 geen netwerk zonder knop: het opbouwen van Vandaag doet nooit een verzoek naar VIES (een teller op de nagebootste fetch blijft 0), ook niet na een telefoonfactuur.', async () => {
    const o = omgeving();
    const k = o.klant('Duitse Klant', 'DE123456789');
    o.factuur(k.uuid);
    expect(o.taken()).toHaveLength(1);
    o.s.inbox.tasks();
    o.s.inbox.home();
    await o.api().home.get();
    expect(o.net.urls).toHaveLength(0);
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM vies_checks')).toBe(0);
  });

  it('VIESN-06 knop controleer: de actie roept ViesService.check aan met het btw-nummer en de klant, stuurt precies een verzoek met alleen dat nummer naar de VIES-url, bewaart de uitslag en laat bij geldig de taak verdwijnen.', async () => {
    const o = omgeving();
    const k = o.klant('Duitse Klant', 'DE123456789');
    o.factuur(k.uuid);
    const [taak] = o.taken();
    expect(taak!.actions.map((a) => a.id)).toEqual(['controleer', 'open', 'gezien']);
    expect(taak!.actions[0]).toMatchObject({ primary: true });
    expect(o.s.inbox.home().tasks.find((x) => x.key === taak!.key)!.actions[0]!.hint).toContain('ec.europa.eu');
    // een taak van de interface met een ander nummer in de ref of key doet niets: de pc haalt klant en nummer zelf op
    await expect(o.api().home.act({ ...taak!, key: `vies-klant:${k.id}-onbekend-DE999999999` }, 'controleer')).rejects.toThrow(/intussen veranderd/);
    expect(o.net.urls).toHaveLength(0);
    await o.api().home.act(taak!, 'controleer');
    expect(o.net.urls).toEqual([`${VIES_API}/DE/vat/123456789`]);
    expect(o.uitslagen()).toEqual([{ vat_number: 'DE123456789', relation_id: k.id, valid: 1, message: null }]);
    expect(o.taken()).toEqual([]);
  });

  it('VIESN-07 knop zonder uitslag: bij een mislukte of onbereikbare VIES geeft de actie een duidelijke Nederlandse fout (de reden van VIES), bewaart de controle zoals nu, en laat de taak staan.', async () => {
    const o = omgeving();
    const es = o.klant('Spaanse Klant', 'ESB12345678');
    const it = o.klant('Italiaanse Klant', 'IT12345678901');
    o.factuur(es.uuid);
    o.factuur(it.uuid);
    const taken = o.taken();
    expect(taken).toHaveLength(2);
    const spaans = taken.find((x) => x.ref.relationId === es.id)!;
    const italiaans = taken.find((x) => x.ref.relationId === it.id)!;
    await expect(o.api().home.act(spaans, 'controleer')).rejects.toThrow(/VIES was niet bereikbaar/);
    await expect(o.api().home.act(italiaans, 'controleer')).rejects.toThrow(/Geen uitslag van VIES \(MS_UNAVAILABLE\)/);
    expect(o.net.urls).toHaveLength(2);
    expect(o.uitslagen().map((u) => [u.vat_number, u.valid])).toEqual([['ESB12345678', null], ['IT12345678901', null]]);
    expect(o.taken().map((x) => x.key).sort()).toEqual(taken.map((x) => x.key).sort());
  });

  it('VIESN-08 gezien: de knop gezien laat de taak verdwijnen voor dit nummer en deze toestand (skipTask); verandert de toestand (ongeldig na onbekend) of het btw-nummer van de klant, dan komt er een nieuwe taak met een nieuwe key.', async () => {
    const o = omgeving();
    const k = o.klant('Franse Klant', 'FR12345678901');
    o.factuur(k.uuid);
    const [onbekend] = o.taken();
    await o.api().home.act(onbekend!, 'gezien');
    expect(o.taken()).toEqual([]);
    expect(n(o.db, `SELECT COUNT(*) AS n FROM task_skips WHERE task_key = ?`, onbekend!.key)).toBe(1);
    expect(o.net.urls).toHaveLength(0);
    // de toestand wordt ongeldig: een nieuwe key, dus de melding komt terug
    await o.s.vies.check('FR12345678901', k.id);
    const [ongeldig] = o.taken();
    expect(ongeldig!.key).toBe(`vies-klant:${k.id}-ongeldig-FR12345678901`);
    expect(ongeldig!.key).not.toBe(onbekend!.key);
    await o.api().home.act(ongeldig!, 'gezien');
    expect(o.taken()).toEqual([]);
    // het btw-nummer van de klant verandert: weer een nieuwe key
    o.s.relations.update(k.id, { vat_number: 'FR98765432109' });
    expect(o.taken().map((x) => x.key)).toEqual([`vies-klant:${k.id}-onbekend-FR98765432109`]);
  });

  it('VIESN-09 btw-nummer gewijzigd: een controle van een eerder btw-nummer van de klant telt niet voor het nieuwe nummer; een klant zonder btw-nummer geeft geen taak.', async () => {
    const o = omgeving();
    const k = o.klant('Duitse Klant', 'DE123456789');
    const zonder = o.klant('Klant Zonder Nummer');
    o.factuur(k.uuid);
    o.factuur(zonder.uuid);
    expect(o.taken().map((x) => x.ref.relationId)).toEqual([k.id]);
    await o.s.vies.check('DE123456789', k.id);
    expect(o.taken()).toEqual([]);
    o.s.relations.update(k.id, { vat_number: 'DE987654321' });
    const nieuw = o.taken();
    expect(nieuw.map((x) => x.key)).toEqual([`vies-klant:${k.id}-onbekend-DE987654321`]);
    expect(o.net.urls).toHaveLength(1);
    // de knop controleert het huidige nummer van de klant, niet het oude
    await o.api().home.act(nieuw[0]!, 'controleer');
    expect(o.net.urls[1]).toBe(`${VIES_API}/DE/vat/987654321`);
    expect(o.taken()).toEqual([]);
  });

  it('VIESN-10 boekhouderskopie en gedragsneutraal: in de kopie bij de boekhouder (officeCopy) komt de taak niet; zonder telefoonfacturen zijn alle bestaande taken en hun volgorde ongewijzigd; de taak heeft kind vies-nacontrole, prioriteit 2 en geen automatische actie.', () => {
    const o = omgeving();
    const k = o.klant('Duitse Klant', 'DE123456789');
    const zonder = o.s.inbox.tasks();
    expect(zonder.some((x) => x.kind === 'vies-nacontrole')).toBe(false);
    o.factuur(k.uuid);
    const met = o.s.inbox.tasks();
    // de btw-taken (vat-due, vat-check) hangen van de datum van vandaag af en telt niet mee
    const zonderBtw = (l: Task[]) => l.filter((x) => x.kind !== 'vat-due' && x.kind !== 'vat-check' && x.kind !== 'vies-nacontrole').map((x) => x.key);
    expect(zonderBtw(met)).toEqual(zonderBtw(zonder));
    const taak: Task = met.find((x) => x.kind === 'vies-nacontrole')!;
    expect(taak).toMatchObject({ kind: 'vies-nacontrole', priority: 2 });
    expect(taak.actions.some((a) => /auto/i.test(a.id))).toBe(false);
    expect(taak.actions.map((a) => a.id)).toEqual(['controleer', 'open', 'gezien']);
    expect(n(o.db, 'SELECT COUNT(*) AS n FROM vies_checks')).toBe(0);
    o.s.settings.markOfficeCopy({ office: 'Kantoor', exchange: 1, endDate: iso(Date.now() - 30 * DAG) });
    expect(o.s.settings.officeCopy()).not.toBeNull();
    expect(o.s.inbox.tasks()).toEqual([]);
    expect(o.net.urls).toEqual([]);
  });
});

function n(db: ReturnType<typeof omgeving>['db'], sql: string, ...p: unknown[]): number {
  return (db.prepare(sql).get(...p) as { n: number }).n;
}
