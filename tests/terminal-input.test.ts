/**
 * term.input submit-CR test — the "Codex doesn't respond" fix.
 *
 * Full-screen TUIs (Codex, Claude Code) run with bracketed-paste + a burst
 * heuristic: a line of text arriving WITH its trailing CR in one write is read
 * as pasted content, so the CR becomes a newline in the composer and the
 * message never submits. Terminal.input() must therefore write the text and the
 * submit-CR as SEPARATE events, with the CR deferred so the PTY delivers it in
 * a distinct read. This test observes the injected backend's writes to prove
 * that split — no real shell needed, so it runs in CI.
 */

import {describe, it, expect} from 'vitest';
import {Terminal, ShellBackend} from '../src/terminal/terminal';

/** A fake backend that records every write with a coarse timestamp order. */
function fakeShell() {
  const writes: string[] = [];
  const backend: ShellBackend = {
    write: d => {
      writes.push(d);
    },
    resize: () => {},
    kill: () => {},
    onData: () => {},
    onExit: () => {},
  };
  return {backend, writes};
}

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('Terminal.input — submit CR handling', () => {
  it('writes the text first, then the CR as a SEPARATE deferred write', async () => {
    const {backend, writes} = fakeShell();
    const t = new Terminal('t1', () => {}, () => backend);
    t.start();

    t.input('say hello');

    // Immediately after input(): the text is out, but the CR is deferred.
    expect(writes).toEqual(['say hello']);

    // After the defer window (> ENTER_DELAY_MS): the standalone CR has landed
    // as its own write.
    await tick(200);
    expect(writes).toEqual(['say hello', '\r']);
  });

  it('strips a caller-supplied trailing newline and still sends one CR', async () => {
    const {backend, writes} = fakeShell();
    const t = new Terminal('t2', () => {}, () => backend);
    t.start();

    t.input('echo hi\r'); // caller already appended a CR
    await tick(200);

    // Text without the trailing CR, then exactly one standalone CR.
    expect(writes).toEqual(['echo hi', '\r']);
  });

  it('an empty line just submits (bare CR), no empty text write', async () => {
    const {backend, writes} = fakeShell();
    const t = new Terminal('t3', () => {}, () => backend);
    t.start();

    t.input('');
    await tick(200);

    expect(writes).toEqual(['\r']);
  });
});
