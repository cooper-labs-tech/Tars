import '../../setup/home-guard';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHermesSessionWatch, type SessionCheck } from '../../../electron/services/hermes-session-watch';
import { HERMES_SIGNED_OUT } from '../../../electron/services/kanban-board';

/**
 * Tars's Hermes session, kept valid and watched (brief of 18/10).
 *
 * Measured in Hermes 0.21.5's own code (plugins/dashboard_auth/basic): the access
 * token lives 12 hours, the refresh token 30 days, and the gateway's middleware
 * refreshes a lapsed access token by itself and mints a new refresh token with
 * it, for 30 more days. A session therefore stays valid for as long as Tars asks
 * the gateway something, signed in, at least once a month; what ends it then is
 * the gateway (a new signing secret, a sign-out, another provider's rules). On
 * 17/10 every kanban call answered "Unauthorized" and nothing said so.
 *
 * How this can fail, written before the code:
 * 1. a refusal a kanban call met says nothing to the window until the next check:
 *    it must turn the state to signed out at once, and tell the window once, not
 *    at every refused call;
 * 2. the watch never asks the gateway, so nothing renews the session and nothing
 *    finds it dead: a check at start, then one every interval;
 * 3. a gateway that does not answer, or a check that throws, is reported as signed
 *    out, which tells the user to sign in when the gateway is down;
 * 4. once the user has signed in again, the window goes on saying signed out;
 * 5. an unmeasured version is not said, or a measured one is said as unmeasured,
 *    or no version at all passes as measured;
 * 6. with no Hermes configured, or one that asks for no sign-in, the watch says
 *    signed out, or asks anything at all of a gateway nobody configured;
 * 7. a refusal racing a check tells the window twice for one change;
 * 8. stop() leaves the timer running.
 * 9. one refused call (a 401 during a gateway's refresh, say) keeps the window on
 *    signed out until the next check, half an hour on, while every call after it
 *    works; or a burst of refusals asks the gateway once per refusal (the Audit's
 *    L2 on #452).
 */

afterEach(() => { vi.useRealTimers(); });

const signedIn: SessionCheck = { configured: true, reachable: true, authRequired: true, signedIn: true, version: '0.21.5' };

function watch(checks: Array<SessionCheck | Error>, everyMs = 1000) {
  const seen: Array<ReturnType<ReturnType<typeof createHermesSessionWatch>['state']>> = [];
  let i = 0;
  const check = vi.fn(async () => {
    const next = checks[Math.min(i++, checks.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  });
  const w = createHermesSessionWatch({ check, everyMs, onChange: s => seen.push(s) });
  return { w, check, seen };
}

describe('the Hermes session watch', () => {
  it('1, 7. turns signed out at once on a refused call, and tells the window once', async () => {
    const { w, seen } = watch([signedIn]);
    await w.checkNow();
    expect(w.state().session).toBe('signed-in');
    w.refused();
    w.refused();
    expect(w.state().session).toBe('signed-out');
    expect(w.state().message).toBe(HERMES_SIGNED_OUT);
    expect(seen.map(s => s.session)).toEqual(['signed-in', 'signed-out']);
  });

  it('2, 8. checks at start and at every interval, and stops when told', async () => {
    vi.useFakeTimers();
    const { w, check } = watch([signedIn], 1000);
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(check).toHaveBeenCalledTimes(4);
    w.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(check).toHaveBeenCalledTimes(4);
  });

  it('3. says unreachable, not signed out, when the gateway does not answer', async () => {
    const { w } = watch([{ ...signedIn, reachable: false, signedIn: false }, new Error('ECONNREFUSED')]);
    await w.checkNow();
    expect(w.state().session).toBe('unreachable');
    await w.checkNow();
    expect(w.state().session).toBe('unreachable');
    expect(w.state().message).not.toBe(HERMES_SIGNED_OUT);
  });

  it('4. clears signed out once a check passes again, and tells', async () => {
    const { w, seen } = watch([{ ...signedIn, signedIn: false }, signedIn]);
    await w.checkNow();
    expect(w.state().session).toBe('signed-out');
    await w.checkNow();
    expect(w.state().session).toBe('signed-in');
    expect(w.state().message).toBeUndefined();
    expect(seen.map(s => s.session)).toEqual(['signed-out', 'signed-in']);
  });

  it('5. says when the version was not measured, and only then', async () => {
    const { w } = watch([signedIn, { ...signedIn, version: '0.22.0' }, { ...signedIn, version: undefined }]);
    await w.checkNow();
    expect(w.state()).toMatchObject({ version: '0.21.5', unmeasured: false });
    await w.checkNow();
    expect(w.state()).toMatchObject({ version: '0.22.0', unmeasured: true });
    await w.checkNow();
    expect(w.state().unmeasured).toBe(true);
  });

  it('9. asks again within a minute of a refused call, once for a burst, and says signed in again while the session works', async () => {
    vi.useFakeTimers();
    const { w, check, seen } = watch([signedIn, signedIn, { ...signedIn, signedIn: false }], 30 * 60_000);
    w.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
    w.refused();
    w.refused();
    w.refused();
    expect(w.state().session).toBe('signed-out');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(check, 'one check for the burst').toHaveBeenCalledTimes(2);
    expect(w.state().session).toBe('signed-in');
    // A session the gateway has really ended stays signed out after the check.
    w.refused();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(check).toHaveBeenCalledTimes(3);
    expect(w.state().session).toBe('signed-out');
    expect(seen.map(s => s.session)).toEqual(['signed-in', 'signed-out', 'signed-in', 'signed-out']);
    w.stop();
  });

  it('6. stays quiet with no Hermes configured, or one that asks for no sign-in', async () => {
    const none = watch([{ configured: false, reachable: false, authRequired: false, signedIn: false }]);
    await none.w.checkNow();
    expect(none.w.state().session).toBe('none');
    none.w.refused();
    expect(none.w.state().session).toBe('none');
    const open = watch([{ ...signedIn, authRequired: false, signedIn: true }]);
    await open.w.checkNow();
    expect(open.w.state().session).toBe('none');
  });
});
