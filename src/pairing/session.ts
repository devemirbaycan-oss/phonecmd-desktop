/**
 * Session manager — owns the desktop's per-session keypair, the pairing code,
 * the QR payload, and the lifecycle of each mobile connection.
 *
 * Flow per connection:
 *   1. Phone connects, sends PairRequest (cleartext) with its public key + code.
 *   2. A KNOWN device (public key we've approved before) is let through on the
 *      strength of that key. A NEW device must present the current pairing code
 *      and win human approval.
 *   3. Derive the shared session key via X25519 + KDF.
 *   4. Send PairAccept (cleartext) and mint a session token.
 *   5. All further traffic is XChaCha20-Poly1305 envelopes carrying commands.
 *
 * The session token lives inside the encrypted channel and is required on every
 * command, so a stolen tunnel URL alone grants nothing.
 *
 * On step 2: the pairing code is a fresh one-time secret per host run, so a phone
 * paired yesterday can't recite it today. Re-checking it on every reconnect meant
 * a host restart orphaned every paired phone. A device that has already been
 * approved instead proves itself by decrypting with its stored public key —
 * unguessable, where a 6-digit code is 10^6 guesses. See ./devices.ts.
 */

import { WebSocket } from "ws";
import {
  Sodium,
  ready,
  seal,
  open,
  toBase64,
  fromBase64,
  KeyPair,
} from "../crypto/e2e";
import {
  QrPayload,
  PairRequest,
  CommandRequest,
  CommandResponse,
  Envelope,
} from "../protocol";
import { CommandRouter, LimitReachedError } from "../commands/router";
import { loadOrCreateIdentity } from "./identity";
import { isKnownDevice, rememberDevice } from "./devices";

export interface SessionManagerOptions {
  /** How the phone reaches us (wss URL from the tunnel, or ws:// LAN). */
  endpoint: string;
  /**
   * Optional direct LAN endpoint (ws://<lan-ip>:port) advertised alongside the
   * relay so a phone on the same WiFi can connect directly. Null/omitted when
   * unknown or when `endpoint` is already the LAN address.
   */
  lanEndpoint?: string | null;
  /**
   * Pairing-window validity in ms. `null` (the default) means the pairing QR
   * never expires. A positive number expires it after that many ms.
   */
  ttlMs?: number | null;
  /**
   * Approve a pairing request. Return true to accept. Defaults to auto-accept
   * (headless). The Electron UI replaces this with a real prompt.
   */
  approve?: (req: PairRequest) => Promise<boolean>;
  router: CommandRouter;
  /** Optional log sink. */
  log?: (msg: string) => void;
}

/** Pairing-expiry presets offered in the UI. `ms: null` = never expires. */
export const PAIRING_TTL_OPTIONS: {id: string; label: string; ms: number | null}[] =
  [
    {id: 'never', label: 'Never', ms: null},
    {id: '5m', label: '5 minutes', ms: 5 * 60_000},
    {id: '1h', label: '1 hour', ms: 60 * 60_000},
    {id: '1d', label: '1 day', ms: 24 * 60 * 60_000},
    {id: '7d', label: '7 days', ms: 7 * 24 * 60 * 60_000},
    {id: '30d', label: '30 days', ms: 30 * 24 * 60 * 60_000},
  ];

/** Map a preset id (or raw ms string) to ttl ms. Unknown → null (never). */
export function ttlFromChoice(choice: string | undefined): number | null {
  if (!choice) {
    return null;
  }
  const preset = PAIRING_TTL_OPTIONS.find(o => o.id === choice);
  if (preset) {
    return preset.ms;
  }
  const n = Number(choice);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export class SessionManager {
  private sodium!: Sodium;
  private keyPair!: KeyPair;
  private pairingCode!: string;
  private expiresAt: Date | null = null; // null = never expires
  private readonly ttlMs: number | null;

  constructor(private opts: SessionManagerOptions) {
    // Default: no expiry. Pass a positive ttlMs to expire the pairing window.
    this.ttlMs = opts.ttlMs === undefined ? null : opts.ttlMs;
  }

  /** Must be called once before serving connections. */
  async init(): Promise<void> {
    this.sodium = await ready();
    // Persistent identity: the keypair survives restarts so a saved PC keeps
    // working and the public key is a stable pcId for rendezvous. The pairing
    // CODE is still fresh per session.
    this.keyPair = await loadOrCreateIdentity(this.sodium);
    this.pairingCode = this.generatePairingCode();
    this.expiresAt =
      this.ttlMs && this.ttlMs > 0 ? new Date(Date.now() + this.ttlMs) : null;
  }

  /** The stable pcId (base64 public key) used for API rendezvous. */
  pcId(): string {
    return toBase64(this.sodium, this.keyPair.publicKey);
  }

  /** The payload to encode into the QR shown on the desktop. An endpoint
   *  override is used when the tunnel URL rotates (auto-restart). */
  qrPayload(endpointOverride?: string): QrPayload {
    const endpoint = endpointOverride ?? this.opts.endpoint;
    // Don't duplicate the LAN endpoint if it's already the primary endpoint.
    const lan =
      this.opts.lanEndpoint && this.opts.lanEndpoint !== endpoint
        ? this.opts.lanEndpoint
        : null;
    return {
      v: 1,
      endpoint,
      lanEndpoint: lan,
      pairingCode: this.pairingCode,
      desktopPublicKey: toBase64(this.sodium, this.keyPair.publicKey),
      expiresAt: this.expiresAt ? this.expiresAt.toISOString() : null,
    };
  }

  /** Attach a freshly-accepted WebSocket connection. */
  handleConnection(ws: WebSocket): void {
    const s = this.sodium;
    let peerPublic: Uint8Array | null = null;
    let deviceName = "unknown";
    let sessionToken: string | null = null;
    let isPro = false;

    ws.on("message", async (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        this.log("dropped: non-JSON frame");
        return;
      }

      // ── Handshake phase (cleartext) ──────────────────────────────────────
      if (peerPublic === null) {
        const req = msg as PairRequest;
        if (req?.type !== "pair") {
          this.reject(ws, "expected pair request");
          return;
        }

        // Parse the phone's key first — it's the identity everything hangs off.
        try {
          peerPublic = fromBase64(s, req.mobilePublicKey);
        } catch {
          this.reject(ws, "bad mobile public key");
          return;
        }

        // A device we've approved before reconnects on the strength of its key.
        // Its stored pairing code is from an earlier host run and is expected to
        // be stale — checking it here is what used to break every saved PC on
        // restart. The expiry window likewise gates NEW pairings, not old friends.
        const known = await isKnownDevice(req.mobilePublicKey);

        if (!known) {
          if (this.isExpired()) {
            this.reject(ws, "pairing window expired");
            return;
          }
          if (req.pairingCode !== this.pairingCode) {
            this.reject(ws, "invalid pairing code");
            return;
          }

          const approve = this.opts.approve ?? (async () => true);
          const ok = await approve(req);
          if (!ok) {
            this.reject(ws, "rejected by user");
            return;
          }
        }

        deviceName = req.deviceName || "unknown";
        isPro = req.isPro === true;
        sessionToken = this.mintToken();

        // Remember it (or refresh lastSeen) so the next restart is seamless.
        // Non-fatal: a disk hiccup shouldn't kill a working session — it just
        // means this device re-pairs the slow way next time.
        try {
          await rememberDevice(req.mobilePublicKey, deviceName);
        } catch {
          this.log("warning: could not persist device (will need to re-pair)");
        }

        ws.send(JSON.stringify({ type: "pair_accept", ok: true }));
        this.log(
          `${known ? "reconnected" : "paired"}: ${deviceName}${isPro ? " (pro)" : ""}`,
        );

        // Deliver the session token inside the first encrypted envelope.
        const grant: CommandResponse = {
          id: "session-grant",
          ok: true,
          sessionToken,
          data: { message: "paired" },
        };
        this.sendEncrypted(ws, peerPublic, grant);
        return;
      }

      // ── Command phase (encrypted) ────────────────────────────────────────
      const env = msg as Envelope;
      if (env?.type !== "enc") {
        this.log("dropped: expected encrypted envelope");
        return;
      }

      let req: CommandRequest;
      try {
        const plaintext = open(
          s,
          this.keyPair.privateKey,
          peerPublic,
          env.nonce,
          env.ciphertext
        );
        req = JSON.parse(plaintext);
      } catch {
        this.log("dropped: decryption/auth failure");
        return;
      }

      // Every command must carry the session token.
      if (req.sessionToken !== sessionToken) {
        this.sendEncrypted(ws, peerPublic, {
          id: req.id,
          ok: false,
          error: "invalid session token",
        });
        return;
      }

      // Handlers may push unsolicited encrypted messages (e.g. live terminal
      // output) via ctx.push, in addition to their eventual return value.
      const pub = peerPublic;
      const push = (kind: import("../protocol").PushKind, data: unknown) => {
        this.sendEncrypted(ws, pub, { id: `push:${kind}`, ok: true, push: kind, data });
      };

      let response: CommandResponse;
      try {
        const data = await this.opts.router.dispatch(req, { deviceName, isPro, push });
        response = { id: req.id, ok: true, data };
      } catch (err) {
        if (err instanceof LimitReachedError) {
          // Free daily cap hit → structured response the app shows as a paywall.
          response = {
            id: req.id,
            ok: false,
            error: "daily free limit reached",
            limitReached: true,
            limit: err.limit,
          };
        } else {
          response = {
            id: req.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
      this.sendEncrypted(ws, peerPublic, response);
    });

    ws.on("close", () => this.log(`disconnected: ${deviceName}`));
  }

  // ── internals ──────────────────────────────────────────────────────────

  private sendEncrypted(
    ws: WebSocket,
    peerPublic: Uint8Array,
    payload: CommandResponse
  ): void {
    const { nonce, ciphertext } = seal(
      this.sodium,
      this.keyPair.privateKey,
      peerPublic,
      JSON.stringify(payload)
    );
    const env: Envelope = { type: "enc", nonce, ciphertext };
    ws.send(JSON.stringify(env));
  }

  private reject(ws: WebSocket, reason: string): void {
    try {
      ws.send(JSON.stringify({ type: "pair_reject", reason }));
    } finally {
      ws.close();
    }
    this.log(`rejected: ${reason}`);
  }

  private isExpired(): boolean {
    return this.expiresAt !== null && Date.now() > this.expiresAt.getTime();
  }

  private generatePairingCode(): string {
    // 6-digit numeric code from CSPRNG.
    const buf = this.sodium.randombytes_buf(4);
    const n =
      ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
    return (n % 1_000_000).toString().padStart(6, "0");
  }

  private mintToken(): string {
    return toBase64(this.sodium, this.sodium.randombytes_buf(32));
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }
}
