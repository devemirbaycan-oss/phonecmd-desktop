#!/usr/bin/env node
/**
 * phonecmd — command-line control of the PhoneCMD host, for debugging and
 * third-party automation. No app, no clicks: drive the PC-host, the coding CLIs,
 * and the Claude/GPT agents straight from a shell or a script.
 *
 * By default every command runs IN-PROCESS against the local host (no network,
 * no pairing) — the fastest, safest way to automate the machine you're on.
 *
 * Usage:
 *   phonecmd run "<shell command>"          run a command, print its output
 *   phonecmd fs ls [path]                    list a directory (home if omitted)
 *   phonecmd fs cat <path>                   print a file
 *   phonecmd fs write <path> <<<"text"       write stdin to a file
 *   phonecmd clis                            which coding CLIs are installed
 *   phonecmd cli <name> ["prompt"]           run a coding CLI (claude/codex/…)
 *   phonecmd agent claude|gpt "<prompt>"     let an agent operate the PC
 *   phonecmd call <command> ['{json args}']  raw: dispatch any host command
 *   phonecmd commands                        list every host command
 *   phonecmd serve [--no-tunnel] [--ttl X]   start a host + print the pairing QR
 *   phonecmd --json ...                      machine-readable output
 *
 * Keys for `agent`: --key sk-… or env ANTHROPIC_API_KEY / OPENAI_API_KEY.
 */

import {LocalClient} from './cli/localClient';
import {runAgent, Provider} from './cli/agent';
import {buildCliCommand} from './clis';

interface Flags {
  json: boolean;
  key?: string;
  model?: string;
  noTunnel: boolean;
  ttl?: string;
  _: string[];
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = {json: false, noTunnel: false, _: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') f.json = true;
    else if (a === '--no-tunnel') f.noTunnel = true;
    else if (a === '--key') f.key = argv[++i];
    else if (a === '--model') f.model = argv[++i];
    else if (a === '--ttl') f.ttl = argv[++i];
    else f._.push(a);
  }
  return f;
}

function out(flags: Flags, human: string, data?: unknown) {
  if (flags.json) {
    console.log(JSON.stringify(data ?? {ok: true, message: human}));
  } else {
    console.log(human);
  }
}

function fail(msg: string, code = 1): never {
  console.error(`phonecmd: ${msg}`);
  process.exit(code);
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const [cmd, ...rest] = flags._;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  // `serve` runs the real host; everything else uses the in-process client.
  if (cmd === 'serve') {
    return serve(flags);
  }

  const client = new LocalClient();

  switch (cmd) {
    case 'run': {
      const line = rest.join(' ').trim();
      if (!line) fail('run needs a command: phonecmd run "git status"');
      const result = await client.run(line);
      await client.stop();
      out(flags, result, {ok: true, output: result});
      break;
    }

    case 'fs': {
      const [sub, ...fsArgs] = rest;
      if (sub === 'ls') {
        const path = fsArgs[0];
        const res = await client.call('pcfs.list', path ? {path} : {});
        const d = res.data as {path: string; entries: {name: string; type: string; size: number | null}[]};
        if (flags.json) {
          out(flags, '', d);
        } else {
          console.log(d.path);
          for (const e of d.entries) {
            console.log(`${e.type === 'dir' ? 'd' : '-'} ${e.name}`);
          }
        }
      } else if (sub === 'cat') {
        if (!fsArgs[0]) fail('fs cat needs a path');
        const res = await client.call('pcfs.read', {path: fsArgs[0]});
        const text = Buffer.from((res.data as {contentBase64: string}).contentBase64, 'base64').toString('utf8');
        if (flags.json) out(flags, '', {ok: true, path: fsArgs[0], content: text});
        else process.stdout.write(text);
      } else if (sub === 'write') {
        if (!fsArgs[0]) fail('fs write needs a path (content from stdin)');
        const content = await readStdin();
        const res = await client.call('pcfs.write', {
          path: fsArgs[0],
          contentBase64: Buffer.from(content, 'utf8').toString('base64'),
        });
        out(flags, `wrote ${(res.data as {bytesWritten: number}).bytesWritten} bytes`, res.data);
      } else {
        fail(`unknown fs subcommand: ${sub ?? '(none)'} (use ls|cat|write)`);
      }
      break;
    }

    case 'clis': {
      const names = ['claude', 'codex', 'copilot', 'cursor-agent', 'gemini', 'aider'];
      const res = await client.call('clis.detect', {commands: names});
      const installed = (res.data as {installed: Record<string, boolean>}).installed;
      if (flags.json) out(flags, '', {ok: true, installed});
      else for (const [n, ok] of Object.entries(installed)) console.log(`${ok ? '✓' : '✗'} ${n}`);
      break;
    }

    case 'cli': {
      const [name, ...promptParts] = rest;
      if (!name) fail('cli needs a name: phonecmd cli claude "fix the build"');
      const prompt = promptParts.join(' ');
      const command = buildCliCommand(name, prompt || undefined);
      if (!command) fail(`unknown CLI: ${name}`);
      const result = await client.run(command, {maxMs: 120_000});
      await client.stop();
      out(flags, result, {ok: true, cli: name, output: result});
      break;
    }

    case 'agent': {
      const [provider, ...promptParts] = rest;
      if (provider !== 'claude' && provider !== 'gpt') {
        fail('agent needs a provider: phonecmd agent claude "…"  |  agent gpt "…"');
      }
      const prompt = promptParts.join(' ').trim();
      if (!prompt) fail('agent needs a prompt');
      const key = flags.key ?? envKey(provider as Provider);
      if (!key) fail(`no API key — pass --key or set ${provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}`);
      const final = await runAgent(client, prompt, {
        provider: provider as Provider,
        apiKey: key,
        model: flags.model,
        onEvent: e => {
          if (flags.json) return; // stream only in human mode
          if (e.type === 'text') console.log(e.text);
          else if (e.type === 'tool') console.log(`▸ ${e.name}(${JSON.stringify(e.args)})`);
          else console.log(`  ↳ ${e.result.length > 400 ? e.result.slice(0, 400) + '…' : e.result}`);
        },
      });
      await client.stop('agent');
      if (flags.json) out(flags, '', {ok: true, provider, final});
      break;
    }

    case 'call': {
      const [command, jsonArgs] = rest;
      if (!command) fail('call needs a command name (see `phonecmd commands`)');
      let args: Record<string, unknown> = {};
      if (jsonArgs) {
        try {
          args = JSON.parse(jsonArgs);
        } catch {
          fail('args must be valid JSON');
        }
      }
      const res = await client.call(command, args);
      out(flags, JSON.stringify(res.data, null, 2), res.data);
      break;
    }

    case 'commands': {
      const list = client.commands();
      if (flags.json) out(flags, '', {ok: true, commands: list});
      else list.forEach(c => console.log(c));
      break;
    }

    default:
      fail(`unknown command: ${cmd} (run \`phonecmd help\`)`);
  }
}

async function serve(flags: Flags) {
  // Lazy import so plain automation never pulls in the tunnel/QR deps.
  const {HostCore} = await import('./core/host');
  const {ttlFromChoice} = await import('./pairing/session');
  const qrcode = await import('qrcode-terminal');

  const host = new HostCore({
    port: Number(process.env.PHONECMD_PORT ?? 8787),
    noTunnel: flags.noTunnel || process.env.PHONECMD_NO_TUNNEL === '1',
    lanHost: process.env.PHONECMD_HOST,
    pairingTtlMs: ttlFromChoice(flags.ttl ?? process.env.PHONECMD_PAIRING_TTL),
  });
  host.on('log', m => !flags.json && console.error(`[phonecmd] ${m}`));
  host.on('qr', payload => {
    if (flags.json) {
      console.log(JSON.stringify(payload));
    } else {
      qrcode.default.generate(JSON.stringify(payload), {small: true});
      console.log('QR payload:\n' + JSON.stringify(payload));
      console.log(`Pairing code: ${payload.pairingCode}`);
    }
  });
  await host.start();
  process.on('SIGINT', () => {
    host.stop();
    process.exit(0);
  });
}

function envKey(provider: Provider): string | undefined {
  return provider === 'claude'
    ? process.env.ANTHROPIC_API_KEY
    : process.env.OPENAI_API_KEY;
}

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

function printHelp() {
  console.log(`phonecmd — automate the PhoneCMD host from the command line

  run "<cmd>"                 run a shell command, print output
  fs ls [path]               list a directory (home if omitted)
  fs cat <path>              print a file
  fs write <path>            write stdin to a file
  clis                       which coding CLIs are installed
  cli <name> ["prompt"]      run a coding CLI (claude/codex/copilot/…)
  agent claude|gpt "<txt>"   let an AI agent operate the PC (needs API key)
  call <command> ['{json}']  dispatch any raw host command
  commands                   list every host command
  serve [--no-tunnel] [--ttl never|1d|7d]   start a host + print the pairing QR

  Flags: --json  --key <k>  --model <m>
  Agent keys: --key or env ANTHROPIC_API_KEY / OPENAI_API_KEY`);
}

main().catch(err => {
  console.error(`phonecmd: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
