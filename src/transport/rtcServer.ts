/**
 * RtcServer — the P2P counterpart to WsServer. Instead of accepting incoming
 * WebSocket connections, it polls the signaling server for a phone's WebRTC
 * offer, answers it with node-datachannel, and — once the data channel opens —
 * emits a `connection` event carrying a channel ADAPTER that presents the exact
 * `ws`-like surface SessionManager.handleConnection() already consumes
 * (on('message') / on('close') / send / close).
 *
 * That adapter is the whole trick: the pairing + crypto + command layers never
 * learn they're on a data channel instead of a socket. See P2P-DESIGN.md.
 *
 * Signaling (matchmaking only — no session traffic) goes through the live
 * endpoints on the control-plane API:
 *   POST /rtc/signal/{pcId} {role:'host', data}   — send offer-answer/candidates
 *   GET  /rtc/signal/{pcId}?role=host             — drain the phone's messages
 * All actual session bytes flow DIRECT phone↔PC over the data channel.
 */

import {EventEmitter} from 'events';
import * as dc from 'node-datachannel';

const DEFAULT_API = 'https://phonecmd.emirbaycan.com.tr/api';
/** How often the host asks the signaling server "any phone trying to reach me?" */
const POLL_MS = 2000;
/** Public STUN — enough for ~85-90% of networks (see P2P-DESIGN.md, STUN-only). */
const ICE_SERVERS = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

export interface RtcServerOptions {
  pcId: string;
  apiBase?: string;
}

/**
 * A data channel dressed up as the `ws` object handleConnection expects. Only
 * the members that code touches are implemented: on('message'|'close'), send,
 * close. Everything is driven by the underlying node-datachannel DataChannel.
 */
class ChannelSocket extends EventEmitter {
  private closed = false;
  constructor(
    private channel: dc.DataChannel,
    private pc: dc.PeerConnection,
    private onGone: () => void,
  ) {
    super();
    channel.onMessage(msg => {
      // node-datachannel delivers string or Buffer; the protocol is JSON text.
      this.emit('message', typeof msg === 'string' ? msg : msg.toString());
    });
    channel.onClosed(() => this.fireClose());
    // If the peer connection itself drops (ICE failed / phone gone), close too.
    pc.onStateChange(state => {
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.fireClose();
      }
    });
  }

  /** ws.send — the command layer calls this with JSON strings. */
  send(data: string): void {
    if (!this.closed) {
      try {
        this.channel.sendMessage(data);
      } catch {
        /* channel went away between checks — treat as closed */
        this.fireClose();
      }
    }
  }

  /** ws.close — tear down the whole peer connection for this phone. */
  close(): void {
    this.fireClose();
  }

  private fireClose(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.channel.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
    this.emit('close');
    this.onGone();
  }
}

export declare interface RtcServer {
  on(event: 'connection', listener: (ws: ChannelSocket) => void): this;
  on(event: 'log', listener: (msg: string) => void): this;
}

export class RtcServer extends EventEmitter {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private api: string;
  // One in-flight PeerConnection per phone offer we're mid-handshake on, keyed
  // by a nonce so a retry from the same phone doesn't spawn duplicates.
  private pending = new Map<string, dc.PeerConnection>();
  // Candidates that arrived before their offer built the PC — buffered by nonce
  // and flushed once answerOffer creates the connection.
  private earlyCandidates = new Map<string, {candidate: string; mid: string}[]>();

  constructor(private opts: RtcServerOptions) {
    super();
    this.api = (opts.apiBase ?? DEFAULT_API).replace(/\/$/, '');
  }

  /** Begin polling for phones trying to establish a P2P session.
   *
   *  Fully best-effort: if node-datachannel isn't usable in this environment
   *  (missing native binary, test stub), P2P simply doesn't come up — the WS/LAN
   *  path still works and host startup must NOT fail because of it. */
  start(): void {
    // Sanity-check the native binding by creating (and discarding) a peer
    // connection. initLogger() is intentionally NOT called — it's optional
    // (log verbosity only) and its binding is broken on some Node builds, which
    // would otherwise take down an otherwise-working P2P path.
    try {
      const probe = new dc.PeerConnection('probe', {iceServers: ICE_SERVERS});
      probe.close();
    } catch {
      this.log('rtc: node-datachannel unavailable — P2P disabled');
      return;
    }
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    this.pollTimer.unref?.();
    void this.poll();
    this.log('rtc: signaling poll started');
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const pc of this.pending.values()) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    this.pending.clear();
    // Release node-datachannel's global ICE thread so the process can exit.
    try {
      dc.cleanup();
    } catch {
      /* ignore */
    }
  }

  /** Drain any signaling messages the phone posted, and handle offers. */
  private async poll(): Promise<void> {
    if (this.stopped) return;
    let batch: {messages?: string[]} | null = null;
    try {
      // pcId goes in the QUERY, never the path: it's base64 and can contain '/',
      // which Apache (AllowEncodedSlashes off) 404s both raw and as %2F — that
      // silently killed P2P for every host whose key had a slash. The '+' and
      // '=' also mangle in paths (a '+' decodes as a space), splitting the
      // mailbox in two so both sides saw HTTP 200 and an empty queue.
      const res = await fetch(
        `${this.api}/rtc/signal?pcId=${encodeURIComponent(this.opts.pcId)}&role=host`,
        {method: 'GET'},
      );
      if (!res.ok) return;
      batch = (await res.json()) as {messages?: string[]};
    } catch {
      return; // network blip — try again next tick
    }
    for (const raw of batch?.messages ?? []) {
      try {
        const msg = JSON.parse(raw) as SignalMsg;
        await this.handleSignal(msg);
      } catch {
        /* malformed signal — ignore */
      }
    }
  }

  /** Post a signaling message back to a specific phone. The phone's `nonce`
   *  (carried in every SignalMsg) routes it to that phone's mailbox so two
   *  phones handshaking with this PC at once don't drain each other's answers. */
  private async postSignal(msg: SignalMsg): Promise<void> {
    try {
      await fetch(`${this.api}/rtc/signal?pcId=${encodeURIComponent(this.opts.pcId)}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({role: 'host', nonce: msg.nonce ?? '', data: JSON.stringify(msg)}),
      });
    } catch {
      /* the phone will retry its offer if it never gets an answer */
    }
  }

  private async handleSignal(msg: SignalMsg): Promise<void> {
    if (msg.type === 'offer') {
      await this.answerOffer(msg);
      // Apply any candidates that arrived before the offer built the PC.
      const early = this.earlyCandidates.get(msg.nonce ?? '');
      if (early) {
        this.earlyCandidates.delete(msg.nonce ?? '');
        const pc = this.pending.get(msg.nonce ?? '');
        for (const c of early) {
          try {
            pc?.addRemoteCandidate(c.candidate, c.mid);
          } catch {
            /* ignore */
          }
        }
      }
    } else if (msg.type === 'candidate' && msg.nonce && msg.candidate) {
      const pc = this.pending.get(msg.nonce);
      if (pc) {
        try {
          pc.addRemoteCandidate(msg.candidate, msg.mid ?? '0');
        } catch {
          /* candidate races the description sometimes — libdatachannel tolerates */
        }
      } else {
        // Candidate arrived before the offer created the PC — buffer it so ICE
        // doesn't lose paths. Applied right after answerOffer builds the PC.
        const buf = this.earlyCandidates.get(msg.nonce) ?? [];
        buf.push({candidate: msg.candidate, mid: msg.mid ?? '0'});
        this.earlyCandidates.set(msg.nonce, buf);
      }
    }
  }

  /** The phone sent an SDP offer → create a PeerConnection, answer, and wait
   *  for its data channel to open. */
  private async answerOffer(msg: SignalMsg): Promise<void> {
    const nonce = msg.nonce ?? Math.random().toString(36).slice(2);
    // Ignore a duplicate offer for a handshake already in progress.
    if (this.pending.has(nonce)) return;

    const pc = new dc.PeerConnection(`phone-${nonce}`, {iceServers: ICE_SERVERS});
    this.pending.set(nonce, pc);

    // Register EVERY callback BEFORE setRemoteDescription. node-datachannel
    // generates the answer synchronously the moment the remote offer is set, so
    // onLocalDescription MUST already be attached — registering it afterward
    // (the original bug) meant the answer fired into no listener and was never
    // posted back to the phone, so ICE could gather candidates but never
    // complete. onLocalCandidate/onDataChannel likewise must precede it.
    pc.onLocalDescription((sdp, type) => {
      this.log(`rtc: answering phone ${nonce.slice(0, 6)}`);
      void this.postSignal({type: type as 'answer', nonce, sdp});
    });
    pc.onLocalCandidate((candidate, mid) => {
      // CRITICAL: node-datachannel emits the candidate WITH the SDP line prefix
      // ("a=candidate:..."), but RTCIceCandidate.candidate on the phone
      // (react-native-webrtc / libwebrtc) requires the BARE form
      // ("candidate:..."). Passed through as-is, libwebrtc silently rejects every
      // host candidate, so ICE never pairs and the data channel never opens —
      // even on a directly-reachable LAN. Strip the prefix here so both stacks
      // agree. This was THE bug behind "connects/negotiates but never connects".
      void this.postSignal({type: 'candidate', nonce, candidate: candidate.replace(/^a=/, ''), mid});
    });
    // The phone is the offerer and creates the channel; we receive it.
    pc.onDataChannel(channel => {
      const sock = new ChannelSocket(channel, pc, () => this.pending.delete(nonce));
      channel.onOpen(() => {
        this.log(`rtc: data channel open (phone ${nonce.slice(0, 6)})`);
        this.emit('connection', sock);
      });
    });

    try {
      // Now adopt the offer — this fires onLocalDescription (the answer) which
      // the handler above ships back through signaling.
      pc.setRemoteDescription(msg.sdp!, 'offer');
      this.log(`rtc: got offer from phone ${nonce.slice(0, 6)}`);
    } catch (e) {
      this.log(`rtc: failed to answer offer — ${(e as Error).message}`);
      pc.close();
      this.pending.delete(nonce);
    }
  }

  private log(m: string): void {
    this.emit('log', m);
  }
}

/** Signaling message shapes (opaque to the server; produced/consumed here). */
interface SignalMsg {
  type: 'offer' | 'answer' | 'candidate';
  nonce?: string;
  sdp?: string;
  candidate?: string;
  mid?: string;
}
