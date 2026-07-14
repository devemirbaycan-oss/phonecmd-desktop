/**
 * LAN IP detection — find this machine's primary local IPv4 so the pairing QR
 * can advertise a direct ws:// endpoint (for the phone's "WiFi only" option,
 * which bypasses the Cloudflare relay when both are on the same network).
 */

import {networkInterfaces} from 'os';

/**
 * Best-guess primary LAN IPv4 (e.g. 192.168.x.x / 10.x / 172.16–31.x), or null
 * if none found. Prefers private ranges and skips loopback/virtual adapters.
 */
export function lanIpv4(): string | null {
  const ifaces = networkInterfaces();
  const candidates: string[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    // Skip obvious virtual adapters (Docker, WSL, VMware, VirtualBox, Hyper-V).
    if (/^(veth|docker|br-|vEthernet|VMware|VirtualBox|Hyper-V|WSL|utun|llw|awdl)/i.test(name)) {
      continue;
    }
    for (const a of addrs) {
      // Node typings vary: `family` is 'IPv4' (older) or 4 (newer). Compare loosely.
      const fam = a.family as unknown as string | number;
      const isV4 = fam === 'IPv4' || fam === 4;
      if (isV4 && !a.internal && isPrivateV4(a.address)) {
        candidates.push(a.address);
      }
    }
  }
  // Prefer 192.168.* (typical home WiFi), then 10.*, then 172.*.
  candidates.sort((a, b) => rank(a) - rank(b));
  return candidates[0] ?? null;
}

function isPrivateV4(ip: string): boolean {
  return (
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

function rank(ip: string): number {
  if (/^192\.168\./.test(ip)) return 0;
  if (/^10\./.test(ip)) return 1;
  return 2;
}

/** Build a ws:// LAN endpoint for a given port, or null if no LAN IP found. */
export function lanEndpoint(port: number, host?: string): string | null {
  const ip = host || lanIpv4();
  return ip ? `ws://${ip}:${port}` : null;
}
