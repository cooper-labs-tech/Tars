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
  // Hermes Agent (Nous Research), as measured on 0.23.4 (26 and 27/11, reports of the Hermes harness).
  hermes: { binary: 'hermes', version: 'Hermes Agent v0.23.4' },
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
      // Hermes's stand-in writes its state.db through node:sqlite, whose warning would land in the agent's terminal.
      `#!${process.execPath}${kind === 'hermes' ? ' --no-warnings' : ''}`,
      `process.env.FAKE_CLI_KIND = ${JSON.stringify(kind)};`,
      `process.env.FAKE_CLI_LOG = ${JSON.stringify(path.join(home, 'fake-cli.jsonl'))};`,
      ...(delegateTimeoutS ? [`process.env.FAKE_DELEGATE_TIMEOUT_S = '${delegateTimeoutS}';`] : []),
      // The schema Hermes 0.23.4 created its state.db with (its sessions and messages tables, from a real profile).
      ...(kind === 'hermes' ? [`process.env.FAKE_HERMES_SCHEMA = ${JSON.stringify(path.resolve('__tests__', 'fixtures', 'hermes-agent', 'profile-state.sql'))};`] : []),
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

/** Hermes's mcp_servers, from a config.yaml as Tars writes it: double-quoted scalars, flow lists of strings. */
function hermesMcp(text) {
  const servers = {};
  let inBlock = false;
  let name = null;
  let inEnv = false;
  for (const line of text.split('\n')) {
    if (/^mcp_servers:/.test(line)) { inBlock = true; continue; }
    if (!inBlock || !line.trim() || line.startsWith('#')) continue;
    if (/^\S/.test(line)) break;
    let m;
    if ((m = /^ {2}("(?:[^"\\]|\\.)*"|[A-Za-z0-9_-]+):\s*$/.exec(line))) { name = m[1].startsWith('"') ? JSON.parse(m[1]) : m[1]; servers[name] = { args: [], env: {} }; inEnv = false; }
    else if (name && (m = /^ {4}command: (.+)$/.exec(line))) servers[name].command = JSON.parse(m[1]);
    else if (name && (m = /^ {4}args: (.+)$/.exec(line))) servers[name].args = JSON.parse(m[1]);
    else if (name && /^ {4}env:/.test(line)) inEnv = !/\{\}\s*$/.test(line);
    else if (name && inEnv && (m = /^ {6}([A-Za-z0-9_]+): (.+)$/.exec(line))) servers[name].env[m[1]] = JSON.parse(m[2]);
  }
  return servers;
}

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
  } else if (kind === 'hermes') {
    // hermes chat [--source <tag>] [-m <model>] [--yolo] [--resume <id>] [-q <text>] [--oneshot] [--format <f>] (0.23.4).
    if (argv[0] !== 'chat') { log({ command: argv[0], argv }); out('ok\n'); process.exit(0); }
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--source') opts.source = argv[++i];
      else if (a === '-m' || a === '--model') opts.model = argv[++i];
      else if (a === '--yolo') opts.bypass = true;
      else if (a === '--resume') opts.resume = argv[++i];
      else if (a === '-q' || a === '--query') opts.prompt = argv[++i];
      else if (a === '--oneshot') opts.oneShot = true;
      else if (a === '--format') i++;
      else { log({ launch: true, argv, refused: [a] }); process.stderr.write(`hermes chat: error: unrecognized arguments: ${a}\n`); process.exit(2); }
    }
    // Its gateway takes the tags it knows, `tool` for an integration's sessions (measured: `tars` refused).
    if (opts.source && !['cli', 'tool'].includes(opts.source)) {
      log({ launch: true, argv, refused: [`--source ${opts.source}`] });
      process.stderr.write(`Gateway does not support source '${opts.source}'\n`);
      process.exit(1);
    }
  }

  // ---- Hermes's home (HERMES_HOME, else ~/.hermes): its profile's secret scope (.env), which the gateway hands a
  // session's provider and its MCP servers' ${VAR}, and its config.yaml (0.23.4, measured 27/11). The terminal's own
  // variables do not reach a session: the one gateway of the home was started by whichever terminal came first.
  const hermesHome = kind === 'hermes' ? (process.env.HERMES_HOME || path.join(HOME, '.hermes')) : null;
  const hermesScope = {};
  let hermesConfig = '';
  if (hermesHome) {
    try { for (const l of fs.readFileSync(path.join(hermesHome, '.env'), 'utf8').split('\n')) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l); if (m) hermesScope[m[1]] = m[2]; } } catch { /* none */ }
    try { hermesConfig = fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8'); } catch { /* none */ }
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
    } else if (kind === 'hermes') {
      add(hermesMcp(hermesConfig), 'config.yaml');
    }
    return found;
  }

  /** What an MCP server this CLI starts gets of its environment. */
  function serverEnv(server) {
    const own = server.env ?? {};
    if (kind === 'hermes') {
      // A safe list of the gateway's variables, and the server's own `env`, its ${VAR} from the profile's .env only.
      const SAFE = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TERM', 'SHELL', 'TMPDIR'];
      const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => SAFE.includes(k) || k.startsWith('XDG_')));
      const expanded = Object.fromEntries(Object.entries(own).map(([k, v]) => [k, String(v).replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, n) => hermesScope[n] ?? '')]));
      return { policy: 'measured: safe list, ${VAR} from the profile .env', env: { ...base, ...expanded } };
    }
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
    // Tars's shared servers answer an event stream (progress, then the result), as claude reads it.
    const post = async (body) => {
      const r = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
      const text = await r.text();
      const messages = (r.headers.get('content-type') ?? '').includes('text/event-stream')
        ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return undefined; } }).filter(Boolean)
        : (() => { try { return [JSON.parse(text)]; } catch { return []; } })();
      return { status: r.status, json: messages.find((m) => m.id === body.id) ?? messages[0], text };
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
  const sid = opts.resume || opts.sessionId || (kind === 'hermes' ? `local-${crypto.randomBytes(32).toString('hex')}` : crypto.randomUUID());
  // Hermes's session store: <HERMES_HOME>/state.db (WAL), its sessions and messages tables as 0.23.4 creates them, one
  // row per message as it ends: an assistant's finish_reason tool_calls while the turn goes on, stop at its end.
  let hermesDb = null;
  if (kind === 'hermes' && hermesHome) {
    const { DatabaseSync } = await import('node:sqlite');
    fs.mkdirSync(hermesHome, { recursive: true });
    // Only the two tables Tars reads: sessions' key to system_prompts, which is not made here, is not enforced.
    hermesDb = new DatabaseSync(path.join(hermesHome, 'state.db'), { enableForeignKeyConstraints: false });
    hermesDb.exec('PRAGMA journal_mode=WAL');
    const schema = fs.readFileSync(process.env.FAKE_HERMES_SCHEMA, 'utf8').split('\n').filter((l) => !/^(INSERT|PRAGMA|BEGIN|COMMIT)/.test(l)).join('\n');
    hermesDb.exec(schema.replace(/CREATE TABLE (\w+)/g, 'CREATE TABLE IF NOT EXISTS $1'));
  }
  const hermesRow = (role, content, finish = null, tool = null) => {
    if (!hermesDb) return;
    hermesDb.prepare("INSERT OR IGNORE INTO sessions (id, source, model, started_at, profile_name, cwd) VALUES (?, 'tool', ?, ?, ?, ?)").run(sid, opts.model ?? null, Date.now() / 1000, path.basename(hermesHome), cwd);
    hermesDb.prepare('INSERT INTO messages (session_id, role, content, tool_name, timestamp, finish_reason) VALUES (?, ?, ?, ?, ?, ?)').run(sid, role, content, tool, Date.now() / 1000, finish);
  };
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
    if (kind === 'hermes') { hermesRow(type, text, type === 'assistant' ? 'stop' : null); return; }
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
  // Hermes asks about telemetry at its first interactive start, unless its config answered it (0.23.4, measured 26/11).
  if (kind === 'hermes' && !opts.oneShot && !/^ {4}offer_version: 2$/m.test(hermesConfig)) question = 'telemetry';

  const permissionMode = opts.bypass ? 'bypassPermissions' : 'default';
  log({ launch: true, argv, cwd, token: !!process.env.CLAUDE_MGR_API_TOKEN, instance: !!process.env.TARS_INSTANCE_ID, sid, prompt: opts.prompt, oneShot: opts.oneShot, question, loggedIn, servers: Object.keys(mcpServers()) });
  // What Hermes was started with: which home, what its profile's .env names (never a value), what its terminal holds,
  // and which of Tars's guards its config carries.
  if (kind === 'hermes') {
    const has = (re) => re.test(hermesConfig);
    // The root's config, two folders up (<root>/profiles/<agent id>): what the gateway resolves its own provider from.
    const rootConfig = (() => { try { return fs.readFileSync(path.join(hermesHome, '..', '..', 'config.yaml'), 'utf8'); } catch { return ''; } })();
    const loopbackModelsDev = (text) => /^models_dev:\n {2}url: "http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/[^"]*"$/m.test(text);
    log({
      hermes: true, home: hermesHome, scope: Object.keys(hermesScope).sort(), source: opts.source ?? null,
      terminal: { token: !!process.env.CLAUDE_MGR_API_TOKEN, endpointToken: !!process.env.TARS_ENDPOINT_TOKEN, openaiKey: !!process.env.OPENAI_API_KEY, openaiBase: !!process.env.OPENAI_BASE_URL, awsMetadataOff: process.env.AWS_EC2_METADATA_DISABLED === 'true' },
      root: { customProvider: /^model:\n {2}provider: "custom"\n {2}base_url: "http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/v1"$/m.test(rootConfig), lazyInstallsOff: /^security:\n {2}allow_lazy_installs: false$/m.test(rootConfig), modelsDevLocal: loopbackModelsDev(rootConfig) },
      envMode: (() => { try { return (fs.statSync(path.join(hermesHome, '.env')).mode & 0o777).toString(8); } catch { return null; } })(),
      guards: {
        telemetry: has(/^ {4}offer_version: 2$/m), adoptLogins: has(/^ {2}adopt_external_logins: false$/m), updates: has(/^updates:\n {2}check: false$/m),
        modelCatalog: has(/^model_catalog:\n {2}enabled: false$/m), pluginChecks: has(/^plugins:\n {2}auto_update_check_hours: 0$/m),
        lazyInstallsOff: has(/^security:\n {2}allow_lazy_installs: false$/m), modelsDevLocal: loopbackModelsDev(hermesConfig),
        ownToolEnv: has(/^terminal:\n {2}client_env_passthrough: \[.*"CLAUDE_AGENT_ID".*"TMPDIR".*\]$/m),
        approvals: /^approvals:\n {2}mode: "(\w+)"$/m.exec(hermesConfig)?.[1] ?? null,
      },
    });
  }

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
    if (kind === 'hermes') {
      // A SEND goes through Tars's MCP server first, as the agent it runs for (its token from the profile's .env).
      let sent = '';
      // WHOAMI: who Tars says this agent is, through its MCP server (a token of another agent's is refused there).
      if (/\bWHOAMI\b/.test(text)) {
        const r = await callTars('whoami', {});
        sent += `whoami ${r.isError ? 'refused' : 'answered'}: ${r.text.split('\n')[0]} `;
      }
      if (directive?.[1] === 'SEND') {
        const r = await callTars('send_message', { id: directive[2], message: (directive[3] ?? '').trim() });
        sent = `send_message ${r.isError ? 'refused' : 'sent'}. `;
      }
      // The endpoint, its key and its model from the profile (the .env and config.yaml), never the terminal's; the
      // shell tool is `terminal`, each step a row of state.db.
      const model = /^model:\n(?: {2}.*\n)*? {2}default: "([^"]*)"$/m.exec(hermesConfig)?.[1];
      answer = sent + await modelTurn(text, {
        base: hermesScope.OPENAI_BASE_URL, key: hermesScope.OPENAI_API_KEY ?? '', model: opts.model ?? model, tool: 'terminal',
        onStep: (s) => hermesRow(s.role, s.content, s.finish ?? null, s.tool ?? null),
      });
    } else if (kind === 'qwen-code' && process.env.OPENAI_BASE_URL) answer = await modelTurn(text);
    else if (!directive) answer = 'ok';
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

  // On an inference endpoint (Tars's endpoint proxy, OPENAI_BASE_URL and OPENAI_API_KEY in its environment, as
  // Qwen Code 0.25.2 reads them with --auth-type openai, measured 19/11): a turn is a model's, through chat
  // completions, streamed, with a shell tool. The command asked for is run as its words say (an `echo` prints its
  // argument), on every system alike, and its output is sent back as the tool's result. Logged: each request's
  // status, the time its first chunk came and the time it ended, and what the key looked like (its first four
  // characters), never the key.
  async function modelTurn(text, endpoint = { base: process.env.OPENAI_BASE_URL, key: process.env.OPENAI_API_KEY ?? '', model: process.env.OPENAI_MODEL, tool: 'run_shell_command' }) {
    const base = String(endpoint.base ?? '').replace(/\/+$/, '');
    const key = endpoint.key ?? '';
    const tools = [{ type: 'function', function: { name: endpoint.tool, description: 'Run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }];
    const messages = [{ role: 'system', content: 'You are a stand-in coding agent.' }, { role: 'user', content: text }];
    // A task that asks for a title gets a side request first, as opencode's title call is (no tools, a system prompt of
    // its own, not streamed): what a trace marks `side`.
    if (/\btitle\b/i.test(text)) {
      const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: endpoint.model, messages: [{ role: 'system', content: 'Generate a short title for the conversation.' }, { role: 'user', content: text }], stream: false }) });
      await res.text();
      log({ model: true, side: true, status: res.status, keyHead: key.slice(0, 4), keyLength: key.length });
    }
    for (let step = 0; step < 4; step++) {
      const sentAt = Date.now();
      const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: endpoint.model, messages, tools, stream: true, stream_options: { include_usage: true } }) });
      let firstChunkAt;
      let raw = '';
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (firstChunkAt === undefined) firstChunkAt = Date.now();
        raw += Buffer.from(value).toString('utf8');
      }
      log({ model: true, status: res.status, sentAt, firstChunkAt, endAt: Date.now(), keyHead: key.slice(0, 4), keyLength: key.length, keyHash: crypto.createHash("sha256").update(key).digest("hex").slice(0, 16), model_: process.env.OPENAI_MODEL });
      if (!res.ok) return `the endpoint answered ${res.status}`;
      let content = '';
      const calls = new Map();
      for (const block of raw.split('\n\n')) {
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        for (const c of chunk.choices ?? []) {
          content += c.delta?.content ?? '';
          for (const tc of c.delta?.tool_calls ?? []) {
            const call = calls.get(tc.index) ?? { id: '', name: '', arguments: '' };
            if (tc.id) call.id = tc.id;
            if (tc.function?.name) call.name += tc.function.name;
            call.arguments += tc.function?.arguments ?? '';
            calls.set(tc.index, call);
          }
        }
      }
      if (!calls.size) return content || 'no answer';
      const list = [...calls.values()];
      messages.push({ role: 'assistant', content: null, tool_calls: list.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) });
      endpoint.onStep?.({ role: 'assistant', content: content || null, finish: 'tool_calls' });
      for (const c of list) {
        let command = '';
        try { command = JSON.parse(c.arguments).command ?? ''; } catch { /* nothing */ }
        const echoed = /^echo (.+)$/.exec(String(command).trim());
        const result = echoed ? `${echoed[1]}\n` : `ran ${command}`;
        messages.push({ role: 'tool', tool_call_id: c.id, content: result });
        endpoint.onStep?.({ role: 'tool', content: result, tool: c.name });
      }
    }
    return 'too many steps';
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
  else if (question === 'telemetry') out('\nHelp improve Hermes?\n  ( ) Share with Nous\n  (*) No thanks\n');
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
    // Hermes's question takes the first line typed, its Enter choosing the default (measured 26/11): the task is lost.
    if (question === 'telemetry') { question = null; log({ answered: 'telemetry', lost: text.slice(-200) }); out('\n> '); return; }
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
