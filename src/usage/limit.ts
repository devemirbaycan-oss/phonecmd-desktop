/**
 * Free-tier usage limit — the desktop host counts terminal commands per paired
 * phone per day and enforces the free cap. GPT stays free (user's own key) and
 * doesn't count here; only terminal commands (term.input) do.
 *
 * Pro devices are unlimited. Pro status is asserted by the phone at pairing
 * (it queried /api/subscription/status); the host trusts it for now — a
 * first-version tradeoff favoring adoption. Server-verified Pro can harden this
 * later without changing the enforcement point.
 *
 * The counter persists to ~/.phonecmd/usage.json so it survives host restarts
 * and resets at local midnight.
 */

import {promises as fsp, readFileSync, writeFileSync, mkdirSync} from 'fs';
import {join} from 'path';
import {homedir} from 'os';

export const FREE_DAILY_LIMIT = 10;

const DIR = join(homedir(), '.phonecmd');
const FILE = join(DIR, 'usage.json');

interface UsageFile {
  day: string; // YYYY-MM-DD (local)
  counts: Record<string, number>; // deviceName -> commands today
}

function today(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function load(): UsageFile {
  try {
    const raw = readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw) as UsageFile;
    if (parsed.day === today() && parsed.counts) {
      return parsed;
    }
  } catch {
    /* fall through to fresh */
  }
  return {day: today(), counts: {}};
}

function save(u: UsageFile): void {
  try {
    mkdirSync(DIR, {recursive: true});
    writeFileSync(FILE, JSON.stringify(u));
  } catch {
    /* best-effort */
  }
}

// In-memory copy, rolled over at day change.
let state: UsageFile = load();

function rollover(): void {
  if (state.day !== today()) {
    state = {day: today(), counts: {}};
    save(state);
  }
}

export interface UsageInfo {
  used: number;
  limit: number;
  remaining: number;
}

/** Current usage for a device (does not increment). */
export function getUsage(deviceName: string): UsageInfo {
  rollover();
  const used = state.counts[deviceName] ?? 0;
  return {used, limit: FREE_DAILY_LIMIT, remaining: Math.max(0, FREE_DAILY_LIMIT - used)};
}

/**
 * Try to consume one command for a non-Pro device. Returns true if allowed
 * (and increments), false if the daily limit is already reached. Pro devices
 * are always allowed and never counted.
 */
export function consume(deviceName: string, isPro: boolean): boolean {
  if (isPro) {
    return true;
  }
  rollover();
  const used = state.counts[deviceName] ?? 0;
  if (used >= FREE_DAILY_LIMIT) {
    return false;
  }
  state.counts[deviceName] = used + 1;
  save(state);
  return true;
}

/** Async flush (unused hook for future). */
export async function flush(): Promise<void> {
  try {
    await fsp.writeFile(FILE, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}
