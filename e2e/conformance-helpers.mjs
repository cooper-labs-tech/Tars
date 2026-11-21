/**
 * The harness conformance spec's helpers (e2e/harness-conformance.spec.ts), out of the spec so a unit test can hold
 * them to what they promise (__tests__/e2e-conformance-helpers.test.ts).
 */
import { inheritable } from './fixture.mjs';

/**
 * The runner's settings of a CLI or of git, never handed to a harness in the sandbox: they would point it at the
 * runner's real folders (KILO_CONFIG_DIR, OPENCODE_CONFIG_DIR, PI_CODING_AGENT_SESSION_DIR, GIT_DIR...) or its own
 * config (the *_CONFIG_CONTENT variables). The harnesses' homes are set again from the sandbox's (the #614 Audit's L1).
 * The fixture drops Tars's and Claude Code's own (inheritable).
 */
const CLI_SETTINGS = /^(KILO_|OPENCODE_|PI_CODING_AGENT_|CODEX_|KIMI_|GIT_|XDG_)|^ZDOTDIR$/;

/**
 * The environment a harness's `--version` is read with: what the fixture lets a sandboxed process inherit, without the
 * runner's CLI settings, and the sandbox's HOME, TMPDIR and harness homes over it.
 */
export function versionEnv(runnerEnv, { home, tmp, harnessHomes }) {
  const kept = Object.fromEntries(Object.entries(inheritable(runnerEnv)).filter(([name]) => !CLI_SETTINGS.test(name)));
  return { ...kept, HOME: home, TMPDIR: tmp, ...harnessHomes };
}

/**
 * Tars's own answer to a sender that waited on a launch still on its way (agent-routes.ts, stillStarting; chat-runners
 * .ts): the CLI is still starting, and nothing was typed. Only that is sent again: an error that only quotes "still
 * starting" may be a task that ran and failed, and a blocker Tars names waits on a person (the #614 Audit's L3).
 */
const STILL_STARTING = /still starting[\s\S]*nothing was typed/i;

/**
 * delegate_task, sent again while Tars answers that the CLI is still starting, each time with a request id of its own,
 * five tries at most; the answers that said so are kept with the last one.
 */
export async function delegateOnceUp(lead, { id, prompt, timeoutSeconds, requestId }) {
  const stillStarting = [];
  for (let attempt = 1; ; attempt++) {
    const reply = await lead('delegate_task', { id, prompt, timeoutSeconds, clientRequestId: attempt > 1 ? `${requestId}-${attempt}` : requestId });
    if (!(reply.isError && STILL_STARTING.test(reply.text)) || attempt === 5) return { ...reply, stillStarting };
    stillStarting.push(reply.text);
  }
}
