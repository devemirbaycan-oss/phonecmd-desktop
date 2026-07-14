/**
 * Persistent desktop identity — the host's X25519 keypair, stored on disk so it
 * survives restarts. Two payoffs:
 *
 *  1. A saved PC on the phone keeps working after the host restarts (the phone
 *     trusts a public key delivered in the keycode; if that key changed every
 *     launch, the pairing broke — which it did).
 *  2. The public key doubles as the STABLE pcId for API rendezvous: the phone
 *     resolves "where is this pcId now?" to find the current (possibly rotated)
 *     tunnel endpoint.
 *
 * Stored base64 in ~/.phonecmd/identity.json. The private key never leaves the
 * machine; the file should be user-only readable (best-effort chmod on posix).
 */

import {promises as fsp, mkdirSync} from 'fs';
import {join} from 'path';
import {homedir} from 'os';
import {Sodium, KeyPair, generateKeyPair, toBase64, fromBase64} from '../crypto/e2e';

/**
 * Where the identity lives. PHONECMD_HOME redirects it — the test suite points
 * this at a temp dir so a test run can't overwrite the real host's keypair
 * (which would change its pcId and orphan every paired phone).
 */
function paths(): {dir: string; file: string} {
  const dir = process.env.PHONECMD_HOME || join(homedir(), '.phonecmd');
  return {dir, file: join(dir, 'identity.json')};
}

interface StoredIdentity {
  publicKey: string; // base64
  privateKey: string; // base64
}

/** Load the persisted keypair, or generate + persist a new one. */
export async function loadOrCreateIdentity(s: Sodium): Promise<KeyPair> {
  try {
    const raw = await fsp.readFile(paths().file, 'utf8');
    const id = JSON.parse(raw) as StoredIdentity;
    if (id.publicKey && id.privateKey) {
      return {
        publicKey: fromBase64(s, id.publicKey),
        privateKey: fromBase64(s, id.privateKey),
      };
    }
  } catch {
    /* not present or unreadable → create a fresh one */
  }
  const kp = generateKeyPair(s);
  await save(s, kp);
  return kp;
}

async function save(s: Sodium, kp: KeyPair): Promise<void> {
  const data: StoredIdentity = {
    publicKey: toBase64(s, kp.publicKey),
    privateKey: toBase64(s, kp.privateKey),
  };
  const {dir, file} = paths();
  mkdirSync(dir, {recursive: true});
  await fsp.writeFile(file, JSON.stringify(data), {mode: 0o600});
  try {
    await fsp.chmod(file, 0o600); // user-only (no-op on Windows)
  } catch {
    /* best-effort */
  }
}

/** The stable pcId for a host = its base64 public key (the rendezvous key). */
export function pcIdFromPublicKey(s: Sodium, publicKey: Uint8Array): string {
  return toBase64(s, publicKey);
}
