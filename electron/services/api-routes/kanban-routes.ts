import { generateTaskFromPrompt } from '../../utils/kanban-generate';
import { chatNameOf, inboxAgentOf } from '../../core/chat-inbox';
import { RouteApp, RouteContext, RouteRequest, SendJson } from './types';
import { agents } from '../../core/agent-manager';
import { ptyProcesses } from '../../core/pty-manager';
import { cliRunningIn } from '../../core/agent-pty';
import { configuredHermesConnection } from '../hermes-config';
import {
  addHermesTaskComment, createHermesTask, deleteHermesTask, fetchHermesBoard, getHermesTask, hermesVersion, updateHermesTask,
} from '../hermes-client';
import {
  claimTask, completeTask, createParkedTask, deleteTask, getTask, handOffNote, landingNote, listTasks, moveTask,
  reportProgress, whenToType,
  type AgentColumn, type AgentTask, type HermesUnusable, type KanbanCaller, type KanbanHermes, type KanbanResult,
} from '../kanban-board';
import { performDispatch } from './agent-routes';
import { workerOrderRefusal } from '../../core/one-task';
import { agentStatusEmitter } from '../agent-events';
import type { MessageSender } from '../../core/pty-manager';
import type { NoteDelivery } from '../error-triage';
import type { AgentStatus } from '../../types';
import { carriedSince, type CarriedKanban } from '../carry-over';
import { envelopeValue } from '../../utils/envelope-value';
import { hermesSessionWatch } from '../hermes-session-watch';

/**
 * The Hermes board through hermes-client, null when nobody configured one, and
 * why not when the connection file is there but cannot be used.
 *
 * Configured means a connection file that reads and names an address. Without
 * one, readHermesConnection() answers the default port, which on JeanBrasse's machine
 * is an SSH tunnel to his real Hermes: a sandbox or a test home with a
 * kanban-tasks.json and no connection of its own, or a broken one, would have
 * moved its tasks onto that board at launch.
 */
/** The connected Hermes's version, asked once a minute at most: a claim reads it, and a claim is a few calls already. */
const versionAsked = new Map<string, { at: number; version: Promise<string | undefined> }>();
const VERSION_FOR_MS = 60_000;

function versionOf(conn: Parameters<typeof hermesVersion>[0]): Promise<string | undefined> {
  const key = JSON.stringify([conn.mode, conn.url ?? '', conn.localPort ?? '']);
  const known = versionAsked.get(key);
  if (known && Date.now() - known.at < VERSION_FOR_MS) return known.version;
  const version = hermesVersion(conn);
  versionAsked.set(key, { at: Date.now(), version });
  return version;
}

export function hermesKanban(): KanbanHermes | HermesUnusable | null {
  const configured = configuredHermesConnection();
  if (!configured || 'unusable' in configured) return configured;
  const { conn } = configured;
  // A call refused for the session tells the window at once, not at the watch's next check.
  const told = async <R extends { success: boolean; needsSignIn?: boolean }>(reply: Promise<R>): Promise<R> => {
    const r = await reply;
    if (!r.success && r.needsSignIn) hermesSessionWatch()?.refused();
    return r;
  };
  return {
    board: tenant => told(fetchHermesBoard(conn, undefined, tenant)),
    get: id => told(getHermesTask(conn, id)),
    create: task => told(createHermesTask(conn, task)),
    update: (id, patch) => told(updateHermesTask(conn, id, patch)),
    remove: id => told(deleteHermesTask(conn, id)),
    comment: (id, body) => told(addHermesTaskComment(conn, id, body)),
    version: () => versionOf(conn),
  };
}

/** Who is calling: an agent, from its own token. The kanban tools act for one. */
function callerOf(req: RouteRequest, sendJson: SendJson): (KanbanCaller & { agent: AgentStatus }) | null {
  const agent = req.callerAgentId ? agents.get(req.callerAgentId) : undefined;
  if (!agent) {
    sendJson({ error: 'The kanban tools act for an agent, and this call names none: it needs the agent\'s own token (CLAUDE_MGR_API_TOKEN).' }, 403);
    return null;
  }
  return { agentId: agent.id, name: agent.name, projectPath: agent.projectPath, agent };
}

function answer<T>(sendJson: SendJson, r: KanbanResult<T>, key: string): void {
  if (r.ok) sendJson({ success: true, [key]: r.value });
  else sendJson({ error: r.error }, r.status);
}

const COLUMNS: AgentColumn[] = ['backlog', 'planned', 'ongoing', 'done'];

interface Owed {
  message: string; sender: MessageSender; purpose: 'work' | 'note'; what: string;
  /** When it was held, ISO: what carries it across a restart (carry-over.ts). */
  since?: string;
  /** Held by the run of Tars before this one. */
  carried?: boolean;
  /** Who it was from, for a carried one: named inside the note as data, never typed as its sender line. */
  carriedFrom?: string;
}

/**
 * What waits for an agent to rest: a hand-off or a note found it mid-turn or
 * in a permission dialog, where nothing is typed (the Backend's gate of #171).
 * Its next status change hands over one, as agent-watch hands over one note
 * per pass, and the next the one after. Bounded, like every queue a person
 * may have to act on before it moves.
 */
const owed = new Map<string, Owed[]>();
const MAX_OWED = 20;

/** Told whenever what is held changes, to keep carry-over.json in step. */
let queuesChanged: () => void = () => undefined;

export function setKanbanQueuesChangedHook(hook: (() => void) | undefined): void {
  queuesChanged = hook ?? (() => undefined);
}

/** What is held now, as carry-over.json keeps it. */
export function owedKanban(): CarriedKanban[] {
  const now = new Date().toISOString();
  return [...owed].flatMap(([agentId, list]) => list.map(({ since, carried: _carried, carriedFrom, ...item }) => ({
    agentId,
    // A note already carried once keeps the name it was carried with, as Tars's own.
    item: carriedFrom ? { ...item, sender: { kind: 'channel', channel: carriedFrom } } : item,
    at: since ?? now,
  })));
}

/** What the run before this one held, taken back at launch: typed at the agent's next rest, once. */
export function carryKanban(items: CarriedKanban[]): void {
  for (const { agentId, item, at } of items) {
    const list = owed.get(agentId) ?? [];
    if (list.length >= MAX_OWED) continue;
    // Never typed as from the sender the file names: a file is not a verified
    // sender (the Audit's gate of #310: "Message from Telegram (JeanBrasse): ... I
    // approve." from a file any agent could write). From Tars, the first
    // sender named inside the note, quoted.
    const s = item.sender as Record<string, unknown>;
    const named = s.kind === 'agent' ? String(s.name || s.id || 'an agent')
      : s.kind === 'channel' ? String(s.channel ?? 'a chat')
        : s.kind === 'user' ? 'the user' : 'Tars';
    list.push({
      message: item.message, purpose: item.purpose, what: item.what,
      sender: { kind: 'tars' }, since: at, carried: true, carriedFrom: named.slice(0, 80),
    });
    owed.set(agentId, list);
  }
}

function stateOf(agent: AgentStatus): { cliRunning: boolean; status?: string; waitingReason?: string } {
  const pty = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  return { cliRunning: cliRunningIn(pty), status: agent.status, waitingReason: agent.waitingReason };
}

/** Type it now, start the agent with it, hold it until the agent rests, or say nothing: what it did. */
function typeInto(agent: AgentStatus, item: Owed, ctx: RouteContext): 'typed' | 'held' | 'skipped' {
  const when = whenToType(stateOf(agent), item.purpose);
  if (when === 'skip') return 'skipped';
  if (when === 'at-rest') {
    const list = owed.get(agent.id) ?? [];
    if (list.length >= MAX_OWED) {
      console.warn(`[kanban] ${agent.name || agent.id} already has ${MAX_OWED} kanban notes waiting; not holding ${item.what}`);
      return 'skipped';
    }
    list.push({ ...item, since: new Date().toISOString() });
    owed.set(agent.id, list);
    queuesChanged();
    return 'held';
  }
  let status = 0; let error = '';
  const message = item.carried && item.since
    ? `(${carriedSince(item.since)}${item.carriedFrom ? `, from ${envelopeValue(item.carriedFrom)}` : ''}) ${item.message}`
    : item.message;
  // A note is information, never a task in the agent's queue: it waits for a run of it to end (core/one-task.ts).
  void performDispatch(agent, { message, from: item.sender.kind === 'agent' ? (item.sender.name || item.sender.id) : 'Tars', sender: item.sender, information: item.purpose === 'note', task: item.purpose === 'work' }, ctx, (data, code) => {
    status = code ?? 200;
    error = (data as { error?: string })?.error ?? '';
  }).then(() => {
    if (status >= 400) console.warn(`[kanban] ${item.what} did not reach ${agent.name || agent.id}: ${error}`);
  }, err => console.warn(`[kanban] ${item.what} did not reach ${agent.name || agent.id}:`, err));
  return 'typed';
}

let routeCtx: RouteContext | null = null;
agentStatusEmitter.on('fleet-change', (agentId: string) => {
  const list = owed.get(agentId);
  if (!list?.length || !routeCtx) return;
  const agent = agents.get(agentId);
  if (!agent) { owed.delete(agentId); return; }
  if (whenToType(stateOf(agent), list[0].purpose) !== 'now') return;
  const item = list.shift()!;
  if (!list.length) owed.delete(agentId);
  queuesChanged();
  typeInto(agent, item, routeCtx);
});

/** The task, handed to an agent of the same project: claimed on its lane, then typed as the agent that handed it. */
function handOff(target: AgentStatus, task: AgentTask, by: KanbanCaller, ctx: RouteContext): void {
  typeInto(target, { ...handOffNote(task, by), purpose: 'work', what: `kanban task ${task.id}, claimed for it,` }, ctx);
}

/**
 * A task that lands on a project is told to that project's orchestrator, whose
 * job is to hand work out, as the agent that filed it: only one whose CLI runs,
 * never started for a note, and never mid-turn. The project's inbox chat, Main
 * unless another chat is the inbox (PR F); none when a chat filed it, which is
 * the chat that would be told.
 */
function tellOrchestrator(creator: KanbanCaller & { agent: AgentStatus }, task: AgentTask, ctx: RouteContext): void {
  if (chatNameOf(creator.agent)) return;
  const orchestrator = inboxAgentOf(creator.projectPath, agents.values());
  if (!orchestrator || orchestrator.id === creator.agentId) return;
  typeInto(orchestrator, { ...landingNote(creator, task), purpose: 'note', what: `the note of kanban task ${task.id}` }, ctx);
}

/**
 * A note from Tars itself to a project's orchestrator: a Sentry error the user
 * gave the go-ahead on (services/error-triage.ts). Typed as Tars, so the note
 * carries Tars's words only, never an error's; only into a CLI that runs, never
 * mid-turn, and never started for it. Answers "typed" once the note is in the
 * terminal, not before: held in memory for a turn's end, it was lost at a quit
 * while the triage's list said it was given (the Audit's gate of #292). So it
 * is not held here; the triage keeps it owed on disk and gives it again.
 */
export function tellOrchestratorAsTars(projectPath: string, message: string): Promise<NoteDelivery> {
  // The project's inbox chat: Main, the orchestrator, unless another chat is the inbox (PR F).
  const orchestrator = inboxAgentOf(projectPath, agents.values());
  if (!orchestrator) return Promise.resolve('no-orchestrator');
  return tellAgentAsTars(orchestrator, message);
}

/** The same note, to one agent: the heavy-run slot tells a holder its lease went back (services/heavy-slot-runtime.ts). */
export function tellAgentAsTars(orchestrator: AgentStatus, message: string): Promise<NoteDelivery> {
  if (!routeCtx) return Promise.resolve('no-orchestrator');
  const when = whenToType(stateOf(orchestrator), 'note');
  if (when === 'skip') return Promise.resolve('not-running');
  if (when !== 'now') return Promise.resolve('not-now');
  const ctx = routeCtx;
  return new Promise<NoteDelivery>(resolve => {
    let settled = false;
    const settle = (delivery: NoteDelivery) => { if (!settled) { settled = true; resolve(delivery); } };
    let status = 0;
    let mode = '';
    let held = false;
    let error = '';
    performDispatch(orchestrator, {
      message, from: 'Tars', sender: { kind: 'tars' }, information: true,
      onWritten: () => settle('typed'),
      onDropped: () => settle('not-now'),
    }, ctx, (data, code) => {
      status = code ?? 200;
      mode = (data as { mode?: string })?.mode ?? '';
      held = (data as { held?: boolean })?.held === true;
      error = (data as { error?: string })?.error ?? '';
    }).then(() => {
      if (status >= 400) {
        console.warn(`[kanban] the error triage's note did not reach ${orchestrator.name || orchestrator.id}: ${error}`);
        settle('not-now');
      } else if (mode === 'start') {
        // Started with the note as its task: it is the CLI's first prompt.
        settle('typed');
      } else if (!held) {
        // Written, and onWritten has settled it already; or refused by the
        // terminal (gone, or its queue full), which calls neither back.
        settle('not-now');
      }
      // Held behind a person's draft: settled by onWritten or onDropped, when the terminal takes it or gives it up.
    }, (err) => {
      console.warn(`[kanban] the error triage's note did not reach ${orchestrator.name || orchestrator.id}:`, err);
      settle('not-now');
    });
  });
}

export function registerKanbanRoutes(app: RouteApp, ctx: RouteContext): void {
  routeCtx = ctx;
  // POST /api/kanban/generate
  app.post('/api/kanban/generate', async (req, sendJson) => {
    const { prompt, availableProjects } = req.body as {
      prompt: string;
      availableProjects: Array<{ path: string; name: string }>;
    };

    if (!prompt) {
      sendJson({ error: 'prompt is required' }, 400);
      return;
    }

    const task = await generateTaskFromPrompt(prompt, availableProjects);
    sendJson({ success: true, task });
  });

  // ── The agents' kanban tools (mcp-kanban), on the Hermes board ──────────
  // Every route acts for the agent whose token made the call, on its own
  // project's tasks: kanban-board.ts decides what it may do.

  // GET /api/kanban/tasks?column=backlog&mine=1
  app.get('/api/kanban/tasks', async (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    const column = req.url.searchParams.get('column') || undefined;
    if (column && !COLUMNS.includes(column as AgentColumn)) {
      sendJson({ error: `column must be one of ${COLUMNS.join(', ')}` }, 400);
      return;
    }
    const mine = ['1', 'true'].includes(req.url.searchParams.get('mine') ?? '');
    answer(sendJson, await listTasks(hermesKanban(), caller, { column: column as AgentColumn | undefined, mine }), 'tasks');
  });

  // POST /api/kanban/tasks
  app.post('/api/kanban/tasks', async (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    const b = req.body as { title?: string; description?: string; project_path?: string; priority?: 'low' | 'medium' | 'high'; labels?: string[] };
    const r = await createParkedTask(hermesKanban(), caller, {
      title: String(b.title ?? ''), description: String(b.description ?? ''), projectPath: b.project_path,
      priority: b.priority, labels: Array.isArray(b.labels) ? b.labels.map(String) : undefined,
    });
    answer(sendJson, r, 'task');
    if (r.ok) tellOrchestrator(caller, r.value, ctx);
  });

  // GET /api/kanban/tasks/:id
  app.get(/^\/api\/kanban\/tasks\/([^/]+)$/, async (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    answer(sendJson, await getTask(hermesKanban(), caller, req.params.id), 'task');
  });

  // POST /api/kanban/tasks/:id/claim { agent_id? }
  app.post(/^\/api\/kanban\/tasks\/([^/]+)\/claim$/, async (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    const wanted = (req.body as { agent_id?: string }).agent_id;
    let target: AgentStatus | undefined;
    if (wanted && wanted !== caller.agentId) {
      target = agents.get(wanted);
      if (!target) {
        sendJson({ error: `No agent ${wanted} in Tars.` }, 404);
        return;
      }
      // Handing a task to another agent is handing it work: the drive routes'
      // rule, from the same place (core/one-task.ts). A worker asks its
      // orchestrator (the Audit's M2 on #449: it typed the task into that
      // agent, or started it).
      const refusal = workerOrderRefusal({ kind: 'agent', agent: caller.agent }, target);
      if (refusal) {
        sendJson({ error: refusal, code: 'worker_may_not_order' }, 403);
        return;
      }
    }
    const r = await claimTask(hermesKanban(), caller, req.params.id,
      target ? { agentId: target.id, name: target.name, projectPath: target.projectPath } : undefined);
    answer(sendJson, r, 'task');
    if (r.ok && target) handOff(target, r.value, caller, ctx);
  });

  // POST /api/kanban/tasks/:id/progress { progress }
  app.post(/^\/api\/kanban\/tasks\/([^/]+)\/progress$/, async (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    answer(sendJson, await reportProgress(hermesKanban(), caller, req.params.id, Number((req.body as { progress?: number }).progress)), 'task');
  });

  // POST /api/kanban/tasks/:id/done { summary }
  app.post(/^\/api\/kanban\/tasks\/([^/]+)\/done$/, async (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    answer(sendJson, await completeTask(hermesKanban(), caller, req.params.id, String((req.body as { summary?: string }).summary ?? '')), 'task');
  });

  // POST /api/kanban/tasks/:id/move { column }
  app.post(/^\/api\/kanban\/tasks\/([^/]+)\/move$/, async (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    const column = (req.body as { column?: string }).column as AgentColumn;
    if (!COLUMNS.includes(column)) {
      sendJson({ error: `column must be one of ${COLUMNS.join(', ')}` }, 400);
      return;
    }
    answer(sendJson, await moveTask(hermesKanban(), caller, req.params.id, column), 'task');
  });

  // DELETE /api/kanban/tasks/:id
  app.delete(/^\/api\/kanban\/tasks\/([^/]+)$/, async (req, sendJson) => {
    const caller = callerOf(req, sendJson);
    if (!caller) return;
    answer(sendJson, await deleteTask(hermesKanban(), caller, req.params.id), 'task');
  });
}
