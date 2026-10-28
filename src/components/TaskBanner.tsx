'use client';

import { useEffect, useState, type DragEvent } from 'react';
import { ArrowUpToLine, GripVertical, List, Pause, Play, X } from 'lucide-react';
import { Button, StatusSquare } from '@/components/ui';
import type { AgentStatus } from '@/types/electron';
import { useTaskBanner } from '@/hooks/useTaskBanner';
import { useAgentQueue, type AgentQueue } from '@/hooks/useAgentQueue';
import { cleanLine, clockOf, elapsedSince, sendersOf } from '@/lib/task-banner';

interface Waiting { ref: string; from: string; queuedAt: string; firstLine: string; via?: string }

/** What the strip says of a queue kept with nothing in hand: who paused it, and when. */
function pausedWords(paused: NonNullable<AgentQueue['paused']>, n: number): string {
  const kept = `${n} waiting, kept and paused`;
  if (paused.by === 'stop') return `Stopped by you at ${clockOf(paused.since)}. ${kept}.`;
  if (paused.by === 'restart') return `Tars restarted at ${clockOf(paused.since)}. ${kept}${paused.orchestratorTold ? '; the orchestrator was told what waits' : ''}.`;
  return `Paused by you at ${clockOf(paused.since)}. ${n} waiting.`;
}

/**
 * The task an agent works on, above its terminal, wherever the terminal shows
 * (its Dashboard panel, its window): who gave it, since when and for how long,
 * its first line, the tasks waiting behind it, and stop task, which ends that
 * task only. Frames: `Task banner · above the agent's terminal` and its
 * Dashboard and window frames (design PR #451), whose panes give its widths:
 * from 560 px, "Task from <sender> since 14:02 · 4 min" and the waiting tasks'
 * senders beside their count; under 560, "from <sender> since 14:02", the
 * senders in their list only; under 400, the sender and the hour, and the
 * count without its icon. Those widths are the banner's own, padding included:
 * the container carries no padding, its content does (a container query reads
 * the content box, and a 583 px pane read as 559 took the narrow layout).
 *
 * Since 2.0.5 the list is the agent's queue (frames `Agent queue (2.0.5) · in its
 * panel` and `· states`, design PR 535): pause and resume in its head, move to the
 * head and cancel on each item (cancel asks once), drag one before another. With
 * no task in hand and a queue kept paused (after a stop, after a restart), a
 * strip takes the banner's place. Without the queue's channel, the list is the
 * one it was, with no control.
 */
export default function TaskBanner({ agent }: { agent: AgentStatus }) {
  const banner = useTaskBanner(agent);
  const q = useAgentQueue(agent.id);
  const task = banner?.task ?? null;
  const waiting: Waiting[] = q.queue
    ? q.queue.items.map((i) => ({ ref: i.taskId, from: i.from, queuedAt: i.queuedAt, firstLine: i.firstLine, via: `${i.via} · ${i.taskId}` }))
    : banner?.waiting ?? [];
  const paused = q.queue?.paused ?? null;
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The item whose cancel asks, or 'all' for drop them. */
  const [asking, setAsking] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);

  useEffect(() => {
    if (!task) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [task]);
  useEffect(() => { setError(null); }, [task?.ref]);
  useEffect(() => { if (waiting.length === 0) { setOpen(false); setAsking(null); } }, [waiting.length]);

  if (!task && !(paused && waiting.length > 0)) return null;

  const stop = async () => {
    if (!task) return;
    setStopping(true);
    setError(null);
    try {
      const result = await window.electronAPI?.agent?.stopTask?.(agent.id, task.ref);
      if (result && !result.success) setError(result.error || 'This task could not be stopped.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  };

  const drop = (before: string) => (e: DragEvent) => {
    e.preventDefault();
    if (dragged && dragged !== before) void q.move(dragged, before);
    setDragged(null);
  };

  const count = waiting.length > 0 && (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      className={`h-[26px] shrink-0 flex items-center gap-1.5 px-2 border text-[11px] transition-colors ${open ? 'bg-card border-border-accent text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
    >
      <List size={12} className="hidden @min-[400px]:block" />
      <span>{waiting.length} waiting</span>
      {task && <span className="hidden @min-[560px]:inline">· {sendersOf(waiting)}</span>}
      {paused && task && <span className="px-1.5 border border-border font-mono text-[10px] text-text-secondary">paused</span>}
    </button>
  );

  const list = open && waiting.length > 0 && (
    <div data-queue-list className="absolute right-3 top-full z-20 mt-1 w-[360px] max-w-[calc(100%-24px)] bg-bg-elevated border border-border-accent">
      <div className="flex items-center gap-2 pl-3 pr-2 py-1.5 text-[10px] text-muted-foreground">
        <span className="uppercase tracking-[0.08em]">Waiting · {waiting.length}</span>
        <span className="hidden @min-[400px]:inline font-mono">in the order they run</span>
        <span className="flex-1" />
        {q.has && (paused
          ? <Button size="sm" className="font-mono" onClick={() => void q.resume()}><Play className="w-3 h-3" />resume</Button>
          : <Button size="sm" className="font-mono" onClick={() => void q.pause()}><Pause className="w-3 h-3" />pause</Button>)}
      </div>
      {q.error && (
        <p role="alert" className="flex items-center gap-2 mx-0 px-3 py-2 bg-secondary border border-danger/40 text-[11.5px] text-foreground">
          <StatusSquare tone="error" />
          <span className="flex-1">{q.error}</span>
        </p>
      )}
      <ul aria-label="Tasks waiting">
        {waiting.map((w, i) => (
          <li
            key={w.ref}
            draggable={q.has}
            onDragStart={() => setDragged(w.ref)}
            onDragEnd={() => setDragged(null)}
            onDragOver={(e) => { if (dragged) e.preventDefault(); }}
            onDrop={drop(w.ref)}
            className={`flex flex-col border-t ${dragged && dragged !== w.ref ? 'border-border-accent' : 'border-border'} ${asking === w.ref || dragged === w.ref ? 'bg-secondary' : ''}`}
          >
            <div className="flex items-center gap-2 pl-1.5 pr-2 py-2">
              {q.has && <GripVertical size={12} className="shrink-0 text-muted-foreground cursor-grab" aria-hidden />}
              <div className={`flex-1 min-w-0 flex flex-col gap-[3px] ${q.has ? '' : 'pl-1.5'}`}>
                <p className="flex items-baseline gap-1.5 min-w-0">
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{i + 1}</span>
                  <span className="min-w-0 truncate text-[11.5px] font-medium text-foreground">from {cleanLine(w.from, 40)}</span>
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">queued {clockOf(w.queuedAt)}</span>
                </p>
                <p data-first-line className="truncate text-[12px] text-foreground">{cleanLine(w.firstLine, 100)}</p>
                {w.via && <p className="truncate font-mono text-[10px] text-muted-foreground">{w.via}</p>}
              </div>
              {q.has && asking !== w.ref && (
                <>
                  {i > 0
                    ? <Button size="icon" aria-label="Move to the head" title="Move to the head" onClick={() => void q.move(w.ref, null)}><ArrowUpToLine className="w-3 h-3" /></Button>
                    : <span className="w-[26px] shrink-0" />}
                  <Button size="icon" aria-label="Cancel" title="Cancel" onClick={() => setAsking(w.ref)}><X className="w-3 h-3" /></Button>
                </>
              )}
            </div>
            {asking === w.ref && (
              <div className="flex items-center gap-2 pl-[26px] pr-2 pb-2">
                <p className="flex-1 min-w-0 text-[11.5px] leading-[1.45] text-foreground">{`Cancel this task? ${cleanLine(w.from, 40)} is told it was cancelled.`}</p>
                <Button size="sm" className="font-mono" onClick={() => { setAsking(null); void q.cancel(w.ref); }}>cancel it</Button>
                <Button size="sm" className="font-mono" onClick={() => setAsking(null)}>keep</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="px-3 pt-[7px] pb-[9px] border-t border-border font-mono text-[10.5px] text-muted-foreground">
        {paused
          ? `paused at ${clockOf(paused.since)}${task ? ' · the turn in progress goes on' : ''}`
          : `the first starts when this task ends${q.has ? ' · drag one to move it before another' : ''}`}
      </p>
    </div>
  );

  // Nothing in hand, the queue kept paused: the strip, in the banner's place.
  if (!task && paused) {
    return (
      <div data-queue-strip role="status" className="@container relative shrink-0 bg-secondary border-b border-border select-none">
        <div className="flex items-center gap-2 pl-3 pr-1.5 py-1 min-w-0">
          <StatusSquare tone={paused.by === 'restart' ? 'waiting' : 'idle'} />
          <p className="flex-1 min-w-0 truncate text-[11.5px] text-text-secondary">{pausedWords(paused, waiting.length)}</p>
          {count}
          <Button size="sm" className="font-mono" onClick={() => void q.resume()}><Play className="w-3 h-3" />resume</Button>
          {paused.by === 'stop' && (asking === 'all'
            ? <>
                <Button size="sm" className="font-mono" onClick={() => { setAsking(null); void q.drop(); }}>{`drop ${waiting.length}`}</Button>
                <Button size="sm" className="font-mono" onClick={() => setAsking(null)}>keep</Button>
              </>
            : <Button size="sm" className="font-mono" onClick={() => setAsking('all')}>drop them</Button>)}
        </div>
        {list}
      </div>
    );
  }
  if (!task) return null;

  const from = cleanLine(task.from, 40);
  const firstLine = cleanLine(task.firstLine, 100);
  return (
    <div
      data-task-banner
      role="status"
      aria-label={`Task from ${from}`}
      className="@container relative shrink-0 bg-secondary border-b border-border select-none"
    >
      <div className="px-3 py-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <StatusSquare tone="running" />
          <p className="min-w-0 truncate text-[11px] leading-tight text-muted-foreground">
            <span className="hidden @min-[560px]:inline">Task </span>
            <span className="hidden @min-[400px]:inline">from </span>
            <span className="text-foreground font-medium">{from}</span>
            <span className="font-mono">
              {' '}
              <span className="hidden @min-[400px]:inline">since </span>
              {clockOf(task.startedAt)}
              <span className="hidden @min-[560px]:inline"> · {elapsedSince(task.startedAt, now)}</span>
            </span>
          </p>
          <span className="flex-1" />
          {count}
          {/* As the panel header draws its stop, which every banner frame copies: 11 px, in the secondary grey. */}
          <button
            type="button"
            onClick={stop}
            disabled={stopping}
            className="h-[26px] shrink-0 px-2 border border-border bg-card font-mono text-[11px] text-text-secondary hover:text-foreground hover:bg-secondary transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            stop task
          </button>
        </div>
        <p className="mt-1 truncate text-[12px] leading-snug text-foreground" title={firstLine}>{firstLine}</p>
        {error && <p className="mt-1 text-[11px] text-danger">{error}</p>}
      </div>
      {list}
    </div>
  );
}
