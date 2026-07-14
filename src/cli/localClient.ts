/**
 * LocalClient — drives the PhoneCMD command surface IN-PROCESS, with no
 * WebSocket, no encryption, and no pairing. It builds the same CommandRouter the
 * host uses and dispatches directly, so scripts / CI / debugging can control the
 * PC-host with plain function calls (and, via cli.ts, plain shell commands).
 *
 * This is the automation backbone: everything the phone app can ask the host to
 * do, a program on the host can do here without a single tap.
 */

import {CommandRouter, echoHandler, CommandContext} from '../commands/router';
import {pcfsCommands} from '../pcfs/pcfs';
import {terminalCommands} from '../terminal/terminal';
import {cliDetectCommands} from '../clis/detect';
import {PushKind} from '../protocol';

export interface LocalClientOptions {
  /** Device name the host attributes commands to (usage counter key). */
  deviceName?: string;
  /** Treat as Pro (skip the free daily terminal limit). Default true for CLI:
   *  automation shouldn't be throttled by the consumer free tier. */
  isPro?: boolean;
}

export interface RunResult {
  /** Whatever the handler returned. */
  data: unknown;
  /** Any pushes the handler emitted during the call (e.g. term.output chunks). */
  pushes: {kind: PushKind; data: unknown}[];
}

/** Build the same router the host registers (single source of truth). */
export function buildRouter(): CommandRouter {
  return new CommandRouter()
    .register('echo', echoHandler)
    .registerAll(pcfsCommands)
    .registerAll(terminalCommands)
    .registerAll(cliDetectCommands);
}

export class LocalClient {
  private router = buildRouter();
  private deviceName: string;
  private isPro: boolean;
  private pushListeners = new Set<(kind: PushKind, data: unknown) => void>();

  constructor(opts: LocalClientOptions = {}) {
    this.deviceName = opts.deviceName ?? 'phonecmd-cli';
    this.isPro = opts.isPro ?? true;
  }

  /** Subscribe to live pushes (terminal output/exit) across all calls. */
  onPush(fn: (kind: PushKind, data: unknown) => void): () => void {
    this.pushListeners.add(fn);
    return () => this.pushListeners.delete(fn);
  }

  /** List every command the host understands (for `phonecmd commands`). */
  commands(): string[] {
    return this.router.list();
  }

  /** Dispatch one command; collect any pushes it emits during the call. */
  async call(command: string, args: Record<string, unknown> = {}): Promise<RunResult> {
    const pushes: {kind: PushKind; data: unknown}[] = [];
    const ctx: CommandContext = {
      deviceName: this.deviceName,
      isPro: this.isPro,
      push: (kind, data) => {
        pushes.push({kind, data});
        for (const fn of this.pushListeners) fn(kind, data);
      },
    };
    const data = await this.router.dispatch({id: 'cli', command, args}, ctx);
    return {data, pushes};
  }

  /**
   * Run a shell command in a terminal shell and resolve with the collected
   * stdout/stderr once output goes idle (or a max time elapses). Mirrors the
   * app's runAndCapture so automation gets the command's output back.
   */
  async run(
    line: string,
    opts: {termId?: string; idleMs?: number; maxMs?: number; cwd?: string} = {},
  ): Promise<string> {
    const termId = opts.termId ?? 'cli';
    const idleMs = opts.idleMs ?? 1000;
    const maxMs = opts.maxMs ?? 60_000;

    let buffer = '';
    let exited = false;
    const unsub = this.onPush((kind, data) => {
      const d = data as {termId?: string; chunk?: string};
      if (d.termId !== termId) return;
      if (kind === 'term.output' && d.chunk) buffer += d.chunk;
      if (kind === 'term.exit') exited = true;
    });

    try {
      await this.call('term.start', {termId, ...(opts.cwd ? {cwd: opts.cwd} : {})});
      const res = await this.call('term.input', {termId, line});
      const meta = res.data as {limitReached?: boolean};
      if (meta?.limitReached) {
        return '[daily free limit reached]';
      }

      // Wait for output to settle.
      await new Promise<void>(resolve => {
        let last = buffer.length;
        const started = mono();
        const iv = setInterval(() => {
          if (exited || buffer.length === last || mono() - started > maxMs) {
            clearInterval(iv);
            resolve();
          }
          last = buffer.length;
        }, idleMs);
      });
      return buffer.trim();
    } finally {
      unsub();
    }
  }

  /** Stop a terminal shell (frees the child process). */
  async stop(termId = 'cli'): Promise<void> {
    await this.call('term.stop', {termId});
  }
}

// Wall-clock helper that avoids Date.now (kept isolated for testability).
function mono(): number {
  return Date.now();
}
