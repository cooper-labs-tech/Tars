import '../../setup/home-guard';
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AcpSession } from '../../../electron/services/acp/client';
import { Leftovers, RECORDS_ITS_PID, takePidsRecordedIn } from '../../setup/leftover-processes';

/**
 * A fake agent that speaks just enough ACP to prove the client's contract:
 * a turn returns a stop reason, tool events surface, and the deny list is
 * enforced by answering the agent's own permission request.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-acp-'));
const started: AcpSession[] = [];

function fakeAgent(script: string): { command: string; args: string[] } {
  const file = path.join(tmp, `agent-${Math.abs(hash(script))}.mjs`);
  fs.writeFileSync(file, RECORDS_ITS_PID + script);
  return { command: process.execPath, args: [file] };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

const PRELUDE = `
let buf = '';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
`;

const leftovers = new Leftovers();
afterEach(() => {
  for (const s of started.splice(0)) s.stop();
  // Ended by its id too, stopped or not, whatever stop() got to (leftover-processes.ts).
  leftovers.push(...takePidsRecordedIn(tmp));
  leftovers.end();
});

function track(session: AcpSession): AcpSession {
  started.push(session);
  return session;
}

describe('AcpSession', () => {
  it('returns the turn result rather than leaving the caller to guess', async () => {
    const agent = fakeAgent(`${PRELUDE}
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { agentInfo: { name: 'fake' } } });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn', usage: { totalTokens: 42 } } });
  }
}
`);

    const session = track(new AcpSession(agent, { cwd: tmp }));
    const info = await session.start();
    const turn = await session.prompt('do the thing', 20_000);

    expect(info.agentName).toBe('fake');
    expect(turn.stopReason).toBe('end_turn');
    expect(turn.text).toBe('done');
    expect(turn.usage?.totalTokens).toBe(42);
  });

  it('surfaces tool calls as structured events', async () => {
    const agent = fakeAgent(`${PRELUDE}
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', title: 'Bash', kind: 'execute', status: 'pending' } } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
}
`);

    const session = track(new AcpSession(agent, { cwd: tmp }));
    const seen: string[] = [];
    session.on('tool', t => seen.push(t.title));
    await session.start();
    const turn = await session.prompt('run it', 20_000);

    expect(seen).toEqual(['Bash']);
    expect(turn.toolCalls.map(t => t.title)).toEqual(['Bash']);
  });

  it('rejects a denied tool when the agent asks permission', async () => {
    const agent = fakeAgent(`${PRELUDE}
let promptId = null;
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1', modes: { currentModeId: 'dontAsk', availableModes: [{ id: 'default' }] } } });
  if (msg.method === 'session/set_mode') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/prompt') {
    promptId = msg.id;
    send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
      toolCall: { title: 'Write', kind: 'edit' },
      options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
    } });
    return;
  }
  if (msg.id === 900) {
    send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chose:' + msg.result.outcome.optionId } } } });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  }
}
`);

    const session = track(new AcpSession(agent, { cwd: tmp, denyTools: ['write'] }));
    await session.start();
    const turn = await session.prompt('edit a file', 20_000);

    expect(turn.text).toBe('chose:no');
  });

  it('allows a tool that is not on the deny list', async () => {
    const agent = fakeAgent(`${PRELUDE}
let promptId = null;
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') {
    promptId = msg.id;
    send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
      toolCall: { title: 'Read', kind: 'read' },
      options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
    } });
    return;
  }
  if (msg.id === 900) {
    send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'chose:' + msg.result.outcome.optionId } } } });
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  }
}
`);

    const session = track(new AcpSession(agent, { cwd: tmp, denyTools: ['write'] }));
    await session.start();
    const turn = await session.prompt('read a file', 20_000);

    expect(turn.text).toBe('chose:yes');
  });

  it('fails the pending call when the agent dies mid-turn', async () => {
    const agent = fakeAgent(`${PRELUDE}
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') process.exit(3);
}
`);

    const session = track(new AcpSession(agent, { cwd: tmp }));
    await session.start();

    await expect(session.prompt('boom', 20_000)).rejects.toThrow(/exited/);
  });
});

describe('what a turn leaves behind when it ends (sessions that died while they waited, 2026-09-23)', () => {
  // A delegated run is one turn: when it ends, Tars stops the agent, and what
  // it left running goes with it. Measured on claude-agent-acp 0.70.0: a
  // background command's own notice reads `<status>killed</status>` two seconds
  // after the turn. And a run stopped at its turn limit answered nothing at
  // all, however much it had said and done.
  //
  // How this fails, written before the code:
  // 1. A background command, a Monitor or a ScheduleWakeup the turn started is
  //    not reported, so whoever delegated reads "done" and waits for results
  //    that were stopped.
  // 2. The call's input arrives in a later tool_call_update than the call
  //    itself (the adapter emits the call first), and only the first is read.
  // 3. A foreground command is counted as left behind.
  // 4. A turn stopped at its limit returns no text and no tools: what the
  //    agent said and did before the limit is lost.
  const agentWith = (updates: unknown[], answer = true) => fakeAgent(`${PRELUDE}
function handle(msg) {
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
  if (msg.method === 'session/prompt') {
    for (const update of ${JSON.stringify(updates)}) send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update } });
    ${answer ? "return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });" : ''}
  }
}
`);

  it('reports the background commands, monitors and wakeups the turn left running', async () => {
    const session = track(new AcpSession(agentWith([
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Terminal', kind: 'execute', rawInput: {} },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'pnpm build', rawInput: { command: 'pnpm build', run_in_background: true } },
      { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'pnpm test', kind: 'execute', rawInput: { command: 'pnpm test' } },
      { sessionUpdate: 'tool_call', toolCallId: 't3', title: 'Monitor', kind: 'other', rawInput: { command: 'tail -f build.log' } },
      { sessionUpdate: 'tool_call', toolCallId: 't4', title: 'ScheduleWakeup', kind: 'other', rawInput: { delaySeconds: 1200 } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'builds are running' } },
    ]), { cwd: tmp }));
    await session.start();

    const turn = await session.prompt('upgrade', 20_000);

    expect(turn.background).toEqual(['pnpm build', 'Monitor', 'ScheduleWakeup']);
    // Named by what it ran, not by the placeholder the adapter sends first
    // ("Terminal", measured on claude-agent-acp 0.70.0).
    expect(turn.toolCalls.map(t => t.title)).toEqual(['pnpm build', 'pnpm test', 'Monitor', 'ScheduleWakeup']);
  });

  it('reports nothing for a turn that waited for its own work', async () => {
    const session = track(new AcpSession(agentWith([
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'pnpm build', kind: 'execute', rawInput: { command: 'pnpm build', timeout: 600000 } },
    ]), { cwd: tmp }));
    await session.start();

    expect((await session.prompt('build', 20_000)).background).toEqual([]);
  });

  it('keeps what a turn said and did when it is stopped at its limit', async () => {
    const session = track(new AcpSession(agentWith([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'three of five repos upgraded' } },
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'pnpm build', kind: 'execute', rawInput: { command: 'pnpm build' } },
    ], false), { cwd: tmp }));
    await session.start();

    await expect(session.prompt('upgrade', 1_500)).rejects.toThrow(/timed out/);
    const partial = session.partialTurn();

    expect(partial.text).toBe('three of five repos upgraded');
    expect(partial.toolCalls.map(t => t.title)).toEqual(['pnpm build']);
  });
});

/**
 * A run held to plan mode (the ceiling for delegated runs, core/permission-ceiling.ts),
 * from the Audit's gate of #364 (B1), written before the fix (2026-10-12).
 *
 * How it fails:
 * 1. Claude leaves plan by calling ExitPlanMode, which claude-agent-acp 0.70.0 sends
 *    as a permission request whose options switch the session's mode; Tars answers
 *    every request itself, and under plan it chose allow_once: the run left plan for
 *    `default`, and every edit after was approved too.
 * 2. Any other request under plan (an edit, a command) is approved.
 * 3. The session's mode changes away from plan (the adapter switched without asking,
 *    or a request was approved anyway) and nobody hears of it: the run goes on in a
 *    broader mode than its asker's.
 */
describe('a run held to plan mode (the Audit\'s B1 on #364)', () => {
  /** The options claude-agent-acp 0.70.0 offers with ExitPlanMode (dist/acp-agent.js:4126). */
  const EXIT_PLAN = {
    toolCall: { title: 'ExitPlanMode', kind: 'switch_mode' },
    options: [
      { kind: 'allow_always', name: 'Yes, and use "auto" mode', optionId: 'auto' },
      { kind: 'allow_always', name: 'Yes, and auto-accept edits', optionId: 'acceptEdits' },
      { kind: 'allow_once', name: 'Yes, and manually approve edits', optionId: 'default' },
      { kind: 'reject_once', name: 'No, keep planning', optionId: 'plan' },
    ],
  };
  const EDIT = { toolCall: { title: 'Write src/x.ts', kind: 'edit' }, options: [{ kind: 'allow_once', optionId: 'allow' }, { kind: 'reject_once', optionId: 'reject' }] };

  function answered(mode: 'plan' | 'normal', params: unknown): unknown {
    const s = new AcpSession({ command: 'x', args: [] }, { cwd: '/', permissionMode: mode });
    let out: { result?: unknown } | undefined;
    (s as unknown as { write: (m: unknown) => void }).write = (m) => { out = m as { result?: unknown }; };
    (s as unknown as { answerPermission: (id: number, p: unknown) => void }).answerPermission(7, params);
    return out?.result;
  }

  it('1. answers ExitPlanMode with "keep planning"', () => {
    expect(answered('plan', EXIT_PLAN)).toEqual({ outcome: { outcome: 'selected', optionId: 'plan' } });
  });

  it('2. refuses every other request, and offered no refusal, cancels it', () => {
    expect(answered('plan', EDIT)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } });
    expect(answered('plan', { toolCall: { title: 'Bash' }, options: [{ kind: 'allow_once', optionId: 'go' }] })).toEqual({ outcome: { outcome: 'cancelled' } });
    // Outside plan, as before.
    expect(answered('normal', EDIT)).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
  });

  it('3. reports a mode change away from plan as a breach, and only that', () => {
    const s = new AcpSession({ command: 'x', args: [] }, { cwd: '/', permissionMode: 'plan' });
    const breaches: string[] = [];
    s.on('breach', (mode: string) => breaches.push(mode));
    const update = (u: Record<string, unknown>) => (s as unknown as { onUpdate: (u: Record<string, unknown>) => void }).onUpdate(u);
    update({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' });
    update({ sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' });
    expect(breaches).toEqual(['acceptEdits']);
    const free = new AcpSession({ command: 'x', args: [] }, { cwd: '/', permissionMode: 'normal' });
    const none: string[] = [];
    free.on('breach', (mode: string) => none.push(mode));
    (free as unknown as { onUpdate: (u: Record<string, unknown>) => void }).onUpdate({ sessionUpdate: 'current_mode_update', currentModeId: 'bypassPermissions' });
    expect(none).toEqual([]);
  });
});
