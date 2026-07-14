/**
 * Pairing keycode — the whole QR payload packed into ONE copy-pasteable string.
 *
 *   PCMD-<base64url(json)>
 *
 * It carries everything the phone needs to connect from anywhere — the relay
 * endpoint, the LAN endpoint, the desktop's public key, the pairing code — so
 * the user never types a host, port, or key. Scan the QR OR paste this code;
 * the phone decodes it and (via the WiFi-only logic) picks LAN vs relay.
 *
 * This is NOT a secret-derivation step: security comes from the E2E handshake
 * (the public key in here authenticates the desktop, delivered out-of-band).
 * The keycode is just a transport-address bundle — treat it like an access
 * grant (whoever has it can pair), and bound it with `expiresAt` if desired.
 *
 * Kept dependency-free and mirrored on the mobile side (mobile/src/keycode.ts)
 * so both ends encode/decode identically.
 */

import {QrPayload} from '../protocol';

export const KEYCODE_PREFIX = 'PCMD-';

/** base64url (no padding) of a UTF-8 string. */
function toB64Url(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

/** Encode a QR payload as a PCMD- keycode string. */
export function encodeKeycode(qr: QrPayload): string {
  // Compact key names keep the code shorter; decode restores the full shape.
  const compact = {
    e: qr.endpoint,
    l: qr.lanEndpoint ?? null,
    k: qr.desktopPublicKey,
    c: qr.pairingCode,
    x: qr.expiresAt ?? null,
  };
  return KEYCODE_PREFIX + toB64Url(JSON.stringify(compact));
}

/** Decode a PCMD- keycode back into a QR payload, or null if malformed. */
export function decodeKeycode(code: string): QrPayload | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(KEYCODE_PREFIX)) {
    return null;
  }
  try {
    const json = fromB64Url(trimmed.slice(KEYCODE_PREFIX.length));
    const o = JSON.parse(json);
    if (typeof o.e !== 'string' || typeof o.k !== 'string' || typeof o.c !== 'string') {
      return null;
    }
    return {
      v: 1,
      endpoint: o.e,
      lanEndpoint: typeof o.l === 'string' ? o.l : null,
      desktopPublicKey: o.k,
      pairingCode: o.c,
      expiresAt: typeof o.x === 'string' ? o.x : null,
    };
  } catch {
    return null;
  }
}
