import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The checkpoint line an agent writes about itself (2.0.5, core/agent-checkpoint.ts): the MCP tool `checkpoint` on
 * the orchestrator server, one line of 120 characters at most, kept with the agent.
 *
 * The real app on a sandbox HOME, and the real orchestrator MCP server (mcp-orchestrator/dist/bundle.js) run with the
 * identity Tars hands worker `w`, spoken to over stdio as Claude Code speaks to it. Asserted, with the classic shell
 * and with the new interface:
 * 1. tools/list has `checkpoint`; a call keeps the line on w, which the window reads (agent:get) with its time, and
 *    is pushed to it on agents:tick, where the card reads its agents;
 * 2. get_agent (MCP) and GET /api/agents, as w's orchestrator reads them, carry it;
 * 3. a line of 121 characters, or of two lines, is refused, and w's line stays as it was;
 * 4. w cannot write the orchestrator's line: POST /api/agents/lead/checkpoint with w's token is a 403.
 * Red on main (acb8d2f4): no such tool, and no line anywhere.
 * The artefact: values.json (every answer read).
 */

for (const newInterface of [false, true]) {
  test(`an agent writes its checkpoint line, which the window and the orchestrator read${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-checkpoint-'));
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
    const port = apiPort(newInterface ? 31513 : 31512);
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
        return { lead: tokens.mintRunToken('lead').token as string, w: tokens.mintRunToken('w').token as string, instance: tokens.tarsInstanceId() as string };
      }, { dist });
      mcp = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
        env: {
          PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: identity.w,
          CLAUDE_AGENT_ID: 'w', CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: identity.instance,
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
      const tool = async (name: string, args: Record<string, unknown>) => {
        const reply = await rpc('tools/call', { name, arguments: args });
        const result = reply.result as { content?: Array<{ text?: string }>; isError?: boolean } | undefined;
        return { text: result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!result?.isError || !!reply.error };
      };
      const windowSees = () => page.evaluate(async () => ((await (window as unknown as { electronAPI: { agent: { get(id: string): Promise<{ checkpoint?: { line: string; at: string } } | null> } } }).electronAPI.agent.get('w'))?.checkpoint) ?? null);

      // 1.
      await page.evaluate(() => {
        const g = window as unknown as { __ticks: unknown[]; electronAPI: { agent: { onTick(cb: (a: Array<{ id: string; checkpoint?: unknown }>) => void): void } } };
        g.__ticks = [];
        g.electronAPI.agent.onTick((list) => { const w = list.find((a) => a.id === 'w'); if (w?.checkpoint) g.__ticks.push(w.checkpoint); });
      });
      const listed = ((await rpc('tools/list', {})).result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      values.listed = listed.includes('checkpoint');
      const wrote = await tool('checkpoint', { line: 'tests written, 3 of 5 green' });
      values.wrote = wrote;
      const seen = await windowSees();
      values.windowSees = seen;
      await expect.poll(() => page.evaluate(() => (window as unknown as { __ticks: unknown[] }).__ticks.length), { timeout: 10_000 }).toBeGreaterThan(0);
      values.ticked = await page.evaluate(() => (window as unknown as { __ticks: unknown[] }).__ticks.at(-1));
      // 2.
      const viaGetAgent = await tool('get_agent', { id: 'w' });
      const list = await (await fetch(`http://127.0.0.1:${port}/api/agents`, { headers: { Authorization: `Bearer ${identity.lead}`, 'X-Tars-Caller-Id': 'lead' } })).json() as { agents?: Array<{ id: string; checkpoint?: unknown }> };
      values.getAgent = viaGetAgent.text;
      values.listEntry = list.agents?.find((a) => a.id === 'w');
      // 3.
      const tooLong = await tool('checkpoint', { line: 'x'.repeat(121) });
      const twoLines = await tool('checkpoint', { line: 'one\ntwo' });
      const after = await windowSees();
      Object.assign(values, { tooLong, twoLines, after });
      // 4.
      const cross = await fetch(`http://127.0.0.1:${port}/api/agents/lead/checkpoint`, {
        method: 'POST', headers: { Authorization: `Bearer ${identity.w}`, 'X-Tars-Caller-Id': 'w', 'Content-Type': 'application/json' }, body: JSON.stringify({ line: 'not mine' }),
      });
      values.cross = { status: cross.status, body: await cross.json().catch(() => null) };
      recordValues(values);

      expect(values.listed).toBe(true);
      expect(wrote.isError, wrote.text).toBe(false);
      expect(seen).toMatchObject({ line: 'tests written, 3 of 5 green' });
      expect(Date.parse(seen!.at)).not.toBeNaN();
      expect(values.ticked).toEqual(seen);
      expect(viaGetAgent.text).toContain('tests written, 3 of 5 green');
      expect(values.listEntry).toMatchObject({ checkpoint: { line: 'tests written, 3 of 5 green' } });
      expect(tooLong.isError, tooLong.text).toBe(true);
      expect(twoLines.isError, twoLines.text).toBe(true);
      expect(after).toEqual(seen);
      expect(cross.status).toBe(403);
    } finally {
      recordValues(values);
      mcp?.kill();
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
