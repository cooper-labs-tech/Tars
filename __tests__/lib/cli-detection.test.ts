import '../setup/home-guard';
import { describe, expect, it, vi } from 'vitest';
import { createDetectionStore, type DetectedCliPaths } from '@/lib/cli-detection';

/**
 * The window's copy of main's one detection of the CLIs (cliPaths:detect), which CLI Paths and Providers read
 * (useCliDetection). Written before the code. Every way it can be wrong:
 * 1. A page opened after another has the answer starts empty, so it says "looking" and shows no path until its own
 *    ask returns: CLI Paths opened again after Providers had Claude Code without a path where Providers said ready
 *    (the QA's train 3 of 2.0.4).
 * 2. Pages opened together each ask main: two asks where one answer serves both.
 * 3. A page opened later trusts the copy and never asks main again, so a path saved since in CLI Paths, which main
 *    detects anew, never reaches it.
 * 4. A refresh (detect now) loses to an older ask that answers after it, and the page shows the older answer, or the
 *    page that made the older ask is handed that older answer, which it shows last.
 * 5. A failed ask blanks a known answer, every CLI then "not found"; or, with no answer yet, never settles.
 */

const answer = (claude: string): DetectedCliPaths => ({ claude, codex: '/bin/codex', gemini: '' });

/** An ask whose answers the test hands out, in the order it chooses. */
function controlledAsk() {
  const pending: { refresh: boolean; resolve: (paths: DetectedCliPaths) => void; reject: (err: Error) => void }[] = [];
  const ask = vi.fn((refresh: boolean) => new Promise<DetectedCliPaths>((resolve, reject) => { pending.push({ refresh, resolve, reject }); }));
  return { ask, pending };
}

describe('createDetectionStore', () => {
  it('hands a page opened after an answer that answer at once (1)', async () => {
    const { ask, pending } = controlledAsk();
    const store = createDetectionStore(ask);
    expect(store.known()).toBeNull();
    const first = store.read(false);
    pending[0].resolve(answer('/sandbox/claude'));
    await first;
    expect(store.known()).toEqual(answer('/sandbox/claude'));
  });

  it('serves pages opened together with one ask (2)', async () => {
    const { ask, pending } = controlledAsk();
    const store = createDetectionStore(ask);
    const one = store.read(false);
    const two = store.read(false);
    expect(ask).toHaveBeenCalledTimes(1);
    pending[0].resolve(answer('/sandbox/claude'));
    expect(await one).toEqual(answer('/sandbox/claude'));
    expect(await two).toEqual(answer('/sandbox/claude'));
  });

  it('still asks main as a later page opens, and takes its newer answer (3)', async () => {
    const { ask, pending } = controlledAsk();
    const store = createDetectionStore(ask);
    const first = store.read(false);
    pending[0].resolve(answer('/sandbox/claude'));
    await first;
    const later = store.read(false);
    expect(ask).toHaveBeenCalledTimes(2);
    pending[1].resolve(answer('/saved/claude'));
    expect(await later).toEqual(answer('/saved/claude'));
    expect(store.known()).toEqual(answer('/saved/claude'));
  });

  it('keeps a refresh\'s answer over an older ask that answers after it (4)', async () => {
    const { ask, pending } = controlledAsk();
    const store = createDetectionStore(ask);
    const older = store.read(false);
    const refreshed = store.read(true);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(pending[1].refresh).toBe(true);
    pending[1].resolve(answer('/installed/since/claude'));
    pending[0].resolve(answer(''));
    expect(await refreshed).toEqual(answer('/installed/since/claude'));
    // The older ask's page is handed the refresh's answer too: what it gets is what it shows (setPaths).
    expect(await older).toEqual(answer('/installed/since/claude'));
    expect(store.known()).toEqual(answer('/installed/since/claude'));
  });

  it('keeps the last answer when an ask fails, and settles on none when there was none (5)', async () => {
    const { ask, pending } = controlledAsk();
    const store = createDetectionStore(ask);
    const none = store.read(false);
    pending[0].reject(new Error('main is gone'));
    expect(await none).toEqual({});
    expect(store.known()).toBeNull();
    const first = store.read(false);
    pending[1].resolve(answer('/sandbox/claude'));
    await first;
    const failed = store.read(false);
    pending[2].reject(new Error('main is gone'));
    expect(await failed).toEqual(answer('/sandbox/claude'));
    expect(store.known()).toEqual(answer('/sandbox/claude'));
  });
});
