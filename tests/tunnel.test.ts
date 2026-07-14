/**
 * Tunnel URL parsing — extracting the trycloudflare URL from cloudflared's
 * noisy output and converting https→wss.
 */

import {describe, it, expect} from 'vitest';
import {extractTunnelUrl, toWssUrl} from '../src/transport/tunnel';

describe('extractTunnelUrl', () => {
  it('finds the URL in a typical cloudflared banner', () => {
    const chunk = [
      '2024-01-01T00:00:00Z INF +--------------------------------------+',
      '2024-01-01T00:00:00Z INF |  https://calm-forest-1234.trycloudflare.com  |',
      '2024-01-01T00:00:00Z INF +--------------------------------------+',
    ].join('\n');
    expect(extractTunnelUrl(chunk)).toBe(
      'https://calm-forest-1234.trycloudflare.com',
    );
  });

  it('returns null when no URL is present', () => {
    expect(extractTunnelUrl('starting cloudflared…')).toBeNull();
  });

  it('does NOT capture the api./banner hosts cloudflared prints first', () => {
    // Regression: cloudflared's startup lines mention trycloudflare.com and
    // control hosts. The parser must skip them and only grab the real
    // multi-word quick-tunnel hostname.
    expect(extractTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull();
    expect(extractTunnelUrl('see https://api.trycloudflare.com for details')).toBeNull();
    expect(extractTunnelUrl('https://www.trycloudflare.com/docs')).toBeNull();
  });

  it('extracts the real hostname from full cloudflared output', () => {
    const out = [
      'INF Requesting new quick Tunnel on trycloudflare.com...',
      'INF |  Your quick Tunnel has been created! Visit it at:  |',
      'INF |  https://modern-delete-discover-whom.trycloudflare.com  |',
      'INF Registered tunnel connection connIndex=0',
    ].join('\n');
    expect(extractTunnelUrl(out)).toBe(
      'https://modern-delete-discover-whom.trycloudflare.com',
    );
  });
});

describe('toWssUrl', () => {
  it('rewrites https to wss', () => {
    expect(toWssUrl('https://calm-forest.trycloudflare.com')).toBe(
      'wss://calm-forest.trycloudflare.com',
    );
  });

  it('leaves the host/path intact', () => {
    expect(toWssUrl('https://calm-forest.trycloudflare.com/path')).toBe(
      'wss://calm-forest.trycloudflare.com/path',
    );
  });
});
