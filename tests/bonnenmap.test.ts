import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setup } from './helpers';
import { makeJpeg, makeJpegWithGps } from './fixtures/jpeg';
import { PHONE_SCANNER } from '../src/shared/phone-scanner';
import { makePdf } from './pdf';
import { Bonnenscanner } from '../src/scanner/scanner';
import { folderAccess } from '../src/main/statement-files';

const open: Bonnenscanner[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (prefix: string) => {
  // het echte pad (op macOS en Windows wijst de tijdelijke map via een omweg)
  // .native: op Windows geeft alleen die de lange naam terug (C:\Users\RUNNER~1 → runneradmin), net als de app
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

/** Een administratie met een bonnenmap; de klok is van de test, zodat "een paar seconden" niet echt hoeft te duren. */
function start(opts: { realClock?: boolean; homeDir?: string; broadDirs?: string[] } = {}) {
  const t = setup({ statementFiles: folderAccess });
  const folder = tmp('bvn-bonnen-');
  const data = tmp('bvn-gegevens-');
  const clock = { now: Date.now() };
  const scanner = new Bonnenscanner({
    db: t.db,
    secrets: t.secrets,
    intake: t.s.intake,
    settings: t.s.settings,
    spoolDir: join(data, 'bonnenscanner'),
    protectedDirs: [data],
    interfaces: () => [],
    homeDir: opts.homeDir,
    broadDirs: opts.broadDirs,
    now: opts.realClock ? undefined : () => clock.now,
  });
  open.push(scanner);
  const documents = () => t.db.prepare('SELECT original_name, mime_type, status, purchase_invoice_id FROM documents ORDER BY id').all() as { original_name: string; mime_type: string; status: string; purchase_invoice_id: number | null }[];
  /** kijken, de klok vooruit, en nog eens kijken: zoals de rondgang elke paar seconden doet */
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await scanner.scanFolder();
      clock.now += 2_000;
    }
  };
  const files = (dir = folder) => readdirSync(dir).sort();
  return { ...t, scanner, folder, data, clock, documents, settle, files };
}

const ubl = () => readFileSync(join(__dirname, 'fixtures', 'ubl-invoice.xml'));

describe('bonnenmap (#48)', () => {
  it('zonder gekozen map gebeurt er niets', async () => {
    const t = start();
    await t.scanner.start();
    expect(t.scanner.status().folder).toMatchObject({ folder: null, reachable: false, processed: 0 });
    expect(t.scanner.status().running).toBe(false);
  });

  it('nieuwe bestanden (jpg, png, pdf, xml) gaan de inbox in en worden verplaatst naar verwerkt/', async () => {
    const t = start();
    await t.scanner.setFolder(t.folder);
    writeFileSync(join(t.folder, 'tankbon.jpg'), makeJpeg('tank'));
    writeFileSync(join(t.folder, 'Scan 12.JPEG'), makeJpeg('scan'));
    writeFileSync(join(t.folder, 'schermafdruk.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]));
    writeFileSync(join(t.folder, 'factuur.pdf'), makePdf(['Bouwmaat Utrecht', 'Factuur 2026-17', 'Totaal 121,00']));
    writeFileSync(join(t.folder, 'e-factuur.xml'), ubl());
    await t.settle();
    expect(t.documents().map((d) => d.original_name).sort()).toEqual(['Scan 12.jpeg', 'e-factuur.xml', 'factuur.pdf', 'schermafdruk.png', 'tankbon.jpg']);
    expect(t.files()).toEqual(['verwerkt']);
    expect(t.files(join(t.folder, 'verwerkt'))).toEqual(['Scan 12.JPEG', 'e-factuur.xml', 'factuur.pdf', 'schermafdruk.png', 'tankbon.jpg']);
    // de bestanden zelf zijn ongewijzigd verplaatst
    expect(readFileSync(join(t.folder, 'verwerkt', 'tankbon.jpg')).equals(makeJpeg('tank'))).toBe(true);
    // niets is vanzelf geboekt, ook de e-factuur niet: alles wacht op controle
    expect(t.s.purchases.list()).toHaveLength(0);
    expect(t.documents().every((d) => d.status === 'controle' && d.purchase_invoice_id === null)).toBe(true);
    expect(t.scanner.status().folder).toMatchObject({ folder: t.folder, reachable: true, processed: 5, problems: [] });
  });

  it('een bestand dat nog geschreven wordt, wordt pas opgepakt als de grootte een paar seconden gelijk blijft', async () => {
    const t = start();
    await t.scanner.setFolder(t.folder);
    const file = join(t.folder, 'grote-scan.jpg');
    const jpeg = makeJpeg('groot');
    writeFileSync(file, jpeg.subarray(0, 100));
    // elke twee seconden komt er een stuk bij: blijft liggen
    for (let i = 1; i <= 5; i++) {
      await t.scanner.scanFolder();
      expect(t.documents()).toHaveLength(0);
      t.clock.now += 2_000;
      appendFileSync(file, jpeg.subarray(i * 100, (i + 1) * 100));
    }
    appendFileSync(file, jpeg.subarray(600));
    // klaar met schrijven: eerst gezien, twee seconden later nog te kort, na drie seconden wel
    await t.scanner.scanFolder();
    t.clock.now += 2_000;
    await t.scanner.scanFolder();
    expect(t.documents()).toHaveLength(0);
    t.clock.now += 1_500;
    await t.scanner.scanFolder();
    expect(t.documents()).toHaveLength(1);
    expect(readFileSync(join(t.folder, 'verwerkt', 'grote-scan.jpg')).equals(jpeg)).toBe(true);
  });

  it('een leeg bestand (door het synchronisatieprogramma alvast aangemaakt) blijft liggen tot er iets in staat', async () => {
    const t = start();
    await t.scanner.setFolder(t.folder);
    writeFileSync(join(t.folder, 'bon.jpg'), '');
    await t.settle();
    await t.settle();
    expect(t.documents()).toHaveLength(0);
    expect(t.files()).toEqual(['bon.jpg']);
    writeFileSync(join(t.folder, 'bon.jpg'), makeJpeg());
    await t.settle();
    expect(t.documents()).toHaveLength(1);
  });

  it('dubbele bestanden worden herkend via de hash: één document, beide bestanden naar verwerkt/', async () => {
    const t = start();
    await t.scanner.setFolder(t.folder);
    writeFileSync(join(t.folder, 'bon.jpg'), makeJpeg('zelfde'));
    await t.settle();
    // dezelfde foto onder een andere naam, en later nog eens onder dezelfde naam
    writeFileSync(join(t.folder, 'bon kopie.jpg'), makeJpeg('zelfde'));
    await t.settle();
    writeFileSync(join(t.folder, 'bon.jpg'), makeJpeg('zelfde'));
    await t.settle();
    expect(t.documents()).toHaveLength(1);
    expect(t.files()).toEqual(['verwerkt']);
    // niets overschreven: de tweede bon.jpg kreeg een eigen naam
    expect(t.files(join(t.folder, 'verwerkt'))).toEqual(['bon (2).jpg', 'bon kopie.jpg', 'bon.jpg']);
    expect(t.scanner.status().folder.recent.map((r) => r.duplicate)).toEqual([true, true, false]);
    // je was er niet bij toen ze binnenkwamen: op Vandaag staat dat ze er al in stonden (#179), niets is geboekt
    expect(t.s.intake.notices().map((n) => [n.kind, n.source, n.original_name])).toEqual([['stond-er-al', 'bonnenmap', 'bon kopie.jpg'], ['stond-er-al', 'bonnenmap', 'bon.jpg']]);
    const notice = t.s.inbox.home().tasks.find((x) => x.kind === 'document-notice')!;
    expect(notice.question).toContain('"bon kopie.jpg" kwam binnen via je bonnenmap, maar precies dit bestand staat al in de app');
    expect(t.s.purchases.list()).toHaveLength(0);
  });

  it('een ander bestand met dezelfde naam als een eerder verwerkt bestand overschrijft niets', async () => {
    const t = start();
    await t.scanner.setFolder(t.folder);
    writeFileSync(join(t.folder, 'IMG_0001.jpg'), makeJpeg('maandag'));
    await t.settle();
    writeFileSync(join(t.folder, 'IMG_0001.jpg'), makeJpeg('dinsdag'));
    await t.settle();
    expect(t.documents()).toHaveLength(2);
    expect(readFileSync(join(t.folder, 'verwerkt', 'IMG_0001.jpg')).equals(makeJpeg('maandag'))).toBe(true);
    expect(readFileSync(join(t.folder, 'verwerkt', 'IMG_0001 (2).jpg')).equals(makeJpeg('dinsdag'))).toBe(true);
  });

  it('andere bestanden, mappen, snelkoppelingen en tijdelijke bestanden blijven onaangeroerd', async () => {
    const t = start();
    const elsewhere = tmp('bvn-elders-');
    writeFileSync(join(elsewhere, 'geheim.pdf'), makePdf(['niet van de bonnenmap']));
    await t.scanner.setFolder(t.folder);
    writeFileSync(join(t.folder, 'notities.txt'), 'boodschappen');
    writeFileSync(join(t.folder, 'urenlijst.xlsx'), 'PK');
    writeFileSync(join(t.folder, 'foto.heic'), 'heic');
    writeFileSync(join(t.folder, '.syncthing.bon.jpg.tmp'), makeJpeg('half'));
    writeFileSync(join(t.folder, '.verborgen.jpg'), makeJpeg('verborgen'));
    writeFileSync(join(t.folder, 'download.pdf.crdownload'), 'half');
    writeFileSync(join(t.folder, '~$factuur.pdf'), 'slot');
    mkdirSync(join(t.folder, 'archief 2025'));
    writeFileSync(join(t.folder, 'archief 2025', 'oude-bon.jpg'), makeJpeg('oud'));
    mkdirSync(join(t.folder, 'map.pdf'));
    try {
      symlinkSync(join(elsewhere, 'geheim.pdf'), join(t.folder, 'snelkoppeling.pdf'));
    } catch {
      /* Windows zonder het recht om snelkoppelingen te maken: de rest van de test telt nog */
    }
    const before = t.files();
    await t.settle();
    await t.settle();
    expect(t.documents()).toHaveLength(0);
    expect(t.files()).toEqual(before);
    expect(readdirSync(join(t.folder, 'archief 2025'))).toEqual(['oude-bon.jpg']);
    expect(existsSync(join(elsewhere, 'geheim.pdf'))).toBe(true);
    expect(existsSync(join(t.folder, 'verwerkt'))).toBe(false);
  });

  it('een bestand dat niet is wat de naam zegt blijft liggen, met de reden erbij', async () => {
    const t = start();
    await t.scanner.setFolder(t.folder);
    writeFileSync(join(t.folder, 'programma.pdf'), 'MZ\x90\x00 dit is geen pdf');
    writeFileSync(join(t.folder, 'tekst.jpg'), 'gewoon tekst');
    writeFileSync(join(t.folder, 'instellingen.xml'), '<?xml version="1.0"?><config><a>1</a></config>');
    writeFileSync(join(t.folder, 'echt.jpg'), makeJpeg());
    await t.settle();
    await t.settle();
    expect(t.documents().map((d) => d.original_name)).toEqual(['echt.jpg']);
    expect(t.files()).toEqual(['instellingen.xml', 'programma.pdf', 'tekst.jpg', 'verwerkt']);
    expect(t.scanner.status().folder.problems.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'instellingen.xml', reason: 'is geen e-factuur (UBL)' },
      { name: 'programma.pdf', reason: 'is geen PDF' },
      { name: 'tekst.jpg', reason: 'is geen jpg-foto' },
    ]);
    // er is niets van in de bijlagen van de administratie terechtgekomen
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM documents').get()).toEqual({ n: 1 });
    // vervangen door een goed bestand: dan gaat hij alsnog mee
    writeFileSync(join(t.folder, 'tekst.jpg'), makeJpeg('nu wel'));
    await t.settle();
    expect(t.documents()).toHaveLength(2);
    expect(t.scanner.status().folder.problems.map((p) => p.name)).toEqual(['instellingen.xml', 'programma.pdf']);
  });

  it('er wordt nooit iets verwijderd: elk bestand staat na afloop in de map of in verwerkt/', async () => {
    const t = start();
    await t.scanner.setFolder(t.folder);
    const names = ['a.jpg', 'b.jpg', 'c.pdf', 'd.xml', 'e.txt', 'kapot.pdf'];
    writeFileSync(join(t.folder, 'a.jpg'), makeJpeg('a'));
    writeFileSync(join(t.folder, 'b.jpg'), makeJpeg('a'));
    writeFileSync(join(t.folder, 'c.pdf'), makePdf(['Totaal 10,00']));
    writeFileSync(join(t.folder, 'd.xml'), ubl());
    writeFileSync(join(t.folder, 'e.txt'), 'x');
    writeFileSync(join(t.folder, 'kapot.pdf'), 'geen pdf');
    await t.settle();
    await t.settle();
    const after = [...t.files().filter((f) => f !== 'verwerkt'), ...t.files(join(t.folder, 'verwerkt'))].sort();
    expect(after).toEqual(names);
  });

  it('kan de inbox een bestand niet aannemen, dan blijft het liggen en wordt het niet eindeloos opnieuw geprobeerd', async () => {
    const t = start();
    let calls = 0;
    t.s.intake.add = async () => {
      calls++;
      throw new Error('schijf vol');
    };
    await t.scanner.setFolder(t.folder);
    writeFileSync(join(t.folder, 'bon.jpg'), makeJpeg());
    for (let i = 0; i < 4; i++) await t.settle();
    expect(calls).toBe(1);
    expect(t.files()).toEqual(['bon.jpg']);
    expect(t.scanner.status().folder.problems).toEqual([{ name: 'bon.jpg', reason: 'kon niet in de inbox gezet worden: schijf vol' }]);
  });

  it('een bestand in de bonnenmap staat binnen 10 seconden in de inbox (echte klok)', async () => {
    const t = start({ realClock: true });
    await t.scanner.setFolder(t.folder);
    await t.scanner.start();
    const started = Date.now();
    writeFileSync(join(t.folder, 'bon.jpg'), makeJpeg('op tijd'));
    while (t.documents().length === 0 && Date.now() - started < 12_000) await new Promise((r) => setTimeout(r, 100));
    const seconds = (Date.now() - started) / 1000;
    expect(t.documents()).toHaveLength(1);
    expect(seconds).toBeLessThan(10);
    // en niet te gretig: de grootte moest eerst een paar seconden gelijk blijven
    expect(seconds).toBeGreaterThan(3);
    // het verplaatsen komt net na het document in de inbox: daar even op wachten
    const moved = join(t.folder, 'verwerkt', 'bon.jpg');
    for (let i = 0; i < 50 && !existsSync(moved); i++) await new Promise((r) => setTimeout(r, 100));
    expect(t.files(join(t.folder, 'verwerkt'))).toEqual(['bon.jpg']);
  });

  it('de map kiezen: geen map die te breed is of van de app zelf, en uitzetten kan altijd', async () => {
    const t = start();
    await expect(t.scanner.setFolder(homedir())).rejects.toThrow(/te groot/);
    await expect(t.scanner.setFolder(dirname(homedir()))).rejects.toThrow(/te groot/);
    await expect(t.scanner.setFolder('/')).rejects.toThrow(/te groot/);
    await expect(t.scanner.setFolder(t.data)).rejects.toThrow(/van BoekhoudenVoorNiks zelf/);
    mkdirSync(join(t.data, 'bijlagen'));
    await expect(t.scanner.setFolder(join(t.data, 'bijlagen'))).rejects.toThrow(/van BoekhoudenVoorNiks zelf/);
    await expect(t.scanner.setFolder(join(t.folder, 'bestaat-niet'))).rejects.toThrow(/bestaat niet/);
    await expect(t.scanner.setFolder('bonnen')).rejects.toThrow(/op deze computer/);
    writeFileSync(join(t.folder, 'bestand.txt'), 'x');
    await expect(t.scanner.setFolder(join(t.folder, 'bestand.txt'))).rejects.toThrow(/bestaat niet/);
    expect(t.scanner.folder()).toBeNull();
    expect((await t.scanner.setFolder(t.folder)).folder).toBe(t.folder);
    // de map staat niet tussen de gewone instellingen die het scherm kan aanpassen
    t.s.settings.update({ receiptFolder: '/etc' } as never);
    expect(t.scanner.folder()).toBe(t.folder);
    await t.scanner.setFolder(null);
    expect(t.scanner.folder()).toBeNull();
    writeFileSync(join(t.folder, 'bon.jpg'), makeJpeg());
    await t.settle();
    expect(t.documents()).toHaveLength(0);
  });

  it('je hele map Documenten of Downloads kan geen bonnenmap zijn, een submap ervan wel', async () => {
    const home = tmp('bvn-thuis-');
    for (const name of ['Documents', 'Downloads', 'Foto']) mkdirSync(join(home, name));
    mkdirSync(join(home, 'Documents', 'Bonnen'));
    const t = start({ homeDir: home, broadDirs: [join(home, 'Foto')] });
    for (const name of ['Documents', 'Downloads', 'Foto']) await expect(t.scanner.setFolder(join(home, name))).rejects.toThrow(/te groot/);
    await expect(t.scanner.setFolder(home)).rejects.toThrow(/te groot/);
    expect((await t.scanner.setFolder(join(home, 'Documents', 'Bonnen'))).folder).toBe(join(home, 'Documents', 'Bonnen'));
  });

  it('de gekozen map wordt bij elke rondgang opnieuw gecontroleerd: wordt hij een snelkoppeling naar elders, dan stopt de app', async () => {
    const t = start();
    const elsewhere = tmp('bvn-elders-');
    writeFileSync(join(elsewhere, 'privefoto.jpg'), makeJpeg('niet van de bonnenmap'));
    const chosen = join(t.folder, 'bonnen');
    mkdirSync(chosen);
    await t.scanner.setFolder(chosen);
    rmSync(chosen, { recursive: true });
    try {
      symlinkSync(elsewhere, chosen, 'dir');
    } catch {
      return; // Windows zonder het recht om snelkoppelingen te maken
    }
    await t.settle();
    await t.settle();
    expect(t.documents()).toHaveLength(0);
    expect(readdirSync(elsewhere)).toEqual(['privefoto.jpg']);
    expect(t.scanner.status().folder).toMatchObject({ folder: chosen, reachable: false });
    // ook een map uit de instellingen die nooit gekozen had mogen worden (bv. uit een back-up van een andere pc)
    t.db.prepare(`UPDATE settings SET value = ? WHERE key = 'receiptFolder'`).run(JSON.stringify(t.data));
    writeFileSync(join(t.data, 'iets.jpg'), makeJpeg('in de map van de app'));
    await t.settle();
    expect(t.documents()).toHaveLength(0);
    expect(existsSync(join(t.data, 'iets.jpg'))).toBe(true);
  });

  it('lukt verplaatsen naar verwerkt/ nog niet, dan probeert de app het opnieuw zonder de bon dubbel in te lezen', async () => {
    const t = start();
    await t.scanner.setFolder(t.folder);
    // op de plek van de map `verwerkt` staat een bestand: verplaatsen kan niet
    writeFileSync(join(t.folder, 'verwerkt'), 'in de weg');
    writeFileSync(join(t.folder, 'bon.jpg'), makeJpeg('wacht op verplaatsen'));
    await t.settle();
    await t.settle();
    expect(t.documents()).toHaveLength(1);
    expect(t.files()).toEqual(['bon.jpg', 'verwerkt']);
    expect(t.scanner.status().folder).toMatchObject({ processed: 1, problems: [{ name: 'bon.jpg', reason: 'staat in de inbox, maar kon nog niet naar de map verwerkt verplaatst worden' }] });
    // het obstakel is weg: bij de volgende rondgang gaat hij alsnog
    rmSync(join(t.folder, 'verwerkt'));
    await t.settle();
    expect(t.files()).toEqual(['verwerkt']);
    expect(t.files(join(t.folder, 'verwerkt'))).toEqual(['bon.jpg']);
    expect(t.documents()).toHaveLength(1);
    expect(t.scanner.status().folder).toMatchObject({ processed: 1, problems: [] });
  });

  it('bonnenmap en "Afschriften vanzelf inlezen" op dezelfde map: elk pakt alleen het zijne', async () => {
    const t = start();
    t.s.bank.updateAccount(t.s.bank.listAccounts()[0]!.id, { name: 'Knab zakelijk', iban: 'NL91ABNA0417164300' });
    const camt = `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt><Id>1</Id><Acct><Id><IBAN>NL91ABNA0417164300</IBAN></Id></Acct>
      <Ntry><Amt Ccy="EUR">15.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>${new Date().toISOString().slice(0, 10)}</Dt></BookgDt><AcctSvcrRef>S1</AcctSvcrRef>
      <NtryDtls><TxDtls><RltdPties><Cdtr><Nm>KPN</Nm></Cdtr></RltdPties><RmtInf><Ustrd>betaling KPN</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`;
    writeFileSync(join(t.folder, 'afschrift.xml'), camt);
    writeFileSync(join(t.folder, 'e-factuur.xml'), ubl());
    writeFileSync(join(t.folder, 'factuur.pdf'), makePdf(['Bouwmaat Utrecht', 'Totaal 121,00']));
    writeFileSync(join(t.folder, 'bon.jpg'), makeJpeg('zelfde map'));
    await t.scanner.setFolder(t.folder);
    t.s.statementFolder.enable(t.folder);
    const later = () => new Date(Date.now() + 60_000);
    // eerst kijkt de afschriftenmap, dan de bonnenmap, dan de afschriftenmap nog een keer
    expect((await t.s.statementFolder.scan(later())).found).toBe(1);
    await t.settle();
    await t.s.statementFolder.scan(later());
    // de bonnen zijn opgehaald en verplaatst; het afschrift ligt er nog en is geen "probleem" van de bonnenmap
    expect(t.documents().map((d) => d.original_name).sort()).toEqual(['bon.jpg', 'e-factuur.xml', 'factuur.pdf']);
    expect(t.files()).toEqual(['afschrift.xml', 'verwerkt']);
    expect(t.scanner.status().folder.problems).toEqual([]);
    // en de app vraagt alleen over het afschrift "Inlezen?"; een bon is geen afschrift, ook niet in verwerkt/
    const found = t.db.prepare(`SELECT filename FROM statement_files WHERE status = 'gevonden' AND present = 1`).all();
    expect(found).toEqual([{ filename: 'afschrift.xml' }]);
    expect(t.s.bank.list({}).length).toBe(0);
    // de twee instellingen staan los van elkaar
    await t.scanner.setFolder(null);
    expect(t.s.statementFolder.config()).toMatchObject({ enabled: true, path: t.folder });
    t.s.statementFolder.disable();
    expect(t.scanner.folder()).toBeNull();
  });

  it('een foto met GPS uit de bonnenmap blijft zoals hij is: het is je eigen bestand, de app verandert er niets aan', async () => {
    // de bonnenmap werkt terwijl telefoon koppelen uit staat
    expect(PHONE_SCANNER.available).toBe(false);
    const t = start();
    const stored: Buffer[] = [];
    const add = t.s.intake.add.bind(t.s.intake);
    t.s.intake.add = async (name, data, ...rest) => {
      stored.push(Buffer.from(data));
      return add(name, data, ...rest);
    };
    const photo = makeJpegWithGps('eigen foto');
    await t.scanner.setFolder(t.folder);
    writeFileSync(join(t.folder, 'bon.jpg'), photo);
    await t.settle();
    // de bijlage is het bestand zelf (zoals bij slepen in de app), en het bestand in verwerkt/ ook
    expect(stored[0]!.equals(photo)).toBe(true);
    expect(readFileSync(join(t.folder, 'verwerkt', 'bon.jpg')).equals(photo)).toBe(true);
    // de positie komt alleen in de database als locatie aan staat (#32)
    expect(t.db.prepare('SELECT gps_lat, gps_lon FROM documents').all()).toEqual([{ gps_lat: null, gps_lon: null }]);
    // en dezelfde foto met de hand toevoegen is dan ook gewoon hetzelfde bestand
    expect((await t.s.intake.add('bon.jpg', photo)).already_present).toBe(true);
  });

  it('in de demo kijkt de app niet in de bonnenmap', async () => {
    const t = start();
    await t.scanner.setFolder(t.folder);
    t.s.settings.update({ demoMode: true });
    writeFileSync(join(t.folder, 'bon.jpg'), makeJpeg());
    await t.settle();
    expect(t.documents()).toHaveLength(0);
    expect(t.files()).toEqual(['bon.jpg']);
    await expect(t.scanner.setFolder(t.folder)).rejects.toThrow(/demo/);
  });

  it('is de map even niet bereikbaar (bv. een losgekoppelde schijf), dan gaat het later vanzelf verder', async () => {
    const t = start();
    const gone = join(t.folder, 'schijf');
    mkdirSync(gone);
    await t.scanner.setFolder(gone);
    rmSync(gone, { recursive: true });
    await t.settle();
    expect(t.scanner.status().folder).toMatchObject({ folder: gone, reachable: false });
    mkdirSync(gone);
    writeFileSync(join(gone, 'bon.jpg'), makeJpeg());
    await t.settle();
    expect(t.documents()).toHaveLength(1);
    expect(t.scanner.status().folder.reachable).toBe(true);
  });
});
