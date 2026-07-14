/**
 * Node harness for the WEB client's own code (pcmd.js) — it exercises the exact
 * modules the browser loads, against a live desktop host, so we can prove the
 * protocol/crypto/keycode path end-to-end without fighting headless-Chrome
 * screenshot timing. The browser runs the same file.
 *
 * Usage: node _e2e-node.mjs <PCMD-keycode>
 */

import {createRequire} from 'module';

// The ESM build of libsodium-wrappers has a broken internal import; the CJS one
// (which the desktop uses in production) is fine. Same for ws.
const require = createRequire(import.meta.url);
const {WebSocket} = require('ws');
const _sodium = require('libsodium-wrappers');

// pcmd.js expects browser globals; provide the few it touches.
globalThis.WebSocket = WebSocket;
globalThis.btoa = s => Buffer.from(s, 'binary').toString('base64');
globalThis.atob = b => Buffer.from(b, 'base64').toString('binary');

await _sodium.ready;
globalThis.sodium = _sodium;

const {Session, TerminalEmulator, decodeKeycode, resolveLiveEndpoint} =
  await import(process.env.PCMD_CLIENT ?? './pcmd.js');

const KC = process.argv[2];
const log = m => console.log(m);

try {
  log(`PASS sodium ready — crypto_box: ${typeof sodium.crypto_box_easy === 'function'}`);

  const qr = decodeKeycode(KC);
  if (!qr) throw new Error('keycode decode failed');
  log(`PASS keycode decoded — endpoint=${qr.endpoint}`);

  const live = await resolveLiveEndpoint(qr);
  log(`PASS rendezvous resolved — endpoint=${live.endpoint}`);

  const s = new Session();
  const emu = new TerminalEmulator();
  s.onPush((k, d) => {
    if (k === 'term.output' && d.chunk) emu.write(d.chunk);
  });

  await s.connect(live);
  log('PASS handshake — E2E session established');

  const termId = 'e2e' + Date.now();
  await s.send('term.start', {termId});
  log('PASS term.start');

  await s.send('term.input', {termId, line: 'echo WEBAPP_OK'});
  await new Promise(r => setTimeout(r, 3000));

  const text = emu.text();
  log('--- terminal output ---');
  log(text);
  log('-----------------------');

  if (text.includes('WEBAPP_OK')) {
    log('PASS command round-trip (saw WEBAPP_OK)');
  } else {
    log('FAIL command round-trip');
    process.exitCode = 1;
  }

  s.close();
  log('DONE');
  process.exit(process.exitCode ?? 0);
} catch (e) {
  log(`FAIL ${e.message}`);
  process.exit(1);
}
