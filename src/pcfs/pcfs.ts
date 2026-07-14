/**
 * PC file manager — read/edit/view files on THIS computer (the desktop host),
 * driven from the phone. Uses Node's fs directly (whole-disk access, per the
 * product decision), not ADB. This is a core PhoneCMD capability: the phone is
 * a remote control for the PC.
 *
 * Commands (all under the `pcfs.` namespace):
 *   pcfs.drives  → list drive roots (Windows) / ["/"] (posix)
 *   pcfs.list    → directory listing with type/size (args.path)
 *   pcfs.read    → file contents, base64 (args.path)
 *   pcfs.write   → write file from base64 (args.path, args.contentBase64)
 *   pcfs.rename  → move/rename (args.from, args.to)
 *   pcfs.delete  → remove file or dir (args.path, args.recursive)
 *   pcfs.mkdir   → create directory (args.path)
 *
 * Reads/writes use base64 so binary files survive the JSON channel. Files are
 * read/written via absolute paths. There is intentionally no root sandbox
 * (whole-disk access was chosen); path handling still normalizes and guards
 * against obviously malformed input.
 */

import {promises as fs} from 'fs';
import {join, parse, sep, isAbsolute, normalize} from 'path';
import {CommandHandler} from '../commands/router';

const MAX_READ_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_WRITE_BYTES = 20 * 1024 * 1024;

export interface PcFileEntry {
  name: string;
  type: 'file' | 'dir' | 'other';
  size: number | null;
  path: string;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/** Validate + normalize an absolute path. Throws on empty/relative input. */
export function normalizePath(p: string): string {
  if (!p || !isAbsolute(p)) {
    throw new Error(`Path must be absolute: ${p}`);
  }
  return normalize(p);
}

/** List drive roots on Windows (C:\, D:\ …); "/" on posix. Exported for tests. */
export async function listDrives(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return ['/'];
  }
  // Probe A:–Z:; a drive exists if we can stat its root.
  const roots: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:${sep}`;
    try {
      await fs.access(root);
      roots.push(root);
    } catch {
      /* not present */
    }
  }
  return roots;
}

/** pcfs.drives — list drive roots. */
export const pcfsDrivesHandler: CommandHandler = async () => {
  return {drives: await listDrives(), platform: process.platform};
};

/** pcfs.list — directory listing with type + size. Defaults to the home dir. */
export const pcfsListHandler: CommandHandler = async args => {
  const path = normalizePath(
    str(args?.path) ?? process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(),
  );
  let dirents;
  try {
    dirents = await fs.readdir(path, {withFileTypes: true});
  } catch (err) {
    throw new Error(readableFsError(err, path));
  }

  const entries: PcFileEntry[] = await Promise.all(
    dirents.map(async d => {
      const full = join(path, d.name);
      let type: PcFileEntry['type'] = 'other';
      let size: number | null = null;
      if (d.isDirectory()) {
        type = 'dir';
      } else if (d.isFile()) {
        type = 'file';
        try {
          size = (await fs.stat(full)).size;
        } catch {
          size = null;
        }
      }
      return {name: d.name, type, size, path: full};
    }),
  );

  entries.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name);
  });

  return {path, parent: parentDir(path), entries};
};

/** pcfs.read — file contents as base64 (binary-safe). */
export const pcfsReadHandler: CommandHandler = async args => {
  const path = normalizePath(str(args?.path) ?? '');
  let stat;
  try {
    stat = await fs.stat(path);
  } catch (err) {
    throw new Error(readableFsError(err, path));
  }
  if (stat.isDirectory()) {
    throw new Error(`${path} is a directory`);
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(
      `File too large to read (${stat.size} bytes; limit ${MAX_READ_BYTES}).`,
    );
  }
  const buf = await fs.readFile(path);
  return {path, size: stat.size, contentBase64: buf.toString('base64')};
};

/** pcfs.write — write a file from base64. Destructive: confirm in UI. */
export const pcfsWriteHandler: CommandHandler = async args => {
  const path = normalizePath(str(args?.path) ?? '');
  const contentBase64 = str(args?.contentBase64);
  if (contentBase64 === undefined) {
    throw new Error('pcfs.write requires "contentBase64"');
  }
  const buf = Buffer.from(contentBase64, 'base64');
  if (buf.length > MAX_WRITE_BYTES) {
    throw new Error(
      `Content too large to write (${buf.length} bytes; limit ${MAX_WRITE_BYTES}).`,
    );
  }
  await fs.writeFile(path, buf);
  return {path, bytesWritten: buf.length, ok: true};
};

/** pcfs.rename — move/rename. Destructive: confirm in UI. */
export const pcfsRenameHandler: CommandHandler = async args => {
  const from = normalizePath(str(args?.from) ?? '');
  const to = normalizePath(str(args?.to) ?? '');
  await fs.rename(from, to);
  return {from, to, ok: true};
};

/** pcfs.delete — remove a file or directory. Destructive: confirm in UI. */
export const pcfsDeleteHandler: CommandHandler = async args => {
  const path = normalizePath(str(args?.path) ?? '');
  const recursive = Boolean(args?.recursive);
  await fs.rm(path, {recursive, force: false});
  return {path, ok: true};
};

/** pcfs.mkdir — create a directory (with parents). */
export const pcfsMkdirHandler: CommandHandler = async args => {
  const path = normalizePath(str(args?.path) ?? '');
  await fs.mkdir(path, {recursive: true});
  return {path, ok: true};
};

// ── helpers ──────────────────────────────────────────────────────────────

/** Parent directory, or null at a drive/filesystem root. */
export function parentDir(path: string): string | null {
  const p = parse(path);
  if (p.dir === path || p.root === path || !p.dir) {
    return null; // already at a root (e.g. C:\ or /)
  }
  return p.dir;
}

function readableFsError(err: unknown, path: string): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return `No such file or directory: ${path}`;
  if (code === 'EACCES' || code === 'EPERM') return `Permission denied: ${path}`;
  if (code === 'ENOTDIR') return `Not a directory: ${path}`;
  return err instanceof Error ? err.message : String(err);
}

export const pcfsCommands: Record<string, CommandHandler> = {
  'pcfs.drives': pcfsDrivesHandler,
  'pcfs.list': pcfsListHandler,
  'pcfs.read': pcfsReadHandler,
  'pcfs.write': pcfsWriteHandler,
  'pcfs.rename': pcfsRenameHandler,
  'pcfs.delete': pcfsDeleteHandler,
  'pcfs.mkdir': pcfsMkdirHandler,
};
