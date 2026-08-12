/**
 * device.* commands — a paired phone managing its OWN trust on this host.
 *
 * device.revoke: the phone calls this when the user "Forget PC"s it. The host
 * removes THIS device's public key from devices.json, so the next connection is
 * a stranger again and must re-pair with the current code AND the user's
 * approval. Without this, forgetting a PC on the phone left the host still
 * trusting the phone's key — so re-pairing skipped the approval prompt, a real
 * security gap. A device can only ever revoke ITSELF (the host uses the
 * authenticated key from the session, never a key the phone supplies).
 */

import {forgetDevice} from './devices';
import {CommandHandler} from '../commands/router';

export const deviceRevokeHandler: CommandHandler = async (_args, ctx) => {
  const key = ctx.devicePublicKey;
  if (!key) {
    // No authenticated key on the context — nothing we can safely revoke.
    return {revoked: false};
  }
  await forgetDevice(key);
  return {revoked: true};
};

export const deviceCommands: Record<string, CommandHandler> = {
  'device.revoke': deviceRevokeHandler,
};
