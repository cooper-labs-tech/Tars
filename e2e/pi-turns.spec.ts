import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A task delegated into a pi agent is followed to its end, answered with pi's own words, and the next one goes in
 * (2.0.4, the CLI matrix's pi row). Until then a pi agent read `running` for as long as its TUI was open: its task was
 * said `delivered`, its answer never read, and nothing knew when the next one could go in.
 *
 * pi is a stand-in named `pi` that writes its session as @earendil-works/pi-coding-agent 1.3.0 does (read in the
 * package: docs/session-format.md, dist/core/session-manager.js): in the folder PI_CODING_AGENT_SESSION_DIR names, one
 * `<time>_<uuid>.jsonl` created at the first message, its header first, then one line per message as it ends, an
 * assistant's `stopReason` saying whether the turn goes on (`toolUse`) or ends (`stop`, `aborted` on an Esc).
 * Lead, the project's orchestrator, works through the real mcp-orchestrator over stdio with its own identity.
 *
 * Asserted, with the classic shell and with the new interface:
 * 1. pi is started with a session folder of the agent's own, under Tars's data folder;
 * 2. delegate_task gets pi's answer, `ended: end_turn`, read from its session file;
 * 3. a second task given while the first works waits, goes in once the first ended, and gets its own answer;
 * 4. a turn cut with Esc in pi's terminal ends its task `interrupted`, and the next task goes in and is answered;
 * 5. the ledger has the tasks from lead, completed and stopped.
 * Red on fix/codex-works (b6e2dee1), this branch's base: each task is said delivered at once, with no answer.
 * The artefact: values.json (each tool's answer, the stand-in's log, the session file's lines, the ledger's tasks).
 */

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const dir = process.env.PI_CODING_AGENT_SESSION_DIR;
const log = (entry) => fs.appendFileSync(path.join(process.env.HOME, 'stand-in.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
log({ launched: process.argv.slice(2), sessionDir: dir || null });
const sid = crypto.randomUUID();
let file;
let n = 0;
const entry = (o) => {
  if (!dir) return;
  if (!file) {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '_' + sid + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id: sid, timestamp: new Date().toISOString(), cwd: process.cwd() }) + '\n');
  }
  fs.appendFileSync(file, JSON.stringify({ type: 'message', id: 'e' + (++n), parentId: null, timestamp: new Date().toISOString(), message: { ...o, timestamp: Date.now() } }) + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cut = false;
async function turn(prompt) {
  cut = false;
  log({ turn: prompt });
  entry({ role: 'user', content: prompt });
  entry({ role: 'assistant', content: [{ type: 'toolCall', id: 't' + n, name: 'bash', arguments: {} }], stopReason: 'toolUse' });
  entry({ role: 'toolResult', toolCallId: 't' + n, toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false });
  if (prompt.includes('SLOW')) await sleep(6000);
  if (prompt.includes('ESC-ME')) { for (let i = 0; i < 600 && !cut; i++) await sleep(100); }
  if (cut) { entry({ role: 'assistant', content: [{ type: 'text', text: 'half' }], stopReason: 'aborted' }); log({ aborted: prompt }); return; }
  const word = (prompt.match(/\b(FIRST|SECOND|AFTER)\b/) || [, 'ANY'])[1];
  entry({ role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'pi answer for ' + word }], stopReason: 'stop' });
}
// As pi 1.5.2 draws its first frames, which Tars waits for since #610 (pi-provider.ts, upOnScreen): its field between two
// rules, its footer under them with the context used over its window, and something above the field's top rule.
process.stdout.write('pi stand-in ready\n' + '─'.repeat(40) + '\n> \n' + '─'.repeat(40) + '\n0.0%/128k (auto)\n');
process.stdin.setRawMode(true);
// As pi-tui 1.3.0 does (terminal.js): bracketed paste on, a paste goes into the editor whole, its newlines
// included, and only an Enter typed outside it submits. A lone Esc cuts the turn in hand.
let buffer = '';
let pasting = false;
let queue = Promise.resolve();
process.stdin.on('data', (data) => {
  let s = data.toString();
  while (s.length) {
    if (pasting) {
      const end = s.indexOf('\x1b[201~');
      if (end === -1) { buffer += s; s = ''; } else { buffer += s.slice(0, end); s = s.slice(end + 6); pasting = false; }
      continue;
    }
    const start = s.indexOf('\x1b[200~');
    const keys = start === -1 ? s : s.slice(0, start);
    s = start === -1 ? '' : s.slice(start + 6);
    if (start !== -1) pasting = true;
    for (const ch of keys) {
      if (ch === '\x1b') { cut = true; continue; }
      if (ch === '\r' || ch === '\n') {
        const prompt = buffer;
        buffer = '';
        if (prompt.trim()) queue = queue.then(() => turn(prompt));
        continue;
      }
      buffer += ch;
    }
  }
});
process.stdin.resume();
`;

type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; get(id: string): Promise<{ cliRunning?: boolean } | null> };
  usage: { tasks(q?: { sinceDays?: number }): Promise<{ tasks: Array<{ id: string; agentId: string; requesterAgentId: string | null; outcome: string }> }> };
} };
const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

for (const newInterface of [false, true]) {
  test(`a task delegated into a pi agent is followed to its end and the next one goes in${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-pi-turns-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const pi = path.join(bin, 'pi');
    fs.writeFileSync(pi, `#!${process.execPath}\n${STAND_IN}`, { mode: 0o755 });
    const agent = (id: string, name: string, role: string, provider: string) => ({
      id, name, character: 'robot', provider, status: 'idle', role, projectPath: project, skills: [], permissionMode: 'bypass',
      ...(provider === 'pi' ? { cliPath: pi } : {}), createdAt: '2026-10-19T08:00:00.000Z', lastActivity: '2026-10-19T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'Project Lead', 'orchestrator', 'claude'), agent('pi1', 'Pi Worker', 'worker', 'pi')], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { pi, additionalPaths: [bin] }, newInterface,
    }));
    const port = apiPort(newInterface ? 31385 : 31386);
    const dist = path.resolve('electron', 'dist');
    const log = path.join(home, 'stand-in.jsonl');
    const sessions = path.join(dir, 'pi', 'sessions', 'pi1');
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    let mcp: ChildProcessWithoutNullStreams | undefined;
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });

      // pi1's terminal, started from the window.
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'pi1', prompt: '' }));
      await expect.poll(() => lines(log).some((e) => e.launched), { timeout: 60_000 }).toBe(true);
      await expect.poll(async () => !!(await page.evaluate(() => (window as unknown as Api).electronAPI.agent.get('pi1')))?.cliRunning, { timeout: 30_000 }).toBe(true);

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
          const l = buffered.slice(0, at);
          buffered = buffered.slice(at + 1);
          if (!l.trim()) continue;
          const msg = JSON.parse(l);
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
      const turnsWith = (mark: string) => lines(log).filter((e) => typeof e.turn === 'string' && e.turn.includes(mark));

      // 2, 3. Two tasks, the second while the first works.
      const first = tool('delegate_task', { id: 'pi1', prompt: 'SLOW FIRST read the logs', timeoutSeconds: 90, clientRequestId: `e2e-pi-1-${newInterface}` });
      await expect.configure({ soft: true }).poll(() => turnsWith('FIRST').length, { timeout: 60_000, message: 'the first task reached pi' }).toBe(1);
      const second = tool('delegate_task', { id: 'pi1', prompt: 'SECOND run the tests', timeoutSeconds: 90, clientRequestId: `e2e-pi-2-${newInterface}` });
      const [one, two] = await Promise.all([first, second]);
      keep({ one, two });
      expect.soft(one.text).toContain('pi answer for FIRST');
      expect.soft(one.text).toContain('ended: end_turn');
      expect.soft(two.text).toContain('pi answer for SECOND');
      const order = lines(log).map((e) => e.turn ?? '').filter(Boolean) as string[];
      expect.soft(order.findIndex((t) => t.includes('SECOND')), 'the second went in after the first').toBeGreaterThan(order.findIndex((t) => t.includes('FIRST')));

      // 4. An Esc cuts a turn: its task ends interrupted, and the next goes in.
      const held = tool('delegate_task', { id: 'pi1', prompt: 'ESC-ME write the long report', timeoutSeconds: 90, clientRequestId: `e2e-pi-3-${newInterface}` });
      await expect.configure({ soft: true }).poll(() => turnsWith('ESC-ME').length, { timeout: 60_000 }).toBe(1);
      await app.evaluate((_e, { dist }) => {
        const req = process.mainModule!.require;
        const a = req(`${dist}/core/agent-manager.js`).agents.get('pi1');
        req(`${dist}/core/pty-manager.js`).ptyProcesses.get(a.ptyId)?.write('\x1b');
      }, { dist });
      const cut = await held;
      const after = await tool('delegate_task', { id: 'pi1', prompt: 'AFTER one more thing', timeoutSeconds: 90, clientRequestId: `e2e-pi-4-${newInterface}` });
      keep({ cut, after });
      expect.soft(cut.text).toContain('interrupted');
      expect.soft(after.text).toContain('pi answer for AFTER');

      // 1. Its own session folder, and 5. the ledger.
      const launched = lines(log).find((e) => e.launched);
      const files = fs.existsSync(sessions) ? fs.readdirSync(sessions) : [];
      const report = await page.evaluate(() => (window as unknown as Api).electronAPI.usage.tasks({ sinceDays: 1 }));
      keep({ launched, files, session: files[0] ? lines(path.join(sessions, files[0])) : [], standIn: lines(log), tasks: report.tasks });
      expect.soft(launched?.sessionDir, 'pi\'s session folder').toBe(sessions);
      expect.soft(files.length, 'its session file').toBe(1);
      const piTasks = report.tasks.filter((t) => t.agentId === 'pi1' && t.requesterAgentId === 'lead').map((t) => t.outcome).sort();
      expect.soft(piTasks, 'pi1\'s tasks from lead').toEqual(['completed', 'completed', 'completed', 'stopped']);
    } finally {
      mcp?.kill();
      await app.close();
      await removeHome(home);
    }
  });
}
