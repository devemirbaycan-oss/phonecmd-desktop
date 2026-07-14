/**
 * File-op pure logic tests — path safety (injection) and ls parsing.
 */

import {describe, it, expect} from 'vitest';
import {shellQuotePath, parseLsLine} from '../src/adb/files';

describe('shellQuotePath', () => {
  it('single-quotes a normal absolute path', () => {
    expect(shellQuotePath('/sdcard/Download')).toBe(`'/sdcard/Download'`);
  });

  it('rejects a relative path', () => {
    expect(() => shellQuotePath('sdcard/x')).toThrow(/absolute/);
  });

  it('neutralizes an injection attempt with embedded quotes/semicolons', () => {
    // A path trying to break out and run `rm -rf /` must stay inside quotes.
    const evil = `/sdcard/'; rm -rf / #`;
    const quoted = shellQuotePath(evil);
    // Must start and end as a single-quoted string.
    expect(quoted.startsWith(`'`)).toBe(true);
    expect(quoted.endsWith(`'`)).toBe(true);
    // The one embedded single quote is escaped via the close-escape-reopen idiom
    // ('\''), so the shell never sees an unquoted metacharacter.
    expect(quoted).toBe(`'/sdcard/'\\''; rm -rf / #'`);
  });

  it('handles spaces in paths', () => {
    expect(shellQuotePath('/sdcard/My Files')).toBe(`'/sdcard/My Files'`);
  });
});

describe('parseLsLine', () => {
  const dir = '/sdcard';

  it('parses a directory entry', () => {
    const line = 'drwxrwx--x 2 root sdcard_rw 4096 2024-01-01 00:00 Download';
    expect(parseLsLine(line, dir)).toEqual({
      name: 'Download',
      type: 'dir',
      size: 4096,
      path: '/sdcard/Download',
    });
  });

  it('parses a file entry', () => {
    const line = '-rw-rw---- 1 root sdcard_rw 1234 2024-01-01 00:00 note.txt';
    expect(parseLsLine(line, dir)).toEqual({
      name: 'note.txt',
      type: 'file',
      size: 1234,
      path: '/sdcard/note.txt',
    });
  });

  it('parses a symlink and strips the "-> target" suffix', () => {
    const line = 'lrwxrwxrwx 1 root root 21 2024-01-01 00:00 sdcard';
    const e = parseLsLine(line, '/');
    expect(e?.type).toBe('link');
    expect(e?.name).toBe('sdcard');
  });

  it('strips the arrow target from a symlink name', () => {
    const line =
      'lrwxrwxrwx 1 root root 21 2024-01-01 00:00 sdcard -> /storage/self/primary';
    const e = parseLsLine(line, '/');
    expect(e?.name).toBe('sdcard');
    expect(e?.path).toBe('/sdcard');
  });

  it('handles names with spaces', () => {
    const line = '-rw-rw---- 1 root sdcard_rw 10 2024-01-01 00:00 My Photo.jpg';
    expect(parseLsLine(line, dir)?.name).toBe('My Photo.jpg');
  });

  it('skips total/blank/dot lines', () => {
    expect(parseLsLine('total 40', dir)).toBeNull();
    expect(parseLsLine('', dir)).toBeNull();
    expect(parseLsLine('   ', dir)).toBeNull();
  });

  it('joins paths without doubling the slash', () => {
    const line = '-rw-rw---- 1 root root 1 2024-01-01 00:00 x';
    expect(parseLsLine(line, '/sdcard/')?.path).toBe('/sdcard/x');
  });
});
