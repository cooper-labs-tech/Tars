import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * The allowlist across projects (2.0.7, the owner's word of 19/11 through Tars-Orchestrator, t-e04cb794 and
 * t-b9a332b3): an entry "caller project -> target project", granted by the owner in the window, gives the caller
 * project's orchestrator, and the workers the entry names, the target project's orchestrator's powers over its agents
 * (list them, delegate to them, start, stop and message them, read their answers).
 *
 * How it fails, written before the code (2026-11-19):
 *
 * Where it lives
 * 1. It is kept where agents write: ~/.tars (app-settings.json is in every agent's --add-dir), so a bypass agent grants
 *    itself another project. It must live in ~/.tars-private, whose file is 0600.
 * 2. A file written while Tars runs, by anything but the window's channel (an agent's Bash), is taken at once. It must
 *    wait for Tars's next start, as the owner's Chrome switch does (the Audit's M1 and L3 on #582).
 * 3. A grant set from the window waits for a restart: it must hold at once, and be on disk for the next start.
 * 4. A missing, unreadable or malformed file, or one holding anything else, opens something: it must grant nothing.
 *
 * What it grants
 * 5. A grant from A to B opens A to B's agents as well: a grant is one way.
 * 6. A grant opens B to every agent of A: only A's orchestrator, A's chats' runners (the orchestrator's powers), and
 *    the workers it names, by id.
 * 7. A worker named by its name is let in: names change and two agents may share one; a name grants nothing.
 * 8. A worker named in a grant from A keeps it after moving to project C: the caller's project now is what counts.
 * 9. Paths are compared as prefixes, or with their trailing slash: /p/proj grants /p/project-b. They must be equal
 *    once resolved.
 * 10. A caller that is no agent of the fleet (Tars's own pass, a removed agent) is answered with a grant.
 *
 * What the window sets
 * 11. A grant from a project to itself, a relative path, a path that is no string, or a worker id that is no string
 *     is kept: refused, nothing written.
 * 12. Setting one pair drops the others, or a second set of the same pair adds a duplicate: one entry per pair,
 *     a new set replaces its workers, and removing a pair removes that pair only.
 */

import { privatePath } from '../../../electron/constants';
import {
  GRANTS_FILE, loadGrants, listGrants, setGrant, removeGrant, grantFor, resetGrants,
} from '../../../electron/services/cross-project-grants';
import type { AgentStatus } from '../../../electron/types';

const A = '/work/project-a';
const B = '/work/project-b';
const C = '/work/third';

const agent = (id: string, projectPath: string, more: Partial<AgentStatus> = {}) =>
  ({ id, projectPath, role: 'worker', ...more }) as Pick<AgentStatus, 'id' | 'projectPath' | 'role' | 'kind'>;

beforeEach(() => {
  resetGrants();
  fs.rmSync(GRANTS_FILE, { force: true });
});

describe('where it lives', () => {
  it('1. in ~/.tars-private, 0600, and nowhere under ~/.tars', () => {
    expect(GRANTS_FILE).toBe(privatePath('cross-project-grants.json'));
    expect(GRANTS_FILE.startsWith(path.join(os.homedir(), '.tars') + path.sep)).toBe(false);
    expect(setGrant({ from: A, to: B, workers: [] })).toMatchObject({ ok: true });
    if (process.platform !== 'win32') expect(fs.statSync(GRANTS_FILE).mode & 0o777).toBe(0o600);
  });

  it('2. a file written while Tars runs is taken at its next start only', () => {
    loadGrants();
    fs.mkdirSync(path.dirname(GRANTS_FILE), { recursive: true });
    fs.writeFileSync(GRANTS_FILE, JSON.stringify({ grants: [{ from: A, to: B, workers: [], grantedAt: '2026-11-19T00:00:00.000Z' }] }));
    expect(grantFor(agent('lead', A, { role: 'orchestrator' }), B)).toBeUndefined();
    loadGrants();
    expect(grantFor(agent('lead', A, { role: 'orchestrator' }), B)).toMatchObject({ from: A, to: B });
  });

  it('3. a grant set from the window holds at once, and at the next start', () => {
    loadGrants();
    expect(setGrant({ from: A, to: B, workers: ['w1'] })).toMatchObject({ ok: true });
    expect(grantFor(agent('w1', A), B)).toBeDefined();
    resetGrants();
    loadGrants();
    expect(grantFor(agent('w1', A), B)).toBeDefined();
  });

  it.each([
    ['missing', null],
    ['not JSON', '{grants: ['],
    ['an array', '[]'],
    ['grants not an array', '{"grants": {"from": "/work/project-a"}}'],
    ['an entry with no target', '{"grants": [{"from": "/work/project-a", "workers": []}]}'],
  ])('4. a file %s grants nothing', (_what, text) => {
    if (text !== null) {
      fs.mkdirSync(path.dirname(GRANTS_FILE), { recursive: true });
      fs.writeFileSync(GRANTS_FILE, text);
    }
    loadGrants();
    expect(listGrants()).toEqual([]);
    expect(grantFor(agent('lead', A, { role: 'orchestrator' }), B)).toBeUndefined();
  });
});

describe('what it grants', () => {
  beforeEach(() => {
    loadGrants();
    setGrant({ from: A, to: B, workers: ['named'] });
  });

  it('5. one way: A reaches B, B does not reach A', () => {
    expect(grantFor(agent('lead', A, { role: 'orchestrator' }), B)).toBeDefined();
    expect(grantFor(agent('lead-b', B, { role: 'orchestrator' }), A)).toBeUndefined();
  });

  it("6. A's orchestrator, A's chats' runners and the named workers; no other worker of A", () => {
    expect(grantFor(agent('lead', A, { role: 'orchestrator' }), B)).toBeDefined();
    expect(grantFor(agent('runner', A, { kind: 'chat' }), B)).toBeDefined();
    expect(grantFor(agent('named', A), B)).toBeDefined();
    expect(grantFor(agent('other', A), B)).toBeUndefined();
  });

  it('7. a worker named by its name is not let in', () => {
    setGrant({ from: A, to: B, workers: ['A-Worker'] });
    expect(grantFor({ ...agent('w-id', A), name: 'A-Worker' } as never, B)).toBeUndefined();
  });

  it('8. a named worker that moved to another project has nothing', () => {
    expect(grantFor(agent('named', C), B)).toBeUndefined();
  });

  it('9. paths are equal once resolved, never a prefix', () => {
    expect(grantFor(agent('lead', `${A}/`, { role: 'orchestrator' }), `${B}/`)).toBeDefined();
    expect(grantFor(agent('lead', A, { role: 'orchestrator' }), '/work/project')).toBeUndefined();
    expect(grantFor(agent('lead', A, { role: 'orchestrator' }), `${B}-copy`)).toBeUndefined();
    expect(grantFor(agent('lead', '/work/project', { role: 'orchestrator' }), B)).toBeUndefined();
  });

  it('10. no caller, no grant', () => {
    expect(grantFor(undefined, B)).toBeUndefined();
  });
});

describe('what the window sets', () => {
  beforeEach(() => loadGrants());

  it.each([
    ['a project to itself', { from: A, to: A, workers: [] }],
    ['a relative caller', { from: 'project-a', to: B, workers: [] }],
    ['a relative target', { from: A, to: './project-b', workers: [] }],
    ['a target that is no string', { from: A, to: 42, workers: [] }],
    ['workers that are no list', { from: A, to: B, workers: 'w1' }],
    ['a worker id that is no string', { from: A, to: B, workers: [7] }],
  ])('11. refuses %s, and writes nothing', (_what, input) => {
    const answer = setGrant(input as never);
    expect(answer.ok).toBe(false);
    expect(fs.existsSync(GRANTS_FILE)).toBe(false);
    expect(listGrants()).toEqual([]);
  });

  it('12. one entry per pair: a new set replaces its workers, a removal takes that pair only', () => {
    setGrant({ from: A, to: B, workers: ['w1'] });
    setGrant({ from: A, to: C, workers: [] });
    setGrant({ from: A, to: B, workers: ['w2'] });
    expect(listGrants().map((g) => [g.from, g.to, g.workers])).toEqual([[A, B, ['w2']], [A, C, []]]);
    expect(removeGrant({ from: A, to: B })).toMatchObject({ ok: true, removed: true });
    expect(listGrants().map((g) => [g.from, g.to])).toEqual([[A, C]]);
    const onDisk = JSON.parse(fs.readFileSync(GRANTS_FILE, 'utf8'));
    expect(onDisk.grants.map((g: { to: string }) => g.to)).toEqual([C]);
  });
});
