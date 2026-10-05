import * as path from 'path';
import * as pty from 'node-pty';
import { managedCliEnv } from '../providers/cli-provider';
import { mintAgentToken, revokeTerminalToken, tarsInstanceId } from './agent-tokens';
import { API_PORT } from '../constants';
import { rememberTerminalOwner, terminalExited } from './pty-manager';
import { attachTerminalMirror, panelSizeOf } from './terminal-mirror';
import { accountEnvFor, withAccountEnv } from './account-env';
import { refuseWhileQuitting } from './quit-state';
import { agentTmpEnvOrNone } from '../services/agent-tmp';

export { setAccountEnvResolver } from './account-env';

/**
 * How each agent PTY was started: the shell, as it was given to node-pty, and
 * whether it was handed a command to run (`-c`) rather than left interactive.
 */
const spawnedAs = new WeakMap<pty.IPty, { shell: string; runsCommand: boolean }>();

/** When each agent PTY last printed something, and whether it has at all. */
const heardFrom = new WeakMap<pty.IPty, { lastAt: number }>();
/** The agent PTYs whose output is listened to for that. */
const listening = new WeakSet<pty.IPty>();

/** A shell that has spoken and then been quiet this long is at its prompt. */
export const SHELL_QUIET_MS = 150;
/** A shell that has said nothing after this long is typed into anyway. */
export const SHELL_READY_MAX_MS = 5_000;

/** node-pty's own program, which takes the terminal and then executes the shell. */
const NODE_PTY_HELPER = 'spawn-helper';

/**
 * Spawn the PTY an agent's CLI runs in.
 *
 * There are two of these, and only two: initAgentPty for a restored or
 * renderer-started agent, and spawnAgentSession for every API-driven one
 * (delegation, /dispatch, /message, /start). They assemble their environments
 * separately and always have, which is how DISABLE_AUTOUPDATER shipped on one
 * path and not the other, and how armTaskStartWatch did the same thing a
 * change earlier. The pattern is the bug: anything Tars imposes on a CLI it
 * launched cannot live in the callers, because a caller can be added or
 * forgotten.
 *
 * So it lives here instead, applied after the caller's env and after the
 * provider's own deletions, on the one line that actually starts the process.
 * A third spawn site would have to go through this to exist.
 *
 * The claim this comment used to make, that a third spawn site would have to
 * come through here to exist, was wrong twice over. Switching an agent to the
 * local provider recreated its pty with a direct pty.spawn, and creating an
 * agent from the renderer spawned one too. Both predate all of this, both put
 * CLAUDE_AGENT_ID in the environment through getPtyEnvVars, and neither had
 * the API address, so both posted their hooks to whichever Tars owned 31415.
 * Five sites now, all through here. The fifth is the kanban automation in
 * main.ts, creating agents of its own under a comment saying it duplicates the
 * agent:create handler, which it did, defect included. What deliberately does not are the shells that run no
 * agent: the quick terminal, the skill and plugin runners, and the npx
 * installer. They carry no CLAUDE_AGENT_ID, so a hook fired from one of them
 * has no agent to name and is refused. Anything that spawns an agent belongs
 * here.
 *
 * Its own module rather than a function in pty-manager, because five suites
 * stub pty-manager out wholesale to keep node-pty away from them. Putting the
 * spawn in there would have replaced their `pty.spawn` assertions with a stub
 * of the very thing under test, so they would have gone on passing while
 * checking nothing. Here they reach the real one and keep asserting what they
 * always did.
 */
export function spawnAgentPty(opts: {
  /** The provider's binary, which decides what Tars is allowed to impose. */
  binaryName: string;
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string | undefined>;
}): pty.IPty {
  // Once the quit has begun, a terminal spawned here would be in no map the
  // quit ends: every caller (the API, the IPC, the bots, main.ts) is refused,
  // before a token is minted or an account worked out for a terminal that
  // will not exist.
  refuseWhileQuitting('agent terminal');
  // Whose process this is. Set by the callers through getPtyEnvVars, and read
  // back here rather than taken as a parameter so that a caller cannot spawn
  // an agent pty with one identity in the environment and another in the
  // token. The shells that run no agent carry no id, and are meant to get no
  // token: the quick terminal, the skill and plugin runners, the installer.
  const agentId = opts.env.CLAUDE_AGENT_ID;
  // The size the agent's panel last asked for, when one has: a PTY spawned at
  // the caller's default kept it until the panel happened to change size. See
  // rememberPanelSize.
  const size = panelSizeOf(agentId) ?? { cols: opts.cols, rows: opts.rows };
  const token = agentId ? mintAgentToken(agentId) : undefined;
  // The Claude account this agent starts on, when the option is on (see
  // core/account-env.ts): here for the reason this module exists, since an
  // account a caller forgot would be a CLI billed to the wrong subscription.
  const env = withAccountEnv(opts.env, accountEnvFor(agentId, opts.cwd));

  const spawned = pty.spawn(opts.shell, opts.args, {
    name: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: opts.cwd,
    env: {
      ...env,
      // Which Tars this CLI answers to: its hooks, its bundled MCP servers and
      // anything else that calls back. It is set here, after the caller's env,
      // for the reason this module exists. initAgentPty set it and
      // spawnAgentSession never did, so every agent started through the API,
      // which is /start, /dispatch, /message and delegation, ran with no port
      // at all and fell back to 31415. A sandbox on 31499 therefore wrote its
      // statuses into whichever Tars owned 31415, which is the live one.
      //
      // After opts.env on purpose: an agent spawned by an agent inherits the
      // parent's value, and the app that spawns a CLI is the app that CLI must
      // report to.
      CLAUDE_MGR_API_URL: `http://127.0.0.1:${API_PORT}`,
      // What this CLI is, provably. CLAUDE_AGENT_ID travels in the same
      // environment and says who the agent is, but anything that can read an
      // environment can repeat it, so it was a claim and not a proof. This
      // cannot be guessed, and the API resolves the caller from it.
      //
      // Here for the same reason as the address above: five spawn sites, and
      // a secret that has to reach every agent process cannot depend on each
      // of them remembering. Minted per spawn, so a restart invalidates the
      // token the previous process ran with.
      ...(token ? { CLAUDE_MGR_API_TOKEN: token } : {}),
      // What a hook checks the port with before it sends that token (#11).
      TARS_INSTANCE_ID: tarsInstanceId(),
      // Its own temporary folder, which a boot does not empty (services/agent-tmp.ts):
      // here because every agent terminal is spawned here.
      ...(agentId ? agentTmpEnvOrNone(agentId) : {}),
      ...managedCliEnv(opts.binaryName),
    } as { [key: string]: string },
  });
  spawnedAs.set(spawned, { shell: opts.shell, runsCommand: opts.args.includes('-c') });
  // Whose terminal this is, so a message that has to wait for a draft in it
  // can name the agent whose panel should say so. Here because this is the
  // one function that spawns an agent's terminal, and a caller that has to
  // remember is a caller that will not.
  if (agentId) rememberTerminalOwner(spawned, agentId);
  // And what it held goes when it does: a message queued for a terminal whose
  // CLI has exited would be probed for, and later typed into nothing.
  spawned.onExit(() => {
    terminalExited(spawned);
    // And what it was spawned as: gone, node-pty on Linux still names the
    // shell it spawned, and a terminal handed a command read as a running CLI.
    spawnedAs.delete(spawned);
    // And its token: a stopped CLI's stayed valid until the agent's next launch.
    if (agentId && token) revokeTerminalToken(agentId, token);
  });
  // Before any caller subscribes, so a chunk is in the mirror before it is
  // broadcast. Here for the reason above: every agent terminal needs one. The
  // left-fullscreen watch only for the claude binary, whose two renderers it
  // was measured on.
  if (agentId) {
    attachTerminalMirror(spawned, { ...size, watchRepaint: opts.binaryName === 'claude', label: agentId });
    // What shellReady waits on: a launch typed before the shell has printed its
    // prompt goes through the terminal's canonical mode (see shellReady).
    listening.add(spawned);
    spawned.onData(() => { heardFrom.set(spawned, { lastAt: Date.now() }); });
  }
  return spawned;
}

/**
 * Whether a program runs in an agent's PTY rather than the shell Tars types
 * commands into.
 *
 * Read from the terminal itself, not from the agent's status: a CLI outlives
 * the statuses that say it stopped. A turn that fails leaves claude at its
 * prompt, and an agent marked done or idle keeps its session open, so the
 * status said "not running" while a start typed `cd '...' && claude ...` into
 * a live claude.
 *
 * node-pty names the leader of the terminal's foreground process group
 * (tcgetpgrp, then its p_comm). Measured with the real node-pty and Claude Code
 * 2.1.273 in `/bin/bash -l`: `bash` at the prompt; `2.1.273` while claude runs,
 * at its prompt and during a turn, because the native binary is named after its
 * version, which is why this compares against the shell and never against a
 * CLI's name; `bash` again within 300 ms of `/exit`; `sleep` for a plain
 * command, which counts too, since typing into it is just as wrong. Between the
 * fork and the exec of a command, about 200 ms, the new group's leader is still
 * named bash and this reads false.
 *
 * Until the shell holds its terminal, node-pty gives it two other names, and
 * only the process name was compared. First the file it was asked to spawn, as
 * given, `/bin/bash`: node-pty returns it whenever it finds kernel_task leading
 * the foreground. Then `spawn-helper`, node-pty's own program, which opens the
 * terminal and executes the shell. Measured with the real spawnAgentPty and
 * node-pty 1.1.0 under Electron's node, five spawns: `/bin/bash` for 3 to
 * 127 ms, `spawn-helper` for up to 7 ms, then `bash`. agent:get, which then
 * created a terminal and read this at once, said a CLI ran in a shell that
 * had not started. After a command exits the name is briefly undefined, until the
 * shell takes the terminal back.
 *
 * All of that is the interactive shell. A shell handed its command with `-c`,
 * which is how spawnAgentSession starts every API-driven session, has no job
 * control: the CLI stayed in the shell's process group and node-pty named
 * `bash` for its whole life. Measured on 2026-09-23 by the Audit and the
 * Frontend: every agent the API had started read false with claude alive, the
 * orchestrator among them, so /dispatch and /start ended their sessions and a
 * start from the Dashboard typed its launch line into claude's field.
 * spawnAgentSession now execs the CLI, which names it; but from the spawn to
 * the exec, while the shell reads its login files, the leader is still bash.
 * Such a terminal exists for that one CLI: it never shows a prompt, what is
 * typed into it waits for the CLI (a non-interactive shell does not read its
 * terminal), and it closes when the CLI ends. So it counts for as long as it
 * can be read, starting and then running, and an interactive shell never does
 * at its prompt, where a typed line would run as a command.
 */
/**
 * Whether this is an agent terminal Tars started whose CLI has stopped, back
 * at its shell: what the writer asks before it types a held message
 * (pty-manager.ts, setCliProbe). A terminal it did not start as an agent's is
 * not known to have stopped, and is left as it was.
 */
export function cliStoppedIn(ptyProcess: pty.IPty): boolean {
  return spawnedAs.has(ptyProcess) && !cliRunningIn(ptyProcess);
}

export function cliRunningIn(ptyProcess: pty.IPty | undefined): boolean {
  if (!ptyProcess) return false;
  const spawned = spawnedAs.get(ptyProcess);
  if (!spawned) return false;
  let foreground: string | undefined;
  try {
    foreground = ptyProcess.process;
  } catch {
    // The terminal is gone: nothing runs in it.
    return false;
  }
  if (!foreground) return false;
  if (spawned.runsCommand) return true;
  return foreground !== path.basename(spawned.shell)
    && foreground !== spawned.shell
    && foreground !== NODE_PTY_HELPER;
}

/**
 * Resolves once the shell in an agent's PTY is at its prompt: it has printed
 * something, then been quiet for SHELL_QUIET_MS. At once for a shell that did
 * so long ago, and after SHELL_READY_MAX_MS for one that never speaks.
 *
 * A line typed before the shell takes its terminal goes through the terminal's
 * canonical mode, which holds a line of about 1 KB on macOS and 4 KB on Linux:
 * the rest is cut, and the command never runs. Measured at the QA gate of #155
 * with node-pty and a cold `/bin/bash -l`: 995 bytes typed at once ran, 1095 did
 * not; 1495 ran after the shell had spoken and gone quiet for 150 ms, 2/2. In
 * the app, a Telegram message of 946 characters (a 1374-byte launch) started no
 * session in 60 s, and the same launch into a shell at its prompt did. The
 * quiet adapts to load where a fixed delay does not.
 */
export async function shellReady(ptyProcess: pty.IPty): Promise<void> {
  const deadline = Date.now() + SHELL_READY_MAX_MS;
  for (;;) {
    const heard = heardFrom.get(ptyProcess);
    const quietFor = heard ? Date.now() - heard.lastAt : 0;
    if (heard && quietFor >= SHELL_QUIET_MS) return;
    // A terminal nobody listens to, or one that has exited, has nothing to wait for.
    if (!listening.has(ptyProcess) || !spawnedAs.has(ptyProcess)) return;
    const left = deadline - Date.now();
    if (left <= 0) {
      console.warn(`[agent-pty] a shell said nothing in ${SHELL_READY_MAX_MS / 1000} s: typing into it anyway`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(left, heard ? SHELL_QUIET_MS - quietFor : 50)));
  }
}
