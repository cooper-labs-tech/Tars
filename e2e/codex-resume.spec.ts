import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A codex agent is permanent too (2.0.4): after Tars restarts, it resumes its own codex session, as a claude agent
 * resumes its conversation. Measured on codex-cli 0.163.0: `codex resume <id>` continues the session in its own
 * rollout, with its conversation, and writes a line to it at once; a codex started with no prompt writes no rollout
 * before its first turn.
 *
 * codex is e2e/fake-codex.mjs, which does both as measured. Lead, the project's orchestrator, works through the real
 * mcp-orchestrator with its own identity. Asserted:
 * 1. Cody, created on codex, answers a first task, and Tars keeps his codex session as the one to resume;
 * 2. Tars quits and starts again on the same home, and the window starts Cody as Start or autostart does: his codex
 *    is `codex resume <that session>`, typed into his new terminal, and Tars follows that session again;
 * 3. a task delegated after the restart is answered in that same session, which still remembers the task before the
 *    restart (RECALL reads it back from the session), in the same rollout;
 * 4. at rest for 40 minutes, Cody is put to sleep by the minute's pass, as a claude agent is, and a task wakes him on
 *    that same session again.
 * The artefact: values.json (each launch's argv, the sessions, the answers) and the screenshots.
 */

const LEAD = 'dddd4444-0000-4000-8000-0000000000d4';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Reply = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Array<{ id: string; cliRunning?: boolean }>> } } };

test(`a codex agent resumes its own session after Tars restarts`, async () => {
  test.setTimeout(4 * 60_000);
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-codex-resume-');
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin, path.join(home, '.codex')]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', project]);

  const codexLog = path.join(home, 'codex.jsonl');
  const codex = path.join(bin, 'codex');
  fs.writeFileSync(codex, `#!${process.execPath}\nprocess.env.FAKE_CODEX_LOG = ${JSON.stringify(codexLog)};\nimport(${JSON.stringify(path.resolve('e2e', 'fake-codex.mjs'))});\n`, { mode: 0o755 });
  const entries = () => (fs.existsSync(codexLog) ? fs.readFileSync(codexLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<Record<string, unknown>>;
  const rollouts = () => {
    const found: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else found.push(e.name);
      }
    };
    walk(path.join(home, '.codex', 'sessions'));
    return found.filter(n => n.endsWith('.jsonl'));
  };

  const lead = { id: LEAD, name: 'Lead', character: 'robot', provider: 'claude', status: 'idle', role: 'orchestrator', permissionMode: 'normal', projectPath: project, skills: [], createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z' };
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([lead], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { codex } }, null, 2));

  const port = apiPort(31321);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const servers: ChildProcessWithoutNullStreams[] = [];
  let app: ElectronApplication | undefined;

  /** Tars started on this home, and Lead's tools through the real mcp-orchestrator, with Lead's own identity. */
  const startTars = async (run: number) => {
    app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
    const appLog = test.info().outputPath(`app-${run}.log`);
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(1, { timeout: 30_000 });
    const identity = await app.evaluate((_e, { dist, lead }) => {
      const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
      return { token: tokens.mintRunToken(lead).token as string, instance: tokens.tarsInstanceId() as string };
    }, { dist, lead: LEAD });
    const mcp = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
      env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: identity.token, CLAUDE_AGENT_ID: LEAD, CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: identity.instance },
    });
    servers.push(mcp);
    const replies = new Map<number, (msg: Reply) => void>();
    let buffered = '';
    mcp.stdout.on('data', (chunk) => {
      buffered += chunk;
      for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
        const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (typeof msg.id === 'number') replies.get(msg.id)?.(msg);
      }
    });
    mcp.on('exit', () => { for (const [, r] of replies) r({ error: 'mcp-orchestrator exited' }); replies.clear(); });
    let nextId = 1;
    const rpc = (method: string, params: unknown) => new Promise<Reply>((resolve) => { const id = nextId++; replies.set(id, resolve); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tool = async (name: string, args: Record<string, unknown>) => {
      const reply = await Promise.race([rpc('tools/call', { name, arguments: args }), sleep(90_000).then(() => ({ error: `${name} gave no answer in 90 s` }) as Reply)]);
      return { tool: name, args, text: reply.result?.content?.map(c => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
    };
    return { page, tool };
  };
  const cody = (id: string) => app!.evaluate((_e, { dist, id }) => {
    const a = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get(id);
    return { status: a?.status as string | undefined, currentSessionId: a?.currentSessionId as string | undefined, resumableSessionId: a?.resumableSessionId as string | undefined };
  }, { dist, id });

  try {
    const nonce = randomBytes(4).toString('hex');
    // 1. Cody's first task, before the restart.
    const first = await startTars(1);
    const made = await first.tool('create_agent', { name: 'Cody', provider: 'codex', projectPath: project, model: 'gpt-6-luna', effort: 'low', permissionMode: 'auto' });
    const codyId = made.text.match(/with ID: ([0-9a-f-]{36})/)?.[1] ?? '';
    expect(codyId, made.text).toBeTruthy();
    const before = await first.tool('delegate_task', { id: codyId, prompt: `ECHO r${nonce}`, timeoutSeconds: 60 });
    const session = (await cody(codyId)).resumableSessionId;
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')).find((a: { id: string }) => a.id === codyId)?.resumableSessionId, { timeout: 10_000 }).toBe(session).catch(() => {});
    keep({ before, session, rolloutsBefore: rollouts() });
    expect.soft(before.text, "Cody's first answer").toContain(`echo r${nonce}`);
    expect(session, 'no codex session kept to resume').toMatch(/^[0-9a-f-]{36}$/);
    await stepShot(first.page, 'before-restart-new-interface');

    // 2. Tars quits, and starts again on the same home.
    const launchedBefore = entries().filter(e => e.launch).length;
    for (const server of servers.splice(0)) server.kill();
    await app!.close();
    app = undefined;
    const second = await startTars(2);
    await second.page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), codyId);
    await expect.poll(async () => (await second.page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).find(a => a.id === codyId)?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
    await expect.poll(() => entries().filter(e => e.launch).length, { timeout: 15_000 }).toBeGreaterThan(launchedBefore).catch(() => {});
    const launches = entries().filter(e => e.launch);
    const resumedLaunch = launches.length > launchedBefore ? launches.at(-1)?.argv as string[] | undefined : undefined;
    await expect.poll(async () => (await cody(codyId)).currentSessionId, { timeout: 20_000 }).toBe(session).catch(() => {});
    const afterStart = await cody(codyId);
    keep({ launches: launches.map(l => l.argv), afterStart });
    expect.soft(resumedLaunch?.slice(0, 1), "Cody's codex after the restart").toEqual(['resume']);
    expect.soft(resumedLaunch ?? [], 'the session it resumes').toContain(session);
    expect.soft(afterStart.currentSessionId, 'Tars does not follow the resumed session').toBe(session);

    // 3. A task after the restart, in the same conversation.
    const after = await second.tool('delegate_task', { id: codyId, prompt: 'RECALL', timeoutSeconds: 60 });
    const recall = entries().filter(e => e.turn && (String(e.head ?? '') + String(e.text)).includes('RECALL')).at(-1);
    keep({ after, recall, rolloutsAfter: rollouts() });
    expect.soft(after.text, "the task after the restart, in Cody's same conversation").toContain(`recall r${nonce}`);
    expect.soft(recall?.session, 'the session the task ran in').toBe(session);
    expect.soft(rollouts(), 'one rollout, the same').toEqual(values.rolloutsBefore as string[]);
    await stepShot(second.page, 'after-restart-new-interface');

    // 4. Asleep after 40 minutes at rest, and woken by a task on the same session.
    const passes: unknown[] = [];
    await expect.poll(async () => {
      const outcome = await app!.evaluate(async (_e, { dist }) => {
        const req = process.mainModule!.require;
        const fortyMinutesAgo = new Date(Date.now() - 40 * 60_000).toISOString();
        for (const a of req(`${dist}/core/agent-manager.js`).agents.values()) {
          a.statusSince = fortyMinutesAgo;
          a.lastTurnStartedAt = undefined;
          a.workHandedAt = undefined;
        }
        return req(`${dist}/services/agent-sleep.js`).checkSleep() as Promise<Array<{ agentId: string; slept: boolean; why?: string }>>;
      }, { dist });
      passes.push(outcome);
      return outcome.some(o => o.agentId === codyId && o.slept);
    }, { timeout: 30_000, intervals: [1000] }).toBe(true).catch(() => {});
    const asleep = await cody(codyId);
    const launchedAsleep = entries().filter(e => e.launch).length;
    const woken = await second.tool('delegate_task', { id: codyId, prompt: 'RECALL', timeoutSeconds: 60 });
    keep({ passes, asleep, woken, launchesAfterWake: entries().filter(e => e.launch).map(l => l.argv), rolloutsAfterWake: rollouts() });
    expect.soft(asleep.status, 'Cody put to sleep at rest').toBe('asleep');
    const wake = entries().filter(e => e.launch);
    expect.soft(wake.length > launchedAsleep ? wake.at(-1)?.argv as string[] : [], 'his codex once woken').toEqual(expect.arrayContaining(['resume', session]));
    expect.soft(woken.text, 'the task that woke him, in his same conversation').toContain(`recall r${nonce}`);
    expect.soft(rollouts(), 'still one rollout').toEqual(values.rolloutsBefore as string[]);
    keep({ entries: entries() });
  } finally {
    for (const server of servers) server.kill();
    await app?.close();
    await sleep(500);
    await removeHome(home);
  }
});
