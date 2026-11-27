import { describe, it, expect } from 'vitest';
import { diffLines, linesOf, isBinary } from '../../electron/services/line-diff';

/**
 * The line diff a turn's changes are counted with, and its lines followed to the final tree (trace feature B1).
 *
 * How it fails, written before the code (27/11):
 * 1. Identical texts count a change, or keep fewer lines than they hold.
 * 2. A pure insertion or deletion is miscounted.
 * 3. A changed line is not one removed and one added.
 * 4. The counts are not minimal: a line moved from the end to the start costs more than one removed and one added.
 * 5. A copy that differs only by line endings (CRLF, as git's autocrlf writes it) counts every line changed.
 * 6. A missing newline at the end of the file counts a changed line.
 * 7. A large file with a few changes takes seconds (the diff runs for every changed file of every turn).
 * 8. The kept pairs are not increasing on both sides, or pair lines that differ: following a line through the turns
 *    would then land on the wrong one.
 * 9. A binary file (a NUL byte) is split into lines and counted.
 */

describe('the line diff', () => {
  it('1: identical texts change nothing and keep every line', () => {
    const a = linesOf('one\ntwo\nthree\n');
    const d = diffLines(a, a);
    expect(d).toMatchObject({ added: 0, removed: 0 });
    expect(d.kept).toEqual([[0, 0], [1, 1], [2, 2]]);
  });

  it('2: a pure insertion and a pure deletion', () => {
    expect(diffLines(linesOf('a\nc\n'), linesOf('a\nb\nc\nd\n'))).toMatchObject({ added: 2, removed: 0 });
    expect(diffLines(linesOf('a\nb\nc\nd\n'), linesOf('a\nd\n'))).toMatchObject({ added: 0, removed: 2 });
    expect(diffLines([], linesOf('x\ny\n'))).toMatchObject({ added: 2, removed: 0, kept: [] });
    expect(diffLines(linesOf('x\ny\n'), [])).toMatchObject({ added: 0, removed: 2, kept: [] });
  });

  it('3: a changed line is one removed and one added', () => {
    expect(diffLines(linesOf('a\nb\nc\n'), linesOf('a\nB\nc\n'))).toMatchObject({ added: 1, removed: 1 });
  });

  it('4: the counts are minimal', () => {
    expect(diffLines(linesOf('a\nb\nc\n'), linesOf('c\na\nb\n'))).toMatchObject({ added: 1, removed: 1 });
  });

  it('5 and 6: line endings and a final newline change nothing', () => {
    expect(diffLines(linesOf('a\nb\n'), linesOf('a\r\nb\r\n'))).toMatchObject({ added: 0, removed: 0 });
    expect(diffLines(linesOf('a\nb'), linesOf('a\nb\n'))).toMatchObject({ added: 0, removed: 0 });
    expect(linesOf('')).toEqual([]);
    expect(linesOf('\n')).toEqual(['']);
  });

  it('7: 20,000 lines with a few changes take well under a second', () => {
    const a = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    const b = [...a];
    b.splice(100, 1, 'changed');
    b.splice(15_000, 0, 'inserted 1', 'inserted 2');
    b.splice(19_000, 3);
    const at = Date.now();
    const d = diffLines(a, b);
    expect(Date.now() - at).toBeLessThan(500);
    expect(d).toMatchObject({ added: 3, removed: 4 });
  });

  it('8: the kept pairs increase on both sides and pair equal lines', () => {
    const a = linesOf('k\nx\nk\ny\nk\nz\n');
    const b = linesOf('k\ny\nk\nw\nk\nz\nk\n');
    const d = diffLines(a, b);
    let last: [number, number] = [-1, -1];
    for (const [i, j] of d.kept) {
      expect(i).toBeGreaterThan(last[0]);
      expect(j).toBeGreaterThan(last[1]);
      expect(a[i]).toBe(b[j]);
      last = [i, j];
    }
    expect(d.kept.length).toBe(a.length - d.removed);
    expect(d.kept.length).toBe(b.length - d.added);
  });

  it('9: a binary file is not text', () => {
    expect(isBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]))).toBe(true);
    expect(isBinary(Buffer.from('plain text\nwith lines\n'))).toBe(false);
    expect(isBinary(Buffer.from('é à ü\n'))).toBe(false);
  });
});
