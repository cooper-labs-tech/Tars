'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgentStatus, AgentRetuned } from '@/types/electron';
import { Button, PanelCaption, StatusSquare } from '@/components/ui';
import type { StatusTone } from '@/components/ui';
import { askedOf, byWords, clockOfIso, dismissRetune, impliedOf, latestRetune, noteRevert, useRetunes, whatWords } from '@/hooks/useRetunes';

type Undo = { word: string; tone: StatusTone } | null;

/** Undo a retune through main's engine (agent.revertChange), filed under the window; its answer in words. */
async function undoChange(changeId: string): Promise<Undo> {
  const revert = window.electronAPI?.agent?.revertChange;
  if (!revert) return { word: 'not undone: this Tars cannot undo a change from the window', tone: 'error' };
  const r = await revert({ changeId });
  if (!r.ok) return { word: `not undone: ${r.error}`, tone: 'error' };
  if (r.revertChangeId) noteRevert(r.revertChangeId, changeId);
  const left = r.leftAlone && r.leftAlone.length > 0 ? ` · ${r.leftAlone.join(', ')} left alone: changed since` : '';
  if (r.state === 'cancelled') return { word: `cancelled by you at ${clockOfIso(new Date().toISOString())}, before it took effect${left}`, tone: 'running' };
  if (r.state === 'queued') return { word: `undo asked: it waits for the agent's turn to end${left}`, tone: 'waiting' };
  return { word: `undone by you at ${clockOfIso(new Date().toISOString())}${left}`, tone: left ? 'waiting' : 'running' };
}

function Line({ word, tone }: { word: string; tone: StatusTone }) {
  const ink = tone === 'idle' ? 'text-muted-foreground' : tone === 'running' ? 'text-status-running' : tone === 'waiting' ? 'text-status-waiting' : 'text-status-error';
  return <span className={`flex items-center gap-1.5 min-w-0 font-mono text-[10.5px] ${ink}`}><StatusSquare tone={tone} /><span className="truncate">{word}</span></span>;
}

/** The state of a change in words: applied at, waiting, cancelled, failed. */
function stateWords(state: AgentRetuned['state'], effectiveAt?: string, waitingFor?: string): string {
  if (state === 'applied') return `applied ${clockOfIso(effectiveAt)}`;
  if (state === 'queued') return waitingFor ? `waits for ${waitingFor}` : 'waits for its turn to end';
  return state;
}

/**
 * An agent's last retune on its card (frame `Agents · retuned by an agent`, the card): who, what, when, and undo.
 * Values before and after come from the event the window heard; after a restart of the window, the fields alone.
 */
export function RetuneLine({ agent }: { agent: AgentStatus }) {
  const { byAgent, reverts } = useRetunes();
  const [undo, setUndo] = useState<Undo>(null);
  const known = latestRetune(agent, byAgent);
  if (!known) return null;
  const { last, heard } = known;
  const asked = last.state === 'queued';
  // The window's own undo is no retune to undo: it says what it took back, with no undo on it.
  const undoes = reverts[last.changeId];
  const head = undoes
    ? { word: `undone by ${byWords(last.by)} at ${clockOfIso(last.effectiveAt ?? last.askedAt)}`, tone: 'running' as const }
    : { word: `${asked ? 'retune asked' : 'retuned'} by ${byWords(last.by)} at ${clockOfIso(last.askedAt)}`, tone: 'waiting' as const };
  return (
    <div data-retune={undoes ? 'undone' : last.state} className="px-2.5 py-2 bg-secondary border border-border space-y-1" onClick={e => e.stopPropagation()}>
      <div className="flex items-center gap-2">
        {undo && !undoes ? <Line word={undo.word} tone={undo.tone} /> : <Line word={head.word} tone={head.tone} />}
        <span className="flex-1" />
        {!undo && !undoes && last.state !== 'cancelled' && last.state !== 'failed' && (
          <Button size="sm" variant="ghost" className="font-mono" onClick={() => { void undoChange(last.changeId).then(setUndo); }}>undo</Button>
        )}
      </div>
      <p className="font-mono text-[10.5px] text-text-secondary truncate">
        {`${whatWords(askedOf(last), heard?.before, heard?.after)} · ${stateWords(last.state, last.effectiveAt, heard?.waitingFor)}`}
      </p>
    </div>
  );
}

/** LAST RETUNE in an agent's panel: by, what, asked, in effect, and undo. */
export function RetunePanel({ agent }: { agent: AgentStatus }) {
  const { byAgent, reverts } = useRetunes();
  const [undo, setUndo] = useState<Undo>(null);
  const known = latestRetune(agent, byAgent);
  if (!known) return null;
  const { last, heard } = known;
  const undoes = reverts[last.changeId];
  const row = (k: string, v: string) => (
    <div className="flex gap-2.5"><span className="w-[74px] shrink-0 font-mono text-[10.5px] text-muted-foreground">{k}</span><span className="min-w-0 text-[11.5px] text-text-secondary">{v}</span></div>
  );
  return (
    <div data-retune-panel className="px-4 py-3 border-b border-border space-y-1.5">
      <PanelCaption>LAST RETUNE</PanelCaption>
      {undo ? <Line word={undo.word} tone={undo.tone} /> : (
        <>
          {row('by', undoes ? `${byWords(last.by)}, undoing the change before` : byWords(last.by))}
          {row('what', whatWords(askedOf(last), heard?.before, heard?.after))}
          {impliedOf(last).length > 0 && row('also reset', impliedOf(last).join(', '))}
          {row('asked', `${new Date(last.askedAt).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' })} ${clockOfIso(last.askedAt)}`)}
          {row('in effect', last.state === 'applied' ? clockOfIso(last.effectiveAt) : stateWords(last.state, last.effectiveAt, heard?.waitingFor))}
          {!undoes && last.state !== 'cancelled' && last.state !== 'failed' && (
            <Button size="sm" className="font-mono" onClick={() => { void undoChange(last.changeId).then(setUndo); }}>undo</Button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The notices across the top of the page when an agent retunes one of yours (frame `Agents · retuned by an agent`,
 * the notice): who, which agent, what, and its state; undo, show (the agent's page), close. A change made in the
 * window shows none.
 */
export function RetuneNotices({ className = '' }: { className?: string }) {
  const { notices } = useRetunes();
  const router = useRouter();
  const [undone, setUndone] = useState<Record<string, Undo>>({});
  if (notices.length === 0) return null;
  return (
    <div data-retune-notices className={`space-y-1.5 ${className}`}>
      {notices.map(n => {
        const u = undone[n.changeId];
        const project = n.projectPath.split(/[\\/]/).filter(Boolean).pop();
        const text = u ? u.word
          : n.state === 'queued'
            ? `${byWords(n.by)} asked ${n.agentName}${project ? ` (${project})` : ''} to move to ${whatWords(askedOf(n), n.before, n.after)}: it ${n.waitingFor ? `waits for ${n.waitingFor}` : 'waits for its turn to end'}.`
            : `${byWords(n.by)} retuned ${n.agentName}${project ? ` (${project})` : ''}: ${whatWords(askedOf(n), n.before, n.after)}, ${stateWords(n.state, n.effectiveAt)}.`;
        return (
          <div key={n.changeId} role="status" className="flex items-center gap-2.5 h-10 px-3 bg-secondary border border-border-accent">
            <StatusSquare tone={u ? u.tone : n.state === 'failed' ? 'error' : 'waiting'} />
            <p className="flex-1 min-w-0 truncate text-xs text-foreground">{text}</p>
            {!u && n.state !== 'cancelled' && n.state !== 'failed' && (
              <Button size="sm" onClick={() => { void undoChange(n.changeId).then(r => setUndone(m => ({ ...m, [n.changeId]: r }))); }}>undo</Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => router.push(`/agents?agent=${encodeURIComponent(n.agentId)}`)}>show</Button>
            <Button size="sm" variant="ghost" onClick={() => dismissRetune(n.changeId)}>close</Button>
          </div>
        );
      })}
    </div>
  );
}
