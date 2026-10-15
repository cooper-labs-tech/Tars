import * as crypto from 'crypto';

/**
 * A secret per agent process, so that on the local API an agent is named by
 * what it holds rather than by what it says.
 *
 * Until this existed, an agent proved nothing. The bearer token on every MCP
 * call was `~/.dorothy/api-token`, one file every agent can read, so it proved
 * "a process of this machine" and never "this agent". Which agent was carried
 * in the X-Tars-Caller-Id header, written by the caller, believed by the
 * server: any agent could put a colleague's id in it and be that colleague for
 * the length of the call. The bus places a caller in a room by the project of
 * the agent it is, and the delegation routes decide what an orchestrator may
 * drive the same way.
 *
 * So: a random 256 bit token is minted on the line that starts an agent
 * process, and travels to the CLI, and from there to the MCP servers it
 * starts, in the environment. The server names the caller from the token and
 * from nothing else: a call on the shared token is no agent at all.
 *
 * What this does not stop. The token travels in the environment of the agent's
 * CLI and of the MCP servers it starts, and the environment of those processes
 * is readable by every other process of the same user: `ps -Eww -p <pid>`
 * prints it, measured on 2026-09-16 by reading one agent's CLAUDE_AGENT_ID from
 * another agent's shell. Only Apple's platform binaries, /bin/zsh among them,
 * hide theirs, and neither `claude` nor `node` is one. An agent set on it can
 * read a colleague's token the same way and present it. The token ends the
 * impersonation that took writing a header. It is not a boundary against a
 * process that reads the process table, and no check in the API can be one
 * while agents run as the user without a sandbox.
 *
 * In memory, deliberately, and never next to api-token: a file is what made
 * the shared token shared. An agent removed from the fleet needs no
 * revocation either: every guard resolves the id through `agents`, and an id
 * that is no longer in there is refused by the lookup that follows.
 */

/**
 * This Tars, for the run: a random id handed to every agent process beside its
 * token (TARS_INSTANCE_ID), never written anywhere and never sent. A hook asks
 * the port it posts to for sha256("<id>:<challenge>") on a challenge of its
 * own, and sends its token only when the answer is right (the Audit's table on
 * a3d7c125, #11): while Tars is down, any process of any account may hold
 * 31415, and got every token posted to it. The id is as readable as the token
 * by a process of the same user (`ps -Eww`), and no more: this closes the port
 * to others, not to that.
 */
const INSTANCE_ID = crypto.randomBytes(16).toString('hex');

export function tarsInstanceId(): string {
  return INSTANCE_ID;
}

/** The proof of this instance for a hook's challenge, or undefined for a challenge that is not 32 to 64 hex digits. */
export function instanceProof(challenge: unknown): string | undefined {
  if (typeof challenge !== 'string' || !/^[0-9a-f]{32,64}$/.test(challenge)) return undefined;
  return crypto.createHash('sha256').update(`${INSTANCE_ID}:${challenge}`).digest('hex');
}

/** token -> agent id. The direction the server asks in. */
const agentByToken = new Map<string, string>();
/** agent id -> the token of its terminal, so a new spawn can drop the previous one. */
const tokenByAgent = new Map<string, string>();

/**
 * A fresh token for this agent's terminal, replacing the one it had.
 *
 * Called from spawnAgentPty, which is the single line every agent pty starts
 * on. Called there rather than when the agent record is created because a
 * token that outlives the process it was minted for is a pass left behind.
 */
export function mintAgentToken(agentId: string): string {
  const previous = tokenByAgent.get(agentId);
  if (previous) agentByToken.delete(previous);

  const token = crypto.randomBytes(32).toString('hex');
  agentByToken.set(token, agentId);
  tokenByAgent.set(agentId, token);
  return token;
}

/**
 * A token for one delegated run, held beside the terminal's rather than in its
 * place, and valid until `revoke` is called.
 *
 * A task delegated over ACP runs in a process of its own, started by
 * delegateOverAcp and not by spawnAgentPty, while the agent's terminal may
 * well be alive with a token of its own. Minting through mintAgentToken would
 * cut that terminal off in mid-session, and a terminal respawned during the
 * run would cut the run off. So the run's token takes no part in the
 * terminal's replacement, and ends with the run.
 */
export function mintRunToken(agentId: string): { token: string; revoke: () => void } {
  const token = crypto.randomBytes(32).toString('hex');
  agentByToken.set(token, agentId);
  return { token, revoke: () => { agentByToken.delete(token); } };
}

/**
 * Whether this is the token of the agent's terminal as it is now: not a
 * delegated run's, not a replaced or ended terminal's. The hook routes take
 * this one alone. A run's token passed them as its agent's, and a SessionStart
 * posted with it registered a session over the live terminal's, which then had
 * every post refused as stale and stayed `running` (the Audit, gate of #135).
 */
export function isTerminalToken(token: string): boolean {
  const agentId = agentByToken.get(token);
  return !!agentId && tokenByAgent.get(agentId) === token;
}

/**
 * The terminal this token was minted for has ended: its token ends with it,
 * unless a newer terminal of the agent has already replaced it. It used to
 * last until the agent's next launch, and a fake SessionStart with a stopped
 * CLI's token changed which session a restart would resume.
 */
export function revokeTerminalToken(agentId: string, token: string): void {
  if (tokenByAgent.get(agentId) !== token) return;
  tokenByAgent.delete(agentId);
  agentByToken.delete(token);
}

/** The agent this token was minted for, or undefined if it was not minted here. */
export function agentForToken(token: string): string | undefined {
  return agentByToken.get(token);
}

/**
 * Tars's own pass on its own API, for the parts of the main process that reach
 * it over the loopback.
 *
 * One caller: the super chat. It posts to /api/agents/:id/dispatch rather than
 * writing to a terminal by hand, so that a message from JeanBrasse takes exactly the
 * path a delegation takes. It authenticated with `~/.dorothy/api-token`, and
 * that is precisely why that token could not be refused on the routes that
 * drive an agent: every agent can read the file (`--add-dir ~/.dorothy`, and
 * its Bash reads it whatever the flag says), so refusing the file would have
 * taken the super chat down with whoever else had read it.
 *
 * Minted here rather than in a file, because a file is what made the shared
 * token shared. It exists in this process's memory, is never written to disk,
 * never enters the environment of a child, and is not the shared token: an
 * agent that reads `~/.dorothy` or the process table of its colleagues finds
 * nothing that opens these routes. Lazily, and once per run of the app: the
 * super chat outlives no restart, and neither does an agent's token.
 *
 * What it is not. A process able to read the memory of the Electron main
 * process, or to attach a debugger to it, has this the way it has everything
 * else Tars holds. On a machine where every agent runs as the user, that is
 * the floor for all of this; see the sandbox note. It removes a credential
 * from the filesystem, it does not put one out of reach.
 */
let internal: string | null = null;

export function internalToken(): string {
  if (!internal) internal = crypto.randomBytes(32).toString('hex');
  return internal;
}

/** True for Tars's own pass, and only when one has been minted. */
export function isInternalToken(token: string): boolean {
  return !!internal && token === internal;
}
