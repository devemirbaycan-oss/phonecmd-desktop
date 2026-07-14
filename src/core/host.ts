/**
 * HostCore — the reusable engine that both the headless CLI and the Electron
 * app drive. Owns the ws server, the Cloudflare tunnel, the session manager, and
 * the command router. Emits lifecycle events so any front-end (terminal or GUI)
 * can render status without knowing the internals.
 *
 * The one thing a front-end MUST provide is how to APPROVE a pairing request:
 * headless auto-accepts; Electron shows a dialog. That's injected via options.
 */

import {EventEmitter} from 'events';
import {WsServer} from '../transport/server';
import {Tunnel} from '../transport/tunnel';
import {pickFreePort} from '../transport/port';
import {lanEndpoint as buildLanEndpoint} from '../transport/lan';
import {Rendezvous} from '../transport/rendezvous';
import {SessionManager} from '../pairing/session';
import {CommandRouter, echoHandler} from '../commands/router';
import {pcfsCommands} from '../pcfs/pcfs';
import {terminalCommands} from '../terminal/terminal';
import {cliDetectCommands} from '../clis/detect';
import {QrPayload, PairRequest} from '../protocol';

export interface HostOptions {
  port?: number;
  /** Skip cloudflared and expose ws://localhost only (offline dev). */
  noTunnel?: boolean;
  /**
   * When noTunnel is set, advertise this host in the QR endpoint instead of
   * "localhost" (e.g. the PC's LAN IP so a phone on the same WiFi can reach it).
   */
  lanHost?: string;
  /**
   * Decide whether to accept a pairing request. Return true to accept.
   * Defaults to auto-accept. Electron overrides this with a real prompt.
   */
  approve?: (req: PairRequest) => Promise<boolean>;
  /**
   * Pairing-window expiry in ms. `null`/omitted = never expires (default).
   * The desktop UI lets the user pick (Never / 1 day / 7 days / …).
   */
  pairingTtlMs?: number | null;
}

export type HostStatus =
  | 'starting'
  | 'tunneling'
  | 'ready'
  | 'stopped'
  | 'error';

export declare interface HostCore {
  on(event: 'status', listener: (s: HostStatus, detail?: string) => void): this;
  on(event: 'log', listener: (msg: string) => void): this;
  on(event: 'qr', listener: (payload: QrPayload) => void): this;
  on(event: 'pair-request', listener: (req: PairRequest) => void): this;
  on(event: 'paired', listener: (deviceName: string) => void): this;
  on(event: 'disconnected', listener: (deviceName: string) => void): this;
}

export class HostCore extends EventEmitter {
  private server: WsServer | null = null;
  private tunnel: Tunnel | null = null;
  private sessions: SessionManager | null = null;
  private _qr: QrPayload | null = null;
  private _lanEndpoint: string | null = null;
  private rendezvous: Rendezvous | null = null;
  private stopped = false;
  private tunnelHealthTimer: NodeJS.Timeout | null = null;
  /** True while a tunnel respawn is in flight (keeps triggers from stacking). */
  private respawning = false;
  /** The port we actually bound (may differ from the requested one). */
  private _port = 0;

  constructor(private opts: HostOptions = {}) {
    super();
  }

  get qr(): QrPayload | null {
    return this._qr;
  }

  async start(): Promise<QrPayload> {
    const preferred = this.opts.port ?? 8787;
    this.emit('status', 'starting');

    // 1. Local ws server.
    //    Pick a port that's free ON LOOPBACK — cloudflared forwards to
    //    http://localhost:<port>, so if another app holds 127.0.0.1:<port> the
    //    tunnel silently lands on IT (404s) even though our 0.0.0.0 bind succeeds.
    const port = await pickFreePort(preferred);
    if (port !== preferred) {
      this.log(
        `port ${preferred} is taken on localhost by another app — using ${port} instead`,
      );
    }
    this._port = port;
    this.server = new WsServer({port});
    await this.server.start();
    this.log(`ws server listening on :${port}`);

    // 2. Endpoint (tunnel or localhost) + a direct LAN endpoint for "WiFi only".
    //    We always try to discover the LAN IP so the QR can offer a relay-free
    //    path when the phone is on the same network.
    const lan = buildLanEndpoint(port, this.opts.lanHost);
    let endpoint: string;
    if (this.opts.noTunnel) {
      endpoint = lan ?? `ws://${this.opts.lanHost ?? 'localhost'}:${port}`;
      this.log(`tunnel skipped — using ${endpoint}`);
    } else {
      this.emit('status', 'tunneling');
      this.tunnel = new Tunnel({port});
      await this.tunnel.start();
      endpoint = this.tunnel.wssUrl()!;
      this.log(`tunnel up: ${endpoint}`);
      if (lan) {
        this.log(`LAN direct also available: ${lan}`);
      }
    }
    this._lanEndpoint = lan;

    // 3. Router: PhoneCMD is PC control. Only PC-side commands are registered —
    //    the terminal (run anything, incl. coding CLIs) and the PC file manager.
    //    (The old ADB/phone-inspection handlers were removed as off-mission.)
    const router = new CommandRouter()
      .register('echo', echoHandler)
      .registerAll(pcfsCommands)
      .registerAll(terminalCommands)
      .registerAll(cliDetectCommands);

    // 4. Session manager. Approval is proxied through an event so a GUI can
    //    show a prompt; if no approver is provided we auto-accept.
    this.sessions = new SessionManager({
      endpoint,
      lanEndpoint: this._lanEndpoint,
      router,
      ttlMs: this.opts.pairingTtlMs ?? null,
      approve: async req => {
        this.emit('pair-request', req);
        const approver = this.opts.approve ?? (async () => true);
        return approver(req);
      },
      log: msg => {
        this.log(msg);
        // A known device logs "reconnected:" rather than "paired:" — both mean a
        // device is now attached, so both must surface to the UI.
        for (const prefix of ['paired: ', 'reconnected: '] as const) {
          if (msg.startsWith(prefix)) {
            this.emit('paired', msg.slice(prefix.length));
            return;
          }
        }
        if (msg.startsWith('disconnected: ')) {
          this.emit('disconnected', msg.slice('disconnected: '.length));
        }
      },
    });
    await this.sessions.init();
    this.server.on('connection', ws => this.sessions!.handleConnection(ws));

    this._qr = this.sessions.qrPayload();
    this.emit('qr', this._qr);

    // Register with the rendezvous API so a phone can resolve pcId → this live
    // endpoint (survives tunnel-URL rotation). Best-effort; LAN + baked endpoint
    // are the fallbacks. Skip when explicitly disabled.
    if (process.env.PHONECMD_NO_RENDEZVOUS !== '1') {
      this.rendezvous = new Rendezvous({
        pcId: this.sessions.pcId(),
        log: msg => this.log(msg),
      });
      this.rendezvous.start(endpoint, this._lanEndpoint);
    }

    // Auto-recover a dead quick tunnel: respawn cloudflared and re-register the
    // new URL so a paired phone can re-resolve it via rendezvous. (Quick tunnels
    // rotate/die often.) Only when we actually run a tunnel.
    if (this.tunnel && !this.opts.noTunnel) {
      this.watchTunnel(port);
    }

    this.emit('status', 'ready');
    this.log('waiting for a device to pair…');
    return this._qr;
  }

  /**
   * Keep the tunnel alive by two independent triggers:
   *
   *   1. process exit  — cloudflared crashed/was killed (the obvious case), and
   *   2. health check  — the tunnel went DEAD WHILE THE PROCESS KEPT RUNNING.
   *      Cloudflare reaps quick tunnels (or a network change strands them) without
   *      the local process exiting, so an exit-only watch never notices. We probe
   *      the tunnel's own public URL every 30s; if it stops answering, we treat it
   *      as dead and respawn — which mints a NEW url, updates the QR, and
   *      re-registers with rendezvous so a paired phone re-resolves automatically.
   */
  private watchTunnel(port: number): void {
    const attach = (t: Tunnel) => {
      t.once('exit', () => {
        if (this.stopped || this.tunnel !== t || this.respawning) {
          return; // already replaced (e.g. by the health check) — ignore
        }
        this.log('tunnel process exited — restarting…');
        void this.respawnTunnel(port, attach);
      });
    };
    if (this.tunnel) {
      attach(this.tunnel);
    }

    // Periodic liveness probe. A tunnel with no URL means the last respawn failed
    // — we must still retry, so that case is treated as "dead" rather than skipped
    // (otherwise a single failed restart would leave the host tunnel-less forever).
    this.tunnelHealthTimer = setInterval(() => {
      if (this.stopped || this.respawning) {
        return;
      }
      const t = this.tunnel;
      if (!t || !t.url) {
        this.log('no live tunnel — retrying…');
        void this.respawnTunnel(port, attach);
        return;
      }
      this.probeTunnel(t.url)
        .then(alive => {
          if (alive || this.stopped || this.respawning || this.tunnel !== t) {
            return;
          }
          this.log('tunnel unreachable (process still running) — respawning…');
          t.stop(); // kill the stale-but-live process before starting a new one
          return this.respawnTunnel(port, attach);
        })
        .catch(() => {
          /* probe/respawn errors are handled inside respawnTunnel */
        });
    }, 30_000);
    this.tunnelHealthTimer.unref?.();
  }

  /**
   * Start a fresh tunnel, adopt its URL everywhere, and keep watching it.
   *
   * A FAILED respawn must not be terminal: cloudflared can exit non-zero for
   * transient reasons (network still flapping, a stale process still holding on).
   * We leave `this.tunnel` null on failure so the next health tick retries — that
   * loop is what guarantees the host eventually gets a working relay back, which
   * is the whole promise of "if the relay dies, get a new one".
   */
  private async respawnTunnel(
    port: number,
    attach: (t: Tunnel) => void,
  ): Promise<void> {
    if (this.respawning || this.stopped) {
      return;
    }
    this.respawning = true;
    try {
      this.tunnel?.stop(); // make sure no old process lingers on the port
      const next = new Tunnel({port});
      await next.start();
      if (this.stopped) {
        next.stop();
        return;
      }
      this.tunnel = next;
      const endpoint = next.wssUrl()!;
      this.log(`tunnel back up: ${endpoint}`);
      if (this.sessions) {
        this._qr = this.sessions.qrPayload(endpoint);
        this.emit('qr', this._qr);
      }
      this.rendezvous?.update(endpoint, this._lanEndpoint);
      attach(next); // watch the new one for exit
    } catch (err) {
      // Leave this.tunnel unset — the health tick sees "no live tunnel" and retries.
      this.tunnel = null;
      this.log(
        `tunnel restart failed: ${(err as Error).message} — will retry`,
      );
    } finally {
      this.respawning = false;
    }
  }

  /**
   * Is the tunnel serving our origin? A response that actually reached our WS
   * server (426 Upgrade Required, 400, 404 …) means the whole path is alive. But
   * a Cloudflare edge error — 502 Bad Gateway or 530 (origin unreachable) — means
   * the edge is up while the tunnel to US is dead, which is the exact failure we
   * heal. And a DNS/connection error / timeout is dead too. Short timeout so a
   * slow probe never stalls the interval.
   */
  private async probeTunnel(httpsUrl: string): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const res = await fetch(httpsUrl, {method: 'HEAD', signal: ctrl.signal});
      // 502/530 = Cloudflare can't reach our origin → tunnel to us is dead.
      if (res.status === 502 || res.status === 530) {
        return false;
      }
      return true; // reached our origin (even a 4xx) → path is alive
    } catch {
      return false; // DNS failure / connection refused / timeout → dead
    } finally {
      clearTimeout(timer);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.tunnelHealthTimer) {
      clearInterval(this.tunnelHealthTimer);
      this.tunnelHealthTimer = null;
    }
    this.rendezvous?.stop();
    this.tunnel?.stop();
    this.server?.stop();
    this.emit('status', 'stopped');
  }

  private log(msg: string): void {
    this.emit('log', msg);
  }
}
