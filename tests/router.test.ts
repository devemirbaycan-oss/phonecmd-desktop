/**
 * Command router tests — dispatch, unknown commands, bulk registration.
 */

import {describe, it, expect} from 'vitest';
import {CommandRouter, echoHandler} from '../src/commands/router';

const ctx = {deviceName: 'test', isPro: false};

describe('CommandRouter', () => {
  it('dispatches to a registered handler', async () => {
    const router = new CommandRouter().register('echo', echoHandler);
    const out = await router.dispatch(
      {id: '1', command: 'echo', args: {message: 'hi'}},
      ctx,
    );
    expect(out).toEqual({echo: 'hi', at: 'desktop'});
  });

  it('echo returns null when no message provided', async () => {
    const router = new CommandRouter().register('echo', echoHandler);
    const out = await router.dispatch({id: '1', command: 'echo'}, ctx);
    expect(out).toEqual({echo: null, at: 'desktop'});
  });

  it('throws on an unknown command', async () => {
    const router = new CommandRouter();
    await expect(
      router.dispatch({id: '1', command: 'nope'}, ctx),
    ).rejects.toThrow(/unknown command: nope/);
  });

  it('registerAll adds a map of handlers and list() is sorted', () => {
    const router = new CommandRouter().registerAll({
      'b.cmd': async () => 1,
      'a.cmd': async () => 2,
    });
    expect(router.has('a.cmd')).toBe(true);
    expect(router.has('b.cmd')).toBe(true);
    expect(router.list()).toEqual(['a.cmd', 'b.cmd']);
  });

  it('passes ctx through to handlers', async () => {
    const router = new CommandRouter().register('who', async (_a, c) => ({
      device: c.deviceName,
    }));
    const out = await router.dispatch({id: '1', command: 'who'}, {
      deviceName: 'Pixel',
      isPro: false,
    });
    expect(out).toEqual({device: 'Pixel'});
  });
});
