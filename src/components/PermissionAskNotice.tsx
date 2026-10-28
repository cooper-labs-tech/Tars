'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button, Input, StatusSquare } from '@/components/ui';
import type { AgentStatus } from '@/types/electron';
import { permissionAskLine } from '@/lib/permission-ask';
import { TERMINAL_SURFACE_CLASS } from '@/lib/terminal-theme';

const ACTION = 'font-mono lowercase';

/** What main keeps of a reason (permission-asks.ts); the field takes no more. */
const MAX_REASON = 200;

const LATE_WHO = 'Tars no longer holds this question:';
const LATE_REST = 'if its terminal asks, answer there.';

type Decision = 'allow' | 'deny' | 'ask';
/** answers: the three; reason: deny's field; sending and sent: off until the agent's next state; late: Tars held nothing. */
type Phase = 'answers' | 'reason' | 'sending' | 'sent' | 'late';
interface State {
  of: string | undefined;
  phase: Phase;
  reason: string;
  /** The panel's line holds the call whole, as measured; until it is known, it does not. */
  fits: boolean;
  /** The panel opened the call whole, under its header (show all). */
  shown: boolean;
}

const fresh = (of: string | undefined): State => ({ of, phase: 'answers', reason: '', fits: false, shown: false });

/** Whether a line holds its text whole: what it cut is wider than what it shows. */
const holdsWhole = (el: Pick<HTMLElement, 'scrollWidth' | 'clientWidth'>) => el.scrollWidth <= el.clientWidth;

/**
 * A permission question the state mod asked Tars instead of Claude Code's
 * dialog (the state mod, PR 318), and its three answers: allow runs the call, deny refuses it
 * with a reason the agent reads if one is given, ask in terminal puts it to
 * Claude Code's own dialog, which has no delay: answer it there. Nothing is
 * typed into the terminal. Tars never answers allow by itself (PR 538): a
 * question waits for the owner, and at the delay Tars refuses it, with its
 * reason. Frame: `Permission asked of Tars`.
 *
 * `panel`: the row of MessageWaitingNotice, 26 high under a panel's header,
 * the sentence cut first and the answers kept. It offers allow only once its
 * line is measured to hold the whole call (the Audit's Low at the gate of PR
 * 320: what is allowed must be what was read); until then, and whenever the
 * call is cut, show all opens it whole under the header, as the window shows
 * it. `window`: the top of the agent window's terminal column, the call whole
 * with when it was asked, and under it why Claude Code asks and the settings
 * rule that asked, each when it said (the Audit's Low at the recheck of PR
 * 318 and 320): in bypass, an ask rule is the only reason a call comes here.
 *
 * The state belongs to one question: the next call's (another askedAt) starts
 * afresh, whatever the last one left open, its line measured again.
 *
 * A file tool asked by an agent in bypass, its content withheld from Tars (`withheld`, PR 538):
 * the path alone, said withheld, and deny and ask in terminal, never allow nor
 * show all. Tars cannot see what would be written, and refuses an allow anyway
 * (frame `Permission asked of Tars`, its withheld row).
 */
export default function PermissionAskNotice({ agent, layout }: {
  agent: Pick<AgentStatus, 'id' | 'status' | 'permissionAsk'>;
  layout: 'panel' | 'window';
}) {
  const askedAt = agent.permissionAsk?.askedAt;
  const withheld = agent.permissionAsk?.withheld === true;
  /** What was withheld and why, as the state mod says it (\`command: 3,014 characters, past the 2,000 the window shows\`). */
  const withheldWhy = withheld ? agent.permissionAsk?.withheldWhy : undefined;
  const [kept, setKept] = useState<State>(() => fresh(askedAt));
  const state: State = kept.of === askedAt ? kept : fresh(askedAt);
  const update = useCallback(
    (next: Partial<State>) => setKept(prev => ({ ...(prev.of === askedAt ? prev : fresh(askedAt)), ...next })),
    [askedAt],
  );

  // The panel's line, measured when it is drawn and whenever its panel is
  // resized: a narrower panel cuts a call that fitted.
  const subjectEl = useRef<HTMLElement | null>(null);
  const measure = useCallback((el: HTMLElement | null) => {
    subjectEl.current = el;
    if (el) update({ fits: holdsWhole(el) });
  }, [update]);
  useEffect(() => {
    const el = subjectEl.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => update({ fits: holdsWhole(el) }));
    observer.observe(el);
    return () => observer.disconnect();
  }, [update, state.shown]);

  const line = permissionAskLine(agent);
  if (!line) return null;

  const busy = state.phase === 'sending' || state.phase === 'sent';

  const answer = async (decision: Decision, reason?: string) => {
    if (busy) return;
    update({ phase: 'sending' });
    let taken = false;
    try {
      const result = await window.electronAPI?.agent?.answerPermission?.(agent.id, decision, reason);
      taken = result?.success === true;
    } catch {
      taken = false;
    }
    // Taken: off until the agent's next state takes the line away. Not taken:
    // the time ran out, the turn ended, or another window answered first.
    setKept(prev => (prev.of === askedAt ? { ...prev, phase: taken ? 'sent' : 'late' } : prev));
  };
  const deny = () => answer('deny', state.reason.trim() || undefined);
  const back = () => update({ phase: 'answers', reason: '' });
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      deny();
    } else if (e.key === 'Escape') {
      // Back to the three, and no further: the agent window closes on Esc,
      // and a fullscreen panel leaves fullscreen.
      e.preventDefault();
      e.stopPropagation();
      back();
    }
  };

  const late = state.phase === 'late';
  const reasonField = (
    <Input
      compact
      autoFocus
      aria-label="Why, for the agent"
      placeholder="why, optional: the agent reads it"
      value={state.reason}
      maxLength={MAX_REASON}
      onChange={e => update({ reason: e.target.value })}
      onKeyDown={onKeyDown}
    />
  );
  const lateLine = (
    <p className="min-w-0 truncate text-[11px] leading-tight text-muted-foreground">
      <span className="text-foreground">{LATE_WHO}</span> {LATE_REST}
    </p>
  );

  if (layout === 'panel' && !state.shown) {
    // A withheld question's why, on a line under it (frame `Permission asked of Tars`, its withheld row at 420).
    const why = withheldWhy && !late && state.phase !== 'reason' ? (
      <p data-withheld-why className="truncate pl-[26px] pr-3 pt-[3px] pb-1 bg-secondary border-b border-border font-mono text-[10.5px] text-muted-foreground" title={withheldWhy}>{withheldWhy}</p>
    ) : null;
    return (
      <div role="status" data-permission-ask={agent.id} title={late ? `${LATE_WHO} ${LATE_REST}` : line.title} className="shrink-0 flex flex-col">
      <div
        className={`shrink-0 flex items-center gap-2 pl-3 pr-1 bg-secondary border-b border-border select-none ${state.phase === 'reason' ? 'py-1' : 'h-[26px]'}`}
      >
        <StatusSquare tone="waiting" />
        {state.phase === 'reason' ? (
          <>
            {reasonField}
            <div className="shrink-0 flex items-center">
              <Button variant="ghost" size="sm" className={ACTION} onClick={deny}>deny</Button>
              <Button variant="ghost" size="sm" className={ACTION} onClick={back}>back</Button>
            </div>
          </>
        ) : late ? lateLine : (
          <>
            <p className="min-w-0 flex-1 flex items-baseline gap-1 text-[11px] leading-tight text-muted-foreground">
              <span className="shrink-0 text-foreground">{line.who}</span>
              <span ref={measure} data-subject className="min-w-0 truncate font-mono">{withheld ? `${line.subject} · ${withheldWhy ? 'withheld' : 'content withheld'}` : line.subject}</span>
            </p>
            <div className="shrink-0 flex items-center">
              {withheld ? null : state.fits ? (
                <Button variant="ghost" size="sm" className={ACTION} disabled={busy} onClick={() => answer('allow')}>allow</Button>
              ) : (
                <Button variant="ghost" size="sm" className={ACTION} disabled={busy} onClick={() => update({ shown: true })} title="Read the whole call before allowing it">show all</Button>
              )}
              <Button variant="ghost" size="sm" className={ACTION} disabled={busy} onClick={() => update({ phase: 'reason' })}>deny</Button>
              <Button variant="ghost" size="sm" className={ACTION} disabled={busy} onClick={() => answer('ask')} title="Claude Code's own dialog, which has no delay: answer it there">ask in terminal</Button>
            </div>
          </>
        )}
      </div>
      {why}
      </div>
    );
  }

  // The window, and a panel that opened the call whole: the same block.
  return (
    <div role="status" data-permission-ask={agent.id} className="shrink-0 flex flex-col gap-2 px-3 py-2.5 bg-secondary border-b border-border">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2">
          <StatusSquare tone="waiting" />
          <span className="text-xs text-foreground truncate" title={line.title}>{line.who.replace(/:$/, '')}</span>
        </div>
        {line.at && <span className="shrink-0 font-mono text-[11px] text-text-muted">{line.at}</span>}
      </div>
      {line.subject && (
        <p className={`px-2.5 py-[7px] border border-border ${TERMINAL_SURFACE_CLASS} font-mono text-xs leading-[18px] text-foreground break-all select-text`}>
          {/* Each line on its own: a break is never read as a space (the Audit's M1 on PR 544). */}
          {line.lines.map((l, i) => <span key={i} data-subject-line className="block">{l}</span>)}
          {withheld && <span className="text-muted-foreground">{` · ${withheldWhy ? 'withheld' : 'content withheld'}`}</span>}
        </p>
      )}
      {withheldWhy && <p data-withheld-why className="font-mono text-[11px] leading-[15px] text-muted-foreground break-words">{withheldWhy}</p>}
      {(line.reason || line.rule) && (
        <dl className="grid grid-cols-[30px_minmax(0,1fr)] gap-x-2.5 gap-y-[3px] text-[11px] leading-[15px] select-text">
          {line.reason && (
            <>
              <dt className="font-mono text-text-muted">why</dt>
              <dd className="text-muted-foreground break-words">{line.reason}</dd>
            </>
          )}
          {line.rule && (
            <>
              <dt className="font-mono text-text-muted">rule</dt>
              <dd className="font-mono text-muted-foreground break-all">{line.rule}</dd>
            </>
          )}
        </dl>
      )}
      {state.phase === 'reason' ? (
        <div className="flex items-center gap-1.5">
          {reasonField}
          <Button size="sm" className={`shrink-0 ${ACTION}`} onClick={deny}>deny</Button>
          <Button size="sm" className={`shrink-0 ${ACTION}`} onClick={back}>back</Button>
        </div>
      ) : late ? lateLine : (
        <div className="flex items-center gap-1.5">
          {!withheld && <Button size="sm" className={ACTION} disabled={busy} onClick={() => answer('allow')}>allow</Button>}
          <Button size="sm" className={ACTION} disabled={busy} onClick={() => update({ phase: 'reason' })}>deny</Button>
          <Button size="sm" className={ACTION} disabled={busy} onClick={() => answer('ask')} title="Claude Code's own dialog, which has no delay: answer it there">ask in terminal</Button>
        </div>
      )}
    </div>
  );
}
