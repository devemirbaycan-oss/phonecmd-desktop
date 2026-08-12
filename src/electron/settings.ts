/**
 * Tiny persisted-settings store for the desktop app. Lives next to the host's
 * other state in ~/.phonecmd (PHONECMD_HOME override honored, like identity.ts).
 *
 * Only user-facing toggles belong here — right now just auto-update on/off.
 */

import {readFileSync, writeFileSync, mkdirSync} from 'fs';
import {join} from 'path';
import {homedir} from 'os';

export interface Settings {
  /** Whether to check for and install updates automatically. Default: on. */
  autoUpdate: boolean;
  /**
   * Localhost Preview — lets a paired phone view a service running on THIS PC's
   * loopback (e.g. a dev server at http://localhost:3000) in the phone's browser,
   * proxied over the existing end-to-end channel. OFF by default: the host
   * rejects the net.proxy command unless the user turns this on.
   */
  localhostPreview: boolean;
  /**
   * Optional allow-list of loopback ports the phone may reach. When non-empty,
   * ONLY these ports are permitted (everything else is denied). Empty = allow any
   * port (subject to `localhostDenyPorts`). Lets a cautious user expose just the
   * one dev-server port instead of all of localhost.
   */
  localhostAllowPorts: number[];
  /**
   * Ports to always deny, even if `localhostAllowPorts` is empty (allow-any mode).
   * A deny always wins over an allow. Good for shielding sensitive local services
   * (databases, admin panels) while leaving the rest open.
   */
  localhostDenyPorts: number[];
}

const DEFAULTS: Settings = {
  autoUpdate: true,
  localhostPreview: false,
  localhostAllowPorts: [],
  localhostDenyPorts: [],
};

function file(): string {
  const dir = process.env.PHONECMD_HOME || join(homedir(), '.phonecmd');
  return join(dir, 'settings.json');
}

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8'));
    return {...DEFAULTS, ...raw};
  } catch {
    return {...DEFAULTS}; // absent or corrupt → defaults
  }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = {...loadSettings(), ...patch};
  const dir = process.env.PHONECMD_HOME || join(homedir(), '.phonecmd');
  mkdirSync(dir, {recursive: true});
  writeFileSync(file(), JSON.stringify(next, null, 2));
  return next;
}
