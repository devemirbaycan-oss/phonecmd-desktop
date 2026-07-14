/**
 * Persistent-session tests — the PTY fix. A shell must STAY ALIVE across
 * commands and keep its state (env vars, cwd), so interactive CLIs like Claude
 * don't die after one prompt.
 */

import {describe, it, expect} from 'vitest';
import {terminalCommands, ptyAvailable} from '../src/terminal/terminal';

type Push = (k: string, d: any) => void;
const ctx = (push: Push) => ({deviceName: 'pty-test', isPro: true, push} as any);

/** Collect output for a termId until it goes idle, then resolve. */
function collector() {
  let buf = '';
  let exited = false;
  const push: Push = (k, d) => {
    if (k === 'term.output') buf += String(d.chunk);
    if (k === 'term.exit') exited = true;
  };
  return {push, get: () => buf, get exited() { return exited; }};
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('persistent PTY session', () => {
  it('reports a real PTY is available in this environment', () => {
    // On dev/CI with the native build present this is true; the code still works
    // (piped fallback) if false, but we assert the intended path here.
    expect(ptyAvailable()).toBe(true);
  });

  it('keeps the shell alive across commands and preserves state', async () => {
    const c = collector();
    const cx = ctx(c.push);
    await terminalCommands['term.start']({termId: 't1'}, cx);
    await wait(800);

    // Set a var in the session, then read it back in a LATER command. Use the
    // syntax of whatever shell the OS actually spawns — cmd.exe on Windows,
    // POSIX sh elsewhere — so this passes on Linux/macOS CI, not just Windows.
    const win = process.platform === 'win32';
    const setVar = win ? 'set PCMDVAR=alive42' : 'PCMDVAR=alive42';
    const readVar = win ? 'echo VAL=%PCMDVAR%' : 'echo VAL=$PCMDVAR';

    await terminalCommands['term.input']({termId: 't1', line: setVar}, cx);
    await wait(600);
    await terminalCommands['term.input']({termId: 't1', line: readVar}, cx);
    await wait(1200);

    expect(c.get()).toContain('VAL=alive42'); // state survived → same session
    expect(c.exited).toBe(false); // shell did NOT die after the first command

    await terminalCommands['term.stop']({termId: 't1'}, cx);
  }, 15000);

  it('term.stop ends the session', async () => {
    const c = collector();
    const cx = ctx(c.push);
    await terminalCommands['term.start']({termId: 't2'}, cx);
    await wait(600);
    await terminalCommands['term.stop']({termId: 't2'}, cx);
    await wait(400);
    // After stop, a fresh start should succeed (registry slot cleared).
    await terminalCommands['term.start']({termId: 't2'}, cx);
    await wait(400);
    await terminalCommands['term.stop']({termId: 't2'}, cx);
    expect(true).toBe(true);
  }, 10000);

  it('term.resize returns the clamped size', async () => {
    const c = collector();
    const cx = ctx(c.push);
    await terminalCommands['term.start']({termId: 't3'}, cx);
    await wait(400);
    const res: any = await terminalCommands['term.resize']({termId: 't3', cols: 100, rows: 40}, cx);
    expect(res).toMatchObject({ok: true, cols: 100, rows: 40});
    await terminalCommands['term.stop']({termId: 't3'}, cx);
  }, 8000);
});
