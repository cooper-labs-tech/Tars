import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { writeFakeClis } from './fake-clis.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A task delegated to a gemini agent the moment it is started again goes in once gemini's field is drawn, and is not
 * lost (#641).
 *
 * Measured on gemini 0.70.0 (the harness conformance of 24/11): Tars took a gemini for up 300 ms after its exec, typed
 * the task of a delegation into it then, and gemini, still drawing its screen, lost it; delegate_task waited on a turn
 * that never began. #641 reads gemini up once its field is on the screen (GeminiProvider.upOnScreen), as the terminal
 * mirror renders the rows drawn since the launch.
 *
 * The real app on a sandbox HOME, and the real orchestrator MCP server with the identity Tars hands agent `lead`. Agent
 * `gem` is a gemini agent whose CLI is e2e/fake-clis.mjs's gemini, with FAKE_GEMINI_FIELD_AFTER_MS: it draws gemini
 * 0.70.0's field 4 s after its exec, and loses what is typed before it, as gemini does. gem is started from the window,
 * then restarted (resumed where Tars resumes gemini, #636), and lead delegates a task to it right after the restart.
 *
 * Asserted:
 * 1. the task is answered, with the stand-in's own answer;
 * 2. nothing typed into the restarted gemini was lost, and its one turn is the task's, begun after its field was drawn.
 * Red with upOnScreen answering up at once (the mutant of the PR's evidence): the task is typed at the exec, lost, and
 * the delegation is never answered.
 * The artefact: values.json (the answer, the stand-in's log, the restart's launch line), the stand-in's log, the trace.
 */

type Agent = { id: string; status: string; cliRunning?: boolean; currentSessionId?: string };
type Api = { electronAPI: { agent: {
  start(p: { id: string; prompt: string }): Promise<unknown>;
  restart(id: string): Promise<unknown>;
  get(id: string): Promise<Agent | null>;
} } };

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('a task delegated right after a gemini agent restarts goes in once its field is drawn, and is not lost', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-gemini-field-late-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  const fakes = writeFakeClis(home, ['gemini'], { geminiFieldAfterMs: 4000 });
  const agent = (id: string, name: string, role: string, provider: string) => ({
    id, name, character: 'robot', provider, status: 'idle', role, projectPath: project, skills: [], permissionMode: 'bypass',
    ...(provider === 'gemini' ? { cliPath: fakes.gemini } : {}), createdAt: '2026-11-24T08:00:00.000Z', lastActivity: '2026-11-24T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'Project Lead', 'orchestrator', 'claude'), agent('gem', 'Gemini Agent', 'worker', 'gemini')], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { additionalPaths: [path.dirname(fakes.gemini)], gemini: fakes.gemini }, geminiEnabled: true,
  }));
  const port = apiPort(31381);
  const dist = path.resolve('electron', 'dist');
  const log = path.join(home, 'fake-cli.jsonl');
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  let mcp: ChildProcessWithoutNullStreams | undefined;
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const get = async (id: string) => (await page.evaluate((i) => (window as unknown as Api).electronAPI.agent.get(i), id))!;
    const launches = () => lines(log).filter((e) => e.launch === true);

    // gem's first start, from the window, until its field is drawn.
    await expect.poll(() => fs.existsSync(path.join(home, '.gemini', 'settings.json')), { timeout: 30_000, message: 'Tars wrote gemini\'s hooks' }).toBe(true);
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'gem', prompt: '' }));
    await expect.poll(async () => { const a = await get('gem'); return !!(a.cliRunning && a.currentSessionId); }, { timeout: 60_000, message: 'gem\'s session registered' }).toBe(true);
    await expect.poll(() => lines(log).filter((e) => e.field === 'drawn').length, { timeout: 30_000, message: 'the first start drew its field' }).toBe(1);

    const identity = await app.evaluate((_e, { dist }) => {
      const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
      return { token: tokens.mintRunToken('lead').token as string, instance: tokens.tarsInstanceId() as string };
    }, { dist });
    mcp = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
      env: {
        PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: identity.token,
        CLAUDE_AGENT_ID: 'lead', CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: identity.instance,
      },
    });
    const replies = new Map<number, (msg: { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown }) => void>();
    let buffered = '';
    mcp.stdout.on('data', (chunk) => {
      buffered += chunk;
      for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (typeof msg.id === 'number') replies.get(msg.id)?.(msg);
      }
    });
    let nextId = 1;
    const rpc = (method: string, params: unknown) => new Promise<Parameters<NonNullable<ReturnType<typeof replies.get>>>[0]>((resolve) => {
      const id = nextId++;
      replies.set(id, resolve);
      mcp!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const tool = async (name: string, args: Record<string, unknown>) => {
      const reply = await rpc('tools/call', { name, arguments: args });
      return { text: reply.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
    };
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    // gem started again, and a task delegated to it at once.
    const before = lines(log).length;
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.restart('gem'));
    await expect.poll(() => launches().length, { timeout: 30_000, message: 'gem\'s CLI started again' }).toBe(2);
    const task = await tool('delegate_task', { id: 'gem', prompt: 'FIELD-LATE ECHO field-late-42', timeoutSeconds: 45, clientRequestId: 'e2e-gemini-field-late' });
    const after = lines(log).slice(before);
    keep({ task, restartLine: launches()[1]?.argv, afterRestart: after });

    // 1. Answered.
    expect.soft(task.isError, task.text.slice(0, 400)).toBe(false);
    expect.soft(task.text).toContain('echo field-late-42');
    // 2. Nothing lost, and the task's turn after the field.
    expect.soft(after.filter((e) => e.lost !== undefined), 'nothing typed before the field was drawn').toEqual([]);
    // The stand-in logs what was typed by its head and a turn by its last 600 characters, where Tars's own lines
    // follow the task: the task is found by the head of what was typed, its turn as the turn that follows it.
    const drawn = after.findIndex((e) => e.field === 'drawn');
    const typed = after.findIndex((e) => typeof e.head === 'string' && e.head.includes('FIELD-LATE'));
    const turn = after.findIndex((e, i) => i > typed && e.turn === true);
    expect.soft(drawn, 'the restarted gemini drew its field').toBeGreaterThanOrEqual(0);
    expect.soft(typed, 'the task was typed after the field was drawn').toBeGreaterThan(drawn);
    expect.soft(turn, 'the task\'s turn began after it was typed').toBeGreaterThan(typed);
  } finally {
    mcp?.kill();
    await app.close();
    if (fs.existsSync(log)) fs.copyFileSync(log, test.info().outputPath('fake-cli.jsonl'));
    await removeHome(home);
  }
});
