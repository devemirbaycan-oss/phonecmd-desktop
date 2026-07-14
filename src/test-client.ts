/**
 * Test client — stands in for the React Native mobile app so we can prove the
 * E2E handshake + encrypted echo entirely from the desktop, before the RN app
 * exists. It mirrors exactly what the mobile client will do:
 *
 *   1. Read the QR payload (here from argv / env instead of a camera scan).
 *   2. Generate its own X25519 keypair.
 *   3. Connect, send PairRequest, derive the shared key from desktopPublicKey.
 *   4. Receive the encrypted session-token grant.
 *   5. Send an encrypted `echo` command and print the decrypted response.
 *
 * Run (after copying the QR payload the headless server prints):
 *   PHONECMD_QR='<payload json>' npm run dev:test-client
 */

import WebSocket from "ws";
import {
  ready,
  generateKeyPair,
  seal,
  open,
  toBase64,
  fromBase64,
} from "./crypto/e2e";
import {
  QrPayload,
  PairRequest,
  Envelope,
  CommandRequest,
  CommandResponse,
} from "./protocol";

async function main() {
  const s = await ready();

  const qrRaw = process.env.PHONECMD_QR;
  if (!qrRaw) {
    console.error(
      "Set PHONECMD_QR to the QR payload JSON printed by the headless server."
    );
    process.exit(1);
  }
  const qr: QrPayload = JSON.parse(qrRaw);

  // Command to run is configurable: PHONECMD_CMD (default "echo") and
  // PHONECMD_ARGS (JSON object). e.g. PHONECMD_CMD=device.info
  const command = process.env.PHONECMD_CMD || "echo";
  const commandArgs: Record<string, unknown> = process.env.PHONECMD_ARGS
    ? JSON.parse(process.env.PHONECMD_ARGS)
    : command === "echo"
    ? { message: "hello from the phone 👋" }
    : {};

  const kp = generateKeyPair(s);
  const desktopPub = fromBase64(s, qr.desktopPublicKey);

  const dialUrl = qr.endpoint;
  console.log(`[client] connecting to ${dialUrl}`);
  const ws = new WebSocket(dialUrl);

  let sessionToken: string | null = null;

  ws.on("open", () => {
    const pair: PairRequest = {
      type: "pair",
      pairingCode: qr.pairingCode,
      mobilePublicKey: toBase64(s, kp.publicKey),
      deviceName: "Test Client",
    };
    ws.send(JSON.stringify(pair));
    console.log("[client] sent pair request");
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "pair_reject") {
      console.error(`[client] pairing rejected: ${msg.reason}`);
      ws.close();
      return;
    }
    if (msg.type === "pair_accept") {
      console.log("[client] pair accepted, awaiting encrypted grant…");
      return;
    }
    if (msg.type === "enc") {
      const env = msg as Envelope;
      const plaintext = open(s, kp.privateKey, desktopPub, env.nonce, env.ciphertext);
      const res: CommandResponse = JSON.parse(plaintext);

      // First encrypted message is the session-token grant.
      if (res.sessionToken && !sessionToken) {
        sessionToken = res.sessionToken;
        console.log(`[client] received session token, sending "${command}"…`);
        sendCommand(s, ws, kp.privateKey, desktopPub, sessionToken, command, commandArgs);
        return;
      }

      console.log("[client] response:", JSON.stringify(res, null, 2));
      if (res.ok) {
        console.log(`\n✅ "${command}" round-tripped over the encrypted channel.`);
      } else {
        console.log(`\n⚠️  "${command}" returned an error (see above).`);
      }
      ws.close();
    }
  });

  ws.on("error", (e) => console.error("[client] ws error:", e.message));
}

function sendCommand(
  s: Awaited<ReturnType<typeof ready>>,
  ws: WebSocket,
  ourPrivate: Uint8Array,
  peerPublic: Uint8Array,
  token: string,
  command: string,
  args: Record<string, unknown>
) {
  const req: CommandRequest = {
    id: `${command}-1`,
    command,
    args,
    sessionToken: token,
  };
  const { nonce, ciphertext } = seal(s, ourPrivate, peerPublic, JSON.stringify(req));
  const env: Envelope = { type: "enc", nonce, ciphertext };
  ws.send(JSON.stringify(env));
}

main().catch((e) => {
  console.error("[client] fatal:", e);
  process.exit(1);
});
