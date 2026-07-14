/**
 * Free-tier daily limit tests. Uses a temp HOME so the persisted usage file
 * doesn't touch the real ~/.phonecmd.
 */

import {describe, it, expect, beforeEach, vi} from 'vitest';
import {tmpdir} from 'os';
import {join} from 'path';
import {mkdtempSync} from 'fs';

// Point HOME at a throwaway dir before importing the module (it reads homedir()
// at load). We re-import fresh in each test via vi.resetModules.
function freshModule() {
  const dir = mkdtempSync(join(tmpdir(), 'pcmd-usage-'));
  vi.stubEnv('USERPROFILE', dir);
  vi.stubEnv('HOME', dir);
  return import('../src/usage/limit');
}

describe('free daily limit', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('allows exactly FREE_DAILY_LIMIT commands, then blocks', async () => {
    const m = await freshModule();
    const dev = 'phone-1';
    let allowed = 0;
    for (let i = 0; i < m.FREE_DAILY_LIMIT + 5; i++) {
      if (m.consume(dev, false)) {
        allowed++;
      }
    }
    expect(allowed).toBe(m.FREE_DAILY_LIMIT);
    expect(m.getUsage(dev).remaining).toBe(0);
  });

  it('Pro is unlimited and never counted', async () => {
    const m = await freshModule();
    const dev = 'phone-pro';
    for (let i = 0; i < 100; i++) {
      expect(m.consume(dev, true)).toBe(true);
    }
    // Pro consumption doesn't touch the counter.
    expect(m.getUsage(dev).used).toBe(0);
  });

  it('counts are per-device', async () => {
    const m = await freshModule();
    for (let i = 0; i < m.FREE_DAILY_LIMIT; i++) {
      m.consume('a', false);
    }
    expect(m.consume('a', false)).toBe(false); // a is capped
    expect(m.consume('b', false)).toBe(true); // b is independent
  });
});
