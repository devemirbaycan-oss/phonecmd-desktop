/**
 * Auto-update via electron-updater, backed by GitHub Releases (free).
 *
 * How it works: electron-builder publishes a `latest.yml` / `latest-mac.yml` /
 * `latest-linux.yml` manifest alongside each release's installers. On launch we
 * fetch that manifest, compare versions, and if a newer one exists, download it
 * in the background and install on the next quit. The user just gets a notice.
 *
 * Everything here is best-effort: a network blip, a rate-limit, or a missing
 * manifest must NEVER stop the app from starting. So we swallow errors and log.
 *
 * Not signed: unsigned apps still auto-update on Windows/Linux. macOS Gatekeeper
 * is stricter about updating unsigned apps — it may prompt again — but it won't
 * break; worst case the user re-downloads.
 */

import {app, dialog, BrowserWindow} from 'electron';
import {autoUpdater} from 'electron-updater';

type Log = (msg: string) => void;

let wired = false;

/**
 * Wire up and kick off an update check. Safe to call once, after app-ready.
 * Does nothing in dev (no packaged app / no update manifest to compare against).
 */
export function initAutoUpdate(getWindow: () => BrowserWindow | null, log: Log = () => {}): void {
  if (wired) return;
  wired = true;

  // In dev there's no installer to update, and electron-updater throws if asked.
  if (!app.isPackaged) {
    log('auto-update: skipped (dev build)');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m: unknown) => log(`auto-update: ${m}`),
    warn: (m: unknown) => log(`auto-update warn: ${m}`),
    error: (m: unknown) => log(`auto-update error: ${m}`),
    debug: () => {},
  } as never;

  autoUpdater.on('update-available', info => {
    log(`auto-update: v${info.version} available — downloading`);
  });

  autoUpdater.on('update-not-available', () => {
    log('auto-update: already on the latest version');
  });

  autoUpdater.on('error', err => {
    // Never surface as a crash — just log. A failed check is a non-event.
    log(`auto-update: check failed (${err?.message ?? err})`);
  });

  // When the download finishes, ask the user — don't yank the app out from under
  // them. If they decline, it installs on the next quit anyway.
  autoUpdater.on('update-downloaded', async info => {
    log(`auto-update: v${info.version} downloaded`);
    const win = getWindow();
    const opts = {
      type: 'info' as const,
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `PhoneCMD ${info.version} is ready to install.`,
      detail: 'Restart to update now, or it will install the next time you quit.',
    };
    const {response} = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts);
    if (response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  // Fire the check. Catch synchronously AND the returned promise — a rejection
  // here must not become an unhandled rejection that could take the app down.
  autoUpdater.checkForUpdates().catch(err => {
    log(`auto-update: initial check failed (${err?.message ?? err})`);
  });
}
