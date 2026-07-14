/**
 * Known devices — the phones this host has already paired with, remembered
 * across restarts.
 *
 * Why this exists: the pairing CODE is a fresh one-time secret per host run, so
 * a phone that paired yesterday presents yesterday's code and gets
 * `invalid pairing code`. The host had no memory of it — `peerPublic` lived only
 * in the connection closure — so every restart silently orphaned every paired
 * phone, and the user saw a generic connection failure.
 *
 * The fix is not to freeze the pairing code (that would make a leaked keycode
 * valid forever). It's to give the host a memory: once you approve a device, we
 * store its public key here, and on reconnect it authenticates by decrypting
 * with that key instead of by reciting a 6-digit code. That is strictly stronger
 * — a code is 10^6 guesses, an X25519 key is not guessable — and it's the same
 * trust the user already granted when they clicked Approve.
 *
 * A NEW device still needs the current pairing code AND the user's approval.
 *
 * Stored in ~/.phonecmd/devices.json, user-only (best-effort chmod on posix).
 */

import {promises as fsp, mkdirSync} from 'fs';
import {join} from 'path';
import {homedir} from 'os';

/**
 * Where the store lives. PHONECMD_HOME redirects it — tests point this at a temp
 * dir so a test run can never mutate the real host's paired-device list.
 * Resolved per call (not cached) so a test can set it after import.
 */
function paths(): {dir: string; file: string} {
  const dir = process.env.PHONECMD_HOME || join(homedir(), '.phonecmd');
  return {dir, file: join(dir, 'devices.json')};
}

export interface KnownDevice {
  /** The phone's X25519 public key, base64. The identity we actually trust. */
  publicKey: string;
  /** Last device name it announced (display only — never trusted for auth). */
  name: string;
  /** ISO timestamps, for the UI and for pruning. */
  pairedAt: string;
  lastSeenAt: string;
}

interface StoredDevices {
  devices: KnownDevice[];
}

/** Load the known-device list. Returns [] if absent or unreadable. */
export async function loadKnownDevices(): Promise<KnownDevice[]> {
  try {
    const raw = await fsp.readFile(paths().file, 'utf8');
    const parsed = JSON.parse(raw) as StoredDevices;
    if (Array.isArray(parsed?.devices)) {
      return parsed.devices.filter(d => typeof d?.publicKey === 'string' && d.publicKey);
    }
  } catch {
    /* not present or corrupt → start empty */
  }
  return [];
}

/** True if this public key has been approved before. */
export async function isKnownDevice(publicKey: string): Promise<boolean> {
  const devices = await loadKnownDevices();
  return devices.some(d => d.publicKey === publicKey);
}

/**
 * Remember a device (or refresh its lastSeen/name). Keyed on the public key, so
 * re-pairing the same phone updates in place rather than duplicating.
 */
export async function rememberDevice(publicKey: string, name: string): Promise<void> {
  const devices = await loadKnownDevices();
  const now = new Date().toISOString();
  const existing = devices.find(d => d.publicKey === publicKey);
  if (existing) {
    existing.lastSeenAt = now;
    if (name) {
      existing.name = name;
    }
  } else {
    devices.push({publicKey, name: name || 'unknown', pairedAt: now, lastSeenAt: now});
  }
  await save({devices});
}

/** Revoke a device — it must pair from scratch (code + approval) next time. */
export async function forgetDevice(publicKey: string): Promise<void> {
  const devices = await loadKnownDevices();
  await save({devices: devices.filter(d => d.publicKey !== publicKey)});
}

/** Revoke every device. */
export async function forgetAllDevices(): Promise<void> {
  await save({devices: []});
}

async function save(data: StoredDevices): Promise<void> {
  const {dir, file} = paths();
  mkdirSync(dir, {recursive: true});
  await fsp.writeFile(file, JSON.stringify(data, null, 2), {mode: 0o600});
  try {
    await fsp.chmod(file, 0o600); // user-only (no-op on Windows)
  } catch {
    /* best-effort */
  }
}
