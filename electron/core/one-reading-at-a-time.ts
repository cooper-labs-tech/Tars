/**
 * At most one reading at a time, and one per question (usage:tasks, 2026-10-13).
 *
 * The Usage page asks for the cost of each task again at each new figure,
 * before the last answer is in: on the machine's own data, 62 asks in 10
 * minutes, each a reading of the transcripts, overlapping, with the main
 * process's heap at 1 to 2.2 GB. Here, an ask for what is already being read,
 * or already waiting to be, gets that same answer; any other waits for the
 * reading in progress to end, and then reads. A reading that fails is its own
 * asks' failure only: the next reading starts all the same.
 */
export function oneReadingAtATime<Q, T>(read: (query: Q) => Promise<T>, keyOf: (query: Q) => string): (query: Q) => Promise<T> {
  /** The reading in progress, or the last one, its failure swallowed: never rejects. */
  let last: Promise<unknown> = Promise.resolve();
  /** What each question's asks share, until its answer is in. */
  const asked = new Map<string, Promise<T>>();
  return (query: Q) => {
    const key = keyOf(query);
    const shared = asked.get(key);
    if (shared) return shared;
    const mine: Promise<T> = last.then(() => read(query)).finally(() => {
      if (asked.get(key) === mine) asked.delete(key);
    });
    asked.set(key, mine);
    last = mine.catch(() => undefined);
    return mine;
  };
}
