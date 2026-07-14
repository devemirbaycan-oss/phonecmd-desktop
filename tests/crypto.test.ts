/**
 * Crypto tests — the highest-risk code. Verifies the crypto_box scheme:
 *  - a message sealed by A for B opens with B's private key + A's public key
 *  - fresh nonce per call
 *  - tampering fails closed
 *  - wrong key fails closed
 */

import {describe, it, expect, beforeAll} from 'vitest';
import {
  ready,
  generateKeyPair,
  seal,
  open,
  toBase64,
  fromBase64,
  Sodium,
} from '../src/crypto/e2e';

let s: Sodium;

beforeAll(async () => {
  s = await ready();
});

describe('crypto_box seal / open', () => {
  it('A→B round-trips: sealed by A for B, opened by B from A', () => {
    const desktop = generateKeyPair(s);
    const mobile = generateKeyPair(s);

    const msg = JSON.stringify({id: 'x', command: 'echo', args: {m: 'hi 👋'}});
    // desktop seals for mobile
    const {nonce, ciphertext} = seal(s, desktop.privateKey, mobile.publicKey, msg);
    // mobile opens: its private key + desktop's public key
    expect(open(s, mobile.privateKey, desktop.publicKey, nonce, ciphertext)).toBe(
      msg,
    );
  });

  it('B→A also works (bidirectional)', () => {
    const desktop = generateKeyPair(s);
    const mobile = generateKeyPair(s);
    const msg = 'from the phone';
    const {nonce, ciphertext} = seal(s, mobile.privateKey, desktop.publicKey, msg);
    expect(open(s, desktop.privateKey, mobile.publicKey, nonce, ciphertext)).toBe(
      msg,
    );
  });

  it('produces a fresh nonce each call', () => {
    const a = generateKeyPair(s);
    const b = generateKeyPair(s);
    const x = seal(s, a.privateKey, b.publicKey, 'same');
    const y = seal(s, a.privateKey, b.publicKey, 'same');
    expect(x.nonce).not.toBe(y.nonce);
    expect(x.ciphertext).not.toBe(y.ciphertext);
  });

  it('fails closed on tampered ciphertext', () => {
    const a = generateKeyPair(s);
    const b = generateKeyPair(s);
    const {nonce, ciphertext} = seal(s, a.privateKey, b.publicKey, 'secret');
    const bytes = fromBase64(s, ciphertext);
    bytes[0] ^= 0xff;
    expect(() =>
      open(s, b.privateKey, a.publicKey, nonce, toBase64(s, bytes)),
    ).toThrow();
  });

  it('fails closed with the wrong recipient key', () => {
    const a = generateKeyPair(s);
    const b = generateKeyPair(s);
    const eve = generateKeyPair(s);
    const {nonce, ciphertext} = seal(s, a.privateKey, b.publicKey, 'secret');
    // Eve tries to open with her own private key
    expect(() =>
      open(s, eve.privateKey, a.publicKey, nonce, ciphertext),
    ).toThrow();
  });
});
