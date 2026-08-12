/**
 * CLI detection — checks which command-line tools are actually installed on the
 * PC, so the phone can mark uninstalled CLIs (Claude/Codex/Cursor/…) instead of
 * launching one that just errors with "not recognized".
 *
 * Uses `where` on Windows and `which` on posix. A command counts as installed if
 * the lookup exits 0 and prints a path.
 */

import {execFile} from 'child_process';
import {promises as fsp} from 'fs';
import {join} from 'path';
import {homedir} from 'os';
import {CommandHandler} from '../commands/router';

/** Read at most `maxBytes` from the start of a file as UTF-8. Used to parse the
 *  small header of a large transcript (cwd + first message) without loading the
 *  whole file — a long CLI conversation can be many MB. */
async function readHead(file: string, maxBytes: number): Promise<string> {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const {bytesRead} = await fh.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Resolve whether a single command name is on PATH. */
export function detectOne(cmd: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return new Promise(resolve => {
    execFile(finder, [cmd], {timeout: 5000, windowsHide: true}, (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

/**
 * clis.detect — args.commands: string[]. Returns { installed: {cmd: boolean} }.
 * Only the base command name is checked (e.g. "claude", "cursor-agent").
 */
export const clisDetectHandler: CommandHandler = async args => {
  const commands = Array.isArray(args?.commands)
    ? (args!.commands as unknown[]).filter(c => typeof c === 'string').map(String)
    : [];
  const installed: Record<string, boolean> = {};
  await Promise.all(
    commands.map(async cmd => {
      // Use just the first token (e.g. "cursor-agent" from "cursor-agent -p").
      const base = cmd.split(/\s+/)[0];
      installed[cmd] = await detectOne(base);
    }),
  );
  return {installed};
};

/** A resumable past conversation of a coding CLI. */
export interface CliSession {
  id: string; // the CLI's session id (passed to --resume)
  preview: string; // first user message, truncated — a human label
  mtime: number; // last-modified epoch ms, for "2h ago" + newest-first sort
}

/** Claude Code stores each conversation as
 *  ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl, where the FILENAME is the
 *  session id and the slug is the cwd with every non-alphanumeric char turned to
 *  '-'. We list those files for the given cwd so the phone can show a resume
 *  picker and reopen the exact one (claude --resume <id>) — never the global
 *  "most recent" (which could be a Claude running in VSCode). */
async function claudeSessions(cwd: string): Promise<CliSession[]> {
  // Claude's project-dir slug is the cwd with every non-alphanumeric char turned
  // to '-', and the drive letter lowercased. That exact rule is undocumented and
  // could shift between versions, so instead of reproducing it we compute a
  // normalized key (lowercased, non-alnum→'-') and match it against the actual
  // project dirs case-insensitively.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const wanted = norm(cwd);
  const projectsDir = join(homedir(), '.claude', 'projects');
  let dir: string;
  try {
    const dirs = await fsp.readdir(projectsDir);
    const match = dirs.find(d => norm(d) === wanted);
    if (!match) return [];
    dir = join(projectsDir, match);
  } catch {
    return [];
  }
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter(n => n.endsWith('.jsonl'));
  } catch {
    return []; // no sessions for this cwd (or Claude not used here)
  }
  const out: CliSession[] = [];
  for (const name of names) {
    const full = join(dir, name);
    const id = name.replace(/\.jsonl$/, '');
    try {
      const stat = await fsp.stat(full);
      const meta = await readSessionMeta(full);
      out.push({id, preview: meta.preview, mtime: stat.mtimeMs});
    } catch {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => b.mtime - a.mtime); // newest first
  return out;
}

/** Read the head of a Claude .jsonl transcript once, returning its first user
 *  message (a label) and the real cwd it recorded (Claude writes `cwd` on each
 *  line). The slug can't be reversed exactly, so this is how we get the true
 *  path to reopen the session in the right directory. */
async function readSessionMeta(file: string): Promise<{preview: string; cwd: string}> {
  // `cwd` and the first user message are always near the TOP of the transcript,
  // so read only a head chunk instead of the whole file — a long conversation can
  // be many MB, and reading them all made the projects browser take seconds.
  let content: string;
  try {
    content = await readHead(file, 256 * 1024);
  } catch {
    return {preview: '', cwd: ''};
  }
  let preview = '';
  let cwd = '';
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (!cwd && typeof obj?.cwd === 'string') cwd = obj.cwd;
      if (!preview && obj?.type === 'user') {
        const c = obj?.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((p: any) => p?.type === 'text')?.text : '';
        if (text) preview = String(text).replace(/\s+/g, ' ').slice(0, 80);
      }
      if (preview && cwd) break;
    } catch {
      /* malformed line — keep looking */
    }
  }
  return {preview, cwd};
}

/** A project folder Claude has sessions for, with its most-recent conversations. */
export interface CliProject {
  cwd: string; // the real working directory (from the transcript)
  label: string; // a short display name (last path segment)
  sessions: CliSession[]; // latest N, newest first
  mtime: number; // newest session's time, for sorting projects
}

/** Read one Claude project dir → its sessions (newest first, up to `limit`).
 *  Each session carries the real cwd from its transcript. */
async function claudeProjectSessions(dir: string, limit: number): Promise<{cwd: string; sessions: CliSession[]}> {
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter(n => n.endsWith('.jsonl'));
  } catch {
    return {cwd: '', sessions: []};
  }
  const stated: {name: string; mtime: number}[] = [];
  for (const name of names) {
    try {
      const st = await fsp.stat(join(dir, name));
      stated.push({name, mtime: st.mtimeMs});
    } catch {
      /* skip */
    }
  }
  stated.sort((a, b) => b.mtime - a.mtime); // newest first, so we only read the top N
  const top = stated.slice(0, limit);
  const sessions: CliSession[] = [];
  let cwd = '';
  for (const {name, mtime} of top) {
    const meta = await readSessionMeta(join(dir, name));
    if (!cwd && meta.cwd) cwd = meta.cwd;
    sessions.push({id: name.replace(/\.jsonl$/, ''), preview: meta.preview, mtime});
  }
  return {cwd, sessions};
}

// ── Codex ────────────────────────────────────────────────────────────────

/** A session with its cwd — the common shape we build both views from. */
interface SessionWithCwd extends CliSession {
  cwd: string;
}

/** Codex stores conversations under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
 *  The first line is a `session_meta` with payload.id (→ `codex resume <id>`) and
 *  payload.cwd. Sessions are organized by DATE not cwd, so we read them all once
 *  and group by cwd ourselves. `codex resume <UUID>` reopens a specific one. */
async function codexAllSessions(): Promise<SessionWithCwd[]> {
  const root = join(homedir(), '.codex', 'sessions');
  const files: {full: string; mtime: number}[] = [];
  // Walk YYYY/MM/DD.
  const walk = async (dir: string, depth: number) => {
    let entries: import('fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory() && depth < 3) await walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          files.push({full, mtime: (await fsp.stat(full)).mtimeMs});
        } catch {
          /* skip */
        }
      }
    }
  };
  await walk(root, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  const out: SessionWithCwd[] = [];
  // Cap the number we parse (newest first) so a huge history stays fast.
  for (const {full, mtime} of files.slice(0, 300)) {
    const meta = await readCodexMeta(full);
    if (meta.id) out.push({id: meta.id, cwd: meta.cwd, preview: meta.preview, mtime});
  }
  return out;
}

/** Parse a Codex rollout .jsonl: session id + cwd from `session_meta`, and the
 *  first REAL user message (skipping the env-context / instructions preamble). */
async function readCodexMeta(file: string): Promise<{id: string; cwd: string; preview: string}> {
  let content: string;
  try {
    content = await readHead(file, 256 * 1024); // header only — see readSessionMeta
  } catch {
    return {id: '', cwd: '', preview: ''};
  }
  let id = '';
  let cwd = '';
  let preview = '';
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const p = obj?.payload;
      if (obj?.type === 'session_meta' && p) {
        id = p.id ?? id;
        cwd = p.cwd ?? cwd;
      } else if (!preview && p?.type === 'message' && p?.role === 'user') {
        const text = Array.isArray(p.content) ? p.content.find((c: any) => c?.type === 'input_text')?.text : '';
        const t = String(text ?? '').replace(/\s+/g, ' ').trim();
        // Skip the injected environment/instructions preamble.
        if (t && !/^<(environment_context|user_instructions)|caveat/i.test(t)) {
          preview = t.slice(0, 80);
        }
      }
      if (id && cwd && preview) break;
    } catch {
      /* malformed line */
    }
  }
  return {id, cwd, preview};
}

// ── Copilot ──────────────────────────────────────────────────────────────

/** GitHub Copilot CLI stores each conversation under
 *  ~/.copilot/session-state/<uuid>/events.jsonl. The dir name is the session id
 *  (→ `copilot --resume <id>`). The first `session.start` event carries
 *  data.context.cwd; the first `user.message` event's data.content is the label. */
async function copilotAllSessions(): Promise<SessionWithCwd[]> {
  const root = join(homedir(), '.copilot', 'session-state');
  let entries: import('fs').Dirent[];
  try {
    entries = await fsp.readdir(root, {withFileTypes: true});
  } catch {
    return [];
  }
  const out: SessionWithCwd[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = join(root, e.name, 'events.jsonl');
    try {
      const mtime = (await fsp.stat(file)).mtimeMs;
      const meta = await readCopilotMeta(file);
      // Dir name IS the session id; trust it even if the file omits sessionId.
      out.push({id: meta.id || e.name, cwd: meta.cwd, preview: meta.preview, mtime});
    } catch {
      /* no events.jsonl / unreadable — skip */
    }
  }
  return out;
}

/** Parse a Copilot events.jsonl: session id + cwd from `session.start`, preview
 *  from the first `user.message`. */
async function readCopilotMeta(file: string): Promise<{id: string; cwd: string; preview: string}> {
  let content: string;
  try {
    content = await readHead(file, 256 * 1024); // header only — see readSessionMeta
  } catch {
    return {id: '', cwd: '', preview: ''};
  }
  let id = '';
  let cwd = '';
  let preview = '';
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const d = obj?.data;
      if (obj?.type === 'session.start' && d) {
        id = d.sessionId ?? id;
        cwd = d.context?.cwd ?? cwd;
      } else if (!preview && obj?.type === 'user.message' && d) {
        const t = String(d.content ?? '').replace(/\s+/g, ' ').trim();
        if (t) preview = t.slice(0, 80);
      }
      if (id && cwd && preview) break;
    } catch {
      /* malformed line */
    }
  }
  return {id, cwd, preview};
}

// ── Cursor ───────────────────────────────────────────────────────────────

// Minimal shape of node:sqlite's DatabaseSync (the installed @types/node predates
// node:sqlite, so we type it locally rather than import from 'node:sqlite').
interface SqliteStmt {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDb {
  prepare(sql: string): SqliteStmt;
  close(): void;
}
type SqliteCtor = new (path: string, opts?: {readOnly?: boolean}) => SqliteDb;

/** Cursor (agent) stores each chat as a SQLite DB at
 *  ~/.cursor/chats/<workspaceHash>/<chatId>/store.db. The dir name is the chat id
 *  (→ `agent --resume <id>`). `meta` holds {name, createdAt}; the conversation
 *  turns are JSON docs in the `blobs` table (keyed by content-hash, no order), so
 *  we scan them for the first user turn (preview) and the injected
 *  "Workspace Path: <cwd>" line (the real directory). Uses node:sqlite (built into
 *  Node 22) so no native dependency. */
async function cursorAllSessions(): Promise<SessionWithCwd[]> {
  // Lazy-require so a Node without node:sqlite (older) simply yields no Cursor
  // sessions instead of crashing the whole handler.
  let DatabaseSync: SqliteCtor;
  try {
    ({DatabaseSync} = require('node:sqlite'));
  } catch {
    return [];
  }
  const root = join(homedir(), '.cursor', 'chats');
  let wsDirs: import('fs').Dirent[];
  try {
    wsDirs = await fsp.readdir(root, {withFileTypes: true});
  } catch {
    return [];
  }
  const out: SessionWithCwd[] = [];
  for (const ws of wsDirs) {
    if (!ws.isDirectory()) continue;
    const wsPath = join(root, ws.name);
    let chats: import('fs').Dirent[];
    try {
      chats = await fsp.readdir(wsPath, {withFileTypes: true});
    } catch {
      continue;
    }
    for (const chat of chats) {
      if (!chat.isDirectory()) continue;
      const db = join(wsPath, chat.name, 'store.db');
      try {
        const mtime = (await fsp.stat(db)).mtimeMs;
        const meta = readCursorChat(DatabaseSync, db);
        out.push({
          id: chat.name,
          cwd: meta.cwd,
          preview: meta.preview || meta.name,
          mtime: meta.created || mtime,
        });
      } catch {
        /* no store.db / unreadable / encrypted — skip */
      }
    }
  }
  return out;
}

/** Read one Cursor store.db synchronously (node:sqlite is sync). Extracts the
 *  chat name + createdAt from `meta`, and the cwd + first user message from the
 *  JSON `blobs`. */
function readCursorChat(
  DatabaseSync: SqliteCtor,
  file: string,
): {name: string; cwd: string; preview: string; created: number} {
  const d = new DatabaseSync(file, {readOnly: true});
  let name = '';
  let cwd = '';
  let preview = '';
  let created = 0;
  try {
    const m = d.prepare('SELECT value FROM meta WHERE key = ?').get('0') as {value?: string} | undefined;
    if (m?.value) {
      // meta.value is hex-encoded JSON.
      const mj = JSON.parse(Buffer.from(m.value, 'hex').toString('utf8'));
      name = typeof mj?.name === 'string' ? mj.name : '';
      created = typeof mj?.createdAt === 'number' ? mj.createdAt : 0;
    }
  } catch {
    /* meta missing/encrypted */
  }
  try {
    const blobs = d.prepare('SELECT data FROM blobs').all() as {data: Uint8Array}[];
    for (const b of blobs) {
      let o: any;
      try {
        o = JSON.parse(Buffer.from(b.data).toString('utf8'));
      } catch {
        continue; // binary/encrypted blob — skip
      }
      const raw = cursorContentText(o);
      if (!cwd) cwd = extractCursorCwd(raw);
      if (!preview && o?.role === 'user') {
        const t = extractCursorUserQuery(raw);
        if (t) preview = t.slice(0, 80);
      }
      if (cwd && preview) break;
    }
  } catch {
    /* no blobs table */
  }
  d.close();
  return {name, cwd, preview, created};
}

function cursorContentText(o: any): string {
  if (typeof o?.content === 'string') return o.content;
  if (Array.isArray(o?.content)) return o.content.map((x: any) => x?.text ?? '').join(' ');
  return '';
}

/** Extract the real human prompt from a Cursor user message. Cursor prepends huge
 *  injected blocks (`<user_info>`, `<agent_transcripts>`, `<system_reminder>`,
 *  `<user_rules>`/`<rules>`, …) to the first turn and wraps the ACTUAL typed
 *  message in a `<user_query>` tag. The injected-context blobs have no
 *  `<user_query>`, and stripping their nested/unclosed tags reliably still leaks
 *  ("Agent transcripts …", "The rules section …"). So we trust ONLY `<user_query>`
 *  and return '' otherwise — the caller then keeps scanning for the blob that has
 *  it. If a message carries no injected tags at all (a bare prompt), we accept it
 *  as-is. */
function extractCursorUserQuery(raw: string): string {
  const q = raw.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  if (q && q[1].trim()) return q[1].replace(/\s+/g, ' ').trim();
  // A message with any injected block but no <user_query> is pure context — skip
  // it (stripping nested tags leaks). A message with NO tags is a bare prompt.
  if (/<(user_info|agent_transcripts|system_reminder|user_rules|rules|additional_data)\b/i.test(raw)) {
    return '';
  }
  const t = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return t;
}

/** Pull the workspace path out of Cursor's injected "Workspace Path: <cwd>" line.
 *  Cursor stores it with DOUBLED backslashes (C:\\Users\\EB), so we accept either
 *  form and collapse to single. */
function extractCursorCwd(raw: string): string {
  const m = raw.match(/Workspace Path:\s*([A-Za-z]:(?:\\{1,2}[^\r\n\\]+)+)/);
  if (!m) return '';
  return m[1].replace(/\\{2}/g, '\\').trim();
}

// ── Antigravity ──────────────────────────────────────────────────────────

/** Antigravity (`agy`) keeps a clean summary index at
 *  ~/.gemini/antigravity-cli/conversation_summaries.db — one row per conversation
 *  with conversation_id (→ `agy --conversation <id>`), a `preview`/`title`,
 *  `workspace_uris` (a JSON array of file:// URIs → the cwd) and
 *  `last_modified_time`. The full transcripts (conversations/<id>.db) are protobuf
 *  and we DON'T parse them, but this summary table is all we need to list + resume.
 *  Uses node:sqlite (built into Node 22). */
async function antigravityAllSessions(): Promise<SessionWithCwd[]> {
  let DatabaseSync: SqliteCtor;
  try {
    ({DatabaseSync} = require('node:sqlite'));
  } catch {
    return [];
  }
  const file = join(homedir(), '.gemini', 'antigravity-cli', 'conversation_summaries.db');
  try {
    await fsp.access(file);
  } catch {
    return []; // Antigravity not used here
  }
  const out: SessionWithCwd[] = [];
  try {
    const d = new DatabaseSync(file, {readOnly: true});
    const rows = d
      .prepare(
        'SELECT conversation_id, title, preview, workspace_uris, last_modified_time FROM conversation_summaries',
      )
      .all() as {
      conversation_id?: string;
      title?: string;
      preview?: string;
      workspace_uris?: string;
      last_modified_time?: string;
    }[];
    for (const r of rows) {
      if (!r.conversation_id) continue;
      const preview = (r.preview || r.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      out.push({
        id: r.conversation_id,
        cwd: firstWorkspaceUriToPath(r.workspace_uris),
        preview,
        mtime: parseSqliteTime(r.last_modified_time),
      });
    }
    d.close();
  } catch {
    /* schema drift / unreadable */
  }
  return out;
}

/** First entry of a `workspace_uris` JSON array (`["file:///C:/Users/EB"]`) →
 *  a native path (`C:\Users\EB`). '' if absent/unparseable. */
function firstWorkspaceUriToPath(json: string | undefined): string {
  if (!json) return '';
  try {
    const arr = JSON.parse(json);
    const uri = Array.isArray(arr) ? arr[0] : undefined;
    if (typeof uri !== 'string') return '';
    let p = uri.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
    p = decodeURIComponent(p);
    // On Windows, forward-slash file URIs → backslashes.
    return process.platform === 'win32' ? p.replace(/\//g, '\\') : '/' + p.replace(/^\/+/, '');
  } catch {
    return '';
  }
}

/** Parse a SQLite datetime ("2026-07-27 22:47:26.906+00:00") → epoch ms (0 on
 *  failure so the row still lists, just sorts last). */
function parseSqliteTime(s: string | undefined): number {
  if (!s) return 0;
  const t = Date.parse(s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : 0;
}

// ── generic dispatch ───────────────────────────────────────────────────────

/** Every resumable session for a CLI, each tagged with its cwd. Per-CLI storage. */
async function allSessionsWithCwd(cli: string): Promise<SessionWithCwd[]> {
  if (cli === 'codex') return codexAllSessions();
  if (cli === 'copilot') return copilotAllSessions();
  if (cli === 'cursor') return cursorAllSessions();
  if (cli === 'antigravity') return antigravityAllSessions();
  if (cli === 'claude') {
    // Claude is already grouped by cwd-dir; flatten across dirs. Read the dirs in
    // PARALLEL — reading them one-at-a-time made the "Other projects" browser take
    // several seconds on a large history (each dir stats + reads up to N files).
    const projectsDir = join(homedir(), '.claude', 'projects');
    let dirs: string[];
    try {
      dirs = await fsp.readdir(projectsDir);
    } catch {
      return [];
    }
    const perDir = await Promise.all(
      dirs.map(d => claudeProjectSessions(join(projectsDir, d), 10).then(r => ({...r, dir: d}))),
    );
    const out: SessionWithCwd[] = [];
    for (const {cwd, sessions, dir} of perDir) {
      for (const s of sessions) out.push({...s, cwd: cwd || dir});
    }
    return out;
  }
  return [];
}

/** clis.sessions — a CLI's resumable conversations for a specific cwd. */
export const clisSessionsHandler: CommandHandler = async args => {
  const cli = typeof args?.cli === 'string' ? args.cli : '';
  const cwd = typeof args?.cwd === 'string' && args.cwd ? args.cwd : homedir();
  // Claude has a direct per-cwd lookup; others filter the full list by cwd.
  if (cli === 'claude') return {sessions: await claudeSessions(cwd)};
  const norm = (s: string) => s.toLowerCase().replace(/[\\/]+$/, '');
  const all = await allSessionsWithCwd(cli);
  const sessions = all
    .filter(s => norm(s.cwd) === norm(cwd))
    .sort((a, b) => b.mtime - a.mtime)
    .map(({cwd: _c, ...s}) => s);
  return {sessions};
};

/** clis.projects — ALL of a CLI's project folders, each with its latest few
 *  sessions, so the phone can browse conversations across the whole PC. */
export const clisProjectsHandler: CommandHandler = async args => {
  const cli = typeof args?.cli === 'string' ? args.cli : '';
  const perProject = Math.min(Math.max(Number(args?.perProject) || 3, 1), 10);

  const all = await allSessionsWithCwd(cli);
  // Group by cwd.
  const byCwd = new Map<string, SessionWithCwd[]>();
  for (const s of all) {
    const key = s.cwd || '(unknown)';
    (byCwd.get(key) ?? byCwd.set(key, []).get(key)!).push(s);
  }
  const projects: CliProject[] = [];
  for (const [cwd, list] of byCwd) {
    list.sort((a, b) => b.mtime - a.mtime);
    const sessions = list.slice(0, perProject).map(({cwd: _c, ...s}) => s);
    const label = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
    projects.push({cwd, label, sessions, mtime: sessions[0].mtime});
  }
  projects.sort((a, b) => b.mtime - a.mtime);
  return {projects};
};

export const cliDetectCommands: Record<string, CommandHandler> = {
  'clis.detect': clisDetectHandler,
  'clis.sessions': clisSessionsHandler,
  'clis.projects': clisProjectsHandler,
};
