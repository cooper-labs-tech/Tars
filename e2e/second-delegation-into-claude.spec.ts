import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Two tasks delegated in a row into one claude agent, from two other agents (the QA's CLI matrix, H1, 2026-10-18).
 *
 * The matrix found it: the second task delegated into a claude agent's terminal, from another agent, after the first
 * ended, was typed without its ", task t-..." line, and delegate_task told its asker it "never started, and Tars no
 * longer has it" while it ran. This spec plays the matrix's order with the real app on a sandbox HOME and the real
 * orchestrator MCP server (mcp-orchestrator/dist/bundle.js), one per asker, each with the identity Tars hands it:
 * 1. `dev`, a claude agent whose CLI is a stand-in that runs Tars's own hooks around each turn and writes its reply in
 *    the transcript, is the project's orchestrator and delegates to `oc` (opencode) and `ap` (amp), whose CLIs give
 *    Tars no hook: Tars never sees their turns end, and their links to `dev` stay up;
 * 2. `ap`, made the project's orchestrator, delegates a task to `dev`: it goes in under ap's line with its task id,
 *    and ap reads dev's answer;
 * 3. `oc`, made the orchestrator in turn, delegates a second task to `dev`: under oc's line with its own id, and oc
 *    reads its own answer, never "never started";
 * 4. the ledger files each of dev's two turns under its own asker.
 * Red on main (ce9c0084): both lines carry no id (each asker is taken for a worker reporting back to dev), and the
 * second delegation is answered 404, its turn filed under ap from the first's spare hand-off.
 * The artefact: values.json (every tool answer, the links, dev's turns, the ledger's tasks), a screenshot of the
 * Usage page, the app's trace with E2E_TRACE=on.
 */

const HOOKS = path.resolve('hooks');

/** Claude Code around each turn: its hooks, and its reply in the transcript, which names the task it read. */
const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const id = process.env.CLAUDE_AGENT_ID;
const sid = crypto.randomUUID();
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
const log = (entry) => fs.appendFileSync(path.join(process.env.HOME, 'stand-in.jsonl'), JSON.stringify({ at: new Date().toISOString(), id, sid, pid: process.pid, ...entry }) + '\n');
const hook = (name, payload) => {
  const out = spawnSync('/bin/bash', [path.join(HOOKS, name)], {
    input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }),
    env: process.env, timeout: 20000, encoding: 'utf8',
  });
  log({ hook: name, exit: out.status });
};
let n = 0;
function turn(prompt) {
  log({ turn: prompt });
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  fs.appendFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } }) + '\n');
  const echo = /ECHO (\S+)/.exec(prompt);
  n++;
  fs.appendFileSync(transcript, JSON.stringify({
    type: 'assistant', requestId: 'req_' + id + '_' + n, timestamp: new Date().toISOString(),
    message: { id: 'msg_' + id + '_' + n, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'ANSWER ' + (echo ? echo[1] : 'none') }], usage: { input_tokens: 1000, output_tokens: 10 } },
  }) + '\n');
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
}
hook('session-start.sh', { hook_event_name: 'SessionStart', source: 'startup' });
log({ launched: process.argv.slice(2) });
process.stdout.write('stand-in ready\n');
process.stdin.setRawMode(true);
let buffer = '';
let pasting = false;
process.stdin.on('data', (data) => {
  // Enter outside a paste ends a message: since #569 the sender line ends its own line inside its paste, as in claude.
  for (const piece of data.toString().split(/(\x1b\[20[01]~)/)) {
    if (piece === '\x1b[200~') { pasting = true; continue; }
    if (piece === '\x1b[201~') { pasting = false; continue; }
    for (const ch of piece) {
      if ((ch !== '\r' && ch !== '\n') || pasting) { buffer += ch; continue; }
      const line = buffer;
      buffer = '';
      if (line.trim()) turn(line);
    }
  }
});
process.stdin.resume();
`;

/** A CLI with no hook: it logs how it was launched and what is typed into it, and says nothing to Tars. */
const NO_HOOK_CLI = String.raw`
const fs = require('fs'), path = require('path');
const name = path.basename(process.argv[1]);
const log = (entry) => fs.appendFileSync(path.join(process.env.HOME, name + '.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }) + '\n');
log({ launched: process.argv.slice(2) });
process.stdout.write(name + ' stand-in ready\n');
process.stdin.on('data', (d) => log({ typed: d.toString() }));
process.stdin.resume();
`;

type Agent = { id: string; status: string; cliRunning?: boolean; currentSessionId?: string };
type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; get(id: string): Promise<Agent | null> };
  usage: { tasks(q?: { sinceDays?: number }): Promise<{ tasks: Array<{ id: string; agentId: string; source: string; requesterAgentId: string | null; outcome: string }> }> };
} };
type Tool = (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

for (const newInterface of [false, true]) {
  test(`a second task delegated into a claude agent is its own asker's, after a first from another${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-second-delegation-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const claude = path.join(bin, 'claude');
    fs.writeFileSync(claude, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`, { mode: 0o755 });
    const opencode = path.join(bin, 'opencode');
    fs.writeFileSync(opencode, `#!${process.execPath}\n${NO_HOOK_CLI}`, { mode: 0o755 });
    const amp = path.join(bin, 'amp');
    fs.writeFileSync(amp, `#!${process.execPath}\n${NO_HOOK_CLI}`, { mode: 0o755 });
    const agent = (id: string, name: string, role: string, provider: string, cliPath: string) => ({
      id, name, character: 'robot', provider, status: 'idle', role, projectPath: project, skills: [], permissionMode: 'normal', cliPath,
      createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent('dev', 'Claude Agent', 'orchestrator', 'claude', claude),
      agent('oc', 'Opencode Agent', 'worker', 'opencode', opencode),
      agent('ap', 'Amp Agent', 'worker', 'amp', amp),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { additionalPaths: [bin] }, newInterface,
    }));
    const port = apiPort(newInterface ? 31409 : 31410);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    const servers: ChildProcessWithoutNullStreams[] = [];
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
      const get = (id: string) => page.evaluate((i) => (window as unknown as Api).electronAPI.agent.get(i), id);

      // dev's permanent session, started from the window, as its card shows it.
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'dev', prompt: '' }));
      await expect.poll(async () => { const a = await get('dev'); return !!(a?.cliRunning && a.currentSessionId); }, { timeout: 60_000 }).toBe(true);

      /** The orchestrator MCP server as `agentId`'s CLI runs it, with the token Tars hands that agent. */
      const mcpAs = async (agentId: string): Promise<Tool> => {
        const identity = await app.evaluate((_e, { dist, agentId }) => {
          const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
          return { token: tokens.mintRunToken(agentId).token as string, instance: tokens.tarsInstanceId() as string };
        }, { dist, agentId });
        const mcp = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
          env: {
            PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: identity.token,
            CLAUDE_AGENT_ID: agentId, CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: identity.instance,
          },
        });
        servers.push(mcp);
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
        await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
        mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        return async (name, args) => {
          const reply = await rpc('tools/call', { name, arguments: args });
          return { text: reply.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
        };
      };
      /** The project's orchestrator from now on, as the window's role switch makes it (the previous one demoted). */
      const orchestrator = (id: string) => app.evaluate((_e, { dist, id }) => {
        const req = process.mainModule!.require;
        const manager = req(`${dist}/core/agent-manager.js`);
        req(`${dist}/core/agent-role.js`).assignRole(manager.agents.get(id), 'orchestrator', manager.agents.values());
      }, { dist, id });
      const links = () => app.evaluate((_e, { dist }) => {
        const manager = process.mainModule!.require(`${dist}/core/agent-manager.js`);
        return Object.fromEntries(['oc', 'ap'].map((id) => [id, manager.agents.get(id)?.requestedBy?.agentId ?? null]));
      }, { dist });

      // 1. dev, the orchestrator, hands oc and ap a task each: CLIs with no hook, whose turns Tars never sees end.
      const asDev = await mcpAs('dev');
      const toOc = await asDev('delegate_task', { id: 'oc', prompt: 'NOHOOK look at the logs', timeoutSeconds: 60 });
      const toAp = await asDev('delegate_task', { id: 'ap', prompt: 'AMPTASK sort the inbox', timeoutSeconds: 60 });
      await expect.poll(() => JSON.stringify(lines(path.join(home, 'amp.jsonl')).filter((e) => e.typed)), { timeout: 30_000 }).toContain('AMPTASK sort the inbox');
      const linksBefore = await links();
      keep({ toOc, toAp, linksBefore });

      // 2. ap, now the orchestrator, delegates to dev.
      await orchestrator('ap');
      const asAp = await mcpAs('ap');
      const first = await asAp('delegate_task', { id: 'dev', prompt: 'ECHO FIRSTDELEG', timeoutSeconds: 90 });
      keep({ first });

      // 3. oc, the orchestrator in turn, delegates the second task to dev.
      await orchestrator('oc');
      const asOc = await mcpAs('oc');
      const second = await asOc('delegate_task', { id: 'dev', prompt: 'ECHO SECONDDELEG', timeoutSeconds: 90 });

      const devTurns = lines(path.join(home, 'stand-in.jsonl')).filter((e) => e.id === 'dev' && typeof e.turn === 'string').map((e) => e.turn as string);
      const report = await page.evaluate(() => (window as unknown as Api).electronAPI.usage.tasks({ sinceDays: 1 }));
      const devTasks = report.tasks.filter((t) => t.agentId === 'dev').map((t) => ({ requesterAgentId: t.requesterAgentId, source: t.source, outcome: t.outcome }));
      keep({ second, devTurns, devTasks, linksAfter: await links() });
      await page.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await stepShot(page, newInterface ? 'usage-new-interface' : 'usage');

      // 1. The links the matrix had: oc's and ap's still name dev.
      expect.soft(toOc.isError, toOc.text.slice(0, 300)).toBe(false);
      expect.soft(toAp.isError, toAp.text.slice(0, 300)).toBe(false);
      expect.soft(linksBefore, 'oc\'s and ap\'s links to dev, up since their turns never end').toEqual({ oc: 'dev', ap: 'dev' });
      // 2 and 3. Each task under its asker's line with its id, each asker its own answer.
      expect.soft(devTurns, 'dev\'s turns').toHaveLength(2);
      // Since #569 the sender line ends its own line, and the task is the line under it.
      expect.soft(devTurns[0]).toMatch(/^Message from agent "Amp Agent" \("ap"\), task t-[0-9a-f]{8}: \nECHO FIRSTDELEG$/);
      expect.soft(devTurns[1]).toMatch(/^Message from agent "Opencode Agent" \("oc"\), task t-[0-9a-f]{8}: \nECHO SECONDDELEG$/);
      expect.soft(first.isError, first.text.slice(0, 300)).toBe(false);
      expect.soft(first.text).toContain('ANSWER FIRSTDELEG');
      expect.soft(second.isError, second.text.slice(0, 300)).toBe(false);
      expect.soft(second.text).not.toContain('never started');
      expect.soft(second.text).toContain('ANSWER SECONDDELEG');
      // 4. Each turn filed under its own asker.
      expect.soft(devTasks.map((t) => t.requesterAgentId).sort(), 'the askers of dev\'s tasks in the ledger').toEqual(['ap', 'oc']);
    } finally {
      for (const s of servers) s.kill();
      await app.close();
      for (const f of ['stand-in.jsonl', 'opencode.jsonl', 'amp.jsonl']) if (fs.existsSync(path.join(home, f))) fs.copyFileSync(path.join(home, f), test.info().outputPath(f));
      await removeHome(home);
    }
  });
}
