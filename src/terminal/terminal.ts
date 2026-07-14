/**
 * PC terminals — the backbone of PhoneCMD. A phone can run MULTIPLE shells at
 * once (tabs/agents), each identified by a `termId`. Each shell streams its
 * output to the phone tagged with its termId so the app routes it to the right
 * tab. Commands (run anything: npm, git, claude/codex/… CLIs) go to a specific
 * shell by termId.
 *
 * Each shell is a REAL, PERSISTENT terminal session backed by a PTY (node-pty),
 * so interactive CLIs (Claude, Codex, Gemini, aider) and TUIs get a proper TTY
 * and STAY ALIVE across prompts — not one-shot command runs. If the native
 * node-pty build is unavailable (some headless/CI envs), we transparently fall
 * back to a plain piped child process so line-oriented commands still work.
 *
 * Also persists on the PC:
 *  - command history (~/.phonecmd/history.log), shared across shells
 *  - saved profiles (~/.phonecmd/profiles.json): named {label, command, cwd}
 *    the user can relaunch into a new tab.
 */

import {spawn, ChildProcessWithoutNullStreams} from 'child_process';
import {promises as fsp, appendFileSync, mkdirSync} from 'fs';
import {join} from 'path';
import {homedir} from 'os';
import {CommandHandler, LimitReachedError} from '../commands/router';
import {consume, getUsage, FREE_DAILY_LIMIT} from '../usage/limit';

const DIR = join(homedir(), '.phonecmd');
const HISTORY_FILE = join(DIR, 'history.log');
const PROFILES_FILE = join(DIR, 'profiles.json');
const MAX_HISTORY_LINES = 1000;

type PushFn = (kind: 'term.output' | 'term.exit', data: unknown) => void;

// ── PTY backend (node-pty) with a piped fallback ────────────────────────────
// A minimal common surface both backends implement, so the Terminal class
// doesn't care which is in use.
interface ShellBackend {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

type PtyModule = typeof import('node-pty');
let ptyModule: PtyModule | null | undefined;
function loadPty(): PtyModule | null {
  if (ptyModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ptyModule = require('node-pty') as PtyModule;
    } catch {
      ptyModule = null; // native build missing — use the piped fallback
    }
  }
  return ptyModule ?? null;
}

/** True when a real PTY backend is available (used by tests / diagnostics). */
export function ptyAvailable(): boolean {
  return loadPty() !== null;
}

/** Spawn an interactive shell — a real PTY if possible, else a piped process. */
function spawnShell(cwd: string): ShellBackend {
  const pty = loadPty();
  if (pty) {
    const shell = process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL || '/bin/bash';
    const p = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd,
      env: process.env as {[k: string]: string},
    });
    return {
      write: d => p.write(d),
      resize: (c, r) => {
        try {
          p.resize(c, r);
        } catch {
          /* ignore */
        }
      },
      kill: sig => p.kill(sig),
      onData: cb => p.onData(cb),
      onExit: cb => p.onExit(e => cb(e.exitCode)),
    };
  }
  // Fallback: plain piped child process (no TTY — one-shot-ish CLIs only).
  const {cmd, args} = pipedShellCommand();
  const proc = spawn(cmd, args, {cwd, env: process.env, windowsHide: true}) as ChildProcessWithoutNullStreams;
  return {
    write: d => proc.stdin.write(d),
    resize: () => {},
    kill: sig => proc.kill((sig as NodeJS.Signals) || undefined),
    onData: cb => {
      proc.stdout.on('data', (b: Buffer) => cb(b.toString()));
      proc.stderr.on('data', (b: Buffer) => cb(b.toString()));
    },
    onExit: cb => proc.on('exit', code => cb(code)),
  };
}

/** One persistent shell SESSION (PTY-backed), streaming output to the phone. */
class Terminal {
  private shell: ShellBackend | null = null;

  constructor(readonly termId: string, private push: PushFn) {}

  /** Update the push channel (a reconnect brings a new one). */
  setPush(push: PushFn) {
    this.push = push;
  }

  get running(): boolean {
    return this.shell !== null;
  }

  start(cwd?: string): {cwd: string} {
    if (this.shell) {
      return {cwd: cwd || homedir()};
    }
    const startCwd = cwd || homedir();
    try {
      this.shell = spawnShell(startCwd);
    } catch (err) {
      this.push('term.output', {
        termId: this.termId,
        chunk: `\n[phonecmd] shell error: ${err instanceof Error ? err.message : String(err)}\n`,
      });
      return {cwd: startCwd};
    }

    this.shell.onData(chunk =>
      this.push('term.output', {termId: this.termId, chunk}),
    );
    this.shell.onExit(code => {
      this.push('term.exit', {termId: this.termId, code});
      this.shell = null;
    });
    return {cwd: startCwd};
  }

  /** Send a line to the SESSION. Uses \r so a PTY treats it as Enter. */
  input(line: string): void {
    if (!this.shell) {
      throw new Error('Terminal not started');
    }
    appendHistory(line);
    const data = line.endsWith('\n') || line.endsWith('\r') ? line : line + '\r';
    this.shell.write(data);
  }

  /** Send raw bytes/keys without history (e.g. arrow keys, Ctrl sequences). */
  writeRaw(data: string): void {
    this.shell?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.shell?.resize(cols, rows);
  }

  signal(sig: NodeJS.Signals = 'SIGINT'): void {
    // In a PTY, Ctrl-C is the interrupt; send the character so the foreground
    // program (e.g. a running CLI) gets it, keeping the shell session alive.
    if (sig === 'SIGINT') {
      this.shell?.write('\x03');
    } else {
      this.shell?.kill(sig);
    }
  }

  stop(): void {
    this.shell?.kill();
    this.shell = null;
  }
}

// ── registry: one map of termId → Terminal per device ───────────────────────

const registry = new Map<string, Map<string, Terminal>>();

function shellsFor(deviceName: string): Map<string, Terminal> {
  let m = registry.get(deviceName);
  if (!m) {
    m = new Map();
    registry.set(deviceName, m);
  }
  return m;
}

function getOrCreate(
  deviceName: string,
  termId: string,
  push: PushFn,
): Terminal {
  const shells = shellsFor(deviceName);
  let t = shells.get(termId);
  if (!t) {
    t = new Terminal(termId, push);
    shells.set(termId, t);
  } else {
    t.setPush(push); // refresh push channel on reconnect
  }
  return t;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

function requireTermId(args: Record<string, unknown> | undefined): string {
  const id = str(args?.termId);
  if (!id) {
    throw new Error('missing termId');
  }
  return id;
}

// ── command handlers ────────────────────────────────────────────────────────

/** term.start — spawn (or reuse) a shell for termId. args.cwd optional. */
export const termStartHandler: CommandHandler = async (args, ctx) => {
  const termId = requireTermId(args);
  const t = getOrCreate(ctx.deviceName, termId, (k, d) => ctx.push?.(k, d));
  const info = t.start(str(args?.cwd));
  return {termId, running: true, cwd: info.cwd};
};

/** term.input — run a line in a specific shell. args.termId, args.line. */
export const termInputHandler: CommandHandler = async (args, ctx) => {
  const termId = requireTermId(args);
  const line = str(args?.line);
  if (line === undefined) {
    throw new Error('term.input requires a "line" arg');
  }
  // Free-tier daily cap: each command counts (Pro is unlimited). Throw before
  // running anything so the phone shows the paywall and nothing executes.
  if (!consume(ctx.deviceName, ctx.isPro)) {
    throw new LimitReachedError(FREE_DAILY_LIMIT);
  }
  const t = getOrCreate(ctx.deviceName, termId, (k, d) => ctx.push?.(k, d));
  if (!t.running) {
    t.start(str(args?.cwd));
  }
  t.input(line);
  const u = getUsage(ctx.deviceName);
  return {ok: true, usage: ctx.isPro ? null : u};
};

/** term.usage — current daily usage for this device (for the x/10 UI). */
export const termUsageHandler: CommandHandler = async (_args, ctx) => {
  return {pro: ctx.isPro, usage: ctx.isPro ? null : getUsage(ctx.deviceName)};
};

/** term.signal — send SIGINT (Ctrl-C) etc. to a shell. */
export const termSignalHandler: CommandHandler = async (args, ctx) => {
  const termId = requireTermId(args);
  shellsFor(ctx.deviceName)
    .get(termId)
    ?.signal((args?.signal as NodeJS.Signals) || 'SIGINT');
  return {ok: true};
};

/** term.keys — send raw keystrokes/bytes to a shell (arrows, Ctrl-seqs, etc.)
 *  without touching history. Lets the phone drive interactive TUIs. */
export const termKeysHandler: CommandHandler = async (args, ctx) => {
  const termId = requireTermId(args);
  const data = str(args?.data);
  if (data === undefined) {
    throw new Error('term.keys requires "data"');
  }
  shellsFor(ctx.deviceName).get(termId)?.writeRaw(data);
  return {ok: true};
};

/** term.resize — tell the PTY its new size so full-screen apps render right. */
export const termResizeHandler: CommandHandler = async (args, ctx) => {
  const termId = requireTermId(args);
  const cols = Math.max(1, Math.min(500, Number(args?.cols) || 120));
  const rows = Math.max(1, Math.min(300, Number(args?.rows) || 30));
  shellsFor(ctx.deviceName).get(termId)?.resize(cols, rows);
  return {ok: true, cols, rows};
};

/** term.stop — kill a specific shell. */
export const termStopHandler: CommandHandler = async (args, ctx) => {
  const termId = requireTermId(args);
  const shells = shellsFor(ctx.deviceName);
  shells.get(termId)?.stop();
  shells.delete(termId);
  return {ok: true};
};

/** term.history — recent PC-stored command history (shared across shells). */
export const termHistoryHandler: CommandHandler = async args => {
  const limit = Math.min(Math.max(Number(args?.limit) || 200, 1), MAX_HISTORY_LINES);
  await trimHistory();
  return {history: await loadHistory(limit)};
};

// ── profiles (persisted on the PC) ──────────────────────────────────────────

export interface Profile {
  id: string;
  label: string;
  command: string; // e.g. 'claude' or 'npm run dev'
  cwd?: string;
}

/** profiles.list — return saved profiles. */
export const profilesListHandler: CommandHandler = async () => {
  return {profiles: await loadProfiles()};
};

/** profiles.save — add/update a profile. args: {id?, label, command, cwd?}. */
export const profilesSaveHandler: CommandHandler = async args => {
  const label = str(args?.label);
  const command = str(args?.command);
  if (!label || !command) {
    throw new Error('profiles.save requires "label" and "command"');
  }
  const id = str(args?.id) ?? `p${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const profiles = await loadProfiles();
  const next: Profile = {id, label, command, cwd: str(args?.cwd)};
  const idx = profiles.findIndex(p => p.id === id);
  if (idx >= 0) {
    profiles[idx] = next;
  } else {
    profiles.push(next);
  }
  await saveProfiles(profiles);
  return {profile: next, profiles};
};

/** profiles.delete — remove a profile by id. */
export const profilesDeleteHandler: CommandHandler = async args => {
  const id = str(args?.id);
  if (!id) {
    throw new Error('profiles.delete requires "id"');
  }
  const profiles = (await loadProfiles()).filter(p => p.id !== id);
  await saveProfiles(profiles);
  return {profiles};
};

async function loadProfiles(): Promise<Profile[]> {
  try {
    const raw = await fsp.readFile(PROFILES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveProfiles(profiles: Profile[]): Promise<void> {
  mkdirSync(DIR, {recursive: true});
  await fsp.writeFile(PROFILES_FILE, JSON.stringify(profiles, null, 2));
}

// ── history helpers ─────────────────────────────────────────────────────────

function appendHistory(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  try {
    mkdirSync(DIR, {recursive: true});
    appendFileSync(HISTORY_FILE, `${Date.now()}\t${trimmed}\n`);
  } catch {
    /* best-effort */
  }
}

export async function loadHistory(limit = 200): Promise<string[]> {
  try {
    const raw = await fsp.readFile(HISTORY_FILE, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map(l => {
        const tab = l.indexOf('\t');
        return tab >= 0 ? l.slice(tab + 1) : l;
      })
      .slice(-limit);
  } catch {
    return [];
  }
}

export async function trimHistory(): Promise<void> {
  try {
    const raw = await fsp.readFile(HISTORY_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length > MAX_HISTORY_LINES) {
      await fsp.writeFile(HISTORY_FILE, lines.slice(-MAX_HISTORY_LINES).join('\n') + '\n');
    }
  } catch {
    /* ignore */
  }
}

/** Shell command for the PIPED fallback only (the PTY path spawns the shell
 *  directly). `/K` keeps cmd.exe alive so the session persists. */
function pipedShellCommand(): {cmd: string; args: string[]} {
  if (process.platform === 'win32') {
    return {cmd: process.env.COMSPEC || 'cmd.exe', args: ['/Q', '/K']};
  }
  const shell = process.env.SHELL || '/bin/bash';
  return {cmd: shell, args: ['-i']};
}

export const terminalCommands: Record<string, CommandHandler> = {
  'term.start': termStartHandler,
  'term.input': termInputHandler,
  'term.signal': termSignalHandler,
  'term.keys': termKeysHandler,
  'term.resize': termResizeHandler,
  'term.stop': termStopHandler,
  'term.usage': termUsageHandler,
  'term.history': termHistoryHandler,
  'profiles.list': profilesListHandler,
  'profiles.save': profilesSaveHandler,
  'profiles.delete': profilesDeleteHandler,
};
