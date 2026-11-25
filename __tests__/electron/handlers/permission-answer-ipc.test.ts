/**
 * The window's side of a permission question the state mod asked Tars
 * (services/permission-asks.ts): agent:answerPermission answers it, and the
 * window's Stop and Delete, the API's stop and DELETE, and the quit each end a
 * question still held.
 *
 * How it fails, written before the code (2026-10-05):
 * 1. The window has no way to answer: no IPC, or one that is not in the
 *    preload, or whose type the renderer does not have.
 * 2. The answer reaches the mod without saying who gave it, or as "you",
 *    which the model reads as itself: the window is the user.
 * 3. A stop or a delete leaves the question held: the mod's request open on a
 *    CLI that is being ended, and a later answer taken for a gone session.
 * 4. The quit leaves the questions held: a request open while the app exits.
 * And from the owner's question of 10/11 (approve-everywhere.md), written before the code:
 * 5. The window has only the view Tars publishes of a question (each field at most 2,000 characters): it cannot show
 *    the whole call it would allow. agent:permissionQuestion gives it whole, with its fingerprint, and nothing for an
 *    agent with no question.
 * 6. The window's answer cannot name what it read: agent:answerPermission takes the fingerprint the window showed,
 *    and an allow naming another question's changes nothing.
 * And from the Audit's FIX FIRST on #588 (M1 and L2), written before the code:
 * 7. An allow with no fingerprint is taken, and a refusal comes back as a bare `success: false` the window reads as a
 *    question gone: every allow names the fingerprint, and a refusal says why (`code`, `error`), in the preload's type.
 *
 * The handlers are the real ones; the question is held as the route holds it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { tmpHome } = vi.hoisted(() => ({
  tmpHome: `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-permission-ipc-${process.pid}-${Date.now()}`,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.9.3', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { holdPermissionAsk, resetPermissionAsks, type PermissionAnswer, type PermissionPending } from '../../../electron/services/permission-asks';
import type { AgentStatus, AppSettings } from '../../../electron/types';

fs.mkdirSync(tmpHome, { recursive: true });

function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = { agents, ptyProcesses, saveAgents: vi.fn(), getAppSettings: () => ({} as AppSettings) };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}
registerIpcHandlers(deps());

const ROOT = path.join(__dirname, '../../..');

function held(): { agent: AgentStatus; answer: Promise<PermissionAnswer | PermissionPending> } {
  const agent = {
    id: 'a1', name: 'Backend', status: 'running', projectPath: tmpHome, skills: [], output: [],
    currentSessionId: '11111111-1111-4111-8111-111111111111', lastActivity: new Date().toISOString(),
  } as unknown as AgentStatus;
  agents.set('a1', agent);
  const answer = holdPermissionAsk(agent, { tool: 'Bash', toolUseId: 'toolu_1', fields: { command: 'rm -rf build' }, waitingOn: { kind: 'permission', text: 'rm -rf build' } }, () => undefined);
  return { agent, answer };
}

beforeEach(() => {
  agents.clear();
  resetPermissionAsks();
});

describe("the window's answer", () => {
  it('1, 2, 7. agent:answerPermission allows the held call, as the user, named by its fingerprint', async () => {
    const { agent, answer } = held();
    expect(await handlers.get('agent:answerPermission')!({}, 'a1', 'allow')).toMatchObject({
      success: false, code: 'read-first', error: expect.stringMatching(/whole/),
    });
    const read = agent.permissionAsk!.fingerprint;
    expect(await handlers.get('agent:answerPermission')!({}, 'a1', 'allow', undefined, read)).toEqual({ success: true });
    expect(await answer).toMatchObject({ decision: 'allow', reason: 'the user allowed it in Tars' });
    expect(agent.status).toBe('running');
  });

  it('2. a deny carries the reason the window gave', async () => {
    const { answer } = held();
    await handlers.get('agent:answerPermission')!({}, 'a1', 'deny', 'not on main');
    expect(await answer).toMatchObject({ decision: 'deny', reason: 'the user refused it in Tars: not on main' });
  });

  it('1, 7. says when there was nothing to answer, and why', async () => {
    expect(await handlers.get('agent:answerPermission')!({}, 'a1', 'allow')).toMatchObject({
      success: false, code: 'no-question', error: expect.stringMatching(/no longer holds/),
    });
  });

  it('1, 6, 7. is in the preload and typed for the renderer, with the fingerprint the window read and why a refusal', () => {
    const preload = fs.readFileSync(path.join(ROOT, 'electron/preload.ts'), 'utf8');
    const types = fs.readFileSync(path.join(ROOT, 'src/types/electron.d.ts'), 'utf8');
    expect(preload).toMatch(/answerPermission: \(id: string, decision: 'allow' \| 'deny' \| 'ask', reason\?: string, fingerprint\?: string\) =>\s*ipcRenderer\.invoke\('agent:answerPermission', id, decision, reason, fingerprint\)/);
    expect(types).toContain("answerPermission: (id: string, decision: 'allow' | 'deny' | 'ask', reason?: string, fingerprint?: string) => Promise<{ success: true } | { success: false; code: PermissionRefusal; error: string }>;");
    expect(types).toContain("export type PermissionRefusal = 'no-question' | 'another-question' | 'read-first' | 'withheld' | 'not-a-decision';");
  });

  it('6. an allow naming the fingerprint of what the window read is taken; one naming another changes nothing', async () => {
    const { answer } = held();
    const shown = (await handlers.get('agent:permissionQuestion')!({}, 'a1') as { question: { fingerprint: string } }).question.fingerprint;
    expect(await handlers.get('agent:answerPermission')!({}, 'a1', 'allow', undefined, 'f'.repeat(64))).toMatchObject({ success: false, code: 'another-question' });
    expect(await handlers.get('agent:answerPermission')!({}, 'a1', 'allow', undefined, shown)).toEqual({ success: true });
    expect(await answer).toMatchObject({ decision: 'allow', fingerprint: shown });
  });
});

describe('the whole question, for the window', () => {
  it('5. agent:permissionQuestion gives the held question whole, with its fingerprint', async () => {
    const command = `cat > notes.md <<'EOF'\n${'y'.repeat(5000)}\nEOF`;
    const agent = { id: 'a1', name: 'Backend', status: 'running', projectPath: tmpHome, skills: [], output: [], lastActivity: new Date().toISOString() } as unknown as AgentStatus;
    agents.set('a1', agent);
    void holdPermissionAsk(agent, { tool: 'Bash', toolUseId: 'toolu_1', fields: { command }, waitingOn: undefined }, () => undefined);
    const got = await handlers.get('agent:permissionQuestion')!({}, 'a1') as { success: boolean; question: Record<string, unknown> };
    expect(got).toMatchObject({ success: true, question: { tool: 'Bash', fields: { command }, subject: command, jsonFields: [] } });
    expect(got.question.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(agent.permissionAsk?.fields.command).toHaveLength(2000);
  });

  it('5. says when there is no question', async () => {
    expect(await handlers.get('agent:permissionQuestion')!({}, 'a1')).toMatchObject({ success: false });
    expect(await handlers.get('agent:permissionQuestion')!({}, 42)).toMatchObject({ success: false });
  });

  it('5. is in the preload and typed for the renderer', () => {
    const preload = fs.readFileSync(path.join(ROOT, 'electron/preload.ts'), 'utf8');
    const types = fs.readFileSync(path.join(ROOT, 'src/types/electron.d.ts'), 'utf8');
    expect(preload).toMatch(/permissionQuestion: \(id: string\) =>\s*ipcRenderer\.invoke\('agent:permissionQuestion', id\)/);
    expect(types).toMatch(/permissionQuestion: \(id: string\) => Promise<\{ success: true; question: PermissionQuestionWhole \} \| \{ success: false; error: string \}>;/);
  });
});

describe('the status event the window reads', () => {
  // The question's own event carries permissionAsk (and waitingReason): the
  // type the renderer reads it with must say so, preload and type together
  // (the Audit's recheck of #318, the type gap).
  it('declares permissionAsk and waitingReason, in the preload and in the renderer\'s type', () => {
    const preload = fs.readFileSync(path.join(ROOT, 'electron/preload.ts'), 'utf8');
    const types = fs.readFileSync(path.join(ROOT, 'src/types/electron.d.ts'), 'utf8');
    const onStatus = (text: string) => text.slice(text.indexOf('onStatus'), text.indexOf('=>', text.indexOf('onStatus')));
    for (const text of [preload, types]) {
      expect(onStatus(text)).toMatch(/waitingReason\?: string/);
      expect(onStatus(text)).toMatch(/permissionAsk\?: AgentStatus\['permissionAsk'\] \| null/);
    }
  });
});

describe('a question still held', () => {
  it("3. ends with the window's Stop", async () => {
    const { answer } = held();
    await handlers.get('agent:stop')!({}, 'a1');
    expect(await answer).toEqual({ decision: 'ask' });
  });

  it("3. ends with the window's Delete", async () => {
    const { answer } = held();
    await handlers.get('agent:remove')!({}, 'a1');
    expect(await answer).toEqual({ decision: 'ask' });
  });

  it('3, 4. ends with the API\'s DELETE, and the quit has a step for every question', () => {
    const routes = fs.readFileSync(path.join(ROOT, 'electron/services/api-routes/agent-routes.ts'), 'utf8');
    const deleteRoute = routes.slice(routes.indexOf('// DELETE /api/agents/:id'));
    // Through the window's removal since 28/10 (the Audit's L4 on #523), which drops the agent's questions.
    expect(deleteRoute).toMatch(/removeAgent\(agent\.id\)/);
    const removal = fs.readFileSync(path.join(ROOT, 'electron/core/agent-remove.ts'), 'utf8');
    expect(removal).toMatch(/dropPermissionAsks\(id\)/);
    const main = fs.readFileSync(path.join(ROOT, 'electron/main.ts'), 'utf8');
    expect(main).toMatch(/\['endPermissionAsks', endPermissionAsks\]/);
  });
});
