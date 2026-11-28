'use client';

import type { ReactNode } from 'react';
import { PanelCaption, StatusSquare } from '@/components/ui';
import type { AnyTone } from '@/components/ui';
import { clockOf } from '@/lib/traces-format';
import type { LoadBlockReason, LoadRunView, LoadSplit, LoadWindowParams } from '@/types/electron';

/** A box of the card (`Card · Load window`): a caption, what it says on the right, and its rows. */
export function Box({ caption, meta, tone, children, className = '', ...rest }: {
  caption: string; meta?: ReactNode; tone?: 'error'; children: ReactNode; className?: string; [data: `data-${string}`]: string | undefined;
}) {
  return (
    <section className={`border ${tone === 'error' ? 'border-status-error' : 'border-border'} bg-card ${className}`} {...rest}>
      <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-2">
        <PanelCaption>{caption}</PanelCaption>
        {meta !== undefined && <span className="font-mono text-[10.5px] text-muted-foreground">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

/** A word in its tone with its square, the frames' chip. */
export function Chip({ children, tone }: { children: ReactNode; tone?: AnyTone }) {
  return (
    <span className={`h-[22px] px-1.5 inline-flex items-center gap-1.5 bg-secondary font-mono text-[10.5px] shrink-0 ${tone ? `text-status-${tone}` : 'text-text-secondary'}`}>
      {tone && <StatusSquare tone={tone} />}
      {children}
    </span>
  );
}

/** A figure with its caption and its line, the running and ended windows' counts. */
export function Stat({ caption, value, sub, tone }: { caption: string; value: number | string; sub: string; tone?: 'waiting' }) {
  return (
    <div className="flex-1 min-w-0 border border-border bg-card px-4 pt-3 pb-3">
      <PanelCaption>{caption}</PanelCaption>
      <p className={`mt-1 font-serif text-[30px] leading-[1.15] ${tone ? 'text-status-waiting' : 'text-foreground'}`}>{value}</p>
      <p className="mt-1 font-mono text-[10.5px] leading-snug text-muted-foreground">{sub}</p>
    </div>
  );
}

export const MEMORY_LINE = 'Each load agent starts every task without the memory earlier load tasks wrote, and writes none.';
export const BLOCKED_LINE = (arrivals: number, minutes: number) =>
  `About ${arrivals} arrivals in ${minutes} minutes. An arrival that finds max concurrent, a busy agent or the heavy-run slot full, or no free load agent with a harness the task accepts, is blocked: recorded and dropped, never queued.`;

export const BLOCK_WORDS: Record<LoadBlockReason, string> = {
  max_concurrent: 'max concurrent full',
  busy_cap: 'busy-agent cap full',
  heavy_slot: 'heavy-run slot taken',
  no_harness: 'no_harness',
};
export const BLOCK_ORDER: LoadBlockReason[] = ['max_concurrent', 'busy_cap', 'heavy_slot', 'no_harness'];

/**
 * A pool's folder as the frames write it, `~/.tars/load-pools/<pool>`. Main keeps every pool under its own data folder
 * (load-handlers.ts, DATA_DIR/load-pools), so what comes before `.tars/load-pools` is Tars's own home and nobody
 * else's (the Audit's Info on #695); any other path is shown whole.
 */
export const poolDirOf = (dir: string) => {
  const m = /^(.+)([\\/])\.tars\2load-pools\2([^\\/]+)$/.exec(dir);
  return m ? ['~', '.tars', 'load-pools', m[3]].join(m[2]) : dir;
};
export const splitWord = (s: LoadSplit) => (s === 'heldout' ? 'held-out' : s);
export const nameOf = (projectPath: string) => projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
export const short = (sha: string) => sha.slice(0, 7);
export const pad = (n: number) => String(n).padStart(2, '0');
export const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));
export const blockedTotal = (run: LoadRunView) => BLOCK_ORDER.reduce((sum, r) => sum + (run.blocked[r] ?? 0), 0);

/** A sentence ends once: main's detail may already carry its period. */
const ended = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** How a window stopped, as the notes word each reason (`Shell · Load window · notes`). */
export function stopSentence(run: LoadRunView): string {
  const stop = run.stop;
  if (!stop) return '';
  const at = clockOf(stop.at);
  if (stop.reason === 'window_end') return `Ended at ${at}: the window's ${run.window.window_min} minutes ran out.`;
  if (stop.reason === 'switch') return `Stopped by you at ${at}, with the switch.`;
  if (stop.reason === 'disk_floor') return ended(`Stopped at ${at}: ${stop.detail ?? 'free disk fell under the 15 GB floor'}`);
  return ended(`Stopped at ${at}: ${stop.detail ?? 'an error stopped it'}`);
}
export const STOP_WORDS = { window_end: 'window end', switch: 'switch', disk_floor: 'disk floor', error: 'error' } as const;
/** The same stop, in the few words of the "Last window" line. */
export const STOP_SHORT = { window_end: 'ended at its end', switch: 'stopped by you', disk_floor: 'stopped at the disk floor', error: 'stopped by an error' } as const;

/** The window's values, read only: the running and ended windows' box. */
export function WindowValues({ window: w, caption, meta, about }: { window: LoadWindowParams; caption: string; meta: string; about: number }) {
  const rows: Array<[string, string]> = [
    ['Rate per hour', String(w.rate_per_hour)], ['Distribution', w.distribution], ['Seed', String(w.seed)], ['Length', `${w.window_min} min`],
    ['Max concurrent', String(w.max_concurrent)], ['Initial sessions', String(w.initial_sessions)], ['Pick', 'weighted, no repeat'],
  ];
  return (
    <Box caption={caption} meta={meta}>
      <div className="px-4 pb-3">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3 py-[7px]">
            <span className="text-[12.5px] text-text-secondary">{k}</span>
            <span className="font-mono text-[12px] text-foreground">{v}</span>
          </div>
        ))}
        <p className="mt-1.5 text-[11.5px] leading-[1.45] text-muted-foreground">{BLOCKED_LINE(about, w.window_min)}</p>
      </div>
    </Box>
  );
}
