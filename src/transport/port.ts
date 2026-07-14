/**
 * Port selection for the local WS server.
 *
 * WHY THIS EXISTS — a subtle failure that silently breaks the tunnel:
 * our server binds 0.0.0.0 (so the LAN can reach it), but ANOTHER app can be
 * bound to 127.0.0.1 on the SAME port. Both binds "succeed" — they're different
 * addresses. cloudflared then forwards to `http://localhost:<port>`, which
 * resolves to 127.0.0.1, so the tunnel lands on the OTHER app and every request
 * 404s. The user sees "connection error" while our server looks perfectly healthy.
 *
 * So a free port here means free ON LOOPBACK — that's the address the tunnel
 * actually uses. We probe it and fall forward to the next free port if taken.
 */

import {createServer} from 'net';

/**
 * Can we actually bind this port the way the WS server will — on 0.0.0.0 with
 * exclusive ownership?
 *
 * The subtlety that bit us: our server binds 0.0.0.0, but the old check probed
 * 127.0.0.1. On Windows a 127.0.0.1 bind SUCCEEDS even when 0.0.0.0 already holds
 * the port (they're treated as distinct), so the probe reported "free", we
 * returned that port, and the real 0.0.0.0 bind then failed with EADDRINUSE —
 * leaving the app stuck on "starting". So probe the SAME address the server uses.
 *
 * `exclusive: true` also stops the probe itself from "sharing" a port that
 * another process holds, which is what makes the check trustworthy.
 */
export function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const srv = createServer();
    srv.once('error', () => resolve(false)); // EADDRINUSE → someone holds it
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen({port, host: '0.0.0.0', exclusive: true});
  });
}

/**
 * Return `preferred` if it's free on loopback, else the next free port after it.
 * Scans a small range so we don't wander far from the expected port.
 */
export async function pickFreePort(
  preferred: number,
  tries = 20,
): Promise<number> {
  for (let i = 0; i < tries; i++) {
    const port = preferred + i;
    if (await isLoopbackPortFree(port)) {
      return port;
    }
  }
  // Nothing free in range — hand back the preferred port and let the caller fail
  // loudly rather than silently binding somewhere unexpected.
  return preferred;
}
