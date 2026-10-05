import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { startFakeRelay, type FakeRelay } from '../../../fixtures/fake-tars-relay';

/**
 * The orchestrator's send tool with the relay on (trap 2 of DESIGN-RELAIS-HERMES-V2.md, section 9; JeanBrasse's rule of
 * 2026-10-01): one way to write to the user, the orchestrator's, through Hermes, masked. `send_telegram`
 * (mcp-orchestrator) posts to /api/telegram/send.
 *
 * How this can fail, written before the code:
 * 1. With the relay on, a send goes through the Tars bot, or nowhere, where it should go through the relay.
 * 2. A worker, or a caller no token names, writes to the user: only a project's orchestrator does.
 * 3. A secret an orchestrator put in its text goes out in clear.
 * 4. The send goes under another project than its orchestrator's: the user's reply would reach someone else.
 * 5. With the relay on, a photo, a video or a document goes out: the relay carries text only.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.9.2' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';
import type { AgentStatus, AppSettings } from '../../../../electron/types';

let fake: FakeRelay;
let relay: typeof import('../../../../electron/services/hermes-relay');
let agents: Map<string, AgentStatus>;
const TARS = '/Users/someone/projects/tars';
const settings = { hermesRelayEnabled: true } as AppSettings;
let botSends = 0;

function routeApp(): RouteApp {
  return {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
}

function context(): RouteContext {
  return {
    mainWindow: null,
    appSettings: settings,
    getAppSettings: () => settings,
    getTelegramBot: () => ({ sendMessage: async () => { botSends += 1; return { message_id: 1 }; } }) as never,
    getSlackApp: () => null,
    slackResponseChannel: null,
    slackResponseThreadTs: null,
    handleStatusChangeNotificationCallback: vi.fn(),
    sendNotificationCallback: vi.fn(),
    initAgentPtyCallback: vi.fn(async () => 'pty'),
    agentStatusEmitter: new EventEmitter(),
  } as never;
}

async function post(route: string, body: unknown, caller?: string) {
  const app = routeApp();
  const { registerTelegramRoutes } = await import('../../../../electron/services/api-routes/telegram-routes');
  registerTelegramRoutes(app, context());
  const r = app.routes.find((x) => x.method === 'POST' && x.pattern === route)!;
  const answers: Array<{ body: unknown; status?: number }> = [];
  const req = { method: 'POST', pathname: route, url: new URL(`http://x${route}`), body, callerAgentId: caller } as unknown as RouteRequest;
  await r.handler(req, (b: unknown, status?: number) => { answers.push({ body: b, status }); }, context());
  return answers[0];
}

beforeAll(async () => {
  fake = await startFakeRelay();
});

afterAll(async () => {
  relay?.stopHermesRelay();
  await fake.close();
});

beforeEach(async () => {
  relay?.stopHermesRelay();
  vi.resetModules();
  fs.rmSync(path.join(os.homedir(), '.tars-private'), { recursive: true, force: true });
  fake.sends.length = 0;
  botSends = 0;
  ({ agents } = await import('../../../../electron/core/agent-manager') as never);
  agents.clear();
  agents.set('orch', { id: 'orch', name: 'Tars-Orchestrator', role: 'orchestrator', projectPath: TARS, status: 'running', provider: 'claude' } as unknown as AgentStatus);
  agents.set('worker', { id: 'worker', name: 'Tars-Backend', projectPath: TARS, status: 'running', provider: 'claude' } as unknown as AgentStatus);
  const config = await import('../../../../electron/services/hermes-config');
  config.writeHermesConnection({ mode: 'local', localPort: fake.port, authMode: 'token', token: fake.token });
  relay = await import('../../../../electron/services/hermes-relay');
  relay.startHermesRelay({ enabled: () => true, pollMs: 0 });
});

describe('send_telegram with the relay on', () => {
  it('1, 3, 4. goes through the relay, under the orchestrator\'s project, masked, and never through the bot', async () => {
    const answer = await post('/api/telegram/send', { message: 'Done: #271 merged. key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', chat_id: '-100999' }, 'orch');

    expect(answer.status ?? 200).toBe(200);
    expect(fake.sends).toEqual([expect.objectContaining({ kind: 'report', project: 'tars', text: expect.stringContaining('Done: #271 merged.') })]);
    expect(fake.sends[0].text).not.toContain('AbCdEfGh');
    expect(botSends).toBe(0);
  });

  it('2. is refused to a worker, and to a caller no token names', async () => {
    for (const caller of ['worker', undefined]) {
      const answer = await post('/api/telegram/send', { message: 'hi' }, caller);
      expect(answer.status, String(caller)).toBe(403);
    }
    expect(fake.sends).toEqual([]);
    expect(botSends).toBe(0);
  });

  it('5. a photo, a video or a document is refused: the relay carries text only', async () => {
    for (const route of ['/api/telegram/send-photo', '/api/telegram/send-video', '/api/telegram/send-document']) {
      const answer = await post(route, { photo_path: '/tmp/x.png', video_path: '/tmp/x.mp4', document_path: '/tmp/x.pdf' }, 'orch');
      expect(answer.status, route).toBe(410);
    }
    expect(fake.sends).toEqual([]);
    expect(botSends).toBe(0);
  });
});
