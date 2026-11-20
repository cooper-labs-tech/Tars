// Cline's hooks for a Tars agent: Cline 3.0.74 runs each `<Event>.mjs` of the agent's `--config` folder's hooks/ with
// `node`, its payload on stdin and its whole environment inherited (the agent's id and token with it); each one is a
// line that imports this file and calls run(<event>) (providers/cline-provider.ts writes them). This tells Tars the
// turn the way Claude Code's hooks do, with the same routes, token and proof as tars-hook.mjs.
//
// Measured on 3.0.74 (__tests__/hooks/cline-hook.test.ts says how it fails): every task of a session fires TaskStart,
// the first of a session resumed with --id TaskResume, TaskComplete carries turn.outputText and turn.status, an Esc
// TaskCancel. A payload names its session (sessionContext.rootSessionId) and never its prompt: the first prompt is the
// session record's `prompt` when the first TaskStart runs, every later one the last user message of its messages
// file, each wrapped as <user_input mode="...">. The hook is a child of the Cline process whose pid the session's
// sessions.db row names, itself a child of Cline's node launcher: the process Tars started, the terminal's own on an
// exec launch. So the CLI the hook names to the hook routes, which check it against the agent's terminal, is its
// grandparent (the conformance on 66214ddc4: named as its parent, the session was refused as another CLI's).

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

/** A prompt as typed: Cline's `<user_input mode="...">` tag taken off. */
export function promptOf(text) {
  const m = /^\s*<user_input(?:\s[^>]*)?>([\s\S]*)<\/user_input>\s*$/.exec(text);
  return m ? m[1] : text;
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const textOf = (content) => (Array.isArray(content) ? content : [])
  .filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');

/**
 * The prompt of the task a TaskStart opens, and whether it is the session's first: the last user message with text of
 * the session's messages when it has one, else the first prompt of its record.
 */
export function currentPrompt(dataDir, sessionId) {
  const at = path.join(dataDir || '', 'sessions', sessionId);
  const messages = readJson(path.join(at, `${sessionId}.messages.json`))?.messages;
  const users = Array.isArray(messages) ? messages.filter((m) => m && m.role === 'user') : [];
  const last = users.length > 0 ? textOf(users[users.length - 1].content) : '';
  if (last) return { prompt: promptOf(last), first: false };
  const recorded = readJson(path.join(at, `${sessionId}.json`))?.prompt;
  return { prompt: typeof recorded === 'string' ? promptOf(recorded) : null, first: users.length === 0 };
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
      return [register('resume'), opening];
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
      const sessionId = payload.sessionContext?.rootSessionId;
      const { prompt, first } = event === 'TaskStart' || event === 'TaskResume' ? currentPrompt(env.CLINE_DATA_DIR, sessionId) : { prompt: null, first: false };
      // The CLI Tars started: Cline's launcher, this hook's grandparent (the .cline binary is its parent).
      const cliPid = parentOf(process.ppid);
      const posts = postsFor(event, payload, { agentId, cliPid, prompt, first });
      if (posts.length > 0) {
        // Named on every post too (authHeader sends it as X-Tars-Cli-Pid); none when it could not be read.
        if (cliPid) env.CLAUDE_PID = String(cliPid);
        else delete env.CLAUDE_PID;
        // The agent's token only to a port that proved to be this Tars (tars-hook-lib.mjs).
        const token = (await tarsProvesInstance(env)) ? env.CLAUDE_MGR_API_TOKEN : null;
        for (const post of posts) await postWithRetry(`${apiUrl(env)}${post.path}`, token, JSON.stringify(post.body));
      }
    }
  } catch {
    // Never Cline's problem: a hook that fails must not hold its turn.
  }
  process.stdout.write('{}\n');
  process.exit(0);
}
