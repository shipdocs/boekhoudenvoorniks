import { BrowserWindow, dialog } from 'electron';
import { inspectMoved, migrateToSharedDir, movedQuestion, resumeMoved, switchDataDir, type DataDirResolution, type MigrationOutcome, type OldFolderInfo, type SwitchAction, type SwitchOutcome } from './data-dir';
import type { StoreMigrationChoice, StoreMigrationFailure } from './windows-store';

function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function describe(folder: OldFolderInfo): string {
  const when = new Date(folder.lastModified).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' });
  const count = folder.administrationCount === 1 ? '1 administratie' : `${folder.administrationCount} administraties`;
  return `${folder.dir}\n   laatst gewijzigd ${when} · ${megabytes(folder.size)} · ${count}`;
}

/**
 * Twee oude mappen met een administratie: de app raadt niet, de gebruiker kiest. Null = geannuleerd
 * (de app sluit dan zonder iets te wijzigen en vraagt het de volgende keer weer).
 */
export async function chooseOldFolder(candidates: OldFolderInfo[]): Promise<OldFolderInfo | null> {
  const result = await dialog.showMessageBox({
    type: 'question',
    title: 'BoekhoudenVoorNiks',
    message: 'Welke administratie wil je meenemen?',
    detail:
      'Er staan op deze computer twee mappen met een administratie. Je gegevens verhuizen naar één vaste map; kies welke je wilt gebruiken. De andere map blijft staan, er wordt niets gewist.\n\n' +
      candidates.map((c, i) => `${i + 1}. ${describe(c)}`).join('\n\n'),
    buttons: [...candidates.map((c, i) => `Map ${i + 1} (${c.name})`), 'Annuleren'],
    cancelId: candidates.length,
    defaultId: candidates.length,
    noLink: true,
  });
  return candidates[result.response] ?? null;
}

/**
 * De gegevens zijn verplaatst naar een eigen map, maar de verwijzing daarnaar is weg: de app raadt niet.
 * `{ dir }` = de verplaatste map weer gebruiken (de verwijzing is teruggezet), `ouder` = bewust verder
 * met wat er zonder die map is, null = afsluiten zonder iets te wijzigen. Opnieuw proberen kijkt opnieuw
 * of de map er is (schijf aangesloten).
 */
export async function chooseAfterMove(resolution: Extract<DataDirResolution, { kind: 'verhuisd' }>, home: string): Promise<{ dir: string } | 'ouder' | null> {
  for (;;) {
    const question = movedQuestion(resolution, inspectMoved(resolution.moved), home);
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: 'BoekhoudenVoorNiks',
      message: question.message,
      detail: question.detail,
      buttons: question.buttons.map((b) => b.label),
      cancelId: question.buttons.length - 1,
      defaultId: question.buttons.length - 1,
      noLink: true,
    });
    const answer = question.buttons[result.response]?.answer ?? 'stoppen';
    if (answer === 'stoppen') return null;
    if (answer === 'ouder') return 'ouder';
    if (answer === 'verplaatst') {
      try {
        return { dir: resumeMoved(home, resolution.moved) };
      } catch (e) {
        // de map is net verdwenen: opnieuw kijken en opnieuw vragen
        console.error(e);
      }
    }
  }
}

const progressPage = (title: string, text: string): string => `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  body { font: 14px system-ui, sans-serif; margin: 24px; color: #1c2430; background: #f6f7f9; }
  h1 { font-size: 16px; margin: 0 0 8px; }
  p { margin: 0 0 16px; color: #4a5565; }
  progress { width: 100%; height: 14px; }
  a { display: inline-block; margin-top: 16px; padding: 6px 14px; border: 1px solid #b6bfcc; border-radius: 6px; color: #1c2430; text-decoration: none; background: #fff; }
</style></head><body>
<h1>${title}</h1>
<p>${text}</p>
<progress id="p" max="100" value="0"></progress>
<div><a href="https://stoppen.invalid/">Stoppen</a></div>
</body></html>`;

interface ProgressHooks {
  shouldStop: () => boolean;
  onProgress: (done: number, total: number) => void;
}

/**
 * Voert `run` uit met een voortgangsvenster. Stoppen (de knop of het venster sluiten) breekt netjes af:
 * de map waaruit de app werkt blijft zoals hij was en de app werkt daar verder.
 */
async function withProgress<T>(title: string, text: string, showWindow: boolean, run: (hooks: ProgressHooks) => Promise<T>): Promise<T> {
  let stop = false;
  let window: BrowserWindow | null = null;
  if (showWindow) {
    window = new BrowserWindow({
      width: 480,
      height: 250,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'BoekhoudenVoorNiks',
      backgroundColor: '#f6f7f9',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    // de pagina kan niets behalve "Stoppen": elke navigatie betekent stoppen
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault();
      stop = true;
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.on('closed', () => {
      stop = true;
      window = null;
    });
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(progressPage(title, text))}`);
  }
  let shown = -1;
  try {
    return await run({
      shouldStop: () => stop,
      onProgress: (done, total) => {
        const percent = total > 0 ? Math.floor((done / total) * 100) : 100;
        if (percent === shown || !window) return;
        shown = percent;
        void window.webContents.executeJavaScript(`document.getElementById('p').value = ${percent}`).catch(() => undefined);
      },
    });
  } finally {
    window?.destroy();
  }
}

/**
 * Zet over met een voortgangsvenster. Stoppen (de knop of het venster sluiten) breekt netjes af: de
 * oude map blijft zoals hij was en de app werkt daar verder.
 */
export function migrateWithProgress(source: string, target: string, showWindow: boolean): Promise<MigrationOutcome> {
  return withProgress(
    'Je gegevens worden overgezet',
    'Je administratie verhuist naar een vaste map in je persoonlijke map. De oude map blijft bewaard. Dit gebeurt één keer.',
    showWindow,
    (hooks) => migrateToSharedDir({ source, target, log: (message) => console.log(message), ...hooks }),
  );
}

/** Wisselt van gegevensmap (Instellingen); alleen bij kopiëren is er een voortgangsvenster. */
export function switchWithProgress(home: string, source: string, request: { target: string; action: SwitchAction }, showWindow: boolean): Promise<SwitchOutcome> {
  return withProgress(
    'Je gegevens worden gekopieerd',
    'Je administratie gaat naar de map die je koos. De map waar hij nu staat blijft bewaard.',
    showWindow && request.action === 'kopieren',
    (hooks) => switchDataDir({ home, source, ...request, log: (message) => console.log(message), ...hooks }),
  );
}

/**
 * Store-versie, het overzetten lukte niet: opnieuw proberen, zelf een map kiezen, of de oude map
 * alleen bekijken. Het venster sluiten = afsluiten; er verandert dan niets.
 */
export async function chooseAfterFailedMigration(failure: StoreMigrationFailure): Promise<StoreMigrationChoice> {
  const choices: [string, StoreMigrationChoice][] = [
    ['Opnieuw proberen', 'opnieuw'],
    ['Zelf een map kiezen…', 'kiezen'],
    ...(failure.viewProblem === null ? ([['Alleen bekijken', 'bekijken']] as [string, StoreMigrationChoice][]) : []),
    ['Afsluiten', 'afsluiten'],
  ];
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'BoekhoudenVoorNiks',
    message: 'Je gegevens zijn nog niet overgezet',
    detail:
      `${failure.status === 'mislukt' ? `Het overzetten naar ${failure.target} lukte niet (${failure.reason}).` : failure.reason}\n\n` +
      `Er is niets veranderd: je administratie staat nog in ${failure.source}. De versie uit de Microsoft Store kan daar niet in werken, want wat hij daar opslaat verdwijnt als je de app verwijdert.\n\n` +
      'Probeer het opnieuw, of kies zelf een map (bijvoorbeeld op een schijf met meer ruimte). ' +
      (failure.viewProblem === null ? 'Je kunt je administratie ook alleen bekijken; wijzigen kan dan niet.' : `Alleen bekijken kan nu niet: ${failure.viewProblem}`),
    buttons: choices.map(([label]) => label),
    cancelId: choices.length - 1,
    defaultId: 0,
    noLink: true,
  });
  return choices[result.response]?.[1] ?? 'afsluiten';
}

/** De mapkiezer voor een zelf gekozen gegevensmap; null = geannuleerd. */
export async function pickDataFolder(defaultPath: string): Promise<string | null> {
  const result = await dialog.showOpenDialog({ title: 'Kies een map voor je administratie', defaultPath, properties: ['openDirectory', 'createDirectory'] });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

export async function refuseDataFolder(reason: string): Promise<void> {
  await dialog.showMessageBox({ type: 'warning', title: 'BoekhoudenVoorNiks', message: 'Deze map kan niet', detail: reason, buttons: ['OK'] });
}

/** De gekozen map wordt bijgehouden door een synchronisatiedienst: dezelfde waarschuwing als in Instellingen. Waar = toch gebruiken. */
export async function confirmSyncFolder(dir: string, service: string): Promise<boolean> {
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'BoekhoudenVoorNiks',
    message: `Let op: deze map wordt bijgehouden door ${service}`,
    detail: `De map ${dir} wordt bijgehouden door ${service}. Zo'n dienst kopieert bestanden terwijl de app ermee werkt, en daar kan je administratie van beschadigen.\n\nKies liever een map die niet wordt gesynchroniseerd.`,
    buttons: ['Andere map kiezen', 'Toch gebruiken'],
    cancelId: 0,
    defaultId: 0,
    noLink: true,
  });
  return result.response === 1;
}
