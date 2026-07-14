/**
 * Coding-CLI registry (desktop copy — mirrors mobile/src/clis.ts). Used by the
 * `phonecmd cli <name> [prompt]` command to build the right shell invocation.
 *
 * promptFlag: how a one-shot prompt is passed —
 *   '-p'   → cli -p "<prompt>"   (Claude, Copilot, Cursor, Gemini)
 *   'exec' → cli exec "<prompt>" (Codex)
 *   ''     → cli "<prompt>"      (positional, e.g. aider)
 * Empty prompt launches the CLI interactively (just the command).
 */

export interface CliSpec {
  key: string;
  cmd: string;
  promptFlag: string;
}

export const CLIS: CliSpec[] = [
  {key: 'claude', cmd: 'claude', promptFlag: '-p'},
  {key: 'codex', cmd: 'codex', promptFlag: 'exec'},
  {key: 'copilot', cmd: 'copilot', promptFlag: '-p'},
  {key: 'cursor', cmd: 'cursor-agent', promptFlag: '-p'},
  {key: 'gemini', cmd: 'gemini', promptFlag: '-p'},
  {key: 'aider', cmd: 'aider', promptFlag: ''},
];

/** Look up a CLI by its key OR its command name (e.g. 'cursor' or 'cursor-agent'). */
export function cliByName(name: string): CliSpec | undefined {
  return CLIS.find(c => c.key === name || c.cmd === name);
}

/**
 * Build the shell command for a CLI name + optional prompt. Returns null for an
 * unknown CLI. Empty prompt → interactive launch.
 */
export function buildCliCommand(name: string, prompt?: string): string | null {
  const cli = cliByName(name);
  if (!cli) {
    return null;
  }
  const p = (prompt ?? '').trim();
  if (!p) {
    return cli.cmd;
  }
  const quoted = `"${p.replace(/(["\\$`])/g, '\\$1')}"`;
  return cli.promptFlag ? `${cli.cmd} ${cli.promptFlag} ${quoted}` : `${cli.cmd} ${quoted}`;
}
