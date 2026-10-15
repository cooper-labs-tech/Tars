/**
 * The steps Tars takes on its way out, run so that none of them can be lost to
 * an earlier one.
 *
 * `before-quit` was a plain sequence of eight calls, and two of them are the
 * only chance the app has to put something on disk: `saveAgents()` and
 * `flushBus()`, which writes the Chat journal once per turn of the event loop
 * and so has a turn's worth of messages still in memory when the quit lands.
 * Both sat behind calls that had no reason to throw, which is not the same as
 * cannot: a sequence in which the fourth statement decides whether the fifth
 * runs at all is one refactor away from losing JeanBrasse's conversation, and
 * nothing would say so. `flushBus()` was the fifth.
 *
 * So: the two that persist go first, every step is caught on its own, and a
 * step that throws is reported and the rest still run. The order among the
 * others is the one they had.
 */
export type ShutdownStep = [name: string, run: () => void];

export function runShutdownSteps(steps: ShutdownStep[]): void {
  for (const [name, run] of steps) {
    try {
      run();
    } catch (err) {
      console.error(`[quit] ${name} failed, continuing:`, err);
    }
  }
}
