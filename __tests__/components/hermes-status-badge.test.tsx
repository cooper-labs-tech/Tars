import '../setup/home-guard';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, settle, ofType, textOf, type Mount } from './hook-runtime';
import { HermesSection, gatewayStatus } from '../../src/components/Settings/HermesSection';
import { Button, StatusBadge, StatusSquare } from '../../src/components/ui';
import type { AppSettings } from '../../src/components/Settings/types';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * Settings > Hermes, the Status badge, for a gateway that answers but wants a
 * sign-in. Frame: `row Status · signed out` (zBCak) in `Settings · Connection`,
 * drawn in #264: "signed out" in `$status-waiting`, dot and word.
 *
 * The badge read `gatewayResult.success`, which the page sets to false for a
 * gateway that wants a sign-in, so it said "unreachable" in the error colour
 * for a gateway that had just answered with its version. The Chat tells the two
 * apart from the same IPC answer, `testConnection().needsSignIn`
 * (`needs_sign_in` in its GatewayState); so does the badge now.
 *
 * Written before the change, as the ways it can fail:
 * 1. a gateway that answers and wants a sign-in reads "unreachable", or in the
 *    error tone, or the word and the dot disagree on the tone;
 * 2. a gateway that does not answer stops reading "unreachable" in the error tone;
 * 3. a signed-in or open gateway stops reading "connected" in the running tone;
 * 4. "checking" while a probe runs, and "unknown" before any probe or after an
 *    edit to the form, are lost;
 * 5. signing out leaves the badge on "connected".
 */

describe('the status the badge reads', () => {
  it('is signed out, in the waiting tone, for a gateway that wants a sign-in (1)', () => {
    expect(gatewayStatus(false, { success: false }, true)).toEqual({ word: 'signed out', tone: 'waiting' });
  });

  it('is unreachable, in the error tone, for a gateway that does not answer (2)', () => {
    expect(gatewayStatus(false, { success: false }, false)).toEqual({ word: 'unreachable', tone: 'error' });
  });

  it('is connected, in the running tone, for a gateway that lets Tars in (3)', () => {
    expect(gatewayStatus(false, { success: true }, false)).toEqual({ word: 'connected', tone: 'running' });
  });

  it('is checking during a probe, and unknown with nothing probed (4)', () => {
    expect(gatewayStatus(true, null, false).word).toBe('checking');
    expect(gatewayStatus(true, { success: false }, true).word).toBe('checking');
    expect(gatewayStatus(false, null, false)).toEqual({ word: 'unknown', tone: 'idle' });
    // An edit clears the result: whatever the last probe said about signing in is no longer known.
    expect(gatewayStatus(false, null, true)).toEqual({ word: 'unknown', tone: 'idle' });
  });
});

type El = { type: unknown; props: Record<string, unknown> };
const g = globalThis as unknown as { window?: unknown };

let page: Mount<unknown> | null = null;
afterEach(() => {
  page?.unmount();
  page = null;
  delete g.window;
});

const REMOTE = { mode: 'remote', url: 'http://box.example:9119', authMode: 'oauth' };

/** The section on a saved remote connection, the gateway answering `test`. */
async function section(test: Record<string, unknown>) {
  g.window = {
    electronAPI: {
      hermes: {
        getConnection: async () => ({ connection: REMOTE, baseUrl: REMOTE.url, desktopConfigAvailable: false }),
        getConnectionInfo: async () => null,
        testConnection: async () => test,
        signOut: async () => ({ success: true }),
      },
    },
  };
  page = mount(() => HermesSection({ appSettings: {} as unknown as AppSettings, onSaveAppSettings: () => {}, onUpdateLocalSettings: () => {} }));
  await settle();
  return {
    badge: () => {
      const badge = (ofType(page!.result, StatusBadge) as unknown as El[]).find(b => b.props.tone !== undefined && ofType(b, StatusSquare).length > 0 && ['checking', 'connected', 'unreachable', 'unknown', 'signed out'].includes(textOf(b.props.children as never)))!;
      const dot = ofType(badge, StatusSquare)[0] as unknown as El;
      return { word: textOf(badge.props.children as never), tone: badge.props.tone, dot: dot.props.tone };
    },
    signOut: async () => {
      const button = (ofType(page!.result, Button) as unknown as El[]).find(b => textOf(b.props.children as never) === 'sign out')!;
      await (button.props.onClick as () => Promise<void>)();
      page!.rerender();
    },
  };
}

const ANSWERS = { baseUrl: REMOTE.url, status: 200, version: '0.20.0', authRequired: true, authProviders: ['basic'] };

describe('the badge on the page', () => {
  it('reads signed out, word and dot in the waiting tone, when the gateway wants a sign-in (1)', async () => {
    const s = await section({ ...ANSWERS, success: false, signedIn: false, needsSignIn: true });
    expect(s.badge()).toEqual({ word: 'signed out', tone: 'waiting', dot: 'waiting' });
  });

  it('reads unreachable in the error tone when the gateway does not answer (2)', async () => {
    const s = await section({ success: false, baseUrl: REMOTE.url, error: 'connect ECONNREFUSED' });
    expect(s.badge()).toEqual({ word: 'unreachable', tone: 'error', dot: 'error' });
  });

  it('reads connected when signed in, then signed out once the user signs out (3, 5)', async () => {
    const s = await section({ ...ANSWERS, success: true, signedIn: true, needsSignIn: false });
    expect(s.badge()).toEqual({ word: 'connected', tone: 'running', dot: 'running' });
    await s.signOut();
    expect(s.badge()).toEqual({ word: 'signed out', tone: 'waiting', dot: 'waiting' });
  });
});
