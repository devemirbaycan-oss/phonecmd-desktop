/**
 * Command router. Maps a CommandRequest.command string to a handler.
 *
 * Handlers are async and return arbitrary JSON-serializable data. The router
 * does NOT deal with encryption or session tokens — the session layer verifies
 * the token before dispatching here. This keeps command handlers pure and easy
 * to unit-test.
 *
 * Real handlers (adb.shell, device.info, file.pull, logcat.stream) plug in here
 * in Phase 4. For now we ship `echo` to prove the pipe end-to-end.
 */

import { CommandRequest, PushKind } from "../protocol";

export type CommandHandler = (
  args: Record<string, unknown> | undefined,
  ctx: CommandContext
) => Promise<unknown>;

export interface CommandContext {
  deviceName: string;
  /** Whether this device is Pro (unlimited). Set from the pair request. */
  isPro: boolean;
  /**
   * Push an unsolicited, encrypted message to the phone (e.g. streaming
   * terminal output). Provided by the session layer. Handlers that only do
   * request/response can ignore it.
   */
  push?: (kind: PushKind, data: unknown) => void;
}

/** Thrown by a handler when the free daily limit is hit. The session turns this
 *  into an { ok:false, error, limit } response the app shows as a paywall. */
export class LimitReachedError extends Error {
  constructor(readonly limit: number) {
    super("daily free limit reached");
    this.name = "LimitReachedError";
  }
}

export class CommandRouter {
  private handlers = new Map<string, CommandHandler>();

  register(command: string, handler: CommandHandler): this {
    this.handlers.set(command, handler);
    return this;
  }

  /** Register a map of { command: handler } in one call. */
  registerAll(map: Record<string, CommandHandler>): this {
    for (const [command, handler] of Object.entries(map)) {
      this.handlers.set(command, handler);
    }
    return this;
  }

  /** Names of all registered commands (for discovery / a "help" command). */
  list(): string[] {
    return [...this.handlers.keys()].sort();
  }

  has(command: string): boolean {
    return this.handlers.has(command);
  }

  async dispatch(
    req: CommandRequest,
    ctx: CommandContext
  ): Promise<unknown> {
    const handler = this.handlers.get(req.command);
    if (!handler) {
      throw new Error(`unknown command: ${req.command}`);
    }
    return handler(req.args, ctx);
  }
}

/** The echo command — returns whatever `args.message` was sent. */
export const echoHandler: CommandHandler = async (args) => {
  return { echo: args?.message ?? null, at: "desktop" };
};
