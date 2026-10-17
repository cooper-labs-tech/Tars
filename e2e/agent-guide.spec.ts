import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Every agent learns how Tars works from Tars itself (2.0.4).
 *
 * The defect: an agent's identity never said what the kanban is, where to keep files or what a tool really does, and
 * nothing else did. No agent of any project had filed a kanban task; orchestrators believed delegate_task honoured a
 * per-task model before it did; scripts were kept in temporary folders that were wiped, or under ~/Documents.
 *
 * The real app on a sandbox HOME, and the real orchestrator MCP server (mcp-orchestrator/dist/bundle.js) run with the
 * identity Tars hands agent `lead`, spoken to over stdio as Claude Code speaks to it. `oc` and `acp` are opencode
 * workers whose CLI is a stand-in: in a terminal it records its command line, launched as `opencode acp` it is an ACP
 * agent that records every prompt; `win` and `dash` are opencode workers started from the window. `w` is a claude worker, whose terminal reads its identity from the bootstrap route
 * (hooks/session-start.sh, tars-hook.mjs): read here with w's own token, as its hook does.
 *
 * Asserted, once with the classic shell and once with the new interface:
 * 1. tars_guide without a topic lists the topics, stamped with the version; with one it returns it, with lead's
 *    project folder; an unknown topic is an error that lists them;
 * 2. the bootstrap of a claude worker and of the orchestrator carry the "How Tars works" section for their role,
 *    with the project's folder;
 * 3. an opencode worker started in a terminal (start_agent) gets the section in its prompt;
 * 4. a run over ACP (delegate_task) gets it in its prompt;
 * 5. the folder exists, outside the project, with tools/, notes/ and reports/;
 * 6. an opencode worker started from the window (agent:start, the launcher behind the Dashboard's Start, a wake and a
 *    restart) gets the section in its prompt, with a task and without one (the Audit's M1 on #448).
 * Each of 3, 4 and 6 carries the section once.
 * Red on 9df7c099: tars_guide is no tool, and no identity carries the section or a folder. Red on 9bd12b6c: 6, the
 * window's launcher gave a CLI without Claude's SessionStart hook its memory but not the section.
 * The artefact: values.json (each tool's answer, both bootstraps, the stand-in's launches and prompts, the folder's
 * listing), a screenshot of the Agents page, the app's trace with E2E_TRACE=on.
 */

/** opencode's stand-in: a terminal records its command line; `acp` speaks ACP and records each prompt. */
const STAND_IN = String.raw`
const fs = require('fs');
const log = (entry) => fs.appendFileSync(process.env.STAND_IN_LOG, JSON.stringify({ at: new Date().toISOString(), agent: process.env.CLAUDE_AGENT_ID || null, ...entry }) + '\n');
if (process.argv[2] !== 'acp') {
  log({ terminal: process.argv.slice(2) });
  process.stdout.write('opencode ready\r\n');
  setInterval(() => {}, 1 << 30);
} else {
  log({ launched: process.argv.slice(2) });
  let buf = '';
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handle(JSON.parse(line));
    }
  });
  function handle(msg) {
    if (msg.method === 'session/prompt') log({ prompt: msg.params.prompt?.map((p) => p.text ?? '').join('') });
    if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
    if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-1' } });
    if (msg.method === 'session/prompt') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'acp-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'checked the guide' } } } });
      return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    }
    if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
  process.stdin.resume();
}
`;

const SECTION = '## How Tars works';

for (const newInterface of [false, true]) {
  test(`every agent gets how Tars works, its project folder and tars_guide${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-agent-guide-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.dorothy');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const standInLog = path.join(home, 'stand-in.jsonl');
    const opencode = path.join(bin, 'opencode');
    fs.writeFileSync(opencode, `#!${process.execPath}\nprocess.env.STAND_IN_LOG = ${JSON.stringify(standInLog)};\n${STAND_IN}`, { mode: 0o755 });
    const agent = (id: string, name: string, role: string, provider: string) => ({
      id, name, character: 'robot', provider, status: 'idle', role, projectPath: project, skills: [], permissionMode: 'normal',
      createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent('lead', 'Project Lead', 'orchestrator', 'claude'), agent('w', 'Writer', 'worker', 'claude'),
      agent('oc', 'Terminal Worker', 'worker', 'opencode'), agent('acp', 'Run Worker', 'worker', 'opencode'),
      agent('win', 'Window Worker', 'worker', 'opencode'), agent('dash', 'Dashboard Worker', 'worker', 'opencode'),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { opencode, additionalPaths: [bin] }, newInterface,
    }));
    fs.writeFileSync(path.join(dir, 'acp-registry.json'), JSON.stringify({ fetchedAt: Date.now(), agents: { opencode: { id: 'opencode', name: 'opencode', version: 'local', command: 'opencode', args: ['acp'] } } }));
    const port = apiPort(newInterface ? 31427 : 31431);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { newInterface, home, project };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const once = (text: string) => text.split(SECTION).length - 1;
    const entries = () => (fs.existsSync(standInLog) ? fs.readFileSync(standInLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    let mcp: ChildProcessWithoutNullStreams | undefined;
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
      const version = await app.evaluate(({ app }) => app.getVersion());

      const identity = await app.evaluate((_e, { dist }) => {
        const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
        return { lead: tokens.mintRunToken('lead').token as string, w: tokens.mintRunToken('w').token as string, instance: tokens.tarsInstanceId() as string };
      }, { dist });
      mcp = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
        env: {
          PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: identity.lead,
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
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const tool = async (name: string, args: Record<string, unknown>) => {
        const reply = await rpc('tools/call', { name, arguments: args });
        return { text: reply.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
      };
      const bootstrap = async (id: string, token: string) => {
        const r = await fetch(`http://127.0.0.1:${port}/api/agents/${id}/bootstrap`, { headers: { Authorization: `Bearer ${token}`, 'X-Tars-Caller-Id': id } });
        return ((await r.json()) as { context?: string }).context ?? '';
      };

      // 1. tars_guide.
      const index = await tool('tars_guide', {});
      const folderTopic = await tool('tars_guide', { topic: 'project-folder' });
      const kanbanTopic = await tool('tars_guide', { topic: 'kanban' });
      const unknown = await tool('tars_guide', { topic: 'no-such-topic' });
      keep({ version, index, folderTopic, kanbanTopic, unknown });
      expect.soft(index.isError, index.text).toBe(false);
      expect.soft(index.text).toMatch(new RegExp(`^Tars ${version.replace(/\./g, '\\.')}, `));
      for (const id of ['delegation', 'messages', 'held-and-refused', 'kanban', 'project-folder', 'asking-the-user', 'limits']) expect.soft(index.text).toContain(`- ${id}: `);
      expect.soft(kanbanTopic.text).toContain('assign_task');
      expect.soft(unknown.isError).toBe(true);
      expect.soft(unknown.text).toContain('- kanban: ');
      const folder = /(\/\S+\/\.dorothy\/project-files\/demo-[0-9a-f]{10})/.exec(folderTopic.text)?.[1];
      keep({ folder });
      expect(folder, folderTopic.text).toBeTruthy();
      expect(fs.realpathSync(path.dirname(path.dirname(folder!)))).toBe(fs.realpathSync(dir));

      // 2. The bootstrap of a claude worker and of the orchestrator.
      const workerBoot = await bootstrap('w', identity.w);
      const leadBoot = await bootstrap('lead', identity.lead);
      keep({ workerBoot, leadBoot });
      for (const boot of [workerBoot, leadBoot]) {
        expect.soft(boot).toContain(SECTION);
        expect.soft(boot).toContain(folder!);
        expect.soft(boot).toContain('tars_guide');
      }
      const workerSection = workerBoot.slice(workerBoot.indexOf(SECTION));
      const leadSection = leadBoot.slice(leadBoot.indexOf(SECTION));
      expect.soft(workerSection).toContain('assign_task');
      expect.soft(workerSection).not.toContain('delegate_task');
      expect.soft(leadSection).toContain('delegate_task');
      expect.soft(leadSection).toContain('task_status');

      // 3. An opencode worker started in a terminal.
      const started = await tool('start_agent', { id: 'oc', prompt: 'TERMINAL>> read the guide' });
      keep({ started });
      expect.soft(started.isError, started.text).toBe(false);
      await expect.poll(() => entries().filter((e) => e.terminal && e.agent === 'oc').length, { timeout: 30_000 }).toBe(1);
      const terminalArgv = (entries().find((e) => e.terminal && e.agent === 'oc')!.terminal as string[]).join(' ');
      expect.soft(terminalArgv).toContain('TERMINAL>> read the guide');
      expect.soft(once(terminalArgv), terminalArgv).toBe(1);
      expect.soft(terminalArgv).toContain(folder!);

      // 4. A run over ACP.
      const delegated = await tool('delegate_task', { id: 'acp', prompt: 'ACP>> read the guide', timeoutSeconds: 120, clientRequestId: `e2e-agent-guide-${newInterface}` });
      keep({ delegated });
      expect.soft(delegated.isError, delegated.text).toBe(false);
      expect.soft(delegated.text).toContain('checked the guide');
      const prompts = entries().filter((e) => e.prompt && e.agent === 'acp').map((e) => e.prompt as string);
      keep({ standIn: entries() });
      expect.soft(prompts.length).toBe(1);
      expect.soft(prompts[0] ?? '').toContain('ACP>> read the guide');
      expect.soft(once(prompts[0] ?? ''), prompts[0]).toBe(1);
      expect.soft(prompts[0] ?? '').toContain(folder!);

      // 6. Opencode workers started from the window, with a task and without one.
      type Api = { electronAPI: { agent: { start: (p: { id: string; prompt: string }) => Promise<unknown> } } };
      const fromWindow: Record<string, unknown> = {};
      for (const [id, prompt] of [['win', 'WINDOW>> read the guide'], ['dash', '']] as const) {
        fromWindow[id] = await page.evaluate((p) => (window as unknown as Api).electronAPI.agent.start(p), { id, prompt });
        await expect.poll(() => entries().filter((e) => e.terminal && e.agent === id).length, { timeout: 30_000 }).toBe(1);
      }
      const argvOf = (id: string) => (entries().find((e) => e.terminal && e.agent === id)!.terminal as string[]).join(' ');
      keep({ fromWindow, windowArgv: argvOf('win'), dashboardArgv: argvOf('dash') });
      for (const id of ['win', 'dash']) {
        expect.soft(once(argvOf(id)), argvOf(id)).toBe(1);
        expect.soft(argvOf(id)).toContain(folder!);
        expect.soft(argvOf(id)).toContain('assign_task');
      }
      expect.soft(argvOf('win')).toContain('WINDOW>> read the guide');

      // 5. The folder, outside the project.
      const listing = fs.readdirSync(folder!).sort();
      keep({ listing });
      expect.soft(listing).toEqual(['notes', 'reports', 'tools']);
      expect.soft(fs.realpathSync(folder!).startsWith(fs.realpathSync(project))).toBe(false);
      await stepShot(page, newInterface ? 'agents-new-interface' : 'agents');
    } finally {
      mcp?.kill();
      await app.close();
      if (fs.existsSync(standInLog)) fs.copyFileSync(standInLog, test.info().outputPath('stand-in.jsonl'));
      await removeHome(home);
    }
  });
}
