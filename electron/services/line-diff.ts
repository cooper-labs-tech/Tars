/**
 * A line diff (Myers), to count what a traced turn changed and follow its lines to the final tree (turn-workspace.ts).
 *
 * - Lines are split on LF, a CR before it dropped and a missing final newline ignored, so a CRLF copy of an LF file
 *   (git's autocrlf) and a file without its last newline read as unchanged.
 * - The common head and tail are taken off first; the middle is diffed with Myers' O((N+M)D) algorithm, up to
 *   MAX_EDITS differences. Past that the middle keeps no line: every line of it counts as removed and added, an upper
 *   bound, for a file rewritten through.
 * - `kept` pairs each unchanged line's index in the old text with its index in the new one, increasing on both sides.
 * __tests__/electron/line-diff.test.ts says each way this goes wrong.
 */

export interface LineDiff {
  added: number;
  removed: number;
  /** [old index, new index] of every line kept, increasing on both sides. */
  kept: Array<[number, number]>;
}

/** Past this many differences in the middle of two texts, no line of it is matched (bounds time and memory). */
const MAX_EDITS = 1000;

export function linesOf(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** git's own test: a NUL byte in the first 8000 bytes makes a file binary. */
export function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

/** Myers' forward search on interned lines; the kept pairs, or null past `maxEdits`. */
function myers(a: Int32Array, b: Int32Array, maxEdits: number): Array<[number, number]> | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(maxEdits, n + m);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, offset, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], offset: number, n: number, m: number): Array<[number, number]> {
  const kept: Array<[number, number]> = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { kept.push([x - 1, y - 1]); x--; y--; }
    if (d > 0) { x = prevX; y = prevY; }
  }
  return kept.reverse();
}

export function diffLines(a: string[], b: string[], maxEdits = MAX_EDITS): LineDiff {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ids = new Map<string, number>();
  const intern = (s: string) => { let id = ids.get(s); if (id === undefined) { id = ids.size; ids.set(s, id); } return id; };
  const midA = Int32Array.from(a.slice(head, a.length - tail), intern);
  const midB = Int32Array.from(b.slice(head, b.length - tail), intern);
  const middle = midA.length && midB.length ? myers(midA, midB, maxEdits) ?? [] : [];
  const kept: Array<[number, number]> = [];
  for (let i = 0; i < head; i++) kept.push([i, i]);
  for (const [i, j] of middle) kept.push([head + i, head + j]);
  for (let t = tail; t > 0; t--) kept.push([a.length - t, b.length - t]);
  return { added: b.length - kept.length, removed: a.length - kept.length, kept };
}
