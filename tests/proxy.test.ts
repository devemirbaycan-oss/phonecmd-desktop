/**
 * Localhost Preview security gate — the allow/deny port policy and the
 * enabled-check that guard net.proxy. These are the safety-critical bits: they
 * decide whether a paired phone may reach a given loopback port at all.
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';

// Mock the settings store so we can drive the gate deterministically.
let SETTINGS: any;
vi.mock('../src/electron/settings', () => ({
  loadSettings: () => SETTINGS,
}));

import {portAllowed, checkProxyAllowed} from '../src/net/proxy';

describe('portAllowed', () => {
  it('rejects out-of-range / non-integer ports', () => {
    expect(portAllowed(0, {allow: [], deny: []})).toBe(false);
    expect(portAllowed(70000, {allow: [], deny: []})).toBe(false);
    expect(portAllowed(3.5, {allow: [], deny: []})).toBe(false);
    expect(portAllowed(NaN, {allow: [], deny: []})).toBe(false);
  });

  it('allows any valid port when both lists are empty', () => {
    expect(portAllowed(3000, {allow: [], deny: []})).toBe(true);
    expect(portAllowed(8080, {allow: [], deny: []})).toBe(true);
  });

  it('deny-list always wins, even in allow-any mode', () => {
    expect(portAllowed(5432, {allow: [], deny: [5432]})).toBe(false);
    expect(portAllowed(3000, {allow: [], deny: [5432]})).toBe(true);
  });

  it('a non-empty allow-list is exclusive (only listed ports pass)', () => {
    expect(portAllowed(3000, {allow: [3000, 8080], deny: []})).toBe(true);
    expect(portAllowed(8080, {allow: [3000, 8080], deny: []})).toBe(true);
    expect(portAllowed(9999, {allow: [3000, 8080], deny: []})).toBe(false);
  });

  it('deny wins over allow when a port is in both', () => {
    expect(portAllowed(3000, {allow: [3000], deny: [3000]})).toBe(false);
  });
});

describe('checkProxyAllowed (reads live settings)', () => {
  beforeEach(() => {
    SETTINGS = {localhostPreview: true, localhostAllowPorts: [], localhostDenyPorts: []};
  });

  it('is disabled when the feature is off (the default)', () => {
    SETTINGS.localhostPreview = false;
    expect(checkProxyAllowed(3000)).toBe('disabled');
  });

  it('rejects a bad port', () => {
    expect(checkProxyAllowed(0)).toBe('bad-port');
    expect(checkProxyAllowed('nope')).toBe('bad-port');
    expect(checkProxyAllowed(undefined)).toBe('bad-port');
  });

  it('blocks a port outside the allow-list', () => {
    SETTINGS.localhostAllowPorts = [3000];
    expect(checkProxyAllowed(8080)).toBe('port-blocked');
    expect(checkProxyAllowed(3000)).toBeNull();
  });

  it('blocks a denied port', () => {
    SETTINGS.localhostDenyPorts = [5432];
    expect(checkProxyAllowed(5432)).toBe('port-blocked');
  });

  it('allows a valid port when enabled with open policy', () => {
    expect(checkProxyAllowed(3000)).toBeNull();
    expect(checkProxyAllowed('8080')).toBeNull(); // string coerces to number
  });
});
