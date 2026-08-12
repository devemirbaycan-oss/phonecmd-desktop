/**
 * device.revoke — a paired phone forgetting a PC must also drop its trust on the
 * host, so a later re-pair genuinely needs the code AND the user's approval.
 * These verify the handler forgets exactly the CALLING device's key (from the
 * authenticated session context), and no-ops safely without one.
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';

const forgetDevice = vi.fn();
vi.mock('../src/pairing/devices', () => ({
  forgetDevice: (k: string) => forgetDevice(k),
}));

import {deviceRevokeHandler} from '../src/pairing/deviceCommands';

describe('device.revoke', () => {
  beforeEach(() => forgetDevice.mockReset());

  it('revokes the calling device by its authenticated key', async () => {
    const res = await deviceRevokeHandler({}, {
      deviceName: 'phone',
      isPro: false,
      devicePublicKey: 'PHONE_KEY_B64',
    });
    expect(forgetDevice).toHaveBeenCalledWith('PHONE_KEY_B64');
    expect(res).toEqual({revoked: true});
  });

  it('no-ops safely when no device key is on the context', async () => {
    const res = await deviceRevokeHandler({}, {deviceName: 'phone', isPro: false});
    expect(forgetDevice).not.toHaveBeenCalled();
    expect(res).toEqual({revoked: false});
  });

  it('can only ever revoke itself (ignores any key in args)', async () => {
    await deviceRevokeHandler({publicKey: 'SOMEONE_ELSE'} as any, {
      deviceName: 'phone',
      isPro: false,
      devicePublicKey: 'PHONE_KEY_B64',
    });
    // The arg is ignored — only the session's authenticated key is used.
    expect(forgetDevice).toHaveBeenCalledWith('PHONE_KEY_B64');
    expect(forgetDevice).not.toHaveBeenCalledWith('SOMEONE_ELSE');
  });
});
