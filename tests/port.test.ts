/**
 * Port selection.
 *
 * The bug this guards against: our WS server binds 0.0.0.0, but the free-check
 * used to probe 127.0.0.1. On Windows a 127.0.0.1 bind succeeds even when
 * 0.0.0.0 already holds the port, so the probe wrongly reported "free" — then the
 * real 0.0.0.0 bind failed with EADDRINUSE and the app hung on "starting". The
 * probe must test the SAME address the server uses (0.0.0.0, exclusive).
 */

import {describe, it, expect, afterEach} from 'vitest';
import {createServer, Server} from 'net';
import {isLoopbackPortFree, pickFreePort} from '../src/transport/port';

const opened: Server[] = [];

/** Occupy a port on 0.0.0.0 — exactly how the WS server (or a leftover one) holds it. */
function holdPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    opened.push(srv);
    srv.once('error', reject);
    srv.listen({port, host: '0.0.0.0', exclusive: true}, () => resolve());
  });
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map(s => new Promise(r => s.close(() => r(null)))));
});

describe('isLoopbackPortFree', () => {
  it('is true for a port nobody holds', async () => {
    expect(await isLoopbackPortFree(45871)).toBe(true);
  });

  it('is false when another process already holds the port on 0.0.0.0', async () => {
    // The real failure mode: a leftover server on 0.0.0.0 (e.g. an old host).
    await holdPort(45872);
    expect(await isLoopbackPortFree(45872)).toBe(false);
  });
});

describe('pickFreePort', () => {
  it('returns the preferred port when it is free', async () => {
    // Bind a port to learn one that's definitely free, then release it, so we
    // don't hardcode a number another test/process might hold on the CI runner.
    const free = await pickFreePort(45873);
    expect(await pickFreePort(free)).toBe(free);
  });

  it('skips a squatted port and returns the next free one', async () => {
    // Find a genuinely-free base port first, hold it, then confirm pickFreePort
    // moves past it. Using a discovered port (not a hardcoded 45874) avoids the
    // flaky EADDRINUSE when a prior test's port hasn't fully released on Linux.
    const base = await pickFreePort(45900);
    await holdPort(base);
    const port = await pickFreePort(base);
    expect(port).toBeGreaterThan(base);
  });
});
