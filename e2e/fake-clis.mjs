// Stand-ins of the CLIs Tars drives, for the specs that need more than one kind of CLI at once (cli-matrix). Each
// is faithful to its real CLI where Tars depends on it, and says where each fact comes from:
//   where it keeps the MCP servers Tars registers (`<cli> mcp add`) and reads them at a session's start,
//   which of its environment an MCP server it starts receives (Tars's agent token among it, or not),
//   how it takes a first prompt on its command line and a task typed into it,
//   how a turn's start and end show (its hooks, run as it runs them; its own session files),
//   how it asks for an approval.
// Measured on this Mac on 2026-10-18 with a probe MCP server that writes the NAMES of the variables it receives, under
// `<cli> mcp list` (no model call): claude 2.1.302 and qwen 0.25.2 hand an MCP server their whole environment; amp
// keeps its servers in ~/.config/amp/settings.json under amp.mcpServers (its `mcp doctor` needs a login, so what it
// hands a server was not measured). qwen 0.25.2 refuses an option it does not have ("Unknown arguments: ...", exit 1).
// Documented, not measured (not installed here): gemini (~/.gemini/settings.json mcpServers; its MCP servers get its
// environment with every name matching TOKEN, SECRET, PASSWORD, KEY, AUTH or CREDENTIAL removed, unless the server's
// own env names it, https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md), opencode
// (~/.config/opencode/opencode.json, under `mcp`: type local, command as an array, environment,
// https://opencode.ai/docs/mcp-servers/), pi (~/.pi/agent/mcp.json and .pi/mcp.json, mcpServers, from a third
// party's notes), grok 0.2.64 (~/.grok/config.toml, [mcp_servers.<name>], as electron/providers/grok-provider.ts
// says). Where nothing says what a CLI hands its MCP servers, it is its whole environment, and the log says
// `assumed`.
// claude reports 2.1.288, under the 2.1.289 that the state mod needs: its turns show through the shell hooks here,
// the state mod having specs of its own (state-mod.live.spec.ts).
// codex is e2e/fake-codex.mjs (fix/codex-works, measured on 0.163), not this file.
//
// A turn does what the text it was given asks, as a model would (the first of these in the text):
//   DELEGATE <agent id> <prompt>   calls Tars's delegate_task, through Tars's MCP server as this CLI starts it;
//   SEND <agent id> <message>      calls send_message the same way;
//   ECHO <word>                    answers "echo <word>";
//   APPROVE <tag>                  asks for an approval, as this CLI asks, before it answers.
// Every launch, typed line, turn, hook, tool call and answer is one JSON line in FAKE_CLI_LOG, with whether Tars's
// agent token reached it or the MCP server, never a token or a key.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

// The specs run from the repository's root, as the others do (path.resolve('hooks')); Playwright loads this file
// through its CommonJS transform, where import.meta does not exist.
const HERE = path.resolve('e2e');

/** The CLIs this file stands in for: the binary Tars looks for, and what each answers to --version. */
export const FAKE_KINDS = {
  claude: { binary: 'claude', version: '2.1.288 (Claude Code)' },
  'qwen-code': { binary: 'qwen', version: '0.25.2' },
  gemini: { binary: 'gemini', version: '0.64.0' },
  opencode: { binary: 'opencode', version: '1.19.3' },
  pi: { binary: 'pi', version: '0.73.0' },
  amp: { binary: 'amp', version: '0.0.1788811227-gce258b' },
  grok: { binary: 'grok', version: '0.2.64' },
};

/**
 * Writes the stand-ins into <home>/bin: one executable per kind (and codex's, which runs e2e/fake-codex.mjs).
 * Returns the path of each, by kind. Logs go to <home>/fake-cli.jsonl and <home>/fake-codex.jsonl.
 */
export function writeFakeClis(home, kinds = [...Object.keys(FAKE_KINDS), 'codex'], { delegateTimeoutS } = {}) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const paths = {};
  for (const kind of kinds) {
    if (kind === 'codex') {
      paths.codex = path.join(bin, 'codex');
      fs.writeFileSync(paths.codex, `#!${process.execPath}\nprocess.env.FAKE_CODEX_LOG = ${JSON.stringify(path.join(home, 'fake-codex.jsonl'))};\n${delegateTimeoutS ? `process.env.FAKE_DELEGATE_TIMEOUT_S = '${delegateTimeoutS}';\n` : ''}import(${JSON.stringify(path.join(HERE, 'fake-codex.mjs'))});\n`, { mode: 0o755 });
      continue;
    }
    const spec = FAKE_KINDS[kind];
    if (!spec) throw new Error(`no stand-in for ${kind}`);
    paths[kind] = path.join(bin, spec.binary);
    fs.writeFileSync(paths[kind], [
      `#!${process.execPath}`,
      `process.env.FAKE_CLI_KIND = ${JSON.stringify(kind)};`,
      `process.env.FAKE_CLI_LOG = ${JSON.stringify(path.join(home, 'fake-cli.jsonl'))};`,
      ...(delegateTimeoutS ? [`process.env.FAKE_DELEGATE_TIMEOUT_S = '${delegateTimeoutS}';`] : []),
      `import(${JSON.stringify(path.join(HERE, 'fake-clis.mjs'))}).then((m) => m.run());`,
      '',
    ].join('\n'), { mode: 0o755 });
  }
  return paths;
}

// ---------------------------------------------------------------------------------------------------------------
// The stand-in itself, run by the executables above.

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** [mcp_servers.<name>] sections of a config.toml, read as codex and grok write them (strings and string arrays). */
function tomlServers(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const servers = {};
  for (const section of text.split(/\n(?=\[)/)) {
    const head = /^\[mcp_servers\.("?)([^\]"]+)\1\]/.exec(section.trim());
    if (!head) continue;
    const get = (key) => { const m = new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm').exec(section); try { return m ? JSON.parse(m[1]) : undefined; } catch { return undefined; } };
    servers[head[2]] = { command: get('command'), args: get('args') ?? [], env: {} };
  }
  return servers;
}

function addTomlServer(file, name, command, args) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const kept = text.split(/\n(?=\[)/).filter((s) => !s.trim().startsWith(`[mcp_servers.${name}]`)).join('\n').trim();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${kept ? kept + '\n\n' : ''}[mcp_servers.${name}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`);
}

const GEMINI_REDACTED = /TOKEN|SECRET|PASSWORD|KEY|AUTH|CREDENTIAL/i;

export async function run() {
  const kind = process.env.FAKE_CLI_KIND;
  const spec = FAKE_KINDS[kind];
  const argv = process.argv.slice(2);
  const HOME = process.env.HOME || '';
  const LOG = process.env.FAKE_CLI_LOG;
  const log = (entry) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, kind, agent: process.env.CLAUDE_AGENT_ID || null, ...entry }) + '\n'); };
  const out = (text) => process.stdout.write(text.replace(/\r?\n/g, '\r\n'));

  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
  // `claude mcp add -s user` writes ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json in an account's folder (measured).
  const claudeJson = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(HOME, '.claude.json');
  const files = {
    gemini: path.join(HOME, '.gemini', 'settings.json'),
    qwen: path.join(HOME, '.qwen', 'settings.json'),
    amp: path.join(HOME, '.config', 'amp', 'settings.json'),
    grok: path.join(HOME, '.grok', 'config.toml'),
  };

  // ---- Registration and the commands that are not a session.
  if (['--version', '-v', 'version'].includes(argv[0])) { out(`${spec.version}\n`); process.exit(0); }
  if (argv[0] === 'mcp') {
    const sub = argv[1];
    const rest = argv.slice(2);
    log({ registration: sub, argv });
    if (sub !== 'add') { out('ok\n'); process.exit(0); }
    const words = rest.filter((a, i) => !(a === '-s' || a === '--scope' || rest[i - 1] === '-s' || rest[i - 1] === '--scope'));
    const dashes = words.indexOf('--');
    if (kind === 'claude') {
      // claude mcp add -s user <name> [--] <command> [args...]
      const [name, ...cmd] = words.filter((a) => a !== '--');
      const cfg = readJson(claudeJson) ?? {};
      cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [name]: { type: 'stdio', command: cmd[0], args: cmd.slice(1), env: {} } };
      writeJson(claudeJson, cfg);
    } else if (kind === 'gemini' || kind === 'qwen-code') {
      // gemini mcp add -s user <name> <command> [args...]; qwen mcp add --scope user, the same (qwen measured).
      const [name, ...cmd] = words.filter((a) => a !== '--');
      const file = kind === 'gemini' ? files.gemini : files.qwen;
      const cfg = readJson(file) ?? {};
      cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [name]: { command: cmd[0], args: cmd.slice(1) } };
      writeJson(file, cfg);
    } else if (kind === 'grok') {
      // grok mcp add <name> <command> -- <args...> (electron/providers/grok-provider.ts, 0.2.64)
      const name = words[0];
      const command = words[1];
      const args = dashes >= 0 ? words.slice(dashes + 1) : words.slice(2);
      addTomlServer(files.grok, name, command, args);
    } else if (kind === 'amp') {
      // amp mcp add <name> -- <command> [args...]: "Added amp.mcpServers.<name> to ~/.config/amp/settings.json" (measured)
      const name = words[0];
      const cmd = dashes >= 0 ? words.slice(dashes + 1) : words.slice(1);
      const cfg = readJson(files.amp) ?? {};
      cfg['amp.mcpServers'] = { ...(cfg['amp.mcpServers'] ?? {}), [name]: { command: cmd[0], args: cmd.slice(1) } };
      writeJson(files.amp, cfg);
    } else {
      // opencode and pi have no `mcp add` that Tars calls: Tars writes their file itself.
      out(`error: unknown command 'mcp'\n`);
      process.exit(1);
    }
    out(`Added MCP server\n`);
    process.exit(0);
  }
  if (['auth', 'login', 'logout', 'update', 'hooks', 'config', 'models', 'doctor', 'upgrade'].includes(argv[0])) { log({ command: argv[0], argv }); out('ok\n'); process.exit(0); }

  // ---- The session's command line, read as each CLI reads it.
  const opts = { prompt: null, oneShot: false, mcpConfigs: [], settingsFile: null, bypass: false, resume: null, model: null };
  const value = (i) => argv[i + 1];
  if (kind === 'claude') {
    const dd = argv.indexOf('--');
    const before = dd >= 0 ? argv.slice(0, dd) : argv;
    if (dd >= 0) opts.prompt = argv.slice(dd + 1).join(' ') || null;
    for (let i = 0; i < before.length; i++) {
      const a = before[i];
      if (a === '--mcp-config') { opts.mcpConfigs.push(value(i)); i++; }
      else if (a === '--dangerously-skip-permissions') opts.bypass = true;
      else if (a === '--permission-mode') { opts.bypass = value(i) === 'bypassPermissions'; i++; }
      else if (a === '--resume' || a === '-r') { opts.resume = value(i); i++; }
      else if (a === '--session-id') { opts.resume = opts.resume ?? null; opts.sessionId = value(i); i++; }
      else if (a === '--model') { opts.model = value(i); i++; }
      else if (a === '-p' || a === '--print') opts.oneShot = true;
      else if (a.startsWith('--') && before[i + 1] !== undefined && !before[i + 1].startsWith('-')) i++;
    }
  } else if (kind === 'qwen-code') {
    // Options from `qwen --help` (0.25.2), and --add-dir, which it took without complaint (measured).
    const KNOWN = new Set(['telemetry', 'telemetry-target', 'telemetry-otlp-endpoint', 'telemetry-otlp-protocol', 'telemetry-log-prompts', 'telemetry-outfile', 'debug', 'd', 'bare', 'safe-mode', 'proxy', 'insecure', 'chat-recording', 'model', 'm', 'advisor', 'fallback-model', 'prompt', 'p', 'prompt-interactive', 'i', 'system-prompt', 'append-system-prompt', 'output-style', 'sandbox', 's', 'sandbox-image', 'yolo', 'y', 'approval-mode', 'acp', 'experimental-lsp', 'restore-ask-user-question', 'channel', 'allowed-mcp-server-names', 'disable-mcp-server', 'mcp-config', 'allowed-tools', 'extensions', 'e', 'list-extensions', 'l', 'include-directories', 'add-dir', 'openai-logging', 'openai-logging-dir', 'openai-api-key', 'openai-base-url', 'screen-reader', 'input-format', 'output-format', 'o', 'include-partial-messages', 'json-fd', 'json-file', 'json-schema', 'input-file', 'continue', 'c', 'resume', 'r', 'session-id', 'fork-session', 'worktree', 'max-session-turns', 'max-wall-time', 'max-tool-calls', 'max-subagent-depth', 'core-tools', 'exclude-tools', 'disabled-slash-commands', 'auth-type', 'version', 'v', 'help', 'h']);
    const BOOL = new Set(['debug', 'd', 'bare', 'safe-mode', 'insecure', 'yolo', 'y', 'acp', 'continue', 'c', 'fork-session', 'screen-reader', 'list-extensions', 'l', 'include-partial-messages', 'telemetry', 'telemetry-log-prompts', 'chat-recording', 'experimental-lsp', 'openai-logging']);
    const unknown = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--') { opts.prompt = argv.slice(i + 1).join(' ') || opts.prompt; break; }
      const m = /^-{1,2}([^=]+)(=.*)?$/.exec(a);
      if (!m) { opts.prompt = opts.prompt ?? a; continue; }
      const name = m[1];
      if (!KNOWN.has(name)) { unknown.push(name, name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())); if (argv[i + 1] && !argv[i + 1].startsWith('-')) i++; continue; }
      if (BOOL.has(name)) { if (name === 'yolo' || name === 'y') opts.bypass = true; continue; }
      const v = m[2] ? m[2].slice(1) : argv[++i];
      if (name === 'prompt-interactive' || name === 'i') opts.prompt = v;
      else if (name === 'prompt' || name === 'p') { opts.prompt = v; opts.oneShot = true; }
      else if (name === 'approval-mode') opts.bypass = v === 'yolo';
      else if (name === 'resume' || name === 'r') opts.resume = v;
      else if (name === 'model' || name === 'm') opts.model = v;
      else if (name === 'mcp-config') opts.mcpConfigs.push(v);
    }
    if (unknown.length) {
      log({ launch: true, argv, refused: unknown.filter((_, i) => i % 2 === 0) });
      process.stderr.write(`Usage: qwen [options] [command]\n\nUnknown arguments: ${[...new Set(unknown)].join(', ')}\n`);
      process.exit(1);
    }
  } else if (kind === 'gemini') {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-i' || a === '--prompt-interactive') opts.prompt = argv[++i];
      else if (a === '-p' || a === '--prompt') { opts.prompt = argv[++i]; opts.oneShot = true; }
      else if (a === '-y' || a === '--yolo') opts.bypass = true;
      else if (a === '--approval-mode') opts.bypass = argv[++i] === 'yolo';
      else if (a === '-m' || a === '--model') opts.model = argv[++i];
      else if (a === '--resume' || a === '-r') opts.resume = argv[++i];
      else if (a.startsWith('-')) { if (argv[i + 1] && !argv[i + 1].startsWith('-')) i++; }
      else opts.prompt = opts.prompt ?? a;
    }
  } else if (kind === 'opencode') {
    if (argv[0] === 'run') { opts.oneShot = true; opts.prompt = argv.slice(1).filter((a) => !a.startsWith('-')).join(' '); }
    else for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--prompt') opts.prompt = argv[++i];
      else if (argv[i] === '-m' || argv[i] === '--model') opts.model = argv[++i];
    }
    opts.bypass = true; // opencode asks for nothing Tars depends on
  } else if (kind === 'pi' || kind === 'grok') {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-p' || a === '--print' || a === '--single') { opts.oneShot = true; continue; }
      if (a === '--permission-mode') { opts.bypass = ['bypassPermissions', 'bypass', 'yolo', 'auto'].includes(argv[++i]); continue; }
      if (a === '--model' || a === '-m' || a === '--provider' || a === '--effort') { i++; continue; }
      if (a.startsWith('-')) continue;
      opts.prompt = opts.prompt ? `${opts.prompt} ${a}` : a;
    }
    if (kind === 'pi') opts.bypass = true;
  } else if (kind === 'amp') {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-x' || a === '--execute') { opts.oneShot = true; opts.prompt = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : null; }
      else if (a === '--settings-file') opts.settingsFile = argv[++i];
      else if (a === '--dangerously-allow-all') opts.bypass = true;
      else if (a === '--mode') i++;
    }
  }

  // ---- Its settings: hooks, MCP servers.
  const settings = kind === 'claude' ? (readJson(path.join(claudeDir, 'settings.json')) ?? {})
    : kind === 'gemini' ? (readJson(files.gemini) ?? {})
      : kind === 'qwen-code' ? { ...(readJson(files.qwen) ?? {}), ...(readJson(process.env.QWEN_CODE_SYSTEM_SETTINGS_PATH ?? '') ?? {}) }
        : {};
  const hookEvents = { claude: ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'StopFailure'], 'qwen-code': ['SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'PermissionRequest'], gemini: ['SessionStart', 'BeforeAgent', 'AfterAgent', 'Notification'] }[kind] ?? [];

  function mcpServers() {
    const found = {};
    const add = (servers, where) => { for (const [name, s] of Object.entries(servers ?? {})) if (s && !found[name]) found[name] = { ...s, where }; };
    if (kind === 'claude') {
      for (const c of opts.mcpConfigs) {
        const parsed = c && c.trim().startsWith('{') ? (() => { try { return JSON.parse(c); } catch { return undefined; } })() : readJson(c);
        add(parsed?.mcpServers, '--mcp-config');
      }
      add(readJson(claudeJson)?.mcpServers, path.basename(claudeJson));
    } else if (kind === 'gemini' || kind === 'qwen-code') {
      add(settings.mcpServers, 'settings');
      add(readJson(path.join(process.cwd(), kind === 'gemini' ? '.gemini' : '.qwen', 'settings.json'))?.mcpServers, 'project settings');
    } else if (kind === 'amp') {
      add((opts.settingsFile ? readJson(opts.settingsFile) : undefined)?.['amp.mcpServers'], '--settings-file');
      add(readJson(files.amp)?.['amp.mcpServers'], '~/.config/amp/settings.json');
    } else if (kind === 'grok') {
      add(tomlServers(files.grok), '~/.grok/config.toml');
    } else if (kind === 'opencode') {
      for (const f of [path.join(HOME, '.config', 'opencode', 'opencode.json'), path.join(HOME, '.config', 'opencode', 'opencode.jsonc'), path.join(process.cwd(), 'opencode.json')]) {
        const mcp = readJson(f)?.mcp ?? {};
        add(Object.fromEntries(Object.entries(mcp).filter(([, s]) => s?.type === 'local' && Array.isArray(s.command)).map(([n, s]) => [n, { command: s.command[0], args: s.command.slice(1), env: s.environment ?? {} }])), path.basename(f));
      }
    } else if (kind === 'pi') {
      add(readJson(path.join(HOME, '.pi', 'agent', 'mcp.json'))?.mcpServers, '~/.pi/agent/mcp.json');
      add(readJson(path.join(process.cwd(), '.pi', 'mcp.json'))?.mcpServers, '.pi/mcp.json');
    }
    return found;
  }

  /** What an MCP server this CLI starts gets of its environment. */
  function serverEnv(server) {
    const own = server.env ?? {};
    if (kind === 'gemini') {
      const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !GEMINI_REDACTED.test(k)));
      const expanded = Object.fromEntries(Object.entries(own).map(([k, v]) => [k, String(v).replace(/\$\{?([A-Z0-9_]+)\}?/g, (_, n) => process.env[n] ?? '')]));
      return { policy: 'documented: redacted', env: { ...base, ...expanded } };
    }
    const measured = kind === 'claude' || kind === 'qwen-code';
    return { policy: measured ? 'measured: whole environment' : 'assumed: whole environment', env: { ...process.env, ...own } };
  }

  /**
   * One call to an HTTP MCP server, as claude makes it (2.1.312, measured): `${VAR}` in a header is expanded from its
   * own environment, then initialize and the tool's call, each a POST of its own (Tars's shared servers answer JSON).
   */
  async function callHttp(server, tool, args) {
    const headers = Object.fromEntries(Object.entries(server.headers ?? {}).map(([k, v]) => [k, String(v).replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, n) => process.env[n] ?? '')]));
    log({ mcp: true, tool, to: args.id ?? null, calling: true, where: server.where, policy: 'measured: headers expanded', token: /Bearer \S+/.test(headers.Authorization ?? ''), agentId: process.env.CLAUDE_AGENT_ID ?? null });
    const post = async (body) => {
      const r = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch { json = undefined; }
      return { status: r.status, json, text };
    };
    let r;
    try {
      const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: kind, version: spec.version } } });
      if (init.status !== 200) r = { isError: true, text: `initialize answered ${init.status}: ${init.json?.error ?? init.text.slice(0, 200)}` };
      else {
        const called = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } });
        const msg = called.json ?? {};
        r = called.status !== 200
          ? { isError: true, text: `tools/call answered ${called.status}: ${msg.error?.message ?? msg.error ?? called.text.slice(0, 200)}` }
          : { isError: !!msg.result?.isError || !!msg.error, text: msg.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(msg.error ?? {}) };
      }
    } catch (e) {
      r = { isError: true, text: `the server did not answer: ${e.message}` };
    }
    log({ mcp: true, tool, to: args.id ?? null, isError: r.isError, text: r.text.slice(0, 3000) });
    return r;
  }

  /** One tool of Tars's MCP server, started as this CLI starts it, then called once. */
  function callTars(tool, args) {
    const server = mcpServers()['claude-mgr-orchestrator'];
    // Claude's own binary reads an HTTP entry (Tars's shared servers); the other CLIs here read only stdio ones.
    if (server && server.type === 'http' && server.url && kind === 'claude') return callHttp(server, tool, args);
    if (!server || !server.command) {
      log({ mcp: true, tool, to: args.id ?? null, isError: true, text: 'no Tars server where this CLI reads its MCP servers' });
      return Promise.resolve({ isError: true, text: 'no Tars server where this CLI reads its MCP servers' });
    }
    const { policy, env } = serverEnv(server);
    log({ mcp: true, tool, to: args.id ?? null, calling: true, where: server.where, policy, token: !!env.CLAUDE_MGR_API_TOKEN, agentId: env.CLAUDE_AGENT_ID ?? null });
    return new Promise((resolve) => {
      const child = spawn(server.command, server.args ?? [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let said = '';
      let buffered = '';
      let settled = false;
      const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } log({ mcp: true, tool, to: args.id ?? null, isError: r.isError, text: r.text.slice(0, 3000) }); resolve(r); };
      const timer = setTimeout(() => done({ isError: true, text: `no answer from Tars's server in 150 s: ${said.trim().split('\n').pop() ?? ''}` }), 150_000);
      child.stderr.on('data', (d) => { said = (said + d).slice(-400); });
      child.on('error', (e) => done({ isError: true, text: `the server did not start: ${e.message}` }));
      child.on('exit', (code) => done({ isError: true, text: `the server ended (${code}): ${said.trim().split('\n').pop() ?? ''}` }));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffered += chunk;
        for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
          const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id === 1) {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }) + '\n');
          } else if (msg.id === 2) {
            const text = msg.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(msg.error ?? {});
            done({ isError: !!msg.result?.isError || !!msg.error, text });
          }
        }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: kind, version: spec.version } } }) + '\n');
    });
  }

  // ---- Its session: id, transcript, hooks.
  const cwd = process.cwd();
  const sid = opts.resume || opts.sessionId || crypto.randomUUID();
  const transcript = kind === 'claude' ? path.join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sid}.jsonl`)
    : kind === 'qwen-code' ? path.join(HOME, '.qwen', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'chats', `${sid}.jsonl`)
      : kind === 'gemini' ? path.join(HOME, '.gemini', 'tmp', crypto.createHash('sha256').update(cwd).digest('hex'), 'chats', `session-${sid}.json`)
        // pi 1.3.0 writes its session in the folder Tars names for it (PI_CODING_AGENT_SESSION_DIR), which #483 follows.
        : kind === 'pi' && process.env.PI_CODING_AGENT_SESSION_DIR
          ? path.join(process.env.PI_CODING_AGENT_SESSION_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}_${sid}.jsonl`)
          : null;
  if (transcript) fs.mkdirSync(path.dirname(transcript), { recursive: true });
  let n = 0;
  const record = (type, text, usage) => {
    if (!transcript || kind === 'gemini') return;
    n += 1;
    const at = new Date().toISOString();
    if (kind === 'pi') {
      // pi 1.3.0's lines, as fix/pi-turns-end's stand-in writes them: a header, then one message line each.
      if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: at, cwd }) + '\n');
      fs.appendFileSync(transcript, JSON.stringify({ type: 'message', id: `e${n}`, parentId: null, timestamp: at, message: type === 'user'
        ? { role: 'user', content: text, timestamp: Date.now() }
        : { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now() } }) + '\n');
    } else if (kind === 'claude') {
      fs.appendFileSync(transcript, JSON.stringify(type === 'user'
        ? { type: 'user', uuid: crypto.randomUUID(), sessionId: sid, cwd, timestamp: at, message: { role: 'user', content: text } }
        : { type: 'assistant', uuid: crypto.randomUUID(), sessionId: sid, cwd, requestId: `req_${sid}_${n}`, timestamp: at, isSidechain: false, message: { id: `msg_${sid}_${n}`, role: 'assistant', model: opts.model || 'claude-haiku-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: usage ?? { input_tokens: 1200, output_tokens: 80 } } }) + '\n');
    } else {
      // qwen's lines, as fix/qwen-code's stand-in writes them (parts and usageMetadata, measured on 0.25.2).
      fs.appendFileSync(transcript, JSON.stringify(type === 'user'
        ? { sessionId: sid, cwd, timestamp: at, uuid: crypto.randomUUID(), type: 'user', message: { role: 'user', parts: [{ text }] } }
        : { sessionId: sid, cwd, timestamp: at, uuid: crypto.randomUUID(), type: 'assistant', model: opts.model || 'deepseek-v4-flash', message: { role: 'model', parts: [{ text }] }, usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 80, totalTokenCount: 1280 } }) + '\n');
    }
  };
  const hook = (event, payload = {}) => {
    if (!hookEvents.includes(event)) return;
    for (const entry of settings.hooks?.[event] ?? []) {
      for (const h of entry.hooks ?? []) {
        if (h.type && h.type !== 'command') continue;
        const r = spawnSync('/bin/sh', ['-c', h.command], { input: JSON.stringify({ session_id: sid, transcript_path: transcript, cwd, hook_event_name: event, timestamp: new Date().toISOString(), ...payload }), env: process.env, timeout: (h.timeout ?? 20) * 1000, encoding: 'utf8' });
        log({ hook: event, exit: r.status });
      }
    }
  };

  // ---- Claude Code's own questions before it takes anything (claude 2.1.302, #458's measure, ensureProjectTrusted).
  let loggedIn = true;
  let question = null; // what the next typed line answers instead of being a turn
  if (kind === 'claude' && !opts.oneShot) {
    const cfg = readJson(claudeJson) ?? {};
    const real = fs.realpathSync(cwd);
    const trusted = cfg.projects?.[real]?.hasTrustDialogAccepted === true || cfg.projects?.[cwd]?.hasTrustDialogAccepted === true;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const approved = apiKey && (cfg.customApiKeyResponses?.approved ?? []).includes(apiKey.slice(-20));
    if (!trusted) question = 'trust';
    else if (apiKey && !approved) question = 'api-key';
    if (process.env.ANTHROPIC_BASE_URL && !process.env.ANTHROPIC_AUTH_TOKEN && !approved) loggedIn = false;
  }

  const permissionMode = opts.bypass ? 'bypassPermissions' : 'default';
  log({ launch: true, argv, cwd, token: !!process.env.CLAUDE_MGR_API_TOKEN, instance: !!process.env.TARS_INSTANCE_ID, sid, prompt: opts.prompt, oneShot: opts.oneShot, question, loggedIn, servers: Object.keys(mcpServers()) });

  let dialog = null;
  function ask(tag) {
    hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: `echo ${tag}` } });
    hook('Notification', { notification_type: 'permission_prompt', message: `${kind} needs your permission to use Bash` });
    out(`\nDo you want to run echo ${tag}?\n> 1. Yes\n  2. No\n`);
    return new Promise((resolve) => { dialog = resolve; });
  }

  async function turn(text) {
    log({ turn: true, text: text.slice(-600) });
    if (kind === 'gemini') hook('BeforeAgent', { prompt: text });
    else hook('UserPromptSubmit', { prompt: text, permission_mode: permissionMode });
    record('user', text);
    await sleep(900); // long enough for a window that polls to see the turn
    let answer;
    if (kind === 'claude' && !loggedIn) {
      answer = 'Not logged in · Please run /login';
      log({ answer: answer, failed: 'not logged in' });
      out(`\n⎿ ${answer}\n\n> `);
      hook('StopFailure', { error: 'authentication_failed', error_details: answer });
      return;
    }
    const directive = /\b(DELEGATE|SEND|ECHO|APPROVE) (\S+)(?: (.+))?$/ms.exec(text);
    if (!directive) answer = 'ok';
    else if (directive[1] === 'ECHO') answer = `echo ${directive[2]}`;
    else if (directive[1] === 'APPROVE') answer = (opts.bypass || await ask(directive[2])) ? `ran echo ${directive[2]}` : `did not run echo ${directive[2]}`;
    else if (directive[1] === 'SEND') {
      const r = await callTars('send_message', { id: directive[2], message: (directive[3] ?? '').trim() });
      answer = `send_message ${r.isError ? 'refused' : 'sent'}: ${r.text.split('\n')[0]}`;
    } else {
      const r = await callTars('delegate_task', { id: directive[2], prompt: (directive[3] ?? '').trim(), timeoutSeconds: Number(process.env.FAKE_DELEGATE_TIMEOUT_S) || 90 });
      answer = `delegate_task ${r.isError ? 'refused' : 'answered'}: ${r.text}`;
    }
    record('assistant', answer);
    log({ answer: answer.slice(0, 3000) });
    out(`\n● ${answer.split('\n')[0]}\n\n> `);
    if (kind === 'gemini') hook('AfterAgent', { prompt: text, prompt_response: answer, stop_hook_active: false });
    else hook('Stop', { stop_hook_active: false, last_assistant_message: answer, permission_mode: permissionMode });
    if (kind !== 'claude') hook('Notification', { notification_type: 'idle_prompt', message: 'waiting for your input' });
  }

  hook('SessionStart', { source: opts.resume ? 'resume' : 'startup', model: opts.model, permission_mode: permissionMode });
  let busy = Promise.resolve();
  const queue = (text) => { busy = busy.then(() => turn(text)).catch((e) => log({ crashed: String(e) })); };

  if (opts.oneShot) {
    // The one-shot forms (claude -p, qwen -p, opencode run, amp -x, pi -p, grok --single): the task, then exit.
    if (opts.prompt) queue(opts.prompt);
    await busy;
    log({ exited: 'one-shot' });
    process.exit(0);
  }
  if (question === 'trust') out('\nDo you trust the files in this folder?\n> 1. Yes, proceed\n  2. No, exit\n');
  else if (question === 'api-key') out('\nDetected a custom API key in your environment\nDo you want to use this API key?\n  1. Yes\n> 2. No (recommended)\n');
  else out(`${kind} stand-in ready\n> `);
  if (opts.prompt && !question) queue(opts.prompt);
  else if (opts.prompt) log({ lost: 'the first prompt went to the question', question });

  let typed = '';
  // As the TUIs read their input (pi-tui 1.3.0, Claude Code): a bracketed paste goes in whole, its newlines kept, and
  // only an Enter typed outside it submits. Cut at every Enter, a pasted task of two lines was two turns (#483's
  // finding of 19/10, in its own stand-in and in this one).
  let pasting = false;
  const submit = () => {
    const text = typed.trim();
    typed = '';
    if (!text) return;
    log({ typed: text.slice(-1500), head: text.slice(0, 300) });
    if (question === 'trust') { question = null; log({ answered: 'trust', with: text }); return; }
    if (question === 'api-key') {
      // A prompt typed into the question answers it, No being preselected: the key refused for good (#458).
      const cfg = readJson(claudeJson) ?? {};
      const key = process.env.ANTHROPIC_API_KEY ?? '';
      cfg.customApiKeyResponses = { approved: cfg.customApiKeyResponses?.approved ?? [], rejected: [...new Set([...(cfg.customApiKeyResponses?.rejected ?? []), key.slice(-20)])] };
      writeJson(claudeJson, cfg);
      question = null;
      loggedIn = !!process.env.ANTHROPIC_AUTH_TOKEN;
      log({ answered: 'api-key', with: 'No', lost: text.slice(-200) });
      return;
    }
    queue(text);
  };
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', (chunk) => {
    let data = chunk.toString('utf8');
    if (dialog) {
      if (/[1y\r]/.test(data)) { const d = dialog; dialog = null; d(true); }
      else if (/[2n\x1b]/.test(data)) { const d = dialog; dialog = null; d(false); }
      return;
    }
    while (data.length) {
      if (pasting) {
        const end = data.indexOf('\x1b[201~');
        if (end === -1) { typed += data; data = ''; } else { typed += data.slice(0, end); data = data.slice(end + 6); pasting = false; }
        continue;
      }
      const start = data.indexOf('\x1b[200~');
      const keys = start === -1 ? data : data.slice(0, start);
      data = start === -1 ? '' : data.slice(start + 6);
      if (start !== -1) pasting = true;
      for (const ch of keys) {
        if (ch === '\r') submit();
        else typed += ch;
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}
