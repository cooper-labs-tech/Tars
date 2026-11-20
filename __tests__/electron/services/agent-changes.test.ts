import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The change log of agents' settings (2.0.7, the owner's word of 19/11 through Tars-Orchestrator, t-e04cb794 item 4):
 * every change (who, which agent, before and after, when, applied or queued) logged, readable through an
 * authenticated route and an MCP tool, and what a revert reads.
 *
 * How it fails, written before the code (2026-11-19):
 * 1. It is kept where agents write (~/.tars, in every agent's --add-dir): a prompt-injected agent rewrites the
 *    history of what it did. It must live in ~/.tars-private, 0600.
 * 2. It grows without bound, or rewrites the whole log at every change (a batch of a hundred agents writing it a
 *    hundred times). It keeps the last CHANGES_KEPT entries, the oldest dropped first, one line appended per change
 *    and per update, the file rewritten only once it holds twice as many lines as entries.
 * 3. A missing or malformed file at Tars's start throws, or the next write keeps the garbage: it starts empty and
 *    writes a sound file.
 * 4. Two changes asked in the same millisecond share an id: each has its own, chg- and 8 hex.
 * 5. A listing filtered by agent, project or batch returns another's entries, or in no useful order, or ignores its
 *    limit: newest first, filtered, at most `limit` (1 to 500, 100 when not given).
 * 6. A value that is no setting reaches the log (an object carrying anything, a long string): `before` and `after`
 *    keep strings up to 300 characters, numbers, booleans and null, a list of such strings (the skills), and a
 *    worktree as its path and branch; anything else is refused at the record, never written.
 * 7. A change queued when Tars quits is lost: queued entries are read back at the start, still queued, for Tars to
 *    apply.
 * 8. An entry updated (applied, cancelled, failed) is read back as a new entry, or not at all: the same entry
 *    changes, after a restart too.
 */

import { privatePath } from '../../../electron/constants';
import {
  CHANGES_FILE, keepAtMost, loadChanges, recordChange, updateChange, listChanges, changeById, queuedChanges, resetChanges,
  type AgentChange,
} from '../../../electron/services/agent-changes';

const by = { kind: 'agent' as const, id: 'a-x', name: 'A-Other', projectPath: '/work/project-a' };
const base = (more: Partial<AgentChange> = {}): Omit<AgentChange, 'id'> => ({
  agentId: 'b-c', agentName: 'B-Claude', projectPath: '/work/project-b', by,
  fields: ['model'], before: { model: 'sonnet' }, after: { model: 'opus' },
  askedAt: new Date().toISOString(), state: 'applied', ...more,
});

beforeEach(() => {
  resetChanges();
  fs.rmSync(CHANGES_FILE, { force: true });
  loadChanges();
});

describe('agent-changes', () => {
  it('1. lives in ~/.tars-private, 0600', () => {
    expect(CHANGES_FILE).toBe(privatePath('agent-changes.jsonl'));
    expect(CHANGES_FILE.startsWith(path.join(os.homedir(), '.tars') + path.sep)).toBe(false);
    recordChange(base());
    if (process.platform !== 'win32') expect(fs.statSync(CHANGES_FILE).mode & 0o777).toBe(0o600);
  });

  it('2. keeps the last CHANGES_KEPT entries, dropping the oldest', () => {
    const CHANGES_KEPT = 20;
    keepAtMost(CHANGES_KEPT);
    const total = CHANGES_KEPT * 2 + 3;
    for (let i = 0; i < total; i += 1) recordChange(base({ after: { model: `m${i}` } }));
    // Rewritten once past twice as many lines as entries: never more lines than that.
    const onDisk = fs.readFileSync(CHANGES_FILE, 'utf8').trim().split('\n');
    expect(onDisk.length).toBeLessThanOrEqual(CHANGES_KEPT * 2);
    resetChanges();
    keepAtMost(CHANGES_KEPT);
    loadChanges();
    const all = listChanges({ limit: 500 });
    expect(all).toHaveLength(CHANGES_KEPT);
    expect(all[0].after).toEqual({ model: `m${total - 1}` });
    expect(listChanges({ limit: 500 }).some((c) => (c.after as { model: string }).model === `m${total - CHANGES_KEPT - 1}`)).toBe(false);
  });

  it.each([['missing', null], ['malformed', '{changes: ['], ['an array', '[]'], ['lines of no change', '{"changes": 3}\n[1]\n{"update": {"id": "chg-00000000"}}']])('3. a file %s starts empty, and the next write reads back', (_what, text) => {
    resetChanges();
    if (text !== null) {
      fs.mkdirSync(path.dirname(CHANGES_FILE), { recursive: true });
      fs.writeFileSync(CHANGES_FILE, text);
    }
    expect(() => loadChanges()).not.toThrow();
    expect(listChanges({})).toEqual([]);
    recordChange(base());
    resetChanges();
    loadChanges();
    expect(listChanges({})).toHaveLength(1);
  });

  it('4. every change has an id of its own', () => {
    const ids = Array.from({ length: 50 }, () => recordChange(base()).id);
    expect(new Set(ids).size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^chg-[0-9a-f]{8}$/);
  });

  it('5. filters by agent, project and batch, newest first, within the limit', () => {
    const a = recordChange(base({ agentId: 'b-a', batchId: 'b-1' }));
    const b = recordChange(base({ agentId: 'b-b', batchId: 'b-1' }));
    const c = recordChange(base({ agentId: 'b-a', projectPath: '/work/other' }));
    expect(listChanges({ agentId: 'b-a' }).map((x) => x.id)).toEqual([c.id, a.id]);
    expect(listChanges({ projectPath: '/work/project-b' }).map((x) => x.id)).toEqual([b.id, a.id]);
    expect(listChanges({ batchId: 'b-1' }).map((x) => x.id)).toEqual([b.id, a.id]);
    expect(listChanges({ limit: 1 }).map((x) => x.id)).toEqual([c.id]);
    expect(listChanges({ limit: 0 })).toHaveLength(1);
    expect(listChanges({ limit: 10_000 })).toHaveLength(3);
  });

  it.each([
    ['an object', { model: { anything: 'else' } }],
    ['a long string', { model: 'x'.repeat(301) }],
    ['a function', { model: (() => 1) as unknown as string }],
    ['a list holding an object', { skills: [{ name: 'x' }] }],
  ])('6. refuses %s as a value, and writes nothing', (_what, after) => {
    expect(() => recordChange(base({ after: after as Record<string, unknown> }))).toThrow();
    expect(fs.existsSync(CHANGES_FILE)).toBe(false);
  });

  it('6. keeps a worktree as its path and branch', () => {
    const c = recordChange(base({ fields: ['worktree'], before: { worktree: null }, after: { worktree: { worktreePath: '/w/.worktrees/x', branchName: 'x' } } }));
    expect(changeById(c.id)?.after).toEqual({ worktree: { worktreePath: '/w/.worktrees/x', branchName: 'x' } });
  });

  it('7. a queued change is read back at the start, still queued', () => {
    const q = recordChange(base({ state: 'queued', waitingFor: 'turn' }));
    recordChange(base());
    resetChanges();
    loadChanges();
    expect(queuedChanges().map((c) => c.id)).toEqual([q.id]);
  });

  it('8. an update changes the same entry, on disk too', () => {
    const q = recordChange(base({ state: 'queued' }));
    const at = new Date().toISOString();
    updateChange(q.id, { state: 'applied', effectiveAt: at, waitingFor: undefined });
    expect(listChanges({})).toHaveLength(1);
    expect(changeById(q.id)).toMatchObject({ state: 'applied', effectiveAt: at });
    resetChanges();
    loadChanges();
    const back = listChanges({});
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ id: q.id, state: 'applied', effectiveAt: at });
    expect(back[0]).not.toHaveProperty('waitingFor');
  });
});
