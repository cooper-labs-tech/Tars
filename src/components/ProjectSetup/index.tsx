'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, PanelCaption, SegmentedControl, StatusSquare } from '@/components/ui';
import type { SegmentedOption } from '@/components/ui';
import type { AgentStatus } from '@/types/electron';
import type { AgentPermissionMode } from '@/types/agent';
import { lastPathPart } from '@/lib/display-path';
import { ipcReason } from '@/lib/ipc-error';
import {
  ciDoneLine, ciLine, claudeMdDoneLine, claudeMdLine, permissionOutcome, teamOf,
  type OfferLine, type SetupLine,
} from '@/lib/project-setup';

type Setup = NonNullable<NonNullable<typeof window.electronAPI>['projectSetup']>;
type Offer = Extract<Awaited<ReturnType<Setup['offer']>>, { success: true }>;

const MODES: SegmentedOption<AgentPermissionMode>[] = [
  { value: 'plan', label: 'plan' },
  { value: 'normal', label: 'normal' },
  { value: 'auto', label: 'auto' },
  { value: 'bypass', label: 'bypass' },
];

/**
 * What a project is offered so that the team's workflow runs there (2.0.7, PR 586's electronAPI.projectSetup; frame
 * `First run (2.0.7) · states`, its rows `what a project is offered`, `after yes, and what is not offered`, `see it`
 * and `a project's panel, its team there`): its CI workflow and its CLAUDE.md, each written only on the user's yes,
 * and, in a project's panel once it has agents, one permission level for its whole team. Main decides what applies.
 * `firstRun`: under the first run's folder step, where the team does not exist yet; else a project's panel.
 */
export default function ProjectSetup({ projectPath, agents, firstRun = false, tracked = true, onAddToTars }: {
  projectPath: string;
  agents?: readonly AgentStatus[];
  firstRun?: boolean;
  /** One of Tars's projects (added, or an agent's): main offers nothing for a folder Claude Code has only seen. */
  tracked?: boolean;
  /** Adds the folder to Tars, as + Project does; the offers are read once it is. */
  onAddToTars?: () => Promise<void>;
}) {
  const [offer, setOffer] = useState<{ of: string; is: Offer | null; error?: string } | null>(null);
  const [done, setDone] = useState<{ of: string; ci?: SetupLine & { note?: string }; claudeMd?: SetupLine }>({ of: projectPath });
  const [adding, setAdding] = useState<{ of: string; error?: string } | null>(null);
  const [shown, setShown] = useState<'ci' | 'claude-md' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const team = teamOf(agents ?? [], projectPath);
  const common = team.length > 0 && team.every(a => a.permissionMode === team[0].permissionMode) ? team[0].permissionMode : undefined;
  const [mode, setMode] = useState<AgentPermissionMode | null>(null);
  const [applied, setApplied] = useState<{ of: string; lines: SetupLine[] } | null>(null);

  useEffect(() => {
    const setup = window.electronAPI?.projectSetup;
    if (!setup || !tracked) return;
    let live = true;
    setup.offer(projectPath)
      .then(r => { if (live) setOffer(r.success ? { of: projectPath, is: r } : { of: projectPath, is: null, error: r.error }); })
      .catch((err: unknown) => { if (live) setOffer({ of: projectPath, is: null, error: ipcReason(err, 'Tars could not read what this project is offered.') }); });
    return () => { live = false; };
  }, [projectPath, tracked]);

  const known = offer?.of === projectPath ? offer : null;
  const answered = done.of === projectPath ? done : { of: projectPath };
  if (!window.electronAPI?.projectSetup) return null;

  // A folder Tars does not know: the way on beside the reason (frame `First run (2.0.7) · states`, its row `a folder
  // Tars does not know`).
  if (!tracked) {
    const add = async () => {
      setAdding({ of: projectPath });
      try {
        await onAddToTars?.();
      } catch (err) {
        setAdding({ of: projectPath, error: ipcReason(err, 'The folder could not be added.') });
      }
    };
    const failed = adding?.of === projectPath ? adding.error : undefined;
    return (
      <div data-project-setup={projectPath} className="flex flex-col gap-2">
        <PanelCaption>Set up for your team</PanelCaption>
        <Line data="unknown" line={{ tone: 'idle', text: 'Tars does not know this folder yet: add it to Tars, and it is offered its CI and CLAUDE.md.' }}>
          {onAddToTars && (
            <Button size="sm" className="font-mono" disabled={adding?.of === projectPath && !failed} onClick={() => { void add(); }}>add it to Tars</Button>
          )}
        </Line>
        {failed && <Line line={{ tone: 'error', text: failed }} />}
      </div>
    );
  }
  if (!known) return null;

  const yes = async (what: 'ci' | 'claude-md') => {
    const setup = window.electronAPI?.projectSetup;
    if (!setup) return;
    setBusy(what);
    try {
      const line = what === 'ci'
        ? ciDoneLine(await setup.writeCi(projectPath), projectPath)
        : claudeMdDoneLine(await setup.writeClaudeMd(projectPath));
      setDone(d => ({ ...(d.of === projectPath ? d : { of: projectPath }), [what === 'ci' ? 'ci' : 'claudeMd']: line }));
    } catch (err) {
      const line: SetupLine = { tone: 'error', text: ipcReason(err, 'Nothing was written.') };
      setDone(d => ({ ...(d.of === projectPath ? d : { of: projectPath }), [what === 'ci' ? 'ci' : 'claudeMd']: line }));
    } finally {
      setBusy(null);
      setShown(null);
    }
  };

  const level = mode ?? common ?? 'auto';
  const apply = async () => {
    const setup = window.electronAPI?.projectSetup;
    if (!setup) return;
    setBusy('permission');
    try {
      setApplied({ of: projectPath, lines: permissionOutcome(await setup.setTeamPermissionMode(projectPath, level), level) });
    } catch (err) {
      setApplied({ of: projectPath, lines: [{ tone: 'error', text: ipcReason(err, 'The level could not be set.') }] });
    } finally {
      setBusy(null);
    }
  };

  const name = lastPathPart(projectPath) || projectPath;
  const is = known.is;
  const ci = is ? ciLine(is.ci, projectPath) : null;
  const md = is ? claudeMdLine(is.claudeMd) : null;
  const preview = (what: 'ci' | 'claude-md') => {
    if (!is || shown !== what) return null;
    const file = what === 'ci' ? is.ci : is.claudeMd;
    if (file.state !== 'offer') return null;
    return (
      <div data-setup-preview={what} className="ml-3.5 flex flex-col gap-1">
        <p className="font-mono text-[11px] text-text-muted break-all">{file.path}</p>
        <pre className="max-h-[240px] overflow-auto px-3 py-2.5 bg-background border border-border font-mono text-[11px] leading-[1.45] text-text-secondary whitespace-pre">{file.content}</pre>
      </div>
    );
  };
  const offerRow = (what: 'ci' | 'claude-md', line: OfferLine | null, after: (SetupLine & { note?: string }) | undefined, label: string) => {
    if (!line) return null;
    const open = line.offer && !after;
    return (
      <div className="flex flex-col gap-1.5">
        <Line data={what} line={after ?? line}>
          {open && (
            <>
              <Button size="sm" className="font-mono lowercase" disabled={busy !== null} onClick={() => { void yes(what); }}>{label}</Button>
              <Button size="sm" className="font-mono lowercase" onClick={() => setShown(shown === what ? null : what)}>{shown === what ? 'hide it' : 'see it'}</Button>
            </>
          )}
        </Line>
        {after?.note && <p className="ml-3.5 text-[11.5px] leading-[1.45] text-text-muted">{after.note}</p>}
        {open && preview(what)}
      </div>
    );
  };

  return (
    <div data-project-setup={projectPath} className="flex flex-col gap-2">
      {firstRun
        ? <p className="text-[13px] text-foreground">Offered for {name}</p>
        : <PanelCaption>Set up for your team</PanelCaption>}
      {known.error && <Line line={{ tone: 'error', text: known.error }} />}
      {offerRow('ci', ci, answered.ci, 'add the CI workflow')}
      {offerRow('claude-md', md, answered.claudeMd, 'write CLAUDE.md')}
      {firstRun ? (
        <p className="text-[11.5px] leading-[1.45] text-text-muted">Your team&apos;s permission level is chosen when you deploy it: New team, Options, Permissions.</p>
      ) : team.length > 0 && (
        <>
          <div data-setup="permission" className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-foreground">Every agent of {name} works in</span>
            <SegmentedControl ariaLabel={`Permission level for every agent of ${name}`} className="font-mono" options={MODES} value={level} onChange={setMode} />
            <Button size="sm" variant="primary" className="font-mono lowercase" disabled={busy !== null} onClick={() => { void apply(); }}>
              apply to {team.length} agent{team.length === 1 ? '' : 's'}
            </Button>
          </div>
          {applied?.of === projectPath && (
            <div data-setup="permission-result" className="flex flex-col gap-1.5">
              {applied.lines.map((l, i) => <Line key={i} line={l} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Line({ line, data, children }: { line: SetupLine; data?: string; children?: ReactNode }) {
  return (
    <div data-setup={data} className="flex items-center gap-2 text-xs">
      <StatusSquare tone={line.tone} />
      <span className={`min-w-0 flex-1 break-words ${line.tone === 'idle' ? 'text-text-muted' : 'text-foreground'}`}>{line.text}</span>
      {children && <span className="flex shrink-0 items-center gap-1.5">{children}</span>}
    </div>
  );
}
