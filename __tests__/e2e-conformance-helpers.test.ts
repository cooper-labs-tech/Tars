import { describe, it, expect, vi } from 'vitest';

/**
 * The harness conformance spec's helpers (e2e/conformance-helpers.mjs): the environment a harness's `--version` is read
 * with, and the loop that sends delegate_task again while Tars answers that the CLI is still starting.
 *
 * How they fail, written before the fix (the #614 Audit's L1 to L3, 20/11):
 * 1. (L1) The version read spreads the runner's environment: the runner's own CLI settings reach the binary
 *    (KILO_CONFIG, KILO_CONFIG_DIR, KILO_CONFIG_CONTENT, OPENCODE_CONFIG, OPENCODE_CONFIG_DIR, OPENCODE_CONFIG_CONTENT,
 *    PI_CODING_AGENT_SESSION_DIR, ZDOTDIR, CLAUDE_CONFIG_DIR, GIT_*, and Tars's own), so a Kilo reads, and may write,
 *    the runner's real folders: the class of the incident where Kilo wrote four folders into the real home. Only the
 *    sandbox's HOME, TMPDIR and harness homes, over what the fixture lets a sandboxed process inherit.
 * 2. (L3) A resend on any error that quotes "still starting": a task that ran and failed in its CLI's words would be
 *    typed again. Only on Tars's own answer, which says the CLI is still starting and that nothing was typed.
 * 3. A resend on a blocker Tars names ("has not taken keys ... it asks ...: Nothing was typed. Send it again once that
 *    is done."): that waits on a person, not on a moment.
 * 4. Resent for ever, or under the same request id, which Tars answers with the first answer: five tries at most,
 *    each with an id of its own, the "still starting" answers kept with the last one.
 * 5. A refusal, or an answer that is no error, resent.
 * 6. (Goose, 20/11) The runner's Goose settings reach the version read: GOOSE_PROVIDER, GOOSE_MODE, GOOSE_PATH_ROOT
 *    (which moves every folder of Goose's), so a Goose reads, and may write, the runner's own.
 */

import { delegateOnceUp, versionEnv } from '../e2e/conformance-helpers.mjs';

const STILL_STARTING = "Not delegated: Task t-aceeea2e never started: Worker's CLI is still starting (it has not taken keys after 20 s, as happens on a loaded machine): nothing was typed. Send it again in a moment.";
const ANSWERED = { text: 'PROBE-OK TARS-PROBE-1234abcd  --- ended: end_turn', isError: false };

/** A lead whose delegate_task answers each call with the next canned reply, the last one for ever after. */
function leadAnswering(...replies: Array<{ text: string; isError: boolean }>) {
  const lead = vi.fn(async (_tool: string, _args: Record<string, unknown>) => replies[Math.min(lead.mock.calls.length - 1, replies.length - 1)]);
  return lead;
}
const ids = (lead: ReturnType<typeof leadAnswering>) => lead.mock.calls.map(([, args]) => (args as { clientRequestId: string }).clientRequestId);
const opts = { id: 'worker', prompt: 'the task', timeoutSeconds: 200, requestId: 'e2e-conformance-kilo-1' };

describe("the version read's environment (1)", () => {
  it("is the sandbox's homes over what a sandboxed process may inherit, never the runner's CLI settings", () => {
    const runner = {
      PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', HOME: '/home/runner', TMPDIR: '/var/tmp/someone',
      KILO_CONFIG: '/home/runner/kilo.json', KILO_CONFIG_DIR: '/home/runner/.kilo', KILO_CONFIG_CONTENT: '{}',
      OPENCODE_CONFIG: '/home/runner/oc.json', OPENCODE_CONFIG_DIR: '/home/runner/.oc', OPENCODE_CONFIG_CONTENT: '{}',
      PI_CODING_AGENT_SESSION_DIR: '/home/runner/.pi/sessions', ZDOTDIR: '/home/runner/.zsh', CLAUDE_CONFIG_DIR: '/home/runner/.claude',
      GIT_DIR: '/home/runner/repo/.git', GIT_CONFIG_GLOBAL: '/home/runner/.gitconfig',
      GOOSE_PROVIDER: 'anthropic', GOOSE_MODE: 'auto', GOOSE_PATH_ROOT: '/home/runner/.goose-root',
      CLAUDE_MGR_API_TOKEN: 'a-token', DOROTHY_API_PORT: '31415', TARS_AGENT: 'x', ANTHROPIC_API_KEY: 'sk-x',
    };
    const harnessHomes = { XDG_CONFIG_HOME: '/sandbox/.config', XDG_DATA_HOME: '/sandbox/.local/share', CODEX_HOME: '/sandbox/.codex' };
    const env = versionEnv(runner, { home: '/sandbox', tmp: '/sandbox/tmp', harnessHomes });
    expect(env).toMatchObject({ PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', HOME: '/sandbox', TMPDIR: '/sandbox/tmp', ...harnessHomes });
    const leaked = Object.keys(env).filter((name) => /^(KILO_|OPENCODE_|PI_CODING_AGENT_|GOOSE_|GIT_|CLAUDE|DOROTHY|TARS_|ANTHROPIC)|^ZDOTDIR$/.test(name));
    expect(leaked).toEqual([]);
  });
});

describe('the resend loop (2 to 5)', () => {
  it("sends again on Tars's own answer, each time under an id of its own, and keeps what it was told", async () => {
    const lead = leadAnswering({ text: STILL_STARTING, isError: true }, ANSWERED);
    const reply = await delegateOnceUp(lead, opts);
    expect(reply).toMatchObject(ANSWERED);
    expect(reply.stillStarting).toEqual([STILL_STARTING]);
    expect(ids(lead)).toEqual(['e2e-conformance-kilo-1', 'e2e-conformance-kilo-1-2']);
  });

  it('2: never on an error that only quotes "still starting": a task that ran and failed is not typed again', async () => {
    const lead = leadAnswering({ text: 'The task failed: npm said the dev server is still starting, try again later.', isError: true }, ANSWERED);
    const reply = await delegateOnceUp(lead, opts);
    expect(lead).toHaveBeenCalledTimes(1);
    expect(reply.isError).toBe(true);
  });

  it('3: never on a blocker Tars names, which waits on a person', async () => {
    const named = 'Not delegated: Worker\'s CLI has not taken keys after 20 s: it asks "Trust project folder? /p" in its terminal, which nobody answers there: answer it in the agent\'s terminal. Nothing was typed. Send it again once that is done.';
    const lead = leadAnswering({ text: named, isError: true }, ANSWERED);
    await delegateOnceUp(lead, opts);
    expect(lead).toHaveBeenCalledTimes(1);
  });

  it('4: five tries at most, the last answer returned with the four before it', async () => {
    const lead = leadAnswering({ text: STILL_STARTING, isError: true });
    const reply = await delegateOnceUp(lead, opts);
    expect(lead).toHaveBeenCalledTimes(5);
    expect(new Set(ids(lead)).size).toBe(5);
    expect(reply.stillStarting).toHaveLength(4);
    expect(reply.isError).toBe(true);
  });

  it('5: never on a refusal, nor on an answer that is no error, whatever it says', async () => {
    const refused = leadAnswering({ text: 'Not delegated: the agent belongs to another project.', isError: true });
    await delegateOnceUp(refused, opts);
    expect(refused).toHaveBeenCalledTimes(1);
    const quoted = leadAnswering({ text: `It said: ${STILL_STARTING}`, isError: false });
    await delegateOnceUp(quoted, opts);
    expect(quoted).toHaveBeenCalledTimes(1);
  });
});
