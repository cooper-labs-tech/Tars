import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import {
  BOX_H,
  BOX_W,
  FIT_MARGIN,
  ZOOM_MAX,
  ZOOM_MIN,
  fitZoom,
  keepAnchor,
  layoutRings,
  ringOrder,
  stageBox,
  zoomBounds,
} from '../../src/lib/graph-layout';

/**
 * Where the boxes of Brain's agent graph go, and how much of it the canvas
 * shows (JeanBrasse, 18/10, for 2.0.4: about fifty agents, and even at 25 %
 * the circle was too large to see or to move around in). Frames: `Brain ·
 * Agents`, and `Brain · Agents · fifty agents, fitted`. Written before the
 * code. How it can fail:
 * 1. two boxes overlap, so one label hides another: a ring placed too close to
 *    the one inside it, or two boxes of a ring closer than a box is wide. Four
 *    agents around one project did, on main: the boxes left and right of the
 *    project sat 132 px from its middle, and a box is 176 px wide;
 * 2. the drawing grows as the square of its boxes: every box of a ring on one
 *    circle makes the circle's width follow the count, so 997 memory files
 *    drew a ring 65,000 px wide, a sixth of it at 25 %. Its width should
 *    follow the square root of the count, as its area follows the count;
 * 3. a node lost, placed twice, or two nodes on one spot;
 * 4. the order: a ring's nodes not going round clockwise from the top in the
 *    order given, so an agent's files scatter rather than sit together; a ring
 *    not outside the one before it; a ring of few boxes starting anywhere but
 *    the top, so a lone skill of the first agent lands across the graph from
 *    it; several projects with one in the middle and the others off to a side;
 * 5. the same nodes giving another picture from one opening to the next;
 * 6. a box outside the drawing's bounds, or bounds wider than the boxes, which
 *    makes the fit smaller than it needs to be;
 * 7. no node, a single node, or an empty ring between two others: a throw, or
 *    NaN in a position or a bound;
 * 8. the fit: a small graph magnified past 100 %, no margin left, a graph that
 *    still does not fit, or a canvas with no room yet (a tab hidden) fitted to
 *    a zoom of 0, a negative one or NaN;
 * 9. the zoom range: a floor above the fit, so nothing can show the whole
 *    graph (the fixed 25 % of main), or a ceiling under 100 %;
 * 10. the stage: the graph's corner at a negative offset once it is larger
 *     than the canvas, so its left and top cannot be scrolled to, or not
 *     centred while it is smaller;
 * 11. a zoom at the pointer or at the middle moving the point under it, or
 *     scrolling past the stage's ends;
 * 13. the canvas's overlays: at fit, a box under the zoom controls in the top
 *     right corner or under the legend in the bottom left one, its name half
 *     hidden and a click on it landing on the controls: the bands start at
 *     the top and the bounds are tight, so a few boxes sit in the corners (the
 *     QA's L1 of #454: 422 fits where main had none);
 * 12. the order round each ring: agents listed as they came rather than by
 *     their project's place in the middle, so a project's agents scatter round
 *     the ring and its edges cross the graph; a file or a tool not next to the
 *     first agent that reads it, or in no steady order beside it; a node no
 *     agent reads put first; a ring missing from the middle shifting the rings
 *     after it inwards. On main the owner was found by reading every edge for
 *     each comparison of the sort: 997 files and 7,000 edges took seconds.
 */

type Box = { id: string; x: number; y: number };

const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
/** The graph of a fleet like the maintainer's: 7 projects, 50 agents, 997 memory files and 8 instruction files, 10 skills and 7 servers. */
const FLEET = [names('project', 7), names('agent', 50), names('file', 1005), names('tool', 17)];

function boxes(rings: string[][]): Box[] {
  const { positions } = layoutRings(rings);
  return [...positions].map(([id, p]) => ({ id, ...p }));
}

function overlaps(list: Box[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (Math.abs(a.x - b.x) < BOX_W && Math.abs(a.y - b.y) < BOX_H) found.push(`${a.id} and ${b.id}`);
    }
  }
  return found;
}

/** A box's distance from the point the rings go round. */
function radius(layout: ReturnType<typeof layoutRings>, id: string): number {
  const p = layout.positions.get(id)!;
  return Math.hypot(p.x - layout.centre.x, p.y - layout.centre.y);
}

/** Round that point clockwise from the top, in [0, 2π). */
function angle(layout: ReturnType<typeof layoutRings>, id: string): number {
  const p = layout.positions.get(id)!;
  const a = Math.atan2(p.x - layout.centre.x, -(p.y - layout.centre.y));
  return a < 0 ? a + 2 * Math.PI : a;
}

describe('no two boxes overlap (1)', () => {
  it('keeps four agents clear of the one project they sit around', () => {
    expect(overlaps(boxes([['project'], names('agent', 4)]))).toEqual([]);
  });

  it('keeps every box clear in small and large graphs alike', () => {
    for (const rings of [
      [['p'], names('agent', 1)],
      [names('project', 2), names('agent', 6), ['skill']],
      [names('project', 3), names('agent', 9), names('file', 12), names('tool', 3)],
      FLEET,
    ]) {
      expect(overlaps(boxes(rings)), `${rings.map(r => r.length).join('/')}`).toEqual([]);
    }
  });
});

describe('the drawing follows the square root of its boxes (2)', () => {
  it('doubles its width, not quadruples it, for four times the boxes', () => {
    const small = layoutRings([['p'], names('file', 250)]);
    const large = layoutRings([['p'], names('file', 1000)]);
    expect(large.width / small.width).toBeLessThan(2.4);
    expect(large.height / small.height).toBeLessThan(2.4);
  });

  it('draws the fleet in a few thousand pixels, not 65,000', () => {
    const fleet = layoutRings(FLEET);
    expect(fleet.width).toBeLessThan(6_500);
    expect(fleet.height).toBeLessThan(6_500);
  });
});

describe('every node once (3)', () => {
  it('places each node of the input, once, each on its own spot', () => {
    const list = boxes(FLEET);
    expect(list.map(b => b.id).sort()).toEqual(FLEET.flat().sort());
    expect(new Set(list.map(b => `${b.x},${b.y}`)).size).toBe(list.length);
  });
});

describe('the order and the rings (4)', () => {
  it('goes round each ring clockwise from the top, in the order given', () => {
    const layout = layoutRings([['p'], names('agent', 50), names('file', 300)]);
    for (const ring of [names('agent', 50), names('file', 300)]) {
      const angles = ring.map(id => angle(layout, id));
      for (let i = 1; i < angles.length; i++) expect(angles[i], `${ring[i]}`).toBeGreaterThanOrEqual(angles[i - 1]);
    }
  });

  it('puts every box of a ring further out than every box of the ring inside it', () => {
    const layout = layoutRings(FLEET);
    for (let r = 1; r < FLEET.length; r++) {
      const inner = Math.max(...FLEET[r - 1].map(id => radius(layout, id)));
      const outer = Math.min(...FLEET[r].map(id => radius(layout, id)));
      expect(outer, `ring ${r}`).toBeGreaterThan(inner);
    }
  });

  it('puts a lone node of the middle ring where the rings go round', () => {
    const layout = layoutRings([['p'], names('agent', 5)]);
    expect(radius(layout, 'p')).toBeCloseTo(0, 6);
  });

  it('puts several nodes of the middle ring around it, none on it, evenly', () => {
    const layout = layoutRings([names('project', 2), names('agent', 6)]);
    expect(radius(layout, 'project-0')).toBeGreaterThan(0);
    expect(radius(layout, 'project-1')).toBeCloseTo(radius(layout, 'project-0'), 6);
    expect(Math.abs(angle(layout, 'project-1') - angle(layout, 'project-0'))).toBeCloseTo(Math.PI, 6);
  });

  it('starts every ring at the top, so a lone node of a ring sits up there by the first agent', () => {
    const layout = layoutRings([['p'], names('agent', 6), ['skill']]);
    const top = (id: string) => Math.min(angle(layout, id), 2 * Math.PI - angle(layout, id));
    expect(top('agent-0')).toBeLessThan(Math.PI / 3);
    expect(top('skill')).toBeLessThan(Math.PI / 3);
  });
});

describe('the same picture every time (5)', () => {
  it('places the same nodes on the same spots', () => {
    expect(layoutRings(FLEET)).toEqual(layoutRings(FLEET));
  });
});

describe('the drawing\'s bounds (6)', () => {
  it('holds every box, and is no larger than the boxes', () => {
    for (const rings of [[['p'], names('agent', 4)], FLEET]) {
      const layout = layoutRings(rings);
      const list = boxes(rings);
      expect(Math.min(...list.map(b => b.x - BOX_W / 2))).toBeCloseTo(0, 6);
      expect(Math.min(...list.map(b => b.y - BOX_H / 2))).toBeCloseTo(0, 6);
      expect(Math.max(...list.map(b => b.x + BOX_W / 2))).toBeCloseTo(layout.width, 6);
      expect(Math.max(...list.map(b => b.y + BOX_H / 2))).toBeCloseTo(layout.height, 6);
    }
  });
});

describe('no node, one node, an empty ring (7)', () => {
  it('draws nothing for no node', () => {
    const layout = layoutRings([]);
    expect(layout.positions.size).toBe(0);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
    expect(layoutRings([[], []]).positions.size).toBe(0);
  });

  it('draws one box for one node', () => {
    const layout = layoutRings([['only']]);
    expect(layout).toEqual({
      positions: new Map([['only', { x: BOX_W / 2, y: BOX_H / 2 }]]), width: BOX_W, height: BOX_H, centre: { x: BOX_W / 2, y: BOX_H / 2 },
    });
  });

  it('skips an empty ring without a NaN', () => {
    const list = boxes([[], ['p'], [], names('agent', 3), [], ['tool']]);
    expect(list).toHaveLength(5);
    for (const b of list) {
      expect(Number.isFinite(b.x) && Number.isFinite(b.y), b.id).toBe(true);
    }
    expect(overlaps(list)).toEqual([]);
  });
});

describe('the fit (8)', () => {
  it('never magnifies a graph smaller than the canvas', () => {
    expect(fitZoom({ width: 400, height: 300 }, { width: 1100, height: 700 })).toBe(1);
  });

  it('scales a larger graph to the canvas less its margins, on the tighter side: 52 px kept above, 56 below', () => {
    const zoom = fitZoom({ width: 5_000, height: 4_000 }, { width: 1_100, height: 700 })!;
    expect(zoom).toBeCloseTo((700 - 52 - 56) / 4_000, 10);
    expect(5_000 * zoom + 2 * FIT_MARGIN).toBeLessThanOrEqual(1_100);
    expect(4_000 * zoom + 52 + 56).toBeLessThanOrEqual(700 + 1e-9);
  });

  it('gives no zoom while the canvas has no room, and 100 % for no graph', () => {
    expect(fitZoom({ width: 500, height: 500 }, { width: 0, height: 0 })).toBeNull();
    expect(fitZoom({ width: 500, height: 500 }, { width: 2 * FIT_MARGIN, height: 600 })).toBeNull();
    expect(fitZoom({ width: 500, height: 500 }, { width: 900, height: 52 + 56 })).toBeNull();
    expect(fitZoom({ width: 0, height: 0 }, { width: 900, height: 600 })).toBe(1);
  });
});

describe('the zoom range (9)', () => {
  it('reaches down to the fit, and to 25 % at least, and up to 200 %', () => {
    expect(zoomBounds(0.05)).toEqual({ min: 0.05, max: ZOOM_MAX });
    expect(zoomBounds(0.6)).toEqual({ min: ZOOM_MIN, max: ZOOM_MAX });
    expect(zoomBounds(1)).toEqual({ min: ZOOM_MIN, max: ZOOM_MAX });
    expect(ZOOM_MIN).toBe(0.25);
    expect(ZOOM_MAX).toBeGreaterThanOrEqual(1);
  });
});

describe('the stage (10)', () => {
  it('centres a graph smaller than the canvas between its margins', () => {
    expect(stageBox({ width: 400, height: 200 }, { width: 1_000, height: 600 }, 1)).toEqual({ width: 1_000, height: 600, left: 300, top: 52 + (600 - 108 - 200) / 2 });
  });

  it('keeps the margins round a graph larger than the canvas, never a negative offset', () => {
    expect(stageBox({ width: 3_000, height: 2_000 }, { width: 1_000, height: 600 }, 1)).toEqual({
      width: 3_000 + 2 * FIT_MARGIN, height: 2_000 + 52 + 56, left: FIT_MARGIN, top: 52,
    });
    expect(stageBox({ width: 3_000, height: 200 }, { width: 1_000, height: 600 }, 0.5)).toEqual({
      width: 1_500 + 2 * FIT_MARGIN, height: 600, left: FIT_MARGIN, top: 52 + (600 - 108 - 100) / 2,
    });
  });
});

describe('a zoom keeps the point under it (11)', () => {
  const graph = { width: 4_000, height: 4_000 };
  const view = { width: 1_000, height: 600 };

  it('keeps the graph point under the pointer where it was', () => {
    const from = { zoom: 0.5, box: stageBox(graph, view, 0.5) };
    const to = { zoom: 1, box: stageBox(graph, view, 1) };
    const scroll = { left: 400, top: 300 };
    const anchor = { x: 250, y: 120 };
    const next = keepAnchor(anchor, scroll, view, from, to);
    const before = { x: (scroll.left + anchor.x - from.box.left) / from.zoom, y: (scroll.top + anchor.y - from.box.top) / from.zoom };
    const after = { x: (next.left + anchor.x - to.box.left) / to.zoom, y: (next.top + anchor.y - to.box.top) / to.zoom };
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('never scrolls past either end of the stage', () => {
    const from = { zoom: 1, box: stageBox(graph, view, 1) };
    const to = { zoom: 0.25, box: stageBox(graph, view, 0.25) };
    const next = keepAnchor({ x: 0, y: 0 }, { left: 0, top: 0 }, view, from, to);
    expect(next.left).toBeGreaterThanOrEqual(0);
    expect(next.top).toBeGreaterThanOrEqual(0);
    const far = keepAnchor({ x: 1_000, y: 600 }, { left: 3_048 - 1_000, top: 3_048 - 600 }, view, to, from);
    expect(far.left).toBeLessThanOrEqual(from.box.width - view.width);
    expect(far.top).toBeLessThanOrEqual(from.box.height - view.height);
  });
});

describe('the order round each ring (12)', () => {
  const nodes = [
    { id: 'p:a', ring: 0, label: 'a' }, { id: 'p:b', ring: 0, label: 'b' },
    { id: 'late', ring: 1, label: 'late' }, { id: 'first', ring: 1, label: 'first' }, { id: 'second', ring: 1, label: 'second' },
    { id: 'f:zeta', ring: 2, label: 'zeta' }, { id: 'f:alpha', ring: 2, label: 'alpha' }, { id: 'f:own', ring: 2, label: 'own' },
    { id: 'f:none', ring: 2, label: 'aaa' },
    { id: 't:mcp', ring: 3, label: 'mcp' }, { id: 't:skill', ring: 3, label: 'skill' },
  ];
  const edges = [
    { source: 'p:b', target: 'late' }, { source: 'p:a', target: 'first' }, { source: 'p:a', target: 'second' },
    { source: 'late', target: 'f:own' },
    { source: 'second', target: 'f:zeta' }, { source: 'second', target: 'f:alpha' }, { source: 'first', target: 'f:zeta' },
    { source: 'late', target: 't:mcp' }, { source: 'first', target: 't:mcp' }, { source: 'second', target: 't:skill' },
  ];

  it('keeps the middle in the order given, and puts each project\'s agents together, in its place', () => {
    const rings = ringOrder(nodes, edges);
    expect(rings[0]).toEqual(['p:a', 'p:b']);
    expect(rings[1]).toEqual(['first', 'second', 'late']);
  });

  it('puts a file or a tool beside the first agent that reads it, by name beside the same agent, and one nobody reads last', () => {
    const rings = ringOrder(nodes, edges);
    expect(rings[2]).toEqual(['f:zeta', 'f:alpha', 'f:own', 'f:none']);
    expect(rings[3]).toEqual(['t:mcp', 't:skill']);
  });

  it('keeps a ring missing from the middle as an empty ring, so the rings after it stay outside', () => {
    expect(ringOrder([{ id: 'p', ring: 0, label: 'p' }, { id: 't', ring: 3, label: 't' }], [])).toEqual([['p'], [], [], ['t']]);
    expect(ringOrder([], [])).toEqual([]);
  });

  it('orders a thousand files and seven thousand edges in well under a second', () => {
    const many = [
      ...names('project', 7).map(id => ({ id, ring: 0, label: id })),
      ...names('agent', 50).map(id => ({ id, ring: 1, label: id })),
      ...names('file', 1005).map(id => ({ id, ring: 2, label: id })),
    ];
    const links = [
      ...names('agent', 50).map((id, i) => ({ source: `project-${i % 7}`, target: id })),
      ...names('agent', 50).flatMap((id, i) => names('file', 1005).filter((_, f) => f % 7 === i % 7).map(target => ({ source: id, target }))),
    ];
    expect(links.length).toBeGreaterThan(7_000);
    const started = performance.now();
    const rings = ringOrder(many, links);
    expect(performance.now() - started).toBeLessThan(500);
    expect(rings[2]).toHaveLength(1005);
  });
});

describe('clear of the canvas\'s overlays at fit (13)', () => {
  // As AgentKnowledgeGraph draws them: the zoom controls 8 px from the top right
  // corner, 170 x 36; the legend's two 11 px lines 12 px from the bottom left one.
  const underOverlays = (rings: string[][], view: { width: number; height: number }): string[] => {
    const layout = layoutRings(rings);
    const zoom = fitZoom(layout, view);
    if (zoom === null) return [];
    const box = stageBox(layout, view, zoom);
    const overlays: Array<[string, { l: number; t: number; r: number; b: number }]> = [
      ['the zoom controls', { l: view.width - 8 - 170, t: 8, r: view.width - 8, b: 8 + 36 }],
      ['the legend', { l: 12, t: view.height - 12 - 36, r: 12 + 210, b: view.height - 12 }],
    ];
    const hits: string[] = [];
    for (const [id, p] of layout.positions) {
      const l = box.left + (p.x - BOX_W / 2) * zoom;
      const t = box.top + (p.y - BOX_H / 2) * zoom;
      const r = l + BOX_W * zoom;
      const b = t + BOX_H * zoom;
      for (const [name, o] of overlays) {
        if (l < o.r && r > o.l && t < o.b && b > o.t) hits.push(`${id} under ${name} in ${view.width}x${view.height}`);
      }
    }
    return hits;
  };
  // The canvas at 1440x900 and 1180x760 in the classic shell and in the new
  // interface's card, and narrow, tall and wide ones.
  const VIEWS = [[1172, 757], [912, 617], [1024, 589], [765, 449], [520, 800], [1600, 1000]].map(([width, height]) => ({ width, height }));

  it('keeps every box of the QA\'s small fleet clear of both: one project, three agents, its CLAUDE.md, two servers', () => {
    const rings = [['project'], names('agent', 3), ['claude-md'], names('server', 2)];
    expect(VIEWS.flatMap(view => underOverlays(rings, view))).toEqual([]);
  });

  it('keeps every box clear of both for small and large graphs in every canvas', () => {
    const hits: string[] = [];
    for (const projects of [1, 2, 3]) {
      for (const agents of [1, 2, 3, 4, 6, 8, 12, 50]) {
        for (const files of [0, 1, 5, 40]) {
          for (const tools of [0, 2, 5]) {
            const rings = [names('project', projects), names('agent', agents), names('file', files), names('tool', tools)];
            for (const view of VIEWS) hits.push(...underOverlays(rings, view));
          }
        }
      }
    }
    hits.push(...VIEWS.flatMap(view => underOverlays(FLEET, view)));
    expect(hits.slice(0, 5), `${hits.length} boxes under an overlay`).toEqual([]);
  });
});
