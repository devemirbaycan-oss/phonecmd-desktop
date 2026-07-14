/**
 * CLI detection — checks which command-line tools are actually installed on the
 * PC, so the phone can mark uninstalled CLIs (Claude/Codex/Cursor/…) instead of
 * launching one that just errors with "not recognized".
 *
 * Uses `where` on Windows and `which` on posix. A command counts as installed if
 * the lookup exits 0 and prints a path.
 */

import {execFile} from 'child_process';
import {CommandHandler} from '../commands/router';

/** Resolve whether a single command name is on PATH. */
export function detectOne(cmd: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return new Promise(resolve => {
    execFile(finder, [cmd], {timeout: 5000, windowsHide: true}, (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

/**
 * clis.detect — args.commands: string[]. Returns { installed: {cmd: boolean} }.
 * Only the base command name is checked (e.g. "claude", "cursor-agent").
 */
export const clisDetectHandler: CommandHandler = async args => {
  const commands = Array.isArray(args?.commands)
    ? (args!.commands as unknown[]).filter(c => typeof c === 'string').map(String)
    : [];
  const installed: Record<string, boolean> = {};
  await Promise.all(
    commands.map(async cmd => {
      // Use just the first token (e.g. "cursor-agent" from "cursor-agent -p").
      const base = cmd.split(/\s+/)[0];
      installed[cmd] = await detectOne(base);
    }),
  );
  return {installed};
};

export const cliDetectCommands: Record<string, CommandHandler> = {
  'clis.detect': clisDetectHandler,
};
