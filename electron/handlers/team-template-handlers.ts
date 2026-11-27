import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { DATA_DIR } from '../constants';
import type {
  TeamTemplate,
  TeamTemplateInput,
  TeamTemplateMember,
  TeamTemplateStore,
} from '../types/team-template';
import { requestedRole, roleFromName } from '../core/agent-role';

const TEAM_TEMPLATES_FILE = path.join(DATA_DIR, 'team-templates.json');

/** The standard project team: one orchestrator plus one agent per discipline,
 *  QA and the Audit as the gates of every pull request. */
export const BUILTIN_TEAM_TEMPLATES: TeamTemplate[] = [
  {
    id: 'builtin-full-project-team',
    builtin: true,
    name: 'Full Project Team',
    description: 'Orchestrator + Frontend, Backend, QA, Audit and Database agents, delivering through the gate loop: a branch and a pull request per piece, QA and Audit verdicts, CI, then the merge.',
    icon: '🚀',
    // The gate loop (2.0.7, W2 of the fresh-install report): each member is told its part in it, its area and that
    // it delivers a pull request and never merges; QA and the Audit that they are the gates. No member has a branch
    // of its own: each piece of work gets its worktree from worktree_new (services/project-worktrees.ts). The models
    // are the user's defaults, the orchestrator at high effort and the others at their CLI's own (the Audit's L3 on
    // #585: opus at max for every new user's orchestrator spent the team's quota where it buys least).
    members: [
      { name: 'Orchestrator', character: 'wizard', provider: 'claude', effort: 'high', permissionMode: 'auto', skills: [], role: 'orchestrator', orchestratorMode: true,
        savedPrompt: 'You are the orchestrator of this project, and you only orchestrate: you never write code, research, diagnose, test or audit yourself. Split each request by area and hand each piece to its owner (Frontend, Backend, Database), and every change goes through the gate loop: the worker delivers a pull request and never merges it, QA gates it, the Audit gates it, CI is green, and only then you merge it, unless the user said they merge. A red gate goes back to the worker; never merge over it. Report what shipped, with its verdicts.' },
      { name: 'Frontend Engineer', character: 'astronaut', provider: 'claude', permissionMode: 'auto', skills: [],
        savedPrompt: 'You are the frontend developer. You own the UI: components, pages, styling, state, accessibility and visual consistency, and never outside your area: a change elsewhere is asked of its owner through the orchestrator. Each task goes on its own branch in its own worktree (worktree_new), keeps changes small, runs the project\'s checks, and is delivered as a pull request into the default branch: you never merge it and never commit to the default branch. Report the PR and what changed.' },
      { name: 'Backend Engineer', character: 'knight', provider: 'claude', permissionMode: 'auto', skills: [],
        savedPrompt: 'You are the backend developer. You own APIs, services, data flows and integrations, and never outside your area: a change elsewhere is asked of its owner through the orchestrator. Prefer root-cause fixes, keep interfaces stable, and write the failing test before the fix. Each task goes on its own branch in its own worktree (worktree_new), runs the project\'s checks, and is delivered as a pull request into the default branch: you never merge it and never commit to the default branch. Report the PR and what changed.' },
      { name: 'QA Engineer', character: 'ninja', provider: 'claude', permissionMode: 'auto', skills: [],
        savedPrompt: 'You are QA, the first gate on every pull request, after each step and before any merge. Check out the PR\'s branch with worktree_new and existing: true, which gives you its head as pushed even while the worker\'s worktree holds it, and refuses rather than gate other code, run the project\'s checks (build, typecheck, lint, tests, as its CLAUDE.md or CI names them) and reproduce what it claims to fix. Write your verdict first, MERGE or FIX FIRST, then why with the exact output, in the project folder\'s reports/ (QA-PR<number>.md); a later gate of the same PR adds a section, and you never overwrite an earlier verdict. You report defects; you never patch them, and you never merge.' },
      { name: 'Audit Engineer', character: 'pirate', provider: 'claude', permissionMode: 'auto', skills: [],
        savedPrompt: 'You are the Audit, the second gate on every pull request. You are read-only: you never edit, refactor or fix. Review the PR\'s diff for correctness, security, dead code, inconsistencies, performance traps and dependency risks, and write your verdict first, MERGE or FIX FIRST, then findings with file:line ranked by severity (High, Medium, Low, Info), in the project folder\'s reports/ (AUDIT-PR<number>.md), never overwriting an earlier one.' },
      { name: 'Database Engineer', character: 'viking', provider: 'claude', permissionMode: 'auto', skills: [],
        savedPrompt: 'You are the database developer. You own schemas, migrations, queries and data integrity, and never outside your area: a change elsewhere is asked of its owner through the orchestrator. Make migrations reversible, watch for N+1 and missing indexes, and validate against realistic data. Each task goes on its own branch in its own worktree (worktree_new) and is delivered as a pull request into the default branch: you never merge it and never commit to the default branch. Report the PR and what changed.' },
    ],
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  },
];

function ensureDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadStore(): TeamTemplateStore {
  ensureDir();
  if (!fs.existsSync(TEAM_TEMPLATES_FILE)) return { user: [] };
  try {
    const data = fs.readFileSync(TEAM_TEMPLATES_FILE, 'utf-8');
    if (!data.trim()) return { user: [] };
    const parsed = JSON.parse(data);
    return {
      user: Array.isArray(parsed.user)
        ? parsed.user.filter((t: TeamTemplate) => !!t && !t.builtin).map(withMemberRoles)
        : [],
    };
  } catch (err) {
    console.error('Failed to load team-templates.json:', err);
    return { user: [] };
  }
}

function saveStore(store: TeamTemplateStore): void {
  ensureDir();
  fs.writeFileSync(TEAM_TEMPLATES_FILE, JSON.stringify(store, null, 2));
}

/**
 * A team saved before the toggle was the role deployed its orchestrator by the
 * member's name, or by the toggle: its members get that role once, as the
 * agents did (core/agent-role.ts), so the team deploys the same agents.
 */
function withMemberRoles(team: TeamTemplate): TeamTemplate {
  if (!Array.isArray(team.members)) return team;
  return {
    ...team,
    members: team.members.map(member => {
      if (member.role === 'orchestrator' || member.role === 'worker') return member;
      const role = member.orchestratorMode === true ? 'orchestrator' : roleFromName(member.name);
      return { ...member, role, orchestratorMode: role === 'orchestrator' || undefined };
    }),
  };
}

function normalizeMember(raw: Partial<TeamTemplateMember>): TeamTemplateMember | null {
  if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) return null;
  // The toggle, never the name. Throws on a role that is neither.
  const role = requestedRole(raw) ?? 'worker';
  return {
    name: raw.name.trim(),
    character: raw.character ?? 'robot',
    provider: raw.provider ?? 'claude',
    model: raw.model,
    localModel: raw.localModel,
    permissionMode: raw.permissionMode ?? 'auto',
    effort: raw.effort,
    skills: Array.isArray(raw.skills) ? raw.skills : [],
    savedPrompt: raw.savedPrompt,
    worktreeBranch: raw.worktreeBranch?.trim() || undefined,
    role,
    orchestratorMode: role === 'orchestrator' || undefined,
  };
}

export function registerTeamTemplateHandlers(): void {
  ipcMain.handle('teamTemplate:list', async () => {
    try {
      const store = loadStore();
      return { teams: [...BUILTIN_TEAM_TEMPLATES, ...store.user] };
    } catch (err) {
      console.error('teamTemplate:list error:', err);
      return {
        teams: BUILTIN_TEAM_TEMPLATES,
        error: err instanceof Error ? err.message : 'Failed to list team templates',
      };
    }
  });

  ipcMain.handle('teamTemplate:create', async (_event, input: TeamTemplateInput) => {
    try {
      if (!input?.name?.trim()) {
        return { success: false, error: 'name is required' };
      }
      const members = (Array.isArray(input.members) ? input.members : [])
        .map(normalizeMember)
        .filter((m): m is TeamTemplateMember => m !== null);
      if (members.length === 0) {
        return { success: false, error: 'A team needs at least one member' };
      }
      const now = new Date().toISOString();
      const team: TeamTemplate = {
        id: uuidv4(),
        builtin: false,
        name: input.name.trim(),
        description: input.description ?? '',
        icon: input.icon ?? '👥',
        members,
        createdAt: now,
        updatedAt: now,
      };
      const store = loadStore();
      store.user.push(team);
      saveStore(store);
      return { success: true, team };
    } catch (err) {
      console.error('teamTemplate:create error:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to create team template' };
    }
  });

  ipcMain.handle('teamTemplate:delete', async (_event, id: string) => {
    try {
      if (BUILTIN_TEAM_TEMPLATES.some(t => t.id === id)) {
        return { success: false, error: 'Built-in teams cannot be deleted.' };
      }
      const store = loadStore();
      const next = store.user.filter(t => t.id !== id);
      if (next.length === store.user.length) {
        return { success: false, error: 'Team template not found' };
      }
      store.user = next;
      saveStore(store);
      return { success: true };
    } catch (err) {
      console.error('teamTemplate:delete error:', err);
      return { success: false, error: err instanceof Error ? err.message : 'Failed to delete team template' };
    }
  });
}
