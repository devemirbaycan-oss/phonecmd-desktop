/**
 * Pairing-expiry tests — the new configurable expiry behavior:
 *  - default = never expires (expiresAt null)
 *  - ttlFromChoice maps presets / raw ms / unknown correctly
 *  - a positive ttl produces a future expiresAt
 *  - an already-past ttl rejects a pair request
 */

import {describe, it, expect, beforeAll} from 'vitest';
import {EventEmitter} from 'events';
import {ready, generateKeyPair, toBase64, Sodium} from '../src/crypto/e2e';
import {
  SessionManager,
  ttlFromChoice,
  PAIRING_TTL_OPTIONS,
} from '../src/pairing/session';
import {CommandRouter, echoHandler} from '../src/commands/router';
import {PairRequest} from '../src/protocol';

let s: Sodium;
beforeAll(async () => {
  s = await ready();
});

describe('ttlFromChoice', () => {
  it('maps preset ids to ms', () => {
    expect(ttlFromChoice('never')).toBeNull();
    expect(ttlFromChoice('5m')).toBe(5 * 60_000);
    expect(ttlFromChoice('1d')).toBe(24 * 60 * 60_000);
    expect(ttlFromChoice('7d')).toBe(7 * 24 * 60 * 60_000);
  });
  it('accepts a raw ms number string', () => {
    expect(ttlFromChoice('120000')).toBe(120000);
  });
  it('treats undefined / unknown / non-positive as never (null)', () => {
    expect(ttlFromChoice(undefined)).toBeNull();
    expect(ttlFromChoice('bogus')).toBeNull();
    expect(ttlFromChoice('0')).toBeNull();
    expect(ttlFromChoice('-5')).toBeNull();
  });
  it('exposes a Never option first', () => {
    expect(PAIRING_TTL_OPTIONS[0]).toMatchObject({id: 'never', ms: null});
  });
});

async function makeManager(ttlMs?: number | null) {
  const mgr = new SessionManager({
    endpoint: 'ws://localhost:0',
    router: new CommandRouter().register('echo', echoHandler),
    approve: async () => true,
    ...(ttlMs === undefined ? {} : {ttlMs}),
  });
  await mgr.init();
  return mgr;
}

describe('SessionManager expiry', () => {
  it('never expires by default (expiresAt null)', async () => {
    const mgr = await makeManager(); // no ttl passed
    expect(mgr.qrPayload().expiresAt).toBeNull();
  });

  it('explicit null also means never', async () => {
    const mgr = await makeManager(null);
    expect(mgr.qrPayload().expiresAt).toBeNull();
  });

  it('a positive ttl sets a future expiresAt', async () => {
    const mgr = await makeManager(60_000);
    const exp = mgr.qrPayload().expiresAt;
    expect(exp).not.toBeNull();
    expect(new Date(exp!).getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects a pair request once the window has elapsed', async () => {
    const mgr = await makeManager(1); // 1ms window
    await new Promise(r => setTimeout(r, 5)); // let it elapse
    const sock = new FakeSocket();
    mgr.handleConnection(sock as any);
    const kp = generateKeyPair(s);
    sock.inject({
      type: 'pair',
      pairingCode: mgr.qrPayload().pairingCode,
      mobilePublicKey: toBase64(s, kp.publicKey),
      deviceName: 'Test',
    } as PairRequest);
    await new Promise(r => setTimeout(r, 10));
    expect(sock.lastMsg().type).toBe('pair_reject');
    expect(sock.lastMsg().reason).toMatch(/expired/i);
  });
});

// Minimal fake socket (mirrors session.test.ts).
class FakeSocket extends EventEmitter {
  outbound: string[] = [];
  send(data: string) {
    this.outbound.push(data);
  }
  close() {
    this.emit('close');
  }
  inject(obj: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(obj)));
  }
  lastMsg<T = any>(): T {
    return JSON.parse(this.outbound[this.outbound.length - 1]) as T;
  }
}
