import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Two tasks delegated in a row into a gemini agent each end, with their own answer (the QA's CLI matrix of 18/10,
 * gemini as B: "the first task is never closed... every later delegation answers queued behind a turn in its
 * terminal"). gemini's hooks tell Tars when a turn begins (BeforeAgent) and ends (AfterAgent); Tars took gemini for a
 * CLI with no hook, its BeforeAgent opened no turn, and its AfterAgent left the agent `waiting` with no reason, which
 * Tars reads as a turn still asking.
 *
 * The real app on a sandbox HOME, and the real orchestrator MCP server with the identity Tars hands agent `lead`.
 * Agent `gem` is a gemini agent whose CLI is a stand-in named `gemini` that does what gemini 0.64.0 does around a turn,
 * as read in its published code (@google/gemini-cli-core, hookEventHandler.js and client.js): it runs the hooks of
 * ~/.gemini/settings.json, the ones Tars wrote there, on SessionStart, BeforeAgent (`prompt`) and AfterAgent (`prompt`,
 * `prompt_response`, `stop_hook_active`), once per turn, with gemini's environment.
 *
 * Asserted, with the classic shell and with the new interface:
 * 1. the first task is answered with its turn's answer, not said delivered;
 * 2. the second, given while the first works, goes in after the first's turn ended, and is answered with its own;
 * 3. the ledger has both, from lead, completed, and gem is at rest at the end.
 * gem is started from the window with no task, so Tars owes it how Tars works, typed with the first task (19/10: typed
 * ahead of the task's sender line, it pushed the line out of the prompt's start and the hook's first 200 bytes, and the
 * first task was nobody's).
 * Red on main (e2363ae0): the first is said delivered, and the second waits behind a turn that never ends.
 * The artefact: values.json (both answers, the stand-in's log, the ledger's tasks), the app's trace.
 */


const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const sid = crypto.randomUUID();
const transcript = path.join(process.env.HOME, '.gemini', 'tmp', 'chats', 'session-' + sid + '.json');
const log = (entry) => fs.appendFileSync(path.join(process.env.HOME, 'gemini.jsonl'), JSON.stringify({ at: new Date().toISOString(), sid, ...entry }) + '\n');
const settings = (() => { try { return JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.gemini', 'settings.json'), 'utf8')); } catch { return {}; } })();
const hook = (event, payload) => {
  for (const entry of settings.hooks?.[event] ?? []) {
    for (const h of entry.hooks ?? []) {
      if (h.type !== 'command') continue;
      const out = spawnSync('/bin/sh', ['-c', h.command], {
        input: JSON.stringify({ session_id: sid, transcript_path: transcript, cwd: process.cwd(), hook_event_name: event, timestamp: new Date().toISOString(), ...payload }),
        env: process.env, timeout: 20000, encoding: 'utf8',
      });
      log({ hook: event, command: path.basename(h.command), exit: out.status });
    }
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function turn(prompt) {
  log({ turn: prompt });
  hook('BeforeAgent', { prompt });
  if (prompt.includes('SLOW')) await sleep(8000);
  const answer = prompt.includes('FIRST') ? 'First task done: the logs are clean.' : prompt.includes('SECOND') ? 'Second task done: the tests pass.' : 'Done.';
  hook('AfterAgent', { prompt, prompt_response: answer, stop_hook_active: false });
}
log({ launched: process.argv.slice(2), hooks: Object.keys(settings.hooks ?? {}) });
hook('SessionStart', { source: 'startup' });
process.stdout.write('gemini stand-in ready\r\n');
// gemini 0.70.0's field, the row Tars reads before it types into a gemini terminal (GeminiProvider.upOnScreen, #641).
process.stdout.write(' >   Type your message or @path/to/file\r\n');
process.stdin.setRawMode(true);
// As gemini's input does: a bracketed paste is text, newlines and all, and only an Enter typed outside one submits.
let field = '';
let pasting = false;
let queue = Promise.resolve();
process.stdin.on('data', (data) => {
  let rest = data.toString();
  while (rest) {
    if (rest.startsWith('\x1b[200~')) { pasting = true; rest = rest.slice(6); continue; }
    if (rest.startsWith('\x1b[201~')) { pasting = false; rest = rest.slice(6); continue; }
    const ch = rest[0];
    rest = rest.slice(1);
    if (!pasting && (ch === '\r' || ch === '\n')) {
      const prompt = field;
      field = '';
      if (prompt.trim()) queue = queue.then(() => turn(prompt));
    } else field += ch;
  }
});
process.stdin.resume();
`;

type Agent = { id: string; status: string; cliRunning?: boolean; currentSessionId?: string };
type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; get(id: string): Promise<Agent | null> };
  usage: { tasks(q?: { sinceDays?: number }): Promise<{ tasks: Array<{ id: string; agentId: string; requesterAgentId: string | null; outcome: string }> }> };
} };

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

for (const newInterface of [false, true]) {
  test(`two tasks in a row into a gemini agent each end with their own answer${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-gemini-turns-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const gemini = path.join(bin, 'gemini');
    fs.writeFileSync(gemini, `#!${process.execPath}\n${STAND_IN}`, { mode: 0o755 });
    const agent = (id: string, name: string, role: string, provider: string) => ({
      id, name, character: 'robot', provider, status: 'idle', role, projectPath: project, skills: [], permissionMode: 'normal',
      ...(provider === 'gemini' ? { cliPath: gemini } : {}), createdAt: '2026-10-19T08:00:00.000Z', lastActivity: '2026-10-19T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'Project Lead', 'orchestrator', 'claude'), agent('gem', 'Gemini Agent', 'worker', 'gemini')], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { additionalPaths: [bin], gemini }, newInterface,
    }));
    const port = apiPort(newInterface ? 31387 : 31386);
    const dist = path.resolve('electron', 'dist');
    const log = path.join(home, 'gemini.jsonl');
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
      const get = async (id: string) => (await page.evaluate((i) => (window as unknown as Api).electronAPI.agent.get(i), id))!;

      // Tars writes gemini's hooks at its start; gem's permanent session, started from the window.
      await expect.poll(() => fs.existsSync(path.join(home, '.gemini', 'settings.json')), { timeout: 30_000, message: 'Tars wrote gemini\'s hooks' }).toBe(true);
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'gem', prompt: '' }));
      await expect.poll(async () => { const a = await get('gem'); return !!(a.cliRunning && a.currentSessionId); }, { timeout: 60_000, message: 'gem\'s session registered' }).toBe(true);

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

      // Two tasks, the second given while the first works.
      const first = tool('delegate_task', { id: 'gem', prompt: 'SLOW FIRST read the logs', timeoutSeconds: 60, clientRequestId: `e2e-gemini-1-${newInterface}` });
      const turnsWith = (mark: string) => lines(log).filter((e) => typeof e.turn === 'string' && e.turn.includes(mark));
      await expect.poll(() => turnsWith('SLOW FIRST').length, { timeout: 60_000, message: 'the first task reached gemini' }).toBe(1);
      const second = tool('delegate_task', { id: 'gem', prompt: 'SECOND run the tests', timeoutSeconds: 60, clientRequestId: `e2e-gemini-2-${newInterface}` });
      const [one, two] = await Promise.all([first, second]);

      const standIn = lines(log);
      const report = await page.evaluate(() => (window as unknown as Api).electronAPI.usage.tasks({ sinceDays: 1 }));
      const after = await get('gem');
      keep({ one, two, standIn, tasks: report.tasks, after: { status: after.status } });

      // 1. The first answered with its turn's answer.
      expect.soft(one.isError, one.text.slice(0, 400)).toBe(false);
      expect.soft(one.text).toContain('First task done: the logs are clean.');
      expect.soft(one.text).not.toMatch(/cannot see when its turn ends/);
      // 2. The second after the first's end, with its own.
      expect.soft(two.isError, two.text.slice(0, 400)).toBe(false);
      expect.soft(two.text).toContain('Second task done: the tests pass.');
      const firstEnd = standIn.findIndex((e) => e.hook === 'AfterAgent');
      const secondTurn = standIn.findIndex((e) => typeof e.turn === 'string' && e.turn.includes('SECOND'));
      expect.soft(secondTurn, 'the second task went in after the first turn ended').toBeGreaterThan(firstEnd);
      expect.soft(firstEnd).toBeGreaterThanOrEqual(0);
      // 3. The ledger, and gem at rest.
      expect.soft(report.tasks.filter((t) => t.agentId === 'gem' && t.requesterAgentId === 'lead').map((t) => t.outcome)).toEqual(['completed', 'completed']);
      expect.soft(after.status).toBe('idle');
    } finally {
      mcp?.kill();
      await app.close();
      if (fs.existsSync(log)) fs.copyFileSync(log, test.info().outputPath('gemini.jsonl'));
      await removeHome(home);
    }
  });
}
