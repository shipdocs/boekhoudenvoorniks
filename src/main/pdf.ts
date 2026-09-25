import { BrowserWindow } from 'electron';

/**
 * HTML → PDF met de ingebouwde Chromium van Electron (geen Puppeteer nodig).
 * Het document wordt geladen in een onzichtbaar, gesandboxed venster zonder JavaScript.
 */
export async function renderPdf(html: string): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    win.destroy();
  }
}
