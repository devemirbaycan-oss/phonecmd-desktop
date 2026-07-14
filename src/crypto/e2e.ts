/**
 * End-to-end crypto for PhoneCMD, built on libsodium.
 *
 * Scheme: crypto_box (authenticated public-key encryption over X25519 +
 * XSalsa20-Poly1305). Each side has its own keypair and knows the peer's public
 * key (desktop's is delivered via the scanned QR; mobile's via the pair
 * request). Messages are sealed with crypto_box_easy and opened with
 * crypto_box_open_easy — no manual ECDH/KDF needed.
 *
 * WHY crypto_box (not manual scalarmult + KDF + XChaCha20): the mobile binding
 * `react-native-libsodium` does NOT expose crypto_scalarmult or crypto_kx on its
 * native (JSI) build, but BOTH platforms expose crypto_box_easy/open_easy with a
 * 24-byte nonce. crypto_box is the portable, interoperable primitive.
 */

import _sodium from "libsodium-wrappers";

export type Sodium = typeof _sodium;

let sodiumReady: Promise<Sodium> | null = null;

/** Load libsodium once. Must be awaited before any other call here. */
export function ready(): Promise<Sodium> {
  if (!sodiumReady) {
    sodiumReady = _sodium.ready.then(() => _sodium);
  }
  return sodiumReady;
}

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export const toBase64 = (s: Sodium, b: Uint8Array): string =>
  s.to_base64(b, s.base64_variants.ORIGINAL);
export const fromBase64 = (s: Sodium, str: string): Uint8Array =>
  s.from_base64(str, s.base64_variants.ORIGINAL);

/** Generate an X25519 keypair (crypto_box) for one session. */
export function generateKeyPair(s: Sodium): KeyPair {
  const kp = s.crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

/**
 * Seal a plaintext for `peerPublic`, signed by `ourPrivate`.
 * Returns a random 24-byte nonce + ciphertext (both base64).
 */
export function seal(
  s: Sodium,
  ourPrivate: Uint8Array,
  peerPublic: Uint8Array,
  plaintext: string
): { nonce: string; ciphertext: string } {
  const nonce = s.randombytes_buf(s.crypto_box_NONCEBYTES); // 24
  const ct = s.crypto_box_easy(
    s.from_string(plaintext),
    nonce,
    peerPublic,
    ourPrivate
  );
  return { nonce: toBase64(s, nonce), ciphertext: toBase64(s, ct) };
}

/**
 * Open a message sealed by `peerPublic`, addressed to `ourPrivate`.
 * Throws if authentication fails (tampered / wrong key).
 */
export function open(
  s: Sodium,
  ourPrivate: Uint8Array,
  peerPublic: Uint8Array,
  nonceB64: string,
  ciphertextB64: string
): string {
  const nonce = fromBase64(s, nonceB64);
  const ct = fromBase64(s, ciphertextB64);
  const pt = s.crypto_box_open_easy(ct, nonce, peerPublic, ourPrivate);
  return s.to_string(pt);
}
