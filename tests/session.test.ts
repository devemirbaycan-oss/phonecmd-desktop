/**
 * Session handshake integration test — drives SessionManager through a fake
 * in-memory WebSocket, playing the role of the mobile client. Verifies the real
 * pairing → key-derivation → encrypted-command flow with no network or device.
 *
 * This is the desktop-side twin of the interop the mobile app relies on.
 */

import {describe, it, expect, beforeAll} from 'vitest';
import {EventEmitter} from 'events';
import {
  ready,
  generateKeyPair,
  seal,
  open,
  toBase64,
  fromBase64,
  Sodium,
} from '../src/crypto/e2e';
import {SessionManager} from '../src/pairing/session';
import {CommandRouter, echoHandler} from '../src/commands/router';
import {
  QrPayload,
  PairRequest,
  Envelope,
  CommandRequest,
  CommandResponse,
} from '../src/protocol';

/**
 * Minimal fake WebSocket: what the desktop's session code sends via ws.send()
 * shows up as 'outbound' here; test code injects inbound frames via .inject().
 * Shaped just enough for SessionManager (on('message'|'close'), send()).
 */
class FakeSocket extends EventEmitter {
  outbound: string[] = [];
  send(data: string) {
    this.outbound.push(data);
  }
  close() {
    this.emit('close');
  }
  /** simulate a frame arriving from the client */
  inject(obj: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(obj)));
  }
  lastMsg<T = any>(): T {
    return JSON.parse(this.outbound[this.outbound.length - 1]) as T;
  }
}

let s: Sodium;
beforeAll(async () => {
  s = await ready();
});

async function makeHost(approve: (r: PairRequest) => Promise<boolean>) {
  const router = new CommandRouter().register('echo', echoHandler);
  const mgr = new SessionManager({
    endpoint: 'ws://localhost:0',
    router,
    approve,
    ttlMs: 60_000,
  });
  await mgr.init();
  return mgr;
}

/** Play the mobile client against a fake socket; returns helpers. */
function makeClient(qr: QrPayload) {
  const kp = generateKeyPair(s);
  const desktopPub = fromBase64(s, qr.desktopPublicKey);
  return {
    pairRequest(deviceName = 'Test Phone'): PairRequest {
      return {
        type: 'pair',
        pairingCode: qr.pairingCode,
        mobilePublicKey: toBase64(s, kp.publicKey),
        deviceName,
      };
    },
    encrypt(req: CommandRequest): Envelope {
      const {nonce, ciphertext} = seal(
        s,
        kp.privateKey,
        desktopPub,
        JSON.stringify(req),
      );
      return {type: 'enc', nonce, ciphertext};
    },
    decrypt(env: Envelope): CommandResponse {
      return JSON.parse(open(s, kp.privateKey, desktopPub, env.nonce, env.ciphertext));
    },
  };
}

describe('SessionManager handshake', () => {
  it('pairs, grants a token, and serves an encrypted command', async () => {
    const mgr = await makeHost(async () => true);
    const qr = mgr.qrPayload();
    const sock = new FakeSocket();
    mgr.handleConnection(sock as any);
    const client = makeClient(qr);

    // 1. Send pair request.
    sock.inject(client.pairRequest());
    await tick();

    // Expect a pair_accept then an encrypted token grant.
    const accept = JSON.parse(sock.outbound[0]);
    expect(accept.type).toBe('pair_accept');

    const grantEnv = JSON.parse(sock.outbound[1]) as Envelope;
    const grant = client.decrypt(grantEnv);
    expect(grant.sessionToken).toBeTruthy();
    const token = grant.sessionToken!;

    // 2. Send an encrypted echo command carrying the token.
    sock.inject(
      client.encrypt({
        id: 'e1',
        command: 'echo',
        args: {message: 'ping'},
        sessionToken: token,
      }),
    );
    await tick();

    const res = client.decrypt(sock.lastMsg<Envelope>());
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({echo: 'ping', at: 'desktop'});
  });

  it('rejects a wrong pairing code', async () => {
    const mgr = await makeHost(async () => true);
    const qr = mgr.qrPayload();
    const sock = new FakeSocket();
    mgr.handleConnection(sock as any);
    const client = makeClient(qr);

    sock.inject({...client.pairRequest(), pairingCode: '000000'});
    await tick();

    expect(sock.lastMsg().type).toBe('pair_reject');
  });

  it('rejects when the approver denies', async () => {
    const mgr = await makeHost(async () => false);
    const qr = mgr.qrPayload();
    const sock = new FakeSocket();
    mgr.handleConnection(sock as any);
    const client = makeClient(qr);

    sock.inject(client.pairRequest());
    await tick();

    const msg = sock.lastMsg();
    expect(msg.type).toBe('pair_reject');
    expect(msg.reason).toMatch(/rejected/i);
  });

  it('refuses a command bearing an invalid session token', async () => {
    const mgr = await makeHost(async () => true);
    const qr = mgr.qrPayload();
    const sock = new FakeSocket();
    mgr.handleConnection(sock as any);
    const client = makeClient(qr);

    sock.inject(client.pairRequest());
    await tick();

    sock.inject(
      client.encrypt({
        id: 'e1',
        command: 'echo',
        args: {message: 'x'},
        sessionToken: 'forged-token',
      }),
    );
    await tick();

    const res = client.decrypt(sock.lastMsg<Envelope>());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid session token/);
  });
});

/** let queued promise microtasks (async approve + seal) settle */
function tick() {
  return new Promise(r => setTimeout(r, 10));
}
