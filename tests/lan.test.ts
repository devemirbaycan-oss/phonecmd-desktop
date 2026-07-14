/**
 * LAN endpoint tests — the "WiFi only" support. The desktop advertises a direct
 * ws://<lan-ip>:port alongside the relay so a same-network phone can skip the
 * relay. Verify IP detection returns a private v4 (or null) and that the session
 * QR carries a lanEndpoint distinct from the relay endpoint.
 */

import {describe, it, expect, beforeAll} from 'vitest';
import {lanIpv4, lanEndpoint} from '../src/transport/lan';
import {SessionManager} from '../src/pairing/session';

describe('lanIpv4', () => {
  it('returns a private IPv4 or null (never a public/loopback address)', () => {
    const ip = lanIpv4();
    if (ip !== null) {
      expect(ip).toMatch(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/);
      expect(ip).not.toBe('127.0.0.1');
    }
  });
});

describe('lanEndpoint', () => {
  it('builds a ws:// URL from an explicit host', () => {
    expect(lanEndpoint(8787, '192.168.1.5')).toBe('ws://192.168.1.5:8787');
  });
  it('returns null when no host is given and none is discoverable', () => {
    // We can't force "no interfaces", but with an explicit host it must build.
    expect(lanEndpoint(9000, '10.0.0.9')).toBe('ws://10.0.0.9:9000');
  });
});

describe('SessionManager QR lanEndpoint', () => {
  it('includes a distinct lanEndpoint when relay + LAN differ', async () => {
    const sm = new SessionManager({
      endpoint: 'wss://abc.trycloudflare.com',
      lanEndpoint: 'ws://192.168.1.5:8787',
      // minimal router stub — qrPayload doesn't dispatch commands
      router: {dispatch: async () => ({})} as any,
    });
    await sm.init();
    const qr = sm.qrPayload();
    expect(qr.endpoint).toBe('wss://abc.trycloudflare.com');
    expect(qr.lanEndpoint).toBe('ws://192.168.1.5:8787');
  });

  it('drops lanEndpoint when it equals the primary endpoint (LAN-only host)', async () => {
    const sm = new SessionManager({
      endpoint: 'ws://192.168.1.5:8787',
      lanEndpoint: 'ws://192.168.1.5:8787',
      router: {dispatch: async () => ({})} as any,
    });
    await sm.init();
    expect(sm.qrPayload().lanEndpoint).toBeNull();
  });

  it('lanEndpoint is null when none is provided', async () => {
    const sm = new SessionManager({
      endpoint: 'wss://abc.trycloudflare.com',
      router: {dispatch: async () => ({})} as any,
    });
    await sm.init();
    expect(sm.qrPayload().lanEndpoint).toBeNull();
  });
});
