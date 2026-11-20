// Where the delegating agent A stands with a line the CLI matrix typed into its terminal (e2e/cli-matrix.spec.ts),
// read from A's records since the line went in (the stand-ins' logs: e2e/fake-clis.mjs, e2e/fake-codex.mjs).
//
// A may still be busy when the line goes in: its turns from the pair before (B's reply, Tars's note that B finished)
// run first, and the line waits behind them, as a typed line waits in a real CLI. Only A's own turn on the line says
// whether it made the call (QA's I5 on #601 and #607, 20/11: any answer of A ended the spec's wait, and 20 cells of 9
// runs read "no answer within 45 s" about 2 s after the line, with the answer back seconds later).

/**
 * @param {Array<Record<string, unknown>>} records A's records since the line went in, oldest first
 * @param {string} line the line as typed
 * @param {{ tool: string, to: string }} call the call the line asks A to make
 * @returns {{ turnStartedAt: number | null, endedWithoutCall: string | null }}
 *   turnStartedAt: when A's turn on the line began, from its own record (ms), null while the line waits;
 *   endedWithoutCall: what A answered when its turn on the line ended without the call, or which question took the
 *   line; null while the turn runs, once it made the call, or before it begins.
 */
export function lineInA(records, line, call) {
  const holds = (value) => typeof value === 'string' && value.split('\n').some((l) => l.trim() === line);
  const at = records.findIndex((r) => (r.turn && (holds(r.text) || holds(r.head))) || holds(r.with) || holds(r.lost));
  if (at < 0) return { turnStartedAt: null, endedWithoutCall: null };
  const own = records[at];
  if (!own.turn) return { turnStartedAt: null, endedWithoutCall: `the line went to a question (${own.answered ?? 'one it asked'})` };
  const started = typeof own.t === 'string' ? Date.parse(own.t) : NaN;
  const turnStartedAt = Number.isFinite(started) ? started : null;
  // The turn's own records: up to the next turn's start (each stand-in runs its turns one after the other).
  const next = records.findIndex((r, i) => i > at && r.turn);
  const its = records.slice(at + 1, next < 0 ? undefined : next);
  if (its.some((r) => r.mcp && r.tool === call.tool && r.to === call.to)) return { turnStartedAt, endedWithoutCall: null };
  const end = its.find((r) => r.answer !== undefined);
  return { turnStartedAt, endedWithoutCall: end ? String(end.answer) : null };
}
