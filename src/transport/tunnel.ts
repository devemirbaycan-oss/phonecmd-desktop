/**
 * Cloudflare quick-tunnel manager.
 *
 * Spawns `cloudflared tunnel --url http://localhost:<port>` and captures the
 * ephemeral `https://<random>.trycloudflare.com` URL it prints to stderr. That
 * URL lives as long as this process, which is exactly the session lifetime — so
 * we bake it (as wss://) into the pairing QR.
 *
 * Quick tunnels need no Cloudflare account. The `cloudflared` binary is BUNDLED
 * with the app (electron-builder extraResources), so users install nothing —
 * see resolveCloudflared() for the lookup order.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { existsSync } from "fs";
import { join } from "path";

// Quick-tunnel hostnames are always multiple hyphenated words
// (e.g. modern-delete-discover-whom.trycloudflare.com). cloudflared's banner
// also prints `trycloudflare.com` and control hosts like `api.trycloudflare.com`
// — require at least one hyphen and exclude the known non-tunnel subdomains so we
// never capture those by mistake.
const TRYCLOUDFLARE_RE =
  /https:\/\/(?!api\.|www\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/i;

/** Per-platform bundled binary filename. */
function bundledBinaryName(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "win32") return `cloudflared-win-${arch}.exe`;
  if (process.platform === "darwin") return `cloudflared-mac-${arch}`;
  return `cloudflared-linux-${arch}`;
}

/**
 * Resolve the cloudflared binary. Lookup order:
 *   1. PHONECMD_CLOUDFLARED env override
 *   2. packaged app resources (process.resourcesPath/cloudflared/…) — production
 *   3. repo ./resources/cloudflared/… — dev
 *   4. bare "cloudflared" on PATH — last-resort dev fallback
 * The bundled binary means the shipped app needs nothing installed.
 */
export function resolveCloudflared(): string {
  if (process.env.PHONECMD_CLOUDFLARED) {
    return process.env.PHONECMD_CLOUDFLARED;
  }
  const name = bundledBinaryName();
  const candidates: string[] = [];
  // Packaged (Electron sets process.resourcesPath).
  const resourcesPath = (process as NodeJS.Process & {
    resourcesPath?: string;
  }).resourcesPath;
  if (resourcesPath) {
    candidates.push(join(resourcesPath, "cloudflared", name));
  }
  // Dev: repo resources dir (two levels up from dist/transport or src/transport).
  candidates.push(join(__dirname, "..", "..", "resources", "cloudflared", name));
  candidates.push(join(process.cwd(), "resources", "cloudflared", name));

  for (const c of candidates) {
    if (existsSync(c)) {
      return c;
    }
  }
  return "cloudflared"; // PATH fallback (dev machines that have it installed)
}

/** Extract a trycloudflare URL from a chunk of cloudflared output, or null. */
export function extractTunnelUrl(text: string): string | null {
  const match = text.match(TRYCLOUDFLARE_RE);
  return match ? match[0] : null;
}

/** Convert an https tunnel URL to the wss URL clients dial. */
export function toWssUrl(httpsUrl: string): string {
  return httpsUrl.replace(/^https:/, 'wss:');
}

export interface TunnelOptions {
  port: number;
  /** Override the binary name/path if cloudflared isn't on PATH. */
  bin?: string;
}

export declare interface Tunnel {
  on(event: "url", listener: (url: string) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
}

export class Tunnel extends EventEmitter {
  private proc: ChildProcess | null = null;
  private _url: string | null = null;

  constructor(private opts: TunnelOptions) {
    super();
  }

  get url(): string | null {
    return this._url;
  }

  /** Start cloudflared and resolve once the public URL is captured. */
  start(timeoutMs = 20_000): Promise<string> {
    const bin = this.opts.bin ?? resolveCloudflared();
    const args = [
      "tunnel",
      "--url",
      `http://localhost:${this.opts.port}`,
      // trycloudflare requires this on newer cloudflared for quick tunnels
      "--no-autoupdate",
    ];

    this.proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `cloudflared did not report a tunnel URL within ${timeoutMs}ms. ` +
              `Is the 'cloudflared' binary installed and on PATH?`
          )
        );
      }, timeoutMs);

      const scan = (buf: Buffer) => {
        const url = extractTunnelUrl(buf.toString());
        if (url && !this._url) {
          this._url = url;
          clearTimeout(timer);
          this.emit("url", this._url);
          resolve(this._url);
        }
      };

      // cloudflared prints the URL to stderr; scan both to be safe.
      this.proc!.stderr?.on("data", scan);
      this.proc!.stdout?.on("data", scan);

      this.proc!.on("error", (err) => {
        clearTimeout(timer);
        this.emit("error", err);
        reject(err);
      });

      this.proc!.on("exit", (code) => {
        this.emit("exit", code);
        if (!this._url) {
          clearTimeout(timer);
          reject(new Error(`cloudflared exited (code ${code}) before a URL was captured.`));
        }
      });
    });
  }

  /** Convert the captured https URL into the wss URL clients should dial. */
  wssUrl(): string | null {
    return this._url ? toWssUrl(this._url) : null;
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }
}
