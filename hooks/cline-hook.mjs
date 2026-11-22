// Cline's hooks for a Tars agent: Cline 3.0.74 runs each `<Event>.mjs` of the agent's `--config` folder's hooks/ with
// `node`, its payload on stdin and its whole environment inherited (the agent's id and token with it); each one is a
// line that imports this file and calls run(<event>) (providers/cline-provider.ts writes them). This tells Tars the
// turn the way Claude Code's hooks do, with the same routes, token and proof as tars-hook.mjs.
//
// Measured on 3.0.74 (__tests__/hooks/cline-hook.test.ts says how it fails): every task of a process fires TaskStart,
// or TaskResume in a process started with --id; TaskComplete carries turn.outputText, an Esc fires TaskCancel. A
// payload names its session (sessionContext.rootSessionId) and never its prompt. The prompt is the last line of the
// TUI's input history, which Cline writes on the Enter, before the run begins: the session's messages file is written
// at the end of each round, so a TaskStart found the earlier task there (the conformance on bd51c1068). Cline runs its
// hooks detached, each a process of its own that nothing waits for: the hooks of one Cline process keep, in the agent's
// own data folder, which of them registered the session and how many of its turns opened and ended, so that a
// session registers once per process and a turn's end never reaches Tars before its start. The hook is a child of the
// Cline process whose pid the session's sessions.db row names, itself a child of Cline's node launcher: the process
// Tars started, the terminal's own on an exec launch. So the CLI the hook names to the hook routes, which check it
// against the agent's terminal, is its grandparent (the conformance on 66214ddc4: named as its parent, the session was
// refused as another CLI's), or, for another layout (the binary itself, a shim), the one cliOf finds.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { apiUrl, postWithRetry, tarsProvesInstance } from './tars-hook-lib.mjs';

/** A Cline session id: `<ms>_<5 chars>` (1795204260136_9ovct). */
const CLINE_SESSION_ID = /^\d{10,16}_[a-z0-9]{5}$/;

/** The UUID Tars knows a Cline session by (the hook routes take nothing else); providers/cline-cli.ts makes the same. */
export function clineUuidOf(sessionId) {
  if (typeof sessionId !== 'string' || !CLINE_SESSION_ID.test(sessionId)) return null;
  const h = createHash('sha256').update(`cline-session:${sessionId}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * The prompt the run a TaskStart opens was given: the last good line of the TUI's input history, which Cline rewrites
 * whole on every Enter, the latest last (a repeat moved there), before the run begins. Null when there is none.
 */
export function typedPrompt(dataDir) {
  if (!dataDir) return null;
  let lines;
  try {
    lines = fs.readFileSync(path.join(dataDir, 'cache', 'user_input_history.jsonl'), 'utf8').split('\n');
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const prompt = JSON.parse(lines[i])?.prompt;
      if (typeof prompt === 'string' && prompt.trim()) return prompt;
    } catch {
      // Not a line Cline wrote whole: the one before.
    }
  }
  return null;
}

/** Where the hooks of an agent's Cline keep their marks: in its own data folder, never the user's. */
const marksDir = (dataDir) => path.join(dataDir, 'tars-hooks');

/**
 * Whether this hook registers the session for its Cline process (`key`: the session and that process): the first to
 * create the mark does, every later hook of that process does not. With nowhere to keep the mark, every one does.
 */
export function claimRegistration(dataDir, key) {
  if (!dataDir) return true;
  try {
    fs.mkdirSync(marksDir(dataDir), { recursive: true });
    fs.writeFileSync(path.join(marksDir(dataDir), `${key}.registered`), '', { flag: 'wx' });
    return true;
  } catch (err) {
    return err?.code !== 'EEXIST';
  }
}

/** A turn of this Cline process opened, or ended, as Tars was told: one line each, appended. */
export function markTurn(dataDir, key, mark) {
  if (!dataDir) return;
  try {
    fs.mkdirSync(marksDir(dataDir), { recursive: true });
    fs.appendFileSync(path.join(marksDir(dataDir), `${key}.turns`), `${mark}\n`);
  } catch {
    // An end then waits its bound for nothing, and goes.
  }
}

/**
 * Whether a turn of this Cline process opened that has not ended: more openings than ends, counted in order and never
 * below zero. An end without its opening (one that timed out still marks; a TaskError then a TaskCancel end one turn
 * twice) took the count below zero for good, and every later end of that process waited the whole bound (the Audit's
 * L1 on #620).
 */
function openTurn(dataDir, key) {
  let marks;
  try {
    marks = fs.readFileSync(path.join(marksDir(dataDir), `${key}.turns`), 'utf8').split('\n');
  } catch {
    return false;
  }
  let open = 0;
  for (const m of marks) open = Math.max(0, open + (m === 'open' ? 1 : m === 'end' ? -1 : 0));
  return open > 0;
}

/**
 * A turn's end waits for its start to have reached Tars: true once it has, false after `maxMs` without it (an
 * opening that never comes, or a hook that could not mark it), and the end goes then anyway.
 */
export async function waitForOpening(dataDir, key, { maxMs = 10_000, stepMs = 50 } = {}) {
  if (!dataDir) return true;
  const until = Date.now() + maxMs;
  for (;;) {
    if (openTurn(dataDir, key)) return true;
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/**
 * A live process's parent pid: from /proc/<pid>/stat on Linux, else `ps -o ppid=` (macOS); null when it cannot be read
 * (Windows), and then the hook names no CLI, which the hook routes take as before.
 */
export function parentOf(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (Number.isInteger(ppid) && ppid > 0) return ppid;
  } catch {
    // Not Linux, or gone.
  }
  if (process.platform === 'win32') return null;
  try {
    const ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim());
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * A live process's command line, as its words: exact from /proc/<pid>/cmdline on Linux, else `ps -o args=` split on
 * spaces (macOS: a path holding a space comes apart, and is then read as no Cline's); null on Windows or when it
 * cannot be read.
 */
export function commandOf(pid) {
  try {
    const words = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((w) => w !== '');
    if (words.length > 0) return words;
  } catch {
    // Not Linux, or gone.
  }
  if (process.platform === 'win32') return null;
  try {
    const words = execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim().split(/\s+/).filter(Boolean);
    return words.length > 0 ? words : null;
  } catch {
    return null;
  }
}

const baseOf = (word) => word.split(/[\\/]/).pop() ?? '';
const CLINE_NAMES = new Set(['cline', '.cline', 'cline.exe', 'cline.cmd']);
const INTERPRETERS = new Set(['node', 'nodejs', 'node.exe', 'sh', 'bash', 'zsh', 'dash', 'ksh']);

/** Cline's binary run as itself: a program named cline, not an interpreter running a script of that name. */
const isClineBinary = (words) => !!words && CLINE_NAMES.has(baseOf(words[0])) && !INTERPRETERS.has(baseOf(words[0]));

/**
 * A wrapper of Cline's: an interpreter running a script named cline (its npm launcher, `node .../bin/cline`; a shim,
 * `bash .../shims/cline`). node's options may come before the script; a shell's may not, so `bash -c "cline ..."`,
 * a tool's shell that names cline in a command, is none.
 */
function wrapsCline(words) {
  if (!words || words.length < 2) return false;
  const interpreter = baseOf(words[0]);
  if (!INTERPRETERS.has(interpreter)) return false;
  let i = 1;
  if (interpreter.startsWith('node')) while (i < words.length && words[i].startsWith('-')) i += 1;
  const script = words[i];
  return !!script && !script.startsWith('-') && CLINE_NAMES.has(baseOf(script));
}

/**
 * The CLI Tars started, which the hook routes check against the agent's terminal: from the hook's parent (Cline's
 * binary) up through the wrappers of Cline's above it, the topmost (npm's launcher; a shim that runs it without exec,
 * the terminal's own process then). With none, the parent itself when its command is Cline's binary (a CLI path set to
 * `bin/.cline`, the terminal's process then); and when no command could be read, the grandparent, as measured with
 * npm's launcher (the conformance on 66214ddc4). Never above another Cline: a Cline that a Cline's tool started names
 * its own launcher or binary, which the routes refuse as not the terminal's. Null when no parent can be read (Windows).
 */
export function cliOf(parent, look = { parentOf, commandOf }) {
  const above = look.parentOf(parent);
  let named = parent;
  let next = above;
  while (next && wrapsCline(look.commandOf(next))) {
    named = next;
    next = look.parentOf(next);
  }
  if (named !== parent) return named;
  if (isClineBinary(look.commandOf(parent))) return parent;
  return above;
}

/** The posts an event of Cline's makes, in order: none for an event Tars does not read, or a payload naming no session. */
export function postsFor(event, payload, ctx) {
  const sessionId = clineUuidOf(payload?.sessionContext?.rootSessionId);
  if (!sessionId) return [];
  const base = { agent_id: ctx.agentId, session_id: sessionId };
  const opening = { path: '/api/hooks/status', body: { ...base, status: 'running', event: 'UserPromptSubmit', ...(ctx.prompt ? { current_task: ctx.prompt } : {}) } };
  const register = (source) => ({ path: '/api/hooks/status', body: { ...base, status: 'running', source, ...(ctx.cliPid ? { cli_pid: ctx.cliPid } : {}) } });
  switch (event) {
    case 'TaskStart':
      return ctx.first ? [register('startup'), opening] : [opening];
    case 'TaskResume':
      return ctx.first ? [register('resume'), opening] : [opening];
    case 'TaskComplete': {
      const turn = payload.turn && typeof payload.turn === 'object' ? payload.turn : {};
      if (turn.status && turn.status !== 'completed') {
        return [{ path: '/api/hooks/status', body: { ...base, status: 'error', error_kind: 'cline_turn_failed', error_message: `Cline ended the turn ${String(turn.status).slice(0, 200)}` } }];
      }
      const answer = typeof turn.outputText === 'string' ? turn.outputText : '';
      return [
        ...(answer ? [{ path: '/api/hooks/output', body: { ...base, hook: 'Stop', output: answer } }] : []),
        { path: '/api/hooks/status', body: { ...base, hook: 'Stop', status: 'idle' } },
        { path: '/api/hooks/agent-stopped', body: { ...base, hook: 'Stop' } },
      ];
    }
    case 'TaskCancel':
      return [{ path: '/api/hooks/status', body: { ...base, hook: 'Stop', status: 'idle' } }];
    case 'TaskError': {
      const said = payload.taskError?.message ?? payload.error?.message;
      return [{ path: '/api/hooks/status', body: { ...base, status: 'error', error_kind: 'cline_turn_failed', error_message: typeof said === 'string' && said ? said.slice(0, 2000) : 'Cline reported an error' } }];
    }
    default:
      return [];
  }
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

/** What Cline runs: posts the event's turn to Tars, then answers `{}` and exits 0, whatever happened. */
export async function run(event) {
  try {
    const env = process.env;
    let payload = null;
    try { payload = JSON.parse(await readStdin()); } catch { payload = null; }
    const agentId = env.CLAUDE_AGENT_ID;
    if (payload && agentId) {
      const dataDir = env.CLINE_DATA_DIR || undefined;
      // This hook's Cline process (its parent) and the session: what its marks are kept under.
      const key = `${String(payload.sessionContext?.rootSessionId)}.${process.ppid}`;
      const opens = event === 'TaskStart' || event === 'TaskResume';
      const ends = event === 'TaskComplete' || event === 'TaskCancel' || event === 'TaskError';
      // The CLI Tars started: Cline's launcher above its .cline binary, this hook's parent, or another layout (cliOf).
      const cliPid = cliOf(process.ppid);
      const valid = clineUuidOf(payload.sessionContext?.rootSessionId) !== null;
      const prompt = opens && valid ? typedPrompt(dataDir) : null;
      const first = opens && valid ? claimRegistration(dataDir, key) : false;
      const posts = postsFor(event, payload, { agentId, cliPid, prompt, first });
      if (posts.length > 0) {
        if (ends) await waitForOpening(dataDir, key);
        // Named on every post too (authHeader sends it as X-Tars-Cli-Pid); none when it could not be read.
        if (cliPid) env.CLAUDE_PID = String(cliPid);
        else delete env.CLAUDE_PID;
        // The agent's token only to a port that proved to be this Tars (tars-hook-lib.mjs).
        const token = (await tarsProvesInstance(env)) ? env.CLAUDE_MGR_API_TOKEN : null;
        for (const post of posts) await postWithRetry(`${apiUrl(env)}${post.path}`, token, JSON.stringify(post.body));
        if (opens || ends) markTurn(dataDir, key, opens ? 'open' : 'end');
      }
    }
  } catch {
    // Never Cline's problem: a hook that fails must not hold its turn.
  }
  process.stdout.write('{}\n');
  process.exit(0);
}
