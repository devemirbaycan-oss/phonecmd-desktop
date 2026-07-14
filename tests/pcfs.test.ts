/**
 * PC file manager tests. Path handling + a real read/write/list round-trip in a
 * temp directory (this exercises the actual Node fs handlers end to end).
 */

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import {promises as fs} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import {
  normalizePath,
  parentDir,
  listDrives,
  pcfsListHandler,
  pcfsReadHandler,
  pcfsWriteHandler,
  pcfsDeleteHandler,
} from '../src/pcfs/pcfs';

const ctx = {deviceName: 'test', isPro: false};

describe('normalizePath', () => {
  it('rejects relative/empty paths', () => {
    expect(() => normalizePath('')).toThrow(/absolute/);
    expect(() => normalizePath('foo/bar')).toThrow(/absolute/);
  });
  it('accepts an absolute path', () => {
    // Use a platform-appropriate absolute path.
    const p = process.platform === 'win32' ? 'C:\\Users' : '/usr';
    expect(normalizePath(p)).toBeTruthy();
  });
});

describe('parentDir', () => {
  it('returns null at a root', () => {
    if (process.platform === 'win32') {
      expect(parentDir('C:\\')).toBeNull();
    } else {
      expect(parentDir('/')).toBeNull();
    }
  });
  it('returns the parent of a nested path', () => {
    if (process.platform === 'win32') {
      expect(parentDir('C:\\Users\\EB')).toBe('C:\\Users');
    } else {
      expect(parentDir('/usr/local')).toBe('/usr');
    }
  });
});

describe('listDrives', () => {
  it('returns at least one root', async () => {
    const drives = await listDrives();
    expect(drives.length).toBeGreaterThan(0);
  });
});

describe('read / write / list round-trip (real fs)', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'pcfs-'));
    file = join(dir, 'hello.txt');
  });
  afterAll(async () => {
    await fs.rm(dir, {recursive: true, force: true});
  });

  it('writes then reads identical content (base64, binary-safe)', async () => {
    const text = 'Hello from PhoneCMD PC 👋\nsecond line';
    const contentBase64 = Buffer.from(text, 'utf8').toString('base64');

    const w = (await pcfsWriteHandler({path: file, contentBase64}, ctx)) as any;
    expect(w.ok).toBe(true);
    expect(w.bytesWritten).toBe(Buffer.byteLength(text, 'utf8'));

    const r = (await pcfsReadHandler({path: file}, ctx)) as any;
    expect(Buffer.from(r.contentBase64, 'base64').toString('utf8')).toBe(text);
  });

  it('lists the directory with the new file, dirs first', async () => {
    await fs.mkdir(join(dir, 'subdir'));
    const res = (await pcfsListHandler({path: dir}, ctx)) as any;
    const names = res.entries.map((e: any) => e.name);
    expect(names).toContain('hello.txt');
    expect(names).toContain('subdir');
    // subdir (dir) sorts before hello.txt (file)
    expect(names.indexOf('subdir')).toBeLessThan(names.indexOf('hello.txt'));
    const fileEntry = res.entries.find((e: any) => e.name === 'hello.txt');
    expect(fileEntry.type).toBe('file');
    expect(fileEntry.size).toBeGreaterThan(0);
  });

  it('read on a missing file gives a clear error', async () => {
    await expect(
      pcfsReadHandler({path: join(dir, 'nope.txt')}, ctx),
    ).rejects.toThrow(/No such file/);
  });

  it('delete removes a file', async () => {
    const victim = join(dir, 'victim.txt');
    await fs.writeFile(victim, 'x');
    const d = (await pcfsDeleteHandler({path: victim}, ctx)) as any;
    expect(d.ok).toBe(true);
    await expect(fs.access(victim)).rejects.toThrow();
  });
});
