import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { agentMarkBits, agentMarkCells } from '../../src/lib/agent-mark';

/**
 * The agent mark, `src/lib/agent-mark.ts`: an agent's name in, sixteen
 * squares out. Every way it can fail, written before the code:
 *
 * 1. The same name draws two marks: something other than the name (a clock,
 *    a random draw, the locale, the order of calls) reaches the result.
 * 2. The app and the design disagree: `Tars-QA` lights other squares in the
 *    running app than in the `Agent mark` frame, because the hash drifted
 *    from the one the frames were drawn with.
 * 3. A mark reads as nothing or as a block: fewer than 3, or more than 6, of
 *    the 8 squares of its left half are lit.
 * 4. The mark is lopsided: a row's right half does not mirror its left.
 * 5. An empty name, or one with a character beyond the Basic Multilingual
 *    Plane, throws or comes out with the wrong number of squares.
 * 6. The team JeanBrasse looks at every day cannot be told apart: two of the six
 *    agents of tars share a mark.
 */

const TARS = ['Tars-Orchestrator', 'Tars-Frontend', 'Tars-Backend', 'Tars-QA', 'Tars - Audit Engineer', 'Tars - Database Engineer'];
/** The legend of the frame, in its order. */
const FLEET = ['Sak-Orchestrator', 'Sak-Database', 'Sak-Scrapers', 'Sak-QA', '1212-Frontend', '1212-Backend', 'Parallel-QA', 'Drone-Orchestrator', 'Avionics & Autonomy'];
const MANY = [...TARS, ...FLEET, '', 'a', 'Agent 🦊', '𝒜gent', 'エージェント', ...Array.from({ length: 4000 }, (_, i) => `agent-${i}`)];

type PenNode = { type?: string; name?: string; content?: string; children?: PenNode[] };

/** The squares a drawn mark lights, row by row, read off the rectangles the pen CLI named `on` and `off`. */
function drawn(mark: PenNode): boolean[] {
  const grid = mark.children?.[0];
  return (grid?.children ?? []).flatMap(row => (row.children ?? []).map(cell => cell.name === 'on'));
}

function find(node: PenNode, pred: (n: PenNode) => boolean): PenNode[] {
  const out: PenNode[] = pred(node) ? [node] : [];
  for (const child of node.children ?? []) out.push(...find(child, pred));
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe('the agent mark', () => {
  it('is the name and nothing else: the same squares on every call, with the clock and the dice taken away', () => {
    const before = TARS.map(agentMarkCells);
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('the mark read Math.random'); });
    vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('the mark read the clock'); });
    expect([...TARS].reverse().map(agentMarkCells).reverse()).toEqual(before);
  });

  it('lights the squares the Agent mark frame draws, for the six agents of tars and the fleet legend', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'design/tars-redesign.pen'), 'utf8')) as PenNode;
    const frame = doc.children!.find(r => r.name === 'Agent mark')!;
    for (const name of TARS) {
      const row = find(frame, n => n.name === `row ${name}`)[0];
      const mark = find(row, n => n.name === 'agent mark')[0];
      expect(drawn(mark), name).toEqual(agentMarkCells(name));
    }
    const legend = find(frame, n => n.name === 'legend')[0];
    expect(legend.children!.map(drawn)).toEqual(FLEET.map(agentMarkCells));
  });

  // The names that fail are listed, then asserted once: an expect per name and
  // per row, some 44,000 of them, took these two past the 5 s default under
  // load (QA, the gate of #358, 2026-10-12).
  it('lights 3 to 6 of the 8 squares of its left half, for any name', () => {
    const wrong: string[] = [];
    for (const name of MANY) {
      const lit = agentMarkBits(name).filter(Boolean).length;
      if (lit < 3 || lit > 6) wrong.push(`${JSON.stringify(name)} lights ${lit}`);
    }
    expect(wrong).toEqual([]);
  });

  it('mirrors each row: the right half is the left one turned over', () => {
    const lopsided: string[] = [];
    for (const name of MANY) {
      const cells = agentMarkCells(name);
      if (cells.length !== 16) {
        lopsided.push(`${JSON.stringify(name)} has ${cells.length} squares`);
        continue;
      }
      for (let r = 0; r < 4; r++) {
        if (cells[r * 4 + 3] !== cells[r * 4] || cells[r * 4 + 2] !== cells[r * 4 + 1]) lopsided.push(`${JSON.stringify(name)} row ${r}`);
      }
    }
    expect(lopsided).toEqual([]);
  });

  it('draws an empty name and names beyond the Basic Multilingual Plane as the pen CLI draws them', () => {
    // What the prelude the frames were drawn with gives for these names, read
    // off the pen CLI on 2026-09-23. It walks a name by code point, so the fox
    // and the mathematical A are one character each, not two UTF-16 halves.
    const PEN: Array<[string, string]> = [
      ['', '10101110'],
      ['a', '00100011'],
      ['Agent 🦊', '01101110'],
      ['𝒜gent', '11001010'],
      ['エージェント', '10101010'],
      ['Tars-QA', '10101000'],
    ];
    for (const [name, bits] of PEN) {
      expect(agentMarkBits(name).join(''), JSON.stringify(name)).toBe(bits);
      expect(agentMarkCells(name)).toHaveLength(16);
    }
  });

  it('tells the six agents of tars apart', () => {
    const marks = new Set(TARS.map(name => agentMarkCells(name).map(Number).join('')));
    expect(marks.size).toBe(TARS.length);
  });
});
