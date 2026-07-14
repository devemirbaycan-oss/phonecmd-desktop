/**
 * Keycode codec tests (desktop). Must stay byte-compatible with the mobile
 * codec — the desktop encodes the PCMD- string, the phone decodes it.
 */

import {describe, it, expect} from 'vitest';
import {encodeKeycode, decodeKeycode, KEYCODE_PREFIX} from '../src/pairing/keycode';
import {QrPayload} from '../src/protocol';

const RELAY: QrPayload = {
  v: 1,
  endpoint: 'wss://ooo-talk-celebrity-chat.trycloudflare.com',
  lanEndpoint: 'ws://192.168.1.100:8787',
  desktopPublicKey: 'Mny/00Z3l2ggpV3uR0JRN7jS4JCuMN5znnHgSDFYTg4=',
  pairingCode: '423301',
  expiresAt: null,
};

describe('desktop keycode', () => {
  it('round-trips a relay+LAN payload', () => {
    const code = encodeKeycode(RELAY);
    expect(code.startsWith(KEYCODE_PREFIX)).toBe(true);
    expect(decodeKeycode(code)).toEqual(RELAY);
  });

  it('produces base64url (no +/= chars) so it pastes cleanly', () => {
    const body = encodeKeycode(RELAY).slice(KEYCODE_PREFIX.length);
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is stable/deterministic for the same payload', () => {
    expect(encodeKeycode(RELAY)).toBe(encodeKeycode(RELAY));
  });

  it('rejects malformed keycodes', () => {
    expect(decodeKeycode('nope')).toBeNull();
    expect(decodeKeycode('PCMD-@@@')).toBeNull();
  });

  it('cross-decodes a keycode built from the compact JSON shape', () => {
    // Sanity: decode reconstructs the full QrPayload from compact keys.
    const decoded = decodeKeycode(encodeKeycode(RELAY))!;
    expect(decoded.v).toBe(1);
    expect(decoded.desktopPublicKey).toBe(RELAY.desktopPublicKey);
    expect(decoded.pairingCode).toBe(RELAY.pairingCode);
  });
});
