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
  version: 'phonecmd:version',
  getAutoUpdate: 'phonecmd:get-auto-update',
  setAutoUpdate: 'phonecmd:set-auto-update',
  getLocalhost: 'phonecmd:get-localhost',
  setLocalhost: 'phonecmd:set-localhost',
  forgetDevice: 'phonecmd:forget-device',
  renameDevice: 'phonecmd:rename-device',
  favoriteDevice: 'phonecmd:favorite-device',
} as const;

/** Mirror of ipc.ts LocalhostConfig (preload can't import it). */
interface LocalhostConfig {
  enabled: boolean;
  allowPorts: number[];
  denyPorts: number[];
}

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

  /** The running app version (e.g. "0.1.6"). */
  getVersion: (): Promise<string> => ipcRenderer.invoke(CHANNEL.version),

  /** Whether auto-update is currently enabled (persisted preference). */
  getAutoUpdate: (): Promise<boolean> => ipcRenderer.invoke(CHANNEL.getAutoUpdate),

  /** Turn auto-update on/off. Returns the new value. */
  setAutoUpdate: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke(CHANNEL.setAutoUpdate, enabled),

  /** Read the Localhost Preview config (enabled + port allow/deny lists). */
  getLocalhost: (): Promise<LocalhostConfig> =>
    ipcRenderer.invoke(CHANNEL.getLocalhost),

  /** Update the Localhost Preview config. Returns the saved value. */
  setLocalhost: (cfg: LocalhostConfig): Promise<LocalhostConfig> =>
    ipcRenderer.invoke(CHANNEL.setLocalhost, cfg),

  /** Revoke a paired device (it must re-pair with code + approval next time). */
  forgetDevice: (publicKey: string): Promise<void> =>
    ipcRenderer.invoke(CHANNEL.forgetDevice, publicKey),

  /** Set a display label for a device. */
  renameDevice: (publicKey: string, label: string): Promise<void> =>
    ipcRenderer.invoke(CHANNEL.renameDevice, publicKey, label),

  /** Pin/unpin a device. */
  favoriteDevice: (publicKey: string, favorite: boolean): Promise<void> =>
    ipcRenderer.invoke(CHANNEL.favoriteDevice, publicKey, favorite),
};

contextBridge.exposeInMainWorld('phonecmd', api);

export type PhoneCmdApi = typeof api;
