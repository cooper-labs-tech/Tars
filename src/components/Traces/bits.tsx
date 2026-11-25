'use client';

import type { ReactNode } from 'react';
import { Panel, PanelCaption, StatusSquare } from '@/components/ui';
import type { StatusTone } from '@/components/ui';

/**
 * The pieces the Traces page is made of (frames `Traces · sessions`, `· a session's turns`, `· storage and reader
 * access`, `· who may be traced` and their states). The boxes, rows and notices are the Resources page's own
 * (components/Resources/bits.tsx); these are the three it does not have.
 */

/**
 * A state in its tone: the 6px square and the words, mono. One line, cut at its end; `wrap` keeps every word, on as
 * many lines as it takes, for a sentence of main's that must be read whole (a token's refusal).
 */
export function StateLine({ word, tone, className = '', wrap = false }: { word: string; tone: StatusTone; className?: string; wrap?: boolean }) {
  const ink = tone === 'idle' ? 'text-muted-foreground' : tone === 'running' ? 'text-status-running' : tone === 'waiting' ? 'text-status-waiting' : 'text-status-error';
  return (
    <span className={`inline-flex ${wrap ? 'items-start' : 'items-center'} gap-1.5 min-w-0 font-mono text-[10.5px] ${ink} ${className}`}>
      <StatusSquare tone={tone} className={wrap ? 'mt-[5px] shrink-0' : undefined} />
      <span className={wrap ? 'break-words' : 'truncate'}>{word}</span>
    </span>
  );
}

/** A 5px bar over its track, the share used. */
export function Meter({ share, tone = 'accent', className = '' }: { share: number; tone?: 'accent' | 'muted' | 'waiting'; className?: string }) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(share) ? share : 0)) * 100;
  const ink = tone === 'accent' ? 'bg-primary' : tone === 'waiting' ? 'bg-status-waiting' : 'bg-text-secondary';
  return (
    <span data-meter className={`relative block h-[9px] ${className}`}>
      <span className="absolute left-0 right-0 top-[2px] h-[5px] bg-secondary" />
      <span className={`absolute left-0 top-[2px] h-[5px] ${ink}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

/** One figure across the top: caption, the number in the display serif, what it is under it, a meter if any. */
export function Stat({ caption, value, sub, meter, tone }: { caption: string; value: string; sub: string; meter?: ReactNode; tone?: StatusTone }) {
  return (
    <Panel data-trace-stat={caption} className="min-w-0 h-[96px] flex flex-col gap-1">
      <PanelCaption>{caption}</PanelCaption>
      <p data-value className="font-serif text-[22px] leading-[1.15] text-foreground truncate">{value}</p>
      {meter}
      <p className={`font-mono text-[10.5px] truncate ${tone === 'waiting' ? 'text-status-waiting' : 'text-muted-foreground'}`}>{sub}</p>
    </Panel>
  );
}

/** A caption over a value, mono: a session's facts. */
export function Fact({ caption, value }: { caption: string; value: string }) {
  return (
    <div className="min-w-0">
      <PanelCaption>{caption}</PanelCaption>
      <p className="mt-0.5 font-mono text-[11.5px] text-foreground truncate">{value}</p>
    </div>
  );
}
