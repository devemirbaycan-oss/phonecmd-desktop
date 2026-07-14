/**
 * PhoneCMD wire protocol.
 *
 * Two layers:
 *   1. Handshake messages — sent in CLEARTEXT over the WSS tunnel. They carry
 *      only public keys + the pairing code, which is safe: the desktop's public
 *      key was already delivered to the phone out-of-band via the scanned QR,
 *      so an on-path attacker (Cloudflare included) cannot substitute its own
 *      key without the phone noticing.
 *   2. Encrypted envelopes — everything after the handshake. The plaintext is a
 *      `CommandRequest` / `CommandResponse`, sealed with XChaCha20-Poly1305.
 */

/** Payload encoded into the pairing QR shown on the desktop. */
export interface QrPayload {
  v: 1;
  endpoint: string; // wss://xxxx.trycloudflare.com (relay) or ws://<lan-ip>:port
  /**
   * Direct LAN endpoint (ws://<lan-ip>:port) when the desktop knows its local IP.
   * Present alongside a relay `endpoint` so a phone on the same WiFi can choose
   * to connect directly (lower latency, no relay) via the "WiFi only" option.
   * Null when unknown or when `endpoint` is already the LAN address.
   */
  lanEndpoint?: string | null;
  pairingCode: string; // short human code, also proven inside the handshake
  desktopPublicKey: string; // base64 X25519 public key — authenticates the desktop
  /** ISO8601 expiry for the pairing window, or null = never expires (default). */
  expiresAt: string | null;
}

/** First message the phone sends after connecting (cleartext). */
export interface PairRequest {
  type: "pair";
  pairingCode: string;
  mobilePublicKey: string; // base64 X25519 public key
  deviceName: string;
  /** Phone asserts Pro (from /api/subscription/status). Unlimited when true. */
  isPro?: boolean;
}

/** Desktop's reply once it accepts the pairing (cleartext). */
export interface PairAccept {
  type: "pair_accept";
  // The session token is NOT sent here in cleartext; it is delivered in the
  // first encrypted envelope. This message only confirms the handshake so the
  // phone can derive the shared key and switch to encrypted mode.
  ok: true;
}

export interface PairReject {
  type: "pair_reject";
  reason: string;
}

/** Everything after the handshake rides inside one of these (cleartext frame,
 *  ciphertext body). */
export interface Envelope {
  type: "enc";
  nonce: string; // base64, 24 bytes (XChaCha20 nonce)
  ciphertext: string; // base64, XChaCha20-Poly1305 sealed CommandRequest/Response
}

/** Decrypted request from phone → desktop. */
export interface CommandRequest {
  id: string; // client-generated correlation id
  command: string; // e.g. "echo", later "adb.shell", "device.info"
  args?: Record<string, unknown>;
  sessionToken?: string; // required for all commands except the initial token grant
}

/** Decrypted response desktop → phone. */
export interface CommandResponse {
  id: string; // echoes the request id
  ok: boolean;
  data?: unknown;
  error?: string;
  // On the very first response (the token grant) the desktop includes the
  // session token the phone must present on subsequent commands.
  sessionToken?: string;
  // Set on server-pushed messages that are NOT replies to a request (e.g.
  // streaming terminal output). The phone routes these by `push` type rather
  // than by matching a pending request id.
  push?: PushKind;
  // Free-tier daily limit was hit (the app shows an upgrade paywall).
  limitReached?: boolean;
  limit?: number;
}

/** Kinds of unsolicited server→phone push messages (encrypted like any other). */
export type PushKind = 'term.output' | 'term.exit';

/** Terminal output chunk pushed desktop → phone (inside a CommandResponse with
 *  push:'term.output', carried in `data`). termId identifies which tab/shell. */
export interface TermOutput {
  termId: string;
  chunk: string; // text written to the terminal (stdout+stderr merged)
}

/** Terminal exited (push:'term.exit'). */
export interface TermExit {
  termId: string;
  code: number | null;
}

export type HandshakeMessage = PairRequest | PairAccept | PairReject;
