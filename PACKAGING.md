# Packaging & releasing

Uses [electron-builder](https://www.electron.build/). Distribution is
**GitHub Releases** — free hosting, free bandwidth, free build machines.

## Cutting a release

Push a tag. That's it.

```bash
git tag v0.1.0
git push origin v0.1.0
```

[`.github/workflows/release.yml`](.github/workflows/release.yml) then, on
Windows / macOS / Linux runners in parallel:

1. fetches the right `cloudflared` and bundles it (users install nothing extra);
2. runs typecheck + the full test suite — a red test blocks the release;
3. builds the installer;
4. **verifies an installer actually exists** (electron-builder can exit 0 having
   produced nothing — don't publish an empty release);
5. publishes `.exe`, `.dmg`, `.AppImage` to a GitHub Release.

`releases/latest` always points at the newest build, so download links never need
updating.

To exercise the pipeline without publishing: **Actions → Release desktop app →
Run workflow**. It builds and uploads artifacts but creates no Release.

## Building locally

```bash
npm run fetch:cloudflared   # vendor the tunnel binary (gitignored, ~52 MB)
npm run pack:dir            # unpacked app in release/ — fast, for testing
npm run dist                # a real installer for the current OS
```

### You need a C++ toolchain

`node-pty` is a native module. Its shipped prebuilds target **Node's** ABI, but
Electron has a different one, so `@electron/rebuild` recompiles it from source.

| OS | Requirement |
|----|-------------|
| Windows | [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/) → *Desktop development with C++* |
| macOS | `xcode-select --install` |
| Linux | `sudo apt install build-essential` |

Without it you get:

```
gyp ERR! find VS could not use PowerShell to find Visual Studio 2017 or newer
⨯ node-gyp failed to rebuild 'node_modules\node-pty'
```

**This is not cosmetic.** If `node-pty` can't load, the app silently falls back to
piped shells and **loses persistent interactive sessions** — the whole point of
the product. The CI build fails rather than shipping that.

## What gets bundled

`cloudflared` ships **inside** the app (`extraResources` in `package.json`), so
the user installs nothing else. `transport/tunnel.ts` prefers the bundled copy
and falls back to `PATH`.

The binaries are **gitignored** (~52 MB each) and fetched at build time:

```bash
node scripts/fetch-cloudflared.mjs                       # all platforms
node scripts/fetch-cloudflared.mjs --this-platform-only  # just this one (CI)
```

> Cloudflare publishes **no** `cloudflared-windows-arm64` build — Windows-on-ARM
> runs the x64 binary under emulation. (Asking for one used to 404 and kill the
> whole build.)

`adb` is **not** bundled — it's only used by optional developer tooling, and is
resolved from `PHONECMD_ADB` → `ANDROID_HOME/platform-tools` → `PATH`.

## Signing: there is none

Installers are unsigned, so users get a scary dialog. This is a deliberate
zero-cost tradeoff; the download page says so plainly.

| Platform | What the user sees | What they do |
|---|---|---|
| **Windows** | “Windows protected your PC” (SmartScreen) | **More info → Run anyway** |
| **macOS** | “Apple cannot check it for malicious software” | **Right-click → Open → Open** |
| **Linux** | nothing | `chmod +x` and run |

What it would cost to remove:

- **Microsoft Store — $19 one-time.** Kills SmartScreen entirely and adds
  one-click install + auto-updates. By far the best value if you ever spend
  anything.
- Windows code-signing cert — ~$200–400/yr (OV).
- Apple notarization — $99/yr (Developer Program); also the gate for the Mac App
  Store.

## Free distribution channels to add later

All of these point at the same GitHub Release, so they cost nothing to maintain:

- **winget** (Windows) — submit a manifest to `microsoft/winget-pkgs`. No cert
  needed, and `winget install phonecmd` is a first-class install for developers.
- **Homebrew cask** (macOS) — no notarization required for a cask.
- **`.deb` / AUR** (Linux) — add `deb` to `build.linux.target`.
