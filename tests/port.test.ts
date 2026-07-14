/**
 * Loopback port selection.
 *
 * The bug this guards against: our WS server binds 0.0.0.0 while ANOTHER app
 * holds 127.0.0.1 on the same port. Both binds succeed, but cloudflared forwards
 * to localhost → the tunnel lands on the other app and every request 404s. So
 * "free" must mean free on LOOPBACK, which is what the tunnel actually dials.
 */

import {describe, it, expect, afterEach} from 'vitest';
import {createServer, Server} from 'net';
import {isLoopbackPortFree, pickFreePort} from '../src/transport/port';

const opened: Server[] = [];

/** Occupy a port on 127.0.0.1 only (mimics the squatting app). */
function holdLoopback(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    opened.push(srv);
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve());
  });
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map(s => new Promise(r => s.close(() => r(null)))));
});

describe('isLoopbackPortFree', () => {
  it('is true for a port nobody holds', async () => {
    expect(await isLoopbackPortFree(45871)).toBe(true);
  });

  it('is false when another process holds it on 127.0.0.1', async () => {
    await holdLoopback(45872);
    expect(await isLoopbackPortFree(45872)).toBe(false);
  });
});

describe('pickFreePort', () => {
  it('returns the preferred port when it is free', async () => {
    expect(await pickFreePort(45873)).toBe(45873);
  });

  it('skips a loopback-squatted port and returns the next free one', async () => {
    await holdLoopback(45874);
    // 45874 is taken on loopback → must move on rather than silently colliding.
    const port = await pickFreePort(45874);
    expect(port).toBeGreaterThan(45874);
  });
});
