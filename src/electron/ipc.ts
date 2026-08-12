/**
 * Shared IPC contract between the Electron main process and the renderer.
 * Kept in one file so both sides stay in sync.
 */

import {QrPayload, PairRequest} from '../protocol';

/** One device this host knows — either live now or remembered from before. */
export interface ConnectedDevice {
  deviceName: string;
  /** ISO timestamp: when it connected this session, or when it was first paired. */
  since: string;
  /** True if the device is connected right now; false = remembered (offline). */
  online: boolean;
  /** The device's X25519 public key (base64) — the identity to revoke/rename. */
  publicKey?: string;
  /** User-set label from the desktop (overrides deviceName for display). */
  label?: string;
  /** Pinned to the top of the list. */
  favorite?: boolean;
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
  getLocalhost: 'phonecmd:get-localhost', // renderer → main: read localhost-preview config
  setLocalhost: 'phonecmd:set-localhost', // renderer → main: update localhost-preview config
  forgetDevice: 'phonecmd:forget-device', // renderer → main: revoke a paired device
  renameDevice: 'phonecmd:rename-device', // renderer → main: set a device label
  favoriteDevice: 'phonecmd:favorite-device', // renderer → main: pin/unpin a device
} as const;

/** The localhost-preview config surfaced to / from the settings UI. */
export interface LocalhostConfig {
  enabled: boolean;
  allowPorts: number[];
  denyPorts: number[];
}
