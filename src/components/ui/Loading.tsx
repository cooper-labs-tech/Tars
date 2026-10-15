'use client';

import { useEffect, useState } from 'react';

/**
 * Loading, in three stages.
 *
 * A spinner that appears for 200ms is a flash, and one that spins for eight
 * seconds says nothing about what is slow. So: nothing at all under 400ms, the
 * mark filling over a line naming what is coming, and past three seconds the
 * same line with how long it has taken and a way out.
 */

const MARK_AFTER_MS = 400;
const EXPLAIN_AFTER_MS = 3000;

export function useLoadingStage(loading: boolean): 'idle' | 'quiet' | 'mark' | 'explain' {
  const [elapsed, setElapsed] = useState<'quiet' | 'mark' | 'explain'>('quiet');

  useEffect(() => {
    if (!loading) {
      // Reset on the next tick: resetting during the effect would cascade.
      const reset = setTimeout(() => setElapsed('quiet'), 0);
      return () => clearTimeout(reset);
    }
    const toMark = setTimeout(() => setElapsed('mark'), MARK_AFTER_MS);
    const toExplain = setTimeout(() => setElapsed('explain'), EXPLAIN_AFTER_MS);
    return () => {
      clearTimeout(toMark);
      clearTimeout(toExplain);
    };
  }, [loading]);

  return loading ? elapsed : 'idle';
}

/**
 * The mark, waiting.
 *
 * This replaces `<Loader2 className="animate-spin" />`, which was on 47 call
 * sites. A rotating ring is the same ring every other application uses; it says
 * nothing about whose wait this is. The 4x4 grid is the app icon, the sidebar
 * mark and the launch screen already, so a wait that shows it is recognisably
 * Tars working rather than a generic pause.
 *
 * One light travels the grid in reading order: the top-left cell, then along
 * that row, then back to the left of the row below, and so on. Each cell runs
 * the `square-sweep` keyframes delayed by its own index, so all sixteen are
 * distinct. It used to be `(col + row) mod 4`, which gives only four delays
 * and lights a whole diagonal at a time. Unlit cells rest at 0.16 rather than
 * disappearing, which is what keeps the silhouette readable.
 * Frame: `Loading states`.
 */
/** How long one square waits before the next lights. Sixteen of them makes a
 *  fill just under two seconds, then it clears and starts again. */
const STEP_MS = 110;
const CELLS = 16;

export function BrandSpinner({
  size = 30,
  className = '',
  label,
}: {
  /** Outer edge in px. 56 on the splash, 30 on a page, 26 in a waiting row. */
  size?: number;
  className?: string;
  /** Announced to screen readers. The animation itself is decorative. */
  label?: string;
}) {
  // The grid fills rather than a single light travelling over it: the top-left
  // square lights and stays lit, then the one to its right joins it, and so on
  // to the end of the row and down to the next, until the mark is whole and it
  // starts again. Driven here rather than in CSS because every square holds its
  // state until the reset, and sixteen cells sharing one keyframe cannot each
  // hold a different amount of it.
  const [filled, setFilled] = useState(0);

  useEffect(() => {
    if (typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => setFilled(n => (n + 1) % (CELLS + 1)), STEP_MS);
    return () => clearInterval(id);
  }, []);

  // 4 cells and 3 gaps, gap a quarter of a cell, so the mark keeps its
  // proportions at every size instead of the gaps swallowing a small one.
  const cell = size / 4.75;
  const gap = cell / 4;

  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`relative inline-block shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      {Array.from({ length: CELLS }).map((_, i) => (
        <span
          key={i}
          className="absolute bg-primary transition-opacity duration-150"
          style={{
            left: (i % 4) * (cell + gap),
            top: Math.floor(i / 4) * (cell + gap),
            width: cell,
            height: cell,
            // Unlit cells rest at 0.16 rather than disappearing, which is what
            // keeps the silhouette of the mark readable while it fills.
            opacity: i < filled ? 1 : 0.16,
          }}
        />
      ))}
    </span>
  );
}

/**
 * A whole panel given over to waiting: the mark, centred, over one line saying
 * what is being waited on. Shown at once; `LoadingState` puts the same panel
 * in the middle of its ladder.
 */
export function LoadingPanel({
  what,
  size = 30,
  className = '',
}: {
  what: string;
  size?: number;
  className?: string;
}) {
  return (
    <div className={`flex h-full flex-col items-center justify-center gap-3 ${className}`}>
      <BrandSpinner size={size} label={what} />
      <p className="text-xs text-muted-foreground">{what}</p>
    </div>
  );
}

/** Past three seconds: name what is slow, and offer a way out. */
export function SlowOperation({
  what,
  detail,
  onCancel,
}: {
  what: string;
  detail?: string;
  onCancel?: () => void;
}) {
  const [seconds, setSeconds] = useState(3);

  useEffect(() => {
    const id = setInterval(() => setSeconds(s => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center gap-2.5 border border-border bg-card px-4 py-6 text-center">
      <BrandSpinner size={24} label={what} />
      <p className="text-xs text-foreground">{what}</p>
      {detail && (
        <p className="text-[10.5px] font-mono text-muted-foreground">
          {detail} ·{' '}
          {/* Counts up for as long as the wait lasts, so a page that is slow to
              load could never be screenshotted: the frame never repeats. */}
          <span data-volatile className="inline-block w-[34px] text-left">{seconds}s</span>
        </p>
      )}
      {onCancel && (
        <button
          onClick={onCancel}
          className="px-2.5 py-1 text-[11px] border border-border text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      )}
    </div>
  );
}

/**
 * The whole ladder in one component, for every page and panel that waits.
 *
 * The middle stage is the mark, whatever is loading. It used to default to
 * skeleton rows, grey bars in the shape of a list, and only the settings page
 * had been switched to the mark: the agents, projects, schedules, review,
 * usage and skills pages waited in grey while every other wait in the app
 * showed the mark filling. JeanBrasse noticed. There is no second look to pick now.
 * Frame: `Loading states`.
 */
export function LoadingState({
  loading,
  what,
  detail,
  onCancel,
  children,
}: {
  loading: boolean;
  what: string;
  detail?: string;
  onCancel?: () => void;
  children?: React.ReactNode;
}) {
  const stage = useLoadingStage(loading);

  if (!loading) return <>{children}</>;
  if (stage === 'quiet') return null;
  if (stage === 'explain') return <SlowOperation what={what} detail={detail} onCancel={onCancel} />;
  return <LoadingPanel what={what} className="py-10" />;
}
