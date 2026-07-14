/**
 * ADB-backed file operations on the connected Android device.
 *
 * Commands (all take optional `serial`):
 *   fs.list    → directory listing with type/size (args.path)
 *   fs.read    → file contents, base64 (args.path); text detected client-side
 *   fs.write   → write file from base64 content (args.path, args.contentBase64)
 *   fs.rename  → move/rename (args.from, args.to)
 *   fs.delete  → remove file or dir (args.path, args.recursive)
 *   fs.mkdir   → create directory (args.path)
 *
 * Reads/writes go through `adb exec-out`/`adb shell` with base64 so binary files
 * survive the text channel intact. Destructive ops (write/rename/delete) are
 * intended to be gated by a confirmation prompt in the mobile UI.
 *
 * PATH SAFETY: paths are validated to be absolute and free of shell
 * metacharacters before being interpolated into a shell command, so a crafted
 * path can't inject extra commands. This is defense-in-depth on top of ADB's
 * own device-side permissions.
 */

import {CommandHandler} from '../commands/router';
import {adb, requireDevice} from './adb';

const MAX_READ_BYTES = 10 * 1024 * 1024; // 10 MB guard for reads
const MAX_WRITE_BYTES = 10 * 1024 * 1024;

export interface FileEntry {
  name: string;
  type: 'file' | 'dir' | 'link' | 'other';
  size: number | null;
  path: string;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/**
 * Validate an absolute device path and return it safely single-quoted for use
 * in an `adb shell` command. Throws on anything that could break out of the
 * quotes or isn't an absolute path.
 */
export function shellQuotePath(path: string): string {
  if (!path.startsWith('/')) {
    throw new Error('Path must be absolute (start with "/").');
  }
  // A single quote can't appear inside a single-quoted shell string; if the
  // path contains one, close-escape-reopen. This makes ANY path injection-safe.
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Parse one line of `ls -lA` output into a FileEntry, or null for noise. */
export function parseLsLine(line: string, dir: string): FileEntry | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('total ')) {
    return null;
  }
  // Typical (ls -lA): "drwxr-xr-x 2 root root 4096 2024-01-01 00:00 name"
  //   [0]perms [1]links [2]owner [3]group [4]size [5]date [6]time [7…]name
  const parts = trimmed.split(/\s+/);
  if (parts.length < 8) {
    return null;
  }
  const perms = parts[0];
  // Name is everything from field 7 on, rejoined so names with spaces survive.
  let name = parts.slice(7).join(' ');
  let type: FileEntry['type'] = 'other';
  if (perms[0] === 'd') {
    type = 'dir';
  } else if (perms[0] === '-') {
    type = 'file';
  } else if (perms[0] === 'l') {
    type = 'link';
    // Symlinks render as "name -> target"; keep just the entry name.
    const arrow = name.indexOf(' -> ');
    if (arrow !== -1) {
      name = name.slice(0, arrow);
    }
  }
  if (!name || name === '.' || name === '..') {
    return null;
  }
  const size = Number(parts[4]);
  return {
    name,
    type,
    size: Number.isFinite(size) ? size : null,
    path: joinPath(dir, name),
  };
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** fs.list — directory listing with type + size. */
export const fsListHandler: CommandHandler = async args => {
  const path = str(args?.path) ?? '/sdcard';
  const serial = await requireDevice(str(args?.serial));
  // -L follows symlinks so listing a symlinked dir (e.g. /sdcard) shows its
  // target's contents rather than the single symlink line. The trailing "/."
  // (inside the quoting) forces directory-content listing even for a
  // symlink-to-dir.
  const q = shellQuotePath(path.replace(/\/+$/, '') + '/.');
  const out = await adb(['shell', `ls -lAL ${q}`], {serial});
  if (/No such file or directory/i.test(out)) {
    throw new Error(`No such directory: ${path}`);
  }
  if (/Permission denied/i.test(out)) {
    throw new Error(`Permission denied: ${path}`);
  }
  const entries = out
    .split('\n')
    .map(l => parseLsLine(l, path))
    .filter((e): e is FileEntry => e !== null)
    .sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (a.type !== 'dir' && b.type === 'dir') return 1;
      return a.name.localeCompare(b.name);
    });
  return {path, entries};
};

/** fs.read — file contents as base64 (binary-safe). */
export const fsReadHandler: CommandHandler = async args => {
  const path = str(args?.path);
  if (!path) {
    throw new Error('fs.read requires a "path" arg');
  }
  const serial = await requireDevice(str(args?.serial));
  const q = shellQuotePath(path);

  // Size guard first, so we don't try to slurp a huge/binary blob.
  const sizeOut = await adb(['shell', `stat -c %s ${q} 2>/dev/null || echo -1`], {
    serial,
  });
  const size = Number(sizeOut.trim());
  if (size > MAX_READ_BYTES) {
    throw new Error(
      `File too large to read (${size} bytes; limit ${MAX_READ_BYTES}).`,
    );
  }

  // base64 the file on-device so binary content survives the text channel.
  const b64 = (await adb(['shell', `base64 ${q}`], {serial}))
    .replace(/\s+/g, '');
  if (/No such file|Permission denied/i.test(b64)) {
    throw new Error(`Cannot read ${path}`);
  }
  return {path, size: size >= 0 ? size : null, contentBase64: b64};
};

/** fs.write — write file from base64 content. Destructive: confirm in UI. */
export const fsWriteHandler: CommandHandler = async args => {
  const path = str(args?.path);
  const contentBase64 = str(args?.contentBase64);
  if (!path || contentBase64 === undefined) {
    throw new Error('fs.write requires "path" and "contentBase64" args');
  }
  const approxBytes = Math.floor((contentBase64.length * 3) / 4);
  if (approxBytes > MAX_WRITE_BYTES) {
    throw new Error(
      `Content too large to write (${approxBytes} bytes; limit ${MAX_WRITE_BYTES}).`,
    );
  }
  const serial = await requireDevice(str(args?.serial));
  const q = shellQuotePath(path);

  // Decode on-device: pipe the base64 through `base64 -d` into the target.
  // The content is passed as stdin to avoid arg-length limits + injection.
  await adb(
    ['shell', `base64 -d > ${q}`],
    {serial, stdin: contentBase64 + '\n'},
  );
  return {path, bytesWritten: approxBytes, ok: true};
};

/** fs.rename — move/rename a path. Destructive: confirm in UI. */
export const fsRenameHandler: CommandHandler = async args => {
  const from = str(args?.from);
  const to = str(args?.to);
  if (!from || !to) {
    throw new Error('fs.rename requires "from" and "to" args');
  }
  const serial = await requireDevice(str(args?.serial));
  const out = await adb(
    ['shell', `mv ${shellQuotePath(from)} ${shellQuotePath(to)}`],
    {serial},
  );
  if (/No such file|Permission denied|cannot/i.test(out)) {
    throw new Error(out.trim() || `Cannot move ${from} → ${to}`);
  }
  return {from, to, ok: true};
};

/** fs.delete — remove a file or directory. Destructive: confirm in UI. */
export const fsDeleteHandler: CommandHandler = async args => {
  const path = str(args?.path);
  if (!path) {
    throw new Error('fs.delete requires a "path" arg');
  }
  const serial = await requireDevice(str(args?.serial));
  const flag = args?.recursive ? '-rf' : '-f';
  const out = await adb(['shell', `rm ${flag} ${shellQuotePath(path)}`], {
    serial,
  });
  if (/Permission denied|is a directory/i.test(out)) {
    throw new Error(out.trim() || `Cannot delete ${path}`);
  }
  return {path, ok: true};
};

/** fs.mkdir — create a directory (with parents). */
export const fsMkdirHandler: CommandHandler = async args => {
  const path = str(args?.path);
  if (!path) {
    throw new Error('fs.mkdir requires a "path" arg');
  }
  const serial = await requireDevice(str(args?.serial));
  const out = await adb(['shell', `mkdir -p ${shellQuotePath(path)}`], {serial});
  if (/Permission denied|cannot/i.test(out)) {
    throw new Error(out.trim() || `Cannot create ${path}`);
  }
  return {path, ok: true};
};

export const fileCommands: Record<string, CommandHandler> = {
  'fs.list': fsListHandler,
  'fs.read': fsReadHandler,
  'fs.write': fsWriteHandler,
  'fs.rename': fsRenameHandler,
  'fs.delete': fsDeleteHandler,
  'fs.mkdir': fsMkdirHandler,
};
