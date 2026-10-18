import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chromiumDir,
  DataDirError,
  forgetMoved,
  inspectMoved,
  MARKER,
  markComplete,
  MCP_MOVED_PENDING,
  MOVED_NOTE,
  movedQuestion,
  noteMoved,
  pointerFile,
  readMovedNote,
  resolveDataDir,
  resolveForMcp,
  resumeMoved,
  sharedDataDir,
  SWITCH_STEPS,
  switchDataDir,
  writePointer,
  type DataDirResolution,
} from '../src/main/data-dir';
import { administrationOnDisk } from './helpers';

// Elke test bouwt complete gegevensmappen (databases met alle migraties); op een trage Windows-runner
// duurt dat soms langer dan de gewone 30 seconden.
vi.setConfig({ testTimeout: 120_000 });

const NOW = () => new Date(2026, 9, 1, 12, 34, 56);
const LATER = () => new Date(2026, 10, 15, 9, 0, 0);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Een nagebootste computer: thuismap, AppData en een andere schijf voor een eigen map. */
function machine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gb-verhuisd-')));
  roots.push(root);
  const home = join(root, 'home');
  const appData = join(root, 'appdata');
  mkdirSync(home, { recursive: true });
  mkdirSync(appData, { recursive: true });
  const folder = (name: string): string => {
    mkdirSync(join(root, name), { recursive: true });
    return join(root, name);
  };
  return { root, home, appData, env: { home, appData }, shared: sharedDataDir(home), note: join(sharedDataDir(home), MOVED_NOTE), oldNew: join(appData, 'boekhoudenvoorniks'), folder };
}
type Machine = ReturnType<typeof machine>;

/** De standaardmap in gebruik: een complete administratie, met de sleutel van Chromium erin. */
async function standardFolder(m: Machine): Promise<void> {
  await administrationOnDisk(m.shared, 'standaard');
  writeFileSync(join(m.shared, 'Local State'), 'sleutel');
  markComplete(m.shared);
}

/** Alles in een map, als pad → hash (zonder de WAL-bestanden van SQLite). Niets uitgezonderd. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const item of readdirSync(d, { withFileTypes: true })) {
      const file = join(d, item.name);
      if (item.isDirectory()) walk(file);
      else if (!/-(wal|shm)$/.test(item.name)) out[relative(dir, file).split(sep).join('/')] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function description(dir: string): unknown {
  const db = new Database(join(dir, 'boekhouding.sqlite'), { readonly: true });
  try {
    return db.prepare('SELECT description FROM purchase_invoices').pluck().get();
  } finally {
    db.close();
  }
}

function setDescription(dir: string, text: string): void {
  const db = new Database(join(dir, 'boekhouding.sqlite'));
  db.prepare('UPDATE purchase_invoices SET description = ?').run(text);
  db.close();
}

/** Gewisseld naar een eigen map en daar verder gewerkt; in de standaardmap staat nog de stand van toen. */
async function switchedAway(m: Machine, name = 'eigen'): Promise<string> {
  await standardFolder(m);
  const own = m.folder(name);
  expect((await switchDataDir({ home: m.home, source: m.shared, target: own, action: 'kopieren', now: NOW })).status).toBe('gewisseld');
  setDescription(own, 'verder gewerkt in de eigen map');
  return own;
}

/** De verwijzing is weg (gewist, of een nieuwe thuismap zonder dat bestand). */
function losePointer(m: Machine): void {
  rmSync(pointerFile(m.home));
}

function moved(m: Machine): Extract<DataDirResolution, { kind: 'verhuisd' }> {
  const resolution = resolveDataDir(m.env);
  if (resolution.kind !== 'verhuisd') throw new Error(`verwacht: verhuisd, gekregen: ${resolution.kind}`);
  return resolution;
}

const day = (time: number | string): string => new Date(time).toLocaleString('nl-NL', { dateStyle: 'long' });
const dayTime = (time: number | string): string => new Date(time).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' });
const lastModified = (dir: string): number => statSync(join(dir, 'boekhouding.sqlite')).mtimeMs;

describe('het spoor in de standaardmap', () => {
  it('na het wisselen staat in de standaardmap waarheen en wanneer; verder verandert daar niets', async () => {
    const m = machine();
    await standardFolder(m);
    const before = snapshot(m.shared);
    const own = m.folder('eigen');
    expect((await switchDataDir({ home: m.home, source: m.shared, target: own, action: 'kopieren', now: NOW })).status).toBe('gewisseld');

    expect(readMovedNote(m.home)).toEqual({ to: own, since: NOW().toISOString() });
    expect(JSON.parse(readFileSync(m.note, 'utf8'))).toEqual({ version: 1, naar: own, sinds: NOW().toISOString() });
    // één eigen bestand erbij, naast de marker; aan de gegevens zelf is niets veranderd
    const after = snapshot(m.shared);
    expect(Object.keys(after).filter((file) => !(file in before))).toEqual([MOVED_NOTE]);
    delete after[MOVED_NOTE];
    expect(after).toEqual(before);
    expect(existsSync(join(m.shared, MARKER))).toBe(true);
    // het spoor hoort bij de standaardmap en gaat niet mee
    expect(existsSync(join(own, MOVED_NOTE))).toBe(false);
  });

  it.each(SWITCH_STEPS.filter((s) => s !== 'pointer'))('wisselen afgebroken na stap "%s": geen spoor, de standaardmap blijft gewoon de gegevensmap', async (failAt) => {
    const m = machine();
    await standardFolder(m);
    const before = snapshot(m.shared);
    await switchDataDir({
      home: m.home,
      source: m.shared,
      target: m.folder('eigen'),
      action: 'kopieren',
      now: NOW,
      afterStep: (step) => {
        if (step === failAt) throw new Error(`crash na ${step}`);
      },
    }).catch(() => undefined); // na de marker komt de fout naar buiten
    expect(existsSync(m.note)).toBe(false);
    expect(snapshot(m.shared)).toEqual(before);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'gedeeld', dir: m.shared });
    expect(resolveForMcp(m.env)).toBe(m.shared);
  });

  it('van de ene eigen map naar de andere: het spoor wijst naar de laatste', async () => {
    const m = machine();
    const first = await switchedAway(m, 'eerste');
    const second = m.folder('tweede');
    expect((await switchDataDir({ home: m.home, source: first, target: second, action: 'kopieren', now: LATER })).status).toBe('gewisseld');
    expect(readMovedNote(m.home)).toEqual({ to: second, since: LATER().toISOString() });
    expect(existsSync(join(second, MOVED_NOTE))).toBe(false);
  });

  it('een map met een complete administratie openen legt het ook vast', async () => {
    const m = machine();
    await standardFolder(m);
    const other = m.folder('ander');
    await administrationOnDisk(other, 'ander');
    markComplete(other);
    expect((await switchDataDir({ home: m.home, source: m.shared, target: other, action: 'openen', now: LATER })).status).toBe('gewisseld');
    expect(readMovedNote(m.home)).toEqual({ to: other, since: LATER().toISOString() });
  });

  it('vanuit de oude map in AppData naar een eigen map: ook dan weet de standaardmap waarheen', async () => {
    const m = machine();
    await administrationOnDisk(m.oldNew, 'oud');
    const own = m.folder('eigen');
    expect((await switchDataDir({ home: m.home, source: m.oldNew, target: own, action: 'kopieren', now: NOW })).status).toBe('gewisseld');
    expect(readMovedNote(m.home)).toEqual({ to: own, since: NOW().toISOString() });
    // zonder verwijzing wordt de oude map in AppData dan niet stil opnieuw in gebruik genomen
    losePointer(m);
    expect(moved(m).fallback).toEqual({ kind: 'oud', dir: m.oldNew, target: m.shared });
    expect(() => resolveForMcp(m.env)).toThrow(MCP_MOVED_PENDING);
  });

  it('terug naar de standaardmap (gegevens mee): het spoor is weg en de standaardmap opent weer gewoon', async () => {
    const m = machine();
    const own = await switchedAway(m);
    expect((await switchDataDir({ home: m.home, source: own, target: m.shared, action: 'kopieren', now: LATER })).status).toBe('gewisseld');
    expect(existsSync(m.note)).toBe(false);
    expect(existsSync(pointerFile(m.home))).toBe(false);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'gedeeld', dir: m.shared });
    expect(resolveForMcp(m.env)).toBe(m.shared);
    expect(description(m.shared)).toBe('verder gewerkt in de eigen map');
  });

  it('de standaardmap aanwijzen in het keuzevenster (openen wat daar staat): het spoor is ook dan weg', async () => {
    const m = machine();
    const own = await switchedAway(m);
    expect((await switchDataDir({ home: m.home, source: own, target: m.shared, action: 'openen', now: LATER })).status).toBe('gewisseld');
    expect(existsSync(m.note)).toBe(false);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'gedeeld', dir: m.shared });
  });

  it('terug naar de standaardmap mislukt: verwijzing en spoor staan er nog, je werkt verder vanuit de eigen map', async () => {
    const m = machine();
    const own = await switchedAway(m);
    const note = readFileSync(m.note, 'utf8');
    const outcome = await switchDataDir({ home: m.home, source: own, target: m.shared, action: 'kopieren', now: LATER, afterStep: (step) => { if (step === 'plaatsen') throw new Error('crash'); } });
    expect(outcome.status).toBe('mislukt');
    expect(readFileSync(m.note, 'utf8')).toBe(note);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'pointer', dir: own });
    // raakt nu ook nog de verwijzing weg, dan opent de app de half teruggezette standaardmap niet stil
    losePointer(m);
    expect(moved(m).moved.to).toBe(own);
  });

  it('het spoor van een eerdere keer gaat niet mee naar een nieuwe map', async () => {
    const m = machine();
    await standardFolder(m);
    writeFileSync(m.note, JSON.stringify({ version: 1, naar: join(m.root, 'vroeger'), sinds: NOW().toISOString() }));
    const own = m.folder('eigen');
    expect((await switchDataDir({ home: m.home, source: m.shared, target: own, action: 'kopieren', now: LATER })).status).toBe('gewisseld');
    expect(existsSync(join(own, MOVED_NOTE))).toBe(false);
    expect(readMovedNote(m.home)).toEqual({ to: own, since: LATER().toISOString() });
  });
});

describe('wie al gewisseld was vóór de app dit bijhield', () => {
  /** Zoals de vorige versie het achterliet: een geldige verwijzing, geen spoor in de standaardmap. */
  async function switchedBefore(m: Machine): Promise<string> {
    const own = await switchedAway(m);
    rmSync(m.note);
    return own;
  }

  it('bij de eerstvolgende start, met de verwijzing nog geldig, komt het spoor er alsnog; met de datum van het wisselen', async () => {
    const m = machine();
    const own = await switchedBefore(m);
    const sharedBefore = snapshot(m.shared);
    const ownBefore = snapshot(own);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'pointer', dir: own });

    noteMoved(m.home, own, LATER);
    // de datum komt uit de marker van de eigen map: die is bij het wisselen vanuit de standaardmap geschreven
    expect(readMovedNote(m.home)).toEqual({ to: own, since: NOW().toISOString() });
    const after = snapshot(m.shared);
    delete after[MOVED_NOTE];
    expect(after).toEqual(sharedBefore);
    expect(snapshot(own)).toEqual(ownBefore);

    // en daarmee is ook deze gebruiker beschermd als de verwijzing later wegraakt
    losePointer(m);
    expect(moved(m).moved).toEqual({ to: own, since: NOW().toISOString() });
  });

  it('elke start opnieuw: staat het er al, dan verandert er niets', async () => {
    const m = machine();
    const own = await switchedAway(m);
    const note = readFileSync(m.note, 'utf8');
    const written = statSync(m.note).mtimeMs;
    noteMoved(m.home, own, LATER);
    expect(readFileSync(m.note, 'utf8')).toBe(note);
    expect(statSync(m.note).mtimeMs).toBe(written);
    expect(readdirSync(m.shared).filter((name) => name.startsWith(MOVED_NOTE))).toEqual([MOVED_NOTE]);
  });

  it('een eigen map die niet vanuit de standaardmap gevuld is: de datum van vandaag', async () => {
    const m = machine();
    await standardFolder(m);
    const other = m.folder('ander');
    await administrationOnDisk(other, 'ander');
    markComplete(other);
    writePointer(m.home, other);
    noteMoved(m.home, other, LATER);
    expect(readMovedNote(m.home)).toEqual({ to: other, since: LATER().toISOString() });
  });

  it('de verwijzing is met de hand naar een andere map gezet: het spoor volgt', async () => {
    const m = machine();
    const own = await switchedAway(m);
    const other = m.folder('ander');
    await administrationOnDisk(other, 'ander');
    markComplete(other);
    writePointer(m.home, other);
    noteMoved(m.home, other, LATER);
    expect(readMovedNote(m.home)).toEqual({ to: other, since: LATER().toISOString() });
    expect(existsSync(join(own, MOVED_NOTE))).toBe(false);
  });

  it('de standaardmap zelf is nooit "verhuisd"', async () => {
    const m = machine();
    await standardFolder(m);
    noteMoved(m.home, m.shared, NOW);
    expect(existsSync(m.note)).toBe(false);
  });

  it('de koppeling schrijft nooit iets: zonder spoor blijft het zonder spoor', async () => {
    const m = machine();
    const own = await switchedBefore(m);
    const before = snapshot(m.shared);
    expect(resolveForMcp(m.env)).toBe(own);
    expect(snapshot(m.shared)).toEqual(before);
  });

  it('is de verwijzing al weg vóór die eerste start, dan is er niets om op af te gaan: de standaardmap opent zoals voorheen', async () => {
    const m = machine();
    await switchedBefore(m);
    losePointer(m);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'gedeeld', dir: m.shared });
  });
});

describe('de verwijzing is weg na het wisselen', () => {
  it('er wordt niets stil geopend en er verandert niets: de app vraagt, de koppeling weigert', async () => {
    const m = machine();
    const own = await switchedAway(m);
    losePointer(m);
    const sharedBefore = snapshot(m.shared);
    const ownBefore = snapshot(own);

    const resolution = resolveDataDir(m.env);
    expect(resolution).toEqual({ kind: 'verhuisd', moved: { to: own, since: NOW().toISOString() }, fallback: { kind: 'gedeeld', dir: m.shared } });
    // de koppeling kiest nooit zelf
    expect(() => resolveForMcp(m.env)).toThrow(DataDirError);
    expect(() => resolveForMcp(m.env)).toThrow(MCP_MOVED_PENDING);
    // Chromium (en de sleutel van de opgeslagen wachtwoorden) staat in de standaardmap: geen extra herstart nodig
    expect(chromiumDir(resolution, m.home)).toBe(m.shared);
    // de vraag stellen (en afsluiten zonder te kiezen) raakt geen van beide mappen aan
    movedQuestion(moved(m), inspectMoved(moved(m).moved), m.home);
    expect(snapshot(m.shared)).toEqual(sharedBefore);
    expect(snapshot(own)).toEqual(ownBefore);
    expect(existsSync(pointerFile(m.home))).toBe(false);
    // en bij de volgende start komt dezelfde vraag
    expect(resolveDataDir(m.env)).toEqual(resolution);
  });

  it('de vraag: wat er gebeurd is, wat er in beide mappen staat, en drie keuzes', async () => {
    const m = machine();
    const own = await switchedAway(m);
    losePointer(m);
    const state = inspectMoved(moved(m).moved);
    expect(state).toMatchObject({ state: 'compleet', dir: own });
    expect(movedQuestion(moved(m), state, m.home)).toEqual({
      message: 'Waar staat je administratie?',
      detail:
        `Op ${day(NOW().getTime())} heb je je administratie verplaatst naar:\n${own}\n\n` +
        `De app is kwijt dat je gegevens daar staan (het bestand ${pointerFile(m.home)} is weg). ` +
        `In die map staat nog steeds een complete administratie (laatst gewijzigd ${dayTime(lastModified(own))}, 1 administratie).\n\n` +
        `In de standaardmap ${m.shared} staat een oudere kopie, van vóór het verplaatsen (laatst gewijzigd ${dayTime(lastModified(m.shared))}). Wat je na het verplaatsen hebt ingevoerd, staat daar niet in.\n\n` +
        'De app opent niets tot je gekozen hebt, en er wordt niets gewist.',
      buttons: [
        { label: 'De verplaatste map gebruiken', answer: 'verplaatst' },
        { label: 'De oudere kopie gebruiken', answer: 'ouder' },
        { label: 'Afsluiten', answer: 'stoppen' },
      ],
    });
    expect(day(NOW().getTime())).toBe('1 oktober 2026');
  });

  it('antwoord "de verplaatste map gebruiken": de verwijzing is terug, app en koppeling openen de verplaatste map', async () => {
    const m = machine();
    const own = await switchedAway(m);
    losePointer(m);
    const sharedBefore = snapshot(m.shared);
    const ownBefore = snapshot(own);

    expect(resumeMoved(m.home, moved(m).moved)).toBe(own);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'pointer', dir: own });
    expect(resolveForMcp(m.env)).toBe(own);
    expect(description(own)).toBe('verder gewerkt in de eigen map');
    // alleen de verwijzing is teruggezet; in geen van beide mappen is iets veranderd (het spoor blijft)
    expect(snapshot(m.shared)).toEqual(sharedBefore);
    expect(snapshot(own)).toEqual(ownBefore);
    expect(readMovedNote(m.home)).toEqual({ to: own, since: NOW().toISOString() });
  });

  it('antwoord "de oudere kopie gebruiken": de standaardmap opent, zonder wat er na het verplaatsen is ingevoerd; de verplaatste map blijft staan', async () => {
    const m = machine();
    const own = await switchedAway(m);
    losePointer(m);
    const sharedBefore = snapshot(m.shared);
    const ownBefore = snapshot(own);

    forgetMoved(m.home);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'gedeeld', dir: m.shared });
    expect(resolveForMcp(m.env)).toBe(m.shared);
    expect(description(m.shared)).toBe('bon standaard');
    // alleen het spoor is weg; de gegevens in beide mappen zijn onaangeroerd
    delete sharedBefore[MOVED_NOTE];
    expect(snapshot(m.shared)).toEqual(sharedBefore);
    expect(snapshot(own)).toEqual(ownBefore);
    expect(existsSync(pointerFile(m.home))).toBe(false);
    // de verplaatste map is later nog gewoon te kiezen in Instellingen
    expect((await switchDataDir({ home: m.home, source: m.shared, target: own, action: 'openen', now: LATER })).status).toBe('gewisseld');
    expect(description(resolveForMcp(m.env))).toBe('verder gewerkt in de eigen map');
  });

  it('de verplaatste map is niet bereikbaar (usb-schijf los, netwerkschijf uit): dat staat er, met Opnieuw proberen', async () => {
    const m = machine();
    const own = await switchedAway(m);
    losePointer(m);
    renameSync(own, join(m.root, 'losgekoppeld'));
    const sharedBefore = snapshot(m.shared);

    const state = inspectMoved(moved(m).moved);
    expect(state).toEqual({ state: 'onbereikbaar' });
    const question = movedQuestion(moved(m), state, m.home);
    expect(question.detail).toBe(
      `Op ${day(NOW().getTime())} heb je je administratie verplaatst naar:\n${own}\n\n` +
        `De app is kwijt dat je gegevens daar staan (het bestand ${pointerFile(m.home)} is weg). ` +
        'De app kan die map nu niet bereiken. Staat hij op een usb-schijf of een netwerkschijf? Sluit die aan en kies dan Opnieuw proberen.\n\n' +
        `In de standaardmap ${m.shared} staat een oudere kopie, van vóór het verplaatsen (laatst gewijzigd ${dayTime(lastModified(m.shared))}). Wat je na het verplaatsen hebt ingevoerd, staat daar niet in.\n\n` +
        'De app opent niets tot je gekozen hebt, en er wordt niets gewist.',
    );
    expect(question.buttons).toEqual([
      { label: 'Opnieuw proberen', answer: 'opnieuw' },
      { label: 'De oudere kopie gebruiken', answer: 'ouder' },
      { label: 'Afsluiten', answer: 'stoppen' },
    ]);
    // de verplaatste map is nu niet te kiezen, ook niet langs een omweg
    expect(() => resumeMoved(m.home, moved(m).moved)).toThrow(DataDirError);
    expect(existsSync(pointerFile(m.home))).toBe(false);
    expect(() => resolveForMcp(m.env)).toThrow(MCP_MOVED_PENDING);
    expect(snapshot(m.shared)).toEqual(sharedBefore);

    // de schijf is weer aangesloten: opnieuw proberen vindt de administratie
    renameSync(join(m.root, 'losgekoppeld'), own);
    const again = inspectMoved(moved(m).moved);
    expect(again).toMatchObject({ state: 'compleet', dir: own });
    expect(movedQuestion(moved(m), again, m.home).buttons[0]).toEqual({ label: 'De verplaatste map gebruiken', answer: 'verplaatst' });
    expect(resumeMoved(m.home, moved(m).moved)).toBe(own);
    expect(resolveForMcp(m.env)).toBe(own);
  });

  it.each([
    ['de marker ontbreekt', (own: string) => rmSync(join(own, MARKER))],
    ['de administratie ontbreekt', (own: string) => rmSync(join(own, 'boekhouding.sqlite'))],
    ['de map is leeg', (own: string) => (rmSync(own, { recursive: true }), mkdirSync(own))],
  ])('in de verplaatste map staat geen complete administratie meer (%s): niet te kiezen', async (_label, damage) => {
    const m = machine();
    const own = await switchedAway(m);
    losePointer(m);
    damage(own);
    const ownBefore = snapshot(own);
    const state = inspectMoved(moved(m).moved);
    expect(state).toEqual({ state: 'onvolledig' });
    const question = movedQuestion(moved(m), state, m.home);
    expect(question.detail).toContain('In die map staat nu geen complete administratie. Heb je hem verplaatst of hernoemd? Zet hem terug en kies dan Opnieuw proberen.');
    expect(question.buttons.map((b) => b.answer)).toEqual(['opnieuw', 'ouder', 'stoppen']);
    expect(() => resumeMoved(m.home, moved(m).moved)).toThrow(DataDirError);
    expect(existsSync(pointerFile(m.home))).toBe(false);
    expect(snapshot(own)).toEqual(ownBefore);
  });

  it('er is geen complete standaardmap om op terug te vallen: de app begint niet stil leeg', async () => {
    const m = machine();
    await administrationOnDisk(m.oldNew, 'oud');
    const own = m.folder('eigen');
    expect((await switchDataDir({ home: m.home, source: m.oldNew, target: own, action: 'kopieren', now: NOW })).status).toBe('gewisseld');
    losePointer(m);
    rmSync(m.oldNew, { recursive: true });
    expect(moved(m).fallback).toEqual({ kind: 'nieuw', dir: m.shared });
    expect(() => resolveForMcp(m.env)).toThrow(MCP_MOVED_PENDING);
    const question = movedQuestion(moved(m), inspectMoved(moved(m).moved), m.home);
    expect(question.detail).toContain('Er staat op deze computer geen andere administratie. Ga je zonder de verplaatste map verder, dan begint de app met een lege administratie; daarin kun je een back-up terugzetten.');
    expect(question.buttons).toEqual([
      { label: 'De verplaatste map gebruiken', answer: 'verplaatst' },
      { label: 'Leeg beginnen', answer: 'ouder' },
      { label: 'Afsluiten', answer: 'stoppen' },
    ]);
    expect(existsSync(join(m.shared, MARKER))).toBe(false);
  });

  it('oudere gegevens staan nog in AppData: de vraag noemt die map', async () => {
    const m = machine();
    await administrationOnDisk(m.oldNew, 'oud');
    const own = m.folder('eigen');
    expect((await switchDataDir({ home: m.home, source: m.oldNew, target: own, action: 'kopieren', now: NOW })).status).toBe('gewisseld');
    losePointer(m);
    const before = snapshot(m.oldNew);
    const question = movedQuestion(moved(m), inspectMoved(moved(m).moved), m.home);
    expect(question.detail).toContain(`Op deze computer staan nog oudere gegevens, van vóór het verplaatsen, in ${m.oldNew}. Wat je na het verplaatsen hebt ingevoerd, staat daar niet in.`);
    expect(question.buttons[1]).toEqual({ label: 'De oudere gegevens gebruiken', answer: 'ouder' });
    expect(snapshot(m.oldNew)).toEqual(before);
    // bewust verder zonder de verplaatste map: de gewone volgorde geldt weer (de oude map wordt overgezet)
    forgetMoved(m.home);
    expect(resolveDataDir(m.env)).toEqual({ kind: 'oud', dir: m.oldNew, target: m.shared });
  });

  it('een verwijzing die er wel is maar niet klopt, blijft een fout (zoals voorheen), geen vraag', async () => {
    const m = machine();
    const own = await switchedAway(m);
    renameSync(own, join(m.root, 'losgekoppeld'));
    expect(() => resolveDataDir(m.env)).toThrow(/niet bereikbaar/);
    expect(() => resolveForMcp(m.env)).toThrow(/niet bereikbaar/);
  });

  it('een onleesbaar spoor telt niet als spoor', async () => {
    const m = machine();
    await switchedAway(m);
    losePointer(m);
    for (const content of ['geen json', JSON.stringify({ version: 2, naar: '/x', sinds: 'x' }), JSON.stringify({ version: 1, naar: 'relatief', sinds: 'x' }), JSON.stringify({ version: 1, sinds: 'x' })]) {
      writeFileSync(m.note, content);
      expect(readMovedNote(m.home)).toBeNull();
      expect(resolveDataDir(m.env)).toEqual({ kind: 'gedeeld', dir: m.shared });
    }
  });
});
