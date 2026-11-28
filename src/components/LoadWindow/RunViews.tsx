'use client';

import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import { StatusSquare } from '@/components/ui';
import { Toggle } from '@/components/Settings/Toggle';
import { clockOf } from '@/lib/traces-format';
import type { LoadRunView, LoadTestResult } from '@/types/electron';
import {
  BLOCK_ORDER, BLOCK_WORDS, Box, Chip, MEMORY_LINE, STOP_SHORT, STOP_WORDS, Stat, WindowValues, blockedTotal, minutes, nameOf, pad, short, splitWord, stopSentence,
} from './bits';

/** The clock the running window counts with, every 15 s. */
function useNow(every = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), every); return () => clearInterval(t); }, [every]);
  return now;
}

const about = (run: LoadRunView) => Math.round((run.window.rate_per_hour * run.window.window_min) / 60);

/** The blocked arrivals by reason, each a chip in the waiting tone when some were. */
function BlockedChips({ run }: { run: LoadRunView }) {
  return (
    <div className="flex flex-wrap gap-2">
      {BLOCK_ORDER.map(r => <Chip key={r} tone={run.blocked[r] ? 'waiting' : undefined}>{BLOCK_WORDS[r]} {run.blocked[r] ?? 0}</Chip>)}
    </div>
  );
}

/** A task's test as the frames say it: passed, failed with its count, or not run with its reason. */
function TestChip({ test }: { test?: LoadTestResult }) {
  if (!test) return <Chip>no test</Chip>;
  if (test.result === 'passed') return <Chip tone="running">passed</Chip>;
  if (test.result === 'failed') return <Chip tone="error">failed</Chip>;
  return <Chip tone="idle">not run</Chip>;
}
const testDetail = (test?: LoadTestResult) => {
  if (!test) return '';
  if (test.result === 'not_run') return test.reason ?? '';
  if (test.result === 'failed') {
    const counts = test.failed !== undefined && test.passed !== undefined ? `, ${test.failed} of ${test.failed + test.passed} tests` : '';
    return `${test.exitCode !== undefined ? `exit ${test.exitCode}` : ''}${counts}`.replace(/^, /, '');
  }
  return '';
};

/**
 * The window at work (`Shell · Load window card · running`): time left and its bar, arrivals planned, started and
 * blocked, each load agent with its task and how much of its cap it has used, the tests that ended, the blocked
 * arrivals, and the Stop switch. The run's progress is main's (`load.state().running`).
 */
export function Running({ run, onStop, stopError, stopping }: { run: LoadRunView; onStop: () => void; stopError: string | null; stopping: boolean }) {
  const now = useNow();
  const left = Math.max(0, Math.ceil((run.endsAt - now) / 60_000));
  const span = Math.max(1, run.endsAt - run.approvedAt);
  const done = Math.min(1, Math.max(0, (now - run.approvedAt) / span));
  const blocked = blockedTotal(run);
  const atWork = run.agents.filter(a => a.taskId).length;
  const finished = [...run.finished].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));

  return (
    <div data-load-running className="flex-1 min-h-0 overflow-y-auto px-[26px] pt-[18px] pb-[22px]">
      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          <div>
            <p className="flex items-baseline gap-3">
              <span className="font-serif text-[34px] leading-[1.1] text-foreground">{left} min left</span>
              <span className="font-mono text-[11.5px] text-muted-foreground">running since {clockOf(run.approvedAt)}, approved by you · ends at {clockOf(run.endsAt)}</span>
            </p>
            <div className="mt-2 h-1 bg-secondary"><div className="h-1 bg-status-running" style={{ width: `${Math.round(done * 100)}%` }} /></div>
          </div>
          <div className="flex gap-3">
            <Stat caption="Planned" value={run.planned} sub={`arrivals in ${run.window.window_min} min, seed ${run.window.seed}`} />
            <Stat caption="Started" value={run.started} sub={`${run.finishedCount} finished, ${run.runningNow} running`} />
            <Stat caption="Blocked" value={blocked} sub="by reason, below" tone={blocked ? 'waiting' : undefined} />
          </div>

          <Box caption="Load agents" meta={`${atWork} of ${run.agents.length} at work`}>
            {run.agents.map(a => {
              const used = a.startedAt ? minutes(now - a.startedAt) : 0;
              const share = a.capMin ? Math.min(1, used / a.capMin) : 0;
              const late = share > 0.85;
              return (
                <div key={a.agentId} data-load-agent={a.name} className="flex items-center gap-3 px-4 py-[9px] border-t border-border">
                  <StatusSquare tone={a.taskId ? 'running' : 'idle'} />
                  <span className="w-[150px] shrink-0">
                    <span className="block text-[13px] text-foreground">{a.name}</span>
                    <span className="block font-mono text-[11px] text-muted-foreground truncate">{nameOf(a.project)} · {a.harness}</span>
                  </span>
                  {a.taskId ? (
                    <>
                      <span className="flex-1 min-w-0 text-[12.5px] text-foreground truncate">{a.taskId}{a.split ? ` · ${splitWord(a.split)}` : ''}</span>
                      {a.capMin !== undefined && (
                        <span className="w-[200px] shrink-0">
                          <span className={`block font-mono text-[11px] ${late ? 'text-status-waiting' : 'text-text-secondary'}`}>{used} of {a.capMin} min of its cap</span>
                          <span className="mt-1 block h-1 bg-secondary"><span className={`block h-1 ${late ? 'bg-status-waiting' : 'bg-status-running'}`} style={{ width: `${Math.round(share * 100)}%` }} /></span>
                        </span>
                      )}
                    </>
                  ) : <span className="flex-1 min-w-0 text-[12.5px] text-muted-foreground">free: waits for the next arrival</span>}
                </div>
              );
            })}
            <p className="px-4 py-2.5 border-t border-border text-[11.5px] text-muted-foreground">{MEMORY_LINE}</p>
          </Box>

          <Box caption="Finished" meta={`${finished.length}, newest first`}>
            {finished.slice(0, 3).map(f => (
              <div key={f.n} className="flex items-center gap-3 px-4 py-[9px] border-t border-border">
                <span className="w-[230px] shrink-0 text-[12.5px] text-foreground truncate">#{pad(f.n)} {nameOf(f.project)} · {f.taskId}</span>
                {f.end === 'at_cap' ? <Chip tone="waiting">at cap</Chip> : <TestChip test={f.test} />}
                <span className="flex-1 min-w-0 text-[11.5px] text-muted-foreground truncate">{testDetail(f.test)}</span>
                <span className="font-mono text-[11px] text-text-secondary shrink-0">
                  session {f.startedAt && f.endedAt ? minutes(f.endedAt - f.startedAt) : 0} min · slot wait {minutes(f.test?.slotWaitMs ?? 0)} min
                </span>
              </div>
            ))}
            <p className="px-4 py-2.5 border-t border-border text-[11.5px] text-muted-foreground">
              {finished.length > 3 ? `${finished.length - 3} more. ` : finished.length === 0 ? 'None yet. ' : ''}A test not run is not a failure, and never stops the window.
            </p>
          </Box>

          <Box caption="Blocked arrivals" meta="recorded, not queued">
            <div className="px-4 pb-3 space-y-2">
              <BlockedChips run={run} />
              {run.blockedArrivals.map(b => (
                <p key={b.n} className="flex gap-4 font-mono text-[11.5px] text-text-secondary">
                  <span className="w-[40px] shrink-0">{clockOf(b.at)}</span>
                  <span className="w-[260px] shrink-0 truncate">#{pad(b.n)} {nameOf(b.project)} · {b.taskId}</span>
                  <span className="flex-1 min-w-0">{BLOCK_WORDS[b.reason]}{b.detail ? `: ${b.detail}` : ''}</span>
                </p>
              ))}
            </div>
          </Box>
        </div>

        <div className="w-[300px] shrink-0 flex flex-col gap-3">
          <Box caption="Stop">
            <div className="px-4 pb-3 space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] text-foreground">Stop the window</span>
                <Toggle label="Stop the window" enabled={stopping} disabled={stopping} onChange={onStop} />
              </div>
              <p className="text-[11.5px] leading-[1.45] text-muted-foreground">No new arrival starts, and the running sessions are stopped where they are, each in its worktree.</p>
              {stopError && <p data-load-error className="text-[11.5px] text-status-error">{stopError}</p>}
            </div>
          </Box>
          <WindowValues window={run.window} caption="Window" meta="as approved" about={about(run)} />
          <p className="font-mono text-[11px] text-muted-foreground">{run.pool} · snapshot {short(run.snapshotSha256)} · {run.tasks} tasks</p>
        </div>
      </div>
    </div>
  );
}

/**
 * The window after it ended (`Shell · Load window card · ended`): how it stopped, the summary, the tests, the blocked
 * arrivals by reason, the projects, and the load agents kept for the next window.
 */
export function Ended({ run }: { run: LoadRunView }) {
  const stop = run.stop!;
  const tests = { passed: 0, failed: 0, not_run: 0 };
  let atCap = 0; let sessionMs = 0; let waitMs = 0;
  for (const f of run.finished) {
    if (f.end === 'at_cap') atCap++;
    if (f.test) tests[f.test.result]++;
    if (f.startedAt && f.endedAt) sessionMs += f.endedAt - f.startedAt;
    waitMs += f.test?.slotWaitMs ?? 0;
  }
  const byProject = new Map<string, { started: number; passed: number; failed: number; notRun: number; atCap: number; blocked: number }>();
  const of = (p: string) => { const n = nameOf(p); if (!byProject.has(n)) byProject.set(n, { started: 0, passed: 0, failed: 0, notRun: 0, atCap: 0, blocked: 0 }); return byProject.get(n)!; };
  for (const f of run.finished) {
    const p = of(f.project); p.started++;
    if (f.end === 'at_cap') p.atCap++;
    if (f.test?.result === 'passed') p.passed++; else if (f.test?.result === 'failed') p.failed++; else if (f.test?.result === 'not_run') p.notRun++;
  }
  for (const b of run.blockedArrivals) of(b.project).blocked++;
  const hm = (ms: number) => { const m = minutes(ms); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
  const notRunReasons = [...new Set(run.finished.filter(f => f.test?.result === 'not_run' && f.test.reason).map(f => f.test!.reason!))];
  const blocked = blockedTotal(run);

  return (
    <div data-load-ended className="flex-1 min-h-0 overflow-y-auto px-[26px] pt-[18px] pb-[22px]">
      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          <div className="flex items-center gap-3 px-4 py-3 border border-border-strong bg-secondary">
            <StatusSquare tone={stop.reason === 'error' ? 'error' : 'idle'} />
            <span data-load-stop className="flex-1 min-w-0 text-[13px] text-foreground">{stopSentence(run)}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{STOP_WORDS[stop.reason]}</span>
          </div>
          <div className="flex gap-3">
            <Stat caption="Planned" value={run.planned} sub={`seed ${run.window.seed}`} />
            <Stat caption="Started" value={run.started} sub="tests below" />
            <Stat caption="Blocked" value={blocked} sub="by reason, below" tone={blocked ? 'waiting' : undefined} />
            <Stat caption="At cap" value={atCap} sub="stopped at its time cap" tone={atCap ? 'waiting' : undefined} />
          </div>
          <Box caption="Tests" meta={`${run.started} started`}>
            <div className="px-4 pb-3 space-y-2">
              <div className="flex flex-wrap gap-2">
                <Chip tone={tests.passed ? 'running' : undefined}>passed {tests.passed}</Chip><Chip tone={tests.failed ? 'error' : undefined}>failed {tests.failed}</Chip>
                <Chip tone={tests.not_run ? 'idle' : undefined}>not run {tests.not_run}</Chip><Chip tone={atCap ? 'waiting' : undefined}>at cap {atCap}</Chip>
              </div>
              <p className="text-[11.5px] text-muted-foreground">
                {notRunReasons.length ? `Not run: ${notRunReasons.join('; ')} (${tests.not_run}). Not a failure. ` : ''}Sessions {hm(sessionMs)} in all; waiting for the slot {hm(waitMs)}, counted apart.
              </p>
            </div>
          </Box>
          <Box caption="Blocked, by reason" meta={`${blocked}, recorded, not queued`}>
            <div className="px-4 pb-3"><BlockedChips run={run} /></div>
          </Box>
          <Box caption="By project">
            {byProject.size === 0 && <p className="px-4 py-2.5 border-t border-border text-[11.5px] text-muted-foreground">No task started in this window.</p>}
            {[...byProject.entries()].map(([name, p]) => (
              <div key={name} className="flex items-center gap-3 px-4 py-[9px] border-t border-border">
                <span className="w-[200px] shrink-0 text-[13px] text-foreground truncate">{name}</span>
                <span className="flex-1 min-w-0 font-mono text-[11.5px] text-text-secondary truncate">
                  {[`${p.started} started`, p.passed && `${p.passed} passed`, p.failed && `${p.failed} failed`, p.notRun && `${p.notRun} not run`, p.atCap && `${p.atCap} at cap`, p.blocked && `${p.blocked} blocked`].filter(Boolean).join(' · ')}
                </span>
              </div>
            ))}
          </Box>
          <Box caption="Load agents" meta="kept for the next window">
            <div className="px-4 pb-3 space-y-1">
              {run.agents.map(a => (
                <p key={a.agentId} className="flex gap-4 font-mono text-[11.5px] text-text-secondary">
                  <span className="w-[56px] shrink-0 text-foreground">{a.name}</span><span className="truncate">{nameOf(a.project)} · {a.harness}</span><span>free</span>
                </p>
              ))}
              <p className="pt-1 text-[11.5px] text-muted-foreground">{MEMORY_LINE}</p>
            </div>
          </Box>
        </div>
        <div className="w-[300px] shrink-0 flex flex-col gap-3">
          <WindowValues window={run.window} caption="Window" meta="as approved" about={about(run)} />
          <p className="font-mono text-[11px] text-muted-foreground">{clockOf(run.approvedAt)} to {clockOf(stop.at)} · approved by you · {run.pool} · snapshot {short(run.snapshotSha256)}</p>
        </div>
      </div>
    </div>
  );
}

/** Nothing proposed (`Shell · Load window card · nothing to approve`), with the last window in one line. */
export function Nothing({ last }: { last?: LoadRunView }) {
  return (
    <div data-load-nothing className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-[26px] text-center">
      <Gauge className="w-6 h-6 text-muted-foreground" />
      <h3 className="font-serif text-[24px] leading-[1.15] text-foreground">No load window waits for you</h3>
      <p className="max-w-[560px] text-[12.5px] leading-[1.5] text-text-secondary">
        Tars proposes one when a pool of tasks is written under ~/.tars/load-pools. It shows here, and in the sidebar, until you approve it or say not now. Nothing starts before.
      </p>
      {last?.stop && (
        <p className="font-mono text-[11px] text-muted-foreground">
          Last window: {clockOf(last.approvedAt)} to {clockOf(last.stop.at)}, {last.started} started, {blockedTotal(last)} blocked, {STOP_SHORT[last.stop.reason]}.
        </p>
      )}
    </div>
  );
}
