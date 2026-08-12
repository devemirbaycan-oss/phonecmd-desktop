/**
 * Localhost Preview — `net.proxy` command.
 *
 * Lets a PAIRED phone view a service on THIS PC's loopback (e.g. a dev server at
 * http://localhost:3000) in the phone's browser, relayed over the existing E2E
 * channel. The phone sends only a PORT + path/method/headers/body; the host does
 * the actual fetch against 127.0.0.1 and streams the response back.
 *
 * SECURITY — this is the whole point of the guardrails:
 *  - OFF by default. Rejected unless the user enabled it in desktop settings.
 *  - LOCALHOST ONLY. The target host is hardcoded 127.0.0.1; the phone can NOT
 *    supply a hostname, so this can never become an open proxy into the LAN
 *    (routers, 169.254.169.254, internal admin panels) or the internet.
 *  - PORT POLICY. An optional allow-list restricts to specific ports; a deny-list
 *    always wins. So a cautious user can expose just :3000, or block :5432 etc.
 * Because it rides the authenticated channel, it grants a trusted phone a subset
 * of what the terminal already can (`curl localhost:PORT`) — no new outsider
 * surface, just a browser-friendly wrapper.
 */

import {loadSettings} from '../electron/settings';
import {CommandHandler} from '../commands/router';

/** Decide whether a loopback port may be reached, given the user's policy.
 *  Deny always wins; a non-empty allow-list is exclusive (only those pass). */
export function portAllowed(
  port: number,
  policy: {allow: number[]; deny: number[]},
): boolean {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (policy.deny.includes(port)) return false;
  if (policy.allow.length > 0) return policy.allow.includes(port);
  return true;
}

/** Why a proxy request was refused (surfaced to the phone so it can explain). */
export type ProxyDenial = 'disabled' | 'bad-port' | 'port-blocked';

/** Pure gate: is this request permitted right now? Returns null if allowed, else
 *  the reason. Reads live settings so a toggle change takes effect immediately. */
export function checkProxyAllowed(port: unknown): ProxyDenial | null {
  const s = loadSettings();
  if (!s.localhostPreview) return 'disabled';
  const p = typeof port === 'number' ? port : Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return 'bad-port';
  if (!portAllowed(p, {allow: s.localhostAllowPorts, deny: s.localhostDenyPorts})) {
    return 'port-blocked';
  }
  return null;
}

export interface ProxyResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Response body, base64 so binary assets (images, fonts) survive JSON. */
  bodyBase64: string;
}

/**
 * net.proxy — args:
 *   port   number   loopback port on THIS PC (required)
 *   path   string   request path incl. query, e.g. "/app.js?v=2" (default "/")
 *   method string   HTTP method (default "GET")
 *   headers {}       request headers to forward (host is overridden)
 *   bodyBase64 string  request body for POST/PUT (optional)
 * Returns ProxyResult, or throws with a clear message the app maps to a page.
 */
export const netProxyHandler: CommandHandler = async args => {
  const port = args?.port;
  const denial = checkProxyAllowed(port);
  if (denial === 'disabled') {
    throw new Error('localhost preview is off — enable it in the desktop app');
  }
  if (denial === 'bad-port') {
    throw new Error('invalid port');
  }
  if (denial === 'port-blocked') {
    throw new Error(`port ${port} is not allowed by this PC's localhost policy`);
  }

  const p = Number(port);
  const path = typeof args?.path === 'string' && args.path.startsWith('/') ? args.path : '/';
  const method = typeof args?.method === 'string' ? args.method.toUpperCase() : 'GET';
  // Forward the caller's headers but force Host to loopback and strip hop-by-hop.
  const inHeaders = (args?.headers && typeof args.headers === 'object' ? args.headers : {}) as Record<string, string>;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(inHeaders)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'connection' || lk === 'content-length') continue;
    if (typeof v === 'string') headers[k] = v;
  }
  headers['host'] = `127.0.0.1:${p}`;

  const body =
    typeof args?.bodyBase64 === 'string' && args.bodyBase64
      ? Buffer.from(args.bodyBase64, 'base64')
      : undefined;

  // The URL host is ALWAYS 127.0.0.1 — never anything the phone supplied.
  const url = `http://127.0.0.1:${p}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'manual', // let the phone's browser handle redirects
    });
  } catch (e: any) {
    throw new Error(`nothing is running on localhost:${p} (${e?.message ?? 'connection failed'})`);
  }

  const outHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    // Drop hop-by-hop / encoding headers fetch already resolved.
    const lk = k.toLowerCase();
    if (lk === 'content-encoding' || lk === 'transfer-encoding' || lk === 'connection') return;
    outHeaders[k] = v;
  });

  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    statusText: res.statusText,
    headers: outHeaders,
    bodyBase64: buf.toString('base64'),
  } as ProxyResult;
};

export const netCommands: Record<string, CommandHandler> = {
  'net.proxy': netProxyHandler,
};
