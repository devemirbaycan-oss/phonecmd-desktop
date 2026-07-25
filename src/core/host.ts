/**
 * HostCore — the reusable engine that both the headless CLI and the Electron
 * app drive. Owns the ws server (LAN-direct), the WebRTC P2P server (remote),
 * the session manager, and the command router. Emits lifecycle events so any
 * front-end (terminal or GUI) can render status without knowing the internals.
 *
 * There is no relay tunnel: cloudflared was removed in favour of P2P. A phone on
 * the same network connects over the LAN ws endpoint; a phone anywhere else
 * connects over a WebRTC data channel (see transport/rtcServer.ts).
 *
 * The one thing a front-end MUST provide is how to APPROVE a pairing request:
 * headless auto-accepts; Electron shows a dialog. That's injected via options.
 */

import {EventEmitter} from 'events';
import {WsServer} from '../transport/server';
import {RtcServer} from '../transport/rtcServer';
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
  /**
   * Accepted but ignored — kept so existing callers/scripts don't break. There
   * is no tunnel any more; the host is always LAN-direct + P2P.
   * @deprecated
   */
  noTunnel?: boolean;
  /**
   * Advertise this host in the QR endpoint instead of "localhost" (e.g. the PC's
   * LAN IP so a phone on the same WiFi can reach it directly).
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
  /**
   * Accepted but ignored — cloudflared is gone. Kept so existing callers and
   * tests don't fail to compile.
   * @deprecated
   */
  cloudflaredBin?: string;
}

export type HostStatus = 'starting' | 'ready' | 'stopped' | 'error';

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
  private rtc: RtcServer | null = null;
  private sessions: SessionManager | null = null;
  private _qr: QrPayload | null = null;
  private _lanEndpoint: string | null = null;
  private rendezvous: Rendezvous | null = null;
  private stopped = false;
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

    // 2. Endpoint. There is NO relay tunnel any more — remote reach is P2P
    //    (WebRTC, set up in step 5). cloudflared was removed: it was a fragile
    //    dependency (quick-tunnel URLs rotate, rate-limit with HTTP 429, and
    //    404 for seconds after cloudflared prints them), and when it failed the
    //    host advertised its LAN IP under a "Relay" label — an address no phone
    //    off the network could reach.
    //
    //    So the ws endpoint is now purely the LAN-direct path, used when the
    //    phone is on the same network (or has "WiFi only" on). Off-network
    //    phones connect over the WebRTC data channel instead.
    const lan = buildLanEndpoint(port, this.opts.lanHost);
    const endpoint = lan ?? `ws://${this.opts.lanHost ?? 'localhost'}:${port}`;
    this._lanEndpoint = lan;
    this.log(
      lan
        ? `LAN direct: ${endpoint} · remote access via P2P`
        : `no LAN address found — ${endpoint} (remote access via P2P)`,
    );

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

    // P2P: also accept phones over a direct WebRTC data channel (signaling via
    // the control-plane API). The channel adapter looks exactly like the `ws`
    // handleConnection consumes, so pairing/crypto/commands are unchanged. This
    // is what lets a phone on cellular reach the host without a relay tunnel.
    // Runs ALONGSIDE the WS server — LAN/WS keeps working; P2P is additive.
    if (process.env.PHONECMD_NO_P2P !== '1') {
      this.rtc = new RtcServer({pcId: this.sessions.pcId()});
      this.rtc.on('connection', ch => this.sessions!.handleConnection(ch as never));
      this.rtc.on('log', msg => this.log(msg));
      this.rtc.start();
    }

    this._qr = this.sessions.qrPayload();
    this.emit('qr', this._qr);

    // Register with the rendezvous API so a phone can resolve pcId → this live
    // endpoint. Best-effort; the baked endpoint is the fallback. The pcId is
    // stable, so a phone stays paired across the host's IP changes: the heartbeat
    // re-resolves the current LAN IP (refreshLan) and re-registers it, and P2P
    // reaches the host by pcId regardless. Skip when explicitly disabled.
    if (process.env.PHONECMD_NO_RENDEZVOUS !== '1') {
      this.rendezvous = new Rendezvous({
        pcId: this.sessions.pcId(),
        log: msg => this.log(msg),
        // Recompute the LAN endpoint each heartbeat so a changed IP self-heals.
        refreshLan: () => {
          const lan = buildLanEndpoint(port, this.opts.lanHost);
          this._lanEndpoint = lan;
          return lan;
        },
      });
      this.rendezvous.start(endpoint, this._lanEndpoint);
    }

    this.emit('status', 'ready');
    this.log('waiting for a device to pair…');
    return this._qr;
  }


  stop(): void {
    this.stopped = true;
    this.rendezvous?.stop();
    this.server?.stop();
    this.rtc?.stop(); // stops signaling poll + releases node-datachannel's ICE thread
    this.emit('status', 'stopped');
  }

  private log(msg: string): void {
    this.emit('log', msg);
  }
}
