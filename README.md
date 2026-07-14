<div align="center">

<img src="https://phonecmd.emirbaycan.com.tr/logo.png" width="96" alt="PhoneCMD" />

# PhoneCMD

### Your PC. In your pocket.

**Run any command, browse your files, and drive coding CLIs like Claude & Codex — from your phone, from anywhere.** End-to-end encrypted. No account to try.

[**⬇ Download**](../../releases/latest) · [Website](https://phonecmd.emirbaycan.com.tr) · [How it works](#how-it-works)

<img src="https://phonecmd.emirbaycan.com.tr/shots/terminal.png" width="240" alt="Live terminal on a phone" />

</div>

---

## Left your build running and walked away? Fix it from the couch.

PhoneCMD turns your phone into a real terminal for the computer you already own. Not a toy — a **persistent shell** that stays alive between commands, so `claude`, `codex`, `aider`, a REPL, a long `npm run build` — all keep going while you check on them from bed, a café, or a train.

**This repo is the desktop half — the part that runs on your PC.** Install it, pair your phone once, done. It's open so you can read and build the exact thing you're trusting with your machine.

<div align="center">
<img src="https://phonecmd.emirbaycan.com.tr/shots/sessions.png" width="200" alt="Coding CLIs" />
<img src="https://phonecmd.emirbaycan.com.tr/shots/files.png" width="200" alt="Files" />
<img src="https://phonecmd.emirbaycan.com.tr/shots/file-editor.png" width="200" alt="Edit files" />
</div>

## What you get

- 🖥️ **A real terminal, not a one-shot.** Every session is a true PTY. Set an env var, `cd` somewhere, start an interactive tool — it's all still there in your next command, exactly like sitting at the machine.
- 🤖 **Coding CLIs from your phone.** It detects Claude, Codex, Gemini, Aider and launches them in a live session you can watch and answer.
- 🧠 **An AI agent that operates the PC for you.** Hand Claude or GPT (your key, your account) a task and watch it run commands, read files, and report back.
- 📁 **Your files.** Browse, read, and edit anything on the machine.
- 🔒 **Truly end-to-end encrypted.** The relay and anyone on the wire see only ciphertext. Your machine's keys never leave it.
- 🌍 **Works anywhere.** Same WiFi → direct LAN. Different continent → through a bundled tunnel. The app picks automatically; you do nothing.

## Get started in 60 seconds

1. **[Download the installer](../../releases/latest)** for your OS. Nothing else to install — the tunnel is bundled.
2. **Open it.** A QR code and a `PCMD-…` keycode appear.
3. **Scan or paste** into the [PhoneCMD phone app](https://phonecmd.emirbaycan.com.tr). Tap **Approve** on your desktop.

That's the whole setup. From then on it reconnects with one tap.

> **Heads up — the installer isn't code-signed** (a certificate costs hundreds a year; this is a free app). Your OS will show a scary-looking warning the first time. It's safe — here's how to get past it:
> - **Windows** → "Windows protected your PC" → **More info → Run anyway**
> - **macOS** → right-click the app → **Open → Open**
> - **Linux** → `chmod +x` the AppImage and run it

## How it works

```
📱 Phone (or the web client)  ──E2E──▶  ws:// LAN direct   ─┐
                              crypto    (same WiFi)         ├─▶  🖥️ THIS APP
                                        wss:// tunnel       ─┘     runs your commands
                                         (relay; ciphertext only)
```

The phone is a thin client; **your PC does the work.** Commands and files travel
phone → (LAN or tunnel) → this app, encrypted the whole way. A lightweight
directory service just tells your phone where the PC is right now — it never
sees a single command or byte of your files.

### Security, in plain terms

- **Nobody can read your traffic** — X25519 handshake + `crypto_box` encryption, end to end. The tunnel carries ciphertext only.
- **Nobody can attach without your OK** — pairing shows an approval prompt naming the device. Nothing connects until you tap **Approve**.
- **Your phone is remembered, so reconnecting is one tap** — but a *new* device always needs a fresh code **and** your approval. Revoke any device anytime.
- **Your AI keys stay on your phone**, in its Keychain, and hit the AI provider directly — never our servers.

<div align="center">
<img src="https://phonecmd.emirbaycan.com.tr/shots/pairing.png" width="200" alt="Pairing" />
<img src="https://phonecmd.emirbaycan.com.tr/shots/pc-options.png" width="200" alt="Saved PCs" />
<img src="https://phonecmd.emirbaycan.com.tr/shots/settings.png" width="200" alt="Settings" />
</div>

---

## For developers

Prefer the terminal? There's a `phonecmd` CLI that drives the same surface — no phone required.

```bash
npm run cli -- run "git status"        # run a command, print output
npm run cli -- clis                    # which coding CLIs are installed
npm run cli -- agent claude "summarize each README under ./src"
npm run cli -- serve --no-tunnel       # start a host + print the QR + keycode
```

### Build it yourself

```bash
npm install
npm run fetch:cloudflared   # vendor the tunnel binary (not committed)
npm run app                 # the desktop app
npm run typecheck && npm test
```

Packaging the installers happens in CI on a tag push — see
[`PACKAGING.md`](PACKAGING.md). Building locally needs a C++ toolchain, because
the real-terminal engine (`node-pty`) is a native module.

---

<div align="center">

**[⬇ Download PhoneCMD](../../releases/latest)** and run your PC from anywhere.

<sub>End-to-end encrypted · open source · no account to try</sub>

</div>
