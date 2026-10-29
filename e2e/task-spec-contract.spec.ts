import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A contract for a task's spec (2.0.5, taken from Orca): an orchestrator writes every task it hands as five parts,
 * Target, Change, Constraints, May touch and Proof, the last being the observable check of acceptance. Taught where
 * an orchestrator reads how to delegate: delegate_task's own description and its prompt field, the guide's
 * delegation topic, and the short section of its identity.
 *
 * The real app on a sandbox HOME, and the real orchestrator MCP server (mcp-orchestrator/dist/bundle.js) run with
 * the identity Tars hands agent `lead`, spoken to over stdio as Claude Code speaks to it.
 * Asserted, once with the classic shell and once with the new interface, that each of the five parts is named in:
 * 1. delegate_task's description, and its prompt field's, in tools/list;
 * 2. tars_guide's delegation topic;
 * 3. the orchestrator's bootstrap (its identity's "How Tars works" section).
 * Red on main (acb8d2f4): none of them names a part.
 * The artefact: values.json (the three texts as read).
 */

const PARTS = ['Target', 'Change', 'Constraints', 'May touch', 'Proof'];
const missing = (text: string) => PARTS.filter((p) => !text.includes(`${p}:`) && !text.includes(`${p} (`));

for (const newInterface of [false, true]) {
  test(`an orchestrator is taught a task's spec: target, change, constraints, may touch, proof${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-task-spec-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
    const agent = (id: string, name: string, role: string) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, projectPath: project, skills: [], permissionMode: 'normal',
      createdAt: '2026-10-22T08:00:00.000Z', lastActivity: '2026-10-22T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'Project Lead', 'orchestrator'), agent('w', 'Writer', 'worker')]));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const port = apiPort(newInterface ? 31511 : 31510);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { newInterface, home };

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    let mcp: ChildProcessWithoutNullStreams | undefined;
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
      const identity = await app.evaluate((_e, { dist }) => {
        const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
        return { lead: tokens.mintRunToken('lead').token as string, instance: tokens.tarsInstanceId() as string };
      }, { dist });
      mcp = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
        env: {
          PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: identity.lead,
          CLAUDE_AGENT_ID: 'lead', CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: identity.instance,
        },
      });
      const replies = new Map<number, (msg: Record<string, unknown>) => void>();
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
      const rpc = (method: string, params: unknown) => new Promise<Record<string, unknown>>((resolve) => {
        const id = nextId++;
        replies.set(id, resolve);
        mcp!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

      // 1. delegate_task, as a CLI lists it.
      const listed = (await rpc('tools/list', {})).result as { tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }> };
      const delegate = listed.tools.find((t) => t.name === 'delegate_task')!;
      const description = delegate.description;
      const promptField = delegate.inputSchema.properties.prompt.description ?? '';
      // 2. The guide's delegation topic.
      const topic = ((await rpc('tools/call', { name: 'tars_guide', arguments: { topic: 'delegation' } })).result as { content: Array<{ text: string }> }).content.map((c) => c.text).join('\n');
      // 3. The orchestrator's identity.
      const r = await fetch(`http://127.0.0.1:${port}/api/agents/lead/bootstrap`, { headers: { Authorization: `Bearer ${identity.lead}`, 'X-Tars-Caller-Id': 'lead' } });
      const bootstrap = ((await r.json()) as { context?: string }).context ?? '';
      Object.assign(values, { description, promptField, topic, bootstrap });
      recordValues(values);

      expect(missing(description), 'delegate_task description').toEqual([]);
      expect(missing(promptField), 'delegate_task prompt field').toEqual([]);
      expect(missing(topic), 'tars_guide delegation').toEqual([]);
      expect(missing(bootstrap), 'orchestrator bootstrap').toEqual([]);
    } finally {
      recordValues(values);
      mcp?.kill();
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
