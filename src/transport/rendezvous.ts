/**
 * Rendezvous registration — the host tells the PhoneCMD API "pcId X is reachable
 * at endpoint Y right now", and re-registers on a heartbeat + whenever the
 * endpoint changes (e.g. a Cloudflare quick tunnel rotated). The phone resolves
 * pcId → live endpoint via the same API, so a rotated tunnel URL never strands a
 * paired device.
 *
 * Best-effort: if the API is unreachable, LAN-direct pairing still works and the
 * baked endpoint in the keycode is the fallback. Registration failures are logged
 * but never crash the host.
 */

const DEFAULT_API = "https://phonecmd.emirbaycan.com.tr/api";
const HEARTBEAT_MS = 60_000; // must be < server PcFreshnessMs (90s)

export interface RendezvousOptions {
  pcId: string;
  apiBase?: string;
  log?: (msg: string) => void;
}

export class Rendezvous {
  private readonly apiBase: string;
  private timer: NodeJS.Timeout | null = null;
  private endpoint: string | null = null;
  private lanEndpoint: string | null = null;

  constructor(private opts: RendezvousOptions) {
    this.apiBase = (opts.apiBase ?? process.env.PHONECMD_API ?? DEFAULT_API).replace(/\/$/, "");
  }

  /** Start (or update) registration for the current endpoints + heartbeat. */
  start(endpoint: string, lanEndpoint: string | null): void {
    this.endpoint = endpoint;
    this.lanEndpoint = lanEndpoint;
    void this.register();
    if (!this.timer) {
      this.timer = setInterval(() => void this.register(), HEARTBEAT_MS);
      // Don't keep the process alive just for the heartbeat.
      this.timer.unref?.();
    }
  }

  /** Update the endpoint (e.g. tunnel rotated) and re-register immediately. */
  update(endpoint: string, lanEndpoint: string | null): void {
    if (endpoint === this.endpoint && lanEndpoint === this.lanEndpoint) {
      return;
    }
    this.start(endpoint, lanEndpoint);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async register(): Promise<void> {
    if (!this.endpoint) {
      return;
    }
    try {
      const res = await fetch(`${this.apiBase}/pc/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pcId: this.opts.pcId,
          endpoint: this.endpoint,
          lanEndpoint: this.lanEndpoint,
        }),
      });
      if (!res.ok) {
        this.opts.log?.(`rendezvous register failed: ${res.status}`);
      }
    } catch (e) {
      this.opts.log?.(`rendezvous register error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
