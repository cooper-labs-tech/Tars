import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ── Mocks ────────────────────────────────────────────────────────────────────

let handlers: Map<string, (...args: unknown[]) => Promise<unknown>>;

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    }),
  },
}));

let uuidCounter = 0;
vi.mock('uuid', () => ({
  v4: vi.fn(() => `team-uuid-${++uuidCounter}`),
}));

// The handler module resolves DATA_DIR at import time, so the mocked path
// must be a stable constant (vi.hoisted runs before the static imports).
const h = vi.hoisted(() => ({
  tmpDir: process.getBuiltinModule('node:path').join(process.getBuiltinModule('node:os').tmpdir(), `dorothy-team-test-${process.pid}`),
}));
vi.mock('../../../electron/constants', () => ({
  DATA_DIR: h.tmpDir,
}));

import { registerTeamTemplateHandlers, BUILTIN_TEAM_TEMPLATES } from '../../../electron/handlers/team-template-handlers';

const tmpDir = h.tmpDir;

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler for "${channel}"`);
  return fn({}, ...args);
}

beforeEach(() => {
  handlers = new Map();
  uuidCounter = 0;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  registerTeamTemplateHandlers();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('team-template-handlers', () => {
  describe('builtin team', () => {
    it('ships the Full Project Team with 6 members', () => {
      const team = BUILTIN_TEAM_TEMPLATES[0];
      expect(team.members).toHaveLength(6);
      expect(team.members.map(m => m.name)).toEqual([
        'Orchestrator', 'Frontend Engineer', 'Backend Engineer', 'QA Engineer', 'Audit Engineer', 'Database Engineer',
      ]);
      // Only the orchestrator has the role, and the toggle's old field equal to
      // it for the renderer that deploys from it. No member has a branch of its
      // own any more (2.0.7, W2): each piece of work gets its worktree from
      // worktree_new, so the team deploys on any folder and no long-lived
      // branch drifts from the default one.
      expect(team.members[0].role).toBe('orchestrator');
      expect(team.members[0].orchestratorMode).toBe(true);
      for (const member of team.members) expect(member.worktreeBranch, member.name).toBeUndefined();
      for (const member of team.members.slice(1)) {
        expect(member.role ?? 'worker').toBe('worker');
        expect(member.orchestratorMode).toBeUndefined();
      }
    });

    /**
     * W2 of the fresh-install report, written before the briefs (2026-11-10). How the team fails the gate loop:
     * T1. a developer is not told its area and to stay in it, to deliver a pull request, and never to merge;
     * T2. QA is not told it is the gate: run the checks, a verdict first (MERGE or FIX FIRST) in the reports folder,
     *     never overwriting an earlier one, defects reported and never patched;
     * T3. the Audit is not told it is read-only, with file:line findings ranked by severity and a verdict first;
     * T4. the orchestrator is not on the strongest model and effort, as the owner runs it.
     */
    it('T1-T4. tells each member its part in the gate loop', () => {
      const [lead, ...members] = BUILTIN_TEAM_TEMPLATES[0].members;
      const brief = (name: string) => members.find(m => m.name === name)!.savedPrompt ?? '';
      for (const name of ['Frontend Engineer', 'Backend Engineer', 'Database Engineer']) {
        for (const word of ['You own', 'never outside', 'pull request', 'never merge', 'worktree_new']) expect(brief(name), `${name}: ${word}`).toContain(word);
      }
      for (const word of ['gate', 'MERGE or FIX FIRST', 'reports/', 'never overwrite', 'never patch']) expect(brief('QA Engineer'), word).toContain(word);
      for (const word of ['read-only', 'file:line', 'severity', 'verdict first', 'reports/']) expect(brief('Audit Engineer'), word).toContain(word);
      expect(lead).toMatchObject({ model: 'opus', effort: 'max' });
      for (const word of ['gate loop', 'never merge', 'QA', 'Audit']) expect(lead.savedPrompt ?? '', word).toContain(word);
    });

    it('teamTemplate:list returns builtin first, empty user list', async () => {
      const result = await invoke('teamTemplate:list') as { teams: Array<{ id: string; builtin: boolean }> };
      expect(result.teams).toHaveLength(1);
      expect(result.teams[0].builtin).toBe(true);
    });
  });

  describe('teamTemplate:create', () => {
    it('creates a team, normalizes members, persists to disk', async () => {
      const result = await invoke('teamTemplate:create', {
        name: '  My Team  ',
        members: [
          { name: 'Dev', worktreeBranch: ' feat/x ' },
          { name: '   ' },            // dropped: blank name
          null,                        // dropped: not an object
          { name: 'Reviewer', provider: 'codex', permissionMode: 'normal', skills: ['review'] },
        ],
      }) as { success: boolean; team: { id: string; name: string; members: Array<Record<string, unknown>> } };

      expect(result.success).toBe(true);
      expect(result.team.name).toBe('My Team');
      expect(result.team.members).toHaveLength(2);
      expect(result.team.members[0]).toMatchObject({
        name: 'Dev', character: 'robot', provider: 'claude', permissionMode: 'auto', worktreeBranch: 'feat/x',
      });
      expect(result.team.members[1]).toMatchObject({ name: 'Reviewer', provider: 'codex', permissionMode: 'normal' });

      const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'team-templates.json'), 'utf-8'));
      expect(onDisk.user).toHaveLength(1);

      const list = await invoke('teamTemplate:list') as { teams: unknown[] };
      expect(list.teams).toHaveLength(2); // builtin + user
    });

    it("sets each member's role from the toggle, never from the name", async () => {
      const result = await invoke('teamTemplate:create', {
        name: 'Roles',
        members: [
          { name: 'Lead', role: 'orchestrator' },
          { name: 'Planner', orchestratorMode: true },
          { name: 'Orchestrator docs' },
        ],
      }) as { success: boolean; team: { members: Array<Record<string, unknown>> } };

      expect(result.success).toBe(true);
      expect(result.team.members.map(m => [m.role, m.orchestratorMode])).toEqual([
        ['orchestrator', true],
        ['orchestrator', true],
        ['worker', undefined],
      ]);
    });

    it('refuses a member whose role is neither', async () => {
      expect(await invoke('teamTemplate:create', { name: 'Bad', members: [{ name: 'X', role: 'boss' }] }))
        .toMatchObject({ success: false, error: 'Invalid role: boss' });
    });

    it('rejects a team without a name or without members', async () => {
      expect(await invoke('teamTemplate:create', { name: '', members: [{ name: 'x' }] }))
        .toMatchObject({ success: false });
      expect(await invoke('teamTemplate:create', { name: 'Empty', members: [] }))
        .toMatchObject({ success: false });
      expect(await invoke('teamTemplate:create', { name: 'AllInvalid', members: [{ name: '' }] }))
        .toMatchObject({ success: false });
    });
  });

  describe('teamTemplate:delete', () => {
    it('deletes a user team but never the builtin', async () => {
      const created = await invoke('teamTemplate:create', { name: 'Doomed', members: [{ name: 'x' }] }) as { team: { id: string } };

      expect(await invoke('teamTemplate:delete', created.team.id)).toMatchObject({ success: true });
      const list = await invoke('teamTemplate:list') as { teams: unknown[] };
      expect(list.teams).toHaveLength(1);

      expect(await invoke('teamTemplate:delete', BUILTIN_TEAM_TEMPLATES[0].id))
        .toMatchObject({ success: false });
      expect(await invoke('teamTemplate:delete', 'nonexistent'))
        .toMatchObject({ success: false });
    });
  });

  it('gives the members of a team saved before the toggle was the role the role they deployed with', async () => {
    // Deployed then, "Lead Orchestrator - <project>" was an orchestrator by its
    // name, and the toggle added nothing: the same team deploys the same agents.
    fs.writeFileSync(path.join(tmpDir, 'team-templates.json'), JSON.stringify({ user: [{
      id: 'old', builtin: false, name: 'Old', description: '', icon: '👥', createdAt: '', updatedAt: '',
      members: [
        { name: 'Lead Orchestrator', character: 'wizard', provider: 'claude', permissionMode: 'auto', skills: [] },
        { name: 'Planner', character: 'robot', provider: 'claude', permissionMode: 'auto', skills: [], orchestratorMode: true },
        { name: 'Dev', character: 'robot', provider: 'claude', permissionMode: 'auto', skills: [] },
      ],
    }] }));

    const list = await invoke('teamTemplate:list') as { teams: Array<{ id: string; members: Array<Record<string, unknown>> }> };
    const old = list.teams.find(t => t.id === 'old')!;

    expect(old.members.map(m => [m.name, m.role, m.orchestratorMode])).toEqual([
      ['Lead Orchestrator', 'orchestrator', true],
      ['Planner', 'orchestrator', true],
      ['Dev', 'worker', undefined],
    ]);
  });

  it('survives a corrupt store file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'team-templates.json'), '{not json');
    const result = await invoke('teamTemplate:list') as { teams: unknown[] };
    expect(result.teams).toHaveLength(1); // falls back to builtin only
  });
});
