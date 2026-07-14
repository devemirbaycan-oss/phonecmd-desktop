/**
 * When the tunnel can't open (offline, or Cloudflare 429-rate-limiting the
 * account-less quick-tunnel endpoint), the host must NOT hang on "tunneling"
 * forever. It should fall back to LAN-direct so pairing still works on the same
 * network, and keep the door open for the tunnel to come back in the background.
 *
 * Regression: a real user hit this — the app sat on "opening tunnel…" with a
 * broken QR because `await tunnel.start()` threw and nothing caught it.
 */

import {describe, it, expect, beforeAll, afterEach} from 'vitest';
import {writeFileSync, chmodSync, mkdtempSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {HostCore} from '../src/core/host';

// A "cloudflared" that always exits 1 without printing a URL — exactly the
// shape of a 429/offline failure.
let failingBin: string;

beforeAll(() => {
  // Don't hit the real rendezvous API from a unit test.
  process.env.PHONECMD_NO_RENDEZVOUS = '1';
  const dir = mkdtempSync(join(tmpdir(), 'cf-fail-'));
  if (process.platform === 'win32') {
    failingBin = join(dir, 'cloudflared.cmd');
    writeFileSync(failingBin, '@echo tunnel error 1>&2\r\n@exit /b 1\r\n');
  } else {
    failingBin = join(dir, 'cloudflared.sh');
    writeFileSync(failingBin, '#!/bin/sh\necho "tunnel error" >&2\nexit 1\n');
    chmodSync(failingBin, 0o755);
  }
});

const hosts: HostCore[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.stop();
});

describe('tunnel failure → LAN fallback', () => {
  it('start() resolves (does not hang/throw) when cloudflared fails', async () => {
    const host = new HostCore({
      port: 0, // any free port
      cloudflaredBin: failingBin, // force the failure path
      lanHost: '192.168.1.50', // deterministic LAN endpoint for the assert
    });
    hosts.push(host);

    const statuses: string[] = [];
    host.on('status', s => statuses.push(s));

    // The bug was that this promise never settled. A tight timeout makes a
    // regression fail loudly instead of hanging the suite.
    const qr = await Promise.race([
      host.start(),
      new Promise((_r, rej) => setTimeout(() => rej(new Error('start() hung')), 8000)),
    ]);

    // It came up, and on the LAN endpoint — not a dead trycloudflare URL.
    expect(qr).toBeTruthy();
    expect((qr as {endpoint: string}).endpoint).toContain('192.168.1.50');
    expect((qr as {endpoint: string}).endpoint).not.toContain('trycloudflare');

    // It reached 'ready' (the UI unblocks) rather than getting stuck 'tunneling'.
    expect(statuses).toContain('tunneling'); // it tried
    expect(statuses).toContain('ready'); // …then recovered
  }, 12000);
});
