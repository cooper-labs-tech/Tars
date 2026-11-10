'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button, Input, StatusSquare } from '@/components/ui';
import type { AgentStatus, PermissionQuestionWhole } from '@/types/electron';
import { afterRefusedAllow, permissionAskLine, questionFields } from '@/lib/permission-ask';
import { flat } from '@/lib/stop-line';
import { TERMINAL_SURFACE_CLASS } from '@/lib/terminal-theme';

const ACTION = 'font-mono lowercase';

/** What main keeps of a reason (permission-asks.ts); the field takes no more. */
const MAX_REASON = 200;

const LATE_WHO = 'Tars no longer holds this question:';
const LATE_REST = 'if its terminal asks, answer there.';
const CHANGED = 'The agent asked about another call: this is the new one. Read it, then answer.';
const TERMINAL_TITLE = 'Claude Code\'s own dialog, for what only it offers: allowing a command for the rest of the session, for instance';

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
  /** The question whole, read from main (agent.permissionQuestion) when the view is cut or gives no fingerprint. */
  whole?: PermissionQuestionWhole;
  /** An allow main refused because the question changed in between: the new one is `whole`, said so. */
  changed?: boolean;
  /** The askedAt an allow was refused on, while the agent's copy still carries it: this state is the new question's. */
  alias?: string;
}

const fresh = (of: string | undefined): State => ({ of, phase: 'answers', reason: '', fits: false, shown: false });
const holds = (s: State, askedAt: string | undefined) => s.of === askedAt || (s.alias !== undefined && s.alias === askedAt);

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
export default function PermissionAskNotice({ agent, layout, onAskedInTerminal }: {
  agent: Pick<AgentStatus, 'id' | 'status' | 'permissionAsk'>;
  layout: 'panel' | 'window';
  /**
   * Tars handed the question back to Claude Code's dialog. A host that shows no terminal under the question (a
   * chat's page) brings the agent's terminal into view, where that dialog waits (frame `Permission asked of Tars`,
   * its row `ask in terminal from a chat`). Not called when Tars no longer held the question.
   */
  onAskedInTerminal?: () => void;
}) {
  const ask = agent.permissionAsk;
  const askedAt = ask?.askedAt;
  const withheld = ask?.withheld === true;
  /** What was withheld and why, as the state mod says it (\`command: 3,014 characters, past the 2,000 the window shows\`). */
  const withheldWhy = withheld ? ask?.withheldWhy : undefined;
  const [kept, setKept] = useState<State>(() => fresh(askedAt));
  const state: State = holds(kept, askedAt) ? kept : fresh(askedAt);
  const update = useCallback(
    (next: Partial<State>) => setKept(prev => ({ ...(holds(prev, askedAt) ? prev : fresh(askedAt)), ...next })),
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

  // The question whole, when the view does not hold it (cut, or no fingerprint to name): read once per question,
  // where it is shown whole (the window, or a panel's show all). Until then, no allow.
  const needsWhole = !!ask && !withheld && (!!ask.cut?.length || !ask.fingerprint);
  const reading = needsWhole && !state.whole && (layout === 'window' || state.shown) && state.phase !== 'late';
  useEffect(() => {
    if (!reading) return;
    let live = true;
    const read = window.electronAPI?.agent?.permissionQuestion;
    if (!read) { update({ phase: 'late' }); return; }
    read(agent.id)
      .then(r => { if (live) update(r.success ? { whole: r.question } : { phase: 'late' }); })
      .catch(() => { if (live) update({ phase: 'late' }); });
    return () => { live = false; };
  }, [reading, agent.id, update]);

  const line = permissionAskLine(agent);
  if (!line || !ask) return null;

  // What is shown, and the fingerprint every answer names: the whole question once read, else the view when it holds
  // the question whole (main gives its fingerprint then).
  const shown = state.whole
    ? { fields: state.whole.fields, jsonFields: state.whole.jsonFields, fingerprint: state.whole.fingerprint }
    : needsWhole ? null : { fields: ask.fields, jsonFields: ask.jsonFields ?? [], fingerprint: ask.fingerprint };
  const fingerprint = shown?.fingerprint ?? ask.fingerprint;
  const busy = state.phase === 'sending' || state.phase === 'sent';

  const answer = async (decision: Decision, reason?: string) => {
    if (busy) return;
    update({ phase: 'sending' });
    let taken = false;
    try {
      const result = await window.electronAPI?.agent?.answerPermission?.(agent.id, decision, reason, fingerprint);
      taken = result?.success === true;
    } catch {
      taken = false;
    }
    if (!taken && decision === 'allow') {
      // Refused: the question changed in between (another fingerprint), or Tars holds none. A new one is shown, said
      // so, and nothing is allowed by itself.
      let now: PermissionQuestionWhole | null = null;
      try {
        const r = await window.electronAPI?.agent?.permissionQuestion?.(agent.id);
        now = r?.success ? r.question : null;
      } catch { now = null; }
      if (now && afterRefusedAllow(fingerprint, now) === 'changed') {
        const next = now;
        setKept(prev => (holds(prev, askedAt) ? { ...fresh(next.askedAt), alias: askedAt, shown: true, whole: next, changed: true } : prev));
        return;
      }
    }
    // Taken: off until the agent's next state takes the line away. Not taken:
    // the time ran out, the turn ended, or another window answered first.
    setKept(prev => (holds(prev, askedAt) ? { ...prev, phase: taken ? 'sent' : 'late' } : prev));
    if (taken && decision === 'ask') onAskedInTerminal?.();
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
    // Allowed from the line only when it holds the call whole and the view gives its fingerprint; a cut view opens
    // whole first (frame `Permission asked of Tars`, its row `a cut view, and while it is read`).
    const allowHere = state.fits && !needsWhole && !!fingerprint;
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
              <span ref={measure} data-subject className="min-w-0 truncate whitespace-pre font-mono">{withheld ? `${line.subject} · ${withheldWhy ? 'withheld' : 'content withheld'}` : line.subject}</span>
            </p>
            <div className="shrink-0 flex items-center">
              {withheld ? null : allowHere ? (
                <Button variant="ghost" size="sm" className={ACTION} disabled={busy} onClick={() => answer('allow')}>allow</Button>
              ) : (
                <Button variant="ghost" size="sm" className={ACTION} disabled={busy} onClick={() => update({ shown: true })} title="Read the whole call before allowing it">show all</Button>
              )}
              <Button variant="ghost" size="sm" className={ACTION} disabled={busy} onClick={() => update({ phase: 'reason' })}>deny</Button>
              <Button variant="ghost" size="sm" className={ACTION} disabled={busy} onClick={() => answer('ask')} title={TERMINAL_TITLE}>ask in terminal</Button>
            </div>
          </>
        )}
      </div>
      {why}
      </div>
    );
  }

  // The fields to show: the whole question once read; while it is read, the view's fields it holds whole.
  const cutNames = new Set((ask.cut ?? []).map(c => c.field));
  const fields = withheld ? [] : shown
    ? questionFields(shown.fields, shown.jsonFields)
    : questionFields(Object.fromEntries(Object.entries(ask.fields).filter(([n]) => !cutNames.has(n))), ask.jsonFields ?? []);
  // Why Claude Code asks and the rule that asked, the question shown's, flattened as the line does.
  const why = state.whole ? flat(state.whole.reason) : line.reason;
  const rule = state.whole ? flat(state.whole.rule) : line.rule;

  // The window, and a panel that opened the call whole: the same block. Where
  // its column is too short for it (a panel in the board's smallest cell, a
  // low window), it shrinks to what the column holds: its head and its
  // answers keep their place, and the call, why and the rule scroll between
  // them, inside the block only (JeanBrasse's report of 2026-10-22:
  // the block overflowed the panel, which clips, and allow and deny were out
  // of reach outside full screen). Since 2.0.7 each field is shown by name and
  // whole, a long one with its size above it, and allow comes first, naming the
  // fingerprint of the question shown (frame `Permission asked of Tars`, its rows
  // `approve a file, shown whole` and `the question changed`).
  return (
    <div role="status" data-permission-ask={agent.id} className="min-h-0 flex flex-col gap-2 px-3 py-2.5 bg-secondary border-b border-border">
      <div className="shrink-0 flex items-center justify-between gap-3">
        <div className="min-w-0 flex items-center gap-2">
          <StatusSquare tone="waiting" />
          <span className="text-xs text-foreground truncate" title={line.title}>{state.whole && state.changed ? `Asks to use ${state.whole.tool}` : line.who.replace(/:$/, '')}</span>
        </div>
        {line.at && <span className="shrink-0 font-mono text-[11px] text-text-muted">{line.at}</span>}
      </div>
      {state.changed && !late && (
        <p data-ask-changed className="shrink-0 flex items-center gap-2 text-xs text-foreground">
          <StatusSquare tone="waiting" />
          <span className="min-w-0 break-words">{CHANGED}</span>
        </p>
      )}
      <div data-ask-details className="min-h-0 flex flex-col gap-2 overflow-y-auto">
        {withheld ? (
          <>
            {line.subject && (
              <p className={`px-2.5 py-[7px] border border-border ${TERMINAL_SURFACE_CLASS} font-mono text-xs leading-[18px] text-foreground break-all select-text`}>
                {line.lines.map((l, i) => <span key={i} data-subject-line className="block whitespace-pre-wrap">{l}</span>)}
                <span className="text-muted-foreground">{` · ${withheldWhy ? 'withheld' : 'content withheld'}`}</span>
              </p>
            )}
            {withheldWhy && <p data-withheld-why className="font-mono text-[11px] leading-[15px] text-muted-foreground break-words">{withheldWhy}</p>}
          </>
        ) : fields.map((f, i) => (
          <div key={f.name} data-ask-field={f.name} className="flex flex-col gap-1">
            <p className="font-mono text-[11px] leading-[15px] text-text-muted break-all">{f.size ? `${f.name} · ${f.size}` : f.name}</p>
            <p className={`px-2.5 py-[7px] border border-border ${TERMINAL_SURFACE_CLASS} font-mono text-xs leading-[18px] text-foreground break-all select-text`}>
              {/* Each line on its own: a break is never read as a space (the Audit's M1 on PR 544). The main field's
                  lines one by one; a long one as one text, its breaks kept, so a file of 3 MiB draws in one pass. */}
              {i === 0
                ? f.lines.map((l, k) => <span key={k} data-subject-line className="block whitespace-pre-wrap">{l || ' '}</span>)
                : <span className="block whitespace-pre-wrap">{f.lines.join('\n')}</span>}
            </p>
          </div>
        ))}
        {!withheld && !shown && !late && (
          <p data-ask-reading className="font-mono text-[11px] text-text-muted">reading the whole question</p>
        )}
        {(why || rule) && (
          <dl className="grid grid-cols-[30px_minmax(0,1fr)] gap-x-2.5 gap-y-[3px] text-[11px] leading-[15px] select-text">
            {why && (
              <>
                <dt className="font-mono text-text-muted">why</dt>
                <dd className="text-muted-foreground break-words">{why}</dd>
              </>
            )}
            {rule && (
              <>
                <dt className="font-mono text-text-muted">rule</dt>
                <dd className="font-mono text-muted-foreground break-all">{rule}</dd>
              </>
            )}
          </dl>
        )}
      </div>
      {state.phase === 'reason' ? (
        <div className="shrink-0 flex items-center gap-1.5">
          {reasonField}
          <Button size="sm" className={`shrink-0 ${ACTION}`} onClick={deny}>deny</Button>
          <Button size="sm" className={`shrink-0 ${ACTION}`} onClick={back}>back</Button>
        </div>
      ) : late ? lateLine : (
        <div className="shrink-0 flex items-center gap-1.5">
          {!withheld && shown && fingerprint && <Button size="sm" className={ACTION} disabled={busy} onClick={() => answer('allow')}>allow</Button>}
          <Button size="sm" className={ACTION} disabled={busy} onClick={() => update({ phase: 'reason' })}>deny</Button>
          <Button variant="ghost" size="sm" className={ACTION} disabled={busy} onClick={() => answer('ask')} title={TERMINAL_TITLE}>ask in terminal</Button>
        </div>
      )}
    </div>
  );
}
