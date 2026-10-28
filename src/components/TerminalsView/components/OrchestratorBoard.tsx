'use client';

import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { GRID_GAP, orchestratorBoxes } from '@/lib/orchestrator-board';

/**
 * The orchestrator layout (`Dashboard · orchestrator layout · 2 agents` to `· notes`): the orchestrator's card on the
 * left, two thirds of the board, and every other agent's in a column on the right that scrolls, each the card of today
 * as `panel` draws it. The column's cards keep the box a card of the 3x2 grid has (orchestratorBoxes), so the fit
 * addon gives their terminals the grid's columns and rows; a scrollbar that takes room, as Windows and Linux draw one,
 * is measured and taken from the orchestrator.
 *
 * The wheel over a card of the column scrolls the column, not that card's terminal, until the card has been clicked
 * (the owner, 28/10: an agent at work took the wheel, and the column could no longer be scrolled past it). Clicked, its
 * terminal takes the wheel as any terminal does, until a click lands anywhere else. The orchestrator's terminal takes
 * the wheel without a click, as before. Nothing new is drawn: the clicked card is the focused one, whose box the panel
 * already draws.
 */
function OrchestratorBoard({ width, height, orchestratorId, columnIds, panel }: {
  /** TerminalGrid's own box. */
  width: number;
  height: number;
  orchestratorId: string;
  /** Every other agent on the board, in its order. */
  columnIds: readonly string[];
  panel: (agentId: string) => ReactNode;
}) {
  const columnRef = useRef<HTMLDivElement>(null);
  const [scrollbar, setScrollbar] = useState(0);
  // The column's card last clicked, whose terminal takes the wheel; none until one is clicked, and none again once a
  // click lands outside it. A ref: the wheel reads it as it comes, and nothing is drawn from it.
  const holder = useRef<string | null>(null);
  const boxes = orchestratorBoxes(width, height, columnIds.length, scrollbar);
  const hasColumn = boxes !== null;

  // The column's scrollbar: none where the system overlays it (macOS by default) or while its cards fit, its width where
  // it takes room. Read whenever the column's content box changes, which a scrollbar coming or going does, whatever
  // brought it: more cards, a shorter window, a stylesheet or a system setting. Read after each draw of the board only,
  // a scrollbar that came without one went unseen, and hid the right edge of every card.
  useLayoutEffect(() => {
    const column = columnRef.current;
    if (!column) return;
    const read = () => setScrollbar(column.offsetWidth - column.clientWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(column);
    return () => observer.disconnect();
  }, [hasColumn]);

  // Any press in the window: the column's card it lands in now holds the wheel, or none does.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const card = e.target instanceof Element ? e.target.closest('[data-board-card]') : null;
      holder.current = card && columnRef.current?.contains(card) ? card.getAttribute('data-board-card') : null;
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, []);

  // The wheel over a card that does not hold it scrolls the column. Taken in the capture phase, on the column, before
  // the terminal's own listeners (lib/terminal.ts) and its viewport see it; the default is prevented, or the browser
  // would scroll the terminal's viewport itself.
  useEffect(() => {
    const column = columnRef.current;
    if (!column) return;
    const onWheel = (e: WheelEvent) => {
      const card = e.target instanceof Element ? e.target.closest('[data-board-card]') : null;
      if (!card || card.getAttribute('data-board-card') === holder.current) return;
      e.preventDefault();
      e.stopPropagation();
      // deltaMode 0 is pixels, 1 lines, 2 pages (WheelEvent.DOM_DELTA_*).
      column.scrollTop += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * column.clientHeight : e.deltaY;
    };
    column.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => column.removeEventListener('wheel', onWheel, { capture: true });
  }, [hasColumn]);

  if (!boxes) return null;
  return (
    <div className="flex" style={{ gap: GRID_GAP, height: boxes.boardHeight }}>
      <div className="shrink-0 overflow-hidden" style={{ width: boxes.orchestratorWidth, height: boxes.boardHeight }}>
        {panel(orchestratorId)}
      </div>
      <div
        ref={columnRef}
        data-board-column
        className="shrink-0 overflow-y-auto overflow-x-hidden"
        style={{ width: boxes.columnWidth, height: boxes.boardHeight }}
      >
        <div className="flex flex-col" style={{ gap: GRID_GAP, width: boxes.cardWidth }}>
          {columnIds.map((id) => (
            <div key={id} data-board-card={id} className="shrink-0 overflow-hidden" style={{ height: boxes.cardHeight }}>
              {panel(id)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default memo(OrchestratorBoard);
