'use client';

import { useState } from 'react';
import { Server } from 'lucide-react';
import { Button, Input, Select, StatusSquare } from '@/components/ui';
import { clockOf } from '@/lib/traces-format';
import type { LoadProjectState, LoadProposal, LoadWindowParams } from '@/types/electron';
import { BLOCKED_LINE, Box, Chip, MEMORY_LINE, nameOf, pad, poolDirOf, short, splitWord } from './bits';

type Editable = 'rate_per_hour' | 'seed' | 'window_min' | 'max_concurrent' | 'initial_sessions';
const FIELDS: Array<[Editable, string, string?]> = [
  ['rate_per_hour', 'Rate per hour'], ['seed', 'Seed'], ['window_min', 'Length', 'min'], ['max_concurrent', 'Max concurrent'], ['initial_sessions', 'Initial sessions'],
];

/** Why a project's tasks are refused, after "refused", as the frames word it ("with its repository", gUwVy). */
const REFUSED_WHY: Record<LoadProjectState, string> = {
  private: 'with its repository', unknown: 'with its repository', traces_off: 'with its traces off', off: 'with its switch off',
  no_endpoint: 'with no endpoint yet', no_harness: 'with no harness yet', no_repo: 'as it is not a git work tree',
  unknown_project: 'as it is not one of your projects', allowed: '', allowed_by_name: '',
};

/**
 * What can run and what is left out, composed from the case as the frames word it (the Audit's N1 on #695): the
 * refused lines ("27 of 30 tasks can run: 3 lines are refused and left out. The rest can be approved.", JmxYG), then
 * each project refused whole ("30 of 39 tasks can run: ledger-core's 5 are refused with its repository, orbit-docs's
 * 4 with its traces off.", gUwVy). Null when nothing is left out.
 */
function summaryOf(p: LoadProposal): string | null {
  const lines = p.refused.filter(r => r.file === 'tasks.jsonl' && r.line > 0).length;
  const parts: string[] = [];
  if (lines) parts.push(`${lines} line${lines === 1 ? ' is' : 's are'} refused and left out`);
  p.projects.filter(x => x.visibility === 'refused').forEach((x, i) => {
    const why = REFUSED_WHY[x.state] || 'refused';
    parts.push(i === 0 ? `${x.name}'s ${x.tasks} ${x.tasks === 1 ? 'is' : 'are'} refused ${why}` : `${x.name}'s ${x.tasks} ${why}`);
  });
  if (!parts.length) return null;
  return `${p.runnable} of ${p.total} tasks can run: ${parts.join(', ')}.${lines ? ' The rest can be approved.' : ''}`;
}

/** A project of the pool refused whole: its chip, as the frames word it. */
const refusedChip = (state: string) => (state === 'traces_off' ? 'traces off' : state === 'private' ? 'private, not allowed' : state.replace(/_/g, ' '));

/**
 * A window proposed (`Shell · Load window card · approval`, `· refused lines`, `· a private repo refused`): the pool, its
 * projects, every setup line and test command, the endpoint and the load agents, and the window's values, the owner's
 * to change until Approve. What it shows is the snapshot Approve carries: a pool written since is said, not swapped in
 * (main answers that approval `stale`, and the card shows the pool as it is then).
 */
export function Approval({ proposal, changedSince, staleShown, busy, error, onApprove, onNotNow, onProjects }: {
  proposal: LoadProposal;
  /** The pool was written again after this card showed it. */
  changedSince: boolean;
  /** This is the pool shown again after an approval main found stale. */
  staleShown: boolean;
  busy: boolean;
  error: string | null;
  onApprove: (window: Partial<LoadWindowParams>) => void;
  onNotNow: () => void;
  onProjects: () => void;
}) {
  const [typed, setTyped] = useState<Record<Editable, string>>(() => Object.fromEntries(FIELDS.map(([k]) => [k, String(proposal.window[k])])) as Record<Editable, string>);
  const values = Object.fromEntries(FIELDS.map(([k]) => [k, Number(typed[k])])) as Record<Editable, number>;
  const bad = FIELDS.filter(([k]) => !/^\d+$/.test(typed[k].trim())).map(([k]) => k);
  const about = Math.round((values.rate_per_hour * values.window_min) / 60);
  const refusedProjects = proposal.projects.filter(p => p.visibility === 'refused');
  const refusedSome = refusedProjects.length > 0 || proposal.refused.length > 0;
  const summary = summaryOf(proposal);
  const projectName = (p: string) => proposal.projects.find(x => x.path === p)?.name ?? nameOf(p);

  return (
    <div data-load-proposal={short(proposal.sha256)} className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto px-[26px] pt-[18px] pb-[18px]">
        <div className="flex gap-4 items-start">
          <div className="flex-1 min-w-0 flex flex-col gap-3">
            <p className="text-[12.5px] text-text-secondary">Proposed by Tars from the pool {poolDirOf(proposal.dir)}, written at {clockOf(proposal.writtenAt)}.</p>
            {staleShown && (
              <p data-load-stale className="flex items-center gap-1.5 font-mono text-[10.5px] text-status-waiting">
                <StatusSquare tone="waiting" />The pool changed after this card showed it: here it is as it is now. Nothing was approved.
              </p>
            )}
            {changedSince && !staleShown && (
              <p data-load-changed className="flex items-center gap-1.5 font-mono text-[10.5px] text-status-waiting">
                <StatusSquare tone="waiting" />The pool was written again since this card showed it: Approve shows it again, as it is now.
              </p>
            )}

            <Box caption="Pool">
              <div className="px-4 pb-3 space-y-2">
                <p className="flex items-baseline gap-2.5">
                  <span className="text-[14px] font-semibold text-foreground">{proposal.pool}</span>
                  <span className="font-mono text-[12px] text-muted-foreground">snapshot {short(proposal.sha256)}</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  <Chip>train {proposal.counts.train}</Chip><Chip>held-out {proposal.counts.heldout}</Chip><Chip>eval {proposal.counts.eval}</Chip><Chip>tasks {proposal.counts.tasks}</Chip>
                </div>
                {summary && <p data-load-summary className="text-[12px] text-status-waiting">{summary}</p>}
              </div>
            </Box>

            {proposal.refused.length > 0 && (
              <Box caption="Refused lines" tone="error">
                <div className="px-4 pb-3 space-y-1.5">
                  {proposal.refused.map(r => (
                    <div key={`${r.file}:${r.line}:${r.key ?? ''}`} data-load-refused className="flex items-start gap-3">
                      <span className="flex items-center gap-2 w-[200px] shrink-0 font-mono text-[12px] text-foreground">
                        <StatusSquare tone="error" />{r.file}:{r.line}{r.key ? ` · ${r.key}` : ''}
                      </span>
                      <span className="flex-1 min-w-0 text-[12px] text-status-error">{r.reason}</span>
                    </div>
                  ))}
                </div>
              </Box>
            )}

            <Box caption="Projects" meta={proposal.projects.length}>
              {proposal.projects.map(p => (
                <div key={p.path} data-load-project={p.name} className={`flex items-center gap-3 px-4 py-[9px] border-t border-border ${p.visibility === 'refused' ? 'text-muted-foreground' : ''}`}>
                  <span className={`w-[150px] shrink-0 text-[13px] truncate ${p.visibility === 'refused' ? 'text-text-secondary' : 'text-foreground'}`}>{p.name}</span>
                  <span className="flex-1 min-w-0 font-mono text-[11.5px] text-muted-foreground truncate">{p.repo ? `github.com/${p.repo}` : 'no GitHub repository'}</span>
                  {p.visibility === 'public' && <Chip>public</Chip>}
                  {p.visibility === 'allowed_by_name' && <Chip tone="waiting">allowed by name</Chip>}
                  {p.visibility === 'refused' && <Chip tone="error">{refusedChip(p.state)}</Chip>}
                  <span className={`w-[110px] shrink-0 font-mono text-[11.5px] ${p.visibility === 'refused' ? 'text-status-error' : 'text-text-secondary'}`}>
                    {p.visibility === 'refused' ? `refused, ${p.tasks} task${p.tasks === 1 ? '' : 's'}` : `${p.tasks} task${p.tasks === 1 ? '' : 's'}`}
                  </span>
                </div>
              ))}
              {refusedProjects.length > 0 && (
                <div className="px-4 py-2.5 border-t border-border space-y-1.5">
                  {refusedProjects.map(p => (
                    <div key={p.path} data-load-refused-project={p.name} className="flex items-center gap-3">
                      <span className="flex-1 min-w-0 text-[12px] text-status-error">{p.name}: {p.reason}</span>
                      <Button size="sm" onClick={onProjects}>{p.state === 'traces_off' ? 'see it in Projects' : 'allow it in Projects'}</Button>
                    </div>
                  ))}
                </div>
              )}
            </Box>

            <Box caption="Setup and tests" meta="every line, as it will run">
              <div className="mx-4 mb-3 max-h-[360px] overflow-y-auto border border-border bg-background px-3.5 py-3 font-mono text-[12px] leading-[1.55] whitespace-pre">
                {proposal.tasks.map(t => (
                  <div key={t.n}>
                    <div className="text-foreground">#{pad(t.n)}  {projectName(t.project)} · {t.taskId}   {splitWord(t.split)} · cap {t.capMin} min</div>
                    {(t.setup.length ? t.setup : ['none']).map((s, i) => <div key={i} className="text-text-secondary">{'     setup  '}{s}</div>)}
                    <div className="text-text-secondary">{'     test   '}{t.testCmd ?? 'none'}</div>
                  </div>
                ))}
              </div>
            </Box>
          </div>

          <div className="w-[300px] shrink-0 flex flex-col gap-3">
            <Box caption="Window" meta="yours to change">
              <div className="px-4 pb-3 space-y-2">
                {FIELDS.slice(0, 1).map(([k, label, unit]) => <Field key={k} k={k} label={label} unit={unit} typed={typed} setTyped={setTyped} bad={bad.includes(k)} />)}
                <Row label="Distribution"><Select aria-label="Distribution" compact value="poisson" onChange={() => undefined}><option value="poisson">poisson</option></Select></Row>
                {FIELDS.slice(1).map(([k, label, unit]) => <Field key={k} k={k} label={label} unit={unit} typed={typed} setTyped={setTyped} bad={bad.includes(k)} />)}
                <Row label="Pick"><Select aria-label="Pick" compact value="weighted_without_replacement" onChange={() => undefined}><option value="weighted_without_replacement">weighted, no repeat</option></Select></Row>
                <p className="pt-1 text-[11.5px] leading-[1.45] text-muted-foreground">{BLOCKED_LINE(bad.length ? proposal.expectedArrivals : about, bad.length ? proposal.window.window_min : values.window_min)}</p>
              </div>
            </Box>
            <Box caption="Endpoint and agents" meta={proposal.agents.length}>
              <div className="px-4 pb-3 space-y-2">
                {proposal.endpoints.map(e => (
                  <div key={e.id}>
                    <p className="flex items-center gap-2 text-[13px] text-foreground"><Server className="w-3.5 h-3.5 text-muted-foreground" />{e.name}</p>
                    <p className="font-mono text-[11px] text-muted-foreground truncate">{e.baseUrl}</p>
                  </div>
                ))}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[12px] text-text-secondary">harnesses</span>
                  {proposal.harnesses.map(h => <Chip key={h}>{h}</Chip>)}
                </div>
                <div className="space-y-1">
                  {proposal.agents.map(a => (
                    <p key={a.name} className="flex items-baseline gap-3">
                      <span className="w-[52px] shrink-0 text-[12.5px] text-foreground">{a.name}</span>
                      <span className="font-mono text-[11px] text-muted-foreground truncate">{nameOf(a.project)} · {a.harness}</span>
                    </p>
                  ))}
                </div>
                <p className="text-[11.5px] leading-[1.45] text-muted-foreground">Kept between windows. {MEMORY_LINE}</p>
              </div>
            </Box>
            <p className="text-[11.5px] leading-[1.45] text-muted-foreground">Each task runs in a fresh session of its load agent, in its own worktree, at its base commit. Push is blocked. Nothing starts until you approve here: no agent, token or message can.</p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 px-[26px] py-3 border-t border-border shrink-0">
        <span className="flex-1 min-w-0 text-[12px] text-muted-foreground">
          {error ? <span data-load-error className="text-status-error">{error}</span> : 'Approve starts the window now, with these values.'}
        </span>
        <Button onClick={onNotNow} disabled={busy}>Not now</Button>
        <Button variant="primary" disabled={busy || bad.length > 0 || proposal.runnable === 0}
          onClick={() => onApprove(Object.fromEntries(FIELDS.map(([k]) => [k, values[k]])) as Partial<LoadWindowParams>)}>
          {refusedSome ? `Approve ${proposal.runnable} task${proposal.runnable === 1 ? '' : 's'}` : 'Approve'}
        </Button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px] text-text-secondary">{label}</span>
      <span className="w-[150px] shrink-0">{children}</span>
    </div>
  );
}

function Field({ k, label, unit, typed, setTyped, bad }: {
  k: Editable; label: string; unit?: string; typed: Record<Editable, string>; setTyped: (f: (t: Record<Editable, string>) => Record<Editable, string>) => void; bad: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px] text-text-secondary">{label}</span>
      <span className="w-[110px] shrink-0 flex items-center gap-1.5">
        <Input aria-label={label} mono compact inputMode="numeric" value={typed[k]} error={bad} onChange={e => { const v = e.target.value; setTyped(t => ({ ...t, [k]: v })); }} />
        {unit && <span className="font-mono text-[10.5px] text-muted-foreground">{unit}</span>}
      </span>
    </div>
  );
}
