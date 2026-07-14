/**
 * A restart must not orphan a paired phone.
 *
 * The bug: the pairing CODE is regenerated on every host start, and the host kept
 * no record of which phones it had approved. So a phone that paired yesterday
 * presented yesterday's code, got `invalid pairing code`, and the user saw a
 * generic connection failure — every restart silently broke every saved PC.
 *
 * The fix: remember approved devices by public key. A KNOWN device reconnects on
 * the strength of that key. A NEW device still needs the current code AND human
 * approval — the tests below pin that down, because a fix that let anyone in
 * would be far worse than the bug.
 */

import {describe, it, expect, beforeAll, beforeEach, afterAll} from 'vitest';
import {EventEmitter} from 'events';
import {mkdtempSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {ready, generateKeyPair, toBase64, Sodium} from '../src/crypto/e2e';
import {SessionManager} from '../src/pairing/session';
import {CommandRouter, echoHandler} from '../src/commands/router';
import {PairRequest} from '../src/protocol';
import {loadKnownDevices, forgetDevice, forgetAllDevices} from '../src/pairing/devices';

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

let s: Sodium;
let home: string;

beforeAll(async () => {
  s = await ready();
  // Redirect the device store at a temp dir — a test run must never touch the
  // real ~/.phonecmd/devices.json.
  home = mkdtempSync(join(tmpdir(), 'phonecmd-test-'));
  process.env.PHONECMD_HOME = home;
});

afterAll(() => {
  delete process.env.PHONECMD_HOME;
  rmSync(home, {recursive: true, force: true});
});

beforeEach(async () => {
  await forgetAllDevices();
});

/** A fresh host — models a restart, which mints a NEW pairing code. */
async function startHost(approve: (r: PairRequest) => Promise<boolean> = async () => true) {
  const mgr = new SessionManager({
    endpoint: 'ws://localhost:0',
    router: new CommandRouter().register('echo', echoHandler),
    approve,
    ttlMs: 60_000,
  });
  await mgr.init();
  return mgr;
}

/** A phone: a stable keypair (that's its identity across restarts). */
function makePhone(name = 'Test Phone') {
  const kp = generateKeyPair(s);
  return {
    publicKey: toBase64(s, kp.publicKey),
    pairRequest(pairingCode: string): PairRequest {
      return {
        type: 'pair',
        pairingCode,
        mobilePublicKey: toBase64(s, kp.publicKey),
        deviceName: name,
      };
    },
  };
}

/**
 * Run one handshake; resolve to 'accepted' | 'rejected: <reason>'.
 *
 * Waits for a frame rather than sleeping a fixed span: the handshake now does an
 * async disk read (isKnownDevice), so a fixed delay races it and reads an empty
 * outbound queue.
 */
async function handshake(mgr: SessionManager, req: PairRequest): Promise<string> {
  const ws = new FakeSocket();
  mgr.handleConnection(ws as any);
  ws.inject(req);

  const deadline = Date.now() + 2000;
  while (ws.outbound.length === 0) {
    if (Date.now() > deadline) {
      throw new Error('handshake produced no frame within 2s');
    }
    await new Promise(r => setTimeout(r, 5));
  }

  const msg = JSON.parse(ws.outbound[0]) as {type: string; reason?: string};
  return msg.type === 'pair_accept' ? 'accepted' : `rejected: ${msg.reason}`;
}

describe('a restart must not orphan a paired phone', () => {
  it('reconnects a known phone even though the pairing code changed', async () => {
    const phone = makePhone();

    const first = await startHost();
    const oldCode = first.qrPayload().pairingCode;
    expect(await handshake(first, phone.pairRequest(oldCode))).toBe('accepted');

    // Restart. A new host run mints a new code — this is the whole problem.
    const second = await startHost();
    const newCode = second.qrPayload().pairingCode;
    expect(newCode).not.toBe(oldCode);

    // The phone still holds the OLD code. It must still get in.
    expect(await handshake(second, phone.pairRequest(oldCode))).toBe('accepted');
  });

  it('persists the device across host instances', async () => {
    const phone = makePhone('My Pixel');
    const host = await startHost();
    await handshake(host, phone.pairRequest(host.qrPayload().pairingCode));

    const stored = await loadKnownDevices();
    expect(stored).toHaveLength(1);
    expect(stored[0].publicKey).toBe(phone.publicKey);
    expect(stored[0].name).toBe('My Pixel');
  });

  it('does not duplicate a device that reconnects repeatedly', async () => {
    const phone = makePhone();
    const host = await startHost();
    const code = host.qrPayload().pairingCode;
    await handshake(host, phone.pairRequest(code));
    await handshake(host, phone.pairRequest(code));
    await handshake(host, phone.pairRequest(code));

    expect(await loadKnownDevices()).toHaveLength(1);
  });

  it('a known device skips the human approval prompt on reconnect', async () => {
    const phone = makePhone();
    let prompts = 0;
    const approve = async () => {
      prompts++;
      return true;
    };

    const first = await startHost(approve);
    await handshake(first, phone.pairRequest(first.qrPayload().pairingCode));
    expect(prompts).toBe(1); // asked once, on the first pairing

    const second = await startHost(approve);
    await handshake(second, phone.pairRequest('000000'));
    expect(prompts).toBe(1); // NOT asked again — the user already trusted it
  });
});

// The fix must not become a hole. An unknown device gets no shortcuts.
describe('an unknown device still has to earn it', () => {
  it('rejects a wrong pairing code', async () => {
    const host = await startHost();
    const stranger = makePhone('Attacker');
    expect(await handshake(host, stranger.pairRequest('000000'))).toBe(
      'rejected: invalid pairing code',
    );
  });

  it('does not remember a device it rejected', async () => {
    const host = await startHost();
    const stranger = makePhone('Attacker');
    await handshake(host, stranger.pairRequest('000000'));
    expect(await loadKnownDevices()).toHaveLength(0);
  });

  it('still requires human approval even with the right code', async () => {
    const host = await startHost(async () => false); // user clicks Reject
    const phone = makePhone();
    expect(await handshake(host, phone.pairRequest(host.qrPayload().pairingCode))).toBe(
      'rejected: rejected by user',
    );
    expect(await loadKnownDevices()).toHaveLength(0);
  });

  it('a device the user forgot must pair from scratch again', async () => {
    const phone = makePhone();
    const first = await startHost();
    await handshake(first, phone.pairRequest(first.qrPayload().pairingCode));
    expect(await loadKnownDevices()).toHaveLength(1);

    await forgetDevice(phone.publicKey); // revoked from the desktop UI

    const second = await startHost();
    // Revoked → back to needing the CURRENT code; the stale one must fail.
    expect(await handshake(second, phone.pairRequest('000000'))).toBe(
      'rejected: invalid pairing code',
    );
  });

  it('an expired pairing window still blocks a new device', async () => {
    // A positive-but-tiny TTL. (Note: ttlMs <= 0 means "never expires", not
    // "already expired" — so a negative value would NOT test this.)
    const mgr = new SessionManager({
      endpoint: 'ws://localhost:0',
      router: new CommandRouter().register('echo', echoHandler),
      approve: async () => true,
      ttlMs: 10,
    });
    await mgr.init();
    await new Promise(r => setTimeout(r, 30)); // let the window lapse

    const phone = makePhone();
    expect(await handshake(mgr, phone.pairRequest(mgr.qrPayload().pairingCode))).toBe(
      'rejected: pairing window expired',
    );
  });
});
