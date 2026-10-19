// A stand-in of codex-cli 0.163.0 for the specs, as measured on 2026-10-18 (standalone install, ChatGPT account):
// - its arguments are read as 0.163 reads them: an option it does not have (`--full-auto`) is "unexpected argument",
//   exit 2, and `-a` takes on-request or never only;
// - it writes its session where codex does ($CODEX_HOME, else ~/.codex, sessions/<y>/<m>/<d>/rollout-*.jsonl) in
//   codex's lines: session_meta, task_started, turn_context (the effort it was given), the user's message, and
//   task_complete with the answer, or with the error codex reports for a model a ChatGPT account cannot use;
// - in normal mode it asks before running a command, in codex's own dialog, and waits for a key;
// - for `SEND <agent> <text>` it starts Tars's MCP server from its config.toml as codex does, with HOME, PATH, TERM
//   and the variables `env_vars` names (nothing else: measured with a probe server on 0.163), and calls
//   send_message; for `DELEGATE <agent> <prompt>` the same, with delegate_task (e2e/cli-matrix.spec.ts);
// - it reads what is typed into it as codex's composer does: a bracketed paste, then Enter.
// Every launch and turn is logged to FAKE_CODEX_LOG, one JSON line each, with whether the agent's token was in its
// environment, never the token.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const LOG = process.env.FAKE_CODEX_LOG;
const log = (entry) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...entry }) + '\n'); };

const HELP = `Codex CLI

Usage: codex [OPTIONS] [PROMPT]

Options:
  -c, --config <key=value>
  -m, --model <MODEL>
  -s, --sandbox <SANDBOX_MODE>
      --approve-for-me
      --dangerously-bypass-approvals-and-sandbox
  -a, --ask-for-approval <APPROVAL_POLICY>
      --add-dir <DIR>
  -h, --help
`;

const argv = process.argv.slice(2);
const WITH_VALUE = new Set(['-c', '--config', '-m', '--model', '-s', '--sandbox', '-a', '--ask-for-approval', '--add-dir', '-C', '--cd']);
const FLAGS = new Set(['--approve-for-me', '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen']);
const opts = { configs: [], model: null, sandbox: null, approval: null, approveForMe: false, bypass: false, prompt: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help' || a === '-h') { process.stdout.write(HELP); process.exit(0); }
  if (WITH_VALUE.has(a)) {
    const v = argv[++i];
    if (a === '-c' || a === '--config') opts.configs.push(v);
    else if (a === '-m' || a === '--model') opts.model = v;
    else if (a === '-s' || a === '--sandbox') opts.sandbox = v;
    else if (a === '-a' || a === '--ask-for-approval') opts.approval = v;
    continue;
  }
  if (FLAGS.has(a)) {
    if (a === '--approve-for-me') opts.approveForMe = true;
    if (a === '--dangerously-bypass-approvals-and-sandbox') opts.bypass = true;
    continue;
  }
  if (a.startsWith('-')) {
    process.stderr.write(`error: unexpected argument '${a}' found\n\n  tip: to pass '${a}' as a value, use '-- ${a}'\n\nUsage: codex [OPTIONS] [PROMPT]\n\nFor more information, try '--help'.\n`);
    log({ launch: true, argv, refused: a });
    process.exit(2);
  }
  opts.prompt = a;
}
if (opts.approval && !['on-request', 'never'].includes(opts.approval)) {
  process.stderr.write(`error: invalid value '${opts.approval}' for '--ask-for-approval <APPROVAL_POLICY>'\n  [possible values: on-request, never]\n`);
  log({ launch: true, argv, refused: opts.approval });
  process.exit(2);
}
const effort = opts.configs.map(c => /^model_reasoning_effort=(.+)$/.exec(c)?.[1]).find(Boolean)?.replace(/^"|"$/g, '') ?? null;
const asks = !opts.approveForMe && !opts.bypass && opts.approval !== 'never';
log({ launch: true, argv, cwd: process.cwd(), token: !!process.env.CLAUDE_MGR_API_TOKEN, model: opts.model, effort, asks });

const home = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
const started = new Date();
const pad = (n) => String(n).padStart(2, '0');
const dir = path.join(home, 'sessions', String(started.getFullYear()), pad(started.getMonth() + 1), pad(started.getDate()));
fs.mkdirSync(dir, { recursive: true });
const sessionId = randomUUID();
const stamp = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}T${pad(started.getHours())}-${pad(started.getMinutes())}-${pad(started.getSeconds())}`;
const rollout = path.join(dir, `rollout-${stamp}-${sessionId}.jsonl`);
const write = (type, payload) => fs.appendFileSync(rollout, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n');
write('session_meta', { id: sessionId, session_id: sessionId, cwd: process.cwd(), source: 'cli', originator: 'codex-tui', cli_version: '0.163.0', timestamp: started.toISOString() });

const out = (text) => process.stdout.write(text.replace(/\n/g, '\r\n'));
out('>_ OpenAI Codex (v0.163.0)\n\n› ');

let dialog = null; // the key the open approval dialog waits for
function ask(tag) {
  out(`\n\n  Would you like to run the following command?\n\n  $ echo ${tag}\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for this command in this session (a)\n  3. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel\n`);
  return new Promise((resolve) => { dialog = resolve; });
}

function tarsServer() {
  let toml = '';
  try { toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { return null; }
  const section = toml.split(/\n(?=\[)/).map(s => s.trim()).find(s => s.startsWith('[mcp_servers.claude-mgr-orchestrator]'));
  if (!section) return null;
  const get = (key) => { const m = new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm').exec(section); return m ? JSON.parse(m[1]) : undefined; };
  return { command: get('command'), args: get('args') ?? [], envVars: get('env_vars') ?? [] };
}

function sendThroughTars(to, message) {
  return callTars('send_message', { id: to, message });
}

function callTars(tool, args) {
  const server = tarsServer();
  if (!server) return Promise.resolve('no Tars server in config.toml');
  // What codex 0.163 hands an MCP server: HOME, PATH, TERM and the names env_vars lists, from its own environment.
  const env = { HOME: process.env.HOME, PATH: process.env.PATH, TERM: process.env.TERM || 'xterm' };
  for (const name of server.envVars) if (process.env[name] !== undefined) env[name] = process.env[name];
  log({ mcp: true, handed: Object.keys(env).sort(), token: !!env.CLAUDE_MGR_API_TOKEN });
  return new Promise((resolve) => {
    const child = spawn(server.command, server.args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', (d) => log({ mcp: true, stderr: String(d).slice(0, 400) }));
    // A server that ends before it answers ends the call, with what it said: never a turn left open.
    let said = '';
    child.stderr.on('data', (d) => { said = (said + d).slice(-300); });
    child.on('exit', (code) => { for (const [, r] of replies) r({ error: `the Tars server ended (${code}): ${said.trim().split('\n').pop()}` }); replies.clear(); });
    let buffered = '';
    const replies = new Map();
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
        const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        log({ mcp: true, from: 'server', id: msg.id ?? null, method: msg.method ?? null, hasResult: msg.result !== undefined });
        if (typeof msg.id === 'number' && !msg.method) replies.get(msg.id)?.(msg);
      }
    });
    let next = 1;
    const rpc = (method, params) => new Promise((r) => { const id = next++; replies.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    (async () => {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codex-mcp-client', version: '0.163.0' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const reply = await rpc('tools/call', { name: tool, arguments: args });
      const text = reply.result?.content?.map(c => c.text ?? '').join('\n') ?? JSON.stringify(reply.error);
      log({ mcp: true, tool, to: args.id ?? null, isError: !!reply.result?.isError || !!reply.error, text: text.slice(0, tool === 'send_message' ? 400 : 3000) });
      child.kill();
      resolve(tool === 'send_message' ? `${reply.result?.isError ? 'refused' : 'sent'}: ${text.split('\n')[0]}` : `${tool} ${reply.result?.isError ? 'refused' : 'answered'}: ${text}`);
    })();
  });
}

async function turn(text) {
  const turnId = randomUUID();
  write('event_msg', { type: 'task_started', turn_id: turnId });
  write('turn_context', { model: opts.model, approval_policy: opts.approval ?? 'on-request', collaboration_mode: { mode: 'default', settings: { model: opts.model, reasoning_effort: effort } } });
  write('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } });
  log({ turn: true, text: text.slice(-300), effort, model: opts.model });
  if (opts.model === 'gpt-5-codex-mini') {
    const error = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-5-codex-mini' model is not supported when using Codex with a ChatGPT account." } });
    out(`\n■ ${error}\n\n› `);
    write('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: null, error: { message: error } });
    return;
  }
  let answer = 'ok';
  const approve = /APPROVE (\w+)/.exec(text);
  const send = /SEND (\S+) (.+)$/m.exec(text);
  const delegate = /DELEGATE (\S+) (.+)$/m.exec(text);
  const echo = /ECHO (\w+)/.exec(text);
  if (approve) {
    const allowed = asks ? await ask(approve[1]) : true;
    out('\x1b[2J\x1b[H');
    answer = allowed ? `ran echo ${approve[1]}` : `did not run echo ${approve[1]}`;
  } else if (delegate && (!send || delegate.index < send.index)) {
    answer = await callTars('delegate_task', { id: delegate[1], prompt: delegate[2], timeoutSeconds: Number(process.env.FAKE_DELEGATE_TIMEOUT_S) || 90 });
  } else if (send) {
    answer = await sendThroughTars(send[1], send[2]);
  } else if (echo) {
    answer = `echo ${echo[1]}`;
  }
  out(`\n• ${answer}\n\n› `);
  write('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: answer });
}

let busy = Promise.resolve();
const queue = (text) => { busy = busy.then(() => turn(text)); };
if (opts.prompt) queue(opts.prompt);

let typed = '';
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => {
  const data = chunk.toString('utf8');
  if (dialog) {
    if (/[y\r]/.test(data)) { const d = dialog; dialog = null; d(true); }
    else if (/[\x1bn]/.test(data)) { const d = dialog; dialog = null; d(false); }
    return;
  }
  typed += data.replace(/\x1b\[20[01]~/g, '');
  const enter = typed.indexOf('\r');
  if (enter >= 0) {
    const text = typed.slice(0, enter).trim();
    typed = typed.slice(enter + 1);
    if (text) queue(text);
  }
});
process.stdin.resume();
