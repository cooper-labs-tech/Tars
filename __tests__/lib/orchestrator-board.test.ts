import '../setup/home-guard';
import { describe, expect, it } from 'vitest';
import {
  BOARD_LAYOUT_KEY,
  boardLayoutOf,
  boardOrchestrator,
  orchestratorBoxes,
  withBoardLayout,
} from '@/lib/orchestrator-board';

/**
 * The Dashboard's orchestrator layout (t-c4ac3055, the maintainer's idea of 18/10). Frames:
 * `Dashboard · orchestrator layout · 2 agents` to `· notes` in design/tars-redesign.pen.
 *
 * Written before the code, every way this unit can fail:
 * 1. a custom tab gets the layout: custom tabs keep the preset they were given;
 * 2. a board with its orchestrator alone gets it: two agents or more;
 * 3. a board with no orchestrator gets it: it keeps the grid;
 * 4. an orchestrator that is not first on the board is missed;
 * 5. two orchestrators: not the first of the board's order, or not the same one twice;
 * 6. the choice made for one project is read for another;
 * 7. a storage that is not what this wrote (not JSON, an array, a number, null) throws, or reads as the grid;
 * 8. a stored value other than the exact 'grid' reads as the grid;
 * 9. a project path named like an Object.prototype property reads an inherited value, or writes onto the prototype;
 * 10. writing a choice loses the other projects' choices, or keeps the default's own entry;
 * 11. writing over a storage that is not this one's throws;
 * 12. the column's cards are not the box a card of the 3x2 grid has (TerminalGrid: margin 8, no padding, the row
 *     floored at 80);
 * 13. a scrollbar that takes room is taken from the cards, not from the orchestrator;
 * 14. one agent alone in the column does not take the board's height;
 * 15. a board not measured yet (0, negative, not a number) gives boxes that are not numbers or below zero;
 * 16. a column with no agent gives boxes.
 */

const agent = (id: string, role?: 'orchestrator' | 'worker') => ({ id, role });

describe('boardOrchestrator: the board the orchestrator layout is for', () => {
  it('is a project board with an orchestrator and at least one other agent, the orchestrator its id (2, 4)', () => {
    expect(boardOrchestrator([agent('o', 'orchestrator'), agent('w', 'worker')], true)).toBe('o');
    expect(boardOrchestrator([agent('w1', 'worker'), agent('w2'), agent('o', 'orchestrator')], true)).toBe('o');
  });

  it('is never a custom tab, whatever it holds (1)', () => {
    expect(boardOrchestrator([agent('o', 'orchestrator'), agent('w', 'worker')], false)).toBeNull();
  });

  it('is not a board with its orchestrator alone, nor an empty one (2)', () => {
    expect(boardOrchestrator([agent('o', 'orchestrator')], true)).toBeNull();
    expect(boardOrchestrator([], true)).toBeNull();
  });

  it('is not a board with no orchestrator (3)', () => {
    expect(boardOrchestrator([agent('a', 'worker'), agent('b'), agent('c', 'worker')], true)).toBeNull();
  });

  it('takes the first orchestrator of the board when there are two (5)', () => {
    const board = [agent('w', 'worker'), agent('o1', 'orchestrator'), agent('o2', 'orchestrator')];
    expect(boardOrchestrator(board, true)).toBe('o1');
    expect(boardOrchestrator(board, true)).toBe('o1');
  });
});

describe('boardLayoutOf and withBoardLayout: the choice kept per project', () => {
  it('names its storage key', () => {
    expect(BOARD_LAYOUT_KEY).toMatch(/^tars-/);
  });

  it('reads the orchestrator layout for a project never switched, and the grid once picked, for that project only (6)', () => {
    expect(boardLayoutOf(null, '/p/a')).toBe('orchestrator');
    const stored = withBoardLayout(null, '/p/a', 'grid');
    expect(boardLayoutOf(stored, '/p/a')).toBe('grid');
    expect(boardLayoutOf(stored, '/p/b')).toBe('orchestrator');
  });

  it('reads a storage it did not write as the orchestrator layout, without throwing (7)', () => {
    for (const bad of ['', 'not json', '[]', '["/p/a"]', '42', 'null', '"grid"', '{"/p/a":', undefined]) {
      expect(boardLayoutOf(bad, '/p/a')).toBe('orchestrator');
    }
  });

  it('takes the exact word grid only (8)', () => {
    for (const value of ['Grid', 'GRID', ' grid', 'grid ', true, 1, null, {}, ['grid']]) {
      expect(boardLayoutOf(JSON.stringify({ '/p/a': value }), '/p/a')).toBe('orchestrator');
    }
  });

  it('never reads an inherited property, nor writes onto the prototype (9)', () => {
    for (const path of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(boardLayoutOf('{}', path)).toBe('orchestrator');
      const stored = withBoardLayout('{}', path, 'grid');
      expect(boardLayoutOf(stored, path)).toBe('grid');
      expect(boardLayoutOf(stored, '/p/other')).toBe('orchestrator');
    }
    expect(Object.keys(Object.prototype)).toEqual([]);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("keeps the other projects' choices, and drops the default's own entry (10)", () => {
    let stored = withBoardLayout(null, '/p/a', 'grid');
    stored = withBoardLayout(stored, '/p/b', 'grid');
    stored = withBoardLayout(stored, '/p/a', 'orchestrator');
    expect(boardLayoutOf(stored, '/p/a')).toBe('orchestrator');
    expect(boardLayoutOf(stored, '/p/b')).toBe('grid');
    expect(Object.keys(JSON.parse(stored))).toEqual(['/p/b']);
  });

  it('writes over a storage that is not its own without throwing (11)', () => {
    for (const bad of ['not json', '[]', '42', 'null', '"x"', undefined]) {
      const stored = withBoardLayout(bad, '/p/a', 'grid');
      expect(JSON.parse(stored)).toEqual({ '/p/a': 'grid' });
    }
  });
});

describe('orchestratorBoxes: the boxes of the orchestrator layout', () => {
  // TerminalGrid's 3x2 grid in a 1148 by 700 box: columns (1148 - 16) / 3, rows max(80, (700 - 24) / 2).
  const cell = { w: (1148 - 16) / 3, h: (700 - 24) / 2 };

  it("gives the column's cards the box of a card of the 3x2 grid, two in sight (12)", () => {
    const b = orchestratorBoxes(1148, 700, 5, 0)!;
    expect(b.cardWidth).toBeCloseTo(cell.w, 6);
    expect(b.cardHeight).toBeCloseTo(cell.h, 6);
    expect(b.boardHeight).toBeCloseTo(2 * cell.h + 8, 6);
    expect(b.columnWidth).toBeCloseTo(cell.w, 6);
    expect(b.orchestratorWidth).toBeCloseTo(2 * cell.w + 8, 6);
    expect(b.orchestratorWidth + 8 + b.columnWidth).toBeCloseTo(1148, 6);
  });

  it('floors a row at 80, as the grid does', () => {
    const b = orchestratorBoxes(900, 150, 3, 0)!;
    expect(b.cardHeight).toBe(80);
    expect(b.boardHeight).toBe(168);
  });

  it('takes a scrollbar that takes room from the orchestrator, never from the cards (13)', () => {
    const b = orchestratorBoxes(1148, 700, 5, 11)!;
    expect(b.cardWidth).toBeCloseTo(cell.w, 6);
    expect(b.columnWidth).toBeCloseTo(cell.w + 11, 6);
    expect(b.orchestratorWidth).toBeCloseTo(1148 - 8 - cell.w - 11, 6);
    for (const bad of [-4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(orchestratorBoxes(1148, 700, 5, bad)!.columnWidth).toBeCloseTo(cell.w, 6);
    }
  });

  it("gives one agent alone in the column the board's height (14)", () => {
    const b = orchestratorBoxes(1148, 700, 1, 0)!;
    expect(b.cardHeight).toBeCloseTo(b.boardHeight, 6);
    expect(orchestratorBoxes(1148, 700, 2, 0)!.cardHeight).toBeCloseTo(cell.h, 6);
  });

  it('gives no boxes for a board not measured yet, or a column with no agent (15, 16)', () => {
    for (const [w, h] of [[0, 700], [1148, 0], [-1, 700], [1148, -5], [Number.NaN, 700], [1148, Number.NaN], [Number.POSITIVE_INFINITY, 700]]) {
      expect(orchestratorBoxes(w, h, 3, 0)).toBeNull();
    }
    expect(orchestratorBoxes(1148, 700, 0, 0)).toBeNull();
    expect(orchestratorBoxes(1148, 700, -1, 0)).toBeNull();
  });
});
