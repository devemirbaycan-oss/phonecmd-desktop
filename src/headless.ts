/**
 * Headless entrypoint — proves the full pipe without any Electron UI, now built
 * on the shared HostCore (same engine the Electron app uses).
 *
 *   ws server  →  cloudflared tunnel  →  E2E handshake  →  command engine
 *
 * Run:  npm run dev:headless
 * Set PHONECMD_NO_TUNNEL=1 to run on localhost only (no cloudflared needed).
 */

import qrcodeTerminal from 'qrcode-terminal';
import {HostCore} from './core/host';
import {ttlFromChoice} from './pairing/session';
import {encodeKeycode} from './pairing/keycode';

const PORT = Number(process.env.PHONECMD_PORT ?? 8787);
const NO_TUNNEL = process.env.PHONECMD_NO_TUNNEL === '1';
const LAN_HOST = process.env.PHONECMD_HOST; // e.g. 192.168.1.101
// Pairing expiry: preset id (never/5m/1h/1d/7d/30d) or ms. Default: never.
const PAIRING_TTL = ttlFromChoice(process.env.PHONECMD_PAIRING_TTL);

async function main() {
  const host = new HostCore({
    port: PORT,
    noTunnel: NO_TUNNEL,
    lanHost: LAN_HOST,
    pairingTtlMs: PAIRING_TTL,
  });

  host.on('log', m => console.log(`[phonecmd] ${m}`));
  host.on('pair-request', req =>
    console.log(
      `[phonecmd] pairing request from "${req.deviceName}" — auto-approving (headless)`,
    ),
  );

  host.on('qr', payload => {
    const payloadStr = JSON.stringify(payload);
    const keycode = encodeKeycode(payload);
    console.log('\n── PhoneCMD pairing ──────────────────────────────');
    console.log('Scan this QR, OR paste the keycode below into the app:\n');
    qrcodeTerminal.generate(keycode, {small: true});
    console.log('Keycode (copy-paste this one string — works LAN & remote):');
    console.log('  ' + keycode);
    console.log(`\nPairing code: ${payload.pairingCode}`);
    console.log('QR payload (debug): ' + payloadStr);
    console.log('──────────────────────────────────────────────────\n');
  });

  await host.start();

  const shutdown = () => {
    console.log('[phonecmd] shutting down');
    host.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[phonecmd] fatal:', err);
  process.exit(1);
});
