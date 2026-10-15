'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { TaskReport } from '@/types/electron';
import { useClaude } from '@/hooks/useClaude';
import { Button, Dropdown, Panel, PanelCaption, SegmentedControl } from '@/components/ui';
import type { DropdownOption } from '@/components/ui';
import { fmtTokens, getModelDisplayName } from '@/lib/usage-format';
import { USAGE_VIEW_KEY, agentViewFilter, projectName, totalsByAgent, usageViewOf, viewCounts } from '@/lib/agent-costs';
import type { AgentTotal, UsageView } from '@/lib/agent-costs';
import {
  TASKS_PAGE,
  agentName,
  agentOptions,
  averagesBy,
  dominantModel,
  durationLabel,
  endLabel,
  filterTasks,
  inWindow,
  moneyText,
  moreLabel,
  projectOptions,
  providerText,
  sinceDaysFor,
  sourceText,
  startLabel,
  taskText,
  tokensTotal,
  totalText,
} from '@/lib/task-costs';
import type { AverageRow, FilterOption, TaskFilter } from '@/lib/task-costs';

/** The value of "All projects" and "All agents" in the pickers. */
const ALL = '__all__';

const NOT_COUNTED_NOTE =
  'Not counted: a CLI in a terminal that writes no transcript, such as Codex or Gemini. Over ACP, a task is counted at what the run reports.';

/**
 * What an agent's row holds: its tasks begun in the timeframe, each at its own
 * cost, as the task view lists them. The charts above read every transcript, by
 * turn, so they also hold a task begun earlier, what came before Tars recorded
 * tasks, and Claude Code sessions Tars did not start (the Audit, #408 and #416).
 */
const AGENT_ROWS_NOTE =
  'A row adds up the agent\'s tasks begun in this timeframe, each at its own cost from its first turn to its last. The charts above count by turn, and also hold what no row does: a task begun earlier, what came before Tars recorded tasks (1.9.3), and Claude Code sessions Tars did not start.';

/** The header cells: 10px uppercase, as a panel's caption. */
const HEAD = 'pb-1.5 font-normal text-[10px] uppercase tracking-[0.08em] text-muted-foreground border-b border-border';
/** Every column after the first: the frame's 10px between columns. */
const CELL = 'pl-2.5';
const MONO = 'font-mono text-[11px] text-text-secondary';

/**
 * The columns at the window's width, as `Usage · cost per task` draws them at
 * 1440: model and turns go first below 1400px, provider and tokens below
 * 1280, so the task's own words keep room to be read.
 */
const WIDE = 'hidden min-[1400px]:table-cell';
const MID = 'hidden xl:table-cell';

const countOf = (n: number) => (n === 1 ? '1 task' : `${n} tasks`);
const agentsOf = (n: number) => (n === 1 ? '1 agent' : `${n} agents`);

/** A picker's options, with the one picked kept even when the window holds none of its tasks. */
function withPicked(all: string, total: number, options: FilterOption[], picked: string | null, labelOf: (v: string) => string): DropdownOption[] {
  const list: DropdownOption[] = [{ value: ALL, label: all, hint: countOf(total) }, ...options];
  if (picked && !options.some(o => o.value === picked)) list.push({ value: picked, label: labelOf(picked), hint: countOf(0) });
  return list;
}

/**
 * The cost of each task (PLAN-1.9.3.md item 2, #305's usage.tasks), under the
 * four charts and over the page's one timeframe: the tasks, newest first,
 * twenty at a time, filtered by project and agent, and the averages per agent
 * and per model over the tasks listed. Frame: `Usage · cost per task`, and its
 * light copy. Or the same tasks by agent, one row each, from the switch at the
 * head of the list, which the page remembers: `Usage · cost per agent`.
 */
export function TaskCosts({ start, length, control }: {
  /** The window's first moment: the page's own, not the 24-hour periods usage.tasks counts in. */
  start: Date;
  /** `14 DAYS`, for the captions. */
  length: string;
  /** `14 days`, for the sentences. */
  control: string;
}) {
  // The page's own figures, from the one store every view of them shares: new
  // when the transcripts move, which is when the tasks are read again. And each
  // Claude account's name by its id, for the account a task ran on.
  const { data } = useClaude();
  const accountRateLimits = data?.accountRateLimits;
  const accountLabels = useMemo(
    () => Object.fromEntries((accountRateLimits ?? []).map(account => [account.accountId, account.label])),
    [accountRateLimits],
  );
  const [report, setReport] = useState<TaskReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TaskFilter>({ projectPath: null, agentId: null });
  const [view, setView] = useState<UsageView>('task');
  const startMs = start.getTime();
  // The list a "show more" was for: another window or filter starts at twenty again.
  const listKey = `${startMs}|${filter.projectPath ?? ''}|${filter.agentId ?? ''}`;
  const [paging, setPaging] = useState({ key: listKey, shown: TASKS_PAGE });
  const shown = paging.key === listKey ? paging.shown : TASKS_PAGE;
  // An answer to an earlier question, arriving after a later one, is dropped.
  const asked = useRef(0);

  useEffect(() => {
    const read = window.electronAPI?.usage?.tasks;
    if (!read) return;
    const mine = ++asked.current;
    read({ sinceDays: sinceDaysFor(new Date(startMs), Date.now()) }).then(
      answer => { if (asked.current === mine) { setReport(answer); setError(null); } },
      (err: unknown) => { if (asked.current === mine) setError(err instanceof Error ? err.message : String(err)); },
    );
  }, [startMs, data]);

  // The view last picked, read once mounted: there is no storage when the page is built.
  useEffect(() => {
    try { setView(usageViewOf(window.localStorage.getItem(USAGE_VIEW_KEY))); } catch { /* storage refused: by task */ }
  }, []);
  const pickView = (next: UsageView) => {
    setView(next);
    try { window.localStorage.setItem(USAGE_VIEW_KEY, next); } catch { /* not remembered, still shown */ }
  };

  const names = useMemo(() => report?.agentNames ?? {}, [report]);
  const inTimeframe = useMemo(() => (report ? inWindow(report.tasks, new Date(startMs)) : []), [report, startMs]);
  // By agent, the agent picked steps aside: every agent of the project is a row.
  const listed = useMemo(() => filterTasks(inTimeframe, view === 'agent' ? agentViewFilter(filter) : filter), [inTimeframe, filter, view]);
  const counts = useMemo(() => viewCounts(inTimeframe, filter), [inTimeframe, filter]);
  const agents = useMemo(() => (view === 'agent' ? totalsByAgent(listed, accountLabels) : []), [view, listed, accountLabels]);
  const byAgent = useMemo(() => averagesBy(listed, t => t.agentId), [listed]);
  const byModel = useMemo(() => averagesBy(listed, t => dominantModel(t) ?? t.provider ?? 'claude'), [listed]);

  const now = new Date();
  const notCounted = listed.filter(t => t.costUSD === null).length;
  const more = moreLabel(Math.min(shown, listed.length), listed.length);
  const projectLabel = (value: string) => value.split(/[\\/]/).filter(Boolean).pop() ?? value;

  let body: ReactNode;
  if (error) {
    body = <p className="text-xs text-danger">{`The tasks could not be read: ${error}`}</p>;
  } else if (!report) {
    body = <p className="text-xs text-muted-foreground">Reading the transcripts of the tasks…</p>;
  } else if (inTimeframe.length === 0) {
    body = (
      <p className="text-xs text-muted-foreground">
        {`No task in these ${control}. A task starts when an agent takes a prompt, typed in its window or handed to it, and ends at its next rest.`}
      </p>
    );
  } else if (listed.length === 0) {
    body = (
      <p className="text-xs text-muted-foreground">
        {view === 'agent' ? `No task in these ${control} for the project picked.` : `No task in these ${control} for the project and the agent picked.`}
      </p>
    );
  } else if (view === 'agent') {
    body = (
      <>
        <AgentTable rows={agents} names={names} />
        <p className="text-[11px] text-muted-foreground">{AGENT_ROWS_NOTE}</p>
        {notCounted > 0 && <p className="text-[11px] text-muted-foreground">{NOT_COUNTED_NOTE}</p>}
      </>
    );
  } else {
    body = (
      <>
        <table className="w-full table-fixed border-collapse text-left">
          <thead>
            <tr>
              <th className={HEAD}>Task</th>
              <th className={`${HEAD} ${CELL} w-[110px]`}>Agent</th>
              <th className={`${HEAD} ${CELL} ${MID} w-[122px]`}>Provider</th>
              <th className={`${HEAD} ${CELL} ${WIDE} w-[102px]`}>Model</th>
              <th className={`${HEAD} ${CELL} w-[86px]`}>Started</th>
              <th className={`${HEAD} ${CELL} w-[86px]`}>Ended</th>
              <th className={`${HEAD} ${CELL} w-[66px] text-right`}>Time</th>
              <th className={`${HEAD} ${CELL} ${WIDE} w-[50px] text-right`}>Turns</th>
              <th className={`${HEAD} ${CELL} ${MID} w-[66px] text-right`}>Tokens</th>
              <th className={`${HEAD} ${CELL} w-[90px] text-right`}>Own</th>
              <th className={`${HEAD} ${CELL} w-[90px] text-right`}>Total</th>
            </tr>
          </thead>
          <tbody>
            {listed.slice(0, shown).map(t => {
              const model = dominantModel(t);
              const tokens = tokensTotal(t);
              const total = totalText(t);
              const ended = t.outcome === 'error' || t.outcome === 'stopped';
              return (
                <tr key={t.id} data-task-row className="align-top border-b border-border hover:bg-secondary">
                  <td className="py-[7px]">
                    <p data-cell="text" className="text-xs text-foreground truncate" title={taskText(t)}>{taskText(t)}</p>
                    <p data-cell="source" className="mt-0.5 font-mono text-[10.5px] text-muted-foreground truncate">
                      {sourceText(t, names)}
                      {ended && (
                        <>
                          {' · '}
                          <span className={t.outcome === 'error' ? 'text-status-error' : 'text-status-idle'}>{t.outcome}</span>
                        </>
                      )}
                    </p>
                  </td>
                  <td data-cell="agent" className={`py-[7px] pl-2.5 text-xs truncate ${names[t.agentId] ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {agentName(t.agentId, names)}
                  </td>
                  <td data-cell="provider" className={`py-[7px] pl-2.5 text-xs text-text-secondary truncate ${MID}`}>
                    {providerText(t, accountLabels)}
                  </td>
                  <td data-cell="model" className={`py-[7px] pl-2.5 ${MONO} truncate ${WIDE}`}>
                    {model ? getModelDisplayName(model) : '-'}
                  </td>
                  <td data-cell="started" className={`py-[7px] pl-2.5 ${MONO} whitespace-nowrap`}>{startLabel(t.startedAt, now)}</td>
                  <td data-cell="ended" className={`py-[7px] pl-2.5 font-mono text-[11px] whitespace-nowrap ${t.endedAt === null ? 'text-status-running' : 'text-text-secondary'}`}>
                    {endLabel(t, now)}
                  </td>
                  <td data-cell="time" className={`py-[7px] pl-2.5 ${MONO} text-right whitespace-nowrap`}>{durationLabel(t.durationMs)}</td>
                  <td data-cell="turns" className={`py-[7px] pl-2.5 ${MONO} text-right ${WIDE}`}>{t.turns}</td>
                  <td data-cell="tokens" className={`py-[7px] pl-2.5 ${MONO} text-right ${MID}`}>{tokens === null ? '-' : fmtTokens(tokens)}</td>
                  <td data-cell="own" className={`py-[7px] pl-2.5 font-mono text-[11px] text-right whitespace-nowrap ${t.costUSD === null ? 'text-muted-foreground' : 'text-status-running'}`}>
                    {moneyText(t.costUSD)}
                  </td>
                  <td data-cell="total" className="py-[7px] pl-2.5 text-right whitespace-nowrap">
                    <p className={`font-mono text-[11px] ${t.costUSD === null && t.totalCostUSD === 0 ? 'text-muted-foreground' : 'text-status-running'}`}>{total.text}</p>
                    {total.partial && <p className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">partial</p>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {(notCounted > 0 || more) && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted-foreground">{notCounted > 0 ? NOT_COUNTED_NOTE : ''}</p>
            {more && (
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-mono text-[11px] text-muted-foreground">{`${shown} of ${listed.length}`}</span>
                <Button size="sm" className="font-mono lowercase" onClick={() => setPaging({ key: listKey, shown: shown + TASKS_PAGE })}>
                  {more}
                </Button>
              </div>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <Panel data-tasks-panel className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <PanelCaption>{`${view === 'agent' ? 'AGENTS' : 'TASKS'} · ${length}`}</PanelCaption>
            {inTimeframe.length > 0 && (
              <SegmentedControl
                options={[
                  { value: 'task', label: `By task (${counts.tasks})` },
                  { value: 'agent', label: `By agent (${counts.agents})` },
                ]}
                value={view}
                onChange={pickView}
                ariaLabel="Show the tasks one by one, or by agent"
              />
            )}
          </div>
          {inTimeframe.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-muted-foreground">
                {view === 'agent'
                  ? `${agentsOf(agents.length)}${notCounted > 0 ? ` · ${countOf(notCounted)} not counted` : ''}`
                  : `${countOf(listed.length)}${notCounted > 0 ? ` · ${notCounted} not counted` : ''}`}
              </span>
              <Dropdown
                value={filter.projectPath ?? ALL}
                options={withPicked('All projects', inTimeframe.length, projectOptions(inTimeframe), filter.projectPath, projectLabel)}
                onChange={value => setFilter(f => ({ ...f, projectPath: value === ALL ? null : value }))}
                size="sm"
                align="right"
                className="w-48"
                ariaLabel="Show the tasks of one project"
              />
              {view === 'task' && (
                <Dropdown
                  value={filter.agentId ?? ALL}
                  options={withPicked('All agents', inTimeframe.length, agentOptions(inTimeframe, names), filter.agentId, id => agentName(id, names))}
                  onChange={value => setFilter(f => ({ ...f, agentId: value === ALL ? null : value }))}
                  size="sm"
                  align="right"
                  className="w-48"
                  ariaLabel="Show the tasks of one agent"
                />
              )}
            </div>
          )}
        </div>
        {body}
      </Panel>

      {/* The averages of the tasks listed: the timeframe, then the project picked, and by task the agent picked. */}
      {listed.length > 0 && !error && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
          <Averages which="agent" caption={`AVERAGE PER AGENT · ${length}`} rows={byAgent} nameOf={key => agentName(key, names)} known={key => key in names} />
          <Averages which="model" caption={`AVERAGE PER MODEL · ${length}`} rows={byModel} nameOf={getModelDisplayName} mono />
        </div>
      )}
    </>
  );
}

function Averages({ which, caption, rows, nameOf, known, mono = false }: {
  which: 'agent' | 'model';
  caption: string;
  rows: AverageRow[];
  nameOf: (key: string) => string;
  /** False for an agent deleted since: its name is gone, and it reads muted. */
  known?: (key: string) => boolean;
  mono?: boolean;
}) {
  return (
    <Panel data-task-averages={which} className="flex flex-col gap-2.5">
      <PanelCaption>{caption}</PanelCaption>
      <table className="w-full table-fixed border-collapse text-left">
        <thead>
          <tr>
            <th className={HEAD}>Name</th>
            <th className={`${HEAD} ${CELL} w-[58px] text-right`}>Tasks</th>
            <th className={`${HEAD} ${CELL} w-[74px] text-right`}>Counted</th>
            <th className={`${HEAD} ${CELL} w-[90px] text-right`}>Per task</th>
            <th className={`${HEAD} ${CELL} w-[74px] text-right`}>Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.key} data-average-row className="h-8 border-b border-border">
              <td data-cell="name" className={`truncate ${mono ? 'font-mono text-[11px]' : 'text-[12.5px]'} ${known && !known(row.key) ? 'text-muted-foreground' : 'text-foreground'}`}>
                {nameOf(row.key)}
              </td>
              <td data-cell="tasks" className={`pl-2.5 ${MONO} text-right`}>{row.tasks}</td>
              <td data-cell="counted" className={`pl-2.5 ${MONO} text-right`}>{row.counted}</td>
              <td data-cell="cost" className={`pl-2.5 font-mono text-[11px] text-right whitespace-nowrap ${row.costUSD === null ? 'text-muted-foreground' : 'text-status-running'}`}>
                {moneyText(row.costUSD)}
              </td>
              <td data-cell="time" className={`pl-2.5 ${MONO} text-right whitespace-nowrap`}>{durationLabel(row.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

/**
 * One row per agent over the tasks listed, the dearest first: its project, the
 * provider and account of its latest task with any other under it, its tasks
 * (the running ones said), the time of those that ended, its tokens and the
 * sum of its own costs, partial when a task of it is not counted.
 */
function AgentTable({ rows, names }: { rows: AgentTotal[]; names: Record<string, string> }) {
  return (
    <table className="w-full table-fixed border-collapse text-left">
      <thead>
        <tr>
          <th className={HEAD}>Agent</th>
          <th className={`${HEAD} ${CELL} w-[130px]`}>Project</th>
          <th className={`${HEAD} ${CELL} ${MID} w-[150px]`}>Provider</th>
          <th className={`${HEAD} ${CELL} w-[70px] text-right`}>Tasks</th>
          <th className={`${HEAD} ${CELL} w-[74px] text-right`}>Time</th>
          <th className={`${HEAD} ${CELL} w-[74px] text-right`}>Tokens</th>
          <th className={`${HEAD} ${CELL} w-[100px] text-right`}>Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => {
          const others = row.providers.slice(1).join(', ');
          return (
            <tr key={row.agentId} data-agent-row className="align-top border-b border-border hover:bg-secondary">
              <td data-cell="agent" className="py-[7px]">
                <p data-value className={`text-xs truncate ${row.agentId in names ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {agentName(row.agentId, names)}
                </p>
              </td>
              <td data-cell="project" className="py-[7px] pl-2.5">
                <p data-value className="text-xs text-text-secondary truncate">{projectName(row.projectPath)}</p>
              </td>
              <td data-cell="provider" className={`py-[7px] pl-2.5 ${MID}`}>
                <p data-value className="text-xs text-text-secondary truncate">{row.providers[0]}</p>
                {others && <p data-sub className="mt-0.5 font-mono text-[10.5px] text-muted-foreground truncate" title={others}>{`also ${others}`}</p>}
              </td>
              <td data-cell="tasks" className="py-[7px] pl-2.5 text-right">
                <p data-value className={MONO}>{row.tasks}</p>
                {row.running > 0 && <p data-sub className="mt-0.5 font-mono text-[10.5px] text-status-running whitespace-nowrap">{`${row.running} running`}</p>}
              </td>
              <td data-cell="time" className="py-[7px] pl-2.5 text-right">
                <p data-value className={`${MONO} whitespace-nowrap`}>{durationLabel(row.durationMs)}</p>
              </td>
              <td data-cell="tokens" className="py-[7px] pl-2.5 text-right">
                <p data-value className={MONO}>{row.tokens === null ? '-' : fmtTokens(row.tokens)}</p>
              </td>
              <td data-cell="cost" className="py-[7px] pl-2.5 text-right whitespace-nowrap">
                <p data-value className={`font-mono text-[11px] ${row.costUSD === null ? 'text-muted-foreground' : 'text-status-running'}`}>{moneyText(row.costUSD)}</p>
                {row.partial && <p data-sub className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">partial</p>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
