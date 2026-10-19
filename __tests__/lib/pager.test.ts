import { describe, it, expect } from 'vitest';
import { ROWS_CHOICES, ROWS_KEYS, pageButtons, pageCount, pageOf, pageRows, pagerShown, pagesShown, rangeText, rowsOf } from '../../src/lib/pager';

/**
 * The pager of Usage's three tables (2.0.4, the maintainer's request of 18/10; frames `Usage · pages · five rows a
 * card`, `· states`, `· narrowest window` and `· notes`): five rows a page by default, then 10, 25 or 50, picked per
 * card and remembered; the pages: every page up to seven, past seven the first, the last, the page shown and its two
 * neighbours with a gap between; the range said as "6 to 10 of 23".
 *
 * Written before the code. The ways it can fail:
 * 1. A stored choice that is not one of 5, 10, 25 and 50 (nothing, garbage, '7', '0', '-5', '5.5') pages at that
 *    size, or at nothing, rather than five.
 * 2. The pages miscounted: 23 rows at 5 must make 5 pages, 0 rows one empty page, never zero or a sixth.
 * 3. A page past the end, after rows went (a filter, new figures), shows nothing rather than the last page; a page
 *    before the first, or not a whole number, is taken as it is.
 * 4. The rows of a page cut wrong: page 5 of 23 at 5 must hold rows 21 to 23, page 1 rows 1 to 5.
 * 5. The page buttons: more than seven, the first or the last missing, the page shown missing, a gap where pages
 *    follow each other, or two gaps side by side.
 * 6. The range off by one ("0 to 5", "21 to 25 of 23"), or a range said for an empty table; one page reads "all 7",
 *    and a page of one row "6 of 6".
 * 7. A pager shown for five rows or fewer; page buttons shown when one page holds every row.
 * 8. Two cards sharing one remembered choice.
 */

describe('rowsOf: the remembered choice (1)', () => {
  it('reads each of the four choices', () => {
    expect(ROWS_CHOICES).toEqual([5, 10, 25, 50]);
    for (const n of ROWS_CHOICES) expect(rowsOf(String(n))).toBe(n);
  });
  it('reads anything else as five', () => {
    for (const bad of [null, undefined, '', 'ten', '7', '0', '-5', '5.5', '100', ' 10 ', '10rows']) expect(rowsOf(bad as string | null)).toBe(5);
  });
});

describe('pageCount and pageOf (2, 3)', () => {
  it('counts the pages', () => {
    expect(pageCount(23, 5)).toBe(5);
    expect(pageCount(25, 5)).toBe(5);
    expect(pageCount(26, 5)).toBe(6);
    expect(pageCount(5, 5)).toBe(1);
    expect(pageCount(0, 5)).toBe(1);
    expect(pageCount(12, 10)).toBe(2);
  });
  it('keeps a page inside the pages there are', () => {
    expect(pageOf(3, 23, 5)).toBe(3);
    expect(pageOf(9, 23, 5)).toBe(5);
    expect(pageOf(4, 6, 5)).toBe(2);
    expect(pageOf(0, 23, 5)).toBe(1);
    expect(pageOf(-2, 23, 5)).toBe(1);
    expect(pageOf(2.5, 23, 5)).toBe(2);
    expect(pageOf(Number.NaN, 23, 5)).toBe(1);
    expect(pageOf(3, 0, 5)).toBe(1);
  });
});

describe('pageRows (4)', () => {
  const rows = Array.from({ length: 23 }, (_, i) => i + 1);
  it('cuts the page asked for', () => {
    expect(pageRows(rows, 1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageRows(rows, 2, 5)).toEqual([6, 7, 8, 9, 10]);
    expect(pageRows(rows, 5, 5)).toEqual([21, 22, 23]);
    expect(pageRows(rows, 1, 25)).toEqual(rows);
  });
  it('gives the last page for a page past it, and the first for one before it', () => {
    expect(pageRows(rows, 8, 5)).toEqual([21, 22, 23]);
    expect(pageRows(rows, 0, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageRows([], 1, 5)).toEqual([]);
  });
});

describe('pageButtons (5)', () => {
  it('lists every page up to seven', () => {
    expect(pageButtons(1, 1)).toEqual([1]);
    expect(pageButtons(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageButtons(7, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it('past seven: the first, the last, the page shown and its neighbours, a gap between', () => {
    expect(pageButtons(4, 10)).toEqual([1, 'gap', 3, 4, 5, 'gap', 10]);
    expect(pageButtons(1, 10)).toEqual([1, 2, 'gap', 10]);
    expect(pageButtons(10, 10)).toEqual([1, 'gap', 9, 10]);
  });
  it('never a gap between pages that follow each other, nor two gaps together', () => {
    expect(pageButtons(2, 10)).toEqual([1, 2, 3, 'gap', 10]);
    expect(pageButtons(3, 10)).toEqual([1, 2, 3, 4, 'gap', 10]);
    expect(pageButtons(8, 10)).toEqual([1, 'gap', 7, 8, 9, 10]);
    for (let last = 8; last <= 30; last++) {
      for (let page = 1; page <= last; page++) {
        const list = pageButtons(page, last);
        expect(list.length).toBeLessThanOrEqual(7);
        expect(list[0]).toBe(1);
        expect(list[list.length - 1]).toBe(last);
        expect(list).toContain(page);
        list.forEach((item, i) => {
          if (item !== 'gap') return;
          expect(list[i + 1]).not.toBe('gap');
          expect((list[i + 1] as number) - (list[i - 1] as number)).toBeGreaterThan(1);
        });
      }
    }
  });
});

describe('rangeText (6)', () => {
  it('says which rows show, and of how many', () => {
    expect(rangeText(1, 5, 23)).toBe('1 to 5 of 23');
    expect(rangeText(2, 5, 23)).toBe('6 to 10 of 23');
    expect(rangeText(5, 5, 23)).toBe('21 to 23 of 23');
    expect(rangeText(9, 5, 23)).toBe('21 to 23 of 23');
  });
  it('names a page of one row by that row alone', () => {
    expect(rangeText(2, 5, 6)).toBe('6 of 6');
    expect(rangeText(3, 10, 21)).toBe('21 of 21');
  });
  it('says all when one page holds them, and nothing for an empty table', () => {
    expect(rangeText(1, 10, 7)).toBe('all 7');
    expect(rangeText(1, 5, 5)).toBe('all 5');
    expect(rangeText(1, 5, 0)).toBe('');
  });
});

describe('pagerShown and pagesShown (7)', () => {
  it('shows a pager over five rows only', () => {
    expect(pagerShown(0)).toBe(false);
    expect(pagerShown(5)).toBe(false);
    expect(pagerShown(6)).toBe(true);
  });
  it('shows page buttons only when the rows do not fit one page', () => {
    expect(pagesShown(7, 10)).toBe(false);
    expect(pagesShown(10, 10)).toBe(false);
    expect(pagesShown(11, 10)).toBe(true);
    expect(pagesShown(6, 5)).toBe(true);
  });
});

describe('ROWS_KEYS (8)', () => {
  it('gives each card its own remembered choice', () => {
    const keys = Object.values(ROWS_KEYS);
    expect(Object.keys(ROWS_KEYS).sort()).toEqual(['agents', 'perAgent', 'perModel']);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key).toMatch(/^usage\.rows\./);
  });
});
