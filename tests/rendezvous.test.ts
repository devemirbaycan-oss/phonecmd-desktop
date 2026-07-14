/**
 * Tests for the rendezvous pieces: persistent identity (stable pcId across
 * restarts), the Rendezvous register client, and qrPayload endpoint override
 * (used when a tunnel URL rotates).
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {mkdtempSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {ready, generateKeyPair, toBase64} from '../src/crypto/e2e';
import {SessionManager} from '../src/pairing/session';
import {Rendezvous} from '../src/transport/rendezvous';

describe('persistent identity → stable pcId', () => {
  let home: string;
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'phonecmd-id-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home; // Windows homedir()
  });
  afterEach(() => {
    process.env.HOME = origHome;
    process.env.USERPROFILE = origUserProfile;
    rmSync(home, {recursive: true, force: true});
  });

  it('reuses the same keypair (pcId) across SessionManager instances', async () => {
    const router = {dispatch: async () => ({})} as any;
    const a = new SessionManager({endpoint: 'wss://x', router});
    await a.init();
    const id1 = a.pcId();

    // A fresh manager (simulating a host restart) must load the same identity.
    const b = new SessionManager({endpoint: 'wss://x', router});
    await b.init();
    const id2 = b.pcId();

    expect(id1).toBe(id2);
    // pcId is the base64 public key = the keycode's desktopPublicKey.
    expect(a.qrPayload().desktopPublicKey).toBe(id1);
  });
});

describe('qrPayload endpoint override', () => {
  it('swaps the endpoint (tunnel rotation) but keeps identity + code', async () => {
    const home = mkdtempSync(join(tmpdir(), 'phonecmd-id2-'));
    const origHome = process.env.HOME;
    const origUP = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const sm = new SessionManager({
        endpoint: 'wss://old.trycloudflare.com',
        lanEndpoint: 'ws://192.168.1.5:8787',
        router: {dispatch: async () => ({})} as any,
      });
      await sm.init();
      const base = sm.qrPayload();
      const rotated = sm.qrPayload('wss://new.trycloudflare.com');
      expect(rotated.endpoint).toBe('wss://new.trycloudflare.com');
      expect(rotated.lanEndpoint).toBe('ws://192.168.1.5:8787');
      expect(rotated.desktopPublicKey).toBe(base.desktopPublicKey);
      expect(rotated.pairingCode).toBe(base.pairingCode);
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origUP;
      rmSync(home, {recursive: true, force: true});
    }
  });
});

describe('Rendezvous register client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs pcId + endpoints to /pc/register', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({url, body: JSON.parse(init.body)});
      return {ok: true, status: 200} as any;
    }));

    const r = new Rendezvous({pcId: 'PUB', apiBase: 'https://api.test'});
    r.start('wss://tunnel', 'ws://192.168.1.5:8787');
    // start() fires register() synchronously (async); await a tick.
    await new Promise(res => setTimeout(res, 5));
    r.stop();

    expect(calls[0].url).toBe('https://api.test/pc/register');
    expect(calls[0].body).toEqual({
      pcId: 'PUB',
      endpoint: 'wss://tunnel',
      lanEndpoint: 'ws://192.168.1.5:8787',
    });
  });

  it('re-registers only when the endpoint actually changes', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body).endpoint);
      return {ok: true, status: 200} as any;
    }));
    const r = new Rendezvous({pcId: 'PUB', apiBase: 'https://api.test'});
    r.start('wss://a', null);
    await new Promise(res => setTimeout(res, 5));
    r.update('wss://a', null); // same → no new register
    await new Promise(res => setTimeout(res, 5));
    r.update('wss://b', null); // changed → re-register
    await new Promise(res => setTimeout(res, 5));
    r.stop();
    expect(bodies).toEqual(['wss://a', 'wss://b']);
  });

  it('never throws when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    const r = new Rendezvous({pcId: 'PUB', apiBase: 'https://api.test'});
    expect(() => r.start('wss://x', null)).not.toThrow();
    await new Promise(res => setTimeout(res, 5));
    r.stop();
  });
});
