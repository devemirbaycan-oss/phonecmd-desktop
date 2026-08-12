/**
 * Electron main process. Owns the HostCore and bridges its lifecycle to the
 * renderer over IPC. Crucially, it turns each pairing request into a real
 * user prompt in the renderer and waits for the human's decision before the
 * handshake proceeds — replacing the headless auto-accept.
 */

import {app, BrowserWindow, ipcMain, clipboard} from 'electron';
import {join} from 'path';
import {appendFileSync} from 'fs';
import QRCode from 'qrcode';

/** Debug sink that survives Electron's stdout detachment on Windows. */
function dbg(msg: string): void {
  if (process.env.PHONECMD_DEBUG) {
    try {
      appendFileSync(process.env.PHONECMD_DEBUG, `${msg}\n`);
    } catch {
      /* ignore */
    }
  }
}
import {HostCore} from '../core/host';
import {ttlFromChoice, PAIRING_TTL_OPTIONS} from '../pairing/session';
import {encodeKeycode} from '../pairing/keycode';
import {loadKnownDevices, forgetDevice, renameDevice, setDeviceFavorite} from '../pairing/devices';
import {getUsage, FREE_DAILY_LIMIT} from '../usage/limit';
import {PairRequest} from '../protocol';
import {CHANNEL, ConnectedDevice} from './ipc';
import {initAutoUpdate, setAutoUpdateEnabled} from './updater';
import {loadSettings, saveSettings} from './settings';

const PORT = Number(process.env.PHONECMD_PORT ?? 8787);
const NO_TUNNEL = process.env.PHONECMD_NO_TUNNEL === '1';

let win: BrowserWindow | null = null;
let host: HostCore | null = null;
// Selected pairing-expiry preset id (default: never). Changed from the UI.
let pairingTtlChoice: string =
  process.env.PHONECMD_PAIRING_TTL || 'never';

// Pending pairing prompts awaiting a renderer decision.
const pendingApprovals = new Map<string, (approved: boolean) => void>();
let approvalSeq = 0;

// Every device this host knows — remembered ones (from devices.json, loaded at
// startup, shown offline) plus any live this session. Keyed by device name for
// the UI; `online` reflects live connection state.
const devices: ConnectedDevice[] = [];
let usageTimer: NodeJS.Timeout | null = null;

/** Load remembered devices so the list isn't empty after a restart until the
 *  phone reconnects. They show as offline until they connect. */
async function loadRememberedDevices(): Promise<void> {
  try {
    const known = await loadKnownDevices();
    for (const d of known) {
      if (!devices.some(x => x.publicKey === d.publicKey)) {
        devices.push({
          deviceName: d.name,
          since: d.pairedAt,
          online: false,
          publicKey: d.publicKey,
          label: d.label,
          favorite: d.favorite,
        });
      }
    }
    pushDevices();
  } catch {
    /* best-effort — an empty list is fine */
  }
}

function pushDevices(): void {
  send('devices', {devices: [...devices]});
}

/**
 * Push today's free-tier usage. The host counts per device name, so the figure
 * we show is for the busiest paired device (that's the one that will hit the
 * cap); with none paired we show a zeroed bar.
 */
function pushUsage(): void {
  let used = 0;
  for (const d of devices) {
    used = Math.max(used, getUsage(d.deviceName).used);
  }
  send('usage', {
    used,
    limit: FREE_DAILY_LIMIT,
    remaining: Math.max(0, FREE_DAILY_LIMIT - used),
  });
}

function send<T extends keyof import('./ipc').HostToRenderer>(
  type: T,
  data: import('./ipc').HostToRenderer[T],
): void {
  win?.webContents.send(CHANNEL.event, {type, data});
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 520,
    height: 860,
    minWidth: 420,
    minHeight: 600,
    resizable: true,
    backgroundColor: '#0a0a0f', // matches the app's bg token
    title: 'PhoneCMD',
    // The title-bar / taskbar icon. Without this the window shows Electron's
    // default grey icon even though the installer icon is set. The PNG is copied
    // next to the compiled main.js (see the build script / files glob).
    icon: join(__dirname, 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);

  // Surface renderer console + load failures to the debug sink.
  win.webContents.on('console-message', (_e, _lvl, message) =>
    dbg(`renderer: ${message}`),
  );
  win.webContents.on('did-fail-load', (_e, code, desc) =>
    dbg(`did-fail-load ${code} ${desc}`),
  );
  win.webContents.on('did-finish-load', () => dbg('renderer did-finish-load'));
  win.webContents.on(
    'preload-error',
    (_e, path, error) => dbg(`preload-error ${path}: ${error.message}`),
  );

  // Renderer is a static file; it lives beside the compiled main in dist/.
  win.loadFile(join(__dirname, 'renderer.html'));
  win.on('closed', () => (win = null));
}

/** Ask the renderer to approve a pairing; resolves with the user's choice. */
function askApproval(req: PairRequest): Promise<boolean> {
  const requestId = `pair-${++approvalSeq}`;
  return new Promise<boolean>(resolve => {
    pendingApprovals.set(requestId, resolve);
    send('pair-request', {req, requestId});
    dbg(`pair-request from "${req.deviceName}" (${requestId})`);
    // Test hook: auto-approve without a human clicker (headless verification).
    if (process.env.PHONECMD_AUTO_APPROVE === '1') {
      pendingApprovals.delete(requestId);
      dbg('auto-approved (PHONECMD_AUTO_APPROVE)');
      resolve(true);
      return;
    }
    // Safety timeout: auto-reject after 60s so a socket can't hang forever.
    // Tell the renderer too — otherwise its modal sits there forever holding a
    // request id we've already discarded, and clicking Approve does nothing.
    setTimeout(() => {
      if (pendingApprovals.has(requestId)) {
        pendingApprovals.delete(requestId);
        send('pair-cancelled', {requestId});
        dbg(`pair-request ${requestId} timed out — auto-rejected`);
        resolve(false);
      }
    }, 60_000);
  });
}

async function startHost(): Promise<void> {
  host?.stop();
  host = new HostCore({
    port: PORT,
    noTunnel: NO_TUNNEL,
    approve: askApproval,
    pairingTtlMs: ttlFromChoice(pairingTtlChoice),
  });

  host.on('status', (status, detail) => {
    dbg(`status=${status}${detail ? ' ' + detail : ''}`);
    send('status', {status, detail});
  });
  host.on('log', message => {
    dbg(message);
    send('log', {message});
  });
  host.on('paired', async deviceName => {
    send('paired', {deviceName});
    const existing = devices.find(d => d.deviceName === deviceName);
    if (existing) {
      existing.online = true; // a remembered device came back online
    } else {
      devices.push({deviceName, since: new Date().toISOString(), online: true});
    }
    // Backfill publicKey/label/favorite from devices.json (rememberDevice just
    // wrote the key) so the row supports delete/rename/favorite this session.
    try {
      const known = await loadKnownDevices();
      const match = known.find(k => k.name === deviceName);
      const row = devices.find(d => d.deviceName === deviceName);
      if (match && row) {
        row.publicKey = match.publicKey;
        row.label = match.label;
        row.favorite = match.favorite;
      }
    } catch {
      /* best-effort */
    }
    pushDevices();
    pushUsage();
  });
  host.on('disconnected', deviceName => {
    send('disconnected', {deviceName});
    // Keep the device in the list but mark it offline — it's still a known,
    // approved device (persisted in devices.json), just not connected now.
    const d = devices.find(x => x.deviceName === deviceName);
    if (d) {
      d.online = false;
    }
    pushDevices();
  });
  host.on('qr', async payload => {
    const qrDataUrl = await QRCode.toDataURL(JSON.stringify(payload), {
      margin: 1,
      width: 320,
      color: {dark: '#0a0a0f', light: '#ffffff'},
    });
    dbg(
      `qr ready — code=${payload.pairingCode} endpoint=${payload.endpoint} dataUrlLen=${qrDataUrl.length}`,
    );
    dbg(`qr-payload ${JSON.stringify(payload)}`);
    send('qr', {payload, qrDataUrl, keycode: encodeKeycode(payload)});
  });

  await host.start();

  // Reset the live list, then repopulate from the remembered devices so the UI
  // shows previously-approved phones (offline) instead of an empty list. They
  // flip to online when they reconnect. (A restart does NOT drop pairings —
  // approved keys live in devices.json.)
  devices.length = 0;
  await loadRememberedDevices();
  pushUsage();

  // Keep the usage bar live while commands run.
  if (usageTimer) {
    clearInterval(usageTimer);
  }
  usageTimer = setInterval(pushUsage, 3000);
  usageTimer.unref?.();
}

app.whenReady().then(() => {
  dbg('app ready — creating window');
  createWindow();

  // Check GitHub Releases for a newer version and install it in the background.
  // Best-effort: never blocks or breaks startup (see updater.ts).
  initAutoUpdate(() => win, dbg);

  // Renderer signals it's ready → send the TTL options, then start the host.
  ipcMain.handle('phonecmd:ready', async () => {
    dbg('renderer ready — starting host');
    send('ttl-options', {
      options: PAIRING_TTL_OPTIONS.map(o => ({id: o.id, label: o.label})),
      current: pairingTtlChoice,
    });
    await startHost();
  });

  // Change the pairing-expiry choice → restart the host to mint a fresh QR.
  ipcMain.handle(CHANNEL.setTtl, async (_e, choice: string) => {
    pairingTtlChoice = choice;
    send('ttl-options', {
      options: PAIRING_TTL_OPTIONS.map(o => ({id: o.id, label: o.label})),
      current: pairingTtlChoice,
    });
    await startHost();
  });

  ipcMain.on(CHANNEL.approve, (_e, msg: {requestId: string; approved: boolean}) => {
    const resolver = pendingApprovals.get(msg.requestId);
    if (resolver) {
      pendingApprovals.delete(msg.requestId);
      resolver(msg.approved);
    }
  });

  ipcMain.handle(CHANNEL.restart, async () => {
    await startHost();
  });

  // The renderer is sandboxed (no clipboard access), so copying goes through main.
  ipcMain.handle(CHANNEL.copy, (_e, text: string) => {
    clipboard.writeText(String(text ?? ''));
  });

  // Version — the UI shows it so you can tell which build you're on (and see
  // auto-update actually change it).
  ipcMain.handle(CHANNEL.version, () => app.getVersion());

  // Auto-update toggle, persisted in ~/.phonecmd/settings.json.
  ipcMain.handle(CHANNEL.getAutoUpdate, () => loadSettings().autoUpdate);
  ipcMain.handle(CHANNEL.setAutoUpdate, (_e, enabled: boolean) => {
    const {autoUpdate} = saveSettings({autoUpdate: !!enabled});
    setAutoUpdateEnabled(autoUpdate); // start/stop the checker live
    return autoUpdate;
  });

  // Localhost Preview config (off by default; localhost-only + port policy).
  const readLocalhost = () => {
    const s = loadSettings();
    return {enabled: s.localhostPreview, allowPorts: s.localhostAllowPorts, denyPorts: s.localhostDenyPorts};
  };
  // Coerce arbitrary renderer input into a clean, de-duped list of valid ports.
  const cleanPorts = (v: unknown): number[] =>
    Array.isArray(v)
      ? [...new Set(v.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 65535))]
      : [];
  ipcMain.handle(CHANNEL.getLocalhost, () => readLocalhost());
  ipcMain.handle(CHANNEL.setLocalhost, (_e, cfg: {enabled?: boolean; allowPorts?: unknown; denyPorts?: unknown}) => {
    saveSettings({
      localhostPreview: !!cfg?.enabled,
      localhostAllowPorts: cleanPorts(cfg?.allowPorts),
      localhostDenyPorts: cleanPorts(cfg?.denyPorts),
    });
    return readLocalhost();
  });

  // Paired-device management from the desktop (delete / rename / favorite). Each
  // updates devices.json and refreshes the UI list. Forget = full revoke: that
  // device must re-pair (code + approval) next time.
  const applyDeviceUpdate = (publicKey: string, fn: (d: ConnectedDevice) => void) => {
    const d = devices.find(x => x.publicKey === publicKey);
    if (d) fn(d);
    pushDevices();
  };
  ipcMain.handle(CHANNEL.forgetDevice, async (_e, publicKey: string) => {
    if (!publicKey) return;
    await forgetDevice(publicKey);
    const i = devices.findIndex(x => x.publicKey === publicKey);
    if (i >= 0) devices.splice(i, 1);
    pushDevices();
  });
  ipcMain.handle(CHANNEL.renameDevice, async (_e, publicKey: string, label: string) => {
    if (!publicKey) return;
    await renameDevice(publicKey, label ?? '');
    applyDeviceUpdate(publicKey, d => (d.label = (label ?? '').trim() || undefined));
  });
  ipcMain.handle(CHANNEL.favoriteDevice, async (_e, publicKey: string, favorite: boolean) => {
    if (!publicKey) return;
    await setDeviceFavorite(publicKey, !!favorite);
    applyDeviceUpdate(publicKey, d => (d.favorite = !!favorite));
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  host?.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
