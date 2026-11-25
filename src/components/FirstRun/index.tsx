'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { BrandMark } from '@/components/Brand';
import NewChatModal from '@/components/NewChatModal';
import ProjectSetup from '@/components/ProjectSetup';
import { ClaudeAccountLoginModal } from '@/components/Settings/ClaudeAccountLoginModal';
import { Button, StatusSquare } from '@/components/ui';
import type { StatusTone } from '@/components/ui';
import { useClaudeAccounts } from '@/hooks/useClaudeAccounts';
import { useElectronAgents, useElectronFS } from '@/hooks/useElectron';
import { lastPathPart } from '@/lib/display-path';
import { ipcReason } from '@/lib/ipc-error';
import { claudeStepState, gitInitLine, readinessLines } from '@/lib/first-run';

type Readiness = Extract<Awaited<ReturnType<NonNullable<NonNullable<typeof window.electronAPI>['project']>['readiness']>>, { success: true }>;

/**
 * A new user's first run (frames `First run (2.0.7)` and `· states`; QA's fresh-install report, B3, B4, M1 and W4):
 * sign in to Claude, add a project folder, deploy its team with the orchestrator's first task as its brief. Shown by
 * its host while no project has an agent: the new interface's empty chats page and the classic Dashboard's empty grid.
 * Each step reads its state from main: the accounts' `claude auth status` (and `cli-missing`), the folder's readiness
 * for pull requests in main's order (PR 584), its make it a repository through main's git init. Sign in is Settings'
 * own sign-in for account 1; Deploy the team is New team on the folder, deployed whole or not at all.
 */
export default function FirstRun() {
  const { view } = useClaudeAccounts();
  const account = view?.accounts.find(a => a.id === 'default');
  const claude = claudeStepState(account);
  const { projects, openFolderDialog, refresh } = useElectronFS();
  const { createAgent, startAgent } = useElectronAgents();
  const [added, setAdded] = useState<string | null>(null);
  // The folder this run works on: the one added here, else one added to Tars before. Never a folder Claude Code has
  // only seen: Tars's channels refuse it as not one of its projects (the Audit's M1 on PR 580).
  const folder = added ?? projects.find(p => p.custom)?.path ?? null;
  const [ready, setReady] = useState<{ of: string; is: Readiness | null; error?: string } | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [gitLine, setGitLine] = useState<{ tone: StatusTone; text: string } | null>(null);
  const [reread, setReread] = useState(0);

  // What the folder lacks for pull requests, read again after make it a repository.
  useEffect(() => {
    if (!folder) return;
    let live = true;
    void window.electronAPI?.project?.readiness(folder).then(r => {
      if (live) setReady(r.success ? { of: folder, is: r } : { of: folder, is: null, error: r.error });
    }).catch((err: unknown) => { if (live) setReady({ of: folder, is: null, error: err instanceof Error ? err.message : String(err) }); });
    return () => { live = false; };
  }, [folder, reread]);

  const makeRepository = async () => {
    if (!folder) return;
    const answer = await window.electronAPI?.project?.gitInit(folder)
      .catch((err: unknown) => ({ success: false as const, error: err instanceof Error ? err.message : String(err), code: 'failed' as const }));
    if (!answer) return;
    setGitLine(gitInitLine(answer));
    setReread(n => n + 1);
  };

  const addFolder = async () => {
    setAddError(null);
    try {
      const picked = await openFolderDialog();
      if (!picked) return;
      await window.electronAPI?.fs?.addCustomProject(picked);
      await refresh();
      setAdded(picked);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    }
  };

  const known = folder && ready?.of === folder ? ready : null;
  const lacks = known?.is ? readinessLines(known.is) : [];
  const branch = known?.is?.git.repository && known.is.git.hasCommit ? known.is.git.branch : null;
  const folderWord = folder
    ? [lastPathPart(folder) || folder, !known ? 'reading the folder' : known.error ?? (branch ? `a git repository on ${branch}` : lacks.length ? 'not ready for pull requests' : 'ready')].join(' · ')
    : null;

  return (
    <section role="region" aria-label="First run" className="h-full flex flex-col items-center justify-center gap-3 px-6 pb-[60px]">
      <BrandMark className="w-2.5 h-2.5" />
      <h2 className="font-serif text-[22px] leading-[1.15] text-foreground">Set up your first project</h2>
      <p className="max-w-[560px] text-center text-[12.5px] leading-[1.45] text-text-secondary">
        Three steps, and your project&apos;s orchestrator takes its first task. It hands the work to its team and reports back here.
      </p>
      <ol className="w-full max-w-[620px] flex flex-col gap-2">
        <Step
          name="claude" n={1} done={claude.done}
          title="Sign in to Claude"
          detail={claude.done
            ? 'Claude Code is signed in on this computer.'
            : account?.code === 'cli-missing'
              ? 'Claude Code is not installed on this computer, or not where Settings says it is. Install it, then come back.'
              : 'Claude Code is not signed in on this computer. Every agent runs on it.'}
          state={{ word: claude.word, tone: claude.tone }}
          action={claude.canSignIn ? <Button variant="primary" onClick={() => setSigningIn(true)}>Sign in</Button> : null}
        />
        <Step
          name="project" n={2} done={!!folder}
          title="Add a project folder"
          detail={folder ?? 'The folder your agents work in. In a git repository, they work in worktrees of their own.'}
          state={folderWord ? { word: folderWord, tone: known?.error ? 'error' : branch ? 'running' : 'waiting' } : addError ? { word: addError, tone: 'error' } : null}
          action={<Button size={folder ? 'sm' : undefined} onClick={() => { void addFolder(); }}>{folder ? 'Add another' : 'Add a folder'}</Button>}
        >
          {/* What it lacks for pull requests, in main's order (frame `First run (2.0.7) · states`, its row `what a folder lacks`). */}
          {lacks.map(lack => (
            <p key={lack.key} data-lack={lack.key} className="flex items-center gap-2 text-[11.5px] text-foreground">
              <StatusSquare tone="waiting" />
              <span className="min-w-0 flex-1 break-words">{lack.text}</span>
              {lack.action === 'git-init' && window.electronAPI?.project?.gitInit && (
                <Button size="sm" className="font-mono lowercase" onClick={() => { void makeRepository(); }}>make it a repository</Button>
              )}
            </p>
          ))}
          {gitLine && (
            <p data-git-init={gitLine.tone} className="flex items-start gap-2 text-[11.5px] text-foreground">
              <span className="mt-[5px]"><StatusSquare tone={gitLine.tone} /></span>
              <span className="min-w-0 break-words">{gitLine.text}</span>
            </p>
          )}
          {/* What the folder is offered for the team's workflow, read again once it is made a repository (frame
              `First run (2.0.7) · states`, its row `what a project is offered`). */}
          {folder && <ProjectSetup key={`${folder}:${reread}`} projectPath={folder} firstRun />}
        </Step>
        <Step
          name="team" n={3} done={false} dim={!folder}
          title="Deploy its team, then give the orchestrator its first task"
          detail="An orchestrator and its members, made for this folder. Their first task is yours to write."
          state={null}
          action={<Button variant={folder ? 'primary' : undefined} disabled={!folder} onClick={() => setDeploying(true)}>Deploy the team</Button>}
        />
      </ol>
      {signingIn && <ClaudeAccountLoginModal accountId="default" onClose={() => setSigningIn(false)} />}
      {folder && (
        <NewChatModal
          open={deploying}
          onClose={() => setDeploying(false)}
          // Unreachable with teamOnly; kept whole all the same: started with its task, as New agent does, a refusal said.
          onSubmit={async (projectPath, skills, prompt, model, worktree, character, name, secondaryProjectPath, permissionMode, provider, localModel, obsidianVaultPaths, effort, role, cliPath) => {
            try {
              const agent = await createAgent({ projectPath, skills, model, worktree, character, name, secondaryProjectPath, permissionMode, provider, localModel, obsidianVaultPaths, effort, role, cliPath });
              if (prompt) await startAgent(agent.id, prompt, { model, provider, localModel });
            } catch (err) {
              return { error: ipcReason(err, 'The agent could not be made.') };
            }
          }}
          projects={projects.map(p => ({ path: p.path, name: p.name }))}
          onBrowseFolder={openFolderDialog}
          initialMode="team"
          teamOnly
          initialProjectPath={folder}
        />
      )}
    </section>
  );
}

function Step({ name, n, done, dim, title, detail, state, action, children }: {
  name: string; n: number; done: boolean; dim?: boolean; title: string; detail: string;
  state: { word: string; tone: StatusTone } | null; action: ReactNode; children?: ReactNode;
}) {
  return (
    <li data-first-run-step={name} className="flex items-center gap-3.5 px-4 py-3.5 border border-border bg-secondary">
      <span className={`w-[22px] h-[22px] shrink-0 flex items-center justify-center border border-border font-mono text-[11px] ${done ? 'bg-accent-dim text-accent' : 'bg-card text-text-muted'}`}>
        {done ? <Check className="w-3 h-3" /> : n}
      </span>
      <div className="min-w-0 flex-1 flex flex-col gap-[3px]">
        <p className={`text-[13.5px] ${dim ? 'text-text-muted' : 'text-foreground'}`}>{title}</p>
        <p className="text-[11.5px] leading-[1.45] text-text-muted break-words">{detail}</p>
        {state && (
          <p className="flex items-center gap-1.5 font-mono text-[11px]">
            <StatusSquare tone={state.tone} />
            <span className={state.tone === 'running' ? 'text-status-running' : state.tone === 'waiting' ? 'text-status-waiting' : state.tone === 'error' ? 'text-danger' : 'text-text-muted'}>{state.word}</span>
          </p>
        )}
        {children && <div className="mt-1.5 flex flex-col gap-1.5">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </li>
  );
}
