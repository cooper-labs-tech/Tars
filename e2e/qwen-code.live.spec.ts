import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The real Qwen Code, once (2.0.4): QWEN_LIVE=1 only, as it spends a few tokens of the maintainer's DeepSeek account.
 * Measured with qwen 0.25.2 on deepseek-v4-flash.
 *
 * The real app on a sandbox HOME, whose ~/.qwen/settings.json is a copy of the user's (its model providers and the
 * key its env holds: the file is made 0600 and removed with the sandbox; nothing of it is printed or recorded). lead,
 * the orchestrator, is a claude agent whose terminal records what it receives, spoken for through the real
 * orchestrator MCP server. Asserted:
 * 1. lead's create_agent makes a qwen-code agent on deepseek-v4-flash;
 * 2. lead's delegate_task starts its session and returns its real answer, read from its transcript, with tokens and cost;
 * 3. a second task has it call send_message through Tars's MCP server with its own identity: lead's terminal
 *    receives it from that agent, by its name and id.
 * Run: QWEN_LIVE=1 E2E_TRACE=on npx playwright test e2e/qwen-code.live.spec.ts --project=
 */

const QWEN = process.env.QWEN_BIN || path.join(os.homedir(), '.local', 'bin', 'qwen');
const USER_QWEN_SETTINGS = path.join(os.homedir(), '.qwen', 'settings.json');

type ToolAnswer = { text: string; isError: boolean };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Array<{ id: string; name: string; cliRunning?: boolean }>> } } };

function mcpAs(home: string, project: string, port: string, agentId: string, token: string, instance: string) {
  const mcp: ChildProcessWithoutNullStreams = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
    env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: token, CLAUDE_AGENT_ID: agentId, CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: instance },
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
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const ready = (async () => {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  })();
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolAnswer> => {
    await ready;
    const reply = await rpc('tools/call', { name, arguments: args });
    return { text: reply.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
  };
  return { call, kill: () => mcp.kill() };
}

test.skip(process.env.QWEN_LIVE !== '1', 'the real Qwen Code: QWEN_LIVE=1');

test('the real qwen code: created by an orchestrator, it answers a delegated task and reports back with its own identity', async () => {
  test.setTimeout(600_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-qwen-live-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir, path.join(home, '.qwen')]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(USER_QWEN_SETTINGS, path.join(home, '.qwen', 'settings.json'));
  fs.chmodSync(path.join(home, '.qwen', 'settings.json'), 0o600);
  const leadReceived = path.join(home, 'lead.received');
  const leadCli = path.join(home, 'lead-cli.cjs');
  fs.writeFileSync(leadCli, [`#!${process.execPath}`, "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
    `process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(leadReceived)}, d));`, "process.stdout.write('lead ready\\n');", ''].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'lead', name: 'Project Lead', character: 'robot', provider: 'claude', status: 'idle', role: 'orchestrator', projectPath: project, skills: [],
    permissionMode: 'bypass', cliPath: leadCli, createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { qwencode: QWEN, additionalPaths: [] } }));
  // The registration a packaged Tars makes (a dev run finds no bundle under its resources).
  fs.mkdirSync(path.join(dir, 'qwen-code'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'qwen-code', 'mcp-servers.json'), JSON.stringify({ 'claude-mgr-orchestrator': { command: process.execPath, args: [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')] } }));
  const port = apiPort(31413);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = { home, qwen: QWEN };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app: ElectronApplication = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
  let lead: ReturnType<typeof mcpAs> | undefined;
  try {
    const page: Page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'lead', prompt: '' }));
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).find((a) => a.id === 'lead')?.cliRunning ?? false, { timeout: 30_000 }).toBe(true);
    const ids = await app.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      const l = req(`${dist}/core/agent-manager.js`).agents.get('lead');
      l.sessionRegisteredAt = new Date().toISOString();
      l.status = 'idle';
      const tokens = req(`${dist}/core/agent-tokens.js`);
      return { lead: tokens.mintRunToken('lead').token as string, instance: tokens.tarsInstanceId() as string };
    }, { dist });
    lead = mcpAs(home, project, port, 'lead', ids.lead, ids.instance);

    // 1. Made by the orchestrator.
    const created = await lead.call('create_agent', { name: 'Qwen Live', provider: 'qwen-code', model: 'deepseek-v4-flash', permissionMode: 'bypass', effort: 'low', projectPath: project });
    const qw = (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).find((a) => a.name === 'Qwen Live');
    keep({ created, qw });
    expect(created.isError, created.text).toBe(false);
    expect(qw).toBeDefined();

    // 2. A task delegated to it, its real answer back.
    const one = await lead.call('delegate_task', { id: qw!.id, prompt: 'Reply with exactly the text QWEN-LIVE-OK and nothing else. Use no tool.', timeoutSeconds: 300 });
    keep({ one });
    expect.soft(one.isError, one.text).toBe(false);
    expect.soft(one.text).toContain('QWEN-LIVE-OK');
    expect.soft(one.text).toContain('ended: end_turn');
    expect.soft(one.text).toMatch(/\d+ tokens \| \$\d/);

    // 3. A report back through Tars's MCP server, with its own identity.
    const two = await lead.call('delegate_task', {
      id: qw!.id, timeoutSeconds: 300,
      prompt: 'Call the tool send_message of the MCP server claude-mgr-orchestrator once, with id "requester" and message "QWEN-LIVE-REPORT". Then reply with the single word DONE.',
    });
    await expect.poll(() => (fs.existsSync(leadReceived) ? fs.readFileSync(leadReceived, 'utf8') : ''), { timeout: 60_000 }).toContain('QWEN-LIVE-REPORT');
    // Since #507 the sender line and the body are two pastes into one field: the markers go before the lines are cut.
    const leadLine = fs.readFileSync(leadReceived, 'utf8').replace(/\x1b\[20[01]~/g, '').split(/\r|\n/).find((l) => l.includes('QWEN-LIVE-REPORT')) ?? '';
    keep({ two, leadLine });
    expect.soft(two.isError, two.text).toBe(false);
    expect.soft(leadLine).toContain(`Message from agent "Qwen Live" ("${qw!.id}")`);
  } finally {
    lead?.kill();
    await app.close().catch(() => undefined);
    await removeHome(home);
  }
});
