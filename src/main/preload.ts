import { contextBridge, ipcRenderer } from 'electron';

/**
 * Enige brug tussen renderer en hoofdproces. De renderer krijgt géén Node-toegang;
 * alleen een generieke aanroep naar de whitelist in main/api.ts.
 */
contextBridge.exposeInMainWorld('bridge', {
  call: (method: string, args: unknown[]) => ipcRenderer.invoke('api', method, args),
  onEvent: (listener: (event: string, payload: unknown) => void) => {
    const handler = (_e: unknown, event: string, payload: unknown) => listener(event, payload);
    ipcRenderer.on('app-event', handler);
    return () => ipcRenderer.removeListener('app-event', handler);
  },
});
