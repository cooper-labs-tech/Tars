import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The window's project rule (utils/window-file-access.ts projectRefusal) on every path that sets an agent's folder
 * (2.0.7, the owner's decision of 2026-11-26: the same rule through the API). The window's New agent lists a folder the
 * rule refuses but lets nobody choose it; the local API took one.
 *
 * How it can fail, written before the code (2026-11-26):
 * F1. POST /api/agents (create_agent) creates an agent whose project the rule refuses: a folder of the home whose name
 *     starts with a dot (~/.dotfiles), a link into one, a link into ~/Library, a folder of credentials (~/.aws), Tars's
 *     private folder, or one of these by a second spelling of the home (macOS's Data volume).
 * F2. The same for the folder it is handed besides its project (secondaryProjectPath), at creation and through
 *     update_agent (POST /api/agents/:id/update).
 * F3. The window's own update path, which update_agent shares (core/agent-update.ts), moves an agent into such a
 *     project.
 * F4. A refusal says nothing of why, or quotes more of a path than the caller gave: it is the sentence the window
 *     shows.
 * F5. Over-correction: a plain folder, a dotfiles repository kept in a cloud drive, or an Obsidian vault in iCloud
 *     Drive is refused.
 * F6. Retroactive: an agent already in such a folder can no longer have its other settings changed, or loses the
 *     folder it is handed. Only a change of folder is judged.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn(() => ({ write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), pid: 1 })) }));
let nextId = 0;
vi.mock('uuid', () => ({ v4: vi.fn(() => `made-${++nextId}`) }));
vi.mock('electron', () => ({
  app: { getPath: () => os.homedir() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));
vi.mock('../../../../electron/core/agent-manager', () => ({
  agents: new Map(),
  saveAgents: vi.fn(),
  initAgentPty: vi.fn(),
  killStalePty: vi.fn(),
  ensureProjectTrusted: vi.fn(),
  appendAgentOutput: vi.fn(),
  armTaskStartWatch: vi.fn(),
}));
vi.mock('../../../../electron/core/pty-manager', () => ({
  launchPrompt: (_sender: unknown, data: string) => data,
  ptyProcesses: new Map(),
  writeProgrammaticInput: vi.fn(),
  rememberTerminalOwner: vi.fn(),
  endTerminalTree: vi.fn(async () => {}),
  // What an update tells the terminal's owner of (core/agent-update.ts): nothing listens here.
  onFieldChange: vi.fn(),
}));
vi.mock('../../../../electron/utils/path-builder', () => ({ buildFullPath: vi.fn(() => '/usr/bin') }));

import { registerAgentRoutes } from '../../../../electron/services/api-routes/agent-routes';
import { agents } from '../../../../electron/core/agent-manager';
import { updateAgent } from '../../../../electron/core/agent-update';
import { PRIVATE_DIR } from '../../../../electron/constants';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

// The suite's throwaway home (__tests__/setup/home-isolation.ts).
const home = os.homedir();
const at = (...p: string[]) => path.join(home, ...p);
const made = (dir: string) => { fs.mkdirSync(dir, { recursive: true }); return dir; };
const linked = (link: string, to: string) => {
  made(to);
  made(path.dirname(link));
  // A junction where the type is read (Windows), a link elsewhere.
  if (!fs.existsSync(link)) fs.symlinkSync(to, link, 'junction');
  return link;
};
const dataVolume = '/System/Volumes/Data';
const hasSecondSpelling = process.platform === 'darwin' && fs.existsSync(dataVolume);

/** The folders the rule refuses, by what they are. */
function refused(): Array<[string, string]> {
  const list: Array<[string, string]> = [
    ['a dot folder of the home', made(at('.dotfiles', 'proj'))],
    ['a link into a dot folder', linked(at('work', 'to-local'), at('.local', 'share', 'app'))],
    ['a link into ~/Library', linked(at('work', 'to-lib'), at('Library', 'Application Support', 'App'))],
    ['a folder of credentials', made(at('.aws', 'proj'))],
    ["Tars's private folder", made(PRIVATE_DIR)],
  ];
  if (hasSecondSpelling) list.push(['a dot folder by a second spelling of the home', path.join(dataVolume, fs.realpathSync(made(at('.dotfiles', 'proj'))))]);
  return list;
}
/** The folders it allows that look close to refused ones. */
function allowed(): Array<[string, string]> {
  return [
    ['a plain folder', made(at('work', 'plain'))],
    ['a dotfiles repository in a cloud drive', made(at('Library', 'CloudStorage', 'Dropbox', 'dotfiles'))],
    ['an Obsidian vault in iCloud Drive', made(at('Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents', 'Vault'))],
  ];
}

const routes: RouteApp['routes'] = [];
const app: RouteApp = {
  routes,
  add(method, pattern, handler) { routes.push({ method, pattern, handler }); },
  get(pattern, handler) { this.add('GET', pattern, handler); },
  post(pattern, handler) { this.add('POST', pattern, handler); },
  put(pattern, handler) { this.add('PUT', pattern, handler); },
  delete(pattern, handler) { this.add('DELETE', pattern, handler); },
};
const ctx = {
  mainWindow: null,
  appSettings: {} as AppSettings,
  getAppSettings: () => ({} as AppSettings),
  getTelegramBot: () => null,
  getSlackApp: () => null,
  slackResponseChannel: null,
  slackResponseThreadTs: null,
  handleStatusChangeNotificationCallback: vi.fn(),
  sendNotificationCallback: vi.fn(),
  initAgentPtyCallback: vi.fn(async () => 'pty'),
  agentStatusEmitter: new EventEmitter(),
} as unknown as RouteContext;
registerAgentRoutes(app, ctx);

const request = (pathname: string, body: unknown, callerAgentId: string, params: Record<string, string> = {}): RouteRequest => ({
  method: 'POST', pathname, url: new URL(`http://localhost${pathname}`), body, raw: {} as never, res: {} as never, params, callerAgentId,
} as RouteRequest);

async function call(pattern: string | RegExp, pathname: string, body: unknown, caller: string, params: Record<string, string> = {}) {
  const route = routes.find((r) => r.method === 'POST' && String(r.pattern) === String(pattern))!;
  let answer: { body: Record<string, unknown>; status: number } = { body: {}, status: 0 };
  await route.handler(request(pathname, body, caller, params), (b: unknown, status = 200) => { answer = { body: b as Record<string, unknown>, status }; }, ctx);
  return answer;
}
const create = (body: Record<string, unknown>) => call('/api/agents', '/api/agents', { allowCrossProject: true, ...body }, 'lead');
const updateOver = (id: string, body: Record<string, unknown>, caller = 'lead') => call(/^\/api\/agents\/([^/]+)\/update$/, `/api/agents/${id}/update`, body, caller, { id });

const plainProject = () => made(at('work', 'lead'));
const agent = (id: string, more: Partial<AgentStatus>): AgentStatus => ({
  id, name: id, status: 'idle', projectPath: plainProject(), skills: [], output: [], lastActivity: new Date().toISOString(),
  provider: 'claude', permissionMode: 'auto', ...more,
});

/** The sentence the window shows, and no more of a path than the caller gave: none at all. */
function expectTheRule(error: unknown, folder: string) {
  expect(String(error), folder).toMatch(/cannot be a project/);
  expect(String(error), folder).not.toContain(home);
  expect(String(error), folder).not.toContain(fs.realpathSync(home));
}

beforeEach(() => {
  agents.clear();
  agents.set('lead', agent('lead', { role: 'orchestrator' }));
});

describe('creating an agent through the API (create_agent)', () => {
  it('F1, F4. refuses a project the rule refuses, with its sentence, and makes nothing', async () => {
    for (const [what, folder] of refused()) {
      const answer = await create({ projectPath: folder, name: 'x' });
      expect(answer.status, what).toBe(400);
      expectTheRule(answer.body.error, what);
      expect([...agents.values()].some((a) => a.projectPath === folder), what).toBe(false);
    }
  });

  it('F2. refuses a secondary folder the rule refuses', async () => {
    for (const [what, folder] of refused().filter(([, f]) => f !== PRIVATE_DIR)) {
      const answer = await create({ projectPath: plainProject(), secondaryProjectPath: folder, name: 'x' });
      expect(answer.status, what).toBe(400);
      expectTheRule(answer.body.error, what);
    }
  });

  it('F5. creates one in a plain folder, a dotfiles repository in a cloud drive, an Obsidian vault in iCloud Drive', async () => {
    for (const [what, folder] of allowed()) {
      const answer = await create({ projectPath: folder, name: what, secondaryProjectPath: folder });
      expect(answer.status, what).toBe(200);
      expect((answer.body.agent as AgentStatus | undefined)?.projectPath, what).toBe(folder);
    }
  });
});

describe('changing an agent\'s folders (update_agent, and the window\'s path it shares)', () => {
  it('F2. update_agent refuses a secondary folder the rule refuses, and changes nothing', async () => {
    agents.set('w1', agent('w1', {}));
    for (const [what, folder] of refused().filter(([, f]) => f !== PRIVATE_DIR)) {
      const answer = await updateOver('w1', { secondaryProjectPath: folder });
      expect(answer.status, what).toBeGreaterThanOrEqual(400);
      expectTheRule(answer.body.error, what);
      expect(agents.get('w1')!.secondaryProjectPath, what).toBeUndefined();
    }
  });

  it('F3. the shared update path moves no agent into a project the rule refuses', async () => {
    agents.set('w2', agent('w2', {}));
    for (const [what, folder] of refused()) {
      const result = await updateAgent({ id: 'w2', projectPath: folder });
      expect(result.success, what).toBe(false);
      expectTheRule((result as { error?: string }).error, what);
      expect(agents.get('w2')!.projectPath, what).toBe(plainProject());
    }
    const [, plain] = allowed()[0];
    expect(await updateAgent({ id: 'w2', projectPath: plain })).toMatchObject({ success: true });
  });

  it('F6. an agent already in such a folder keeps working: its other settings change, its folders stay', async () => {
    const [, dot] = refused()[0];
    const [, lib] = refused()[2];
    // Its project's orchestrator, there too: who may change it is not this rule's question.
    agents.set('old-lead', agent('old-lead', { role: 'orchestrator', projectPath: dot }));
    agents.set('old', agent('old', { projectPath: dot, secondaryProjectPath: lib }));
    expect(await updateOver('old', { name: 'renamed', secondaryProjectPath: lib }, 'old-lead')).toMatchObject({ status: 200 });
    expect(await updateAgent({ id: 'old', model: 'opus', projectPath: dot, secondaryProjectPath: lib })).toMatchObject({ success: true });
    expect(agents.get('old')).toMatchObject({ name: 'renamed', model: 'opus', projectPath: dot, secondaryProjectPath: lib });
  });
});
