import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Codex starts and talks in Tars (2.0.4). JeanBrasse's principle: Tars is not built around Claude Code only.
 *
 * Measured on 2026-10-18 with codex-cli 0.163.0 (standalone install, ChatGPT account): Tars passed `--full-auto`,
 * which 0.163 refuses, so every codex agent in auto or bypass died at launch; its model list offered models a ChatGPT
 * account cannot use; its effort never reached codex; the Tars MCP server inside codex had no agent identity; an
 * approval codex waits on in normal mode was invisible; and Tars never saw a codex turn end.
 *
 * Here codex is e2e/fake-codex.mjs, a stand-in that reads its arguments, writes its session log, asks its approvals
 * and starts its MCP servers the way codex 0.163 does (measured, each said in its header). Lead, the project's
 * orchestrator, works through the real mcp-orchestrator over stdio with its own identity. Claire is a claude worker
 * whose terminal records what is typed into it. Asserted:
 * 1. Cody, created in auto at low effort on gpt-6-luna, starts (`--approve-for-me`, not `--full-auto`), with the model
 *    and `-c model_reasoning_effort=low`, and its answer comes back to Lead's wait_for_agent: the turn's end is read
 *    from codex's session log;
 * 2. the window's model list for codex is the account's, from codex's own cache, hidden ones left out;
 * 3. Cody's send_message to Claire goes through the Tars MCP server inside codex with Cody's own identity: Claire's
 *    terminal gets it from "Cody";
 * 4. Nora, in normal mode, waits on codex's approval dialog: her status says she waits on a permission, then her
 *    answer comes back once it is answered; and before her call of a Tars tool, on the form codex 0.163 draws for
 *    it (measured with a probe server), named in her status, then her message reaches Claire once it is allowed;
 * 5. Mini, on gpt-5-codex-mini, fails with codex's own words, and Lead is told so;
 * 6. delegate_task to Cody gets its answer, read from codex's session log; a turn interrupted with Esc in Cody's
 *    terminal (codex logs it turn_aborted) ends that task as interrupted, and Cody's next task is not held behind it.
 * The artefact: values.json (each tool's answer, each launch's argv and effort, Claire's typed bytes, the
 * statuses seen) and the screenshot.
 */

const LEAD = 'dddd4444-0000-4000-8000-0000000000d4';
const CLAIRE = 'cccc3333-0000-4000-8000-0000000000c1';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Reply = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Array<{ id: string; cliRunning?: boolean }>> }; models: { list(provider: string): Promise<{ models: Array<{ id: string }> }> } } };

const CACHE = {
  fetched_at: new Date().toISOString(), client_version: '0.163.0',
  models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.', visibility: 'list', priority: 1, default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({ effort })) },
    { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.', visibility: 'list', priority: 4, default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({ effort })) },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', description: '', visibility: 'hide', priority: 43, supported_reasoning_levels: [{ effort: 'medium' }] },
  ],
};

test(`a codex agent starts, answers, asks and talks to a claude agent`, async () => {
  test.setTimeout(4 * 60_000);
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-codex-works-');
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin, path.join(home, '.codex')]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  fs.writeFileSync(path.join(home, '.codex', 'models_cache.json'), JSON.stringify(CACHE));

  const codexLog = path.join(home, 'codex.jsonl');
  const codex = path.join(bin, 'codex');
  fs.writeFileSync(codex, `#!${process.execPath}\nprocess.env.FAKE_CODEX_LOG = ${JSON.stringify(codexLog)};\nimport(${JSON.stringify(path.resolve('e2e', 'fake-codex.mjs'))});\n`, { mode: 0o755 });
  const claireTyped = path.join(home, 'claire.typed');
  const claude = path.join(bin, 'claude');
  fs.writeFileSync(claude, [
    `#!${process.execPath}`,
    "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
    `process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(claireTyped)}, d));`,
    "process.stdout.write('claude stand-in ready\\n');",
    '',
  ].join('\n'), { mode: 0o755 });
  const entries = () => (fs.existsSync(codexLog) ? fs.readFileSync(codexLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<Record<string, unknown>>;
  const typedIntoClaire = () => (fs.existsSync(claireTyped) ? fs.readFileSync(claireTyped, 'utf8') : '');

  const agent = (id: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role, permissionMode: 'normal', projectPath: project, skills: [],
    createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z', ...extra,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent(LEAD, 'Lead', 'orchestrator'), agent(CLAIRE, 'Claire', 'worker', { cliPath: claude })], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { codex } }, null, 2));

  const port = apiPort(31311);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const servers: ChildProcessWithoutNullStreams[] = [];
  let app: ElectronApplication | undefined;
  try {
    app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
    // The main process's own log, in the artefact: what the hook routes and the codex watch said.
    const appLog = test.info().outputPath('app.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(1, { timeout: 30_000 });

    // Claire's terminal, started by the window, at rest.
    await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), CLAIRE);
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).find(a => a.id === CLAIRE)?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
    const identity = await app.evaluate((_e, { dist, lead, claire }) => {
      const req = process.mainModule!.require;
      const { agents } = req(`${dist}/core/agent-manager.js`);
      const c = agents.get(claire);
      c.status = 'idle';
      c.sessionRegisteredAt = new Date().toISOString();
      const tokens = req(`${dist}/core/agent-tokens.js`);
      return { token: tokens.mintRunToken(lead).token as string, instance: tokens.tarsInstanceId() as string, claire: tokens.mintAgentToken(claire) as string };
    }, { dist, lead: LEAD, claire: CLAIRE });
    // Its session, as Claude Code's SessionStart hook registers it: the stand-in has no hooks, and a launch whose
    // session never registers is still on its way, which a message waits for.
    const registered = await fetch(`http://127.0.0.1:${port}/api/hooks/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.claire}` },
      body: JSON.stringify({ agent_id: CLAIRE, session_id: 'e2e00000-0000-4000-8000-0000000000c1', status: 'idle', source: 'startup' }),
    }).then(r => r.status);
    expect(registered).toBe(200);

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
    const calls: Array<{ tool: string; args: Record<string, unknown>; text: string; isError: boolean }> = [];
    const lead = async (tool: string, args: Record<string, unknown>) => {
      const reply = await Promise.race([rpc('tools/call', { name: tool, arguments: args }), sleep(120_000).then(() => ({ error: `${tool} gave no answer in 120 s` }) as Reply)]);
      const answer = { tool, args, text: reply.result?.content?.map(c => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
      calls.push(answer);
      keep({ calls });
      return answer;
    };
    const make = async (name: string, extra: Record<string, unknown>) => {
      const made = await lead('create_agent', { name, provider: 'codex', projectPath: project, ...extra });
      return made.text.match(/with ID: ([0-9a-f-]{36})/)?.[1] ?? '';
    };
    const statusOf = (id: string) => app!.evaluate((_e, { dist, id }) => {
      const a = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get(id);
      return { status: a?.status as string | undefined, waitingReason: a?.waitingReason as string | undefined, waitingOn: a?.waitingOn as unknown, error: a?.error as string | undefined, ptyId: a?.ptyId as string | undefined };
    }, { dist, id });

    // Tars's servers in codex's config, written by Tars's own registration (setupMcpOrchestrator, run at every
    // start of a packaged Tars). A development run finds no bundle under process.resourcesPath, the app's: the
    // orchestrator's server is put where a packaged Tars holds it, for that call.
    const resources = path.join(home, 'resources');
    fs.mkdirSync(path.join(resources, 'mcp-orchestrator', 'dist'), { recursive: true });
    fs.copyFileSync(path.resolve('mcp-orchestrator', 'dist', 'bundle.js'), path.join(resources, 'mcp-orchestrator', 'dist', 'bundle.js'));
    // With its package.json, as the app ships it (build.extraResources): the bundle is an ES module.
    fs.copyFileSync(path.resolve('mcp-orchestrator', 'package.json'), path.join(resources, 'mcp-orchestrator', 'package.json'));
    await app.evaluate(async (_e, { dist, resources }) => {
      const was = process.resourcesPath;
      Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true, writable: true });
      try {
        await process.mainModule!.require(`${dist}/services/mcp-orchestrator.js`).setupMcpOrchestrator({});
      } finally {
        Object.defineProperty(process, 'resourcesPath', { value: was, configurable: true, writable: true });
      }
    }, { dist, resources });
    const codexConfig = fs.existsSync(path.join(home, '.codex', 'config.toml')) ? fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8') : '';
    keep({ codexConfig });

    // 2. The account's models, from codex's own cache.
    const models = (await page.evaluate(() => (window as unknown as Api).electronAPI.models.list('codex'))).models.map(m => m.id);
    keep({ models });
    expect.soft(models, "the window's codex models are not the account's").toEqual(['gpt-6.1-sol', 'gpt-6-luna']);

    // 1. Cody starts in auto at low effort, and his answer comes back.
    const nonce = randomBytes(4).toString('hex');
    const cody = await make('Cody', { model: 'gpt-6-luna', effort: 'low', permissionMode: 'auto' });
    expect(cody, 'create_agent made no codex agent').toBeTruthy();
    await lead('send_message', { id: cody, message: `ECHO a${nonce}` });
    const codyFirst = await lead('wait_for_agent', { id: cody, timeoutSeconds: 60 });
    const codyLaunch = entries().find(e => e.launch && Array.isArray(e.argv) && !(e.argv as string[]).includes('--help'));
    keep({ codyLaunch, codyFirst, codyTurns: entries().filter(e => e.turn) });
    expect.soft(codyLaunch?.refused, 'codex refused its arguments at launch').toBeUndefined();
    expect.soft((codyLaunch?.argv as string[] | undefined) ?? [], 'the launch').toEqual(expect.arrayContaining(['--approve-for-me', '--model', 'gpt-6-luna', '-c', 'model_reasoning_effort=low']));
    expect.soft(entries().find(e => e.turn)?.effort, "the effort codex's own log shows").toBe('low');
    expect.soft(codyFirst.text, "Cody's answer never came back").toContain(`echo a${nonce}`);

    // 3. Cody's message to Claire, through the Tars MCP server inside codex, with Cody's own identity.
    await lead('send_message', { id: cody, message: `SEND ${CLAIRE} hello from codex b${nonce}` });
    const codySecond = await lead('wait_for_agent', { id: cody, timeoutSeconds: 60 });
    await expect.poll(typedIntoClaire, { timeout: 20_000 }).toContain(`b${nonce}`).catch(() => {});
    const mcpSeen = entries().filter(e => e.mcp);
    keep({ codySecond, mcpSeen, claireTyped: typedIntoClaire().slice(-1500) });
    expect.soft(mcpSeen.find(e => e.handed)?.token, "the agent's token never reached the Tars server inside codex").toBe(true);
    expect.soft(typedIntoClaire(), "Claire never got Cody's message").toContain(`hello from codex b${nonce}`);
    expect.soft(typedIntoClaire(), 'the message is not from Cody').toContain('"Cody"');

    // 6. delegate_task to Cody, its answer from codex's session log; then a turn interrupted with Esc.
    const codyDelegated = await lead('delegate_task', { id: cody, prompt: `ECHO e${nonce}`, timeoutSeconds: 60 });
    keep({ codyDelegated });
    expect.soft(codyDelegated.text, "delegate_task never got Cody's answer").toContain(`echo e${nonce}`);
    const held = lead('delegate_task', { id: cody, prompt: `HOLD f${nonce}`, timeoutSeconds: 60 });
    await expect.poll(() => entries().some(e => e.turn && String(e.text).includes(`HOLD f${nonce}`)), { timeout: 20_000 }).toBe(true).catch(() => {});
    await app.evaluate((_e, { dist, id }) => {
      const req = process.mainModule!.require;
      const a = req(`${dist}/core/agent-manager.js`).agents.get(id);
      req(`${dist}/core/pty-manager.js`).ptyProcesses.get(a.ptyId)?.write('\x1b');
    }, { dist, id: cody });
    const cut = await held;
    keep({ codyCut: cut, codyAfterCut: await statusOf(cody) });
    expect.soft(cut.text, "Cody's interrupted task is not said interrupted").toContain('interrupted');
    const codyNext = await lead('delegate_task', { id: cody, prompt: `ECHO g${nonce}`, timeoutSeconds: 60 });
    keep({ codyNext });
    expect.soft(codyNext.text, "Cody's next task after the interrupt").toContain(`echo g${nonce}`);

    // 4. Nora, in normal mode, waits on codex's approval, said in her status, then answers once it is answered.
    const nora = await make('Nora', { model: 'gpt-6-luna', permissionMode: 'normal' });
    await lead('send_message', { id: nora, message: `APPROVE c${nonce}` });
    let asked: Awaited<ReturnType<typeof statusOf>> | undefined;
    await expect.poll(async () => { asked = await statusOf(nora); return `${asked.status} ${asked.waitingReason}`; }, { timeout: 30_000 })
      .toBe('waiting permission').catch(() => {});
    keep({ noraAsked: asked });
    expect.soft(`${asked?.status} ${asked?.waitingReason}`, "Nora's approval is not in her status").toBe('waiting permission');
    await stepShot(page, 'approval-new-interface');
    await app.evaluate((_e, { dist, id }) => {
      const req = process.mainModule!.require;
      const a = req(`${dist}/core/agent-manager.js`).agents.get(id);
      req(`${dist}/core/pty-manager.js`).ptyProcesses.get(a.ptyId)?.write('y');
    }, { dist, id: nora });
    // Answered: its turn goes on, and ends. wait_for_agent asked while the status still read the dialog would
    // say it again.
    await expect.poll(async () => (await statusOf(nora)).status, { timeout: 30_000 }).not.toBe('waiting').catch(() => {});
    const noraDone = await lead('wait_for_agent', { id: nora, timeoutSeconds: 60 });
    keep({ noraDone });
    expect.soft(noraDone.text, "Nora's answer never came back after the approval").toContain(`ran echo c${nonce}`);

    // And before each call of a tool: codex's form, said in her status, allowed by an Enter in her terminal. Claire's
    // turn on Cody's message is ended first, as her Stop hook would.
    await fetch(`http://127.0.0.1:${port}/api/hooks/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${identity.claire}` },
      body: JSON.stringify({ agent_id: CLAIRE, session_id: 'e2e00000-0000-4000-8000-0000000000c1', status: 'idle' }),
    });
    await lead('send_message', { id: nora, message: `SEND ${CLAIRE} hello from nora d${nonce}` });
    let askedTool: Awaited<ReturnType<typeof statusOf>> | undefined;
    await expect.poll(async () => { askedTool = await statusOf(nora); return `${askedTool.status} ${askedTool.waitingReason}`; }, { timeout: 30_000 })
      .toBe('waiting permission').catch(() => {});
    keep({ noraAskedTool: askedTool });
    expect.soft(`${askedTool?.status} ${askedTool?.waitingReason}`, "Nora's tool call approval is not in her status").toBe('waiting permission');
    expect.soft((askedTool?.waitingOn as { text?: string } | undefined)?.text, 'what Nora waits on').toBe('Allow the claude-mgr-orchestrator MCP server to run tool "send_message"?');
    await app.evaluate((_e, { dist, id }) => {
      const req = process.mainModule!.require;
      const a = req(`${dist}/core/agent-manager.js`).agents.get(id);
      req(`${dist}/core/pty-manager.js`).ptyProcesses.get(a.ptyId)?.write('\r');
    }, { dist, id: nora });
    await expect.poll(async () => (await statusOf(nora)).status, { timeout: 30_000 }).not.toBe('waiting').catch(() => {});
    const noraSent = await lead('wait_for_agent', { id: nora, timeoutSeconds: 60 });
    await expect.poll(typedIntoClaire, { timeout: 15_000 }).toContain(`hello from nora d${nonce}`).catch(() => {});
    keep({ noraSent, claireTyped: typedIntoClaire().slice(-1500) });
    expect.soft(noraSent.text, "Nora's tool call never went through once allowed").toContain('sent:');
    expect.soft(typedIntoClaire(), "Claire never got Nora's message").toContain(`hello from nora d${nonce}`);
    expect.soft(typedIntoClaire(), 'the message is not from Nora').toContain('"Nora"');

    // 5. Mini, on a model the account cannot use: codex's own words, to Lead.
    const mini = await make('Mini', { model: 'gpt-5-codex-mini', permissionMode: 'auto' });
    await lead('send_message', { id: mini, message: 'hello' });
    const miniDone = await lead('wait_for_agent', { id: mini, timeoutSeconds: 60 });
    const miniStatus = await statusOf(mini);
    keep({ miniDone, miniStatus });
    expect.soft(miniStatus.status, "Mini's failed turn is not an error").toBe('error');
    expect.soft(`${miniDone.text} ${miniStatus.error}`, "codex's own words are lost").toContain('not supported when using Codex with a ChatGPT account');

    await stepShot(page, 'codex-agents-new-interface');
    keep({ entries: entries() });
  } finally {
    for (const server of servers) server.kill();
    await app?.close();
    await sleep(500);
    await removeHome(home);
  }
});
