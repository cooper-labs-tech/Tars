import * as path from 'path';
import { stopAcpRuns } from '../acp/delegate';
import { publishedWaitingOn } from '../../utils/waiting-on';
import * as fs from 'fs';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { agents, saveAgents, killStalePty, ensureProjectTrusted, appendAgentOutput, armTaskStartWatch } from '../../core/agent-manager';
import { ptyProcesses, writeProgrammaticInput, type MessageSender } from '../../core/pty-manager';
import { spawnAgentPty, cliRunningIn } from '../../core/agent-pty';
import { agentStatusOnExit, isQuitting } from '../../core/quit-state';
import { clearStop, stopAgent, stopReasonOf } from '../../core/agent-stop';
import { noteWaker, wakeFromSleep } from '../../core/agent-asleep';
import type { AgentWakeVia } from '../../types';
import { sessionStarted, SENDER_WAIT_MS, launchBegins, launchAbandoned, dialogOpen, dialogShown } from '../../core/agent-launch';
import { getProvider, isValidProvider } from '../../providers';
import { skillsProblem } from '../../utils/skill-name';
import { buildFullPath } from '../../utils/path-builder';
import { cliPathDirs } from '../../utils/cli-path-dirs';
import { AgentStatus, AgentCharacter, AgentRole } from '../../types';
import { RouteApp, RouteContext, RouteRequest, SendJson } from './types';
import { getSuperAgentInstructionsPath, isSuperAgent } from '../../utils';
import { assembleDigest, needsPromptInjection, wrapDigestForPrompt } from '../memory-hub';
import { canDelegateOverAcp, delegateOverAcp } from '../acp/delegate';
import { usableHermesConnection } from '../hermes-config';
import { consumeResumeSessionId } from '../../utils/resume-session';
import { getTasmaniaStatus } from '../tasmania-client';
import { emitAgentStatus } from '../agent-events';
import { broadcastToAllWindows } from '../../utils/broadcast';
import { scheduleTick } from '../../utils/agents-tick';
import { noteWaitingOn } from '../agent-watch';
import { withSessionTruth } from '../agent-truth';
import { noteLaunch, launchSettings, restartForSettings, forgetRestart } from '../../core/agent-restart';
import { assignRole, requestedRole } from '../../core/agent-role';
import { callerId as resolveCallerId, callerProject } from './utils';
import { envelopeValue } from '../../utils/envelope-value';

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
  permissionMode?: 'normal' | 'auto' | 'bypass';
  printMode?: boolean;
  /** Who this session wakes the agent for, and how, should it be asleep (core/agent-asleep.ts). */
  wokenBy?: { by: string; via: AgentWakeVia };
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
function stopOf(agent: AgentStatus): { stoppedBy?: string; stoppedAt?: string; stopReason?: string } {
  return agent.status === 'stopped'
    ? { stoppedBy: agent.stoppedBy, stoppedAt: agent.stoppedAt, stopReason: agent.stopReason }
    : {};
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

async function spawnAgentSession(
  agent: AgentStatus,
  prompt: string,
  opts: SpawnOpts,
  ctx: RouteContext,
  sendJson: SendJson
): Promise<boolean> {
  // A session started while the quit ends the others would be in no map the
  // quit ends: refused before anything here ends the old terminal (the Audit's
  // gate of #235: a /start 200 ms into the quit answered 200 and its CLI
  // outlived Tars). spawnAgentPty refuses too, for the callers that are not here.
  if (isQuitting()) {
    sendJson({ error: 'Tars is quitting: no new session is started.', quitting: true }, 503);
    return false;
  }
  // Raw cwd for pty.spawn, shell-escaped form for the `cd` command. These
  // must be separate: passing the shell-escaped form to pty.spawn would
  // break when the path legitimately contains a single quote.
  const rawWorkingDir = agent.worktreePath || agent.projectPath;
  const workingDir = rawWorkingDir.replace(/'/g, "'\\''");

  // Resolve provider and binary: honours the per-agent CLI override, custom
  // CLI paths in Settings, and the agent's provider (claude / codex / gemini /
  // grok / openrouter / deepseek / moonshot / etc.).
  const appSettings = ctx.getAppSettings();
  const cliProvider = getProvider(agent.provider);
  const binaryPath = agent.cliPath || cliProvider.resolveBinaryPath(appSettings);

  const usePrintMode = opts.printMode;

  // Its project's orchestrator: the toggle, never the name (core/agent-role.ts).
  const isSuperAgentApi = isSuperAgent(agent);

  // Provider env vars: CLAUDE_* tracking vars + ANTHROPIC_BASE_URL /
  // ANTHROPIC_API_KEY for alt providers (OpenRouter, DeepSeek, Moonshot...).
  const providerEnvVars = cliProvider.getPtyEnvVars(agent.id, agent.projectPath, agent.skills || [], appSettings);

  // Alt providers re-point the claude binary at another vendor. Without a key
  // there is no ANTHROPIC_BASE_URL and the session would silently run on the
  // user's Anthropic account. Refuse instead.
  const isAltProvider = cliProvider.binaryName === 'claude' &&
                        !!agent.provider && agent.provider !== 'claude' && agent.provider !== 'local';
  if (isAltProvider && !providerEnvVars.ANTHROPIC_BASE_URL) {
    sendJson({
      error: `No API key configured for provider "${agent.provider}". Add it (or an OpenRouter key) in Settings > AI Providers.`,
    }, 400);
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
    `${agent.role || 'worker'} of project ${agent.projectPath}` +
    (agent.worktreePath
      ? `, working in worktree ${agent.worktreePath}${agent.branchName ? ` (branch ${agent.branchName})` : ''}: stay inside this directory`
      : '') +
    `. Work autonomously without asking for confirmation and end with a clear report of your results` +
    (isSuperAgentApi ? '' : ': an orchestrator reads your final message') +
    `.]`;

  // MCP config for flag-strategy providers (all claude-based ones).
  let mcpConfigPath: string | undefined;
  if (cliProvider.getMcpConfigStrategy() === 'flag') {
    // os.homedir(), which follows HOME, and never Electron's home path, which
    // on macOS does not: a sandboxed Tars handed its agents the real one.
    const candidate = path.join(os.homedir(), '.claude', 'mcp.json');
    if (fs.existsSync(candidate)) mcpConfigPath = candidate;
  }

  // An explicit model on this call wins, otherwise the model the agent is set
  // to. Not the model its last session answered on: that is the session this
  // spawn replaces, and preferring it put every agent moved to a new model in
  // the Agents page back on the old one. A `/model` typed into a terminal
  // lasts for that session; the Agents page is where a model is kept.
  const resolvedModel = opts.model || agent.model;
  const effectiveMode = opts.permissionMode ?? agent.permissionMode ?? (agent.skipPermissions ? 'auto' : 'normal');


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
  const taskPrompt = `${identityHeader}${memoryBlock}\n\n${prompt}`;

  // Build the CLI command through the provider so non-claude CLIs (codex,
  // gemini, grok, opencode, pi) get their own syntax instead of claude flags.
  let cliCommand: string;
  try {
    cliCommand = cliProvider.buildInteractiveCommand({
      resumeSessionId: consumeResumeSessionId(agent) ?? undefined,
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

  // `exec`: the shell hands its terminal to the CLI instead of waiting on it.
  // Without it the CLI ran inside the shell's process group and the terminal
  // named `bash` for the CLI's whole life, so everything that reads what runs
  // there (cliRunningIn, in core/agent-pty.ts) took a live session for a bare
  // shell. The provider builds one simple command, the quoted binary and its
  // arguments, which is what exec needs; a test holds every provider to it.
  const command = `cd '${workingDir}' && exec ${cliCommand}`;

  const shell = '/bin/bash';
  // Include user-configured CLI dirs so non-claude binaries resolve too.
  const fullPath = buildFullPath(cliPathDirs(appSettings.cliPaths as unknown as Record<string, unknown> | undefined));

  // Kill any existing PTY for this agent before spawning a new one.
  // Agents started via the API use one-shot PTYs that stay alive (the claude
  // process waits at a prompt after each task). Without this, every dispatch
  // orphans the previous PTY+claude process, eventually exhausting resources.
  if (agent.ptyId) {
    const existingPty = ptyProcesses.get(agent.ptyId);
    if (existingPty) {
      existingPty.kill();
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
  // Whatever it resumes, this session is not a fork waiting on its first turn.
  agent.forkedFromSessionId = undefined;

  // BUG 6: pre-accept Claude Code's workspace trust dialog for this cwd.
  ensureProjectTrusted(rawWorkingDir);

  // Assemble the environment. Identity vars are re-asserted explicitly
  // (MCP project scoping and the hooks depend on them), and provider-specified
  // vars (e.g. CLAUDECODE) are purged so nested sessions don't inherit them.
  const spawnEnv: Record<string, string | undefined> = {
    ...process.env,
    PATH: fullPath,
    TERM: 'xterm-256color',
    ...providerEnvVars,
    ...tasmaniaEnv,
    CLAUDE_SKILLS: agent.skills?.join(',') || '',
    CLAUDE_AGENT_ID: agent.id,
    CLAUDE_PROJECT_PATH: agent.projectPath,
    // Load CLAUDE.md from --add-dir directories (e.g. ~/.dorothy)
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
  };
  for (const key of cliProvider.getEnvVarsToDelete()) {
    delete spawnEnv[key];
  }

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
      shell,
      args: ['-l', '-c', command],
      cols: 120,
      rows: 40,
      cwd: rawWorkingDir,
      env: spawnEnv,
    });
  } catch (err) {
    launchAbandoned(agent.id, launch);
    throw err;
  }

  const ptyId = uuidv4();
  ptyProcesses.set(ptyId, ptyProcess);
  noteLaunch(ptyProcess, launchSettings(agent));

  agent.ptyId = ptyId;
  // The link recorded at the top of the route named the session that was live
  // then, which this call has just replaced. Carry it onto the new one: the
  // caller did ask for this work, and without this the notification would be
  // dropped as belonging to a session that no longer exists.
  if (agent.requestedBy) agent.requestedBy = { ...agent.requestedBy, ptyId };
  agent.ptyCwd = rawWorkingDir;
  // A terminal again: a stop is over (core/agent-stop.ts), and a sleep too,
  // the agent waking on its conversation, its task the message that woke it.
  clearStop(agent);
  if (opts.wokenBy) noteWaker(agent.id, opts.wokenBy.by, opts.wokenBy.via);
  wakeFromSleep(agent);
  agent.status = 'running';
  agent.workHandedAt = new Date().toISOString();
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

function recordRequester(agent: AgentStatus, req: RouteRequest): void {
  const callerId = resolveCallerId(req);
  const agentId = callerId && callerId !== agent.id ? callerId : undefined;
  // A worker writing to the agent that leads it (the orchestrator that handed
  // it the work, or its project's orchestrator) is reporting, not delegating:
  // as a link, the orchestrator's next outcome was typed into the worker's
  // terminal as news of work it had never handed over. The orchestrator's own
  // link, if it has one, stays as it is.
  const caller = agentId ? agents.get(agentId) : undefined;
  if (caller && (caller.requestedBy?.agentId === agent.id
      || (agent.role === 'orchestrator' && agent.projectPath === caller.projectPath))) return;
  // Bound to the session this work is about to run in. When the route ends up
  // spawning a fresh one, spawnAgentSession re-stamps it with the new ptyId
  // below; when the spawn fails, the link keeps a ptyId that is not live and
  // is therefore ignored, which is the right way round.
  const requestedBy = agentId ? { agentId, ptyId: agent.ptyId ?? '' } : undefined;
  if (agent.requestedBy?.agentId === requestedBy?.agentId
      && agent.requestedBy?.ptyId === requestedBy?.ptyId) return;
  agent.requestedBy = requestedBy;
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
 * Every agent can read that file (`--add-dir ~/.dorothy`, and on this machine
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
  permissionMode?: 'normal' | 'auto' | 'bypass';
  from?: string;
  sender?: MessageSender;
  /** Run once the agent takes keys, before anything is typed: never for a sender refused 409. */
  onAccepted?: () => void;
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
  opts.onAccepted?.();

  // BUG 4 guard: kill the PTY if its cwd no longer matches the agent's
  // worktree so the spawn path below restarts it in the right directory.
  killStalePty(agent);

  const previousStatus = agent.status;
  const livePty = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
  if (livePty && dialogOpen(agent)) {
    // A blocking permission dialog expects arrow keys/enter, not text: a
    // typed message is useless and the delayed \r could ACCEPT the pending
    // permission. Refuse and surface the reason instead.
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
  if (livePty && cliRunningIn(livePty)) {
    // A live session, mid-task or at its prompt: type the message into it.
    // Working once the message is in its terminal, not before: an agent read
    // `running` for hours from the instant a message was held behind its
    // field, and nothing else reached it (bug-held-forever-05-10.md).
    // `onWritten` runs at once for a message that goes straight in.
    let cancelRetell: (() => void) | undefined;
    let handed = false;
    const handedOver = () => {
      if (handed) return;
      handed = true;
      cancelRetell?.();
      agent.status = 'running';
      agent.waitingReason = undefined;
      agent.workHandedAt = new Date().toISOString();
      // This message starts a new piece of work in the same session; the
      // previous task's captured output must not be mistaken for its result.
      agent.lastCleanOutput = undefined;
      agent.lastActivity = new Date().toISOString();
      saveAgents();
      announceAgent(agent);
    };
    const outcome = writeProgrammaticInput(livePty, opts.message, true, {
      agentId: agent.id,
      from: opts.from ?? 'Tars',
      sender: opts.sender ?? { kind: 'tars' },
      onWritten: handedOver,
      onDropped: () => cancelRetell?.(),
    });
    if (outcome !== 'held' && outcome !== 'refused') handedOver();
    if (outcome === 'held') cancelRetell = retellWhileHeld(agent, opts.sender, Date.now());
    // `held` is not `written`. The message is queued for that terminal and
    // goes in when the field frees, but answering a caller "sent" while
    // nothing has been typed tells it something it cannot check: the QA
    // measured a 200 with mode `message` and status `running` on a terminal
    // that had received nothing thirty seconds later.
    sendJson({
      success: true, mode: 'message', previousStatus,
      ...(outcome === 'held' ? { held: true, heldReason: heldReasonFor(agent) } : {}),
      agent: { id: agent.id, name: agent.name, status: agent.status },
    });
    return;
  }

  // No session: spawn a fresh one with the message as the prompt.
  const wokenBy = { by: opts.from ?? 'Tars', via: 'message' as const };
  if (!(await spawnAgentSession(agent, opts.message, { model: opts.model, permissionMode: opts.permissionMode, wokenBy }, ctx, sendJson))) {
    return;
  }
  sendJson({ success: true, mode: 'start', previousStatus, agent: { id: agent.id, name: agent.name, status: agent.status } });
}

export function registerAgentRoutes(app_: RouteApp, ctx: RouteContext): void {
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
    let agentValues = Array.from(agents.values());
    if (caller && !showAll) {
      agentValues = agentValues.filter(a => a.projectPath === caller);
    }
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
    sendJson({ agent: full ? { ...agent, waitingOn: publishedWaitingOn(agent) } : projectAgent(agent) });
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

    const isOrchestrator = isSuperAgent(agent);

    const teammates = Array.from(agents.values())
      .filter(a => a.projectPath === agent.projectPath && a.id !== agent.id)
      .map(a => `- "${a.name || a.id}" (id: ${a.id}): ${a.role || 'worker'}, status: ${a.status}` +
                (a.branchName ? `, branch: ${a.branchName}` : '') +
                (a.skills?.length ? `, skills: ${a.skills.join(', ')}` : ''));

    const lines = [
      `# Tars agent identity`,
      ``,
      `You are "${agent.name || agent.id}" (agent id: ${agent.id}), ${agent.role || 'worker'} of project ${agent.projectPath}.`,
    ];
    if (agent.worktreePath) {
      lines.push(`You work in the worktree ${agent.worktreePath}${agent.branchName ? ` (branch ${agent.branchName})` : ''}: stay inside this directory.`);
    }
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
        `- Your turn ending is that report. Wait for the builds and tests you started before you answer: a delegated task ends with your turn and stops what you left in the background, and nothing brings you back (~/.dorothy/CLAUDE.md, "Waiting on work you started").`
      );
    }

    sendJson({ context: lines.join('\n') });
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
      permissionMode?: 'normal' | 'auto' | 'bypass';
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
    if (provider !== undefined && !isValidProvider(provider)) {
      sendJson({ error: `Unknown provider "${provider}"` }, 400);
      return;
    }
    // Every task the agent is given opens with its skills (gate of #204).
    const skillsWrong = skillsProblem(skills);
    if (skillsWrong) {
      sendJson({ error: `Not created: ${skillsWrong}` }, 400);
      return;
    }
    if (model !== undefined && !/^[a-zA-Z0-9._:\/\[\]-]+$/.test(model)) {
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
        error: 'An orchestrator is made in the Agents page of Tars, not over the API. Create the agent as a worker; JeanBrasse can make it the orchestrator there.',
      }, 403);
      return;
    }

    const id = uuidv4();
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
    for (const other of demoted) restartForSettings(other.id, ['orchestrator']);
    announceAgent(agent);
    sendJson({ agent });
  });

  // POST /api/agents/:id/start
  app_.post(/^\/api\/agents\/([^/]+)\/start$/, async (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }
    if (!assertMayDriveAgent(req, agent, sendJson)) return;

    const { prompt, model, permissionMode: bodyPermissionMode, printMode } = req.body as {
      prompt: string; model?: string; permissionMode?: 'normal' | 'auto' | 'bypass'; printMode?: boolean;
    };
    if (!prompt) {
      sendJson({ error: 'prompt is required' }, 400);
      return;
    }
    recordRequester(agent, req);

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
      return spawnAgentSession(agent, prompt, { model, permissionMode: bodyPermissionMode, printMode, wokenBy: { by: senderName(agent, req), via: 'start' } }, ctx, sendJson);
    });
    if (!spawned) return;

    sendJson({ success: true, agent: { id: agent.id, status: agent.status } });
  });

  // POST /api/agents/:id/dispatch: atomic "send this task to the agent".
  // Decides message-vs-spawn server-side, under the single-threaded event
  // loop, eliminating the GET-status-then-POST race that MCP tools had when
  // they made that decision client-side on stale status.
  app_.post(/^\/api\/agents\/([^/]+)\/dispatch$/, async (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }
    if (!assertMayDriveAgent(req, agent, sendJson)) return;

    const { message, model, permissionMode } = req.body as {
      message: string; model?: string; permissionMode?: 'normal' | 'auto' | 'bypass';
    };
    if (!message) {
      sendJson({ error: 'message is required' }, 400);
      return;
    }
    await performDispatch(agent, {
      message, model, permissionMode, from: senderName(agent, req), sender: senderOf(agent, req),
      // After the wait: a sender refused 409 typed nothing and takes no link.
      onAccepted: () => recordRequester(agent, req),
    }, ctx, sendJson);
  });

  /**
   * POST /api/agents/:id/run-task
   *
   * Delegation with a receipt. Where /dispatch types a message into the
   * target's terminal and returns before the agent has even read it, this runs
   * the task over the Agent Client Protocol and answers with what the agent
   * actually did: its reply, why the turn ended, which tools it used and what
   * the turn cost. Works on every CLI with an ACP mode.
   */
  app_.post(/^\/api\/agents\/([^/]+)\/run-task$/, async (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }
    if (!assertMayDriveAgent(req, agent, sendJson)) return;

    const { task, timeoutSeconds } = req.body as { task?: string; timeoutSeconds?: number };
    if (!task?.trim()) {
      sendJson({ error: 'task is required' }, 400);
      return;
    }

    if (!canDelegateOverAcp(agent)) {
      sendJson({ error: `${agent.provider ?? 'this provider'} has no ACP mode; use /dispatch`, retryWithDispatch: true }, 409);
      return;
    }

    const wasStatus = agent.status;
    const handedAt = new Date().toISOString();
    agent.status = 'running';
    agent.workHandedAt = handedAt;
    agent.currentTask = task.slice(0, 100);
    agent.lastActivity = new Date().toISOString();
    // Per-agent channel, not a bare 'status': /wait subscribes with
    // `status:${agentId}` (see the .on below), so an emit on 'status' reached
    // nobody and a caller waiting on this agent hung until its timeout.
    emitAgentStatus(agent.id);
    announceAgent(agent);

    const result = await delegateOverAcp({
      agent,
      task,
      appSettings: ctx.getAppSettings(),
      timeoutMs: Math.min(Math.max((timeoutSeconds ?? 900) * 1000, 30_000), 3_600_000),
    });

    // Only while this run is still the latest work the agent was handed. The
    // MCP client can stop waiting on this route before a slow ACP start gives
    // up, and it then types the task into the terminal instead. The turn that
    // starts there owns the status: writing back the one this run began from
    // put a working agent to `waiting`, which /wait answers at once, and which
    // delegate_task reads as a question and answers by typing into the turn.
    if (agent.workHandedAt === handedAt) {
      agent.status = result.ok ? 'idle' : wasStatus === 'running' ? 'idle' : wasStatus;
      agent.lastActivity = new Date().toISOString();
      if (result.text) agent.lastCleanOutput = result.text.slice(-8000);
      saveAgents();
      emitAgentStatus(agent.id);
      announceAgent(agent);
    }

    // A run that started is an answer, however it ended: 502 only when none
    // did, which is when delegate_task may type the task into the terminal
    // instead without running it twice.
    sendJson(result, result.ok || result.started ? 200 : 502);
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
    const reason = stopReasonOf((req.body as { reason?: unknown } | undefined)?.reason);
    if (!reason) {
      sendJson({ error: 'A reason is required: say in one line why this agent is stopped. It is kept with the agent and shown in the window.' }, 400);
      return;
    }

    const by = driver.kind === 'tars' ? 'Tars' : (driver.agent.name || driver.agent.id);
    const stoppedNow = await stopAgent(agent, { by, reason }, { save: saveAgents, announce: announceAgent });
    sendJson({ success: true, ...(stoppedNow ? {} : { alreadyStopped: true }), ...stopOf(agent) });
  });

  // POST /api/agents/:id/message
  app_.post(/^\/api\/agents\/([^/]+)\/message$/, async (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }
    if (!assertMayDriveAgent(req, agent, sendJson)) return;

    const { message } = req.body as { message: string };
    if (!message) {
      sendJson({ error: 'message is required' }, 400);
      return;
    }
    const until = Date.now() + SENDER_WAIT_MS;
    await withAgentLock(agent.id, async () => {
      // As /dispatch: a launch on its way is waited for, never spawned over,
      // and never typed into before it takes keys, counted from the request.
      if (!(await sessionStarted(agent, until - Date.now()))) {
        sendJson(stillStarting(agent), 409);
        return;
      }
      recordRequester(agent, req);

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

      if (!cliRunningIn(agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined)) {
        // No session: the claude process exited (e.g. crashed while 'waiting'),
        // or the terminal is a shell with no CLI, where a typed message would be
        // run as a command whatever the status says (see performDispatchLocked).
        // Auto-respawn: start a fresh one-shot claude session
        // using the message as the prompt, identical to the /start path. This
        // ensures send_message and delegate_task reconnect transparently
        // instead of timing out.
        if (!(await spawnAgentSession(agent, message, { wokenBy: { by: senderName(agent, req), via: 'message' } }, ctx, sendJson))) {
          return;
        }
        sendJson({ success: true });
        return;
      }

      const ptyProcess = agent.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
      if (ptyProcess) {
        // Working once it is in, as /dispatch (bug-held-forever-05-10.md).
        let cancelRetell: (() => void) | undefined;
        let handed = false;
        const handedOver = () => {
          if (handed) return;
          handed = true;
          cancelRetell?.();
          agent.status = 'running';
          agent.waitingReason = undefined;
          agent.workHandedAt = new Date().toISOString();
          agent.lastActivity = new Date().toISOString();
          saveAgents();
          announceAgent(agent);
        };
        const sender = senderOf(agent, req);
        const outcome = writeProgrammaticInput(ptyProcess, message, true, {
          agentId: agent.id,
          from: senderName(agent, req),
          sender,
          onWritten: handedOver,
          onDropped: () => cancelRetell?.(),
        });
        if (outcome !== 'held' && outcome !== 'refused') handedOver();
        if (outcome === 'held') cancelRetell = retellWhileHeld(agent, sender, Date.now());
        sendJson({ success: true, ...(outcome === 'held' ? { held: true, heldReason: heldReasonFor(agent) } : {}) });
        return;
      }
      sendJson({ error: 'Failed to send message - PTY not available' }, 500);
    });
  });

  // DELETE /api/agents/:id
  app_.delete(/^\/api\/agents\/([^/]+)$/, async (req, sendJson) => {
    const agent = agents.get(req.params.id);
    if (!agent) {
      sendJson({ error: 'Agent not found' }, 404);
      return;
    }

    if (!assertMayDriveAgent(req, agent, sendJson)) return;
    await stopAcpRuns(agent.id, 'the agent was deleted');

    if (agent.ptyId) {
      const ptyProcess = ptyProcesses.get(agent.ptyId);
      if (ptyProcess) {
        ptyProcess.kill();
        ptyProcesses.delete(agent.ptyId);
      }
    }
    agents.delete(req.params.id);
    forgetRestart(req.params.id);
    saveAgents();
    // Gone from the next tick, and the rail reloads a fleet without it.
    announceAgent(agent);
    sendJson({ success: true });
  });
}
