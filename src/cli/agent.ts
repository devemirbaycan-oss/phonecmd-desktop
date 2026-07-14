/**
 * Headless agent runner for the CLI. Drives the SAME assistant behavior as the
 * phone's on-device agents (Claude via Anthropic, GPT via OpenAI) but runs the
 * tool-calling loop on the host, executing each tool through the LocalClient.
 * This lets automation say "ask Claude to do X on this PC" from a script.
 *
 * The four tools mirror the app exactly: run_command, read_file, list_dir,
 * create_profile — each mapped to an in-process host command.
 */

import {LocalClient} from './localClient';

export type Provider = 'claude' | 'gpt';

export interface AgentOptions {
  provider: Provider;
  apiKey: string;
  model?: string;
  /** Print each step (assistant text + tool calls) as it happens. */
  onEvent?: (e: AgentEvent) => void;
  maxTurns?: number;
}

export type AgentEvent =
  | {type: 'text'; text: string}
  | {type: 'tool'; name: string; args: Record<string, unknown>}
  | {type: 'tool_result'; name: string; result: string};

const DEFAULT_MODELS: Record<Provider, string> = {
  claude: 'claude-sonnet-5',
  gpt: 'gpt-4o',
};

const TOOL_SPECS = [
  {
    name: 'run_command',
    description:
      "Run a shell command on the user's PC and return its output. Use for any action: installing packages, running builds, git, file ops, launching CLIs, etc.",
    parameters: {
      type: 'object',
      properties: {command: {type: 'string', description: 'The exact shell command to run'}},
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file on the PC. Returns its contents.',
    parameters: {
      type: 'object',
      properties: {path: {type: 'string', description: 'Absolute file path'}},
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List a directory on the PC.',
    parameters: {
      type: 'object',
      properties: {path: {type: 'string', description: 'Absolute directory path'}},
      required: ['path'],
    },
  },
  {
    name: 'create_profile',
    description: 'Save a named quick-launch profile on the PC (label + command).',
    parameters: {
      type: 'object',
      properties: {label: {type: 'string'}, command: {type: 'string'}},
      required: ['label', 'command'],
    },
  },
] as const;

const SYSTEM_PROMPT = [
  "You are the PhoneCMD assistant. You operate this PC (Windows) by calling tools.",
  'Prefer list_dir/read_file over dir/type when exploring. Use run_command for actions.',
  'Work step by step, one tool call at a time, reading each result before the next.',
  'Be concise. Prefer non-destructive actions; warn before anything that deletes/overwrites.',
].join('\n');

/** Execute a tool against the host via the LocalClient. */
async function execTool(
  client: LocalClient,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'run_command':
      return client.run(String(args.command ?? ''), {termId: 'agent'});
    case 'read_file': {
      const res = await client.call('pcfs.read', {path: String(args.path ?? '')});
      const d = res.data as {contentBase64?: string};
      return d.contentBase64 ? Buffer.from(d.contentBase64, 'base64').toString('utf8') : '(empty)';
    }
    case 'list_dir': {
      const res = await client.call('pcfs.list', {path: String(args.path ?? '')});
      const d = res.data as {entries?: {name: string; type: string}[]};
      return (d.entries ?? []).map(e => `${e.type === 'dir' ? '[dir]' : '     '} ${e.name}`).join('\n') || '(empty)';
    }
    case 'create_profile': {
      const res = await client.call('profiles.save', {
        label: String(args.label ?? ''),
        command: String(args.command ?? ''),
      });
      return (res.data as {profile?: unknown}).profile ? `Saved profile "${args.label}".` : 'Saved.';
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

/** Run one user prompt through the agent loop; returns the final assistant text. */
export async function runAgent(
  client: LocalClient,
  userText: string,
  opts: AgentOptions,
): Promise<string> {
  const model = opts.model ?? DEFAULT_MODELS[opts.provider];
  const maxTurns = opts.maxTurns ?? 12;
  const emit = opts.onEvent ?? (() => {});
  const runner =
    opts.provider === 'claude'
      ? new ClaudeRunner(opts.apiKey, model)
      : new GptRunner(opts.apiKey, model);

  let finalText = '';
  runner.pushUser(userText);
  for (let turn = 0; turn < maxTurns; turn++) {
    const step = await runner.step();
    for (const t of step.texts) {
      finalText = t;
      emit({type: 'text', text: t});
    }
    if (step.toolCalls.length === 0) {
      return finalText;
    }
    const results: {id: string; name: string; result: string}[] = [];
    for (const call of step.toolCalls) {
      emit({type: 'tool', name: call.name, args: call.args});
      let result: string;
      try {
        result = await execTool(client, call.name, call.args);
      } catch (e: any) {
        result = `Error: ${e.message}`;
      }
      emit({type: 'tool_result', name: call.name, result});
      results.push({id: call.id, name: call.name, result});
    }
    runner.pushToolResults(results);
  }
  return finalText || '[stopped: reached max tool-call turns]';
}

interface StepResult {
  texts: string[];
  toolCalls: {id: string; name: string; args: Record<string, unknown>}[];
}

// ── Anthropic (Claude) ──────────────────────────────────────────────────────
class ClaudeRunner {
  private messages: any[] = [];
  constructor(private apiKey: string, private model: string) {}

  pushUser(text: string) {
    this.messages.push({role: 'user', content: text});
  }
  pushToolResults(results: {id: string; result: string}[]) {
    this.messages.push({
      role: 'user',
      content: results.map(r => ({type: 'tool_result', tool_use_id: r.id, content: r.result})),
    });
  }

  async step(): Promise<StepResult> {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: this.messages,
        tools: TOOL_SPECS.map(t => ({name: t.name, description: t.description, input_schema: t.parameters})),
      }),
    });
    if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const data: any = await resp.json();
    const blocks: any[] = Array.isArray(data.content) ? data.content : [];
    this.messages.push({role: 'assistant', content: blocks});
    return {
      texts: blocks.filter(b => b.type === 'text' && b.text).map(b => b.text),
      toolCalls: blocks
        .filter(b => b.type === 'tool_use')
        .map(b => ({id: b.id, name: b.name, args: (b.input || {}) as Record<string, unknown>})),
    };
  }
}

// ── OpenAI (GPT) ────────────────────────────────────────────────────────────
class GptRunner {
  private messages: any[] = [{role: 'system', content: SYSTEM_PROMPT}];
  constructor(private apiKey: string, private model: string) {}

  pushUser(text: string) {
    this.messages.push({role: 'user', content: text});
  }
  pushToolResults(results: {id: string; name: string; result: string}[]) {
    for (const r of results) {
      this.messages.push({role: 'tool', tool_call_id: r.id, name: r.name, content: r.result});
    }
  }

  async step(): Promise<StepResult> {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${this.apiKey}`},
      body: JSON.stringify({
        model: this.model,
        messages: this.messages,
        tools: TOOL_SPECS.map(t => ({type: 'function', function: t})),
        tool_choice: 'auto',
      }),
    });
    if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const data: any = await resp.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('No response from OpenAI');
    this.messages.push(msg);
    return {
      texts: msg.content ? [msg.content] : [],
      toolCalls: (msg.tool_calls ?? []).map((c: any) => ({
        id: c.id,
        name: c.function.name,
        args: safeJson(c.function.arguments),
      })),
    };
  }
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}
