// A stand-in of codex-cli 0.163.0 for the specs, as measured on 2026-10-18 (standalone install, ChatGPT account):
// - its arguments are read as 0.163 reads them: an option it does not have (`--full-auto`) is "unexpected argument",
//   exit 2, and `-a` takes on-request or never only;
// - it writes its session where codex does ($CODEX_HOME, else ~/.codex, sessions/<y>/<m>/<d>/rollout-*.jsonl) in
//   codex's lines: session_meta, task_started, turn_context (the effort it was given), the user's message, and
//   task_complete with the answer, or with the error codex reports for a model a ChatGPT account cannot use;
// - in normal mode it asks before running a command, in codex's own dialog, and before calling an MCP server's tool,
//   in the form 0.163 draws for it (measured with a probe server), and waits for a key;
// - for `SEND <agent> <text>` it starts Tars's MCP server from its config.toml as codex does, with HOME, PATH, TERM
//   and the variables `env_vars` names (nothing else: measured with a probe server on 0.163), and calls
//   send_message; for `DELEGATE <agent> <prompt>` the same, with delegate_task (e2e/cli-matrix.spec.ts);
// - it reads what is typed into it as codex's composer does: a bracketed paste, then Enter;
// - `HOLD <tag>` works until Esc is pressed, then logs the turn as 0.163 does when it is interrupted: `turn_aborted`
//   (reason `interrupted`), and no task_complete;
// - in a folder its config.toml does not trust (`[projects."<real path>"] trust_level = "trusted"`), it first asks
//   "Trust this folder?" and starts no session until it is answered;
// - started with no prompt, it writes no rollout before its first turn; `codex resume <id>` appends to that
//   session's own rollout (a thread_settings_applied line at once, no session_meta), and `codex fork <id>` begins a
//   new one whose session_meta names the session it forks (forked_from_id); `RECALL` answers with the first `ECHO`
//   of the session, read back from its rollout: the conversation goes on across a restart of Tars;
// - it holds its rollout open from its first line to its end, as 0.163 does (measured with lsof: at the file's first
//   sight, through the turn and at rest), which is how Tars knows a session nobody named is its agent's;
// - `--help` answers after FAKE_CODEX_HELP_MS, a codex slow to answer as under a heavy load (0 unless set);
// - its update prompt, as 0.170.0 draws it at its start (measured 21/11 in a sandbox): from the version.json an earlier
//   start wrote in its home ({"latest_version":"0.171.0","last_checked_at":...,"dismissed_version":null}), when it
//   names a newer version than this one and not the one skipped for good, unless the line says
//   `-c check_for_update_on_startup=false`. A task on its line waits behind it. Its Enter takes the option shown
//   selected, "1. Update now": codex ran npm install -g @openai/codex, said to restart it and exited 0 (QA's gate of
//   the #601 stack). This one installs nothing: it logs the choice and exits 0. Esc or 2 skips it, 3 skips that version;
// - `codex login status` exits 0 "Logged in using ChatGPT" or 1 "Not logged in", as 0.163 does (measured). With
//   FAKE_CODEX_SIGN_IN=1 it reads its login as codex does by default, from its home's auth.json, and a home with none
//   shows 0.163's sign-in screen, waits for a key and writes no session (measured on 0.163); without, it is signed in.
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
const codexHomeNow = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
const signedIn = () => process.env.FAKE_CODEX_SIGN_IN !== '1' || fs.existsSync(path.join(codexHomeNow, 'auth.json'));
if (argv[0] === 'login' && argv[1] === 'status') {
  log({ login: 'status', codexHome: process.env.CODEX_HOME ?? null, signedIn: signedIn() });
  process.stdout.write(signedIn() ? 'Logged in using ChatGPT\n' : 'Not logged in\n');
  process.exit(signedIn() ? 0 : 1);
}
if (argv[0] === '--help' || argv[0] === '-h') {
  log({ help: true });
  await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_CODEX_HELP_MS) || 0));
  process.stdout.write(HELP);
  process.exit(0);
}
const WITH_VALUE = new Set(['-c', '--config', '-m', '--model', '-s', '--sandbox', '-a', '--ask-for-approval', '--add-dir', '-C', '--cd']);
const FLAGS = new Set(['--approve-for-me', '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen']);
const opts = { configs: [], model: null, sandbox: null, approval: null, approveForMe: false, bypass: false, prompt: null, sub: null, session: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (i === 0 && (a === 'resume' || a === 'fork')) { opts.sub = a; continue; }
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
  if (opts.sub && opts.session === null) opts.session = a;
  else opts.prompt = a;
}
if (opts.approval && !['on-request', 'never'].includes(opts.approval)) {
  process.stderr.write(`error: invalid value '${opts.approval}' for '--ask-for-approval <APPROVAL_POLICY>'\n  [possible values: on-request, never]\n`);
  log({ launch: true, argv, refused: opts.approval });
  process.exit(2);
}
const effort = opts.configs.map(c => /^model_reasoning_effort=(.+)$/.exec(c)?.[1]).find(Boolean)?.replace(/^"|"$/g, '') ?? null;
const asks = !opts.approveForMe && !opts.bypass && opts.approval !== 'never';
log({ launch: true, argv, cwd: process.cwd(), token: !!process.env.CLAUDE_MGR_API_TOKEN, model: opts.model, effort, asks, codexHome: process.env.CODEX_HOME ?? null });

const home = process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
const out = (text) => process.stdout.write(text.replace(/\n/g, '\r\n'));

/** Whether config.toml trusts this folder, by its real path, as codex 0.163 reads it. */
function trusted(dir) {
  let toml = '';
  try { toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { return false; }
  const header = `[projects.${JSON.stringify(dir)}]`;
  const at = toml.indexOf(header);
  if (at < 0) return false;
  return /^trust_level\s*=\s*"trusted"/m.test(toml.slice(at + header.length).split(/\n\[/)[0]);
}

let booted = false;
/** The session's log, once the session begins (its first turn, or a resume or a fork at once). */
let write = () => {};
let sessionId = null;
let sessionFile = null;
const pad = (n) => String(n).padStart(2, '0');
/** A rollout of this home, by its session's id, in whichever day it began. */
function rolloutOf(id) {
  const sessions = path.join(home, 'sessions');
  const list = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  for (const y of list(sessions)) for (const m of list(path.join(sessions, y))) for (const d of list(path.join(sessions, y, m))) {
    const name = list(path.join(sessions, y, m, d)).find(n => n.endsWith(`-${id}.jsonl`));
    if (name) return path.join(sessions, y, m, d, name);
  }
  return null;
}
function appendTo(file) {
  // Opened once, and held until the process ends, as codex holds its rollout.
  const fd = fs.openSync(file, 'a');
  return (type, payload) => fs.writeSync(fd, JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + '\n');
}
function newSession(extra = {}) {
  const started = new Date();
  const dir = path.join(home, 'sessions', String(started.getFullYear()), pad(started.getMonth() + 1), pad(started.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  sessionId = randomUUID();
  const stamp = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}T${pad(started.getHours())}-${pad(started.getMinutes())}-${pad(started.getSeconds())}`;
  sessionFile = path.join(dir, `rollout-${stamp}-${sessionId}.jsonl`);
  write = appendTo(sessionFile);
  write('session_meta', { id: sessionId, session_id: sessionId, cwd: process.cwd(), source: 'cli', originator: 'codex-tui', cli_version: '0.163.0', timestamp: started.toISOString(), ...extra });
}
function boot() {
  booted = true;
  if (opts.sub) {
    const file = opts.session ? rolloutOf(opts.session) : null;
    if (!file) {
      process.stderr.write(`Error: no saved session found with id ${opts.session}\n`);
      log({ refused: `no session ${opts.session}` });
      process.exit(1);
    }
    if (opts.sub === 'resume') {
      sessionId = opts.session;
      sessionFile = file;
      write = appendTo(file);
    } else {
      newSession({ forked_from_id: opts.session });
    }
    write('event_msg', { type: 'thread_settings_applied' });
    log({ session: sessionId, [opts.sub]: opts.session });
  }
  out('>_ OpenAI Codex (v0.163.0)\n\n› ');
  const latest = updateOffer();
  if (latest) {
    updatePrompt = { selected: 1, latest };
    log({ updatePrompt: 'shown', latest });
    out(`\n  Update available · ${OWN_VERSION} → ${latest}\n  Release notes: https://github.com/openai/codex/releases/latest\n\n› 1. Update now (runs \`npm install -g @openai/codex\`)\n  2. Skip\n  3. Skip until next version\n\n  enter continue · esc skip\n`);
    return;
  }
  if (opts.prompt) queue(opts.prompt);
}

const OWN_VERSION = '0.163.0';
/** Whether version `a` is after `b`, part by part. */
const newer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
/** The newer version the update prompt offers, or null: none known, already skipped, or the check switched off. */
function updateOffer() {
  if (opts.configs.some(c => /^check_for_update_on_startup\s*=\s*false$/.test(c))) return null;
  let known;
  try { known = JSON.parse(fs.readFileSync(path.join(home, 'version.json'), 'utf8')); } catch { return null; }
  const latest = typeof known?.latest_version === 'string' ? known.latest_version : null;
  return latest && newer(latest, OWN_VERSION) && latest !== known.dismissed_version ? latest : null;
}
let updatePrompt = null; // the update prompt on screen: the option selected, and the version offered
/** An option of the update prompt taken: 1 "installs" and exits, as codex does; 2 and 3 go on to the session. */
function chooseUpdate(option) {
  const { latest } = updatePrompt;
  updatePrompt = null;
  if (option === 1) {
    log({ updatePrompt: 'update-now', latest });
    out('\nUpdating Codex via `npm install -g @openai/codex`...\n\nUpdate ran successfully. Please restart Codex.\n');
    process.exit(0);
  }
  if (option === 3) {
    try {
      const file = path.join(home, 'version.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), dismissed_version: latest }));
    } catch { /* nothing to remember it in */ }
  }
  log({ updatePrompt: option === 3 ? 'skip-version' : 'skip', latest });
  out('\x1b[2J\x1b[H>_ OpenAI Codex (v0.163.0)\n\n› ');
  if (opts.prompt) queue(opts.prompt);
}

let dialog = null; // the open approval: which one, and what answering it resolves
let holding = null; // a turn at work until Esc
function ask(tag) {
  out(`\n\n  Would you like to run the following command?\n\n  $ echo ${tag}\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for this command in this session (a)\n  3. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel\n`);
  return new Promise((resolve) => { dialog = { kind: 'command', resolve }; });
}
/** The form codex 0.163 draws before it calls an MCP server's tool; Enter submits Allow, the option shown selected. */
function askTool(server, tool) {
  out(`\n◦ Calling ${server}.${tool}\n    + Show details\n\n  Field 1/1\n  Allow the ${server} MCP server to run tool "${tool}"?\n  › 1. Allow                   Run the tool and continue\n    2. Allow for this session  Run the tool and remember this choice for this session\n    3. Always allow            Run the tool and remember this choice for future tool calls\n    4. Cancel                  Cancel this tool call\n  enter to submit | esc to cancel\n`);
  return new Promise((resolve) => { dialog = { kind: 'tool', resolve }; });
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
  // codex begins a fresh session's rollout with its first turn, and not before (measured on 0.163).
  if (!sessionFile) newSession();
  const turnId = randomUUID();
  write('event_msg', { type: 'task_started', turn_id: turnId });
  write('turn_context', { model: opts.model, approval_policy: opts.approval ?? 'on-request', collaboration_mode: { mode: 'default', settings: { model: opts.model, reasoning_effort: effort } } });
  write('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } });
  log({ turn: true, text: text.slice(-300), head: text.slice(0, 300), effort, model: opts.model, session: sessionId });
  if (opts.model === 'gpt-5-codex-mini') {
    const error = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-5-codex-mini' model is not supported when using Codex with a ChatGPT account." } });
    out(`\n■ ${error}\n\n› `);
    write('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: null, error: { message: error } });
    return;
  }
  if (/\bRECALL\b/.test(text)) {
    const first = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      .filter(l => l.type === 'event_msg' && l.payload?.type === 'item_completed' && l.payload.item?.type === 'UserMessage')
      .map(l => l.payload.item.content.map(c => c.text ?? '').join('')).map(t => /ECHO (\w+)/.exec(t)?.[1]).find(Boolean);
    const answer = `recall ${first ?? 'nothing'}`;
    out(`\n• ${answer}\n\n› `);
    write('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: answer });
    return;
  }
  const hold = /HOLD (\w+)/.exec(text);
  if (hold) {
    out(`\n• Working on ${hold[1]}\n`);
    await new Promise((resolve) => { holding = resolve; });
    out('\n■ Conversation interrupted: tell the model what to do differently.\n\n› ');
    write('event_msg', { type: 'turn_aborted', turn_id: turnId, reason: 'interrupted' });
    log({ aborted: true, tag: hold[1] });
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
    const allowed = asks ? await askTool('claude-mgr-orchestrator', 'delegate_task') : true;
    if (asks) out('\x1b[2J\x1b[H');
    answer = allowed ? await callTars('delegate_task', { id: delegate[1], prompt: delegate[2], timeoutSeconds: Number(process.env.FAKE_DELEGATE_TIMEOUT_S) || 90 }) : 'the call of delegate_task was cancelled';
  } else if (send) {
    const allowed = asks ? await askTool('claude-mgr-orchestrator', 'send_message') : true;
    if (asks) out('\x1b[2J\x1b[H');
    answer = allowed ? await sendThroughTars(send[1], send[2]) : 'the call of send_message was cancelled';
  } else if (echo) {
    answer = `echo ${echo[1]}`;
  }
  out(`\n• ${answer}\n\n› `);
  write('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: answer });
}

let busy = Promise.resolve();
const queue = (text) => { busy = busy.then(() => turn(text)); };

let typed = '';
let signInShown = false;
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => {
  const data = chunk.toString('utf8');
  if (signInShown) return;
  if (!booted) {
    if (/[1y\r]/.test(data)) boot();
    else if (/[2n\x1b]/.test(data)) process.exit(0);
    return;
  }
  if (updatePrompt) {
    // A selection list: the arrows and 1 to 3 move the selection, Enter takes it, Esc skips; a paste is not for it.
    if (data.includes('\x1b[B')) updatePrompt.selected = Math.min(3, updatePrompt.selected + 1);
    else if (data.includes('\x1b[A')) updatePrompt.selected = Math.max(1, updatePrompt.selected - 1);
    else if (/^[123]$/.test(data)) updatePrompt.selected = Number(data);
    if (data.includes('\r')) chooseUpdate(updatePrompt.selected);
    else if (data === '\x1b') chooseUpdate(2);
    return;
  }
  if (holding && data === '\x1b') { const h = holding; holding = null; h(); return; }
  if (dialog) {
    const yes = dialog.kind === 'tool' ? /\r/ : /[y\r]/;
    const no = dialog.kind === 'tool' ? /\x1b/ : /[\x1bn]/;
    if (yes.test(data)) { const d = dialog; dialog = null; d.resolve(true); }
    else if (no.test(data)) { const d = dialog; dialog = null; d.resolve(false); }
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
const cwd = fs.realpathSync(process.cwd());
if (!signedIn()) {
  signInShown = true;
  log({ signInShown: true, codexHome: process.env.CODEX_HOME ?? null });
  out("\n  Welcome to Codex, OpenAI's command-line coding agent\n\n  Sign in with ChatGPT to use Codex as part of your paid plan\n  or connect an API key for usage-based billing\n\n› 1. Sign in with ChatGPT\n     Usage included with Plus, Pro, Business, and Enterprise plans\n\n  2. Sign in with Device Code\n     Sign in from another device with a one-time code\n\n  3. Provide your own API key\n     Pay for what you use\n\n  Press enter to continue\n");
} else if (trusted(cwd)) boot();
else {
  log({ trustAsked: true, cwd });
  out('> You are in ' + cwd + '\n\n  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.\n\n› 1. Yes, continue\n  2. No, quit\n\n  Press enter to continue\n');
}
