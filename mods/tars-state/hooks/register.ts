/**
 * Tars's state mod: this agent's state, reported to the Tars that started it
 * from inside Claude Code (electron/services/state-mod.ts says the rest).
 *
 * It posts what the four shell hooks post, from the same classic events and
 * with the same inputs (SessionStart's registration, UserPromptSubmit's
 * running, Stop's output and idle, StopFailure's error), marked `via: 'mod'`,
 * and a heartbeat every 15 s from this process's own event loop, naming the
 * tool in flight, and each turn's usage from turn.complete, for the task ledger
 * (mods step 4). Every hook hands the event on unchanged (`next(e)`): the
 * agent does exactly what it did without the mod, and the shell hooks still
 * run, Tars setting their four posts aside for a session the mod registered.
 *
 * And one decision (mods step 2): when Claude Code would put a tool call to
 * its permission dialog, it asks Tars instead (`tool.check`), and Tars's allow
 * or deny is the decision, with no dialog in the terminal. Anything else Tars
 * answers, or no answer, keeps Claude Code's own decision: the dialog.
 *
 * Its token is sent only to a Tars that proves it is the one that started this
 * CLI, as the shell hooks do (hooks/tars-hook.sh): sha256 of
 * "<TARS_INSTANCE_ID>:<challenge>" from /api/health. Without that proof the
 * mod says nothing, and the shell hooks report as they did.
 */

const BEAT_MS = 15_000;
const OUTPUT_CAP = 4000;
const TASK_CAP = 200;
/**
 * The waits before a post's second and third tries. For a session the mod
 * registered Tars sets the shell hook's post aside, so the mod's is the only
 * one: a Stop's idle lost or refused (Tars busy, a 503) left the agent
 * `running` until its next turn (the Audit's gate of #308).
 */
const RETRY_WAITS_MS = [1_000, 3_000];

type Tars = { agentId: string; api: string; token: string };

/**
 * What this module uses of the engine, typed here: the repository's own tsc and
 * eslint read this file and do not have Claude Code's `claude-code` module.
 */
type Engine = {
  env: { get(name: string): Promise<string | undefined> };
  http: { fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; text: string }> };
  clock: { every(ms: number, fn: () => void): unknown; sleep(ms: number): Promise<void> };
};
/** tool.check's input, and its verdict: `ask` puts the call to the dialog. */
type Check = { tool: string; input: unknown; tool_use_id?: string };
type Verdict = { decision: 'allow' | 'ask' | 'deny'; reason?: string; rule?: string; hook?: string };
/** The fields of a tool's input a person decides on: never a file's content. */
const ASKED_ABOUT = ['command', 'description', 'file_path', 'notebook_path', 'path', 'url', 'query', 'pattern'];
const INPUT_CAP = 2000;
/** Bash's fields Tars shows as words, each with the type it shows (the Audit's M1 on #538: one Bash call in eight set a timeout). */
const BASH_WORDS: Record<string, 'number' | 'boolean'> = { timeout: 'number', run_in_background: 'boolean', dangerouslyDisableSandbox: 'boolean' };
/**
 * Asks for one call at most: 190 of Tars's 20 s holds (63 minutes) outlast the
 * longest delay the owner can set (permissionAskMinutes, 60), after which Tars
 * refuses the call itself. Fewer, and the dialog showed before Tars's refusal,
 * where nobody answers at night (fix-permission-dialogs-2810.md).
 */
const MAX_ASKS = 190;
/** Requests that fail in a row before the call goes back to the engine. */
const MAX_FAILURES = 3;
/** A classic hook's input, as the shell hooks read it on stdin. */
type Classic = {
  session_id?: string; source?: string; prompt?: unknown; stop_hook_active?: unknown; last_assistant_message?: unknown; error?: unknown;
  session_crons?: unknown; background_tasks?: unknown;
};

/** A background task's status that means it is over, as on-stop.sh reads them. */
const TASK_OVER = new Set(['completed', 'failed', 'killed', 'stopped', 'error']);

/**
 * What the agent leaves waiting inside its CLI at this rest, counted as
 * on-stop.sh counts it: its timers (a /loop wakeup, a CronCreate) and the
 * background tasks still running. Undefined when Claude Code did not send both
 * lists: nothing is known then. For a session the mod registered the shell's
 * Stop post is set aside, so this is the only count that reaches Tars, which
 * decides from it whether the sleep pass may end the agent (QA's gate of #322).
 */
function pendingOf(e: Classic): { crons: number; background: number } | undefined {
  if (!Array.isArray(e.session_crons) || !Array.isArray(e.background_tasks)) return undefined;
  const running = e.background_tasks.filter(task => {
    const status = task && typeof task === 'object' ? (task as { status?: unknown }).status ?? 'running' : 'running';
    return !TASK_OVER.has(String(status));
  });
  return { crons: e.session_crons.length, background: running.length };
}
type On = <E>(event: string, hook: ($: Engine, e: E, next: (e: E) => Promise<unknown>) => unknown) => void;

/** undefined: not asked yet; null: not under a Tars that proved itself. */
let tars: Tars | null | undefined;
let sessionId: string | null = null;
let beating = false;
const inFlight: string[] = [];
/** One post at a time, in the order the events came: a Stop's idle never lands before its turn's running. */
let queue: Promise<unknown> = Promise.resolve();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function proven($: Engine): Promise<Tars | null> {
  if (tars !== undefined) return tars;
  // CLAUDE_PID in this process's own environment means another claude started
  // this one (a `claude -p` from the agent's Bash tool): Claude Code puts it in
  // the environment of what it starts, never in its own (measured by the Audit
  // on 2.1.296, gate of #380). Such a CLI inherited the agent's id and token,
  // and is not the agent: the mod says nothing to Tars from it, and Tars strips
  // CLAUDE_PID from every agent terminal so the agent's own claude never has it.
  if (await $.env.get('CLAUDE_PID')) {
    tars = null;
    return tars;
  }
  const agentId = await $.env.get('CLAUDE_AGENT_ID');
  const api = await $.env.get('CLAUDE_MGR_API_URL');
  const token = await $.env.get('CLAUDE_MGR_API_TOKEN');
  const instance = await $.env.get('TARS_INSTANCE_ID');
  if (!agentId || !api || !token || !instance) {
    tars = null;
    return tars;
  }
  const challenge = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  try {
    const answer = await $.http.fetch(`${api}/api/health?challenge=${challenge}`);
    const proof = JSON.parse(answer.text || '{}').proof;
    const expected = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${instance}:${challenge}`)));
    tars = proof === expected ? { agentId, api, token } : null;
  } catch {
    tars = null;
  }
  return tars;
}

/** A post's body, or how to make it, in the queue, when it needs the engine first. */
type Body = Record<string, unknown> | (() => Promise<Record<string, unknown>>);

function report($: Engine, route: string, body: Body): void {
  queue = queue.then(async () => {
    const to = await proven($);
    if (!to) return;
    const fields = typeof body === 'function' ? await body() : body;
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${to.token}` },
      body: JSON.stringify({ agent_id: to.agentId, ...fields, via: 'mod' }),
    };
    // Tried again, in the queue, so the events keep their order; given up
    // after the third try, so one that keeps failing holds nothing back.
    for (let attempt = 0; ; attempt++) {
      try {
        if ((await $.http.fetch(`${to.api}${route}`, init)).ok) return;
      } catch {
        // tried again below
      }
      if (attempt >= RETRY_WAITS_MS.length) return;
      await $.clock.sleep(RETRY_WAITS_MS[attempt]);
    }
  }).catch(() => undefined);
}

/**
 * What the call asks about, as Tars shows it: every field it shows whole, and why each other one is withheld. A
 * question with a field withheld still goes to Tars, marked so, with the fields shown: the window may refuse it or
 * hand it back to the terminal, never allow it, and a bypass agent's is refused at the owner's delay instead of
 * waiting at Claude Code's dialog all night (the Audit's M1 on #538). A tweet's text, a message, a delegated task, a
 * subagent's prompt, an edit's new content or a heredoc past the cap reached Tars as nothing before #318's rechecks,
 * and an allow approved what nobody saw: such a field is never sent, only its name.
 */
function askedAbout(tool: string, input: unknown): { fields: Record<string, string>; withheld: string[] } {
  const fields: Record<string, string> = {};
  const withheld: string[] = [];
  if (!input || typeof input !== 'object') return { fields, withheld };
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const word = tool === 'Bash' ? BASH_WORDS[key] : undefined;
    if (word && typeof value === word) fields[key] = String(value);
    else if (!word && !ASKED_ABOUT.includes(key)) withheld.push(`${key}: a field the window does not show`);
    else if (typeof value !== 'string') withheld.push(`${key}: not text`);
    else if (value.length > INPUT_CAP) withheld.push(`${key}: ${String(value.length).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} characters, past the 2,000 the window shows`);
    else fields[key] = value;
  }
  return { fields, withheld };
}

/**
 * What the question is about, as Tars computes it: sha256 of the tool and the
 * asked fields, sorted by name. An answer counts only when it names this
 * call's: a post the agent's own shell made for the same call id, with `ls`,
 * would otherwise have its answer allow this call (the gate of #318, Medium 1).
 */
async function fingerprint(tool: string, fields: Record<string, string>): Promise<string> {
  const canonical = JSON.stringify([tool, Object.keys(fields).sort().map(k => [k, fields[k]])]);
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
}

/**
 * Tars's answer to a call Claude Code would ask about, or null for the
 * engine's own decision: Tars handed it back, did not prove itself, could not
 * be reached or answered something else.
 */
async function askTars($: Engine, e: Check, verdict: Verdict): Promise<Verdict | null> {
  const to = await proven($);
  if (!to || !sessionId) return null;
  const { fields, withheld } = askedAbout(e.tool, e.input);
  const mine = await fingerprint(e.tool, fields);
  const question = {
    agent_id: to.agentId, session_id: sessionId, tool: e.tool, tool_use_id: e.tool_use_id,
    input: fields, reason: verdict.reason, rule: verdict.rule, via: 'mod',
    ...(withheld.length ? { withheld: true, withheld_why: withheld.join('; ').slice(0, 1000) } : {}),
  };
  // Tars says `pending` every 20 s and is asked again for the same call: a
  // request held about 30 s ended under the mod, and the dialog showed while
  // Tars still held the question (measured on 2.1.289). A request that fails
  // is asked again too, saying why, since Tars still holds the question;
  // three failures in a row give the call back to the engine.
  let failures = 0;
  let afterError: string | undefined;
  for (let round = 0; round < MAX_ASKS; round++) {
    let text: string;
    try {
      const answer = await $.http.fetch(`${to.api}/api/hooks/permission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${to.token}` },
        body: JSON.stringify(afterError ? { ...question, after_error: afterError } : question),
      });
      text = answer.text;
    } catch (err) {
      failures++;
      if (failures >= MAX_FAILURES) return null;
      afterError = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      continue;
    }
    failures = 0;
    afterError = undefined;
    let said: { decision?: unknown; reason?: unknown; fingerprint?: unknown };
    try { said = JSON.parse(text || '{}'); } catch { return null; }
    if (said.decision === 'pending') continue;
    if (said.decision !== 'allow' && said.decision !== 'deny') return null;
    if (said.fingerprint !== mine) return null;
    // Withheld: the window never saw it whole, so only a refusal is taken.
    if (withheld.length && said.decision === 'allow') return null;
    return { decision: said.decision, ...(typeof said.reason === 'string' ? { reason: said.reason } : {}) };
  }
  return null;
}

function beat($: Engine): void {
  if (!sessionId) return;
  report($, '/api/hooks/mod-beat', { session_id: sessionId, tool: inFlight[inFlight.length - 1] ?? null });
}

export function register(on: On) {
  on<Classic>('classic.SessionStart', ($, e, next) => {
    sessionId = e.session_id ?? null;
    report($, '/api/hooks/status', { session_id: e.session_id, status: 'idle', source: e.source });
    if (!beating) {
      beating = true;
      $.clock.every(BEAT_MS, () => beat($));
    }
    return next(e);
  });

  on<Classic>('classic.UserPromptSubmit', ($, e, next) => {
    report($, '/api/hooks/status', {
      session_id: e.session_id, status: 'running', event: 'UserPromptSubmit',
      current_task: typeof e.prompt === 'string' ? e.prompt.slice(0, TASK_CAP) : '',
    });
    return next(e);
  });

  on<Classic>('classic.Stop', ($, e, next) => {
    if (e.stop_hook_active !== true) {
      if (typeof e.last_assistant_message === 'string' && e.last_assistant_message) {
        report($, '/api/hooks/output', { session_id: e.session_id, output: e.last_assistant_message.slice(0, OUTPUT_CAP) });
      }
      const pending = pendingOf(e);
      report($, '/api/hooks/status', { session_id: e.session_id, status: 'idle', ...(pending ? { pending } : {}) });
      report($, '/api/hooks/agent-stopped', { session_id: e.session_id });
    }
    return next(e);
  });

  on<Classic>('classic.StopFailure', ($, e, next) => {
    report($, '/api/hooks/status', {
      session_id: e.session_id, status: 'error', event: 'StopFailure',
      error_kind: typeof e.error === 'string' ? e.error : '',
      error_message: typeof e.last_assistant_message === 'string' ? e.last_assistant_message : '',
    });
    return next(e);
  });

  // Each turn's usage, summed over its requests, for the task ledger (mods step
  // 4). It comes after the Stop's posts, in the same queue, so Tars files it
  // under the task that Stop ended. Claude Code gives no split of the cache
  // writes and no web searches here: Tars keeps reading the transcript for
  // those while it is there.
  on<{ usage?: unknown }>('turn.complete', ($, e, next) => {
    if (e.usage && typeof e.usage === 'object' && sessionId) {
      report($, '/api/hooks/turn-usage', { session_id: sessionId, usage: e.usage });
    }
    return next(e);
  });

  // A call Claude Code would put to its dialog goes to Tars. Only those: a call
  // the mode or a rule settles is the engine's, and a query with no call behind
  // it decides nothing. An AskUserQuestion goes too, withheld (its questions are
  // not sent): Tars, which knows the agent's role and mode, refuses a bypass
  // worker's and hands any other back to the person (the Audit's fifth gate of #538).
  on<Check>('tool.check', async ($, e, next) => {
    const verdict = await next(e) as Verdict;
    if (verdict?.decision !== 'ask' || !e.tool_use_id) return verdict;
    return (await askTars($, e, verdict)) ?? verdict;
  });

  // The tool in flight, for the heartbeat: a long Bash, an MCP wait or a subagent.
  on<{ tool: string }>('tool.call', async (_$, e, next) => {
    inFlight.push(e.tool);
    try {
      return await next(e);
    } finally {
      const at = inFlight.lastIndexOf(e.tool);
      if (at >= 0) inFlight.splice(at, 1);
    }
  });
}
