import { BrowserWindow, dialog } from 'electron';
import { migrateToSharedDir, type MigrationOutcome, type OldFolderInfo } from './data-dir';
import { syncFolderWarning, type StoreMigrationChoice, type StoreMigrationFailure } from './windows-store';

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

const PROGRESS_PAGE = `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  body { font: 14px system-ui, sans-serif; margin: 24px; color: #1c2430; background: #f6f7f9; }
  h1 { font-size: 16px; margin: 0 0 8px; }
  p { margin: 0 0 16px; color: #4a5565; }
  progress { width: 100%; height: 14px; }
  a { display: inline-block; margin-top: 16px; padding: 6px 14px; border: 1px solid #b6bfcc; border-radius: 6px; color: #1c2430; text-decoration: none; background: #fff; }
</style></head><body>
<h1>Je gegevens worden overgezet</h1>
<p>Je administratie verhuist naar een vaste map in je persoonlijke map. De oude map blijft bewaard. Dit gebeurt één keer.</p>
<progress id="p" max="100" value="0"></progress>
<div><a href="https://stoppen.invalid/">Stoppen</a></div>
</body></html>`;

/**
 * Zet over met een voortgangsvenster. Stoppen (de knop of het venster sluiten) breekt netjes af: de
 * oude map blijft zoals hij was en de app werkt daar verder.
 */
export async function migrateWithProgress(source: string, target: string, showWindow: boolean): Promise<MigrationOutcome> {
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
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PROGRESS_PAGE)}`);
  }
  let shown = -1;
  try {
    return await migrateToSharedDir({
      source,
      target,
      shouldStop: () => stop,
      log: (message) => console.log(message),
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

/** De gekozen map wordt met de cloud gesynchroniseerd: waarschuwen. Waar = toch gebruiken. */
export async function confirmSyncFolder(dir: string, service: string): Promise<boolean> {
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'BoekhoudenVoorNiks',
    message: `Deze map wordt gesynchroniseerd met ${service}`,
    detail: syncFolderWarning(dir, service),
    buttons: ['Andere map kiezen', 'Toch gebruiken'],
    cancelId: 0,
    defaultId: 0,
    noLink: true,
  });
  return result.response === 1;
}
