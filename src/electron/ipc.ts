/**
 * Shared IPC contract between the Electron main process and the renderer.
 * Kept in one file so both sides stay in sync.
 */

import {QrPayload, PairRequest} from '../protocol';

/** One device currently paired to this host. */
export interface ConnectedDevice {
  deviceName: string;
  /** ISO timestamp of when it paired. */
  since: string;
}

/** Events pushed main → renderer. */
export interface HostToRenderer {
  status: {status: string; detail?: string};
  log: {message: string};
  /**
   * The pairing payload, rendered every way the user might need it: the QR image,
   * the copy-pasteable `PCMD-…` keycode, and the raw endpoints.
   */
  qr: {
    payload: QrPayload;
    qrDataUrl: string;
    /** The single `PCMD-…` string that carries everything (the paste path). */
    keycode: string;
  };
  'pair-request': {req: PairRequest; requestId: string};
  /** A pending pair-request expired host-side; the renderer must drop its prompt. */
  'pair-cancelled': {requestId: string};
  paired: {deviceName: string};
  disconnected: {deviceName: string};
  /** Available pairing-expiry presets + the current selection. */
  'ttl-options': {
    options: {id: string; label: string}[];
    current: string;
  };
  /** The live list of paired devices (replaces the list wholesale). */
  devices: {devices: ConnectedDevice[]};
  /** Free-tier usage for the whole host today (x of limit). */
  usage: {used: number; limit: number; remaining: number};
}

/** Invocations renderer → main (request/response). */
export interface RendererToHost {
  /** Resolve a pending pairing prompt. */
  'approve-pairing': {requestId: string; approved: boolean};
  /** (Re)start the host and get a fresh QR. */
  'restart-host': void;
}

export const CHANNEL = {
  event: 'phonecmd:event', // main → renderer (typed by HostToRenderer)
  approve: 'phonecmd:approve', // renderer → main
  restart: 'phonecmd:restart', // renderer → main
  setTtl: 'phonecmd:set-ttl', // renderer → main: change pairing expiry
  copy: 'phonecmd:copy', // renderer → main: copy text to the clipboard
  version: 'phonecmd:version', // renderer → main: get app version
  getAutoUpdate: 'phonecmd:get-auto-update', // renderer → main
  setAutoUpdate: 'phonecmd:set-auto-update', // renderer → main
} as const;
