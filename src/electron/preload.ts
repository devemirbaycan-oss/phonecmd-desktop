/**
 * Preload — the ONLY bridge between the sandboxed renderer and the main process.
 * Exposes a minimal, typed `window.phonecmd` API via contextBridge. No Node
 * globals leak into the renderer (contextIsolation + nodeIntegration:false).
 */

import {contextBridge, ipcRenderer} from 'electron';

// NOTE: preload runs in a sandboxed context that cannot `require` sibling
// modules, so the channel names are inlined here rather than imported from
// ./ipc. Keep these in sync with CHANNEL in ipc.ts.
const CHANNEL = {
  event: 'phonecmd:event',
  approve: 'phonecmd:approve',
  restart: 'phonecmd:restart',
  setTtl: 'phonecmd:set-ttl',
  copy: 'phonecmd:copy',
} as const;

const api = {
  /** Tell main the UI is ready; main then starts the host. */
  ready: (): Promise<void> => ipcRenderer.invoke('phonecmd:ready'),

  /** Subscribe to host events. Returns an unsubscribe fn. */
  onEvent: (cb: (type: string, data: unknown) => void): (() => void) => {
    const listener = (_e: unknown, msg: {type: string; data: unknown}) =>
      cb(msg.type, msg.data);
    ipcRenderer.on(CHANNEL.event, listener);
    return () => ipcRenderer.removeListener(CHANNEL.event, listener);
  },

  /** Answer a pairing prompt. */
  approvePairing: (requestId: string, approved: boolean): void =>
    ipcRenderer.send(CHANNEL.approve, {requestId, approved}),

  /** Restart the host to mint a fresh QR. */
  restart: (): Promise<void> => ipcRenderer.invoke(CHANNEL.restart),

  /** Change the pairing-expiry preset (e.g. 'never', '1d', '7d'). */
  setTtl: (choice: string): Promise<void> =>
    ipcRenderer.invoke(CHANNEL.setTtl, choice),

  /** Copy text (the keycode) to the system clipboard via main. */
  copy: (text: string): Promise<void> =>
    ipcRenderer.invoke(CHANNEL.copy, text),
};

contextBridge.exposeInMainWorld('phonecmd', api);

export type PhoneCmdApi = typeof api;
