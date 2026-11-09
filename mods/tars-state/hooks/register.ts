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
 * its permission dialog, it asks Tars instead (`classic.PermissionRequest`), and
 * Tars's allow or deny is the decision, with no dialog in the terminal. Anything
 * else Tars answers, or no answer, hands the event on: Claude Code's dialog.
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
/**
 * tool.check's input, and its verdict. Measured on 2.1.321: an `ask` there is not yet the dialog, later steps may
 * still decide it (the auto mode classifier, which Claude Code hands Claude in Chrome's calls to under the server's
 * flag, allowed every one of them while the mod held them for the window).
 */
type Check = { tool: string; input: unknown; tool_use_id?: string };
type Verdict = { decision: 'allow' | 'ask' | 'deny'; reason?: string; rule?: string; hook?: string };
/**
 * classic.PermissionRequest's input, as measured on 2.1.321: sent when the dialog would show, after the mode, the
 * rules and the classifier. No call id and no reason: those come from the call's tool.check.
 */
type Request = { session_id?: string; tool_name?: unknown; tool_input?: unknown; permission_mode?: unknown };
/** Its answer: the decision, or the event handed on (`next`) for the dialog. */
type Decision = { decision: { behavior: 'allow' } | { behavior: 'deny'; message: string } };
/** The fields that carry a file's new content: never sent, whatever their size (an allow would approve what nobody saw). */
const FILE_CONTENT: Record<string, string[]> = {
  Write: ['content'], Edit: ['old_string', 'new_string'], MultiEdit: ['edits'], NotebookEdit: ['new_source'],
};
/** The window's caps, the route's too (hooks-routes.ts askedFields): one field's text, a field's name, the fields of one call. */
const INPUT_CAP = 2000;
const KEY_CAP = 64;
const FIELDS_CAP = 16;
/** The checks that asked, latest last, for the dialog that follows to take its call id and reason from. */
const CHECKS_KEPT = 16;
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

/** A count as the window writes it: 3,014. */
function count(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * What the call asks about, as Tars shows it: every field whole, a field that is not text (a number, a boolean,
 * null, an array, an object) as its JSON and named in `json`, so that the window can allow the call (the owner's
 * report of 10/11: Claude in Chrome's tabId, coordinate and createIfEmpty made every one of its questions withheld).
 * What cannot be shown is withheld, never sent, only its name and why: a field past the cap, a file's new content,
 * a field name past 64 characters, the fields past the 16th. A question with a field withheld still goes to Tars,
 * marked so: the window may refuse it or hand it back to the terminal, never allow it, and a bypass agent's is refused
 * at the owner's delay instead of waiting at Claude Code's dialog all night (the Audit's M1 on #538).
 */
function askedAbout(tool: string, input: unknown): { fields: Record<string, string>; json: string[]; withheld: string[] } {
  const fields: Record<string, string> = {};
  const json: string[] = [];
  const withheld: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { fields, json, withheld };
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key.length > KEY_CAP) { withheld.push(`${key.slice(0, KEY_CAP)}: a field whose name is past ${KEY_CAP} characters`); continue; }
    if (FILE_CONTENT[tool]?.includes(key)) { withheld.push(`${key}: a file's new content`); continue; }
    let text: string | undefined;
    try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = undefined; }
    if (typeof text !== 'string') { withheld.push(`${key}: cannot be shown`); continue; }
    if (text.length > INPUT_CAP) { withheld.push(`${key}: ${count(text.length)} characters, past the 2,000 the window shows`); continue; }
    if (Object.keys(fields).length >= FIELDS_CAP) { withheld.push(`${key}: past the ${FIELDS_CAP} fields the window shows`); continue; }
    fields[key] = text;
    if (typeof value !== 'string') json.push(key);
  }
  return { fields, json: json.sort(), withheld: withheld.sort() };
}

/**
 * What the question is about, as Tars computes it (permission-asks.ts questionFingerprint): sha256 of the tool and the
 * asked fields, sorted by name, and of the fields shown as JSON when there are any. An answer counts only when it
 * names this call's: a post the agent's own shell made for the same call id, with `ls`, would otherwise have its
 * answer allow this call (the gate of #318, Medium 1), and an answer about `"true"` would allow `true`.
 */
async function fingerprint(tool: string, fields: Record<string, string>, json: string[]): Promise<string> {
  const entries = Object.keys(fields).sort().map(k => [k, fields[k]]);
  const canonical = JSON.stringify(json.length ? [tool, entries, [...json].sort()] : [tool, entries]);
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
}

/** The calls tool.check said Claude Code would ask about, latest last: the dialog that follows has neither id nor reason. */
const asked: Array<{ tool: string; input: string; id: string; reason?: string; rule?: string }> = [];

function inputText(input: unknown): string {
  try { return JSON.stringify(input) ?? ''; } catch { return ''; }
}

/**
 * The tool.check that asked about this dialog's call: the same tool and input, else the latest of that tool (Claude
 * Code may hand the dialog an input its check rewrote), taken out so that one check lends itself to one dialog.
 */
function checkFor(tool: string, input: unknown): (typeof asked)[number] | undefined {
  const text = inputText(input);
  let at = -1;
  for (let i = asked.length - 1; i >= 0; i--) {
    if (asked[i].tool !== tool) continue;
    if (asked[i].input === text) { at = i; break; }
    if (at < 0) at = i;
  }
  return at < 0 ? undefined : asked.splice(at, 1)[0];
}

/**
 * Tars's answer to a call Claude Code would put to its dialog, or null for the
 * dialog: Tars handed it back, did not prove itself, could not be reached or
 * answered something else.
 */
async function askTars($: Engine, e: Check, verdict: Pick<Verdict, 'reason' | 'rule'>): Promise<Verdict | null> {
  const to = await proven($);
  if (!to || !sessionId) return null;
  const { fields, json, withheld } = askedAbout(e.tool, e.input);
  const mine = await fingerprint(e.tool, fields, json);
  const question = {
    agent_id: to.agentId, session_id: sessionId, tool: e.tool, tool_use_id: e.tool_use_id,
    input: fields, reason: verdict.reason, rule: verdict.rule, via: 'mod',
    ...(json.length ? { json_fields: json } : {}),
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

  // The engine's verdict, handed back untouched: an `ask` here may still be
  // decided by Claude Code's later steps (the auto mode classifier, measured on
  // 2.1.321 with Claude in Chrome), so it is only noted, for the dialog that may
  // follow to take its call id and reason. A query with no call behind it lends
  // nothing.
  on<Check>('tool.check', async (_$, e, next) => {
    const verdict = await next(e) as Verdict;
    if (verdict?.decision === 'ask' && e.tool_use_id) {
      asked.push({ tool: e.tool, input: inputText(e.input), id: e.tool_use_id, reason: verdict.reason, rule: verdict.rule });
      if (asked.length > CHECKS_KEPT) asked.shift();
    }
    return verdict;
  });

  // The dialog Claude Code would show goes to Tars instead, and only that: it
  // comes after the mode, the rules and the classifier. Tars's allow or deny is
  // the decision, and nothing beneath runs (the shell hooks, the dialog); held,
  // the dialog does not show (measured on 2.1.321, 60 s and 5 minutes). Anything
  // else hands the event on, to the shell hooks and the dialog. An
  // AskUserQuestion goes too: Tars, which knows the agent's role and mode,
  // refuses a bypass worker's and hands any other back to the person (the
  // Audit's fifth gate of #538).
  on<Request>('classic.PermissionRequest', async ($, e, next) => {
    const tool = typeof e.tool_name === 'string' ? e.tool_name : '';
    if (!tool) return next(e);
    const from = checkFor(tool, e.tool_input);
    const id = from?.id ?? `tars_${hex(crypto.getRandomValues(new Uint8Array(8)).buffer)}`;
    const said = await askTars($, { tool, input: e.tool_input, tool_use_id: id }, { reason: from?.reason, rule: from?.rule });
    if (said?.decision === 'allow') return { decision: { behavior: 'allow' } } satisfies Decision;
    if (said?.decision === 'deny') return { decision: { behavior: 'deny', message: said.reason || 'Refused in Tars.' } } satisfies Decision;
    return next(e);
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
