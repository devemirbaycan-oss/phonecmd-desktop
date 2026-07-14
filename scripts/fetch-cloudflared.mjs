/**
 * Downloads the cloudflared binaries for all target platforms into
 * desktop/resources/cloudflared/, so electron-builder can bundle them
 * (extraResources) and the shipped app spawns its own copy — users install
 * nothing.
 *
 * Run: node scripts/fetch-cloudflared.mjs [--this-platform-only]
 *
 * Binaries come from Cloudflare's official GitHub releases. We pin "latest" by
 * default; pass CLOUDFLARED_VERSION=2024.x.x to pin a specific tag.
 */

import {createWriteStream, mkdirSync, existsSync, chmodSync, renameSync, rmSync} from 'fs';
import {execFileSync} from 'child_process';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'resources', 'cloudflared');

const VERSION = process.env.CLOUDFLARED_VERSION || 'latest';
const base =
  VERSION === 'latest'
    ? 'https://github.com/cloudflare/cloudflared/releases/latest/download'
    : `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}`;

/**
 * Map our bundled filenames → Cloudflare's release asset names.
 *
 * These are the assets Cloudflare ACTUALLY publishes. Notably there is no
 * `cloudflared-windows-arm64.exe` — asking for one 404s and (before this note)
 * killed the whole build. Windows-on-ARM runs the x64 binary under emulation,
 * so win-x64 covers it.
 *
 * macOS ships as .tgz, so those are extracted rather than saved directly.
 */
const TARGETS = [
  {out: 'cloudflared-win-x64.exe', asset: 'cloudflared-windows-amd64.exe'},
  {out: 'cloudflared-mac-x64', asset: 'cloudflared-darwin-amd64.tgz', tgz: true},
  {out: 'cloudflared-mac-arm64', asset: 'cloudflared-darwin-arm64.tgz', tgz: true},
  {out: 'cloudflared-linux-x64', asset: 'cloudflared-linux-amd64'},
  {out: 'cloudflared-linux-arm64', asset: 'cloudflared-linux-arm64'},
];

const thisPlatformOnly = process.argv.includes('--this-platform-only');

function currentTargets() {
  if (!thisPlatformOnly) return TARGETS;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const plat =
    process.platform === 'win32'
      ? 'win'
      : process.platform === 'darwin'
      ? 'mac'
      : 'linux';
  return TARGETS.filter(t => t.out.includes(`${plat}-${arch}`));
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 10) return reject(new Error('too many redirects'));
    https
      .get(url, {headers: {'User-Agent': 'phonecmd-build'}}, res => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          return resolve(download(res.headers.location, dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

async function main() {
  mkdirSync(OUT_DIR, {recursive: true});
  const targets = currentTargets();
  console.log(
    `Fetching cloudflared (${VERSION}) for: ${targets.map(t => t.out).join(', ')}`,
  );

  const failed = [];

  for (const t of targets) {
    const dest = join(OUT_DIR, t.out);
    if (existsSync(dest)) {
      console.log(`  ✓ ${t.out} (already present)`);
      continue;
    }

    // macOS assets are .tgz. Extract the single `cloudflared` binary out of the
    // archive so the bundled layout is the same on every platform.
    if (t.tgz) {
      const tmp = `${dest}.tgz`;
      process.stdout.write(`  ↓ ${t.out} (tgz) … `);
      try {
        await download(`${base}/${t.asset}`, tmp);
        // `tar` ships with Windows 10+, macOS, and Linux.
        execFileSync('tar', ['-xzf', tmp, '-C', OUT_DIR], {stdio: 'ignore'});
        renameSync(join(OUT_DIR, 'cloudflared'), dest);
        rmSync(tmp, {force: true});
        chmodSync(dest, 0o755);
        console.log('done');
      } catch (e) {
        rmSync(tmp, {force: true});
        console.log(`FAILED (${e.message})`);
        failed.push(t.out);
      }
      continue;
    }

    process.stdout.write(`  ↓ ${t.out} … `);
    try {
      await download(`${base}/${t.asset}`, dest);
      if (!t.out.endsWith('.exe')) {
        chmodSync(dest, 0o755);
      }
      console.log('done');
    } catch (e) {
      // One unavailable platform must not kill the whole build — you can still
      // ship the platforms that did fetch.
      console.log(`FAILED (${e.message})`);
      failed.push(t.out);
    }
  }

  console.log('\ncloudflared binaries in resources/cloudflared/:');
  for (const t of TARGETS) {
    const dest = join(OUT_DIR, t.out);
    console.log(`  ${existsSync(dest) ? '✓' : '✗'} ${t.out}`);
  }
  if (failed.length) {
    console.log(
      `\nWARNING: could not fetch: ${failed.join(', ')}. Those platforms cannot be packaged.`,
    );
  }
}

main().catch(err => {
  console.error('fetch-cloudflared failed:', err.message);
  process.exit(1);
});
