'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- run by node as it is, outside the build: CommonJS. */
/*
 * tars-slot: the heavy-run slot from a command line (electron/services/heavy-slot.ts), for git hooks and scripts,
 * which cannot call an MCP tool. Run from an agent's terminal started by Tars: it presents the agent's own token
 * (CLAUDE_MGR_API_TOKEN) to the Tars at CLAUDE_MGR_API_URL, both in that terminal's environment.
 *
 *   tars-slot run [--priority gate|normal|background] [--label <text>] [--wait-seconds <n>] -- <command> [args...]
 *       Waits for the slot, runs the command as its child, gives the slot back when the command ends, and exits
 *       with its code. The lease is this process's: killed, it goes back by itself.
 *   tars-slot take [--priority ...] [--label <text>] [--wait-seconds <n>]
 *       From a script that runs the steps itself, to hold the slot across them: the lease is the calling process's
 *       (this one's parent), and ends with it. From an agent's own Bash tool, that parent is the shell of one command,
 *       which ends at once: use `run` there. Prints the ticket once granted.
 *   tars-slot give-back <ticket>
 *   tars-slot status
 *
 * Exit: the command's own code (128 + the signal's number when a signal ended it); 2 for a usage error or no token;
 * 3 when Tars refuses or cannot be reached; 75 when --wait-seconds ran out (the ask is given back).
 * Tars never ends a run: an alert during it (the disk filling, the swap growing fast) is printed here.
 */
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const out = (line) => process.stderr.write(`tars-slot: ${line}\n`);

function fail(code, line) {
  out(line);
  process.exit(code);
}

function call(method, path, body) {
  const base = process.env.CLAUDE_MGR_API_URL || 'http://127.0.0.1:31415';
  const token = process.env.CLAUDE_MGR_API_TOKEN;
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(process.env.CLAUDE_AGENT_ID ? { 'X-Tars-Caller-Id': process.env.CLAUDE_AGENT_ID } : {}),
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
      timeout: 15_000,
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(text); } catch { /* said below */ }
        resolve({ status: res.statusCode || 0, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Tars did not answer within 15 s')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function parse(argv) {
  const opts = { priority: undefined, label: undefined, waitSeconds: undefined, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { opts.rest = argv.slice(i + 1); break; }
    if (a === '--priority') opts.priority = argv[++i];
    else if (a === '--label') opts.label = argv[++i];
    else if (a === '--wait-seconds') opts.waitSeconds = Number(argv[++i]);
    else opts.rest.push(a);
  }
  return opts;
}

async function ask(pid, opts, label) {
  const { status, json } = await call('POST', '/api/heavy-slot/ask', {
    pid, ...(opts.priority ? { priority: opts.priority } : {}), label: opts.label || label,
  });
  if (status !== 200 || !json.ticket) fail(3, `the slot was not asked: ${json.error || `HTTP ${status}`}`);
  if (json.ticket.clamped) out('gate is an orchestrator\'s: asked as normal');
  return json.ticket;
}

/** Until granted: says the position and why on every change; undefined when --wait-seconds ran out. */
async function waitGranted(ticket, opts) {
  const deadline = Number.isFinite(opts.waitSeconds) ? Date.now() + opts.waitSeconds * 1000 : Infinity;
  let said = '';
  for (let t = ticket; ; ) {
    if (t.state === 'granted') return t;
    const line = `waiting (position ${t.position || '?'}): ${t.why || 'in the queue'}`;
    if (line !== said) { out(line); said = line; }
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, 1000));
    const { status, json } = await call('GET', `/api/heavy-slot/tickets/${ticket.id}`);
    if (status !== 200) fail(3, `the ask is gone: ${json.error || `HTTP ${status}`}`);
    t = json.ticket;
  }
}

async function run(opts) {
  if (opts.rest.length === 0) fail(2, 'usage: tars-slot run [--priority p] [--label text] -- <command> [args...]');
  const ticket = await ask(process.pid, opts, opts.rest.join(' ').slice(0, 120));
  const granted = await waitGranted(ticket, opts);
  if (!granted) {
    await call('POST', `/api/heavy-slot/tickets/${ticket.id}/give-back`).catch(() => {});
    fail(75, `not granted within ${opts.waitSeconds} s`);
  }
  out(`granted${granted.nestedIn ? ' (inside the run that holds it)' : ''}: ${opts.rest.join(' ')}`);
  const env = { ...process.env };
  // Set by the shim to run this script on Electron's Node; never handed to the command (an Electron app it starts).
  if (env.TARS_SLOT_UNSET_RUN_AS_NODE) { delete env.ELECTRON_RUN_AS_NODE; delete env.TARS_SLOT_UNSET_RUN_AS_NODE; }
  const child = spawn(opts.rest[0], opts.rest.slice(1), { stdio: 'inherit', env, shell: process.platform === 'win32' });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
  }
  let seen = 0;
  const poll = setInterval(() => {
    call('GET', `/api/heavy-slot/tickets/${ticket.id}`).then(({ json }) => {
      const alerts = (json.ticket && json.ticket.alerts) || [];
      for (const a of alerts.slice(seen)) out(`alert: ${a}`);
      seen = Math.max(seen, alerts.length);
    }).catch(() => {});
  }, 5000);
  const code = await new Promise((resolve) => {
    child.on('error', (err) => { out(`could not start ${opts.rest[0]}: ${err.message}`); resolve(127); });
    child.on('exit', (c, sig) => resolve(sig ? 128 + (os.constants.signals[sig] || 0) : (c ?? 0)));
  });
  clearInterval(poll);
  await call('POST', `/api/heavy-slot/tickets/${ticket.id}/give-back`).catch(() => {});
  process.exit(code);
}

async function take(opts) {
  const ticket = await ask(process.ppid, opts, 'held by a script');
  const granted = await waitGranted(ticket, opts);
  if (!granted) {
    await call('POST', `/api/heavy-slot/tickets/${ticket.id}/give-back`).catch(() => {});
    fail(75, `not granted within ${opts.waitSeconds} s`);
  }
  process.stdout.write(`${ticket.id}\n`);
}

async function giveBack(opts) {
  const id = opts.rest[0];
  if (!id) fail(2, 'usage: tars-slot give-back <ticket>');
  const { status, json } = await call('POST', `/api/heavy-slot/tickets/${id}/give-back`);
  if (status !== 200) fail(3, json.error || `HTTP ${status}`);
}

async function status() {
  const { status: code, json } = await call('GET', '/api/heavy-slot');
  if (code !== 200) fail(3, json.error || `HTTP ${code}`);
  const line = (t) => `${t.agentName} (${t.project}): ${t.label}, ${t.priority}`;
  process.stdout.write(`slots: ${json.slots}\n`);
  for (const t of json.holders) process.stdout.write(`holds  ${line(t)} since ${t.grantedAt}\n`);
  for (const t of json.waiting) process.stdout.write(`waits  ${t.position}. ${line(t)}${t.why ? `: ${t.why}` : ''}\n`);
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!process.env.CLAUDE_MGR_API_TOKEN) fail(2, 'run it from an agent\'s terminal started by Tars: no CLAUDE_MGR_API_TOKEN here');
  const opts = parse(argv);
  if (command === 'run') return run(opts);
  if (command === 'take') return take(opts);
  if (command === 'give-back') return giveBack(opts);
  if (command === 'status') return status();
  fail(2, 'usage: tars-slot run [--label text] -- <command> | take (from a script that runs the steps itself) | give-back <ticket> | status');
}

main().catch((err) => fail(3, `Tars could not be reached: ${err.message}`));
