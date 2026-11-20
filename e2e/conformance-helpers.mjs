/**
 * The harness conformance spec's helpers (e2e/harness-conformance.spec.ts), out of the spec so a unit test can hold
 * them to what they promise (__tests__/e2e-conformance-helpers.test.ts).
 */

/**
 * The environment a harness's `--version` is read with: the runner's, with the sandbox's HOME, TMPDIR and harness
 * homes over it.
 */
export function versionEnv(runnerEnv, { home, tmp, harnessHomes }) {
  return { ...runnerEnv, HOME: home, TMPDIR: tmp, ...harnessHomes };
}

/**
 * delegate_task, sent again while Tars answers that the CLI is still starting, each time with a request id of its own,
 * five tries at most; the answers that said so are kept with the last one.
 */
export async function delegateOnceUp(lead, { id, prompt, timeoutSeconds, requestId }) {
  const stillStarting = [];
  for (let attempt = 1; ; attempt++) {
    const reply = await lead('delegate_task', { id, prompt, timeoutSeconds, clientRequestId: attempt > 1 ? `${requestId}-${attempt}` : requestId });
    if (!(reply.isError && /still starting/.test(reply.text)) || attempt === 5) return { ...reply, stillStarting };
    stillStarting.push(reply.text);
  }
}
