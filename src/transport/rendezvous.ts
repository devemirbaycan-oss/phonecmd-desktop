/**
 * Rendezvous registration — the host tells the PhoneCMD API "pcId X is reachable
 * at endpoint Y right now", and re-registers on a heartbeat. The phone resolves
 * pcId → live endpoint via the same API, so a paired device is never stranded by
 * a changed address.
 *
 * The pcId (the desktop's public key) is STABLE — it never changes across IP
 * changes, reboots, or network switches. So on each heartbeat we RE-RESOLVE the
 * host's current LAN IP (via refreshLan) and re-register it: if the PC's LAN IP
 * changes while running (DHCP renew, WiFi reconnect), the phone picks up the new
 * one on its next resolve, and LAN connect keeps working. Remote/P2P doesn't even
 * need the endpoint — it reaches the host by pcId through signaling — so it's
 * already immune to IP changes.
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
  /** Recompute the host's current LAN endpoint. Called on every heartbeat so a
   *  changed LAN IP self-heals. Returns null when not on a LAN. */
  refreshLan?: () => string | null;
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
    // Re-resolve the LAN IP each heartbeat so a changed address self-heals.
    const freshLan = this.opts.refreshLan?.() ?? this.lanEndpoint;
    if (freshLan !== this.lanEndpoint) {
      this.opts.log?.(`rendezvous: LAN endpoint changed ${this.lanEndpoint} → ${freshLan}`);
      this.lanEndpoint = freshLan;
      // If the primary endpoint WAS the LAN address (no relay), move it too.
      if (this.endpoint && this.endpoint.startsWith("ws://") && freshLan) {
        this.endpoint = freshLan;
      }
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
