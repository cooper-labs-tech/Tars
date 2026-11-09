'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { BrandMark } from '@/components/Brand';
import NewChatModal from '@/components/NewChatModal';
import { ClaudeAccountLoginModal } from '@/components/Settings/ClaudeAccountLoginModal';
import { Button, StatusSquare } from '@/components/ui';
import type { StatusTone } from '@/components/ui';
import { useClaudeAccounts } from '@/hooks/useClaudeAccounts';
import { useElectronAgents, useElectronFS } from '@/hooks/useElectron';
import { lastPathPart } from '@/lib/display-path';

/** Whether a folder is a git repository, and on which branch, as `git branch` answers for it. */
export type FolderRepository = { repository: true; branch: string } | { repository: false };

/** The state line of the Claude step, in the words main gives (`claude auth status`). */
export function claudeStepState(account: { signedIn: boolean | null; email: string | null; subscriptionType: string | null; error: string | null } | undefined):
  { done: boolean; word: string; tone: StatusTone } {
  if (account?.signedIn === true) {
    return { done: true, word: ['signed in', account.email, account.subscriptionType].filter(Boolean).join(' · '), tone: 'running' };
  }
  if (account?.signedIn === false) return { done: false, word: 'signed out', tone: 'waiting' };
  if (account?.error) return { done: false, word: account.error, tone: 'error' };
  return { done: false, word: 'checking claude', tone: 'idle' };
}

/**
 * A new user's first run (frames `First run (2.0.7)` and `· states`; QA's fresh-install report, B3, B4 and M1): sign
 * in to Claude, add a project folder, deploy its team with the orchestrator's first task as its brief. Shown by its
 * host while no project has an agent: the new interface's empty chats page and the classic Dashboard's empty grid.
 * Each step reads its state from main (the accounts' `claude auth status`, the folder's `git branch`); the next opens
 * once the one before is done. Sign in is Settings' own sign-in for account 1; Deploy the team is New team on the
 * folder, which offers a folder that is not a repository its way on.
 */
export default function FirstRun() {
  const { view } = useClaudeAccounts();
  const account = view?.accounts.find(a => a.id === 'default');
  const claude = claudeStepState(account);
  const { projects, openFolderDialog, refresh } = useElectronFS();
  const { createAgent } = useElectronAgents();
  const [added, setAdded] = useState<string | null>(null);
  // The folder this run works on: the one added here, else the first project known.
  const folder = added ?? projects[0]?.path ?? null;
  const [repo, setRepo] = useState<{ of: string; is: FolderRepository } | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    if (!folder) return;
    let live = true;
    void window.electronAPI?.shell?.branch(folder).then(r => {
      if (!live) return;
      const branch = r?.success ? r.output?.trim() : '';
      setRepo({ of: folder, is: branch ? { repository: true, branch } : { repository: false } });
    }).catch(() => { if (live) setRepo({ of: folder, is: { repository: false } }); });
    return () => { live = false; };
  }, [folder]);

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

  const known = folder && repo?.of === folder ? repo.is : null;
  const folderWord = folder
    ? [lastPathPart(folder) || folder, known === null ? 'reading the folder' : known.repository ? `a git repository on ${known.branch}` : 'not a git repository'].join(' · ')
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
          detail={claude.done ? 'Claude Code is signed in on this computer.' : 'Claude Code is not signed in on this computer. Every agent runs on it.'}
          state={{ word: claude.word, tone: claude.tone }}
          action={claude.done ? null : <Button variant="primary" onClick={() => setSigningIn(true)}>Sign in</Button>}
        />
        <Step
          name="project" n={2} done={!!folder}
          title="Add a project folder"
          detail={folder ?? 'The folder your agents work in. In a git repository, each member gets its own worktree.'}
          state={folderWord ? { word: folderWord, tone: known?.repository ? 'running' : 'waiting' } : addError ? { word: addError, tone: 'error' } : null}
          action={<Button size={folder ? 'sm' : undefined} onClick={() => { void addFolder(); }}>{folder ? 'Add another' : 'Add a folder'}</Button>}
        />
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
          onSubmit={async (projectPath, skills, _prompt, model, worktree, character, name, secondaryProjectPath, permissionMode, provider, localModel, obsidianVaultPaths, effort, role, cliPath) => {
            await createAgent({ projectPath, skills, model, worktree, character, name, secondaryProjectPath, permissionMode, provider, localModel, obsidianVaultPaths, effort, role, cliPath });
          }}
          projects={projects.map(p => ({ path: p.path, name: p.name }))}
          onBrowseFolder={openFolderDialog}
          initialMode="team"
          initialProjectPath={folder}
        />
      )}
    </section>
  );
}

function Step({ name, n, done, dim, title, detail, state, action }: {
  name: string; n: number; done: boolean; dim?: boolean; title: string; detail: string;
  state: { word: string; tone: StatusTone } | null; action: ReactNode;
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
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </li>
  );
}
