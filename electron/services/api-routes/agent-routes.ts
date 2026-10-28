import { hasClaudeHooks } from '../../core/end-of-turn';
import * as path from 'path';
import { publishedWaitingOn } from '../../utils/waiting-on';
import * as fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { agents, saveAgents, killStalePty, ensureProjectTrusted, appendAgentOutput, armTaskStartWatch } from '../../core/agent-manager';
import { noteTurnCut, ptyProcesses, writeProgrammaticInput, type MessageSender } from '../../core/pty-manager';
import { spawnAgentPty, cliRunningIn } from '../../core/agent-pty';
import { killPty } from '../../core/pty-kill';
import { removeAgent } from '../../core/agent-remove';
import { hasEndOfTurn } from '../../core/end-of-turn';
import { agentStatusOnExit, isQuitting } from '../../core/quit-state';
import { clearStop, noteRestartAfterStop, stopAgent, stopReasonOf } from '../../core/agent-stop';
import { diskRefusal, freeSpace } from '../../core/disk-space';
import { noteWaker, wakeFromSleep } from '../../core/agent-asleep';
import type { AgentWakeVia } from '../../types';
import { sessionStarted, SENDER_WAIT_MS, launchBegins, launchAbandoned, dialogOpen, dialogShown, takeSlot } from '../../core/agent-launch';
import { getAllProviders, getProvider, isValidProvider } from '../../providers';
import { planModeRefusal } from '../../providers/plan-mode';
// An agent may name any CLI, since an agent in bypass can run any binary itself (SECURITY.md): what is
// refused is only what could not start, on the platform Tars runs on (2.0.2).
import { cliPathProblem } from '../../platform/cli-path';
import { skillsProblem } from '../../utils/skill-name';
import { handedFolderProblem } from '../../utils/handed-folder';
import { buildFullPath } from '../../utils/path-builder';
import { toLaunch, withPath, LaunchError, type Launch } from '../../platform';
import { cliPathDirs } from '../../utils/cli-path-dirs';
import { AgentStatus, AgentCharacter, AgentRole, AgentProvider, AgentEffort, AgentPermissionMode } from '../../types';
import { RouteApp, RouteContext, RouteRequest, SendJson } from './types';
import { getSuperAgentInstructionsPath } from '../../utils';
import { assembleDigest, needsPromptInjection, wrapDigestForPrompt } from '../memory-hub';
import { agentGuideSection, guideForPrompt, guideIndex, guideTopic } from '../agent-guide';
import { ensureProjectFiles } from '../../utils/project-files';
import { app } from 'electron';
import { usableHermesConnection } from '../hermes-config';
import { consumeResumeSessionId, newConversationOnNextStart, nextStartResumes } from '../../utils/resume-session';
import { getTasmaniaStatus } from '../tasmania-client';
import { emitAgentStatus } from '../agent-events';
import { handOffFrom, liveTaskLedger, noteHandOff, watchTurns, type TaskWithResult } from '../task-ledger';
import { readTaskCosts } from '../task-cost';
import { readFinalAnswer } from '../terminal-answer';
import { typeLaunchTask } from '../../core/typed-task';
import { accountDir } from '../claude-accounts/registry';
import { announceTask, firstLineOf } from '../task-banner';
import { keptSender, queueRight, queueView, replayJobOf, type RunTaskReplay } from '../agent-queues';
import { taskOfPrompt, requestTitle, enqueueRequest, requestDelivered, requestDropped, requestStartsSession, requestGivenUp, endWorkerRequests, mayInterrupt, mayRestart, cutWorkOf } from '../../core/task-requests';
import { clientRequestIdOf, liveReceipts, payloadHash, type ReceiptOutcome } from '../request-receipts';
import { isPermissionLevel, levelOf, modeGapMark, raises, type PermissionLevel } from '../../core/permission-ceiling';
import { canInterrupt } from '../bus-store';
import { interruptTurn } from '../bus-delivery';
import { broadcastToAllWindows } from '../../utils/broadcast';
import { scheduleTick } from '../../utils/agents-tick';
import { checkpointProblem, writeCheckpoint, checkpointOfTask } from '../../core/agent-checkpoint';
import { noteWaitingOn } from '../agent-watch';
import { lastInterruptAt, pendingBackgroundWork, withSessionTruth } from '../agent-truth';
import { turnInterruptedAt } from '../task-watch';
import { noteLaunch, launchSettings, restartForSettings, type RestartOutcome, type RestartWait } from '../../core/agent-restart';
import { cliAtWork, updateAgent, type AgentUpdate } from '../../core/agent-update';
import { assignRole, hasOrchestratorPowers, requestedRole } from '../../core/agent-role';
import { callerId as resolveCallerId, callerProject } from './utils';
import { mcpConfigPathFor } from '../mcp-roles';
import { envelopeValue } from '../../utils/envelope-value';
import { replyTargetOf } from '../../core/reply-target';
import { oneTaskQueue, workerOrderRefusal, workerStopRefusal, isReportTo, noteFrom, behindText, unknownTaskText, terminalTurnOf, holdsMessages, type Busy, type QueuedTask } from '../../core/one-task';
import { chatIdentityOf, chatOfAsker, orchestratorMoved } from '../../core/chat-identity';

/**
 * The orchestrator instructions, or nothing for a regular agent. The UI start
 * path attached this file; the API path (every MCP delegate_task, start_agent
 * and send_message) did not, so an orchestrator driven by the MCP ran without
 * the rules that tell it to delegate rather than code.
 */
function orchestratorInstructionsFile(isOrchestrator: boolean | undefined): string | undefined {
  if (!isOrchestrator) return undefined;
  const file = getSuperAgentInstructionsPath();
  return fs.existsSync(file) ? file : undefined;
}

type SpawnOpts = {
  model?: string;
  /** The session's mode: the agent's own, or narrower (modeRefusal). */
  permissionMode?: PermissionLevel;
  printMode?: boolean;
  /** Who starts it: noted when the start undoes a stop (core/agent-stop.ts). */
  by?: string;
  /** Who this session wakes the agent for, and how, should it be asleep (core/agent-asleep.ts). */
  wokenBy?: { by: string; via: AgentWakeVia };
  /** The request this prompt runs (core/task-requests.ts): delivered as the session starts. */
  taskRef?: string;
  /**
   * Who sent the prompt, when it is a dispatch: its task is that sender's when
   * no request names its asker. An asker the agent once handed work to queues
   * none (requestFor), and its task, starting the session, was filed as Tars's
   * or under the agent's own requester (the Audit's M1 on #470).
   */
  sender?: MessageSender;
};

/**
 * Spawn a fresh one-shot claude PTY for `agent` with `prompt` as the task.
 *
 * Shared by /start, the /message reconnect path, and /dispatch so every entry
 * point gets identical behavior: skills prefix, MCP config for orchestrators,
 * model flag, orchestrator tool restrictions (BUG 5), trust pre-acceptance
 * (BUG 6), stale-PTY kill and ptyCwd invariant (BUG 4), and session-ownership
 * reset so hooks of the killed session can't flip the new task's status.
 *
 * Returns false if validation failed. An error response has already been sent.
 */
/**
 * Tell every open window that this agent changed, on both channels it reads.
 *
 * The routes here changed agents and told nothing but the in-process emitter,
 * which is /wait's and agent-watch's. A page already open went on showing an
 * agent the super chat had just started, given a task or stopped, until it was
 * reloaded, and the super chat drives every agent it touches through these
 * routes. Both channels, because they are not interchangeable: the Chat page's
 * rail reloads the fleet on `agent:status`, and the Agents page and the
 * Dashboard redraw on `agents:tick`, so either one alone leaves a view wrong.
 * The payload is the one the IPC paths send.
 */
/** The stop, for the callers that read an agent's state: who, when, why. Nothing once it is not stopped. */
function stopOf(agent: AgentStatus): { stoppedBy?: string; stoppedAt?: string; stopReason?: string; stopProcesses?: AgentStatus['stopProcesses'] } {
  return agent.status === 'stopped'
    ? { stoppedBy: agent.stoppedBy, stoppedAt: agent.stoppedAt, stopReason: agent.stopReason, ...(agent.stopProcesses ? { stopProcesses: agent.stopProcesses } : {}) }
    : {};
}

/**
 * The stop a start just undid, for the one who started it (JeanBrasse, 05/10: an
 * orchestrator may start again an agent JeanBrasse stopped, and is told why it was
 * stopped). Nothing when this start undid none.
 */
function restartedAfterStop(agent: AgentStatus, since: string): { restartedAfterStop?: { stoppedBy?: string; stoppedAt?: string; stopReason?: string } } {
  const restart = agent.lastRestartAfterStop;
  if (!restart || restart.restartedAt < since) return {};
  return { restartedAfterStop: { stoppedBy: restart.stoppedBy, stoppedAt: restart.stoppedAt, stopReason: restart.stopReason } };
}

function announceAgent(agent: AgentStatus): void {
  broadcastToAllWindows('agent:status', {
    type: 'status',
    agentId: agent.id,
    status: agent.status,
    timestamp: agent.lastActivity,
  });
  scheduleTick();
}

/**
 * A mode asked for an agent's session that it may not have: none of Tars's (400), or wider than the agent's own
 * (403). A session runs at its agent's mode or narrower: whoever starts it, a /start, a /dispatch or a Hermes
 * gateway's message, may lower it for that session, never raise it (core/permission-ceiling.ts, the Audit's NOW-3
 * and R4.1, 2.0.4: the webhook started any agent of any project in bypass). Undefined when none was asked, or the
 * one asked is fine.
 */
export function modeRefusal(agent: AgentStatus, asked: unknown): { status: number; error: string } | undefined {
  if (asked === undefined || asked === null) return undefined;
  if (!isPermissionLevel(asked)) return { status: 400, error: 'permissionMode is one of plan, normal, auto, bypass.' };
  const own = levelOf(agent);
  if (!raises(asked, own)) return undefined;
  return {
    status: 403,
    error: `${agent.name || agent.id} runs in ${own} mode: a session started for it may run narrower, never wider, and ${asked} is wider. Change its mode in Tars to widen it.`,
  };
}

async function spawnAgentSession(
  agent: AgentStatus,
  prompt: string,
  opts: SpawnOpts,
  ctx: RouteContext,
  sendJson: SendJson
): Promise<boolean> {
  // Never wider than the agent's own mode, whoever asked (modeRefusal): the one
  // place a session starts says it last, before anything is ended or spawned.
  const wider = modeRefusal(agent, opts.permissionMode);
  if (wider) {
    sendJson({ error: wider.error }, wider.status);
    return false;
  }
  // A session started while the quit ends the others would be in no map the
  // quit ends: refused before anything here ends the old terminal (the Audit's
  // gate of #235: a /start 200 ms into the quit answered 200 and its CLI
  // outlived Tars). spawnAgentPty refuses too, for the callers that are not here.
  // A nearly full disk: the reason, rather than the 500 a throw from the
  // spawn below would come back as (core/disk-space.ts).
  const full = diskRefusal(freeSpace());
  if (full) {
    sendJson({ error: full, diskFull: true }, 507);
    return false;
  }
  if (isQuitting()) {
    sendJson({ error: 'Tars is quitting: no new session is started.', quitting: true }, 503);
    return false;
  }
  // A chat's runner starts within the RAM's limit, whoever starts it (core/agent-launch.ts).
  const slot = await takeSlot(agent.id);
  if (!slot.ok) {
    sendJson({ error: slot.error, chatLimit: true }, 409);
    return false;
  }
  try {
    return await spawnAgentSessionInSlot(agent, prompt, opts, ctx, sendJson);
  } finally {
    slot.release();
  }
}

async function spawnAgentSessionInSlot(
  agent: AgentStatus,
  prompt: string,
  opts: SpawnOpts,
  ctx: RouteContext,
  sendJson: SendJson
): Promise<boolean> {
  // Raw cwd for pty.spawn; toLaunch quotes it for the `cd` command. These
  // must be separate: passing the shell-escaped form to pty.spawn would
  // break when the path legitimately contains a single quote.
  const rawWorkingDir = agent.worktreePath || agent.projectPath;

  // Resolve provider and binary: honours the per-agent CLI override, custom
  // CLI paths in Settings, and the agent's provider (claude / codex / gemini /
  // grok / openrouter / deepseek / moonshot / etc.).
  const appSettings = ctx.getAppSettings();
  const cliProvider = getProvider(agent.provider);
  const binaryPath = agent.cliPath || cliProvider.resolveBinaryPath(appSettings);

  const usePrintMode = opts.printMode;

  // The orchestrator's powers: its project's orchestrator (the toggle, never
  // the name) or a chat's runner (core/agent-role.ts).
  const isSuperAgentApi = hasOrchestratorPowers(agent);

  // Provider env vars: CLAUDE_* tracking vars + ANTHROPIC_BASE_URL /
  // ANTHROPIC_API_KEY for alt providers (OpenRouter, DeepSeek, Moonshot...).
  const providerEnvVars = cliProvider.getPtyEnvVars(agent.id, agent.projectPath, agent.skills || [], appSettings, { model: opts.model ?? agent.model, effort: agent.effort });

  const keyRefusal = missingKeyRefusal(agent.provider, providerEnvVars);
  if (keyRefusal) {
    sendJson({ error: keyRefusal }, 400);
    return false;
  }

  // Local provider (Tasmania): point the claude binary at the local server,
  // mirroring initAgentPty. Reject cleanly when Tasmania isn't running.
  // Otherwise the session silently runs on Anthropic cloud.
  let tasmaniaEnv: Record<string, string> = {};
  if (agent.provider === 'local') {
    try {
      const tasmaniaStatus = await getTasmaniaStatus();
      if (tasmaniaStatus.status === 'running' && tasmaniaStatus.endpoint) {
        tasmaniaEnv = {
          // Strip /v1 suffix: Claude Code SDK appends /v1/messages itself
          ANTHROPIC_BASE_URL: tasmaniaStatus.endpoint.replace(/\/v1\/?$/, ''),
          ANTHROPIC_MODEL: agent.localModel || tasmaniaStatus.modelName || 'default',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        };
      } else {
        sendJson({ error: 'Local provider (Tasmania) is not running. Start it before dispatching to this agent.' }, 409);
        return false;
      }
    } catch (err) {
      sendJson({ error: `Local provider (Tasmania) unavailable: ${err instanceof Error ? err.message : String(err)}` }, 409);
      return false;
    }
  }

  // Identity header: agents must know who they are without the orchestrator
  // having to explain it in every delegation ("les agents ne comprennent pas
  // qui ils sont"). The SessionStart bootstrap injection adds the full team
  // roster; this header guarantees the essentials even if hooks are absent.
  // (The provider builder handles the skills prefix itself.)
  const identityHeader =
    `[Tars: you are agent "${agent.name || agent.id}" (id ${agent.id}), ` +
    `${agent.kind === 'chat' ? 'orchestrator' : agent.role || 'worker'} of project ${agent.projectPath}` +
    (agent.worktreePath
      ? `, working in worktree ${agent.worktreePath}${agent.branchName ? ` (branch ${agent.branchName})` : ''}: stay inside this directory`
      : '') +
    `. Work autonomously without asking for confirmation and end with a clear report of your results` +
    (isSuperAgentApi ? '' : ': an orchestrator reads your final message') +
    `.` + (chatIdentityOf(agent) ? ` ${chatIdentityOf(agent)}` : '') + `]`;

  // MCP config for flag-strategy providers (all claude-based ones), by role
  // (services/mcp-roles.ts): a worker's lacks Telegram and X. os.homedir(),
  // which follows HOME, and never Electron's home path, which on macOS does
  // not: a sandboxed Tars handed its agents the real one.
  const mcpConfigPath = mcpConfigPathFor(cliProvider, isSuperAgentApi);

  // An explicit model on this call wins, otherwise the model the agent is set
  // to. Not the model its last session answered on: that is the session this
  // spawn replaces, and preferring it put every agent moved to a new model in
  // the Agents page back on the old one. A `/model` typed into a terminal
  // lasts for that session; the Agents page is where a model is kept.
  const resolvedModel = opts.model || agent.model;
  const effectiveMode = opts.permissionMode ?? levelOf(agent);


  // CLIs without Claude's SessionStart hook get the project's memory in the
  // prompt instead - otherwise those agents start knowing nothing.
  let memoryBlock = '';
  if (needsPromptInjection(cliProvider.configDir)) {
    try {
      const digest = await assembleDigest({
        projectPath: agent.projectPath,
        settings: appSettings as never,
        hermes: usableHermesConnection(),
      });
      const wrapped = wrapDigestForPrompt(digest);
      if (wrapped) memoryBlock = `\n\n${wrapped}`;
    } catch {
      // Memory is context, not a precondition: never block a start on it.
    }
  }

  // The task as the CLI receives it, and as it gets typed in if the argument
  // never becomes a turn.
  // And how Tars works (services/agent-guide.ts): a claude terminal gets it
  // in its bootstrap, a CLI without that hook here.
  // Its own header says who the agent is: the guide without the line.
  const guide = guideForPrompt(agent, cliProvider.configDir, { identity: false });
  const guideBlock = guide ? `\n\n${guide}` : '';
  const taskPrompt = `${identityHeader}${guideBlock}${memoryBlock}\n\n${prompt}`;

  // The conversation to continue: the last session, once per run or after a
  // sleep. The agent's own session is a tombstone once this launch ends its
  // terminal (below): continued under its id, every post of it would be
  // refused, so it continues under a new one, as a restart does
  // (agent-restart.ts), and the ended CLI's late posts stay refused.
  const resumeSessionId = consumeResumeSessionId(agent) ?? undefined;
  const forkSession = !!resumeSessionId && resumeSessionId === agent.currentSessionId;

  // Build the CLI command through the provider so non-claude CLIs (codex,
  // gemini, grok, opencode, pi) get their own syntax instead of claude flags,
  // once what its line needs is read from the CLI (codex's flags), off the
  // main thread.
  await cliProvider.prepareLaunch?.(binaryPath, effectiveMode);
  let cliCommand: string;
  try {
    cliCommand = cliProvider.buildInteractiveCommand({
      agentId: agent.id,
      resumeSessionId,
      forkSession,
      binaryPath,
      prompt: taskPrompt,
      model: resolvedModel && resolvedModel !== 'default' ? resolvedModel : undefined,
      permissionMode: effectiveMode,
      effort: agent.effort,
      secondaryProjectPath: agent.secondaryProjectPath,
      obsidianVaultPaths: agent.obsidianVaultPaths,
      mcpConfigPath,
      skills: agent.skills,
      // Without this an orchestrator restarted through the API or by another
      // orchestrator woke up with no orchestration rules and did the work
      // itself instead of delegating.
      systemPromptFile: orchestratorInstructionsFile(isSuperAgentApi),
      isSuperAgent: isSuperAgentApi,
      // BUG 5: an orchestrator cannot edit files directly.
      orchestratorMode: isSuperAgentApi,
      verbose: appSettings.verboseModeEnabled,
      chrome: appSettings.chromeEnabled,
    });
  } catch (err) {
    sendJson({ error: err instanceof Error ? err.message : 'Invalid agent configuration' }, 400);
    return false;
  }

  // Print mode: inject -p right after the binary token.
  if (usePrintMode) {
    const binToken = `'${binaryPath.replace(/'/g, "'\\''")}'`;
    if (cliCommand.startsWith(binToken)) {
      cliCommand = `${binToken} -p${cliCommand.slice(binToken.length)}`;
    }
  }

  // Include user-configured CLI dirs so non-claude binaries resolve too.
  const fullPath = buildFullPath(cliPathDirs(appSettings.cliPaths as unknown as Record<string, unknown> | undefined));

  // Assemble the environment. Identity vars are re-asserted explicitly
  // (MCP project scoping and the hooks depend on them), and provider-specified
  // vars (e.g. CLAUDECODE) are purged so nested sessions don't inherit them.
  const spawnEnv: Record<string, string | undefined> = {
    ...withPath(process.env, fullPath, process.platform),
    TERM: 'xterm-256color',
    ...providerEnvVars,
    ...tasmaniaEnv,
    CLAUDE_SKILLS: agent.skills?.join(',') || '',
    CLAUDE_AGENT_ID: agent.id,
    CLAUDE_PROJECT_PATH: agent.projectPath,
    // Load CLAUDE.md from --add-dir directories (e.g. ~/.tars)
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
  };
  for (const key of cliProvider.getEnvVarsToDelete()) {
    delete spawnEnv[key];
  }

  // darwin/linux: `/bin/bash -l -c "cd '<dir>' && exec <cmd>"`. `exec`: the
  // shell hands its terminal to the CLI instead of waiting on it. Without it
  // the CLI ran inside the shell's process group and the terminal named
  // `bash` for the CLI's whole life, so everything that reads what runs
  // there (cliRunningIn, in core/agent-pty.ts) took a live session for a bare
  // shell. The provider builds one simple command, the quoted binary and its
  // arguments, which is what exec needs; a test holds every provider to it.
  // win32: that command read back into argv and the CLI started as the
  // terminal's process, with no shell (platform/launch.ts).
  // Worked out before anything is killed: a CLI Windows cannot start as it
  // is configured is said to the caller, as a provider that refuses its
  // configuration is above, and the agent keeps its terminal and session.
  let start: Launch;
  try {
    start = toLaunch(cliCommand, rawWorkingDir, spawnEnv);
  } catch (err) {
    if (!(err instanceof LaunchError)) throw err;
    sendJson({ error: err.message }, 400);
    return false;
  }

  // Kill any existing PTY for this agent before spawning a new one.
  // Agents started via the API use one-shot PTYs that stay alive (the claude
  // process waits at a prompt after each task). Without this, every dispatch
  // orphans the previous PTY+claude process, eventually exhausting resources.
  if (agent.ptyId) {
    const existingPty = ptyProcesses.get(agent.ptyId);
    if (existingPty) {
      killPty(existingPty);
      ptyProcesses.delete(agent.ptyId);
    }
  }
  // Tombstone the killed session: its hook scripts (separate processes that
  // survive the PTY kill) may still POST status/output for several seconds.
  // Without this, the session-adoption fallback in hooks-routes would adopt
  // the dead session during the window before the new SessionStart registers.
  if (agent.currentSessionId) {
    agent.lastKilledSessionId = agent.currentSessionId;
  }
  // A fork writes no transcript before its first turn: until it does, the
  // conversation to resume is still the one it continues (resume-session.ts).
  agent.forkedFromSessionId = forkSession ? resumeSessionId : undefined;

  // BUG 6: pre-accept Claude Code's workspace trust dialog for this cwd.
  ensureProjectTrusted(rawWorkingDir);

  // A session that never starts a turn must stop claiming to work. See
  // TASK_START_GRACE_MS below for what this catches and why it is checked
  // rather than assumed.
  //
  // A launch, for every other sender, from before its terminal exists
  // (core/agent-launch.ts): the CLI execs at once and counts as running, but
  // takes no keys until its SessionStart. Unmarked, a /dispatch 0.1 to 0.3 s
  // after a /start typed its message into a claude not yet reading, and it was
  // lost 4 times in 5 while the caller heard 200 (the Audit, gate of #134).
  const launch = launchBegins(agent.id, { withTask: !!prompt.trim() });
  let ptyProcess: ReturnType<typeof spawnAgentPty>;
  try {
    ptyProcess = spawnAgentPty({
      binaryName: cliProvider.binaryName,
      ...(start.platform === 'win32'
        ? { shell: start.file, args: start.commandLine }
        : { shell: start.shell, args: start.args }),
      runsCommand: true,
      cols: 120,
      rows: 40,
      cwd: rawWorkingDir,
      env: start.env,
    });
  } catch (err) {
    launchAbandoned(agent.id, launch);
    throw err;
  }

  const ptyId = uuidv4();
  ptyProcesses.set(ptyId, ptyProcess);
  noteLaunch(ptyProcess, launchSettings(agent));
  // amp takes its task typed in, once it runs (core/typed-task.ts).
  if (prompt.trim()) typeLaunchTask(cliProvider, ptyProcess, { prompt: taskPrompt, skills: agent.skills, isSuperAgent: isSuperAgentApi });

  agent.ptyId = ptyId;
  // The request this prompt runs is delivered with it, and its first turn is
  // its turn (core/task-requests.ts). A link left from before (an older Tars)
  // is carried onto the new terminal, as it was.
  const request = opts.taskRef ? agent.taskQueue?.find(r => r.ref === opts.taskRef) : undefined;
  if (request) {
    requestStartsSession(agent, request.ref);
    requestDelivered(agent, request.ref);
  } else if (agent.requestedBy) {
    agent.requestedBy = { ...agent.requestedBy, ptyId };
  }
  agent.ptyCwd = rawWorkingDir;
  // A terminal again: a stop is over (core/agent-stop.ts), and if there was
  // one, who undid it is noted beside who made it; and a sleep is over too,
  // the agent waking on its conversation, its task the message that woke it.
  noteRestartAfterStop(agent, opts.by ?? opts.wokenBy?.by ?? 'Tars');
  clearStop(agent);
  if (opts.wokenBy) noteWaker(agent.id, opts.wokenBy.by, opts.wokenBy.via);
  wakeFromSleep(agent);
  agent.status = 'running';
  agent.workHandedAt = new Date().toISOString();
  // Work handed over, for the task its first turn opens (task-ledger.ts).
  if (prompt.trim()) {
    const asker = request?.requesterAgentId;
    noteHandOff(agent.id, asker
      ? { source: 'agent', requesterAgentId: asker, text: prompt }
      : opts.sender && opts.sender.kind !== 'tars'
        ? { ...handOffFrom(opts.sender), text: prompt }
        : agent.requestedBy?.agentId
          ? { source: 'agent', requesterAgentId: agent.requestedBy.agentId, text: prompt }
          : { source: 'tars', text: prompt });
  }
  agent.currentTask = prompt;
  agent.output = [];
  agent.lastCleanOutput = undefined;  // Clear stale output from previous task
  agent.error = undefined;            // Clear previous error state
  agent.waitingReason = undefined;
  // The old session (if any) died with its PTY. The fresh claude session
  // re-registers itself via the SessionStart hook; clearing now lets the
  // hooks-routes stale-session guard reject in-flight posts from the killed
  // session that would otherwise flip this new task's status.
  agent.currentSessionId = undefined;
  agent.lastActivity = new Date().toISOString();
  saveAgents();

  armTaskStartWatch(agent, ptyId, taskPrompt);
  announceAgent(agent);

  ptyProcess.onData((data: string) => {
    appendAgentOutput(agent, data);
    if (agent.output.length > 10000) {
      agent.output = agent.output.slice(-5000);
    }
    agent.lastActivity = new Date().toISOString();

    // The event every other terminal sends, with the terminal it came from:
    // a panel that filters on ptyId dropped this one's output, or took it for
    // the terminal it replaced.
    broadcastToAllWindows('agent:output', {
      type: 'output',
      agentId: agent.id,
      ptyId,
      data,
      timestamp: new Date().toISOString(),
    });
    // As initAgentPty does: the tick carries the line the cards show.
    scheduleTick();
  });

  ptyProcess.onExit(({ exitCode }) => {
    // A CLI that exits before its session came up is not coming up: nobody
    // waits the rest of CLI_BOOT_MS for it.
    launchAbandoned(agent.id, launch);
    // Remove from the live map IMMEDIATELY: node-pty write() on a dead PTY is
    // a silent no-op, so leaving it registered lets /dispatch and /message
    // "successfully" type a task into a corpse during the status-delay below.
    ptyProcesses.delete(ptyId);
    // Delay status change to let hooks (on-stop.sh, task-completed.sh) finish
    // capturing output before wait_for_agent resolves.
    setTimeout(() => {
      // Guard: only mutate if this PTY is still the active one, since a newer
      // dispatch may have replaced it during the delay.
      if (agent.ptyId !== ptyId) {
        return;
      }
      // Ended by the quit: neither the agent's completion nor its error, and
      // the closing window is not told it was (the Audit's gate of #235).
      const outcome = agentStatusOnExit(exitCode);
      if (!outcome) return;
      if (agent.status === 'running') {
        agent.status = outcome;
      } else if (agent.status === 'waiting') {
        // PTY exited while agent was waiting for input: the claude process
        // crashed. Mark as error so /wait is unblocked and the orchestrator
        // can retry rather than hanging until timeout.
        agent.status = 'error';
        agent.waitingReason = undefined;
      }
      if (exitCode !== 0) {
        agent.error = `Process exited with code ${exitCode}`;
      }
      agent.lastActivity = new Date().toISOString();
      saveAgents();
      emitAgentStatus(agent.id);
      // The terminal is gone, so the record stops naming it, and the windows
      // hear it. Only after the emit above: agent-watch tells whoever
      // delegated this work by matching the link it recorded against this
      // ptyId, and clearing it first silently cancelled that notification.
      agent.ptyId = undefined;
      announceAgent(agent);
    }, 1500);
  });

  return true;
}

/** Serializable agent projection for API responses: excludes the raw ANSI
 *  `output` buffer (up to 10 000 chunks), which destroys LLM context windows
 *  when returned to MCP callers. Use /output or ?full=true when needed. */
function projectAgent(agent: AgentStatus) {
  const { output, ...rest } = agent;
  return { ...rest, outputChunks: output.length };
}

// callerId and callerProject live in ./utils: the bus routes ask the same two
// questions, and one answer to each is one thing to change.

/**
 * Remember which agent asked for this work, so services/agent-watch.ts can
 * tell it when the work is done.
 *
 * The MCP client has always sent X-Tars-Caller-Id and nothing has ever read
 * it to establish a filiation, which is why delegation was one-directional:
 * Tars knew an agent had finished but not who was waiting on it.
 *
 * Recorded on every route that starts work rather than only in
 * spawnAgentSession, because the common delegation is a message into an
 * already-live session, which spawns nothing. It is deliberately also cleared
 * when the request has no caller: a start from the interface must not leave
 * an orchestrator attached to work it never asked for, and would otherwise
 * inherit the link from the last delegation.
 *
 * Called only once the route has let the call through and found it well
 * formed. It ran before the guard, so a caller the guard then refused had
 * already rewritten the link: the shared token cleared it, and an agent of
 * another project put its own name there, which is to say the work was then
 * announced to the caller that had been turned away and never to the
 * orchestrator that had asked for it. Found by the audit of lot 4.
 */
/**
 * Why a message is not in the terminal yet, in words a caller can pass on.
 *
 * One string, because two routes say it and a second copy would drift.
 */
const HELD_REASON = 'Somebody is typing in that terminal, has left something in its field, or has a '
  + "command's panel open there. The message goes in by itself as soon as the field is free: "
  + 'whoever is at that terminal can send or clear what is typed, or close the panel.';

/** The same, when what holds it is a dialog the CLI shows (a permission, a
 *  question): the Enter would answer it. */
const DIALOG_REASON = 'That agent\'s CLI shows a dialog (a permission or a question), and a typed Enter would answer it. '
  + 'The message goes in by itself once the dialog is answered or refused.';

function heldReasonFor(agent: AgentStatus): string {
  return dialogShown(agent, agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined) ? DIALOG_REASON : HELD_REASON;
}

/**
 * How long a held message waits before the agent that sent it is told again
 * (bug-held-forever-05-10.md: three messages answered HELD, "Nothing needs
 * resending", waited 2 h 20 to 2 h 40, and nobody heard of them again).
 */
export const HELD_RETELL_MS = 3 * 60_000;

const clockOf = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

/**
 * Tells the agent that sent a message, once, when it is still held
 * HELD_RETELL_MS on: why, and that only a person at the terminal ends the
 * wait. A target in a turn may have somebody typing at it: it is looked at
 * again later. Returns what cancels it, for when the message goes in or is
 * dropped.
 */
function retellWhileHeld(target: AgentStatus, sender: MessageSender | undefined, sentAt: number): () => void {
  if (sender?.kind !== 'agent' || sender.id === target.id) return () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    timer = setTimeout(() => {
      if (target.status === 'running') { arm(); return; }
      const from = agents.get(sender.id);
      const pty = from?.ptyId ? ptyProcesses.get(from.ptyId) : undefined;
      if (!pty) return;
      // Quoted as data, as every value a note of Tars's carries outside a fence
      // (utils/envelope-value.ts): a name with a line separator in it would
      // otherwise put a line of its own in Tars's voice (the Audit's gate of #314).
      const name = envelopeValue(target.name || target.id);
      const minutes = Math.max(1, Math.round((Date.now() - sentAt) / 60_000));
      writeProgrammaticInput(pty,
        `[Tars] Your message to ${name} of ${clockOf(sentAt)} is still not in its terminal, ${minutes} minutes on. `
        + `${heldReasonFor(target)} Only a person at that terminal can end this wait: if nobody is there, tell the user, `
        + `or stop ${name} and start it again, which drops the message, and send it again then.`,
        true, { agentId: sender.id, from: 'Tars', sender: { kind: 'tars' } });
    }, HELD_RETELL_MS);
    timer.unref?.();
  };
  arm();
  return () => { if (timer) clearTimeout(timer); };
}

/** How long a message waits behind an agent's work before its sender hears it still waits. */
export const BEHIND_WORK_RETELL_MS = 10 * 60_000;

/**
 * Tells the agent that sent a message held behind the target's work (a run,
 * or a turn) once, BEHIND_WORK_RETELL_MS on, that it still waits and goes in
 * at the target's next rest: under steady work it heard only `queued` at the
 * start (the Audit's L-D on 9d9a7ad9). Nothing to resend. Returns what cancels
 * it, for when the message goes in or is dropped.
 */
function retellBehindWork(target: AgentStatus, sender: MessageSender | undefined, sentAt: number): () => void {
  if (sender?.kind !== 'agent' || sender.id === target.id) return () => undefined;
  const timer = setTimeout(() => {
    const from = agents.get(sender.id);
    const pty = from?.ptyId ? ptyProcesses.get(from.ptyId) : undefined;
    if (!pty) return;
    const name = envelopeValue(target.name || target.id);
    const minutes = Math.max(1, Math.round((Date.now() - sentAt) / 60_000));
    writeProgrammaticInput(pty,
      `[Tars] Your message to ${name} of ${clockOf(sentAt)} still waits for ${name}'s work to end, ${minutes} minutes on: `
      + 'it goes in at its next rest. Nothing needs resending.',
      true, { agentId: sender.id, from: 'Tars', sender: { kind: 'tars' } });
  }, BEHIND_WORK_RETELL_MS);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** Who a message into an agent's terminal is from, as verified: the agent whose
 *  token made the call, or Tars when it is Tars's own pass or the agent itself. */
function senderOf(agent: AgentStatus, req: RouteRequest): MessageSender {
  const callerId = resolveCallerId(req);
  if (!callerId || callerId === agent.id) return { kind: 'tars' };
  return { kind: 'agent', id: callerId, name: agents.get(callerId)?.name };
}

/** Who a message into an agent's terminal is from, as the panel names them. */
function senderName(agent: AgentStatus, req: RouteRequest): string {
  const callerId = resolveCallerId(req);
  if (!callerId || callerId === agent.id) return 'Tars';
  return agents.get(callerId)?.name || callerId;
}

/**
 * The request this call hands over, queued on the agent (core/task-requests.ts),
 * or undefined when the caller is nobody's requester: Tars, the agent itself,
 * or a worker reporting to the agent that leads it. It used to be written into
 * `requestedBy` here, at send time, so a second request overwrote the first
 * while the first was still the agent's work. Returns its id, for the sender
 * line Tars types before the message.
 */
function requestFor(agent: AgentStatus, req: RouteRequest, title?: string, ref?: string): string | undefined {
  const callerId = resolveCallerId(req);
  const agentId = callerId && callerId !== agent.id ? callerId : undefined;
  // A worker writing to the agent that leads it (the orchestrator that handed
  // it the work, or one of its project's with the orchestrator's powers: the
  // orchestrator, a chat's runner) is reporting, not delegating: as a link,
  // the orchestrator's next outcome was typed into the worker's terminal as
  // news of work it had never handed over. The orchestrator's own link, if it
  // has one, stays as it is.
  const caller = agentId ? agents.get(agentId) : undefined;
  if (caller && (caller.requestedBy?.agentId === agent.id
      || (hasOrchestratorPowers(agent) && agent.projectPath === caller.projectPath))) return undefined;
  if (!agentId) return undefined;
  const queued = enqueueRequest(agent, agentId, { title, ...(ref ? { ref } : {}) });
  saveAgents();
  return queued;
}

/**
 * Written into the agent's terminal: the request may take the link
 * (core/task-requests.ts). Returns whether it is now the agent's work: a
 * request typed in during another's turn waits, and must not move what marks
 * the work in hand (QA's gate of #351). A message with no request is.
 */
function delivered(agent: AgentStatus, ref: string | undefined): boolean {
  if (!ref) return true;
  const request = agent.taskQueue?.find((r) => r.ref === ref);
  // Known to task_status from now, by the id its sender line named (2.0.5: "No such task" for t-9aa78b94, 27/10).
  if (request) oneTaskQueue.noteDelivered({ ref, agentId: agent.id, requesterId: request.requesterAgentId, title: requestTitle(ref) ?? '', queuedAt: Date.parse(request.queuedAt) || Date.now() }, 'typed');
  requestDelivered(agent, ref);
  saveAgents();
  return agent.requestedBy?.taskRef === ref;
}

/** Refused before anything was typed: the caller had the answer, so nobody is told. */
function dropped(agent: AgentStatus, ref: string | undefined): void {
  if (!ref) return;
  requestDropped(agent, ref);
  saveAgents();
}

/** Given up before it went in: off the queue, and its requester told it never ran (the Audit's R2). */
function givenUp(agent: AgentStatus, ref: string | undefined): void {
  if (!ref) return;
  requestGivenUp(agent, ref);
  saveAgents();
}

/**
 * Refused to a caller that is nobody, on every route that drives an agent.
 *
 * What it replaces, measured on b17db0f: a call on `~/.dorothy/api-token` with
 * no `x-tars-client` header stopped, started, messaged, dispatched to and
 * DELETEd an agent of any project, and got a 200. The guard only ever refused
 * a caller that volunteered `x-tars-client: mcp`, which is a header the caller
 * writes about itself: an agent that read the shared file and left that header
 * out had the whole fleet. Honouring it was the theatre; it is gone.
 *
 * Every agent can read that file (`--add-dir ~/.tars`, and on this machine
 * 37 of 42 agents run with `--dangerously-skip-permissions`, so its Bash reads
 * it whatever the flag says), so a call that presents it names nobody. This is
 * the same door the bus has had since the shared token stopped opening rooms.
 *
 * What still passes without an agent behind it: the reads. `session-start.sh`
 * fetches `/api/agents/:id/bootstrap` with the shared token, so requiring an
 * identity there would leave every fresh session without its own name.
 */
const NO_IDENTITY_TO_DRIVE =
  'Driving an agent takes an identity of your own, and this call has none: it presents the '
  + 'shared token, which every agent can read and which therefore names nobody. '
  + 'An agent is known by the token Tars gives its process when it starts it, not by a name: '
  + 'restart the agent from Tars.';

/** Who is driving: an agent of the fleet, or Tars itself. */
type Driver = { kind: 'agent'; agent: AgentStatus } | { kind: 'tars' };

function resolveDriver(req: RouteRequest, sendJson: SendJson): Driver | undefined {
  // Tars itself is not an agent and never will be. This is the super chat
  // reaching the route over the loopback so that a message from JeanBrasse takes the
  // same path a delegation takes, holding a pass that exists only in this
  // process's memory. Nothing scopes it: JeanBrasse's chat drives every project,
  // which is what it is for.
  if (req.internal) return { kind: 'tars' };

  const callerId = resolveCallerId(req);
  if (!callerId) {
    sendJson({ error: NO_IDENTITY_TO_DRIVE }, 403);
    return undefined;
  }
  const caller = agents.get(callerId);
  if (!caller) {
    // An agent removed from the fleet keeps its token until its process ends.
    // Reading its project would give undefined, which is how the old guard
    // read "unrestricted".
    sendJson({ error: 'The calling agent is not one Tars knows about.' }, 404);
    return undefined;
  }
  return { kind: 'agent', agent: caller };
}

/**
 * Cross-project guard: an agent may only act on agents of its own project.
 * This is what stops an orchestrator from delegating to another project's
 * agents when the LLM picks a wrong ID from a global listing. The project is
 * the one of the agent whose token the call presents, never a header.
 *
 * Between agents it is still a guard against mistakes rather than a boundary:
 * any agent can pass allowCrossProject: true. What changed is that there is no
 * longer a way round it by having no identity at all.
 */
function assertMayDriveAgent(req: RouteRequest, agent: AgentStatus, sendJson: SendJson): boolean {
  const driver = resolveDriver(req, sendJson);
  if (!driver) return false;
  return mayActIn(req, driver, agent.projectPath, `agent "${agent.name || agent.id}" belongs to project ${agent.projectPath}`, sendJson);
}

/**
 * The cross-project rule itself, for a project rather than an agent in it:
 * the drive routes ask it about the agent they act on, and creation about the
 * project the new agent would join. `what` says which, in the refusal.
 */
function mayActIn(req: RouteRequest, driver: Driver, projectPath: string, what: string, sendJson: SendJson): boolean {
  if (driver.kind === 'tars') return true;

  const caller = driver.agent;
  if (projectPath === caller.projectPath) return true;
  if ((req.body as { allowCrossProject?: boolean } | undefined)?.allowCrossProject === true) return true;
  // DELETE requests have no parsed body. Accept the override as a query param.
  if (req.url.searchParams.get('allowCrossProject') === 'true') return true;
  sendJson({
    error: `Cross-project access denied: ${what}, but you are the orchestrator of ${caller.projectPath}. Use list_agents to see YOUR project's agents, or pass allowCrossProject: true if this is intentional.`,
  }, 403);
  return false;
}

/**
 * A worker never orders work from another agent (core/one-task.ts): the
 * routes that hand an agent work ask this after the cross-project guard. Tars's
 * own pass, an agent with an orchestrator's powers and the agent itself pass;
 * a worker is refused, and told to ask its orchestrator. The window drives
 * agents over IPC and never reaches these routes.
 */
function mayHandWork(req: RouteRequest, agent: AgentStatus, sendJson: SendJson): boolean {
  if (req.internal) return true;
  const callerId = resolveCallerId(req);
  const caller = callerId ? agents.get(callerId) : undefined;
  // assertMayDriveAgent, asked first, has refused a caller with no agent behind it.
  if (!caller) return true;
  const refusal = workerOrderRefusal({ kind: 'agent', agent: caller }, agent);
  if (!refusal) return true;
  sendJson({ error: refusal, code: 'worker_may_not_order' }, 403);
  return false;
}

/**
 * Stopping is reserved as handing work is (core/one-task.ts): the routes that
 * end, restart or remove an agent's CLI ask this after the cross-project
 * guard, and a worker is refused, told to ask its orchestrator.
 */
function mayStop(req: RouteRequest, agent: AgentStatus, sendJson: SendJson): boolean {
  if (req.internal) return true;
  const callerId = resolveCallerId(req);
  const caller = callerId ? agents.get(callerId) : undefined;
  // The cross-project guard, asked first, has refused a caller with no agent behind it.
  if (!caller) return true;
  const refusal = workerStopRefusal({ kind: 'agent', agent: caller }, agent);
  if (!refusal) return true;
  sendJson({ error: refusal, code: 'worker_may_not_stop' }, 403);
  return false;
}

/**
 * The worker this call comes from when what it sends another agent is a note,
 * not a report to whoever leads it (core/one-task.ts, isReportTo).
 */
function noteSender(req: RouteRequest, agent: AgentStatus): AgentStatus | undefined {
  if (req.internal) return undefined;
  const callerId = resolveCallerId(req);
  const caller = callerId && callerId !== agent.id ? agents.get(callerId) : undefined;
  if (!caller || hasOrchestratorPowers(caller) || isReportTo(caller, agent)) return undefined;
  return caller;
}

/** A note never starts a session: it waits for a turn's end, and an agent with no CLI up has none. */
function noteNeedsSession(agent: AgentStatus): Record<string, unknown> {
  return {
    error: `${envelopeValue(agent.name || agent.id)} has no session open, and a note does not start one: nothing was sent. `
      + 'A worker does not hand work to another agent; ask your orchestrator if it needs to do something.',
    code: 'note_needs_session',
  };
}

/**
 * A turn in the agent's terminal, where Tars can see one end
 * (core/one-task.ts, terminalTurnOf): never for a CLI without hooks, never for
 * one the stall watch found doing nothing.
 */
function terminalTurn(agent: AgentStatus): Busy | undefined {
  return terminalTurnOf(agent, cliRunningIn(agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined));
}

/**
 * A worker writing to whoever leads it: a report, not a task, so it is no
 * task in that agent's queue either (core/one-task.ts, isReportTo).
 */
function reportSender(req: RouteRequest, agent: AgentStatus): AgentStatus | undefined {
  if (req.internal) return undefined;
  const callerId = resolveCallerId(req);
  const caller = callerId && callerId !== agent.id ? agents.get(callerId) : undefined;
  return caller && !hasOrchestratorPowers(caller) && isReportTo(caller, agent) ? caller : undefined;
}

/** What a task asked now (or the queued task `ref`) waits behind, said for its asker. */
function busyText(agent: AgentStatus, ref?: string): string {
  const busy = oneTaskQueue.busyRun(agent.id) ?? terminalTurn(agent);
  const nameOf = (id: string) => agents.get(id)?.name;
  const line = oneTaskQueue.queued(agent.id);
  const at = ref ? line.findIndex((t) => t.ref === ref) : -1;
  const before = at >= 0 ? at : line.length;
  const head = busy ? behindText(busy, nameOf) : 'the tasks queued before it';
  return before && busy ? `${head}, and ${before} task${before === 1 ? '' : 's'} queued before it` : head;
}

/**
 * Waits for a queued task's turn: first in its agent's line, and the agent
 * free (no run, no turn in its terminal). Taken, its run is on record at once
 * (oneTaskQueue.takeTurn). False when it was cancelled, or its agent deleted.
 */
async function waitTurn(agent: AgentStatus, ref: string): Promise<boolean> {
  for (;;) {
    if (!agents.has(agent.id)) { oneTaskQueue.cancel(ref, 'its agent was removed'); return false; }
    if (!oneTaskQueue.find(ref)) return false;
    if (oneTaskQueue.takeTurn(agent.id, ref, terminalTurn(agent))) return true;
    await new Promise((r) => setTimeout(r, TASK_WAIT_STEP_MS));
  }
}

/**
 * Serializes everything that reads-then-mutates one agent's live-session
 * state (ptyId, status) so two callers deciding "message vs spawn" for the
 * same agent at once can't both observe "no live session" and both spawn a
 * fresh PTY.
 *
 * The race is real, not theoretical: spawnAgentSession awaits the memory
 * digest for every non-Claude CLI (needsPromptInjection), which is a genuine
 * suspension point. Two orchestrators (or one orchestrator retried by a
 * caller) dispatching to the same idle agent within that window each pass
 * the "no live PTY" check before either has set agent.ptyId, so both spawn -
 * the second silently orphans the first's process and only the second
 * survives in the agent record. A resolved-promise-only await (the Claude
 * path) never yields far enough for this to happen, which is why it went
 * unnoticed: it only bites non-Claude agents.
 */
const agentDispatchLocks = new Map<string, Promise<unknown>>();

/** A model run-task takes for one run (delegate_task's `model`). */
const RUN_MODEL = /^[A-Za-z0-9._:/[\]-]{1,100}$/;
/** The longest GET /api/tasks/:id?wait= holds a request: one segment, well under undici's 300 s. */
const TASK_WAIT_MAX_S = 120;
const TASK_WAIT_STEP_MS = 500;
/**
 * What a run answered beyond what the ledger keeps (its tools, what it left
 * running, its error), for the caller that waits on its task: the run-task
 * request that started it was answered at the start. In memory, the latest
 * RUN_ENDS_KEPT: after a relaunch the ledger's own record is the answer.
 */
const runEnds = new Map<string, { toolCalls?: string[]; backgroundStopped?: string[]; backgroundLeft?: string[]; error?: string; costUSD?: number }>();
const RUN_ENDS_KEPT = 200;
function noteRunEnd(taskId: string, result: { toolCalls?: string[]; backgroundStopped?: string[]; backgroundLeft?: string[]; error?: string; costUSD?: number }): void {
  runEnds.set(taskId, {
    ...(result.toolCalls?.length ? { toolCalls: result.toolCalls } : {}),
    ...(result.backgroundStopped?.length ? { backgroundStopped: result.backgroundStopped } : {}),
    ...(result.backgroundLeft?.length ? { backgroundLeft: result.backgroundLeft } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(typeof result.costUSD === 'number' ? { costUSD: result.costUSD } : {}),
  });
  while (runEnds.size > RUN_ENDS_KEPT) runEnds.delete(runEnds.keys().next().value as string);
}

/* ── A task in the agent's own terminal (2.0.4) ───────────────────────────── */

/** The model asked for a task, and whether its session took it, by the task's id and the ledger's. */
const taskModels = new Map<string, { asked: string; taken: boolean; own?: string; ranOn?: string }>();
/** A session started for a task undid somebody's stop: who, when and why, by the task's id and the ledger's. */
type RestartNote = { stoppedBy?: string; stoppedAt?: string; stopReason?: string };
const taskRestarts = new Map<string, RestartNote>();
const keep = <T>(map: Map<string, T>, key: string, value: T) => {
  map.set(key, value);
  while (map.size > RUN_ENDS_KEPT) map.delete(map.keys().next().value as string);
};
/** Ledger tasks whose end is known and whose answer is still being read: their followers wait for it. */
const answering = new Set<string>();

/** How long a task typed in may wait for its turn to begin before it is said never started. */
const TURN_START_MAX_MS = 15 * 60_000;
/** How long an asker's follow lasts after its wait answered: the next segment is asked within it. */
const FOLLOW_GRACE_MS = 5_000;
const follows = new Map<string, { count: number; release: () => void; timer?: ReturnType<typeof setTimeout> }>();

/**
 * The asker waits on its task (GET /api/tasks/:id?wait=): while it does, and
 * for a moment after each segment, the end of that agent's work is not typed
 * into the asker's terminal as well (agent-watch.ts, isWaitingOn). Returns
 * the release.
 */
function followTask(workerId: string, askerId: string): () => void {
  const key = `${workerId}\0${askerId}`;
  let follow = follows.get(key);
  if (!follow) {
    follow = { count: 0, release: noteWaitingOn(workerId, askerId) };
    follows.set(key, follow);
  }
  if (follow.timer) {
    clearTimeout(follow.timer);
    follow.timer = undefined;
  }
  follow.count += 1;
  let done = false;
  return () => {
    const held = follows.get(key);
    if (done || !held) return;
    done = true;
    held.count -= 1;
    if (held.count > 0) return;
    held.timer = setTimeout(() => {
      if (held.count > 0) return;
      held.release();
      follows.delete(key);
    }, FOLLOW_GRACE_MS);
    held.timer.unref?.();
  };
}

/**
 * Whether Tars hears this CLI's turns begin with the prompt they run (the
 * UserPromptSubmit post, which opens the ledger's task) and end: every CLI
 * whose hooks say both, or whose turns Tars reads and posts as those hooks
 * would (core/end-of-turn.ts): claude, the providers that run it, Qwen Code (Claude Code's hooks), gemini
 * (BeforeAgent and AfterAgent, hooks/gemini/, since 2.0.4), and codex, from
 * its session log (services/codex-sessions.ts). opencode, amp, pi and grok
 * have no such hook.
 */
function turnsHeard(agent: AgentStatus): boolean {
  return hasEndOfTurn(agent);
}

/** Whether its final answer can be read from a transcript Tars knows: Claude Code's, Qwen Code's. */
function transcriptRead(agent: AgentStatus): boolean {
  return hasClaudeHooks(agent);
}

/** What the asker is told of a task typed into a CLI whose turns Tars cannot see. */
function deliveredText(agent: AgentStatus): string {
  return `The task went into ${agent.name || agent.id}'s terminal. Its CLI, ${agent.provider ?? 'this one'}, gives Tars no hook: Tars cannot see when its turn ends, `
    + 'and reads neither its answer, its tokens nor its cost. Read its terminal, or have it report with send_message to "requester".';
}

/** What a terminal task used and cost, from its session, or undefined when nothing priced it (never 0 for unknown). */
async function terminalUsage(task: TaskWithResult): Promise<Record<string, unknown> | undefined> {
  if (task.source === 'acp') return undefined;
  try {
    const cost = (await readTaskCosts([task])).get(task.id);
    if (!cost?.tokens) return undefined;
    return {
      inputTokens: cost.tokens.input, outputTokens: cost.tokens.output,
      cachedReadTokens: cost.tokens.cacheRead, cachedWriteTokens: cost.tokens.cacheWrite,
      totalTokens: cost.tokens.input + cost.tokens.output + cost.tokens.cacheRead + cost.tokens.cacheWrite,
      costUSD: cost.costUSD, from: cost.from,
    };
  } catch (err) {
    console.warn('[run-task] what a task used could not be read:', (err as Error).message);
    return undefined;
  }
}

/** The folder of the Claude account a task ran on, after the first; undefined for account 1 (~/.claude). */
function accountFolderOf(accountId: string | null): string | undefined {
  if (!accountId || accountId === 'default') return undefined;
  try {
    return accountDir(accountId);
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The task, typed into the agent's permanent terminal (or the session it
 * starts with it), followed to its end there: the turn it opens, the rest that
 * ends it (or an interrupt, for which Claude Code sends no hook), then its
 * final answer from the transcript. The answer the route gives at the end.
 */
async function runInTerminal(
  agent: AgentStatus, req: RouteRequest, ctx: RouteContext, job: { task: string; ref: string; model?: string; asSent?: { from?: string; sender?: MessageSender; mark?: string } },
  onHanded: (start: Record<string, unknown>) => void,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const ledger = liveTaskLedger();
  const never = (why: string, status = 502, more: Record<string, unknown> = {}) => {
    oneTaskQueue.notStarted(job.ref, why);
    return { status, body: { ok: false, started: false, outcome: 'error', taskId: job.ref, error: `Task ${job.ref} never started: ${why}.`, ...more } };
  };
  // The turn this task opens: the first the agent begins once it is typed,
  // the one whose prompt carries this task's id when the sender line has one.
  let turnTask: string | undefined;
  const stopWatching = watchTurns((agentId, taskId, prompt) => {
    if (agentId !== agent.id || turnTask) return;
    const tagged = taskOfPrompt(prompt);
    if (tagged && tagged.ref !== job.ref) return;
    turnTask = taskId;
    // It ends at its turn's rest, whatever it left running (the Audit's M1 on #453).
    ledger?.delegatedTask(taskId);
    // Followed by its first id, it is the ledger's task from this moment on,
    // and open until its answer is read, however soon its turn ends.
    answering.add(taskId);
    oneTaskQueue.runNamed(agent.id, taskId);
    const asked = taskModels.get(job.ref);
    if (asked) taskModels.set(taskId, asked);
    const restart = taskRestarts.get(job.ref);
    if (restart) taskRestarts.set(taskId, restart);
  });
  try {
    let refused: { data: Record<string, unknown>; status: number } | undefined;
    let mode: unknown;
    let restart: RestartNote | undefined;
    let gaveUp = false;
    let withdrawn = false;
    const callerId = resolveCallerId(req);
    const requester = callerId && callerId !== agent.id ? callerId : undefined;
    // The agent is at rest (one task at a time): a task still open there is
    // one its background work keeps open. It ends now, and this task's turn
    // opens its own (the Audit's H1 on #453).
    ledger?.endedForDelegation(agent.id);
    await performDispatch(agent, {
      // Its sender line as it was queued, for a task kept across a restart (the Audit's Info 1 on #536).
      message: job.task, model: job.model, from: job.asSent?.from ?? senderName(agent, req), sender: job.asSent?.sender ?? senderOf(agent, req), mark: job.asSent?.mark ?? markFor(agent, req),
      turnTaken: true,
      onAccepted: () => requestFor(agent, req, job.task, job.ref),
      // An agent's task carries its id on its line, a request queued for it
      // or not; Tars's line carries none (taskOfPrompt reads an agent's). The
      // writer notes the hand-off the turn takes (pty-manager.ts, takeField):
      // noted here too, a second one, with no id when the line had none, was
      // left over for the agent's next turn with none, and that turn was filed
      // under this task's asker (the QA's CLI matrix, H1).
      ...(requester ? { taskId: job.ref } : {}),
      onDropped: () => { gaveUp = true; },
      // Taken back by its asker while held in the terminal (a draft): the
      // turn it kept is given back at once, not after TURN_START_MAX_MS (the
      // Audit's M-B on 8f4f1fd7, on the run-task path).
      onWithdrawn: () => { withdrawn = true; },
    }, ctx, (data, status = 200) => {
      if (status >= 300) refused = { data: (data ?? {}) as Record<string, unknown>, status };
      else {
        mode = (data as { mode?: unknown } | undefined)?.mode;
        restart = (data as { restartedAfterStop?: RestartNote } | undefined)?.restartedAfterStop;
      }
    });
    if (refused) return never(String(refused.data.error ?? 'the terminal refused it'), refused.status, { code: refused.data.code });
    if (job.model) {
      // A model applies to a session Tars starts for the task, never to one already open.
      keep(taskModels, job.ref, { asked: job.model, taken: mode === 'start', ...(agent.model ? { own: agent.model } : {}) });
    }
    if (restart) keep(taskRestarts, job.ref, restart);
    const handed = {
      ...(taskModels.get(job.ref) ? { model: taskModels.get(job.ref) } : {}),
      ...(restart ? { restartedAfterStop: restart } : {}),
    };
    if (!turnsHeard(agent)) {
      oneTaskQueue.delivered(job.ref, mode === 'start' ? 'started' : 'typed', deliveredText(agent));
      const body = { ok: true, started: true, outcome: 'delivered', taskId: job.ref, error: deliveredText(agent), ...handed };
      onHanded(body);
      return { status: 200, body };
    }
    onHanded(handed);
    const handedAt = Date.now();
    const latest = handedAt + TURN_START_MAX_MS;
    while (!turnTask) {
      if (gaveUp) return never('the terminal gave it up before it went in');
      if (withdrawn) return never('it was cancelled', 409, { code: 'cancelled' });
      if (agents.get(agent.id) !== agent) return never('its agent was removed');
      if (agent.status === 'stopped') return never('its agent was stopped before its turn began');
      if (Date.now() > latest) {
        // Its CLI never said a turn began (a gemini older than its hooks, or
        // whose hooks were not installed): the `running` Tars set as it typed
        // the task is undone, or every task behind this one waited for a turn
        // that would never end (the Audit's L2 on #478).
        if (agent.status === 'running' && !(Date.parse(agent.lastTurnStartedAt ?? '') >= handedAt)) {
          agent.status = 'idle';
          agent.lastActivity = new Date().toISOString();
          emitAgentStatus(agent.id);
        }
        return never(`its turn did not begin within ${TURN_START_MAX_MS / 60_000} minutes`);
      }
      await sleep(TASK_WAIT_STEP_MS);
    }
    const taskId = turnTask;
    const asked = taskModels.get(taskId);
    try {
      // Followed until the rest that ends it (the ledger reads it, and waits
      // out work left in the background), or until its turn is interrupted.
      let interrupted = false;
      for (;;) {
        const now = ledger?.task(taskId);
        if (!now || now.endedAt !== null || agents.get(agent.id) !== agent) break;
        const cut = lastInterruptAt(agent);
        if (cut !== undefined && cut >= now.startedAt && ledger?.openTaskOf(agent.id)?.id === taskId) {
          interrupted = true;
          // The Esc that cut it left the field as it was: what waits for the agent goes in.
          const terminal = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
          if (terminal) noteTurnCut(terminal);
          ledger.stateChanged({ id: agent.id, status: 'stopped' });
          if (agent.status === 'running') {
            agent.status = 'idle';
            agent.lastActivity = new Date().toISOString();
            saveAgents();
            emitAgentStatus(agent.id);
            announceAgent(agent);
          }
          break;
        }
        await sleep(TASK_WAIT_STEP_MS);
      }
      const ended = ledger?.task(taskId);
      const outcome = ended?.outcome === 'running' || !ended ? 'stopped' : ended.outcome;
      // Or its CLI's own log said the turn was interrupted, which stopped its task (codex: task-watch.ts).
      if (!interrupted && outcome === 'stopped' && ended && (turnInterruptedAt(agent.id) ?? -Infinity) >= ended.startedAt) interrupted = true;
      const stopReason = interrupted ? 'interrupted' : outcome === 'completed' ? 'end_turn' : outcome === 'error' ? 'error' : 'stopped';
      const result = (ended && transcriptRead(agent) ? await readFinalAnswer({ ...ended, configDir: accountFolderOf(ended.accountId) }) : null)
        ?? agent.lastCleanOutput ?? undefined;
      // What it left running in the background: told to its asker, never waited for.
      const backgroundLeft = ended && !interrupted ? pendingBackgroundWork(agent, ended.startedAt) : [];
      if ((outcome === 'error' && agent.error) || backgroundLeft.length) {
        noteRunEnd(taskId, { ...(outcome === 'error' && agent.error ? { error: agent.error } : {}), backgroundLeft });
      }
      ledger?.terminalEnded(taskId, { ...(result ? { result } : {}), stopReason });
      const done = ledger?.task(taskId);
      const usage = done ? await terminalUsage(done) : undefined;
      return {
        status: 200,
        body: {
          ok: outcome === 'completed', started: true, taskId, outcome, stopReason,
          ...(result ? { text: result } : {}), ...(usage ? { usage } : {}),
          ...(backgroundLeft.length ? { backgroundLeft } : {}),
          ...(outcome === 'error' && agent.error ? { error: agent.error } : {}),
          ...(asked ? { model: asked } : {}),
          ...(taskRestarts.get(taskId) ? { restartedAfterStop: taskRestarts.get(taskId) } : {}),
        },
      };
    } finally {
      answering.delete(taskId);
    }
  } finally {
    stopWatching();
  }
}

/**
 * How a message goes in (ORCHESTRATOR-PER-CHAT.md v2.2, 4.4 item 4): `auto`
 * as always (typed at rest, typed into a running turn, held behind a draft),
 * `queue` written only once the turn is over, `steer` the turn interrupted
 * first (claude only), `restart` the agent stopped and started with it.
 */
type SendMode = 'auto' | 'queue' | 'steer' | 'restart';
const SEND_MODES: readonly SendMode[] = ['auto', 'queue', 'steer', 'restart'];

/** The mark before a message from an asker in a narrower mode than the agent (core/permission-ceiling.ts). */
function markFor(agent: AgentStatus, req: RouteRequest): string {
  const callerId = resolveCallerId(req);
  const caller = callerId && callerId !== agent.id ? agents.get(callerId) : undefined;
  return caller ? modeGapMark(levelOf(caller), levelOf(agent)) : '';
}

/** What a route whose work outlives its first answer does with its receipt. */
interface ReceiptHandle {
  /** Kept as the outcome now, before the route answers: a retry meanwhile gets it at once. */
  started(body: Record<string, unknown>): void;
  /** More of the outcome, learnt later. */
  update(more: Record<string, unknown>): void;
}

/**
 * A request sent with a clientRequestId (services/request-receipts.ts): a
 * retry with the same payload is answered with the first outcome and nothing
 * is done again; the same id with another payload is refused. A request
 * without an id is handled as it always was. Called once the caller may
 * drive the agent: the key is who the token names, or `tars` for Tars's own
 * pass. An answer of 300 or more did nothing, and is not kept.
 */
async function withReceipt(
  req: RouteRequest,
  sendJson: SendJson,
  what: { route: string; agentId: string; payload: Record<string, unknown> },
  handle: (send: SendJson, receipt: ReceiptHandle) => Promise<void>,
): Promise<void> {
  const id = clientRequestIdOf((req.body as { clientRequestId?: unknown } | undefined)?.clientRequestId);
  const none: ReceiptHandle = { started: () => undefined, update: () => undefined };
  if (id === null) return handle(sendJson, none);
  if (id === 'invalid') {
    sendJson({ error: 'clientRequestId is 8 to 128 letters, digits, dots, colons, dashes or underscores.', code: 'clientRequestId_invalid' }, 400);
    return;
  }
  const key = { caller: req.internal ? 'tars' : (resolveCallerId(req) ?? 'tars'), id };
  const hash = payloadHash({ route: what.route, target: what.agentId, ...what.payload });
  const store = liveReceipts();
  const again = (outcome: ReceiptOutcome) => sendJson({ ...outcome.body, duplicate: true, clientRequestId: id }, outcome.status);
  for (;;) {
    const begun = store.begin(key, hash);
    if (begun.kind === 'conflict') {
      sendJson({
        error: `clientRequestId ${id} was already used for another request: nothing was sent. Use a new id for a new request.`,
        code: 'clientRequestId_conflict', clientRequestId: id,
      }, 409);
      return;
    }
    if (begun.kind === 'duplicate') { again(begun.outcome); return; }
    if (begun.kind === 'pending') {
      const outcome = await begun.outcome;
      if (outcome) { again(outcome); return; }
      // The first did nothing: this one tries.
      continue;
    }
    let answered: ReceiptOutcome | null = null;
    let settled = false;
    const settle = (outcome: ReceiptOutcome | null) => {
      if (settled) return;
      settled = true;
      begun.settle(outcome);
    };
    const send: SendJson = (data, status = 200) => {
      if (!answered) answered = { status, body: (data ?? {}) as Record<string, unknown> };
      sendJson(status < 300 ? { ...(data as object), clientRequestId: id } : data, status);
    };
    try {
      await handle(send, {
        started: (body) => settle({ status: 200, body }),
        update: (more) => store.update(key, more),
      });
    } finally {
      const final = answered as ReceiptOutcome | null;
      settle(final && final.status < 300 ? final : null);
    }
    return;
  }
}

async function withAgentLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const prior = agentDispatchLocks.get(agentId) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  // Chain for the next caller regardless of outcome; a failed dispatch must
  // not wedge the queue for agents that dispatch to this id afterward.
  agentDispatchLocks.set(agentId, run.catch(() => undefined));
  return run;
}

/**
 * Core of the atomic dispatch: message a live session or spawn a fresh one,
 * decided server-side. Shared by POST /api/agents/:id/dispatch and the Hermes
 * webhook so both entry points get identical semantics.
 *
 * It asks nothing about the caller: each route that reaches it has already
 * decided, /dispatch with assertMayDriveAgent and the webhook by opening to
 * Hermes alone. A third caller decides for itself first.
 */
export interface DispatchOpts {
  message: string;
  model?: string;
  /** For a session it starts: the agent's own mode, or narrower (modeRefusal). */
  permissionMode?: PermissionLevel;
  from?: string;
  sender?: MessageSender;
  /**
   * Run once the agent takes keys, before anything is typed: never for a
   * sender refused 409. Returns the request it queued (core/task-requests.ts),
   * whose id goes in the sender line and which the write delivers.
   */
  onAccepted?: () => string | undefined | void;
  /**
   * The id its asker follows this task by (delegate_task's terminal path):
   * typed on the sender line when no request of onAccepted's carries one, so
   * its turn is told apart. A worker the agent once handed work to queues no
   * request there (requestFor), and its task went in with no id at all (the
   * QA's CLI matrix, H1).
   */
  taskId?: string;
  /**
   * Typed into a live session: once it is written into the terminal, once the
   * terminal gives it up, or once a cancel takes it back before it went in
   * (WriteOrigin).
   */
  onWritten?: () => void;
  onDropped?: () => void;
  onWithdrawn?: () => void;
  /** `queue` mode: written only once the agent's turn is over (WriteOrigin.untilRest). */
  untilRest?: boolean;
  /** Typed after the sender line: its sender runs in a narrower mode (core/permission-ceiling.ts). */
  mark?: string;
  /** A worker's note (core/one-task.ts): typed into a live session only, never a session started for it. */
  noteOnly?: boolean;
  /**
   * Information, not a task: Tars's own word (the kanban's note, the error
   * triage's), a worker's report to whoever leads it. While a run holds the
   * agent or tasks wait their turn, it waits for them (WriteOrigin.untilRest),
   * and it is never queued as a task.
   */
  information?: boolean;
  /** Its turn in the agent's queue taken already: a session may start now. */
  turnTaken?: boolean;
  /**
   * A task, not a message: start_agent and delegate_task's terminal path
   * (`intent: 'task'`), the kanban's hand-off, Hermes's dispatch. Only a task
   * waits its turn in the agent's queue when a live session would take it;
   * any other message keeps its mode, so an answer to a question is never
   * queued behind a task that waits for it (the Audit's H-A on 9d9a7ad9).
   */
  task?: boolean;
}

export async function performDispatch(
  agent: AgentStatus,
  opts: DispatchOpts,
  ctx: RouteContext,
  sendJson: SendJson,
): Promise<void> {
  // The wait is counted from the request, not from the lock: a sender queued
  // behind another is still answered inside the MCP tools' 30 s.
  const until = Date.now() + SENDER_WAIT_MS;
  return withAgentLock(agent.id, () => performDispatchLocked(agent, opts, ctx, sendJson, until));
}

/**
 * The answer to a sender that waited SENDER_WAIT_MS on a launch still on its
 * way: its CLI runs but has not started its session or task, and a message
 * typed now would be lost. Nothing was typed; the caller may try again.
 */
function stillStarting(agent: AgentStatus): Record<string, unknown> {
  return {
    error: `${agent.name || agent.id}'s CLI is still starting (it has not taken keys after ${SENDER_WAIT_MS / 1000} s, `
      + 'as happens on a loaded machine): nothing was typed. Send it again in a moment.',
    starting: true,
    agent: { id: agent.id, name: agent.name, status: agent.status },
  };
}

async function performDispatchLocked(
  agent: AgentStatus,
  opts: DispatchOpts,
  ctx: RouteContext,
  sendJson: SendJson,
  until: number,
): Promise<void> {
  // A launch on its way (a restart, a start from a window) owns the terminal
  // until its CLI runs there: wait for it, then type into its session. Taken
  // for "no session", the message started one over it, without the resume.
  // Still starting when the caller can wait no longer: say so, type nothing.
  if (!(await sessionStarted(agent, until - Date.now()))) {
    sendJson(stillStarting(agent), 409);
    return;
  }
  const taskRef = opts.onAccepted?.() || undefined;

  // BUG 4 guard: kill the PTY if its cwd no longer matches the agent's
  // worktree so the spawn path below restarts it in the right directory.
  killStalePty(agent);

  const previousStatus = agent.status;
  const livePty = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  if (livePty && dialogOpen(agent)) {
    // A blocking permission dialog expects arrow keys/enter, not text: a
    // typed message is useless and the delayed \r could ACCEPT the pending
    // permission. Refuse and surface the reason instead.
    dropped(agent, taskRef);
    sendJson({
      error: `Agent "${agent.name || agent.id}" is blocked on a permission dialog; a typed message cannot answer it. Resolve it in the Tars UI, or stop the agent and re-dispatch.`,
      waitingReason: 'permission',
    }, 409);
    return;
  }
  // Typed into the session only where a CLI runs, read from the terminal and
  // never from the status. Every turn ends on `idle` (the Stop hook posts it)
  // and a failed one on `error`, both with the CLI at its prompt: /dispatch
  // took those for "no session" and started a new claude over it, with no
  // `--resume`, which ended the orchestrator's conversation on 2026-09-23
  // (its last Stop at 02:14:16, a report dispatched at 02:22:24). And
  // `running` or `waiting` over a bare shell, a CLI that died without its
  // SessionEnd, took the message too, and the shell ran it as a command: the
  // Audit typed `echo MARK-SHELL-$((6*7))` and read MARK-SHELL-42. A session
  // still starting counts, through cliRunningIn: its terminal holds the CLI.
  // Elsewhere a session is started with the message as its task.
  // One task at a time (core/one-task.ts): a run over ACP holds the agent, or
  // tasks wait before this one. Typed into its terminal now, a task would be a
  // second copy of the agent at work beside the run: it waits its turn as with
  // no session (the Audit's M1 on #449). A note or information waits for the
  // run's end in the terminal's writer instead, and is no task.
  const behindWork = !opts.turnTaken && oneTaskQueue.mustQueue(agent.id, undefined);
  if (livePty && cliRunningIn(livePty) && behindWork && opts.task) {
    queueDispatch(agent, opts, ctx, sendJson, taskRef, previousStatus);
    return;
  }
  // The agent's queue (2.0.5, lot 2): a message sent to wait for the agent's rest (mode 'queue') waits in its queue
  // with the tasks, where it is seen, paused, moved, cancelled and kept across a stop and a restart of Tars, no longer
  // in the terminal's writer, which a stop emptied. And while the queue is paused, whatever is sent waits there. A
  // worker's note and Tars's own word are information, never a place in the line (the Audit's H-A and M1 on #449):
  // they keep waiting for the rest in the writer, as before.
  const queueable = !opts.turnTaken && !opts.information && !opts.noteOnly;
  if (queueable && (oneTaskQueue.pausedOf(agent.id) || (livePty && cliRunningIn(livePty) && !!opts.untilRest && holdsMessages(agent)))) {
    queueDispatch(agent, opts, ctx, sendJson, taskRef, previousStatus);
    return;
  }
  // Information waits for a run in hand; a task whose turn came waits for nothing.
  const untilRest = !opts.turnTaken && (!!opts.untilRest || (!!opts.information && !!oneTaskQueue.busyRun(agent.id)));
  if (livePty && cliRunningIn(livePty)) {
    // A live session, mid-task or at its prompt: type the message into it.
    // Working once the message is in its terminal, not before: an agent read
    // `running` for hours from the instant a message was held behind its
    // field, and nothing else reached it (bug-held-forever-05-10.md).
    // `onWritten` runs at once for a message that goes straight in.
    let cancelRetell: (() => void) | undefined;
    let handed = false;
    // `isTheWork`: false for a request typed in during another request's
    // turn. It waits behind that work, and moving `workHandedAt` made the turn
    // in hand no longer count as handed work: its end told nobody (QA's gate
    // of #351). Its own turn, when it comes, is after the mark either way.
    const handedOver = (isTheWork = true) => {
      if (handed) return;
      handed = true;
      cancelRetell?.();
      agent.status = 'running';
      agent.waitingReason = undefined;
      if (isTheWork) {
        agent.workHandedAt = new Date().toISOString();
        // This message starts a new piece of work in the same session; the
        // previous task's captured output must not be mistaken for its result.
        agent.lastCleanOutput = undefined;
      }
      agent.lastActivity = new Date().toISOString();
      saveAgents();
      announceAgent(agent);
    };
    const outcome = writeProgrammaticInput(livePty, opts.message, true, {
      agentId: agent.id,
      from: opts.from ?? 'Tars',
      sender: opts.sender ?? { kind: 'tars' },
      // Both: the agent reads working once the message is in (#314), and the
      // caller hears it went in or was given up (#292).
      onWritten: () => { handedOver(delivered(agent, taskRef)); opts.onWritten?.(); },
      onDropped: () => { cancelRetell?.(); givenUp(agent, taskRef); opts.onDropped?.(); },
      // Cancelled before it went in (task-routes.ts): whoever cancelled it tells the asker.
      onWithdrawn: () => { cancelRetell?.(); opts.onWithdrawn?.(); },
      taskRef: taskRef ?? opts.taskId,
      untilRest,
      mark: opts.mark,
    });
    if (outcome === 'refused') {
      dropped(agent, taskRef);
      opts.onDropped?.();
    }
    if (outcome !== 'held' && outcome !== 'refused') handedOver(delivered(agent, taskRef));
    // Waiting for the turn, or the run, it was sent to wait out: nobody's field holds it.
    const waitsForTurn = outcome === 'held' && untilRest && holdsMessages(agent);
    if (outcome === 'held') cancelRetell = (waitsForTurn ? retellBehindWork : retellWhileHeld)(agent, opts.sender, Date.now());
    // `held` is not `written`. The message is queued for that terminal and
    // goes in when the field frees, but answering a caller "sent" while
    // nothing has been typed tells it something it cannot check: the QA
    // measured a 200 with mode `message` and status `running` on a terminal
    // that had received nothing thirty seconds later.
    sendJson({
      success: true, mode: 'message', previousStatus,
      ...(waitsForTurn ? { queued: true } : outcome === 'held' ? { held: true, heldReason: heldReasonFor(agent) } : {}),
      ...(taskRef ? { taskRef } : {}),
      agent: { id: agent.id, name: agent.name, status: agent.status },
    });
    return;
  }

  if (opts.noteOnly) {
    dropped(agent, taskRef);
    sendJson(noteNeedsSession(agent), 409);
    return;
  }
  // One task at a time (core/one-task.ts): a run over ACP holds the agent, or
  // tasks wait before this one. A session started now would be a second copy
  // of the agent at work: the task waits its turn instead, and the caller is
  // told which task it waits behind.
  if (behindWork) {
    queueDispatch(agent, opts, ctx, sendJson, taskRef, previousStatus);
    return;
  }

  // No session: spawn a fresh one with the message as the prompt.
  const since = new Date().toISOString();
  const wokenBy = { by: opts.from ?? 'Tars', via: 'message' as const };
  if (!(await spawnAgentSession(agent, opts.message, { model: opts.model, permissionMode: opts.permissionMode, by: opts.from, wokenBy, taskRef, sender: opts.sender }, ctx, sendJson))) {
    dropped(agent, taskRef);
    return;
  }
  sendJson({ success: true, mode: 'start', previousStatus, ...restartedAfterStop(agent, since), ...(taskRef ? { taskRef } : {}), agent: { id: agent.id, name: agent.name, status: agent.status } });
}

/**
 * A task that waits its turn in the agent's queue (core/one-task.ts), told
 * which task it waits behind, and handed over once it is first and the agent
 * free: typed into its live session, or a session started on it. What became
 * of it is kept under its id for whoever follows it: delivered, or why it
 * never started. Said `starting` for ever, a start_agent that ran read as
 * still queued (the Audit's L3 on #449).
 */
function queueDispatch(agent: AgentStatus, opts: DispatchOpts, ctx: RouteContext, sendJson: SendJson, taskRef: string | undefined, previousStatus: AgentStatus['status']): void {
  const behind = busyText(agent);
  // Under the request's own id, the one its sender line names: task_status and task_cancel find it by that id.
  const queued = oneTaskQueue.enqueue(agent.id, {
    ...(opts.sender?.kind === 'agent' ? { requesterId: opts.sender.id } : {}), title: firstLineOf(opts.message).slice(0, 100),
    how: opts.task ? 'task' : opts.noteOnly ? 'note' : 'message', from: opts.from ?? 'Tars',
    replay: { kind: 'dispatch', ...(taskRef ? { taskRef } : {}), opts: replayableOpts(opts) } satisfies DispatchReplay,
  }, undefined, taskRef && !oneTaskQueue.find(taskRef) ? taskRef : undefined);
  const paused = oneTaskQueue.pausedOf(agent.id);
  sendJson({
    success: true, mode: 'queued', queued: true, queuedBehind: paused ? `its queue, paused: ${paused.why}` : behind, queuedTask: queued.ref, previousStatus,
    ...(paused ? { paused: { since: new Date(paused.since).toISOString(), why: paused.why } } : {}),
    ...(taskRef ? { taskRef } : {}), agent: { id: agent.id, name: agent.name, status: agent.status },
  });
  announceTask(agent.id);
  awaitTurnAndDispatch(agent, opts, ctx, queued.ref, taskRef);
}

/** What a queued dispatch keeps, to be handed over again after a restart of Tars (services/agent-queues.ts). */
interface DispatchReplay {
  kind: 'dispatch';
  taskRef?: string;
  opts: Pick<DispatchOpts, 'message' | 'model' | 'permissionMode' | 'from' | 'sender' | 'mark' | 'noteOnly' | 'information' | 'task' | 'untilRest' | 'taskId'>;
}

function replayableOpts(opts: DispatchOpts): DispatchReplay['opts'] {
  const { message, model, permissionMode, from, sender, mark, noteOnly, information, task, untilRest, taskId } = opts;
  return JSON.parse(JSON.stringify({ message, model, permissionMode, from, sender, mark, noteOnly, information, task, untilRest, taskId })) as DispatchReplay['opts'];
}

/** A request made by Tars for an item it hands over again: its requester's identity, and nothing else. */
function replayRequest(requesterId: string | undefined): RouteRequest {
  return { method: 'POST', pathname: '/replay', url: new URL('http://127.0.0.1/replay'), body: {}, params: {}, callerAgentId: requesterId, internal: !requesterId } as unknown as RouteRequest;
}

let replayContext: RouteContext | undefined;

/**
 * An item of a queue kept across a restart of Tars (services/agent-queues.ts), handed over again as the route that
 * queued it would have: it waits for its turn (its queue is paused until someone resumes it), then goes in.
 */
export function replayQueuedItem(item: QueuedTask): void {
  const ctx = replayContext;
  const agent = agents.get(item.agentId);
  if (!ctx || !agent) {
    oneTaskQueue.cancel(item.ref, agent ? 'Tars could not hand it over again' : 'its agent was removed');
    return;
  }
  const replay = item.replay as DispatchReplay | RunTaskReplay | undefined;
  if (replay?.kind === 'dispatch') {
    // Its sender, as one Tars writes, or Tars's own line (agent-queues.ts keptSender).
    awaitTurnAndDispatch(agent, { ...replay.opts, sender: keptSender(replay.opts.sender) ?? { kind: 'tars' } }, ctx, item.ref, replay.taskRef);
    return;
  }
  if (replay?.kind === 'run-task') {
    void (async () => {
      if (!(await waitTurn(agent, item.ref))) { announceTask(agent.id); return; }
      announceTask(agent.id);
      try {
        await runInTerminal(agent, replayRequest(replay.requesterId), ctx, replayJobOf(item)!, () => undefined);
      } catch (err) {
        console.warn(`[queue] ${item.ref} for ${agent.name || agent.id} did not go in:`, err);
      } finally {
        oneTaskQueue.runEnded(agent.id);
        announceTask(agent.id);
      }
    })();
    return;
  }
  oneTaskQueue.cancel(item.ref, 'Tars could not hand it over again');
}

/** Waits for a queued dispatch's turn, then hands it over, its turn kept until it is in the terminal or given up. */
function awaitTurnAndDispatch(agent: AgentStatus, opts: DispatchOpts, ctx: RouteContext, ref: string, taskRef: string | undefined): void {
  const queued = { ref };
  void waitTurn(agent, queued.ref).then(async (taken) => {
    announceTask(agent.id);
    if (!taken) { dropped(agent, taskRef); return; }
    // The turn stays taken until the task is in its terminal (or given up):
    // ended when performDispatch returned, a task held behind another message
    // read delivered and let the next one in behind it, into the same turn
    // (the Audit's M-A on 9d9a7ad9). The session it went into holds the agent
    // from then on: its turn, in its terminal.
    let settled = false;
    const settle = (how: 'typed' | 'started' | null, why?: string) => {
      if (settled) return;
      settled = true;
      oneTaskQueue.runEnded(agent.id);
      if (how) oneTaskQueue.delivered(queued.ref, how);
      else oneTaskQueue.notStarted(queued.ref, why ?? 'it could not be handed over');
    };
    let answer: { data: { mode?: unknown; error?: unknown; held?: unknown; queued?: unknown }; status: number } | undefined;
    try {
      await performDispatch(agent, {
        ...opts, onAccepted: () => taskRef, turnTaken: true,
        onWritten: () => { settle('typed'); opts.onWritten?.(); },
        onDropped: () => { settle(null, 'its terminal gave it up'); opts.onDropped?.(); },
        // Taken back by its asker while held there: the turn it kept is given
        // back, or every later task waited behind one that no longer exists
        // (the Audit's M-B on 8f4f1fd7).
        onWithdrawn: () => { settle(null, 'it was cancelled'); opts.onWithdrawn?.(); },
      }, ctx, (data, status = 200) => {
        answer ??= { data: (data ?? {}) as { mode?: unknown; error?: unknown; held?: unknown; queued?: unknown }, status };
      });
    } finally {
      const ok = !!answer && answer.status < 300;
      if (ok && answer!.data.mode === 'start') settle('started');
      // Held in its terminal: settled when it is written, given up, or cancelled.
      else if (!(ok && answer!.data.mode === 'message' && (answer!.data.held === true || answer!.data.queued === true))) {
        settle(null, typeof answer?.data.error === 'string' ? answer.data.error : 'its terminal did not take it');
      }
    }
  });
}

/**
 * The agent a message names (the Audit's R5): an id reaches that agent; the
 * words "requester" and "orchestrator", or the orchestrator's name, reach
 * whoever asked the caller for its current task when that is a chat's runner,
 * else the project's orchestrator (core/reply-target.ts). Answers 404 itself
 * when it names nobody. A message sent by those words is answered with where
 * it went, `deliveredTo`.
 */
function messageTarget(req: RouteRequest, sendJson: SendJson): { agent: AgentStatus; reply: SendJson } | undefined {
  const found = replyTargetOf(req.params.id, req.callerAgentId, agents);
  const agent = found ? agents.get(found.agentId) : undefined;
  if (!found || !agent) {
    sendJson({ error: 'Agent not found' }, 404);
    return undefined;
  }
  if (found.how === 'id') return { agent, reply: sendJson };
  const deliveredTo = { id: agent.id, name: agent.name || agent.id, how: found.how };
  return { agent, reply: (data, status) => sendJson(status && status >= 400 ? data : { ...(data as object), deliveredTo }, status) };
}

/**
 * Alt providers re-point the claude binary at another vendor. Without a key
 * there is no ANTHROPIC_BASE_URL and the session would silently run on the
 * user's Anthropic account: refused, at a launch and, since 2.0.2, at a
 * creation through the API, with the same sentence.
 */
function missingKeyRefusal(provider: AgentStatus['provider'], providerEnvVars: Record<string, string>): string | null {
  const isAltProvider = getProvider(provider).binaryName === 'claude' && !!provider && provider !== 'claude' && provider !== 'local';
  return isAltProvider && !providerEnvVars.ANTHROPIC_BASE_URL
    ? `No API key configured for provider "${provider}". Add it (or an OpenRouter key) in Settings > AI Providers.`
    : null;
}

/** A model's name as a command line takes it: what create_agent and update_agent accept. */
const MODEL_NAME = /^[a-zA-Z0-9._:\/\[\]-]+$/;

/** What update_agent changes, as POST /api/agents/:id/update takes it. */
const UPDATE_FIELDS = [
  'name', 'character', 'provider', 'model', 'localModel', 'effort', 'permissionMode', 'cliPath', 'skills', 'secondaryProjectPath',
] as const;
const CHARACTERS: readonly AgentCharacter[] = ['robot', 'ninja', 'wizard', 'astronaut', 'knight', 'pirate', 'alien', 'viking'];
const EFFORTS: readonly AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES: readonly AgentPermissionMode[] = ['plan', 'normal', 'auto', 'bypass'];

/**
 * Who changes an agent's settings over the API (update_agent): Tars's own
 * pass, and an agent with the orchestrator's powers in the agent's project
 * (its orchestrator, or one of its chats' runners, as for handing work). A
 * worker never, not even its own: they are its orchestrator's to change, and
 * the user's. Never across projects, allowCrossProject or not: a change of
 * settings outlives the mistake that sent it, which a message does not. And
 * never an agent with the orchestrator's powers, whoever asks: the
 * orchestrator's settings, which its chats run on, and a runner's, which are
 * the orchestrator's, are the window's, as the role is.
 */
function mayUpdate(req: RouteRequest, agent: AgentStatus, sendJson: SendJson): boolean {
  const driver = resolveDriver(req, sendJson);
  if (!driver) return false;
  if (driver.kind === 'agent' && !hasOrchestratorPowers(driver.agent)) {
    sendJson({
      error: 'A worker does not change an agent\'s settings, its own included: only the user\'s window and your project\'s orchestrator do. '
        + 'Ask your orchestrator for it (send_message to "orchestrator"), saying what to change and why.',
      code: 'worker_may_not_update',
    }, 403);
    return false;
  }
  if (driver.kind === 'agent' && driver.agent.projectPath !== agent.projectPath) {
    sendJson({
      error: `${envelopeValue(agent.name || agent.id)} belongs to project ${agent.projectPath}, and you are the orchestrator of ${driver.agent.projectPath}: `
        + 'an orchestrator changes the agents of its own project only, and allowCrossProject does not change that here. list_agents shows yours.',
      code: 'other_project',
    }, 403);
    return false;
  }
  const withPowers = hasOrchestratorPowers(agent);
  if (withPowers) {
    sendJson({
      error: `${envelopeValue(agent.name || agent.id)} ${agent.kind === 'chat' ? 'runs a chat, on its orchestrator\'s settings' : 'is its project\'s orchestrator, and its chats run on its settings'}: `
        + 'those are changed in the Agents page of Tars, not over the API.',
      code: 'orchestrator_settings',
    }, 403);
    return false;
  }
  return true;
}

/**
 * The update a body asks for, each field checked as POST /api/agents checks a
 * new agent's, or why it is refused. A field it does not take is refused, not
 * dropped: dropped, the answer would say the agent was changed. A new
 * provider clears the model and the CLI path it is not given: they named the
 * old CLI's, and its binary would run for the new one.
 */
function updateFrom(body: unknown, agent: AgentStatus, ctx: RouteContext): { update: Omit<AgentUpdate, 'id'> } | { status: number; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'The body is an object of the settings to change.' };
  const asked = body as Record<string, unknown>;
  const takes = `It takes: ${UPDATE_FIELDS.join(', ')}.`;
  for (const key of Object.keys(asked)) {
    if (key === 'role' || key === 'orchestratorMode') {
      return { status: 403, error: 'An agent\'s role is changed in the Agents page of Tars, not over the API: the user makes an agent the orchestrator, or takes it back.' };
    }
    if (key === 'projectPath') return { status: 403, error: 'An agent moves to another project in the Agents page of Tars, not over the API.' };
    if (key === 'allowCrossProject') continue;
    if (!(UPDATE_FIELDS as readonly string[]).includes(key)) return { status: 400, error: `${JSON.stringify(key)} is not a setting update_agent changes. ${takes}` };
  }
  if (!UPDATE_FIELDS.some(field => asked[field] !== undefined)) return { status: 400, error: `Nothing to change: name a setting. ${takes}` };

  const { name, character, provider, model, localModel, effort, permissionMode, cliPath, skills, secondaryProjectPath } = asked;
  const update: Omit<AgentUpdate, 'id'> = {};
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return { status: 400, error: 'An agent\'s name is a string with at least one character in it.' };
    // As POST /api/agents refuses it (the Audit's gate of #351).
    if (/,\s*task\s+t-/i.test(name)) {
      return { status: 400, error: 'An agent\'s name cannot contain ", task t-": Tars types the task id after the name in the line that says who a message is from.' };
    }
    update.name = name;
  }
  if (character !== undefined) {
    if (!CHARACTERS.includes(character as AgentCharacter)) return { status: 400, error: `Invalid character: ${CHARACTERS.join(', ')}` };
    update.character = character as AgentCharacter;
  }
  if (provider !== undefined) {
    if (typeof provider !== 'string' || !isValidProvider(provider)) {
      return { status: 400, error: `Unknown provider ${JSON.stringify(provider)}. Providers: ${getAllProviders().map((p) => p.id).join(', ')}.` };
    }
    update.provider = provider as AgentProvider;
  }
  if (model !== undefined) {
    if (model !== null && (typeof model !== 'string' || !MODEL_NAME.test(model))) return { status: 400, error: 'Invalid model name' };
    update.model = model;
  }
  if (localModel !== undefined) {
    if (localModel !== null && (typeof localModel !== 'string' || !MODEL_NAME.test(localModel))) return { status: 400, error: 'Invalid local model name' };
    update.localModel = localModel;
  }
  if (effort !== undefined) {
    if (effort !== null && !EFFORTS.includes(effort as AgentEffort)) {
      return { status: 400, error: 'Invalid effort level: low, medium, high, xhigh or max, or null for the CLI\'s own' };
    }
    update.effort = effort as AgentEffort | null;
  }
  if (permissionMode !== undefined) {
    if (!PERMISSION_MODES.includes(permissionMode as AgentPermissionMode)) return { status: 400, error: 'Invalid permission mode: plan, normal, auto or bypass' };
    update.permissionMode = permissionMode as AgentPermissionMode;
  }
  if (cliPath !== undefined) {
    if (cliPath !== null) {
      const why = cliPathProblem(cliPath);
      if (why) return { status: 400, error: why };
    }
    update.cliPath = cliPath as string | null;
  }
  if (skills !== undefined) {
    const wrong = skillsProblem(skills);
    if (wrong) return { status: 400, error: `Not changed: ${wrong}` };
    update.skills = skills as string[];
  }
  if (secondaryProjectPath !== undefined) {
    if (secondaryProjectPath !== null && (typeof secondaryProjectPath !== 'string' || !path.isAbsolute(secondaryProjectPath))) {
      return { status: 400, error: 'secondaryProjectPath is an absolute path, or null to take it away' };
    }
    const handed = secondaryProjectPath === null ? null : handedFolderProblem(secondaryProjectPath);
    if (handed) return { status: 400, error: `Not changed: ${handed}` };
    update.secondaryProjectPath = secondaryProjectPath;
  }
  if (update.provider !== undefined && update.provider !== agent.provider) {
    if (!('model' in update)) update.model = null;
    if (!('cliPath' in update)) update.cliPath = null;
  }
  // Plan on a provider that has none would run as normal (the Audit's Low 2 on #407).
  if (update.provider !== undefined || update.permissionMode !== undefined) {
    const noPlan = planModeRefusal(update.provider ?? agent.provider, update.permissionMode ?? agent.permissionMode);
    if (noPlan) return { status: 400, error: noPlan };
  }
  // Refused as its next launch would be: an API-key provider without its key.
  if (update.provider !== undefined) {
    const keyRefusal = missingKeyRefusal(update.provider, getProvider(update.provider).getPtyEnvVars(agent.id, agent.projectPath, agent.skills, ctx.getAppSettings()));
    if (keyRefusal) return { status: 400, error: keyRefusal };
  }
  return { update };
}

/** What a restart for new settings waits on, as update_agent's answer says it (core/agent-restart.ts). */
const WAIT_TEXT: Record<RestartWait, string> = {
  turn: 'its turn ends',
  permission: 'its permission question is answered and its turn ends',
  note: 'what Tars owes it has been typed in',
  background: 'the work it left running in the background has reported back',
  launch: 'its CLI, starting from its last restart, is up',
  writing: 'the message just typed into it has started',
  queued: 'the messages waiting for its field have gone in',
  draft: 'its field is empty: something is typed in it and not sent',
  typing: 'nobody has typed in it for five seconds',
};

/**
 * When an update applies, and whether the agent goes on in its conversation,
 * as update_agent answers it: `applies` is now, when what it is doing ends
 * (`when-free`, and `waitingFor` says what), or at its next start; `session`
 * is `kept` or `new`. A new CLI, or one Tars cannot restart without cutting a
 * turn, applies at the next start; that start continues the last
 * conversation only on the claude binary, and only on an agent's first start
 * since Tars opened (utils/resume-session.ts), never after a move to another
 * binary.
 */
function whenItApplies(
  agent: AgentStatus,
  how: { cliWasUp: boolean; newCli: boolean; newBinary: boolean; changed: string[]; changedAtLaunch: string[]; restart?: RestartOutcome },
): { applies: 'now' | 'when-free' | 'next-start'; session: 'kept' | 'new'; waitingFor?: RestartWait; text: string } {
  const cli = getProvider(agent.provider);
  const nextStart = (lead: string) => {
    const resumes = !how.newBinary && cli.binaryName === 'claude' && nextStartResumes(agent);
    return {
      applies: 'next-start' as const,
      session: resumes ? 'kept' as const : 'new' as const,
      text: `${lead}, ${resumes ? 'continuing its last conversation' : 'on a new conversation'}${how.newBinary ? ': no CLI continues another one\'s' : ''}.`,
    };
  };
  if (how.newCli) return nextStart(`Its next start runs ${cli.displayName}${agent.cliPath ? ` (${agent.cliPath})` : ''}`);
  if (how.changedAtLaunch.length === 0) {
    // Its name and skills are given to a session when it starts (the identity Tars types, CLAUDE_SKILLS), and are
    // no launch setting: nothing restarts for them, and the session up keeps the old ones (the Audit's L2 on #480).
    const name = how.changed.includes('name');
    const skills = how.changed.includes('skills');
    if (how.cliWasUp && (name || skills)) {
      const old = name && skills ? 'under its old name and skills' : name ? 'under its old name' : 'with its old skills';
      return {
        applies: 'next-start',
        session: 'kept',
        text: `Changed in Tars now. The session in its terminal was given ${name && skills ? 'these' : name ? 'its name' : 'its skills'} when it `
          + `started and goes on ${old}, untouched; its next session starts with the new ${name && !skills ? 'one' : 'ones'}.`,
      };
    }
    return { applies: 'now', session: 'kept', text: 'Changed. Nothing it reads when it starts was changed: its session goes on as it is.' };
  }
  if (!how.cliWasUp) return nextStart('No CLI runs in its terminal: its next start reads the new settings');
  if (cli.binaryName !== 'claude') {
    return {
      applies: 'next-start',
      session: 'new',
      text: `${cli.displayName} reads these when it starts and does not tell Tars when its turns end, so they apply at its next start, `
        + 'on a new conversation: what it is doing now goes on untouched. Stopping it with stop_agent once its work is done applies them sooner.',
    };
  }
  const session = agent.resumableSessionId ? 'kept' as const : 'new' as const;
  const on = session === 'kept' ? 'on the same conversation' : 'on a new conversation: Tars knows no conversation of it to continue';
  if (how.restart?.action === 'restarted') return { applies: 'now', session, text: `Its CLI was restarted on the new settings, ${on}.` };
  if (how.restart?.action === 'waiting') {
    return {
      applies: 'when-free', session, waitingFor: how.restart.for,
      text: `Its CLI restarts on the new settings once ${WAIT_TEXT[how.restart.for]}, ${on}. A running turn is never cut.`,
    };
  }
  // The restart found nothing to do: its CLI runs on these values already, or has just ended.
  if (!cliRunningIn(agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined)) return nextStart('Its CLI has ended: its next start reads the new settings');
  return { applies: 'now', session: 'kept', text: 'Its CLI already runs on these settings: its session goes on as it is.' };
}

export function registerAgentRoutes(app_: RouteApp, ctx: RouteContext): void {
  replayContext = ctx;
  // GET /api/agents/:id/wait: long-poll until agent status changes
  app_.get(/^\/api\/agents\/([^/]+)\/wait$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }

    const timeoutSec = parseInt(req.url.searchParams.get('timeout') || '300', 10);
    const currentStatus = agent.status;

    // Return immediately if already in terminal state
    if (currentStatus === 'completed' || currentStatus === 'error' || currentStatus === 'idle' || currentStatus === 'waiting' || currentStatus === 'stopped' || currentStatus === 'asleep') {
      sendJson({
        status: agent.status,
        // Asleep: a message wakes it on its conversation (core/agent-asleep.ts).
        asleepSince: agent.asleepSince,
        lastCleanOutput: agent.lastCleanOutput,
        error: agent.error,
        waitingReason: agent.waitingReason,
        ...stopOf(agent),
        stalledSince: agent.stalledSince,
      });
      return;
    }

    // Long-poll: wait for status change event
    const agentId = req.params.id;
    let resolved = false;

    // Said out loud, so the delegation note is not typed into the terminal of
    // an orchestrator that is sitting right here waiting for this exact
    // answer. Only while this poll is open, and only about this agent.
    const waiter = resolveCallerId(req);
    const releaseWait = waiter && waiter !== agentId
      ? noteWaitingOn(agentId, waiter)
      : () => {};

    const cleanup = () => {
      clearTimeout(timeout);
      releaseWait();
      ctx.agentStatusEmitter.off(`status:${agentId}`, onStatusChange);
    };

    const respond = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      const a = agents.get(agentId);
      sendJson({
        status: a?.status || 'idle',
        lastCleanOutput: a?.lastCleanOutput,
        error: a?.error,
        waitingReason: a?.waitingReason,
        ...(a ? stopOf(a) : {}),
        stalledSince: a?.stalledSince,
      });
    };

    const onStatusChange = () => respond();
    ctx.agentStatusEmitter.on(`status:${agentId}`, onStatusChange);

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        releaseWait();
        ctx.agentStatusEmitter.off(`status:${agentId}`, onStatusChange);
        const a = agents.get(agentId);
        sendJson({
          status: a?.status || 'running',
          lastCleanOutput: a?.lastCleanOutput,
          timeout: true,
        });
      }
    }, timeoutSec * 1000);

    // Clean up if client disconnects
    req.raw.on('close', () => {
      if (!resolved) {
        resolved = true;
        cleanup();
      }
    });
  });

  // GET /api/agents: scoped to the caller's project by default (?all=true
  // for the global view). An orchestrator that only ever SEES its own team
  // cannot pick another project's agent ID by mistake.
  app_.get('/api/agents', (req, sendJson) => {
    const caller = callerProject(req);
    const showAll = req.url.searchParams.get('all') === 'true';
    // The team: a chat's runner is a conversation with the orchestrator, listed
    // only as the asker of the work it handed out (ORCHESTRATOR-PER-CHAT.md, 4.2).
    let agentValues = Array.from(agents.values()).filter(a => a.kind !== 'chat');
    if (caller && !showAll) {
      agentValues = agentValues.filter(a => a.projectPath === caller);
    }
    const askerOf = (a: AgentStatus) => {
      const asker = a.requestedBy ? agents.get(a.requestedBy.agentId) : undefined;
      return asker ? { id: asker.id, name: asker.name || asker.id, ...(asker.kind === 'chat' ? { chat: true } : {}) } : undefined;
    };
    const agentList = agentValues.map(withSessionTruth).map(a => ({
      id: a.id,
      name: a.name,
      status: a.status,
      projectPath: a.projectPath,
      secondaryProjectPath: a.secondaryProjectPath,
      skills: a.skills,
      currentTask: a.currentTask,
      lastActivity: a.lastActivity,
      character: a.character,
      branchName: a.branchName,
      role: a.role,
      error: a.error,
      askedBy: askerOf(a),
      ...(a.checkpoint ? { checkpoint: a.checkpoint } : {}),
    }));
    sendJson({ agents: agentList, scopedToProject: caller && !showAll ? caller : undefined });
  });

  // GET /api/agents/:id
  app_.get(/^\/api\/agents\/([^/]+)$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }
    const full = req.url.searchParams.get('full') === 'true';
    // Its queue (2.0.5, lot 2): what the caller may see of it, as GET /api/agents/:id/queue answers.
    const caller = req.internal ? { kind: 'tars' as const } : req.callerAgentId && agents.get(req.callerAgentId) ? { kind: 'agent' as const, agent: agents.get(req.callerAgentId)! } : undefined;
    const right = caller ? queueRight(caller, agent, 'list') : undefined;
    const view = right?.ok ? queueView(oneTaskQueue, agent.id, right.all || caller?.kind !== 'agent' ? undefined : caller.agent.id) : undefined;
    // Only when something waits or the queue is paused: an agent with nothing queued reads as it did.
    const queue = view && (view.items.length || view.paused) ? view : undefined;
    sendJson({ agent: { ...(full ? { ...agent, waitingOn: publishedWaitingOn(agent) } : projectAgent(agent)), ...(queue ? { queue } : {}) } });
  });

  // GET /api/agents/:id/bootstrap: identity + team roster context, injected
  // into every fresh claude session by session-start.sh. This is what makes
  // the "who am I / who is my team" handshake automatic instead of a manual
  // ritual at the start of every working session.
  app_.get(/^\/api\/agents\/([^/]+)\/bootstrap$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }

    // The orchestration rules go with the orchestrator's powers (core/agent-role.ts).
    const isOrchestrator = hasOrchestratorPowers(agent);

    // A chat's runner is a conversation with the orchestrator, not a teammate
    // (ORCHESTRATOR-PER-CHAT.md, 4.2): left out of every team listed here.
    const teammates = Array.from(agents.values())
      .filter(a => a.projectPath === agent.projectPath && a.id !== agent.id && a.kind !== 'chat')
      .map(a => `- "${a.name || a.id}" (id: ${a.id}): ${a.role || 'worker'}, status: ${a.status}` +
                (a.branchName ? `, branch: ${a.branchName}` : '') +
                (a.skills?.length ? `, skills: ${a.skills.join(', ')}` : ''));

    const lines = [
      `# Tars agent identity`,
      ``,
      `You are "${agent.name || agent.id}" (agent id: ${agent.id}), ${agent.kind === 'chat' ? 'orchestrator' : agent.role || 'worker'} of project ${agent.projectPath}.`,
    ];
    if (agent.worktreePath) {
      lines.push(`You work in the worktree ${agent.worktreePath}${agent.branchName ? ` (branch ${agent.branchName})` : ''}: stay inside this directory.`);
    }
    // A chat's runner: which chat, and that others may run beside it (core/chat-identity.ts).
    const inChat = chatIdentityOf(agent);
    if (inChat) lines.push(inChat);
    if (agent.savedPrompt) {
      lines.push(``, `## Your role`, agent.savedPrompt);
    }
    lines.push(``, `## Your team (project ${agent.projectPath})`);
    lines.push(teammates.length ? teammates.join('\n') : '(no other agents in this project)');
    if (isOrchestrator) {
      lines.push(
        ``,
        `## Orchestration rules`,
        `- Delegate ONLY to the agents listed above: they are your project's team. Other projects' agents are off-limits and the API rejects cross-project actions.`,
        `- Use delegate_task with the agent id for one-shot delegation; list_agents already returns only your project's agents.`,
        `- No greeting ritual is needed: this roster is current as of session start, and each agent receives its own identity automatically when you delegate.`
      );
    } else {
      lines.push(
        ``,
        `## Working rules`,
        `- You may receive tasks from your project's orchestrator. Work autonomously, never ask for confirmation, and end with a clear report: the orchestrator reads your final message.`,
        `- To write to whoever asked you for your current task, send_message to "requester": one of the project's chats may have asked, not only the orchestrator. An agent's id always reaches that agent.`,
        `- Your turn ending is that report. Wait for the builds and tests you started before you answer: a delegated task ends with your turn, and whoever gave it to you is told it is done, with what you left running in the background, which goes on in your session (~/.tars/CLAUDE.md, "Waiting on work you started").`
      );
    }

    // How Tars works, for this role, and the project's folder (services/agent-guide.ts).
    lines.push(``, agentGuideSection(agent));

    sendJson({ context: lines.join('\n') });
  });

  // GET /api/guide[?topic=]: the tars_guide tool. The guide of the Tars that
  // answers, stamped with its version, with the caller's project folder.
  app_.get('/api/guide', (req, sendJson) => {
    const version = app?.getVersion?.() ?? 'unknown';
    const topic = req.url.searchParams.get('topic');
    if (!topic) {
      sendJson({ text: guideIndex(version) });
      return;
    }
    const project = callerProject(req);
    const folder = project ? ensureProjectFiles(project) : { dir: null, why: 'no agent is named by the token that asked' };
    const text = guideTopic(topic, version, folder.dir, folder.why);
    if (!text) {
      sendJson({ error: `No topic "${topic}" in the guide of Tars ${version}.\n${guideIndex(version)}` }, 404);
      return;
    }
    sendJson({ text });
  });

  // GET /api/agents/:id/health: liveness of the agent's PTY and session,
  // so orchestrators/tools can distinguish "working" from "ghost status".
  app_.get(/^\/api\/agents\/([^/]+)\/health$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }
    const ptyAlive = !!(agent.ptyId && ptyProcesses.has(agent.ptyId));
    const lastActivityMs = Date.parse(agent.lastActivity || '') || 0;
    sendJson({
      id: agent.id,
      status: agent.status,
      waitingReason: agent.waitingReason,
      ptyAlive,
      hasLiveSession: !!agent.currentSessionId,
      secondsSinceActivity: lastActivityMs ? Math.round((Date.now() - lastActivityMs) / 1000) : null,
    });
  });

  // GET /api/agents/:id/output
  app_.get(/^\/api\/agents\/([^/]+)\/output$/, (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }
    const lines = parseInt(req.url.searchParams.get('lines') || '100', 10);
    const output = agent.output.slice(-lines).join('');
    sendJson({ output, status: agent.status });
  });

  // POST /api/agents
  app_.post('/api/agents', (req, sendJson) => {
    // Adding to the fleet is driving it: a caller that is nobody enrolled an
    // agent in any project it named, and that agent is then started, given
    // tasks and billed. Only the MCP calls this route, always as an agent.
    const driver = resolveDriver(req, sendJson);
    if (!driver) return;

    const { projectPath, name, skills = [], character, permissionMode, secondaryProjectPath, provider, model, effort, cliPath } = req.body as {
      projectPath: string;
      name?: string;
      skills?: string[];
      character?: AgentCharacter;
      permissionMode?: AgentStatus['permissionMode'];
      secondaryProjectPath?: string;
      /** The Orchestrator toggle, or its old name: see requestedRole. */
      role?: AgentRole;
      orchestratorMode?: boolean;
      provider?: string;
      model?: string;
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
      cliPath?: string;
    };

    if (!projectPath) {
      sendJson({ error: 'projectPath is required' }, 400);
      return;
    }
    // And held to the line every route that drives an agent holds: an agent
    // adds to its own project, and to another only when it says so. It asked
    // for an identity and nothing more, so any agent enrolled one in any
    // project it named, while SECURITY.md said its own project only. Found by
    // the audit of lot 4; the code was brought to the document, since
    // creating in the wrong project is the mistake this guard exists for.
    if (!mayActIn(req, driver, projectPath, `a new agent would belong to project ${projectPath}`, sendJson)) return;
    // The folder it is handed besides its project: never ~/.tars-private (the Audit's L1 on #480), as update_agent.
    if (secondaryProjectPath !== undefined && secondaryProjectPath !== null && secondaryProjectPath !== '') {
      const handed = typeof secondaryProjectPath === 'string'
        ? handedFolderProblem(secondaryProjectPath)
        : 'secondaryProjectPath is the path of a folder';
      if (handed) {
        sendJson({ error: handed }, 400);
        return;
      }
    }
    if (provider !== undefined && !isValidProvider(provider)) {
      sendJson({ error: `Unknown provider "${provider}". Providers: ${getAllProviders().map((p) => p.id).join(', ')}.` }, 400);
      return;
    }
    if (permissionMode !== undefined && !['plan', 'normal', 'auto', 'bypass'].includes(permissionMode)) {
      sendJson({ error: 'Invalid permission mode: plan, normal, auto or bypass' }, 400);
      return;
    }
    // Plan on a provider that has none would run as normal (the Audit's Low 2 on #407).
    const noPlan = planModeRefusal(provider, permissionMode);
    if (noPlan) {
      sendJson({ error: noPlan }, 400);
      return;
    }
    if (cliPath !== undefined) {
      const why = cliPathProblem(cliPath);
      if (why) {
        sendJson({ error: why }, 400);
        return;
      }
    }
    // Every task the agent is given opens with its skills (gate of #204).
    const skillsWrong = skillsProblem(skills);
    if (skillsWrong) {
      sendJson({ error: `Not created: ${skillsWrong}` }, 400);
      return;
    }
    if (model !== undefined && !MODEL_NAME.test(model)) {
      sendJson({ error: 'Invalid model name' }, 400);
      return;
    }
    if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
      sendJson({ error: 'Invalid effort level' }, 400);
      return;
    }
    let role: AgentRole;
    try {
      role = requestedRole(req.body as { role?: unknown; orchestratorMode?: unknown }) ?? 'worker';
    } catch (err) {
      sendJson({ error: err instanceof Error ? err.message : 'Invalid role' }, 400);
      return;
    }
    // An orchestrator is made in the Agents page and nowhere else. Made here,
    // it took the role from the project's current one and restarted it on the
    // word of whoever held a token, with none of the confirmation JeanBrasse asked
    // for: the QA's gate of #123 measured a worker's own token making itself a
    // "Rogue" orchestrator of its project, and with allowCrossProject, in
    // bypass, of another one. Nothing asks for it legitimately: the MCP's
    // create_agent sends no role. Decided on 2026-09-23, for every caller.
    if (role === 'orchestrator') {
      sendJson({
        error: 'An orchestrator is made in the Agents page of Tars, not over the API. Create the agent as a worker; the user can make it the orchestrator there.',
      }, 403);
      return;
    }

    // The name is typed before the task id in the line that says who a message
    // is from: one that carries a task id would read as Tars's own (the Audit's
    // gate of #351; core/task-requests.ts reads the envelope, this keeps the
    // line plain for whoever reads it).
    if (typeof name === 'string' && /,\s*task\s+t-/i.test(name)) {
      sendJson({ error: 'An agent\'s name cannot contain ", task t-": Tars types the task id after the name in the line that says who a message is from.' }, 400);
      return;
    }

    const id = uuidv4();
    // Refused as its first launch would be: an API-key provider without its key.
    const keyRefusal = missingKeyRefusal(provider as AgentStatus['provider'], getProvider(provider as AgentStatus['provider']).getPtyEnvVars(id, projectPath, skills, ctx.getAppSettings()));
    if (keyRefusal) {
      sendJson({ error: keyRefusal }, 400);
      return;
    }
    const resolvedName = name || `Agent ${id.slice(0, 6)}`;
    const agent: AgentStatus = {
      id,
      status: 'idle',
      projectPath,
      secondaryProjectPath,
      skills,
      output: [],
      lastActivity: new Date().toISOString(),
      character,
      name: resolvedName,
      permissionMode: permissionMode || 'auto',
      provider: provider as AgentStatus['provider'],
      model,
      effort,
      cliPath,
    };
    // The role asked for, never the name; an orchestrator takes the role from
    // its project's current one, whoever creates it (core/agent-role.ts).
    const demoted = assignRole(agent, role, agents.values());
    agents.set(id, agent);
    saveAgents();
    // An orchestrator made here: its project's Main follows it (core/chat-identity.ts).
    orchestratorMoved();
    for (const other of demoted) restartForSettings(other.id, ['orchestrator']);
    announceAgent(agent);
    sendJson({ agent });
  });

  // POST /api/agents/:id/update: an agent's settings, changed by its
  // project's orchestrator (update_agent) through the window's own path
  // (core/agent-update.ts), never ending a CLI at work: a change that needs a
  // new terminal waits for the agent to be stopped (cli_running). The answer
  // says when the change applies and whether the conversation is kept.
  app_.post(/^\/api\/agents\/([^/]+)\/update$/, async (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }
    if (!mayUpdate(req, agent, sendJson)) return;
    // After a start this agent is already in, or before the next: never in the middle of one.
    await withAgentLock(agent.id, async () => {
      const asked = updateFrom(req.body, agent, ctx);
      if ('error' in asked) {
        sendJson({ error: asked.error }, asked.status);
        return;
      }
      const cliWasUp = cliAtWork(agent);
      const binaryBefore = getProvider(agent.provider).binaryName;
      const result = await updateAgent({ id: agent.id, ...asked.update }, { endsNoCli: true });
      if (!result.success) {
        sendJson({ error: result.error, ...(result.code ? { code: result.code } : {}) }, result.code === 'cli_running' ? 409 : 400);
        return;
      }
      const newCli = result.changed.includes('provider') || result.changed.includes('cliPath');
      const newBinary = getProvider(result.agent.provider).binaryName !== binaryBefore;
      if (newBinary) newConversationOnNextStart(agent.id);
      sendJson({
        agent: projectAgent(result.agent),
        changed: result.changed,
        ...whenItApplies(result.agent, { cliWasUp, newCli, newBinary, changed: result.changed, changedAtLaunch: result.changedAtLaunch, restart: result.restart }),
      });
    });
  });

  // POST /api/agents/:id/checkpoint, `{ line }`: the line an agent writes
  // about itself (the MCP tool checkpoint, core/agent-checkpoint.ts). Only the
  // agent itself, by its own token: nobody writes another's line.
  app_.post(/^\/api\/agents\/([^/]+)\/checkpoint$/, (req, sendJson) => {
    const driver = resolveDriver(req, sendJson);
    if (!driver) return;
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }
    if (driver.kind !== 'agent' || driver.agent.id !== agent.id) {
      sendJson({ error: 'An agent writes its own checkpoint, and no other.' }, 403);
      return;
    }
    const line = (req.body as { line?: unknown } | undefined)?.line;
    const problem = checkpointProblem(line);
    if (problem) {
      sendJson({ error: `Not kept: ${problem}.` }, 400);
      return;
    }
    writeCheckpoint(agent, line as string);
    saveAgents();
    scheduleTick();
    sendJson({ checkpoint: agent.checkpoint });
  });

  // POST /api/agents/:id/start
  app_.post(/^\/api\/agents\/([^/]+)\/start$/, async (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }
    if (!assertMayDriveAgent(req, agent, sendJson)) return;
    if (!mayHandWork(req, agent, sendJson)) return;

    const since = new Date().toISOString();
    const { prompt, model, permissionMode: bodyPermissionMode, printMode } = req.body as {
      prompt: string; model?: string; permissionMode?: PermissionLevel; printMode?: boolean;
    };
    if (!prompt) {
      sendJson({ error: 'prompt is required' }, 400);
      return;
    }
    // Never wider than the agent's own, refused before anything is recorded.
    const wider = modeRefusal(agent, bodyPermissionMode);
    if (wider) {
      sendJson({ error: wider.error }, wider.status);
      return;
    }
    const taskRef = requestFor(agent, req);

    const spawned = await withAgentLock(agent.id, async () => {
      // Starting kills the terminal. With a CLI up in it, that is its session:
      // refused, as a start from a window is (agent:start). /dispatch types
      // the task into it instead.
      if (cliRunningIn(agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined)) {
        sendJson({
          error: `A CLI already runs in the terminal of "${agent.name || agent.id}": starting would end its session. Send the task with /dispatch, which types it in.`,
          cliRunning: true,
        }, 409);
        return false;
      }
      // A run over ACP holds it, or tasks wait their turn (core/one-task.ts):
      // a session started now would work beside them. /dispatch queues it.
      if (oneTaskQueue.mustQueue(agent.id, undefined)) {
        sendJson({
          error: `"${agent.name || agent.id}" is working on ${busyText(agent)}: starting it now would open a second session beside that work. Send the task with /dispatch or delegate_task, which wait their turn.`,
          code: 'agent_busy',
        }, 409);
        return false;
      }
      return spawnAgentSession(agent, prompt, { model, permissionMode: bodyPermissionMode, printMode, by: senderName(agent, req), wokenBy: { by: senderName(agent, req), via: 'start' }, taskRef, sender: senderOf(agent, req) }, ctx, sendJson);
    });
    if (!spawned) {
      dropped(agent, taskRef);
      return;
    }

    sendJson({ success: true, ...restartedAfterStop(agent, since), agent: { id: agent.id, status: agent.status } });
  });

  // POST /api/agents/:id/dispatch: atomic "send this task to the agent".
  // Decides message-vs-spawn server-side, under the single-threaded event
  // loop, eliminating the GET-status-then-POST race that MCP tools had when
  // they made that decision client-side on stale status.
  app_.post(/^\/api\/agents\/([^/]+)\/dispatch$/, async (req, sendJsonToCaller) => {
    const target = messageTarget(req, sendJsonToCaller);
    if (!target) return;
    const { agent, reply: sendJson } = target;
    if (!assertMayDriveAgent(req, agent, sendJson)) return;

    const { message: asSent, model, permissionMode, mode: asked, reason, intent } = req.body as {
      message: string; model?: string; permissionMode?: PermissionLevel; mode?: unknown; reason?: unknown; intent?: unknown;
    };
    if (!asSent) {
      sendJson({ error: 'message is required' }, 400);
      return;
    }
    const askedMode = (asked ?? 'auto') as SendMode;
    if (!SEND_MODES.includes(askedMode)) {
      sendJson({ error: `mode is one of ${SEND_MODES.join(', ')}.`, code: 'invalid_mode' }, 400);
      return;
    }
    // Never wider than the agent's own, refused before a receipt, a stop or anything typed.
    const wider = modeRefusal(agent, permissionMode);
    if (wider) {
      sendJson({ error: wider.error }, wider.status);
      return;
    }
    // A worker never orders work (core/one-task.ts): a task (start_agent,
    // delegate_task typed in) or a steer from a worker is refused, and a
    // restart, which stops the agent, is refused as a stop; anything else it
    // sends another worker is a note, labelled so and typed in once that
    // agent's turn is over. Its report to whoever leads it is not.
    if (askedMode === 'restart' ? !mayStop(req, agent, sendJson) : (intent === 'task' || askedMode === 'steer') && !mayHandWork(req, agent, sendJson)) return;
    const noteBy = noteSender(req, agent);
    const message = noteBy ? noteFrom(noteBy.name || noteBy.id, asSent) : asSent;
    const mode: SendMode = noteBy ? 'queue' : askedMode;
    await withReceipt(req, sendJson, {
      route: 'dispatch', agentId: agent.id, payload: { message, model: model ?? null, permissionMode: permissionMode ?? null, mode },
    }, async (sendAny) => {
      const send: SendJson = noteBy ? (data, status) => sendAny(status && status >= 300 ? data : { ...(data as object), note: true }, status) : sendAny;
      const name = agent.name || agent.id;
      const callerId = resolveCallerId(req);
      const asker = callerId && callerId !== agent.id ? callerId : undefined;
      if (mode === 'steer' && !canInterrupt(agent)) {
        send({
          error: `${name}'s CLI cannot be interrupted: steer works on a claude CLI only. Send it with mode 'auto' or 'queue'.`,
          code: 'not_steerable',
        }, 409);
        return;
      }
      // Never across another asker's work: it would cut it (core/task-requests.ts).
      if ((mode === 'steer' && !mayInterrupt(agent, asker)) || (mode === 'restart' && !mayRestart(agent, asker))) {
        // Another chat's work, by its name: no chat cuts another's (ORCHESTRATOR-PER-CHAT.md 4.3, M1).
        const otherChat = chatOfAsker(cutWorkOf(agent, asker, mode));
        send(otherChat ? {
          error: `${name} is working on, or holds, a task from the chat ${envelopeValue(otherChat.title)} (#${otherChat.number}): a ${mode} would cut it, and no chat cuts another's work. Send it with mode 'queue', or tell the user.`,
          code: 'worker_busy_for_other_chat',
          chat: { title: otherChat.title, number: otherChat.number },
        } : {
          error: `${name} is working on, or holds, a task another agent asked for: a ${mode} would cut it. Send it with mode 'queue', or ask that agent.`,
          code: 'worker_busy_for_other_requester',
        }, 409);
        return;
      }
      const by = senderName(agent, req);
      if (mode === 'restart' && agent.status !== 'stopped') {
        await stopAgent(agent, { by, reason: stopReasonOf(reason) ?? `restarted by ${by} with a new message` }, { save: saveAgents, announce: announceAgent });
      }
      // Steer: an Esc into the turn, and the message once its interrupt is on
      // record. Not on record in time: it waits for the turn's end instead.
      let interrupted: boolean | undefined;
      const pty = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
      if (mode === 'steer' && agent.status === 'running' && pty && cliRunningIn(pty) && !dialogShown(agent, pty)) {
        interrupted = await interruptTurn(agent, pty);
      }
      await performDispatch(agent, {
        message, model, permissionMode, from: by, sender: senderOf(agent, req), mark: markFor(agent, req),
        untilRest: mode === 'queue' || interrupted === false,
        noteOnly: !!noteBy,
        task: intent === 'task' && !noteBy,
        // A report to whoever leads the worker waits for that agent's run, as a note does: it is no task.
        information: !noteBy && !!reportSender(req, agent),
        // After the wait: a sender refused 409 typed nothing and takes no link.
        // A note hands nothing over: nobody's request.
        onAccepted: () => (noteBy ? undefined : requestFor(agent, req, message)),
      }, ctx, interrupted === undefined ? send : (data, status) => send(status && status >= 300 ? data : { ...(data as object), interrupted }, status));
    });
  });

  /**
   * POST /api/agents/:id/run-task
   *
   * Delegation (delegate_task, start_agent): the task goes into the agent's
   * own permanent terminal, the session its card shows, which keeps its
   * conversation, its memory and its background work; with no CLI up, that
   * session is started (resuming its conversation) with the task (2.0.4, the
   * maintainer's decision of 2026-10-18). No run over ACP is opened. One task
   * at a time (core/one-task.ts): an agent at work, or with tasks queued, gets
   * this one queued. Every task has its id (`t-` and 8 hex) from the start,
   * followed by GET /api/tasks/:id to its end, read from the session itself:
   * the final answer from the transcript, what the turn used, why it ended.
   */
  app_.post(/^\/api\/agents\/([^/]+)\/run-task$/, async (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }
    if (!assertMayDriveAgent(req, agent, sendJson)) return;
    if (!mayHandWork(req, agent, sendJson)) return;

    const { task, model, answer } = req.body as { task?: string; model?: unknown; answer?: unknown };
    if (!task?.trim()) {
      sendJson({ error: 'task is required' }, 400);
      return;
    }
    // A model for this task only: the agent's saved one is not changed.
    if (model !== undefined && (typeof model !== 'string' || !RUN_MODEL.test(model))) {
      sendJson({ error: 'model is 1 to 100 letters, digits, dots, colons, dashes, slashes, underscores or brackets.', code: 'invalid_model' }, 400);
      return;
    }
    // `answer: 'started'`: answered at once with the task's id, and the task
    // followed by it (GET /api/tasks/:id?wait=). Held to the task's end, the
    // request outlived undici's 300 s on any long task.
    const answerAtStart = answer === 'started';

    await withReceipt(req, sendJson, { route: 'run-task', agentId: agent.id, payload: { task, ...(model ? { model } : {}) } }, async (sendJson, receipt) => {
      const callerId = resolveCallerId(req);
      const requester = callerId && callerId !== agent.id ? callerId : undefined;
      // One task at a time: the agent works (a task in hand, a turn in its
      // terminal), or tasks wait before this one. Queued or not, it has its
      // id from now, and takes its turn below.
      const waits = oneTaskQueue.mustQueue(agent.id, terminalTurn(agent));
      const behind = waits ? busyText(agent) : undefined;
      const queued = oneTaskQueue.enqueue(agent.id, {
        ...(requester ? { requesterId: requester } : {}), title: firstLineOf(task), how: 'task', from: senderName(agent, req),
        replay: {
          kind: 'run-task', task, ...(typeof model === 'string' ? { model } : {}), ...(requester ? { requesterId: requester } : {}),
          from: senderName(agent, req), sender: senderOf(agent, req), ...(markFor(agent, req) ? { mark: markFor(agent, req) } : {}),
        } satisfies RunTaskReplay,
      });
      const startBody = {
        ok: true, started: false, queued: waits, outcome: waits ? 'queued' : 'starting', taskId: queued.ref,
        ...(waits ? { queuedBehind: behind, queuedAt: new Date(queued.queuedAt).toISOString() } : {}),
      };
      receipt.started(startBody);
      let answered = false;
      // Queued, it is answered now; taken at once, once it is in the
      // terminal (a few seconds at most), with what its start said.
      const answerNow = (more: Record<string, unknown> = {}) => {
        if (!answerAtStart || answered) return;
        answered = true;
        sendJson({ ...startBody, ...more }, 200);
      };
      if (waits) answerNow();
      announceTask(agent.id);
      if (!(await waitTurn(agent, queued.ref))) {
        announceTask(agent.id);
        if (!answered) sendJson({ error: `Task ${queued.ref} was cancelled while it waited${behind ? ` behind ${behind}` : ''}: it never started.`, code: 'cancelled', taskId: queued.ref }, 409);
        return;
      }
      announceTask(agent.id);
      try {
        const end = await runInTerminal(agent, req, ctx, { task, ref: queued.ref, ...(typeof model === 'string' ? { model } : {}) }, answerNow);
        receipt.update({ outcome: end.body.outcome, ok: end.body.ok, ...(end.body.taskId ? { taskId: end.body.taskId } : {}) });
        if (!answered) sendJson(end.body, end.status);
      } finally {
        oneTaskQueue.runEnded(agent.id);
        announceTask(agent.id);
      }
    });
  });

  /**
   * GET /api/tasks/:id, GET /api/tasks?clientRequestId=...
   *
   * A delegated task, by the id it was given (queued, starting, then the
   * ledger's task) or the ledger's own id, its answer included, read after a
   * relaunch as well as before (4.4 item 3): by its asker, by the agent that
   * ran it, or by Tars. Anybody else is answered as if it did not exist. By
   * clientRequestId: the caller's own receipt names the task.
   */
  app_.get(/^\/api\/tasks(?:\/([^/]+))?$/, async (req, sendJson) => {
    const driver = resolveDriver(req, sendJson);
    if (!driver) return;
    const callerId = driver.kind === 'agent' ? driver.agent.id : undefined;
    let id = req.params.id;
    if (!id) {
      const requestId = clientRequestIdOf(req.url.searchParams.get('clientRequestId') ?? undefined);
      if (!requestId || requestId === 'invalid') {
        sendJson({ error: 'A task id, or a clientRequestId, is required.' }, 400);
        return;
      }
      const taskId = liveReceipts().find({ caller: callerId ?? 'tars', id: requestId })?.outcome.body.taskId;
      id = typeof taskId === 'string' ? taskId : '';
    }
    // `?wait=<s>`: held until the task ends, for one segment at most (120 s,
    // well under undici's 300 s), and answered `timeout: true` if it has not.
    const waitS = Math.min(Math.max(Number(req.url.searchParams.get('wait')) || 0, 0), TASK_WAIT_MAX_S);
    const until = Date.now() + waitS * 1000;
    let queued = id ? oneTaskQueue.lookup(id) : undefined;
    if (queued && callerId && callerId !== queued.task.requesterId && callerId !== queued.task.agentId) queued = undefined;
    // Its asker waits on it here: its end is this answer, and is not typed
    // into the asker's terminal as well (agent-watch.ts, isWaitingOn).
    const followed = queued && waitS > 0 && callerId && callerId === queued.task.requesterId ? followTask(queued.task.agentId, callerId) : undefined;
    try {
      while (queued && (queued.state === 'queued' || queued.state === 'starting') && Date.now() < until) {
        await new Promise((r) => setTimeout(r, TASK_WAIT_STEP_MS));
        queued = oneTaskQueue.lookup(id) ?? { state: 'failed', task: queued.task, error: 'cancelled before it started' };
      }
      const model = taskModels.get(queued?.task.ref ?? id);
      if (queued && queued.state !== 'started') {
        const { task: q } = queued;
        sendJson({
          ...((queued.state === 'queued' || queued.state === 'starting') && waitS > 0 ? { timeout: true } : {}),
          task: {
            id: q.ref, agentId: q.agentId, requesterAgentId: q.requesterId ?? null, source: queued.state === 'delivered' ? 'terminal' : q.requesterId ? 'agent' : 'tars', startedAt: null, endedAt: null,
            queuedAt: new Date(q.queuedAt).toISOString(),
            ...(model ? { model } : {}),
            ...(queued.state === 'failed'
              ? { outcome: 'error', error: `It never started: ${queued.error}.` }
              : queued.state === 'delivered'
                ? { outcome: 'delivered', how: queued.how, deliveredAt: new Date(queued.at).toISOString(), ...(queued.note ? { error: queued.note } : {}) }
                : { outcome: queued.state, ...(queued.state === 'queued' ? { queuedBehind: busyText(agents.get(q.agentId) ?? ({ id: q.agentId } as AgentStatus), q.ref) } : {}) }),
          },
        });
        return;
      }
      let found = id ? liveTaskLedger()?.task(queued?.state === 'started' ? queued.taskId : id) : undefined;
      if (!found || (callerId && callerId !== found.requesterAgentId && callerId !== found.agentId)) {
        // An id of the queue's shape: a task that waited its turn in another run of Tars.
        sendJson({ error: /^t-[0-9a-f]{8}$/.test(id) ? unknownTaskText(oneTaskQueue.since) : 'No such task.' }, 404);
        return;
      }
      // Its end is the rest that ended it and the answer read after it: both.
      const open = (t: TaskWithResult) => t.outcome === 'running' || answering.has(t.id);
      let timedOut = false;
      if (waitS > 0 && open(found)) {
        while (found && open(found) && Date.now() < until) {
          await new Promise((r) => setTimeout(r, TASK_WAIT_STEP_MS));
          found = liveTaskLedger()?.task(found.id) ?? found;
        }
        timedOut = open(found);
      }
      const end = runEnds.get(found.id);
      // What the turn used and cost, read from the session (transcripts, the
      // state mod's turns) once it ended; a run over ACP reported its own.
      const usage = found.acp ?? (found.outcome !== 'running' && !answering.has(found.id) ? await terminalUsage(found) : undefined);
      // The line the agent last wrote about itself, while this task runs (core/agent-checkpoint.ts).
      const checkpoint = checkpointOfTask(agents.get(found.agentId), found);
      sendJson({
        ...(timedOut ? { timeout: true } : {}),
        task: {
          ...(end ?? {}),
          id: found.id, agentId: found.agentId, requesterAgentId: found.requesterAgentId, source: found.source,
          outcome: found.outcome, startedAt: found.startedAt, endedAt: found.endedAt,
          ...(found.stopReason ? { stopReason: found.stopReason } : {}),
          ...(found.result !== undefined ? { result: found.result } : {}),
          ...(usage ? { usage } : {}),
          ...((model ?? taskModels.get(found.id)) ? { model: model ?? taskModels.get(found.id) } : {}),
          ...(taskRestarts.get(found.id) ? { restartedAfterStop: taskRestarts.get(found.id) } : {}),
          ...(checkpoint ? { checkpoint } : {}),
        },
      });
    } finally {
      followed?.();
    }
  });

  // POST /api/agents/:id/stop: with a reason, filed under the caller
  // (core/agent-stop.ts). stop_agent gave none, and nobody could tell
  // afterwards why an agent was down.
  app_.post(/^\/api\/agents\/([^/]+)\/stop$/, async (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }

    const driver = resolveDriver(req, sendJson);
    if (!driver) return;
    if (!mayActIn(req, driver, agent.projectPath, `agent "${agent.name || agent.id}" belongs to project ${agent.projectPath}`, sendJson)) return;
    if (!mayStop(req, agent, sendJson)) return;
    const reason = stopReasonOf((req.body as { reason?: unknown } | undefined)?.reason);
    if (!reason) {
      sendJson({ error: 'A reason is required: say in one line why this agent is stopped. It is kept with the agent and shown in the window.' }, 400);
      return;
    }

    const by = driver.kind === 'tars' ? 'Tars' : (driver.agent.name || driver.agent.id);
    const dropQueue = (req.body as { dropQueue?: unknown } | undefined)?.dropQueue === true;
    const queue = { kept: 0, dropped: 0 };
    const stoppedNow = await stopAgent(agent, { by, reason }, { save: saveAgents, announce: announceAgent }, { dropQueue, outcome: queue });
    announceTask(agent.id);
    sendJson({
      success: true, ...(stoppedNow ? {} : { alreadyStopped: true }), ...stopOf(agent),
      // Its queue (2.0.5): kept, paused, or dropped when asked.
      ...(stoppedNow ? { queueKept: queue.kept, queueDropped: queue.dropped } : {}),
    });
  });

  // POST /api/agents/:id/message
  app_.post(/^\/api\/agents\/([^/]+)\/message$/, async (req, sendJsonToCaller) => {
    const target = messageTarget(req, sendJsonToCaller);
    if (!target) return;
    const { agent, reply: sendJson } = target;
    if (!assertMayDriveAgent(req, agent, sendJson)) return;

    const { message: asSent, mode } = req.body as { message: string; mode?: unknown };
    if (!asSent) {
      sendJson({ error: 'message is required' }, 400);
      return;
    }
    // As /dispatch: what a worker sends another worker is a note (core/one-task.ts).
    const noteBy = noteSender(req, agent);
    const message = noteBy ? noteFrom(noteBy.name || noteBy.id, asSent) : asSent;
    // An alias of /dispatch's `auto` for this version (4.4 item 4).
    if (mode !== undefined && mode !== 'auto') {
      sendJson({ error: "/message sends in mode 'auto' only: send other modes through /dispatch.", code: 'invalid_mode' }, 400);
      return;
    }
    const until = Date.now() + SENDER_WAIT_MS;
    await withReceipt(req, sendJson, { route: 'message', agentId: agent.id, payload: { message } }, (sendJson) => withAgentLock(agent.id, async () => {
      // As /dispatch: a launch on its way is waited for, never spawned over,
      // and never typed into before it takes keys, counted from the request.
      if (!(await sessionStarted(agent, until - Date.now()))) {
        sendJson(stillStarting(agent), 409);
        return;
      }
      // BUG 4 guard: if the agent's worktreePath changed after the PTY was
      // spawned, the existing PTY is stuck in the wrong cwd. Kill it so the
      // reconnect path below spawns fresh with the correct working directory.
      killStalePty(agent);

      if (agent.ptyId && ptyProcesses.has(agent.ptyId) &&
          dialogOpen(agent)) {
        // Same guard as /dispatch: never type into a blocking permission dialog.
        sendJson({
          error: `Agent "${agent.name || agent.id}" is blocked on a permission dialog; a typed message cannot answer it. Resolve it in the Tars UI, or stop the agent and re-dispatch.`,
          waitingReason: 'permission',
        }, 409);
        return;
      }
      const noCli = !cliRunningIn(agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined);
      if (noCli && noteBy) {
        sendJson(noteNeedsSession(agent), 409);
        return;
      }
      // A session started now, or a task typed into the live one, would work
      // beside a run, or before tasks queued (core/one-task.ts, the Audit's M1
      // on #449). A note or a report waits for the run's end instead.
      const report = !noteBy && !!reportSender(req, agent);
      const behindWork = oneTaskQueue.mustQueue(agent.id, undefined);
      // Typed beside a run, a message is a second copy of the agent at work; the tasks in line may wait for this very message (an answer to a question), so they hold nothing here (the Audit's H-A on 9d9a7ad9).
      const runHolds = !!oneTaskQueue.busyRun(agent.id);
      if ((noCli && behindWork) || (!noCli && runHolds && !noteBy && !report)) {
        sendJson({
          error: `"${agent.name || agent.id}" is working on ${busyText(agent)}: nothing was sent. Send it with /dispatch, which waits its turn.`,
          code: 'agent_busy',
        }, 409);
        return;
      }
      // Queued once nothing can refuse it any more (core/task-requests.ts). A note hands nothing over.
      const taskRef = noteBy ? undefined : requestFor(agent, req, message);

      if (noCli) {
        // No session: the claude process exited (e.g. crashed while 'waiting'),
        // or the terminal is a shell with no CLI, where a typed message would be
        // run as a command whatever the status says (see performDispatchLocked).
        // Auto-respawn: start a fresh one-shot claude session
        // using the message as the prompt, identical to the /start path. This
        // ensures send_message and delegate_task reconnect transparently
        // instead of timing out.
        const since = new Date().toISOString();
        if (!(await spawnAgentSession(agent, message, { by: senderName(agent, req), wokenBy: { by: senderName(agent, req), via: 'message' }, taskRef, sender: senderOf(agent, req) }, ctx, sendJson))) {
          dropped(agent, taskRef);
          return;
        }
        sendJson({ success: true, ...restartedAfterStop(agent, since) });
        return;
      }

      const ptyProcess = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
      if (ptyProcess) {
        // Working once it is in, as /dispatch (bug-held-forever-05-10.md).
        let cancelRetell: (() => void) | undefined;
        let handed = false;
        // As /dispatch: a request waiting behind another's turn does not move the mark.
        const handedOver = (isTheWork = true) => {
          if (handed) return;
          handed = true;
          cancelRetell?.();
          agent.status = 'running';
          agent.waitingReason = undefined;
          if (isTheWork) agent.workHandedAt = new Date().toISOString();
          agent.lastActivity = new Date().toISOString();
          saveAgents();
          announceAgent(agent);
        };
        const sender = senderOf(agent, req);
        const outcome = writeProgrammaticInput(ptyProcess, message, true, {
          agentId: agent.id,
          from: senderName(agent, req),
          sender,
          onWritten: () => handedOver(delivered(agent, taskRef)),
          onDropped: () => { cancelRetell?.(); givenUp(agent, taskRef); },
          onWithdrawn: () => cancelRetell?.(),
          taskRef,
          mark: markFor(agent, req),
          // A note waits for the turn's end, as /dispatch's `queue`; a note or a report, for a run's.
          untilRest: !!noteBy || runHolds,
        });
        if (outcome === 'refused') dropped(agent, taskRef);
        if (outcome !== 'held' && outcome !== 'refused') handedOver(delivered(agent, taskRef));
        const waitsForTurn = outcome === 'held' && (!!noteBy || runHolds) && holdsMessages(agent);
        if (outcome === 'held') cancelRetell = (waitsForTurn ? retellBehindWork : retellWhileHeld)(agent, sender, Date.now());
        sendJson({
          success: true,
          ...(waitsForTurn ? { queued: true } : outcome === 'held' ? { held: true, heldReason: heldReasonFor(agent) } : {}),
          ...(noteBy ? { note: true } : {}), ...(taskRef ? { taskRef } : {}),
        });
        return;
      }
      sendJson({ error: 'Failed to send message - PTY not available' }, 500);
    }));
  });

  // DELETE /api/agents/:id
  app_.delete(/^\/api\/agents\/([^/]+)$/, async (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }

    if (!assertMayDriveAgent(req, agent, sendJson)) return;
    if (!mayStop(req, agent, sendJson)) return;
    // The window's removal, the one path (core/agent-remove.ts): its runs and questions ended, its terminal's whole
    // tree ended as a stop ends it, its uncommitted work saved, its worktree removed or kept with why, its requesters
    // told (the Audit's L4 on #523: this route sent the hangup alone, and a deaf CLI outlived the agent).
    const removed = await removeAgent(agent.id);
    // Gone from the next tick, and the rail reloads a fleet without it.
    announceAgent(agent);
    sendJson(removed);
  });
}
