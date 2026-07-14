/**
 * Local WebSocket server. cloudflared tunnels the public wss URL to this.
 *
 * The server is transport-only: it hands each raw connection to the pairing
 * manager, which runs the handshake and (on success) upgrades the socket to an
 * encrypted session. This module knows nothing about crypto or commands.
 */

import { WebSocketServer, WebSocket } from "ws";
import { EventEmitter } from "events";

export interface WsServerOptions {
  port: number;
  /**
   * Interface to bind. Defaults to 0.0.0.0 (ALL interfaces) so a phone on the
   * same LAN can reach the host — NOT just localhost. Without this, `ws` may
   * resolve the default to 127.0.0.1 on some setups, and LAN pairing silently
   * fails (the phone can't open the socket).
   */
  host?: string;
}

export declare interface WsServer {
  on(event: "connection", listener: (ws: WebSocket) => void): this;
  on(event: "listening", listener: (port: number) => void): this;
}

export class WsServer extends EventEmitter {
  private wss: WebSocketServer | null = null;

  constructor(private opts: WsServerOptions) {
    super();
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({
        port: this.opts.port,
        host: this.opts.host ?? "0.0.0.0",
      });

      this.wss.on("listening", () => {
        this.emit("listening", this.opts.port);
        resolve(this.opts.port);
      });

      this.wss.on("connection", (ws) => {
        this.emit("connection", ws);
      });

      this.wss.on("error", reject);
    });
  }

  stop(): void {
    this.wss?.close();
    this.wss = null;
  }
}
