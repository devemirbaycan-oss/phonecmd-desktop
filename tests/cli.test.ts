/**
 * CLI automation tests — the LocalClient (in-process command dispatch) and the
 * CLI's coding-CLI command builder. These prove a script can drive the host
 * without a WebSocket, encryption, or pairing.
 */

import {describe, it, expect} from 'vitest';
import {tmpdir} from 'os';
import {join} from 'path';
import {promises as fs} from 'fs';
import {LocalClient} from '../src/cli/localClient';
import {buildCliCommand, cliByName} from '../src/clis';

describe('LocalClient — in-process dispatch', () => {
  it('lists every host command', () => {
    const cmds = new LocalClient().commands();
    expect(cmds).toEqual(expect.arrayContaining(['echo', 'pcfs.list', 'term.input', 'clis.detect']));
  });

  it('dispatches a raw command (echo)', async () => {
    const c = new LocalClient();
    const {data} = await c.call('echo', {message: 'hi'});
    expect(data).toMatchObject({echo: 'hi', at: 'desktop'});
  });

  it('lists a real directory via pcfs.list', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'phonecmd-cli-'));
    await fs.writeFile(join(dir, 'a.txt'), 'x');
    await fs.mkdir(join(dir, 'sub'));
    const {data} = await new LocalClient().call('pcfs.list', {path: dir});
    const names = (data as {entries: {name: string}[]}).entries.map(e => e.name).sort();
    expect(names).toEqual(['a.txt', 'sub']);
    await fs.rm(dir, {recursive: true, force: true});
  });

  it('reads and writes a file (base64 round-trip)', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'phonecmd-cli-'));
    const path = join(dir, 'note.txt');
    await new LocalClient().call('pcfs.write', {
      path,
      contentBase64: Buffer.from('hello cli', 'utf8').toString('base64'),
    });
    const {data} = await new LocalClient().call('pcfs.read', {path});
    const text = Buffer.from((data as {contentBase64: string}).contentBase64, 'base64').toString('utf8');
    expect(text).toBe('hello cli');
    await fs.rm(dir, {recursive: true, force: true});
  });

  it('runs a shell command and captures its output', async () => {
    const c = new LocalClient();
    const out = await c.run('echo cli-run-marker', {idleMs: 400, maxMs: 15_000});
    await c.stop();
    expect(out).toContain('cli-run-marker');
  }, 20_000);

  it('is Pro by default so automation is not throttled by the free limit', async () => {
    const c = new LocalClient(); // isPro defaults true
    // Run more than the free daily limit; none should be blocked.
    for (let i = 0; i < 12; i++) {
      const {data} = await c.call('term.usage', {});
      expect((data as {pro: boolean}).pro).toBe(true);
    }
  });
});

describe('buildCliCommand', () => {
  it('builds a prompt invocation with the right flag per CLI', () => {
    expect(buildCliCommand('claude', 'fix build')).toBe('claude -p "fix build"');
    expect(buildCliCommand('codex', 'do it')).toBe('codex exec "do it"');
    expect(buildCliCommand('aider', 'change x')).toBe('aider "change x"');
  });

  it('resolves cursor by key or by its command name', () => {
    expect(cliByName('cursor')?.cmd).toBe('cursor-agent');
    expect(cliByName('cursor-agent')?.key).toBe('cursor');
    expect(buildCliCommand('cursor', 'go')).toBe('cursor-agent -p "go"');
  });

  it('launches interactively with an empty prompt', () => {
    expect(buildCliCommand('claude')).toBe('claude');
    expect(buildCliCommand('claude', '   ')).toBe('claude');
  });

  it('escapes quotes/backslashes in the prompt', () => {
    expect(buildCliCommand('claude', 'say "hi"')).toBe('claude -p "say \\"hi\\""');
  });

  it('returns null for an unknown CLI', () => {
    expect(buildCliCommand('nope', 'x')).toBeNull();
  });
});
