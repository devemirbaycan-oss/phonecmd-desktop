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
}

const DEFAULTS: Settings = {autoUpdate: true};

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
