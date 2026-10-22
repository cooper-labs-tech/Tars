import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sid } from '../../fixtures/session-id';

/**
 * Nothing Tars types goes into a dialog its CLI shows.
 *
 * Measured by the Audit on the 1.8.0 tree with real claude 2.1.280, and older
 * than it (1.7.9 has it): a bus message pasted into an open "Do you want to
 * proceed? 1. Yes" dialog, and its Enter said Yes: the command ran and the
 * message was lost. Bypass does not protect: an AskUserQuestion ("Delete the
 * build folder?") was answered "Yes, delete it" by JeanBrasse's room post.
 * AskUserQuestion fires PermissionRequest in bypass too, so Tars already knew
 * (waiting, permission): /message answered 409, and the bus, the delegation
 * notes, "send held" and the bots typed anyway (the Audit's census,
 * CENSUS-PERMISSION-WRITES.md).
 *
 * How it fails, written before the code (2026-09-24):
 * 1. A room message to an agent at a dialog is written, and its Enter answers.
 * 2. A delegation note to an orchestrator at a dialog is written.
 * 3. "Send held" (releaseBusMessagesNow) writes into a dialog: it checks no status.
 * 4. A message queued while the agent ran (behind a draft) goes out after a
 *    dialog opened: the check made when it was queued is stale by then.
 * 5. An AskUserQuestion in bypass is not taken for a dialog.
 * 6. What the dialog held back is lost, or delivered before the answer, or
 *    never delivered: it must go in once the agent runs again (PostToolUse).
 * 7. The guard reaches what it must not: a person's keys, and a launch typed
 *    into a bare shell.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-dialog-'));
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return {
    ...actual, DATA_DIR: tmp, AGENTS_FILE: path.join(tmp, 'agents.json'), BUS_FILE: path.join(tmp, 'bus.json'),
    dataPath: (f: string) => path.join(tmp, f),
  };
});
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => { ipcHandlers.set(channel, handler); } },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

type AgentStatus = import('../../../electron/types').AgentStatus;
let store: typeof import('../../../electron/services/bus-store');
let watch: typeof import('../../../electron/services/agent-watch');
let manager: typeof import('../../../electron/core/agent-manager');
let pty: typeof import('../../../electron/core/pty-manager');
let events: typeof import('../../../electron/services/agent-events');

const ROOM = 'project:/tars';
type FakeTerminal = { written: string[]; readonly typed: string };

function terminalFor(id: string): FakeTerminal {
  const written: string[] = [];
  const fake = { write: (d: string) => { written.push(d); } };
  pty.ptyProcesses.set(`pty-${id}`, fake as never);
  pty.rememberTerminalOwner(fake as never, id);
  return { written, get typed() { return written.join(''); } };
}

function putAgent(over: Partial<AgentStatus> & { id: string }): AgentStatus {
  const agent = {
    name: over.id.toUpperCase(), status: 'idle', provider: 'claude', projectPath: '/tars', skills: [], output: [],
    ptyId: `pty-${over.id}`, currentSessionId: sid(`sess-${over.id}`), lastActivity: new Date().toISOString(), ...over,
  } as AgentStatus;
  manager.agents.set(agent.id, agent);
  return agent;
}

/** The PermissionRequest hook's post: a dialog is up (a permission, or an AskUserQuestion). */
function dialogOpens(id: string): void {
  const a = manager.agents.get(id)!;
  a.status = 'waiting';
  a.waitingReason = 'permission';
  events.emitAgentStatus(id);
}

/** Answered: PostToolUse posts `running`. */
function answered(id: string): void {
  const a = manager.agents.get(id)!;
  a.status = 'running';
  a.waitingReason = undefined;
  events.emitAgentStatus(id);
}

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function userWrites(text: string, mentions: string[]): Promise<string> {
  const r = await ipcHandlers.get('bus:postMessage')!(null, { roomId: ROOM, text, mentions }) as { success: boolean; error?: string; messageId: string };
  expect(r.success, r.error).toBe(true);
  return r.messageId;
}

beforeEach(async () => {
  vi.resetModules();
  manager = await import('../../../electron/core/agent-manager');
  pty = await import('../../../electron/core/pty-manager');
  events = await import('../../../electron/services/agent-events');
  watch = await import('../../../electron/services/agent-watch');
  store = await import('../../../electron/services/bus-store');
  manager.agents.clear();
  // As main.ts wires it at startup.
  manager.wireDialogProbe();
  pty.ptyProcesses.clear();
  store.resetBusStore();
  // The transcripts the refusal tests write: each test starts with none.
  fs.rmSync(path.join(os.homedir(), '.claude', 'projects', '-tars'), { recursive: true, force: true });
  fs.rmSync(path.join(tmp, 'bus.json'), { force: true });
  watch.resetAgentWatch();
  watch.startAgentWatch();
  // As main.ts starts it.
  watch.watchInterruptedTurns();
  ipcHandlers.clear();
  const { registerBusHandlers } = await import('../../../electron/handlers/bus-handlers');
  registerBusHandlers();
});

afterEach(() => {
  watch.stopAgentWatch();
});

describe('a dialog open in the CLI', { timeout: 30_000 }, () => {
  it('1, 6. holds a room message, never delivered while it is up, and delivers it once the agent runs again', async () => {
    const alpha = terminalFor('alpha');
    putAgent({ id: 'alpha', status: 'idle' });
    dialogOpens('alpha');

    const id = await userWrites('Clean the build folder, please.', ['alpha']);
    await settle(1500);

    expect(alpha.written, 'typed into the dialog').toEqual([]);
    expect(store.deliveriesOf(id)[0].state).toBe('queued');

    answered('alpha');
    await settle(2500);
    expect(alpha.typed).toContain('Clean the build folder, please.');
    expect(store.deliveriesOf(id)[0].state).toBe('delivered');
  });

  it('2. holds a delegation note to an orchestrator at a dialog', async () => {
    const orch = terminalFor('orch');
    putAgent({ id: 'orch', status: 'idle' });
    putAgent({ id: 'w', name: 'Worker', status: 'running', requestedBy: { agentId: 'orch', ptyId: 'pty-w' } });
    dialogOpens('orch');

    manager.agents.get('w')!.status = 'completed';
    events.emitAgentStatus('w');
    await settle(1500);

    expect(orch.written, 'the note answered the dialog').toEqual([]);
    answered('orch');
    await settle(2500);
    expect(orch.typed).toContain('Worker');
  });

  it('3. writes nothing when "send held" is pressed while a dialog is up', async () => {
    const alpha = terminalFor('alpha');
    putAgent({ id: 'alpha', status: 'idle' });
    dialogOpens('alpha');

    const r = await watch.releaseBusMessagesNow('alpha', [{
      messageId: 'm1', roomId: ROOM, threadId: 't1', authorKind: 'human', authorName: 'User', text: 'held for you',
    }]);

    expect(r.written).toEqual([]);
    expect(alpha.written).toEqual([]);
  });

  it('4. does not write, when its turn comes, a message queued before the dialog opened', async () => {
    const alpha = terminalFor('alpha');
    putAgent({ id: 'alpha', status: 'running' });
    const ptyProcess = pty.ptyProcesses.get('pty-alpha')!;
    // Somebody was typing, and erased it: the field is empty, the message waits for the pause.
    pty.writeHumanInput(ptyProcess, 'x');
    pty.writeHumanInput(ptyProcess, '\x7f');
    const outcome = pty.writeProgrammaticInput(ptyProcess, 'queued before the dialog', true, { agentId: 'alpha', from: 'QA' });
    expect(outcome).toBe('held');

    dialogOpens('alpha');
    pty.writeHumanInput(ptyProcess, '\x03');
    await settle(pty.TYPING_PAUSE_MS + 1500);

    expect(alpha.typed).not.toContain('queued before the dialog');
    answered('alpha');
    await settle(2500);
    expect(alpha.typed).toContain('queued before the dialog');
    pty.resetTerminalInput(ptyProcess);
  });

  it('5. takes an AskUserQuestion in bypass, as the hook reports it, for a dialog', async () => {
    const alpha = terminalFor('alpha');
    putAgent({ id: 'alpha', status: 'running', permissionMode: 'bypass' });
    const { registerHooksRoutes } = await import('../../../electron/services/api-routes/hooks-routes');
    const routes: Array<{ pattern: unknown; handler: (...a: unknown[]) => unknown }> = [];
    const app = {
      routes, add(_m: string, pattern: unknown, handler: (...a: unknown[]) => unknown) { routes.push({ pattern, handler }); },
      get(p: unknown, h: (...a: unknown[]) => unknown) { this.add('GET', p, h); },
      post(p: unknown, h: (...a: unknown[]) => unknown) { this.add('POST', p, h); },
      put(p: unknown, h: (...a: unknown[]) => unknown) { this.add('PUT', p, h); },
      delete(p: unknown, h: (...a: unknown[]) => unknown) { this.add('DELETE', p, h); },
    };
    const ctx = {
      mainWindow: null, appSettings: {}, getAppSettings: () => ({}), handleStatusChangeNotificationCallback: vi.fn(),
      sendNotificationCallback: vi.fn(), agentStatusEmitter: new EventEmitter(),
    };
    registerHooksRoutes(app as never, ctx as never);
    await routes.find(r => r.pattern === '/api/hooks/status')!.handler({ body: {
      agent_id: 'alpha', session_id: sid('sess-alpha'), status: 'waiting', waiting_reason: 'permission', tool_name: 'AskUserQuestion',
    }, params: {} }, vi.fn(), ctx);

    await userWrites('Keep going.', ['alpha']);
    await settle(1500);

    expect(alpha.typed, 'JeanBrasse\'s post answered the question').not.toContain('Keep going.');
  });

  it('8. goes in after a person answers the dialog with the arrows and Enter, whose keys never reached the field', async () => {
    // Found by the in-app proof: the keys that answered the question (an arrow,
    // then Enter) were read as keys typed in the field, which the draft model
    // then could not vouch for, and the message waited for ever.
    const alpha = terminalFor('alpha');
    putAgent({ id: 'alpha', status: 'idle' });
    dialogOpens('alpha');
    await userWrites('After your answer.', ['alpha']);
    const ptyProcess = pty.ptyProcesses.get('pty-alpha')!;

    pty.writeHumanInput(ptyProcess, '\x1b[B');
    pty.writeHumanInput(ptyProcess, '\r');
    answered('alpha');
    await settle(pty.TYPING_PAUSE_MS + 2500);

    expect(alpha.typed).toContain('After your answer.');
    pty.resetTerminalInput(ptyProcess);
  });

  // The Audit's gate of #174: refusing a permission ("No" or Esc) sends no hook,
  // neither Stop nor idle_prompt, so the agent stayed waiting/permission with
  // its screen back at the input, and everything held for it stayed held until
  // JeanBrasse typed there himself. The transcript records the refusal:
  // "[Request interrupted by user for tool use]".
  async function permissionPosted(id: string, extra: Record<string, unknown> = {}): Promise<void> {
    const { registerHooksRoutes } = await import('../../../electron/services/api-routes/hooks-routes');
    const routes: Array<{ pattern: unknown; handler: (...a: unknown[]) => unknown }> = [];
    const app = {
      add(_m: string, pattern: unknown, handler: (...a: unknown[]) => unknown) { routes.push({ pattern, handler }); },
      get(p: unknown, h: (...a: unknown[]) => unknown) { this.add('GET', p, h); },
      post(p: unknown, h: (...a: unknown[]) => unknown) { this.add('POST', p, h); },
      put(p: unknown, h: (...a: unknown[]) => unknown) { this.add('PUT', p, h); },
      delete(p: unknown, h: (...a: unknown[]) => unknown) { this.add('DELETE', p, h); },
    };
    const ctx = { mainWindow: null, appSettings: {}, getAppSettings: () => ({}), handleStatusChangeNotificationCallback: vi.fn(), sendNotificationCallback: vi.fn(), agentStatusEmitter: new EventEmitter() };
    registerHooksRoutes(app as never, ctx as never);
    await routes.find(r => r.pattern === '/api/hooks/status')!.handler({ body: {
      agent_id: id, session_id: sid(`sess-${id}`), status: 'waiting', waiting_reason: 'permission', tool_name: 'Bash', ...extra,
    }, params: {} }, vi.fn(), ctx);
  }

  function interruptRecorded(id: string, at: Date): void {
    const dir = path.join(os.homedir(), '.claude', 'projects', '-tars');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${sid(`sess-${id}`)}.jsonl`), JSON.stringify({
      type: 'user', timestamp: at.toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
    }) + '\n');
  }

  it('9. lets what it held go once the transcript records the dialog was refused, which sends no hook', async () => {
    const alpha = terminalFor('alpha');
    putAgent({ id: 'alpha', status: 'running' });
    await permissionPosted('alpha');
    expect(manager.agents.get('alpha')!.status).toBe('waiting');
    await userWrites('After the refusal.', ['alpha']);
    await settle(1500);
    expect(alpha.typed).not.toContain('After the refusal.');

    await settle(20);
    interruptRecorded('alpha', new Date());
    await settle(2500);

    expect(alpha.typed).toContain('After the refusal.');
  });

  it('9. keeps holding while no refusal is recorded, and does not take one from before the dialog', async () => {
    const alpha = terminalFor('alpha');
    putAgent({ id: 'alpha', status: 'running' });
    interruptRecorded('alpha', new Date(Date.now() - 60_000));
    await permissionPosted('alpha');
    await userWrites('Not before the answer.', ['alpha']);
    await settle(3000);

    expect(alpha.typed).not.toContain('Not before the answer.');
  });

  // The Audit's re-check of #174: dialogSince was the post's arrival, so a
  // refusal made before a late post arrived read as older than the dialog.
  it('11. dates the dialog from the hook script\'s own time, so a refusal before a late post still closes it', async () => {
    const alpha = terminalFor('alpha');
    putAgent({ id: 'alpha', status: 'running' });
    const openedAt = Date.now() - 4000;
    interruptRecorded('alpha', new Date(openedAt + 1000));
    await permissionPosted('alpha', { opened_at: openedAt });

    expect(manager.agents.get('alpha')!.dialogSince).toBe(new Date(openedAt).toISOString());
    await userWrites('After the early refusal.', ['alpha']);
    await settle(2500);
    expect(alpha.typed).toContain('After the early refusal.');
  });

  it('11. does not take a time from the future, nor from long before, for the dialog\'s opening', async () => {
    putAgent({ id: 'alpha', status: 'running' });
    await permissionPosted('alpha', { opened_at: Date.now() + 3_600_000 });
    const future = Date.parse(manager.agents.get('alpha')!.dialogSince!);
    expect(future).toBeLessThanOrEqual(Date.now());

    putAgent({ id: 'beta', status: 'running' });
    await permissionPosted('beta', { opened_at: Date.now() - 3_600_000 });
    expect(Date.now() - Date.parse(manager.agents.get('beta')!.dialogSince!)).toBeLessThanOrEqual(60_000);
  });

  // An Esc on a running turn ends it with no hook: no Stop, and the idle
  // prompt only a minute on. The transcript records it.
  it('12. reads an interruption recorded during a turn as the turn\'s end, and delivers what waited for it', async () => {
    const alpha = terminalFor('alpha');
    putAgent({ id: 'alpha', status: 'running', lastTurnStartedAt: new Date(Date.now() - 10_000).toISOString() });
    const id = await userWrites('After the Esc.', ['alpha']);
    await settle(500);
    expect(alpha.typed).not.toContain('After the Esc.');

    interruptRecorded('alpha', new Date());
    await settle(3500);

    expect(manager.agents.get('alpha')!.status).toBe('idle');
    expect(alpha.typed).toContain('After the Esc.');
    expect(store.deliveriesOf(id)[0].state).toBe('delivered');
  });

  // The Audit's gate of #179: a session resumed with --fork-session copies the
  // old conversation into its transcript, old interruptions and their dates
  // included. Between its SessionStart and its first UserPromptSubmit, the turn
  // it began from was still the previous one.
  it('12. does not end a forked session\'s turn on an interruption copied from before it registered', async () => {
    terminalFor('alpha');
    interruptRecorded('alpha', new Date(Date.now() - 5_000));
    putAgent({
      id: 'alpha', status: 'running',
      lastTurnStartedAt: new Date(Date.now() - 10_000).toISOString(),
      sessionRegisteredAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await settle(3500);

    expect(manager.agents.get('alpha')!.status).toBe('running');
  });

  it('12. still ends a forked session\'s turn on an interruption made after it registered', async () => {
    terminalFor('alpha');
    putAgent({
      id: 'alpha', status: 'running',
      lastTurnStartedAt: new Date(Date.now() - 10_000).toISOString(),
      sessionRegisteredAt: new Date(Date.now() - 3_000).toISOString(),
    });
    interruptRecorded('alpha', new Date());
    await settle(3500);

    expect(manager.agents.get('alpha')!.status).toBe('idle');
  });

  // QA's gate of #189: claude registers again at every compaction, in the same
  // process and session. Counted from that registration, an interruption made
  // before a /compact the next tick had not seen yet was ignored for good, and
  // the agent stayed running. Counted from the CLI's launch, it is not.
  it('12. still ends a turn interrupted just before a compaction registered the session again', async () => {
    terminalFor('alpha');
    const restart = await import('../../../electron/core/agent-restart');
    restart.noteLaunch(pty.ptyProcesses.get('pty-alpha'), {} as never);
    await settle(20);
    const turnStarted = new Date().toISOString();
    await settle(20);
    interruptRecorded('alpha', new Date());
    await settle(20);
    putAgent({ id: 'alpha', status: 'running', lastTurnStartedAt: turnStarted, sessionRegisteredAt: new Date().toISOString() });
    await settle(3500);

    expect(manager.agents.get('alpha')!.status).toBe('idle');
  });

  it('12. does not end a turn on an interruption from before it began', async () => {
    terminalFor('alpha');
    interruptRecorded('alpha', new Date(Date.now() - 20_000));
    putAgent({ id: 'alpha', status: 'running', lastTurnStartedAt: new Date(Date.now() - 10_000).toISOString() });
    await settle(3500);

    expect(manager.agents.get('alpha')!.status).toBe('running');
  });

  it('10. holds the Enter of a message pasted just before a dialog opened, and lets a person answer it', async () => {
    const alpha = terminalFor('alpha');
    putAgent({ id: 'alpha', status: 'running' });
    const ptyProcess = pty.ptyProcesses.get('pty-alpha')!;

    expect(pty.writeProgrammaticInput(ptyProcess, 'pasted before the dialog', true, { agentId: 'alpha', from: 'QA' })).toBe('written');
    dialogOpens('alpha');
    await settle(pty.PROGRAMMATIC_SUBMIT_DELAY_MS + 700);
    expect(alpha.written, 'the Enter answered the dialog').not.toContain('\r');

    pty.writeHumanInput(ptyProcess, '4');
    expect(alpha.written.at(-1), 'the person could not answer the dialog').toBe('4');

    answered('alpha');
    await settle(2000);
    expect(alpha.written).toContain('\r');
    pty.resetTerminalInput(ptyProcess);
  });

  it('7. still passes a person\'s keys, and a launch typed into a bare shell', () => {
    const alpha = terminalFor('alpha');
    putAgent({ id: 'alpha', status: 'idle' });
    dialogOpens('alpha');
    const ptyProcess = pty.ptyProcesses.get('pty-alpha')!;

    pty.writeHumanInput(ptyProcess, '1');
    expect(alpha.written).toEqual(['1']);

    pty.writeProgrammaticInput(ptyProcess, "cd '/tars' && claude", false);
    expect(alpha.typed).toContain("cd '/tars' && claude\r");
    pty.resetTerminalInput(ptyProcess);
  });
});
