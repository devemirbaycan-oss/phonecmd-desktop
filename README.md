# PhoneCMD — desktop host

The program that runs on **your PC** and lets the [PhoneCMD](https://phonecmd.emirbaycan.com.tr)
phone app drive it: real terminal sessions, your files, and coding CLIs — over an
end-to-end encrypted link.

**This is the half you install.** The phone is a thin client; the PC does the work.
It's open so you can read and build the exact thing you're about to run on your
own machine.

```
Phone (or the web client)  ──E2E──▶  ws:// LAN direct   ─┐
                            crypto   (same WiFi)         ├─▶  THIS APP
                                     wss:// Cloudflare   ─┘    PTY shells · files
                                      (relay; ciphertext only)  CLIs · agent tools
```

## Install

Grab an installer from [**Releases**](../../releases/latest). Nothing else to
install — `cloudflared` is bundled.

> **The installer isn't code-signed** (a certificate costs ~$300/yr), so:
> - **Windows** — “Windows protected your PC” → **More info → Run anyway**
> - **macOS** — Gatekeeper blocks it → **right-click the app → Open → Open**
> - **Linux** — `chmod +x` the AppImage and run it

Then open the app, and either scan the QR with the phone app or copy the
`PCMD-…` keycode and paste it there. That's the whole setup.

## What it does

- **Real terminal sessions.** Each shell is a true PTY (`node-pty`), not a
  one-shot `exec` — so `claude`, `codex`, `aider`, a REPL, anything interactive
  stays alive and keeps its state between messages.
- **Files.** List, read, and write files on the PC.
- **Coding CLIs.** Detects which are installed and launches them in a session.
- **A `phonecmd` CLI** for driving the same surface from a terminal (see below).

## Security

True end-to-end encryption — the relay and anyone on the wire see only ciphertext.

- **Handshake:** X25519. The PC's public key travels in the QR/keycode
  (out-of-band), which authenticates this host and prevents a relay-level MITM.
- **Messages:** `crypto_box_easy` / `open_easy`, 24-byte random nonces. A session
  token inside the encrypted channel is required on every command, so a stolen
  tunnel URL alone grants nothing.
- **Pairing needs your consent.** A pairing code isn't enough: the app shows an
  approval prompt naming the device, and nothing attaches until you click
  **Approve**. Unanswered prompts auto-reject after 60s.
- **Devices are remembered, codes are not.** The pairing code is a one-time
  secret minted fresh on every start. Once you approve a device, its **public
  key** is stored (`~/.phonecmd/devices.json`) and it reconnects on the strength
  of that key — no code, no re-approval, however often either side restarts. A
  *new* device still needs the current code **and** your approval. Revoke a
  device and it's back to pairing from scratch.
- **The tunnel is transport, not trust.** A bundled `cloudflared` quick tunnel
  carries ciphertext. On the same WiFi the phone goes LAN-direct and skips it
  entirely. Set `PHONECMD_NO_RENDEZVOUS=1` to opt out of the endpoint directory.

Your machine's identity keypair lives in `~/.phonecmd/identity.json` and never
leaves it.

## Run from source

```bash
npm install
npm run fetch:cloudflared   # vendors the tunnel binary (not committed — 52 MB)
npm run app                 # the Electron app
```

Headless (no UI — for servers, or debugging):

```bash
PHONECMD_NO_TUNNEL=1 PHONECMD_HOST=<lan-ip> npx ts-node src/headless.ts
```

Prints a QR and a `PCMD-…` keycode.

**Tests & typecheck** — 103 tests / 16 files:

```bash
npm run typecheck && npm test
```

> **Building the installer needs a C++ toolchain.** `node-pty` is a native
> module, and Electron's ABI differs from Node's, so it's recompiled from source.
> Windows needs Visual Studio Build Tools with *Desktop development with C++*;
> macOS needs the Xcode command-line tools; Linux needs `build-essential`. CI has
> all three — see [`PACKAGING.md`](PACKAGING.md).
>
> This isn't cosmetic: if `node-pty` can't load, the app falls back to piped
> shells and **loses persistent interactive sessions**.

## The `phonecmd` CLI

The host is a command server, so it ships a CLI that drives the same surface as
the phone — for debugging and automation. Runs in-process by default (no
WebSocket, no pairing). Add `--json` for machine-readable output.

```bash
npm run cli -- run "git status"           # run a command, print output
npm run cli -- fs ls /                    # file ops on the PC
npm run cli -- clis                       # which coding CLIs are installed
npm run cli -- agent claude "summarize each README under ./src"
npm run cli -- serve --no-tunnel --ttl 7d # start a host + print QR + keycode
```

## Layout

| Path | What |
|------|------|
| `core/host.ts` | `HostCore`: server + tunnel (+ auto-respawn) + LAN endpoint + rendezvous + router |
| `transport/` | WebSocket server, bundled `cloudflared`, LAN-IP detection, free-port picker |
| `pairing/` | Persistent identity, known devices, handshake, session tokens, the `PCMD-…` keycode |
| `terminal/` | PTY-backed shells, PC-side history, saved profiles, free-tier counter |
| `pcfs/` | File manager (list / read / write) |
| `clis/` | Detects installed coding CLIs |
| `crypto/e2e.ts` | `crypto_box` seal/open via `libsodium-wrappers` |
| `electron/` | The desktop UI (QR, keycode, connection panel, paired devices, usage) |
| `cli.ts`, `headless.ts` | The CLI, and the UI-less host |

## Releasing

Push a tag; GitHub Actions builds Windows/macOS/Linux installers and publishes
them to a Release. See [`PACKAGING.md`](PACKAGING.md).

```bash
git tag v0.1.0 && git push origin v0.1.0
```
