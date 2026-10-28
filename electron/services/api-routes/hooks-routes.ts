import { agents, saveAgents, noteSessionRegistered, noteTurnStarted, appendAgentOutput } from '../../core/agent-manager';
import { bindTurn } from '../../core/task-requests';
import { liveTaskLedger, noteTurn, turnUsageOf } from '../task-ledger';
import { findAgentByIdOrSession } from './utils';
import { noteSubmitted, ptyProcesses } from '../../core/pty-manager';
import { RouteApp, RouteContext, RouteRequest } from './types';
import { AgentStatus } from '../../types';
import { broadcastToAllWindows } from '../../utils/broadcast';
import { scheduleTick } from '../../utils/agents-tick';
import { oneLine, waitingOnFrom } from '../../utils/waiting-on';
import { emitAgentStatus, agentStatusEmitter } from '../agent-events';
import { onTurnEnded, onUsageLimit } from '../claude-accounts/switching';
import { restPendingOf } from '../../core/agent-asleep';
import { modRunsSession, noteModBeat, noteModSession } from '../state-mod';
import { dropPermissionAsks, holdPermissionAsk, logPermission, permissionHoldMs, questionFingerprint, subjectOf } from '../permission-asks';
import { judgeCall, placesOf } from '../permission-auto';
import { isTerminalsOwnCli, ownCliAtOnce } from '../../core/terminal-cli';
import { terminalIsTheCli } from '../../core/agent-pty';

/**
 * The four shell hooks whose posts the state mod makes instead, for a session
 * it registered (services/state-mod.ts). Each script names itself in `hook`;
 * the mod's own posts say `via: 'mod'`. One source per session: the shell's
 * curl landing after the mod's next post put a Stop's idle after the next
 * turn's running. Every other hook (a permission dialog, a notification) is
 * still taken from the shell.
 */
const MOD_HOOKS = new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure']);

function setAsideForMod(agentId: string, sessionId: string | undefined, body: { hook?: unknown }): boolean {
  return typeof body.hook === 'string' && MOD_HOOKS.has(body.hook) && modRunsSession(agentId, sessionId);
}

/** The mod's cap on one asked field: a call whose field is longer is left to the terminal's dialog, which shows it whole. */
const ASKED_FIELD_CAP = 2000;

/**
 * The fields a permission question is about, as the mod sent them: strings
 * only, kept whole. Null when one is past the mod's cap or there are more than
 * a call has, and the question then goes to the dialog: Tars shows and
 * decides only what it holds in full (the gate of #318, Medium 2).
 */
function askedFields(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const fields: Record<string, string> = {};
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 16) return null;
  for (const [key, value] of entries) {
    if (typeof value !== 'string') continue;
    if (value.length > ASKED_FIELD_CAP) return null;
    fields[key.slice(0, 64)] = value;
  }
  return fields;
}

/**
 * Session ownership contract:
 * - A task dispatch (/start, /message respawn, /dispatch) kills the old PTY and
 *   clears `currentSessionId`. The freshly booted claude session announces
 *   itself via the SessionStart hook (recognizable by its `source` field) and
 *   is registered WITHOUT changing status. Otherwise its startup "idle" would
 *   resolve the orchestrator's long-poll before the task even begins.
 * - Status posts carrying a session_id that doesn't match the registered
 *   session are stale (hooks of a killed PTY still in flight) and are ignored.
 * - `currentSessionId` is NOT cleared on idle: the one-shot claude process is
 *   still alive at its prompt and its later hooks must keep matching.
 */
/**
 * Is this post coming from a session that no longer owns the agent?
 *
 * Two ways to be stale: the post carries the id of a session that was killed
 * (the tombstone), or it carries an id that simply is not the registered one.
 * A killed PTY's hooks are separate processes that outlive the kill, so both
 * happen routinely rather than only under attack.
 *
 * /output, /status and /task-completed each spelled this out inline; the two
 * routes that fire desktop notifications did not check at all, so a hook from a
 * session the user had already moved on from could still tell them their agent
 * needed permission. That is one of the ways the app appeared to ask twice.
 */
/**
 * A session id Tars can act on: present, and shaped like one (see below).
 *
 * The nine hooks build this field with `jq -r '.session_id // empty'`, which
 * yields "" when the field is missing and also when jq is not installed, and
 * no hook checks that jq exists. "" is falsy, so every guard written as
 * `if (!sessionId)` or `sessionId &&` answered "this is not stale" in exactly
 * the case it existed to catch. The measured consequence: the Stop hook of a
 * killed pty posts idle with an empty id, and puts the live session to sleep.
 * Worse, a SessionStart carrying "" was accepted, `currentSessionId` was set
 * to "" and saved to disk, so ownership was erased for good and any session
 * could drive that agent afterwards.
 *
 * Empty is therefore an invalid id here, never a benign absence. It also heals
 * an agent whose id was already emptied on disk: that reads as unowned, and
 * the next real session adopts it.
 */
function usableSessionId(sessionId?: string): string | undefined {
  return typeof sessionId === 'string' && SESSION_ID_SHAPE.test(sessionId) ? sessionId : undefined;
}

/**
 * The shape of every id a CLI Tars hooks into gives its session: a UUID, as
 * Claude Code and Gemini CLI both mint them, sent by the hooks exactly as the
 * CLI wrote it.
 *
 * Anything else is refused, not trimmed or cleaned. The registered id becomes
 * a file name (`transcriptPath` joins it into ~/.claude/projects/<project>/)
 * and a `--resume` argument, and until this check any non-empty string was
 * registered: `../../x` made Tars read and watch a file outside the transcript
 * directory. An id on disk from before the check reads as no owner at all, so
 * the next real session adopts the agent.
 */
const SESSION_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id of a session that was killed. Checked on its own before
 *  registration, where the full staleness test cannot run: a SessionStart
 *  legitimately carries an id that is not the current one, since claiming
 *  ownership is what it is for. */
function isTombstonedSession(agent: AgentStatus, sessionId?: string): boolean {
  const id = usableSessionId(sessionId);
  return !!id && id === usableSessionId(agent.lastKilledSessionId);
}

function isStaleSessionPost(agent: AgentStatus, sessionId?: string): boolean {
  const id = usableSessionId(sessionId);
  const owner = usableSessionId(agent.currentSessionId);
  // A post that carries no usable id cannot show it is the owner. Refused
  // wherever there is an owner to protect; an agent nobody owns is left alone.
  if (!id) return !!owner;
  if (isTombstonedSession(agent, id)) return true;
  return !!owner && id !== owner;
}

/**
 * A post, for an agent nobody owns, from a CLI that is not its terminal's: a
 * `claude -p` its Bash tool started, whose hooks carry the agent's id and
 * token (the Audit's L4 and L5 on #380). Such a post drives nothing, on any
 * route: not the session, the turn, the status, the last output nor an alert.
 * Named by the hooks' X-Tars-Cli-Pid; a post that names no CLI is the
 * terminal's, as before. When the process table must be read to tell, the
 * post waits for its answer (one /proc read on Linux, one ps on macOS), and
 * only then: answered at once, the route goes on in the same tick.
 * An agent with an owner needs none of this: isStaleSessionPost decides.
 */
function fromAnotherCli(agent: AgentStatus, req: RouteRequest): boolean | Promise<boolean> {
  if (usableSessionId(agent.currentSessionId)) return false;
  const header = (req.raw as { headers?: Record<string, unknown> } | undefined)?.headers?.['x-tars-cli-pid'];
  const postedBy = typeof header === 'string' ? header : undefined;
  const terminal = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  const execLaunch = terminalIsTheCli(terminal) === true;
  const atOnce = ownCliAtOnce(terminal?.pid, postedBy, process.platform, execLaunch);
  // Answered at once when it can be: a route then goes on in the same tick, as it always did.
  return atOnce === undefined ? isTerminalsOwnCli(terminal?.pid, postedBy, { execLaunch }).then((own) => !own) : !atOnce;
}

/**
 * An agent whose turn failed is not waiting for anyone.
 *
 * Claude Code raises its idle prompt about sixty seconds after StopFailure,
 * exactly as it does after a turn that ended well, and the prompt reaches Tars
 * twice: as a `waiting` status post from notification.sh, and as the desktop
 * notification "X is waiting". Both told JeanBrasse the agent wanted his answer when
 * it had stopped and could do nothing until he logged it in again, and the
 * notification went on saying so after the card had been fixed to say the
 * opposite.
 *
 * So both ask this, and only a new turn, which sets `running`, reopens them.
 * The same rule written in two places is how one of them was forgotten.
 */
function isStoppedOnAFailure(agent: AgentStatus): boolean {
  return agent.status === 'error';
}

/**
 * How long after an agent stops at its prompt Claude Code raises the idle
 * prompt. Measured on 2026-09-18 in the hooks' own logs, a month of every
 * agent on this machine: 1,390 of the 1,393 idle prompts that followed a Stop
 * came 60 seconds after it, to the second, and of the 345 Stops followed by a
 * new turn within that minute, none brought one.
 */
const IDLE_PROMPT_DELAY_MS = 60_000;

/**
 * Is this idle prompt about a rest the agent has already left?
 *
 * The prompt says the agent has sat at its prompt for a minute. If a route
 * handed it work, or a turn began, within that minute, the rest is over: the
 * prompt was raised before the work and reached Tars after it. /run-task,
 * delegate_task's first attempt, is how: it sets `running` and leaves the
 * terminal alone, so the claude in it goes on counting the minute since its
 * last Stop. Taken, the prompt put the working agent back to `waiting`, told
 * JeanBrasse on the desktop that it waited on him, and told the orchestrator it was
 * waiting. /dispatch cannot do this: an agent still `idle` gets a new session,
 * and the posts of the old one are a tombstone's.
 *
 * An older `running` is another matter, and there the prompt is right. A turn
 * that ends with no Stop hook, interrupted from the terminal or a prompt that
 * never became a model turn, leaves `running` behind with nothing else to end
 * it. Measured the same way: 18 idle prompts in a month came 61 seconds or
 * more after a prompt whose turn sent no Stop, and each was the only sign that
 * the turn was over. So the rule is the minute, not the status.
 */
function isStaleIdlePrompt(agent: AgentStatus, now = Date.now()): boolean {
  if (agent.status !== 'running') return false;
  return [agent.workHandedAt, agent.lastTurnStartedAt]
    .map(at => (at ? now - Date.parse(at) : NaN))
    .some(age => age < IDLE_PROMPT_DELAY_MS);
}

/**
 * When a dialog opened: the hook script's own time, not this post's arrival
 * (the Audit's re-check of #174: a refusal made before a late post arrived
 * read as older than the dialog, and the agent stayed deaf until its next
 * turn). Bounded to the last minute and to now: a hook runs as the dialog
 * appears, and a time outside that is a clock or a caller not to believe.
 */
const DIALOG_TIME_SLACK_MS = 60_000;
function dialogOpenedAt(openedAt: unknown): string {
  const now = Date.now();
  const at = typeof openedAt === 'number' && Number.isFinite(openedAt) ? openedAt : now;
  return new Date(at > now || at < now - DIALOG_TIME_SLACK_MS ? now : at).toISOString();
}

/** Long enough for any message the CLI writes in place of an answer, and short
 *  enough for the notification and the card that show it. */
const TURN_FAILURE_TEXT_MAX = 500;

/**
 * What to tell JeanBrasse about a turn that failed: the CLI's own words.
 *
 * Verbatim, because they are what he needs and what he could not see. The
 * night this was found, every terminal read "Not logged in · Please run
 * /login" while Tars reported the agents as working. A paraphrase would put
 * Tars between him and the one sentence that said what to do.
 */
function describeTurnFailure(message: string | undefined, kind: string | undefined): string {
  const text = message?.trim();
  if (text) return text.slice(0, TURN_FAILURE_TEXT_MAX);
  const name = kind?.trim();
  return name
    ? `The turn stopped on an error the CLI reported as ${name.slice(0, 80)}, with no message.`
    : 'The turn stopped on an error the CLI did not describe.';
}

export function registerHooksRoutes(app: RouteApp, ctx: RouteContext): void {
  // POST /api/hooks/output: capture clean text output from agent transcript
  app.post('/api/hooks/output', async (req, sendJson) => {
    const { agent_id, session_id, output } = req.body as {
      agent_id: string;
      session_id?: string;
      output: string;
    };

    if (!agent_id || !output) {
      sendJson({ error: 'agent_id and output are required' }, 400);
      return;
    }

    const agent = findAgentByIdOrSession(agent_id, session_id);
    if (agent && setAsideForMod(agent.id, session_id, req.body as { hook?: unknown })) {
      sendJson({ success: true, ignored: 'state-mod' });
      return;
    }
    if (agent) {
      if (isStaleSessionPost(agent, session_id)) {
        // Stale session: don't let a killed PTY's Stop hook overwrite the
        // live task's output.
        console.log(`[hooks] Ignored stale output post for ${agent.id} (session ${session_id}, current ${agent.currentSessionId ?? 'none'})`);
        sendJson({ success: false, stale: true });
        return;
      }
      const notOwn = fromAnotherCli(agent, req);
      if (notOwn === true || (notOwn !== false && await notOwn)) {
        console.log(`[hooks] Ignored an output post for ${agent.id} from a CLI that is not its terminal's`);
        sendJson({ success: false, stale: true });
        return;
      }
      agent.lastCleanOutput = output;
      saveAgents();
    }

    sendJson({ success: true });
  });

  // POST /api/hooks/status
  app.post('/api/hooks/status', async (req, sendJson) => {
    const {
      agent_id, session_id, status, source, event, waiting_reason, current_task, error_kind, error_message, opened_at,
      tool_name, tool_input, pending, cli_pid,
    } = req.body as {
      agent_id: string;
      session_id: string;
      status: 'running' | 'waiting' | 'idle' | 'completed' | 'error';
      source?: string;
      event?: string;
      reason?: string;
      waiting_reason?: string;
      current_task?: string;
      /** StopFailure only: the CLI's name for what failed, e.g. authentication_failed. */
      error_kind?: string;
      /** StopFailure only: what the CLI wrote in the terminal instead of an answer. */
      error_message?: string;
      /** PermissionRequest only: when the dialog opened (ms), taken by the hook script. */
      opened_at?: number;
      /** Stop only: the timers and background tasks the CLI holds at this rest (hooks/on-stop.sh). */
      pending?: unknown;
      /** PermissionRequest only: the tool the dialog asks about, and its input. */
      tool_name?: string;
      tool_input?: unknown;
      /** SessionStart only: the pid of the CLI whose session this is (Claude Code's CLAUDE_PID). */
      cli_pid?: unknown;
    };

    console.log(`[hooks] POST /api/hooks/status: agent_id=${agent_id}, status=${status}, session_id=${session_id}, source=${source ?? '-'}`);

    if (!agent_id || !status) {
      sendJson({ error: 'agent_id and status are required' }, 400);
      return;
    }

    // Refused loudly, and before anything can be written down. This is the
    // route that sets ownership, drives status, and makes Tars type into a
    // terminal, and an empty id is how a post with nothing to prove reached
    // all three. The predicates below would refuse it too, but as `stale`,
    // which reads as "another session spoke"; this is a malformed post, and
    // saying so names the actual cause: every hook Tars ships sends a real id,
    // so one that cannot is telling us jq is missing on that machine.
    if (!usableSessionId(session_id)) {
      sendJson({ error: 'session_id is required and must be the UUID the CLI gave its session' }, 400);
      return;
    }

    const agent: AgentStatus | undefined = findAgentByIdOrSession(agent_id, session_id);
    if (!agent) {
      sendJson({ success: false, message: 'Agent not found' });
      return;
    }

    if (setAsideForMod(agent.id, session_id, req.body as { hook?: unknown })) {
      sendJson({ success: true, ignored: 'state-mod', agent: { id: agent.id, status: agent.status } });
      return;
    }

    // Tombstone guard: hooks of a killed PTY's session (separate processes
    // that survive the kill) may arrive during the window where the new
    // session hasn't registered yet. Never let them register or flip status.
    if (isTombstonedSession(agent, session_id)) {
      console.log(`[hooks] Ignored post from killed session ${session_id} for ${agent.id} (status=${status})`);
      sendJson({ success: false, stale: true, agent: { id: agent.id, status: agent.status } });
      return;
    }

    // SessionStart registration (source is only ever sent by session-start
    // hooks): record which session now owns this agent, but never touch
    // status: the agent was just dispatched a task and is about to work.
    if (source) {
      // Only the CLI Tars launched in this agent's terminal: one run from
      // inside it (a `claude -p` from its Bash tool) inherits the agent's id,
      // token and hooks, and took the agent's session (core/terminal-cli.ts).
      const terminal = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
      const terminalPid = terminal?.pid;
      const execLaunch = terminalIsTheCli(terminal) === true;
      const refuse = () => {
        console.log(`[hooks] Refused session ${session_id} for ${agent.id}: its CLI (pid ${String(cli_pid)}) is not its terminal's (pid ${terminalPid})`);
        // Where a person can find it (Logs reads the kept output): a refusal
        // that should not have been reads as an agent stuck in its last status.
        appendAgentOutput(agent, `\r\n[Tars] Refused a session (${session_id}): its CLI (pid ${String(cli_pid)}) is not this terminal's (pid ${terminalPid}). A Claude Code run from inside this agent does not take its session.\r\n`);
        sendJson({ success: false, stale: true, foreign: true, agent: { id: agent.id, status: agent.status } });
      };
      const atOnce = ownCliAtOnce(terminalPid, cli_pid, process.platform, execLaunch);
      if (atOnce === false) { refuse(); return; }
      if (atOnce === undefined) {
        // A CLI the terminal's shell started: `ps` says whose child it is.
        void isTerminalsOwnCli(terminalPid, cli_pid, { execLaunch }).then((own) => {
          if (!own) { refuse(); return; }
          // Asked while `ps` ran: the session may have been killed meanwhile.
          if (isTombstonedSession(agent, session_id)) {
            sendJson({ success: false, stale: true, agent: { id: agent.id, status: agent.status } });
            return;
          }
          registerSession();
        });
        return;
      }
      registerSession();
      return;
    }

    function registerSession(): void {
      if (!agent) return;
      agent.currentSessionId = session_id;
      // What the task-start watch reads, instead of an emptied ownership field.
      agent.sessionRegisteredAt = new Date().toISOString();
      agent.sessionPtyId = agent.ptyId;
      // Remembered separately so a restart can resume it: currentSessionId is
      // ownership and gets cleared on load, this is where the work got to.
      agent.resumableSessionId = session_id;
      // A new session holds no timer of the last one.
      agent.restPending = undefined;
      agent.lastActivity = new Date().toISOString();
      // Registered is not started: this only puts the task this session was
      // spawned with on the clock.
      noteSessionRegistered(agent);
      // A permission question an earlier session left with Tars goes back to it.
      dropPermissionAsks(agent.id);
      // Registered by the state mod: the shell hooks' four posts for this
      // session are set aside from now on, and its heartbeat is taken.
      if ((req.body as { via?: unknown }).via === 'mod') noteModSession(agent.id, session_id);
      saveAgents();
      // Not a status change, and so no `status:` event (a /wait answers
      // those), but the fleet did change: what agent-watch held for this agent
      // while its launch was on its way can go in now (agent-watch flush).
      agentStatusEmitter.emit('fleet-change', agent.id);
      sendJson({ success: true, registered: true, agent: { id: agent.id, status: agent.status } });
    }

    // Stale-session guard: only the registered session may drive status.
    //
    // Naming no session at all is refused here too, and that is the point of
    // this guard rather than a detail of it. A status change emits
    // fleet-change, agent-watch answers it with flush(), and flush writes a
    // note into the agent's pty. flush also refuses a requester that is
    // `running`, so posting `idle` for a busy agent is precisely how an
    // outsider could make Tars write into a turn in progress, which it
    // otherwise refuses on principle. The old condition required a session id
    // to be present before comparing it, so omitting the field skipped the
    // comparison: the guard cancelled itself exactly when the caller gave it
    // nothing to check. Every hook Tars ships sends one.
    if (isStaleSessionPost(agent, session_id)) {
      console.log(`[hooks] Ignored stale status post for ${agent.id}: ${status} from session ${session_id} (current: ${agent.currentSessionId})`);
      sendJson({ success: false, stale: true, agent: { id: agent.id, status: agent.status } });
      return;
    }
    // Registration fallback: if SessionStart never reached us (API briefly
    // down at boot), adopt the first non-tombstoned session that reports in.
    // An agent whose id was emptied on disk by the old bug reads as unowned
    // here, so the next real session adopts it and the damage heals itself.
    // Only from the terminal's own CLI, named by the hooks' X-Tars-Cli-Pid
    // (tars_auth, authHeader): a nested claude's hooks carry the agent's id
    // and token, and its first post adopted an agent whose own SessionStart
    // was lost or refused (the Audit's L4 on #380). A post that names no CLI
    // adopts as before. And a post from another CLI drives nothing: not
    // adopted, its turn, its Stop and its status were still the agent's (L5).
    // When the process table must be read, the post waits for its answer
    // (one /proc read on Linux, one ps on macOS) before anything moves.
    const notOwn = fromAnotherCli(agent, req);
    if (notOwn === true || (notOwn !== false && await notOwn)) {
      console.log(`[hooks] Ignored a status post for ${agent.id} from a CLI that is not its terminal's: ${status}`);
      sendJson({ success: false, stale: true, agent: { id: agent.id, status: agent.status } });
      return;
    }
    if (!usableSessionId(agent.currentSessionId) && !isTombstonedSession(agent, session_id)) {
      agent.currentSessionId = session_id;
      agent.resumableSessionId = session_id;
    }

    // The one post that proves a task reached the CLI. It cannot be read off
    // `status: 'running'`: PostToolUse sends that too, and a dispatch has
    // already set that status at spawn, so the hook names the event instead.
    if (event === 'UserPromptSubmit') {
      noteTurnStarted(agent);
      // The turn whose prompt carries a request's id is that request's: its
      // asker is who this turn's result goes to (core/task-requests.ts).
      if (bindTurn(agent, current_task)) saveAgents();
      // The turn opens a task, or is counted in the one open (task-ledger.ts).
      noteTurn(agent, { sessionId: session_id, text: current_task });
      // And the one post that proves a field emptied. An Enter on a line
      // beginning with `/` may run a command or open a dialog, and the keys
      // alone cannot tell which, so the draft model hedges until something
      // settles it. This is that something.
      const ptyProcess = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
      if (ptyProcess) noteSubmitted(ptyProcess);
    }

    const oldStatus = agent.status;

    // The turn ended: a permission question it left with Tars goes back to its
    // engine, which has moved on, and a later answer allows nothing.
    if (status === 'idle' || status === 'completed' || status === 'error') dropPermissionAsks(agent.id);
    // Claude Code showed its dialog after all (a request of the mod's that
    // failed): the terminal asks now, and the window's answer would reach nothing.
    if (status === 'waiting' && waiting_reason === 'permission') dropPermissionAsks(agent.id);

    // Only the idle prompt: a permission prompt is the wait that matters, and
    // it comes in the middle of a turn by definition.
    const staleIdlePrompt = status === 'waiting' && waiting_reason === 'idle' && isStaleIdlePrompt(agent);
    if (staleIdlePrompt) {
      console.log(`[hooks] Ignored an idle prompt for ${agent.id}: it was handed work, or began a turn, less than a minute ago`);
    }

    // What the CLI holds is counted again at the end of each turn.
    if (status === 'running') agent.restPending = undefined;
    if (status === 'running' && agent.status !== 'running') {
      agent.status = 'running';
      agent.waitingReason = undefined;
      if (current_task) agent.currentTask = current_task;
    } else if (status === 'waiting' && agent.status !== 'waiting' && !isStoppedOnAFailure(agent) && !staleIdlePrompt) {
      // An agent whose turn failed stays in error until a new turn starts.
      // Claude Code sends idle_prompt about sixty seconds after StopFailure,
      // as a `waiting` post, and without this guard it replaced the error:
      // an agent left alone, the very case the error exists for, stopped
      // showing why it had stopped. Only `running` clears it.
      agent.status = 'waiting';
      agent.waitingReason = waiting_reason;
      // When the dialog opened: a refusal of it is read from the transcript,
      // after this moment (dialogOpen), since Claude Code sends no hook for one.
      agent.dialogSince = waiting_reason === 'permission' ? dialogOpenedAt(opened_at) : undefined;
      // What the dialog asks, for the page to say (AgentStatus.waitingOn). The
      // idle prompt waits on nobody in particular and has no text.
      agent.waitingOn = waiting_reason === 'permission' ? waitingOnFrom(tool_name, tool_input) : undefined;
    } else if (status === 'idle') {
      agent.status = 'idle';
      agent.waitingReason = undefined;
      // Its timers and background tasks, as the Stop hook counted them: what
      // keeps it from being put to sleep (services/agent-sleep.ts).
      if (pending !== undefined) agent.restPending = restPendingOf(pending);
    } else if (status === 'completed') {
      agent.status = 'completed';
      agent.waitingReason = undefined;
    } else if (status === 'error') {
      // The turn ended on an error the CLI reported itself, through StopFailure.
      // Without this the agent stayed `running` for good: the process lives on
      // at its prompt, so nothing exits, and a turn did begin, so nothing that
      // watches for one ever fires. See hooks/stop-failure.sh for the
      // measurement.
      //
      // This is not a watch on a quiet agent, and must not become one. Nothing
      // here is timed and nothing is inferred from silence: an agent that works
      // slowly never sends this, and one whose turn failed always does.
      agent.status = 'error';
      agent.waitingReason = undefined;
      agent.error = describeTurnFailure(error_message, error_kind);
      // The turn happened and failed. A delivery still pending would be typed in
      // again fifteen seconds later, into a CLI that cannot run it, and its own
      // verdict would then replace the reason the CLI gave.
      agent.pendingDelivery = undefined;
    }

    agent.lastActivity = new Date().toISOString();

    if (oldStatus !== agent.status) {
      console.log(`[hooks] Status changed: ${agent.id} ${oldStatus} → ${agent.status}`);
      // A usage limit Tars moves the agent away from (another Claude account,
      // services/claude-accounts/switching.ts) is not an error to report; the
      // end of a turn may be the moment to move it before its limit.
      const moving = status === 'error' && error_kind === 'rate_limit' && onUsageLimit(agent, error_message);
      if (status === 'idle') onTurnEnded(agent);
      if (!moving) ctx.handleStatusChangeNotificationCallback(agent, agent.status);
      emitAgentStatus(agent.id);

      broadcastToAllWindows('agent:status', {
        agentId: agent.id,
        status: agent.status,
        waitingReason: waiting_reason,
      });
      scheduleTick();
    }

    sendJson({ success: true, agent: { id: agent.id, status: agent.status } });
  });

  // POST /api/hooks/task-completed: dedicated endpoint for TaskCompleted hook
  app.post('/api/hooks/task-completed', async (req, sendJson) => {
    const { agent_id, session_id } = req.body as {
      agent_id: string;
      session_id?: string;
    };

    if (!agent_id) {
      sendJson({ error: 'agent_id is required' }, 400);
      return;
    }

    const agent = findAgentByIdOrSession(agent_id, session_id);
    if (!agent) {
      sendJson({ success: false, message: 'Agent not found' });
      return;
    }

    // The same decision as everywhere else, taken in one place.
    if (isStaleSessionPost(agent, session_id)) {
      console.log(`[hooks] Ignored stale task-completed for ${agent.id} from session ${session_id}`);
      sendJson({ success: false, stale: true, agent: { id: agent.id, status: agent.status } });
      return;
    }
    const notOwn = fromAnotherCli(agent, req);
    if (notOwn === true || (notOwn !== false && await notOwn)) {
      sendJson({ success: false, stale: true, agent: { id: agent.id, status: agent.status } });
      return;
    }

    const oldStatus = agent.status;
    agent.status = 'completed';
    agent.waitingReason = undefined;
    agent.lastActivity = new Date().toISOString();

    const agentName = agent.name || `Agent ${agent.id.slice(0, 6)}`;

    // Send native notification if user has completion notifications enabled
    if (ctx.getAppSettings().notificationsEnabled && ctx.getAppSettings().notifyOnComplete) {
      ctx.sendNotificationCallback(
        `${agentName} finished`,
        agent.currentTask ? `Done: ${agent.currentTask.slice(0, 80)}` : 'Task completed successfully.',
        agent.id,
        ctx.getAppSettings()
      );
    }

    if (oldStatus !== 'completed') {
      console.log(`[hooks] Task completed: ${agent.id} ${oldStatus} → completed`);
      ctx.handleStatusChangeNotificationCallback(agent, 'completed');
      emitAgentStatus(agent.id);

      broadcastToAllWindows('agent:status', {
        agentId: agent.id,
        status: agent.status,
      });
      scheduleTick();
    }

    sendJson({ success: true, agent: { id: agent.id, status: agent.status } });
  });

  // POST /api/hooks/agent-stopped: Send notification when agent finishes a response (Stop hook)
  // POST /api/hooks/mod-beat: the state mod's heartbeat, every 15 s from the
  // CLI's own event loop, with the tool in flight. A frozen loop stops it
  // (stall-watch.ts). Kept only for the session the mod registered, and the
  // stall watch reads it only while that is the agent's current session.
  app.post('/api/hooks/mod-beat', (req, sendJson) => {
    const { agent_id, tool } = req.body as { agent_id?: string; session_id?: string; tool?: unknown };
    const session_id = usableSessionId((req.body as { session_id?: string }).session_id);
    if (!agent_id || !session_id) {
      sendJson({ error: 'agent_id and session_id are required' }, 400);
      return;
    }
    const agent = agents.get(agent_id);
    if (!agent) {
      sendJson({ success: false, message: 'Agent not found' });
      return;
    }
    const kept = noteModBeat(agent.id, session_id, typeof tool === 'string' && tool ? tool.slice(0, 200) : null);
    sendJson({ success: kept });
  });

  // POST /api/hooks/turn-usage: a turn's usage, from the state mod's
  // turn.complete (mods step 4), into the task ledger. It comes after the Stop
  // that ended the turn's task, so it is filed under the agent's latest task
  // in that session (task-ledger.ts). Taken only from the agent's current
  // session, as every post is.
  app.post('/api/hooks/turn-usage', (req, sendJson) => {
    const { agent_id, usage } = req.body as { agent_id?: string; session_id?: string; usage?: unknown };
    const session_id = usableSessionId((req.body as { session_id?: string }).session_id);
    const parsed = turnUsageOf(usage);
    if (!agent_id || !session_id || !parsed) {
      sendJson({ error: 'agent_id, session_id and a usage are required' }, 400);
      return;
    }
    const agent = agents.get(agent_id);
    if (!agent || agent.currentSessionId !== session_id) {
      sendJson({ success: false, message: agent ? 'stale' : 'Agent not found' });
      return;
    }
    const taskId = liveTaskLedger()?.turnUsage(agent.id, session_id, parsed) ?? null;
    sendJson({ success: !!taskId, taskId });
  });

  // POST /api/hooks/permission: the state mod's tool.check, when Claude Code
  // would show its permission dialog (services/permission-asks.ts). For an
  // agent in bypass, a call that touches only its own folders is allowed at
  // once by Tars (services/permission-auto.ts). Anything else is held until
  // the window answers: allow or deny is then the decision, with no dialog.
  // `pending` after 20 s, and the mod asks again for the same call. Nobody
  // answers within the owner's delay: refused, with a reason the agent reads.
  // `ask` hands it back to the dialog: for a session that is not the agent's
  // current one, nothing to name, or a question dropped.
  app.post('/api/hooks/permission', async (req, sendJson) => {
    const { agent_id, tool, input, tool_use_id, reason, rule } = req.body as {
      agent_id?: string; tool?: unknown; input?: unknown; tool_use_id?: unknown; reason?: unknown; rule?: unknown;
    };
    const session_id = usableSessionId((req.body as { session_id?: string }).session_id);
    const agent = agent_id ? agents.get(agent_id) : undefined;
    const fields = askedFields(input);
    if (!agent || !session_id || agent.currentSessionId !== session_id || agent.status === 'stopped'
      || typeof tool !== 'string' || !tool || typeof tool_use_id !== 'string' || !tool_use_id || !fields) {
      sendJson({ decision: 'ask' });
      return;
    }
    const question = {
      tool: tool.slice(0, 200),
      toolUseId: tool_use_id.slice(0, 200),
      fields,
      waitingOn: waitingOnFrom(tool, fields),
      ...(typeof reason === 'string' && reason ? { reason: reason.slice(0, 1000) } : {}),
      ...(typeof rule === 'string' && rule ? { rule: rule.slice(0, 1000) } : {}),
    };
    const afterError = (req.body as { after_error?: unknown }).after_error;
    if (typeof afterError === 'string') console.log(`[permission] ${agent.name || agent.id}'s mod asks again after a failed request: ${oneLine(afterError)}`);
    // The owner's bypass, applied to what Claude Code still asks: yes, when
    // everything the call touches is inside the agent's own folders.
    const places = placesOf(agent, agents.values());
    const judged = places ? judgeCall(question.tool, fields, places) : undefined;
    if (judged?.allow) {
      logPermission(agent, agent.id, question.tool, 'allow', 'Tars (bypass, its own folders)', subjectOf(question.tool, fields));
      sendJson({
        decision: 'allow',
        reason: `Tars allowed it: ${agent.name || agent.id} is in bypass, and ${judged.why}`,
        fingerprint: questionFingerprint(question.tool, fields),
      });
      return;
    }
    if (places && judged) console.log(`[permission] ${agent.name || agent.id} is in bypass, and the call waits for the owner: ${judged.why}`);
    // A file tool the mod asked about by its path alone (its content is a field the window does not show): Tars's
    // own rule above is the only answer it may get. Held for the window, the owner would approve content never
    // shown (the owner's decision of 05/10 keeps edits on Claude Code's dialog): back to the dialog at once.
    if ((req.body as { withheld?: unknown }).withheld === true) {
      logPermission(agent, agent.id, question.tool, 'back to its dialog', 'Tars (a file tool whose content the window does not show)', subjectOf(question.tool, fields));
      sendJson({ decision: 'ask' });
      return;
    }
    const answer = await holdPermissionAsk(agent, question, changed => {
      saveAgents();
      ctx.handleStatusChangeNotificationCallback(changed, changed.status);
      emitAgentStatus(changed.id);
      broadcastToAllWindows('agent:status', {
        agentId: changed.id, status: changed.status, waitingReason: changed.waitingReason, permissionAsk: changed.permissionAsk ?? null,
      });
      scheduleTick();
    }, permissionHoldMs(ctx.getAppSettings()));
    sendJson(answer);
  });

  app.post('/api/hooks/agent-stopped', async (req, sendJson) => {
    const { agent_id, session_id } = req.body as {
      agent_id: string;
      session_id?: string;
    };

    if (!agent_id) {
      sendJson({ error: 'agent_id is required' }, 400);
      return;
    }

    const agent = findAgentByIdOrSession(agent_id, session_id);
    if (!agent) {
      sendJson({ success: false, message: 'Agent not found' });
      return;
    }

    if (setAsideForMod(agent.id, session_id, req.body as { hook?: unknown })) {
      sendJson({ success: true, ignored: 'state-mod' });
      return;
    }

    if (isStaleSessionPost(agent, session_id)) {
      console.log(`[hooks] Ignored stop from session ${session_id} for ${agent.id} (current: ${agent.currentSessionId ?? 'none'})`);
      sendJson({ success: false, stale: true });
      return;
    }
    const notOwn = fromAnotherCli(agent, req);
    if (notOwn === true || (notOwn !== false && await notOwn)) {
      sendJson({ success: false, stale: true });
      return;
    }

    if (ctx.getAppSettings().notificationsEnabled && ctx.getAppSettings().notifyOnStop) {
      const agentName = agent.name || `Agent ${agent.id.slice(0, 6)}`;
      ctx.sendNotificationCallback(
        `${agentName}`,
        agent.lastCleanOutput ? agent.lastCleanOutput.slice(0, 80) : 'Agent has finished and is ready for the next prompt.',
        agent.id,
        ctx.getAppSettings()
      );
    }

    sendJson({ success: true });
  });

  // POST /api/hooks/notification
  app.post('/api/hooks/notification', async (req, sendJson) => {
    const { agent_id, session_id, type, title, message } = req.body as {
      agent_id: string;
      session_id: string;
      type: string;
      title: string;
      message: string;
    };

    if (!agent_id || !type) {
      sendJson({ error: 'agent_id and type are required' }, 400);
      return;
    }

    const agent = findAgentByIdOrSession(agent_id, session_id);
    // An unknown agent_id used to skip the guard below, because the guard was
    // conditioned on the agent existing: the alert still went to the desktop,
    // carrying the caller's own `message`, under the name "Claude". Same shape
    // as the missing session id above, a guard that lapses when the value it
    // checks is absent.
    if (!agent) {
      sendJson({ success: false, message: 'Agent not found' });
      return;
    }
    if (isStaleSessionPost(agent, session_id)) {
      console.log(`[hooks] Ignored ${type} notification from session ${session_id} for ${agent.id} (current: ${agent.currentSessionId ?? 'none'})`);
      sendJson({ success: false, stale: true });
      return;
    }
    const notOwn = fromAnotherCli(agent, req);
    if (notOwn === true || (notOwn !== false && await notOwn)) {
      sendJson({ success: false, stale: true });
      return;
    }
    const agentName = agent.name || 'Claude';

    if (type === 'permission_prompt') {
      if (ctx.getAppSettings().notifyOnWaiting) {
        ctx.sendNotificationCallback(
          `${agentName} needs permission`,
          message || 'Claude needs your permission to proceed',
          agent.id,
          ctx.getAppSettings()
        );
      }
    } else if (type === 'idle_prompt') {
      // The second channel the idle prompt reached. The error notification,
      // which carries the CLI's own sentence, has already gone out; this one
      // would contradict it a minute later. Nothing is broadcast either: an
      // idle prompt after a failure is not an event any screen should show.
      //
      // Only the idle prompt. A permission prompt belongs to a turn in
      // progress, which has already left `error`, and it is a question that
      // really does wait on JeanBrasse.
      if (isStoppedOnAFailure(agent)) {
        sendJson({ success: true, suppressed: 'the agent stopped on a failure and is not waiting' });
        return;
      }
      // Nor while it works on something handed to it after the prompt was
      // raised: the same question the status post asks, answered once.
      if (isStaleIdlePrompt(agent)) {
        sendJson({ success: true, suppressed: 'the agent was handed work after this idle prompt was raised' });
        return;
      }
      if (ctx.getAppSettings().notifyOnWaiting) {
        ctx.sendNotificationCallback(
          `${agentName} is waiting`,
          message || 'Claude is waiting for your input',
          agent.id,
          ctx.getAppSettings()
        );
      }
    }

    broadcastToAllWindows('agent:notification', {
      agentId: agent?.id,
      type,
      title,
      message,
    });

    sendJson({ success: true });
  });
}
