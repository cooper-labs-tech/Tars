import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The Review page and the project rule (window-file-access.ts projectRefusal), 2.0.7.
 *
 * Review's projects are the projects' list and the agents' folders, both of which agents write
 * (~/.tars/projects.json, agents.json). The rest of the window judges a project at each use;
 * Review took them as listed.
 *
 * How it can fail, written before the code (the Audit's M2 on #648, 2026-11-26):
 * R1. review:repositories scans a project Tars holds under a folder the rule refuses (a dot folder
 *     of the home, a folder of credentials, an application folder), or refuses it with no word of
 *     why: it answers the rule's reason, under its own code.
 * R2. review:search scans and searches such a project.
 * R3. review:diff, review:repo and review:file take a repository in such a folder: an agent's
 *     folder there, a repository a scan found there.
 * R4. Over-correction: a project the rule allows is no longer scanned and searched, or an agent's
 *     folder it allows no longer reviewed.
 * Added before its code, after review-every-repository.spec turned red on b05149c51 (2026-11-26):
 * R5. Over-correction: a project gone from the disk is refused as one that cannot be followed,
 *     instead of scanned and said `gone`, as the rule judges a missing folder by the folder it
 *     would be in.
 *
 * Real git, real folders in the suite's throwaway home, the real handlers.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => os.homedir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.7', getName: () => 'Tars', on: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
}));
vi.mock('../../../electron/utils/broadcast', () => ({
  broadcastToAllWindows: (channel: string, event: Record<string, unknown>) => { events.push({ channel, ...event }); },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const events: Array<Record<string, unknown>> = [];

import { registerReviewHandlers, refuseUnknownRepository } from '../../../electron/handlers/review-handlers';
import { agents } from '../../../electron/core/agent-manager';
import { DATA_DIR } from '../../../electron/constants';
import type { AgentStatus } from '../../../electron/types';

const home = os.homedir();
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const repoAt = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  execFileSync('git', ['commit', '-qm', 'a'], { cwd: dir, env });
  return dir;
};

const held = path.join(home, '.cargo', 'held');
const heldRepo = path.join(held, 'heldrepo');
const allowed = path.join(home, 'work', 'allowed');
const allowedRepo = path.join(allowed, 'allowedrepo');
const heldAgent = path.join(home, '.azure', 'agentrepo');

const until = async (done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
};

beforeEach(() => {
  handlers.clear();
  events.length = 0;
  agents.clear();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), JSON.stringify([held, allowed]));
  for (const r of [heldRepo, allowedRepo, heldAgent]) if (!fs.existsSync(path.join(r, '.git'))) repoAt(r);
  agents.set('a1', { id: 'a1', name: 'a1', projectPath: heldAgent } as AgentStatus);
  agents.set('a2', { id: 'a2', name: 'a2', projectPath: allowedRepo } as AgentStatus);
  registerReviewHandlers();
});

afterAll(() => {
  agents.clear();
  for (const d of [path.join(home, '.cargo'), path.join(home, 'work'), path.join(home, '.azure')]) fs.rmSync(d, { recursive: true, force: true });
});

describe('Review and the project rule', () => {
  it('R1. review:repositories scans no refused project, and says why', async () => {
    const answer = await handlers.get('review:repositories')!({}, { projectPath: held, refresh: true }) as { error?: string; code?: string; scanId?: string };
    expect(answer.scanId).toBeUndefined();
    expect(answer.code).toBe('refused_project');
    expect(answer.error).toMatch(/dot/i);
  });

  it('R2. review:search searches no refused project', async () => {
    const answer = await handlers.get('review:search')!({}, { query: 'repo' }) as { searchId?: string };
    await until(() => events.some((e) => e.searchId === answer.searchId && e.kind === 'done' && e.channel === 'review:search:event'));
    const found = JSON.stringify(events.filter((e) => e.channel === 'review:search:event'));
    expect(found).not.toContain('heldrepo');
    expect(found).toContain('allowedrepo');
  });

  it('R3. no repository in a refused folder is reviewed, an agent\'s or one under a refused project', () => {
    // An agent's folder there is known, and refused with the rule's reason; a repository under a refused project is
    // refused too, whether a scan found it before or, as now, no scan of that project runs.
    expect(refuseUnknownRepository(heldAgent)).toMatchObject({ success: false });
    expect(refuseUnknownRepository(heldAgent)?.error).toMatch(/dot/i);
    expect(refuseUnknownRepository(heldRepo)).toMatchObject({ success: false });
  });

  it('R4. a project the rule allows is scanned, and an agent\'s folder it allows reviewed', async () => {
    const answer = await handlers.get('review:repositories')!({}, { projectPath: allowed, refresh: true }) as { scanId?: string };
    expect(answer.scanId).toBeDefined();
    await until(() => events.some((e) => e.scanId === answer.scanId && e.kind === 'done'));
    expect(events.some((e) => e.scanId === answer.scanId && e.kind === 'found' && e.repo === allowedRepo)).toBe(true);
    expect(refuseUnknownRepository(allowedRepo)).toBeNull();
  });

  it('R5. a project gone from the disk is still scanned, and said gone', async () => {
    const gone = path.join(home, 'work', 'old-shop');
    fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), JSON.stringify([held, allowed, gone]));
    const answer = await handlers.get('review:repositories')!({}, { projectPath: gone, refresh: true }) as { scanId?: string; code?: string };
    expect(answer.code).toBeUndefined();
    expect(answer.scanId).toBeDefined();
    await until(() => events.some((e) => e.scanId === answer.scanId && e.kind === 'done'));
    expect(events.find((e) => e.scanId === answer.scanId && e.kind === 'done')).toMatchObject({ state: 'gone' });
  });
});
