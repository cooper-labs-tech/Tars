import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Each result a worker reports goes back to the agent that asked for that
 * piece of work (ORCHESTRATOR-PER-CHAT.md v2.2, PR A), in the real app.
 *
 * Three stand-in CLIs record every byte typed into them: a worker, and two
 * agents that ask it for work ("Lead" and "Bot"). The requests go through the
 * API with each asker's own token, as send_message does. The worker's turns
 * are told to Tars through the real hook route with the worker's own token,
 * as Claude Code's UserPromptSubmit and Stop hooks do, the prompt being what
 * Tars typed.
 *
 * Asserted, in order:
 * 1. two requests typed in, each sender line naming its own task; the link is
 *    the first asker's (main overwrote it with the second's);
 * 2. a turn Noah types takes nothing: the link and the queue are unchanged;
 * 3. the first task's end is told to Lead only, and the second's to Bot only;
 * 4. a message held behind a half-typed line, whose terminal then dies, is
 *    told to its asker as never run;
 * 5. a worker stopped with one task running and one queued: the queued one's
 *    asker is told it never ran, the running one's that the worker stopped,
 *    and nothing is left queued.
 * The artefact: values.json with every byte each stand-in received, the
 * worker's link and queue at each step.
 *
 * And from QA's gate of #351 (its spec, qa-351-0710/qa-interleave.spec.ts,
 * made a real one; red on 2ee8c416 and 34c1a7e9): a request typed in during
 * another request's turn moved the worker's `workHandedAt`, so the turn in
 * hand no longer counted as handed work: its end told nobody, its link stayed,
 * and Noah's next turn was reported to the first asker as its result. The
 * second asker is held to the same once (QA, 2026-10-12): a link kept after
 * B's end reported Noah's turn to Bot, and only Lead's count was asserted.
 */

type Agent = { id: string; cliRunning?: boolean };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]> } } };

test("each result goes back to the agent that asked for that piece of work", async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-per-task-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const cliFor = (id: string) => {
    const file = path.join(home, `${id}.received`);
    // writeNodeCli: the script itself on macOS and Linux, npm's shim beside it on Windows.
    const cli = writeNodeCli(path.join(home, `${id}-cli.cjs`), [
      "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
      `process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(file)}, d));`,
      "process.stdout.write('stand-in ready\\n');",
      '',
    ].join('\n'));
    return { cli, file };
  };
  const stand = { w1: cliFor('w1'), o1: cliFor('o1'), b1: cliFor('b1') };
  const agent = (id: 'w1' | 'o1' | 'b1', name: string) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: stand[id].cli,
    createdAt: '2026-10-07T08:00:00.000Z', lastActivity: '2026-10-07T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('w1', 'Worker'), agent('o1', 'Lead'), agent('b1', 'Bot')], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const port = apiPort(31458);
  const dist = path.resolve('electron', 'dist');
  const read = (id: keyof typeof stand) => (fs.existsSync(stand[id].file) ? fs.readFileSync(stand[id].file, 'utf8') : '');
  const steps: Record<string, unknown> = {};

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
    const start = async (id: string) => {
      await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), id);
      await expect.poll(async () => (await list()).find(a => a.id === id)?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
    };
    for (const id of ['w1', 'o1', 'b1']) await start(id);

    /** In the main process: each stand-in's session up (it has no hooks), the askers at rest, and a token for each. */
    const settle = () => app.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      const { agents } = req(`${dist}/core/agent-manager.js`);
      const tokens: Record<string, string> = {};
      for (const id of ['w1', 'o1', 'b1']) {
        const a = agents.get(id);
        a.sessionRegisteredAt = new Date().toISOString();
        if (id !== 'w1') a.status = 'idle';
        tokens[id] = req(`${dist}/core/agent-tokens.js`).mintAgentToken(id);
      }
      return tokens;
    }, { dist });
    let tokens = await settle();
    const worker = () => app.evaluate((_e, { dist }) => {
      const w = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get('w1');
      return { requestedBy: w.requestedBy ?? null, queue: (w.taskQueue ?? []).map((r: { ref: string; requesterAgentId: string; state: string }) => [r.ref, r.requesterAgentId, r.state]), status: w.status };
    }, { dist });
    const api = (route: string, as: string, body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[as]}`, 'X-Tars-Caller-Id': as },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }).then(async r => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
    let session = 'e2e00000-0000-4000-8000-000000000001';
    const hook = (body: Record<string, unknown>) => api('/api/hooks/status', 'w1', { agent_id: 'w1', session_id: session, ...body });
    await hook({ status: 'idle', source: 'startup' });

    // 1. Two askers, one busy worker.
    await hook({ status: 'running', event: 'UserPromptSubmit', current_task: 'something Noah asked earlier' });
    const a = await api('/api/agents/w1/message', 'o1', { message: 'TASK-A review #280' });
    const b = await api('/api/agents/w1/message', 'b1', { message: 'TASK-B write the release notes' });
    await expect.poll(() => read('w1').includes('TASK-B'), { timeout: 20_000 }).toBe(true);
    const lines = read('w1').split(/\r|\n|\x1b\[20[01]~/).filter(l => /^Message from/.test(l));
    const refA = /^Message from agent "Lead" \("o1"\), task (t-[0-9a-f]{8}): /.exec(lines[0] ?? '')?.[1];
    const refB = /^Message from agent "Bot" \("b1"\), task (t-[0-9a-f]{8}): /.exec(lines[1] ?? '')?.[1];
    steps.sent = { a, b, lines, refA, refB, worker: await worker() };
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(refA).toBeTruthy();
    expect(refB).toBeTruthy();
    expect(refA).not.toBe(refB);
    expect((await worker()).requestedBy).toMatchObject({ agentId: 'o1', taskRef: refA });

    // 2. A turn Noah types takes nothing.
    await hook({ status: 'running', event: 'UserPromptSubmit', current_task: 'fix the typo in the README first' });
    steps.noahTurn = await worker();
    expect((await worker()).requestedBy).toMatchObject({ agentId: 'o1', taskRef: refA });
    expect((await worker()).queue.map((q: string[]) => q[0])).toEqual([refA, refB]);

    // 3. Turn A, then turn B: each end to its own asker.
    await hook({ status: 'running', event: 'UserPromptSubmit', current_task: `${lines[0]}TASK-A review #280` });
    await hook({ status: 'idle', hook: 'Stop' });
    await expect.poll(() => read('o1').includes('Worker'), { timeout: 20_000 }).toBe(true);
    steps.afterA = { o1: read('o1'), b1: read('b1'), worker: await worker() };
    expect(read('b1')).not.toContain('Worker');
    expect((await worker()).requestedBy).toMatchObject({ agentId: 'b1', taskRef: refB });

    await hook({ status: 'running', event: 'UserPromptSubmit', current_task: `${lines[1]}TASK-B write the release notes` });
    await hook({ status: 'idle', hook: 'Stop' });
    await expect.poll(() => read('b1').includes('Worker'), { timeout: 20_000 }).toBe(true);
    steps.afterB = { o1: read('o1'), b1: read('b1'), worker: await worker() };
    expect(read('o1').split('Worker').length - 1, 'Lead was told of the second task').toBe(1);

    // 4. A message held behind a half-typed line, its terminal then dead.
    await app.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      const w = req(`${dist}/core/agent-manager.js`).agents.get('w1');
      const pm = req(`${dist}/core/pty-manager.js`);
      pm.writeHumanInput(pm.ptyProcesses.get(w.ptyId), 'half-typed');
    }, { dist });
    const held = await api('/api/agents/w1/message', 'o1', { message: 'TASK-C never typed' });
    steps.held = { held, worker: await worker() };
    expect(held.body.held).toBe(true);
    await app.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      const w = req(`${dist}/core/agent-manager.js`).agents.get('w1');
      process.kill(req(`${dist}/core/pty-manager.js`).ptyProcesses.get(w.ptyId).pid, 'SIGKILL');
    }, { dist });
    await expect.poll(() => read('o1').includes('never ran what you asked of it'), { timeout: 30_000 }).toBe(true);
    steps.givenUp = { o1: read('o1'), worker: await worker() };

    // 5. A worker stopped with one task running and one queued.
    await start('w1');
    tokens = await settle();
    session = 'e2e00000-0000-4000-8000-000000000002';
    await hook({ status: 'idle', source: 'startup' });
    const before = read('b1').length;
    const beforeLead = read('o1').length;
    await hook({ status: 'running', event: 'UserPromptSubmit', current_task: 'busy' });
    const d = await api('/api/agents/w1/message', 'o1', { message: 'TASK-D' });
    const e = await api('/api/agents/w1/message', 'b1', { message: 'TASK-E' });
    steps.beforeStop = { d, e, worker: await worker() };
    const stop = await api('/api/agents/w1/stop', 'o1', { reason: 'the e2e stops it with work in hand' });
    await expect.poll(() => read('b1').slice(before).includes('never ran what you asked of it'), { timeout: 30_000 }).toBe(true);
    // The running task's asker is told by the stop itself (its status event).
    await expect.poll(() => read('o1').slice(beforeLead).includes('stopped'), { timeout: 30_000 }).toBe(true);
    steps.stopped = { stop, b1: read('b1').slice(before), o1: read('o1').slice(beforeLead), worker: await worker() };
    expect(stop.status).toBe(200);
    expect((await worker()).queue).toEqual([]);
  } finally {
    recordValues({ steps, received: { w1: read('w1'), o1: read('o1'), b1: read('b1') } });
    await app.close().catch(() => { /* gone */ });
  }
});

test('a request sent during another request\'s turn: each end goes to its own asker', async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-qa-interleave-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const cliFor = (id: string) => {
    const file = path.join(home, `${id}.received`);
    // writeNodeCli: the script itself on macOS and Linux, npm's shim beside it on Windows.
    const cli = writeNodeCli(path.join(home, `${id}-cli.cjs`), [
      "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
      `process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(file)}, d));`,
      "process.stdout.write('stand-in ready\\n');",
      '',
    ].join('\n'));
    return { cli, file };
  };
  const stand = { w1: cliFor('w1'), o1: cliFor('o1'), b1: cliFor('b1') };
  const agent = (id: 'w1' | 'o1' | 'b1', name: string) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], cliPath: stand[id].cli,
    createdAt: '2026-10-07T08:00:00.000Z', lastActivity: '2026-10-07T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('w1', 'Worker'), agent('o1', 'Lead'), agent('b1', 'Bot')], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const port = apiPort(31457);
  const dist = path.resolve('electron', 'dist');
  const read = (id: keyof typeof stand) => (fs.existsSync(stand[id].file) ? fs.readFileSync(stand[id].file, 'utf8') : '');
  const told = (id: keyof typeof stand) => read(id).split('Worker').length - 1;
  const steps: Record<string, unknown> = {};

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
    const start = async (id: string) => {
      await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), id);
      await expect.poll(async () => (await list()).find(a => a.id === id)?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
    };
    for (const id of ['w1', 'o1', 'b1']) await start(id);
    const tokens = await app.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      const { agents } = req(`${dist}/core/agent-manager.js`);
      const out: Record<string, string> = {};
      for (const id of ['w1', 'o1', 'b1']) {
        const a = agents.get(id);
        a.sessionRegisteredAt = new Date().toISOString();
        a.status = 'idle';
        out[id] = req(`${dist}/core/agent-tokens.js`).mintAgentToken(id);
      }
      return out;
    }, { dist });
    const worker = () => app.evaluate((_e, { dist }) => {
      const w = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get('w1');
      return { requestedBy: w.requestedBy ?? null, queue: (w.taskQueue ?? []).map((r: { ref: string; requesterAgentId: string; state: string }) => [r.ref, r.requesterAgentId, r.state]), status: w.status, workHandedAt: w.workHandedAt ?? null, lastTurnStartedAt: w.lastTurnStartedAt ?? null };
    }, { dist });
    const api = (route: string, as: string, body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[as]}`, 'X-Tars-Caller-Id': as },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }).then(async r => ({ status: r.status, body: await r.json() as Record<string, unknown> }));
    const session = 'e2e00000-0000-4000-8000-0000000000aa';
    const hook = (body: Record<string, unknown>) => api('/api/hooks/status', 'w1', { agent_id: 'w1', session_id: session, ...body });
    await hook({ status: 'idle', source: 'startup' });
    const lineOf = (who: string) => read('w1').split(/\r|\n|\x1b\[20[01]~/).find(l => l.startsWith(`Message from agent "${who}"`)) ?? '';

    // 1. A, typed into the idle worker; its turn starts.
    const a = await api('/api/agents/w1/message', 'o1', { message: 'TASK-A review #280' });
    await expect.poll(() => read('w1').includes('TASK-A'), { timeout: 20_000 }).toBe(true);
    await hook({ status: 'running', event: 'UserPromptSubmit', current_task: `${lineOf('Lead')}` });
    steps.turnA = { a, line: lineOf('Lead'), worker: await worker() };

    // 2. B, typed in during turn A.
    await new Promise(r => setTimeout(r, 1100));
    const b = await api('/api/agents/w1/message', 'b1', { message: 'TASK-B write the release notes' });
    await expect.poll(() => read('w1').includes('TASK-B'), { timeout: 20_000 }).toBe(true);
    steps.bDuringA = { b, line: lineOf('Bot'), worker: await worker() };

    // 3. Turn A ends.
    await hook({ status: 'idle', hook: 'Stop' });
    let leadToldOfA = false;
    try { await expect.poll(() => told('o1'), { timeout: 15_000 }).toBeGreaterThan(0); leadToldOfA = true; } catch { /* recorded below */ }
    steps.afterA = { leadToldOfA, o1: read('o1'), b1: read('b1'), worker: await worker() };

    // 4. Turn B runs and ends.
    await hook({ status: 'running', event: 'UserPromptSubmit', current_task: `${lineOf('Bot')}` });
    await hook({ status: 'idle', hook: 'Stop' });
    await expect.poll(() => told('b1'), { timeout: 20_000 }).toBeGreaterThan(0);
    steps.afterB = { o1: read('o1'), b1: read('b1'), worker: await worker() };

    // 5. Noah's own turn.
    await new Promise(r => setTimeout(r, 1100));
    await hook({ status: 'running', event: 'UserPromptSubmit', current_task: 'what does this function return' });
    await hook({ status: 'idle', hook: 'Stop' });
    await new Promise(r => setTimeout(r, 8000));
    steps.afterNoah = { leadTold: told('o1'), botTold: told('b1'), o1: read('o1'), worker: await worker() };

    recordValues({ steps, received: { w1: read('w1'), o1: read('o1'), b1: read('b1') } });
    expect(leadToldOfA, 'Lead is told when turn A ends').toBe(true);
    expect(told('o1'), 'Lead is told once, of A, and not of Noah\'s turn').toBe(1);
    expect(told('b1'), 'Bot is told once, of B, and not of Noah\'s turn').toBe(1);
    expect((await worker()).queue, 'nothing left queued').toEqual([]);
  } finally {
    await app.close().catch(() => {});
    await removeHome(home);
  }
});
