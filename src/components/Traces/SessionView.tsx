'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, DialogShell, PanelCaption } from '@/components/ui';
import type { TraceMessageView, TraceOutcome, TraceRequestView, TraceSessionSummary, TraceTurnView } from '@/types/electron';
import { sizeOf as bytes } from '@/lib/traces-format';
import { Unread } from '@/components/Resources/bits';
import { fmtTokens } from '@/lib/usage-format';
import { BACK_OFFICE_COPY_ONE, clockOf, clockSecondsOf, dayClockOf, durationOf, outcomeOf, outcomeWordsOf, projectNameOf, reasonOf } from '@/lib/traces-format';
import { Fact, StateLine } from './bits';
import { tracesApi } from './hooks';
import { ExportDialog } from './ExportDialog';

type Session = { session: TraceSessionSummary; outcome?: TraceOutcome; turns: TraceTurnView[] };
type Messages = { system?: unknown; tools?: unknown[]; input: TraceMessageView[]; output: TraceMessageView[] };

const RQ_COLS = 'grid grid-cols-[22px_120px_56px_60px_50px_76px_190px_minmax(0,1fr)] gap-2.5 items-center px-2.5';

/** "#1 · 14:02 · 7 requests · 5 tool calls · 1 m 12 s" under a turn's author. */
function turnLine(t: TraceTurnView): string {
  const parts = [clockOf(t.startedAt)];
  if (t.gapBeforeMs && t.gapBeforeMs > 60_000) parts.push(`gap ${durationOf(t.gapBeforeMs)}`);
  parts.push(`${t.requests.length} request${t.requests.length === 1 ? '' : 's'}`);
  parts.push(`${t.toolCalls} tool call${t.toolCalls === 1 ? '' : 's'}${t.toolErrors ? `, ${t.toolErrors} error${t.toolErrors === 1 ? '' : 's'}` : ''}`);
  if (t.endedAt) parts.push(durationOf(t.endedAt - t.startedAt));
  return parts.join(' · ');
}

/** The author as the frame writes it: "orchestrator · Tars-Orchestrator", "user", "unknown". */
function authorOf(t: TraceTurnView): string {
  return t.authorDetail ? `${t.author} · ${t.authorDetail}` : t.author;
}

/** One part of a message, as mono lines: its kind and size, then its text. */
function partLines(m: TraceMessageView): string[] {
  return m.parts.flatMap(p => {
    const head = `${p.kind}${p.toolName ? ` · ${p.toolName}` : ''} · ${bytes(p.size)}${p.isError ? ' · error' : ''}`;
    return p.text ? [head, ...p.text.split('\n').slice(0, 12)] : [head];
  });
}

/**
 * Traces · a session's turns: the session's facts, its turns by author, a turn's requests (TTFT, total, status,
 * finish, tokens, the upstream id), and what one request sent and produced, part by part. Read through IPC only.
 */
export function SessionView({ traceId, onBack }: { traceId: string; onBack: () => void }) {
  const [data, setData] = useState<Session | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [turn, setTurn] = useState(0);
  const [request, setRequest] = useState<string | null>(null);
  const [messages, setMessages] = useState<Messages | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** A removal main refused: said in its dialog, above its answers; Delete tries again. */
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const read = useCallback(async () => {
    const api = tracesApi();
    if (!api) return;
    try { setData(await api.session(traceId)); setError(null); } catch (e) { setError(reasonOf(e)); }
  }, [traceId]);
  useEffect(() => { void read(); }, [read]);

  const current = data?.turns[turn];
  useEffect(() => {
    if (current && !current.requests.some(r => r.requestId === request)) setRequest(current.requests[0]?.requestId ?? null);
  }, [current, request]);
  useEffect(() => {
    setMessages(null);
    if (!request) return;
    void tracesApi()?.requestMessages(request).then(setMessages).catch(() => setMessages(null));
  }, [request]);

  const remove = async () => {
    const api = tracesApi();
    if (!api) return;
    try {
      await api.remove({ traceIds: [traceId] });
    } catch (e) {
      // Main's refusal (a full disk) reaches the window as a rejected call: said in the dialog, which stays, never an
      // unhandled rejection.
      console.warn('[traces] deleting a session failed:', e);
      setRemoveError(reasonOf(e));
      return;
    }
    closeDelete();
    onBack();
  };
  const closeDelete = () => { setDeleting(false); setRemoveError(null); };

  if (error) return <Unread text="could not read this session:" detail={error} onRetry={() => { void read(); }} />;
  if (data === null) {
    return (
      <div className="space-y-2.5">
        <Button size="sm" variant="ghost" className="font-mono" onClick={onBack}>{'< all sessions'}</Button>
        <p className="text-[11.5px] text-text-secondary">This session is no longer kept: it was deleted, or went past the cap or its days.</p>
      </div>
    );
  }
  if (!data) return <p className="font-mono text-[10.5px] text-muted-foreground">reading the session</p>;

  const s = data.session;
  const out = outcomeOf(s.finalStatus);
  const authors = Object.entries(data.turns.reduce<Record<string, number>>((acc, t) => { acc[t.author] = (acc[t.author] ?? 0) + 1; return acc; }, {}))
    .map(([a, n]) => `${a} ${n}`).join(' · ');

  return (
    <div className="flex flex-col gap-2.5 flex-1 min-h-0">
      <div className="flex items-center gap-2 shrink-0">
        <Button size="sm" variant="ghost" className="font-mono" onClick={onBack}>{'< all sessions'}</Button>
        <span className="font-mono text-[11px] text-muted-foreground truncate">{`${projectNameOf(s.projectPath)} / ${s.agentName ?? s.agentId} / ${dayClockOf(s.startedAt)}`}</span>
      </div>

      <section role="region" aria-label="Session" className="border border-border bg-card px-3.5 py-3 space-y-2.5 shrink-0">
        <div className="flex items-center gap-2.5">
          <h2 className="text-[15px] text-foreground truncate">{`${s.agentName ?? s.agentId} · ${s.harness}${s.harnessVersion ? ` ${s.harnessVersion}` : ''} on ${s.model}`}</h2>
          <StateLine word={out.word} tone={out.tone} />
          <span className="flex-1" />
          <Button size="sm" className="font-mono" onClick={() => setExporting(true)}>export</Button>
          <Button size="sm" variant="danger" className="font-mono" onClick={() => setDeleting(true)}>delete</Button>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Fact caption="PROJECT" value={projectNameOf(s.projectPath)} />
          <Fact caption="ENDPOINT" value={s.endpointName ?? s.endpointId} />
          <Fact caption="STARTED" value={`${dayClockOf(s.startedAt)}:${String(new Date(s.startedAt).getSeconds()).padStart(2, '0')}`} />
          <Fact caption="ENDED" value={s.endedAt ? clockSecondsOf(s.endedAt) : 'still open'} />
          <Fact caption="TURNS" value={String(s.turnCount)} />
          <Fact caption="REQUESTS" value={String(s.requestCount)} />
          <Fact caption="TOKENS" value={`in ${fmtTokens(s.tokensIn)} · cached ${fmtTokens(s.tokensCached)} · out ${fmtTokens(s.tokensOut)}`} />
          <Fact caption="SIZE" value={bytes(s.bytes)} />
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Fact caption="OUTCOME" value={outcomeWordsOf(data.outcome) || out.word} />
          <Fact caption="AUTHORS" value={`${authors}${s.unknownTurns && !authors.includes('unknown') ? ` · unknown ${s.unknownTurns}` : ''}`} />
          <Fact caption="MIXED" value={s.mixed ? 'yes' : 'no'} />
        </div>
      </section>

      <div className="flex gap-2.5 flex-1 min-h-0">
        <section role="region" aria-label="Turns" className="w-[300px] shrink-0 border border-border bg-card flex flex-col min-h-0">
          <div className="px-2.5 py-2 border-b border-border shrink-0"><PanelCaption>{`TURNS (${data.turns.length})`}</PanelCaption></div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {data.turns.map((t, i) => (
              <button
                key={t.turnId}
                type="button"
                data-trace-turn={t.index}
                onClick={() => setTurn(i)}
                className={`block w-full text-left px-2.5 py-2 border-b border-border cursor-pointer ${i === turn ? 'bg-primary/10' : 'hover:bg-secondary'}`}
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[10.5px] text-muted-foreground">{`#${t.index}`}</span>
                  <span className={`text-xs truncate ${i === turn ? 'text-foreground' : t.author === 'unknown' ? 'text-muted-foreground' : 'text-text-secondary'}`}>{authorOf(t)}</span>
                </span>
                <span className="block mt-0.5 font-mono text-[10.5px] text-muted-foreground">{turnLine(t)}</span>
              </button>
            ))}
          </div>
        </section>

        <section role="region" aria-label="Turn" className="flex-1 min-w-0 border border-border bg-card px-3.5 py-3 flex flex-col gap-2.5 min-h-0 overflow-y-auto">
          {current && (
            <>
              <div className="flex items-center gap-2.5">
                <span className="font-mono text-[11px] text-muted-foreground">{`#${current.index}`}</span>
                <span className="text-[12.5px] text-foreground">{current.authorDetail ? `from ${current.authorDetail}` : current.author}</span>
                <span className="flex-1" />
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  {`model ${durationOf(current.modelMs)} · tools ${durationOf(current.toolMs)} · ${current.toolErrors} tool error${current.toolErrors === 1 ? '' : 's'}`}
                </span>
              </div>
              <RequestTable requests={current.requests} selected={request} onSelect={setRequest} />
              {request && <RequestMessages index={current.requests.find(r => r.requestId === request)?.seq} messages={messages} />}
            </>
          )}
        </section>
      </div>

      {deleting && (
        <DialogShell
          onClose={closeDelete}
          width={560}
          title="Delete this session?"
          subtitle={`${s.agentName ?? s.agentId}, ${dayClockOf(s.startedAt)}: ${s.turnCount} turns, ${s.requestCount} requests, ${bytes(s.bytes)}. The reader can no longer read it. ${BACK_OFFICE_COPY_ONE} This cannot be undone.`}
          footerRight={<>
            <Button onClick={closeDelete}>Cancel</Button>
            <Button variant="danger" onClick={() => { void remove(); }}>Delete</Button>
          </>}
        >
          {removeError && <div data-remove-refused><StateLine word={`not deleted: ${removeError}. Delete tries again.`} tone="error" /></div>}
        </DialogShell>
      )}
      {exporting && <ExportDialog filter={{}} oneSession={s} onClose={() => setExporting(false)} />}
    </div>
  );
}

function RequestTable({ requests, selected, onSelect }: { requests: TraceRequestView[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="border border-border bg-background shrink-0">
      <div className={`${RQ_COLS} h-[26px] border-b border-border font-mono text-[10px] text-muted-foreground`}>
        <span>#</span><span>SURFACE</span><span>TTFT</span><span>TOTAL</span><span>STATUS</span><span>FINISH</span><span>TOKENS IN · CACHED · OUT</span><span>UPSTREAM ID</span>
      </div>
      {requests.map(r => (
        <button
          key={r.requestId}
          type="button"
          data-trace-request={r.seq}
          onClick={() => onSelect(r.requestId)}
          className={`${RQ_COLS} w-full h-7 border-b border-border font-mono text-[11px] text-left cursor-pointer ${selected === r.requestId ? 'bg-secondary' : 'hover:bg-secondary'}`}
        >
          <span className="text-muted-foreground">{r.seq}</span>
          <span className="truncate text-text-secondary">{r.side ? `${r.surface} · side` : r.surface}</span>
          <span className="text-text-secondary">{r.ttftMs !== undefined ? durationOf(r.ttftMs) : ''}</span>
          <span className="text-text-secondary">{r.totalMs !== undefined ? durationOf(r.totalMs) : ''}</span>
          <span className={r.status === 200 ? 'text-text-secondary' : 'text-status-error'}>{r.status}</span>
          <span className="truncate text-text-secondary">{r.finishReason ?? ''}</span>
          <span className="truncate text-text-secondary">{r.tokensIn !== undefined ? `${(r.tokensIn).toLocaleString('en-US')} · ${(r.tokensCached ?? 0).toLocaleString('en-US')} · ${(r.tokensOut ?? 0).toLocaleString('en-US')}` : ''}</span>
          <span className="truncate text-text-secondary">{r.heldMs > 0 ? `held ${durationOf(r.heldMs)}, ${r.attempts} attempt${r.attempts === 1 ? '' : 's'}${r.upstreamRequestId ? ` · ${r.upstreamRequestId}` : ''}` : r.upstreamRequestId ?? r.error ?? ''}</span>
        </button>
      ))}
    </div>
  );
}

function RequestMessages({ index, messages }: { index?: number; messages: Messages | null }) {
  if (!messages) return <p className="font-mono text-[10.5px] text-muted-foreground">reading the request</p>;
  const sent = messages.input.length;
  // The system prompt as main gives it: its size is the size of its text.
  const systemSize = messages.system === undefined ? 0 : (typeof messages.system === 'string' ? messages.system : JSON.stringify(messages.system)).length;
  return (
    <div className="space-y-2">
      <PanelCaption>{`REQUEST ${index ?? ''} · WHAT IT SENT AND WHAT IT PRODUCED`}</PanelCaption>
      <p className="font-mono text-[11px] text-text-secondary">
        {`system ${bytes(systemSize)} · ${messages.tools?.length ?? 0} tools · ${sent} message${sent === 1 ? '' : 's'} sent`}
      </p>
      {[...messages.input.slice(-2), ...messages.output].map((m, i) => (
        <pre key={`${m.hash}-${i}`} data-trace-message={m.role} className="px-2.5 py-2 bg-term-bg border border-border font-mono text-[11.5px] leading-normal text-foreground whitespace-pre-wrap break-words">
          {partLines(m).join('\n')}
        </pre>
      ))}
      <p className="font-mono text-[10.5px] text-muted-foreground">A request is kept whole: what the harness sent the endpoint and what came back, the key removed.</p>
    </div>
  );
}
