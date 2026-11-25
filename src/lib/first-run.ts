import type { ElectronAPI } from '@/types/electron';
import type { StatusTone } from '@/components/ui';

/**
 * What the first run and New team say from main's answers (2.0.7, PR 584's channels; frame `First run (2.0.7) ·
 * states`). Main gives the facts and their order; these give each its words and its way on.
 */

type Readiness = Extract<Awaited<ReturnType<NonNullable<ElectronAPI['project']>['readiness']>>, { success: true }>;
type GitInitAnswer = Awaited<ReturnType<NonNullable<ElectronAPI['project']>['gitInit']>>;
type DeployAnswer = Awaited<ReturnType<NonNullable<ElectronAPI['teams']>['deploy']>>;

export type Lack = { key: string; text: string; action?: 'git-init' };

const LACK_TEXT: Record<Readiness['missing'][number], string> = {
  git: 'Git is not installed.',
  repository: 'Not a git repository.',
  commit: 'No first commit yet.',
  remote: 'No remote: add one, for instance gh repo create --source . --push',
  gh: 'The GitHub CLI is not installed.',
  'gh-sign-in': 'The GitHub CLI is not signed in: run gh auth login.',
};

/** Each lack in main's order, a folder with no repository or no first commit offered make it a repository. */
export function readinessLines(r: Readiness): Lack[] {
  const lines: Lack[] = r.missing.map(key => ({
    key, text: LACK_TEXT[key], ...(key === 'repository' || key === 'commit' ? { action: 'git-init' as const } : {}),
  }));
  if (r.remote && !r.remote.github) {
    lines.push({ key: 'remote-off-github', text: `The remote ${r.remote.name} is not on GitHub: pull requests go through GitHub.` });
  }
  return lines;
}

/** What a first commit made, and why it is signed Tars when it is. */
export function gitInitLine(a: GitInitAnswer): { tone: StatusTone; text: string } {
  if (!a.success) return { tone: 'error', text: a.error };
  const made = `Made a repository on ${a.branch}: ${a.files} file${a.files === 1 ? '' : 's'} in its first commit`;
  return a.identity === 'tars'
    ? { tone: 'running', text: `${made}, signed Tars, since git knows no name of yours. Set yours with git config --global user.name and user.email.` }
    : { tone: 'running', text: `${made}.` };
}

/**
 * What New team says of a deploy, whole or not at all, and the way on it offers. `brief` and `lead` (the team's
 * orchestrator member) say a brief that went to nobody: main gives it only to an orchestrator it made (team-deploy.ts),
 * so a skipped one, already on the project, does not get it.
 */
export function deployOutcome(a: DeployAnswer, opts: { brief?: string; lead?: string } = {}):
  { done: boolean; tone: StatusTone; offer: 'repository' | 'signed-out' | null; lines: string[] } {
  if (a.success) {
    const lost = !!opts.brief?.trim() && !!opts.lead && a.skipped.some(s => s.member === opts.lead);
    return {
      done: true, tone: lost ? 'waiting' : 'running', offer: null,
      lines: [
        ...a.skipped.map(s => `Skipped: ${s.member}, ${s.reason}.`),
        ...a.notStarted.map(s => `Not started: ${s.member}, ${s.reason}.`),
        ...(lost ? [`The brief went to nobody: ${opts.lead} was already on this project. Give it the task yourself, in its chat or its terminal.`] : []),
      ],
    };
  }
  if (a.code === 'not-a-repository') return { done: false, tone: 'waiting', offer: 'repository', lines: [a.error] };
  if (a.code === 'signed-out') {
    return { done: false, tone: 'waiting', offer: 'signed-out', lines: ['Claude Code is signed out: the team\'s agents cannot work until it is signed in.'] };
  }
  if (a.code === 'cli-missing') return { done: false, tone: 'waiting', offer: null, lines: ['Claude Code is not installed on this computer: install it, then deploy.'] };
  if (a.code === 'failed' && a.failed.length > 0) {
    return {
      done: false, tone: 'error', offer: null,
      lines: [
        `${a.failed[0].member} could not be made: ${a.failed[0].reason}. Nothing was kept.`,
        ...(a.left.length ? [`Left: ${a.left.join('; ')}.`] : []),
      ],
    };
  }
  return { done: false, tone: 'error', offer: null, lines: [a.error] };
}

/** The Claude step's state, from account 1's `claude auth status` (and `code: 'cli-missing'` when there is no claude). */
export function claudeStepState(account: { signedIn: boolean | null; email: string | null; subscriptionType: string | null; error: string | null; code?: 'cli-missing' | null } | undefined):
  { done: boolean; word: string; tone: StatusTone; canSignIn: boolean } {
  if (account?.signedIn === true) {
    return { done: true, word: ['signed in', account.email, account.subscriptionType].filter(Boolean).join(' · '), tone: 'running', canSignIn: false };
  }
  if (account?.code === 'cli-missing') return { done: false, word: 'not installed', tone: 'waiting', canSignIn: false };
  if (account?.signedIn === false) return { done: false, word: 'signed out', tone: 'waiting', canSignIn: true };
  if (account?.error) return { done: false, word: account.error, tone: 'error', canSignIn: true };
  return { done: false, word: 'checking claude', tone: 'idle', canSignIn: true };
}
