'use client';

import type { ReactNode } from 'react';
import { Button, Panel, PanelCaption, StatusSquare } from '@/components/ui';
import type { StatusTone } from '@/components/ui';

/**
 * The pieces every view of the Resources page is made of (frames `Resources (2.0.5) · heavy runs`, `· agents and
 * projects`, `· disk` and their states): the figures across the top, the boxes with their caption, and the notice a
 * view shows when its backend cannot be read.
 */

/** One of the four figures across the top: caption, the number in the display serif, a mono line under it. */
export function Figure({ caption, value, sub, tone, volatile = false }: {
  caption: string;
  value: string;
  sub: string;
  tone?: StatusTone;
  /** A live reading, which the visual suite masks. */
  volatile?: boolean;
}) {
  return (
    <Panel data-resource-card={caption} className="min-w-0">
      <div className="flex items-center gap-1.5">
        {tone && <StatusSquare tone={tone} />}
        <PanelCaption className="text-text-secondary">{caption}</PanelCaption>
      </div>
      <p data-value {...(volatile ? { 'data-volatile': '' } : {})} className={`mt-2 font-serif text-[28px] leading-none ${value === 'not read' ? 'text-muted-foreground' : 'text-foreground'}`}>{value}</p>
      <p {...(volatile ? { 'data-volatile': '' } : {})} className={`mt-2 font-mono text-[11px] leading-[1.4] ${tone === 'waiting' ? 'text-status-waiting' : tone === 'error' ? 'text-status-error' : 'text-text-secondary'}`}>{sub}</p>
    </Panel>
  );
}

export function Figures({ children, columns = 4 }: { children: ReactNode; columns?: 4 | 5 }) {
  return <div className={`grid ${columns === 5 ? 'grid-cols-5' : 'grid-cols-4'} gap-2 shrink-0`}>{children}</div>;
}

/** A bordered box with its caption, a region named for what it holds. */
export function Box({ name, caption, note, actions, fill = false, className = '', children }: {
  name: string;
  caption: string;
  note?: string;
  actions?: ReactNode;
  /** Takes the height left, its list scrolling inside it. */
  fill?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section role="region" aria-label={name} className={`border border-border bg-card flex flex-col min-w-0 ${fill ? 'min-h-0 h-full' : ''} ${className}`}>
      <div className="flex items-center gap-2 px-3.5 pt-2.5 pb-2 shrink-0">
        <PanelCaption className="shrink-0">{caption}</PanelCaption>
        <span className="flex-1 min-w-0 text-right font-mono text-[10px] text-muted-foreground truncate">{note}</span>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A row of a box, ruled above. */
export function Row({ className = '', children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`border-t border-border px-3.5 py-2 ${className}`} {...rest}>{children}</div>;
}

/** What a view says when Tars cannot read what it shows: its backend is not there, or it failed. */
export function Unread({ text, detail, onRetry }: { text: string; detail?: string | null; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-2.5 px-3 py-2 bg-secondary border border-danger/40">
      <StatusSquare tone="error" />
      <p className="flex-1 min-w-0 text-[11.5px] leading-[1.45] text-foreground">
        {text}
        {detail ? <span className="text-muted-foreground">{` ${detail}`}</span> : null}
      </p>
      {onRetry && <Button size="sm" className="font-mono" onClick={onRetry}>try again</Button>}
    </div>
  );
}

/** A notice that is not an error: an alert of the machine, a wait, a scan an agent asked for. */
export function Notice({ tone, children, actions }: { tone: StatusTone; children: ReactNode; actions?: ReactNode }) {
  return (
    <div role="status" className={`flex items-center gap-2.5 px-3 py-2 bg-secondary border ${tone === 'error' ? 'border-danger/40' : 'border-border'}`}>
      <StatusSquare tone={tone} />
      <div className="flex-1 min-w-0 text-[11.5px] leading-[1.45] text-foreground">{children}</div>
      {actions}
    </div>
  );
}

/** A plain sentence in an empty box. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3.5 pb-3.5 text-[11.5px] leading-[1.5] text-text-secondary">{children}</p>;
}
