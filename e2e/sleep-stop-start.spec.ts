import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent put to sleep, then stopped, then started again is seen by Tars, and takes its tasks (the orchestrator's
 * item 3 of 19/10: the "never began" alert). The session it slept in is the one its next start resumes, under the same
 * id with `--resume`, and that id was the tombstone of the CLI the sleep ended: the wake clears it, but a stop in
 * between made the agent `stopped`, not `asleep`, and the wake left the tombstone. Every post of the resumed session,
 * its SessionStart first, was refused as stale: the agent ran in its terminal and Tars never saw it.
 *
 * The real app on a sandbox HOME, and the real orchestrator MCP server run with the identity Tars hands agent `lead`.
 * Agent `dev` is a claude agent whose CLI is a stand-in named `claude` that does what Claude Code does: it continues
 * the session `--resume` names, under a new id with `--fork-session`, runs Tars's own hook scripts (SessionStart,
 * UserPromptSubmit, Stop) and writes its replies in the transcript where Claude Code keeps it.
 *
 * Each case: dev started from the window, put to sleep by the pass that runs every minute, stopped from the window,
 * then brought back one way, and given two tasks by lead, the second while the first works:
 * - `start`: started from the window;
 * - `task`: the first task starts it (delegate_task into a stopped agent);
 * - `restart`: the Dashboard's restart, which continues the conversation under a new id;
 * - `restart-first` (the Audit's M1 on #475): no sleep; the Dashboard's restart is the first launch of the run, on a
 *   session a previous run left, then a stop, then a start from the window, which must resume nothing.
 * Asserted, with the classic shell and with the new interface:
 * 1. its new session is registered: the agent's session is the one its CLI runs, and its CLI is said running;
 * 2. it continues the conversation it slept in (`--resume` and that session);
 * 3. both tasks run and end with their own answers, and the second goes in at the first's end;
 * 4. the ledger has both, from lead, completed.
 * Red on main (e2363ae0) for `start` and `task`: the session is never registered, and the first task never begins.
 * `restart-first` red on ba963f4d: the start after the stop resumes the restarted session, the stop's tombstone, under
 * its own id, and the same.
 * The artefact: values.json (the stand-in's log, the agent as read, both answers, the ledger's tasks), the app's trace.
 */

const HOOKS = path.resolve('hooks');

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const id = process.env.CLAUDE_AGENT_ID;
const args = process.argv.slice(2);
const resumed = args.indexOf('--resume');
const forked = args.includes('--fork-session');
// As Claude Code: --resume <id> continues that session, --fork-session under a new id.
const sid = resumed === -1 || forked ? crypto.randomUUID() : args[resumed + 1];
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
const log = (entry) => fs.appendFileSync(path.join(process.env.HOME, 'stand-in.jsonl'), JSON.stringify({ at: new Date().toISOString(), id, sid, pid: process.pid, ...entry }) + '\n');
const hook = (name, payload) => {
  const out = spawnSync('/bin/bash', [path.join(HOOKS, name)], {
    input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }),
    env: process.env, timeout: 20000, encoding: 'utf8',
  });
  log({ hook: name, exit: out.status, out: (out.stdout || '').slice(0, 300) });
};
let n = 0;
const reply = (text) => fs.appendFileSync(transcript, JSON.stringify({
  type: 'assistant', requestId: 'req_' + sid + '_' + (++n), timestamp: new Date().toISOString(),
  message: { id: 'msg_' + sid + '_' + n, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 100 } },
}) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function turn(prompt) {
  log({ turn: prompt });
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  fs.appendFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } }) + '\n');
  if (prompt.includes('SLOW')) await sleep(8000);
  reply(prompt.includes('FIRST') ? 'First task done.' : prompt.includes('SECOND') ? 'Second task done.' : 'Done.');
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
}

// The transcript exists from the start, as Claude Code's does: what a later --resume looks for.
fs.appendFileSync(transcript, JSON.stringify({ type: 'system', timestamp: new Date().toISOString(), sessionId: sid }) + '\n');
log({ launched: args, resume: resumed === -1 ? null : args[resumed + 1], forked });
hook('session-start.sh', { hook_event_name: 'SessionStart', source: resumed === -1 ? 'startup' : 'resume' });
process.stdout.write('stand-in ready, session ' + sid + '\n');
process.stdin.setRawMode(true);
let buffer = '';
let queue = Promise.resolve();
const dashes = args.indexOf('--');
if (dashes !== -1 && args.slice(dashes + 1).join(' ').trim()) queue = queue.then(() => turn(args.slice(dashes + 1).join(' ')));
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
      if (line.trim()) queue = queue.then(() => turn(line));
    }
  }
});
process.stdin.resume();
`;

type Agent = { id: string; status: string; cliRunning?: boolean; currentSessionId?: string; asleepSince?: string };
type Api = { electronAPI: {
  agent: {
    start(p: { id: string; prompt: string }): Promise<unknown>;
    stop(id: string, reason?: string): Promise<unknown>;
    restart(id: string): Promise<{ success: boolean; error?: string }>;
    get(id: string): Promise<Agent | null>;
  };
  usage: { tasks(q?: { sinceDays?: number }): Promise<{ tasks: Array<{ id: string; agentId: string; requesterAgentId: string | null; outcome: string; sessionIds: string[] }> }> };
} };

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const CASES = ['start', 'task', 'restart', 'restart-first'] as const;
const PORTS: Record<(typeof CASES)[number], [number, number]> = {
  start: [31391, 31392], task: [31393, 31394], restart: [31395, 31396], 'restart-first': [31397, 31398],
};
/** The session a previous run of Tars left dev on, for `restart-first`. */
const LEFT = '3e9a1f0c-7b2d-4c8e-9f60-1a2b3c4d5e6f';

for (const how of CASES) {
  for (const newInterface of [false, true]) {
    const title = how === 'restart-first'
      ? 'an agent restarted as its first launch of the run, then stopped, then started, is seen and takes its tasks'
      : `an agent asleep, then stopped, brought back by ${how}, is seen and takes its tasks`;
    test(`${title}${newInterface ? ' (new interface)' : ''}`, async () => {
      test.setTimeout(300_000);
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-sleep-stop-'));
      const project = path.join(home, 'projects', 'demo');
      const dir = path.join(home, '.tars');
      const bin = path.join(home, 'bin');
      for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
      const claude = path.join(bin, 'claude');
      fs.writeFileSync(claude, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`, { mode: 0o755 });
      const agent = (id: string, name: string, role: string) => ({
        id, name, character: 'robot', provider: 'claude', status: 'idle', role, projectPath: project, skills: [], permissionMode: 'normal', cliPath: claude,
        createdAt: '2026-10-19T08:00:00.000Z', lastActivity: '2026-10-19T08:00:00.000Z',
      });
      const dev = how === 'restart-first' ? { ...agent('dev', 'Build Agent', 'worker'), resumableSessionId: LEFT } : agent('dev', 'Build Agent', 'worker');
      fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'Project Lead', 'orchestrator'), dev], null, 2));
      if (how === 'restart-first') {
        // Where the stand-in, as Claude Code, files the transcript: under the real path of the folder it runs in.
        const transcripts = path.join(home, '.claude', 'projects', fs.realpathSync(project).replace(/[^a-zA-Z0-9]/g, '-'));
        fs.mkdirSync(transcripts, { recursive: true });
        fs.writeFileSync(path.join(transcripts, `${LEFT}.jsonl`), `${JSON.stringify({ type: 'system', timestamp: '2026-10-19T07:00:00.000Z', sessionId: LEFT })}\n`);
      }
      fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
      fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
      fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
        autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { additionalPaths: [bin] }, newInterface,
      }));
      const port = apiPort(PORTS[how][newInterface ? 1 : 0]);
      const dist = path.resolve('electron', 'dist');
      const log = path.join(home, 'stand-in.jsonl');
      const values: Record<string, unknown> = { how, newInterface };
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
        const devLaunches = () => lines(log).filter((e) => e.id === 'dev' && e.launched);

        let slept: string | null = null;
        if (how === 'restart-first') {
          // The Dashboard's restart as the first launch of this run, then a stop: the fork it ran is the tombstone.
          keep({ restartedFirst: await page.evaluate(() => (window as unknown as Api).electronAPI.agent.restart('dev')) });
          await expect.poll(async () => { const a = await get('dev'); return !!(a.cliRunning && a.currentSessionId); }, { timeout: 60_000 }).toBe(true);
          await page.evaluate(() => (window as unknown as Api).electronAPI.agent.stop('dev'));
          await expect.poll(async () => (await get('dev')).status, { timeout: 15_000 }).toBe('stopped');
          await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'dev', prompt: '' }));
        } else {
        // dev's session, started from the window.
        await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'dev', prompt: '' }));
        await expect.poll(async () => { const a = await get('dev'); return !!(a.cliRunning && a.currentSessionId); }, { timeout: 60_000 }).toBe(true);
        slept = (await get('dev')).currentSessionId!;

        // Put to sleep by the pass that runs every minute, as after 40 minutes of rest.
        await expect.poll(() => app.evaluate(async (_e, { dist }) => {
          const req = process.mainModule!.require;
          const { agents } = req(`${dist}/core/agent-manager.js`);
          const dev = agents.get('dev');
          dev.statusSince = new Date(Date.now() - 40 * 60_000).toISOString();
          dev.lastTurnStartedAt = undefined;
          dev.workHandedAt = undefined;
          const outcomes = await req(`${dist}/services/agent-sleep.js`).checkSleep() as Array<{ agentId: string; slept: boolean }>;
          return outcomes.find((o) => o.agentId === 'dev')?.slept ?? dev.status;
        }, { dist }), { timeout: 30_000, intervals: [500] }).toBe(true);
        expect((await get('dev')).status).toBe('asleep');

        // Stopped from the window while asleep.
        await page.evaluate(() => (window as unknown as Api).electronAPI.agent.stop('dev'));
        await expect.poll(async () => (await get('dev')).status, { timeout: 15_000 }).toBe('stopped');

        // Brought back.
        if (how === 'start') await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'dev', prompt: '' }));
        if (how === 'restart') keep({ restarted: await page.evaluate(() => (window as unknown as Api).electronAPI.agent.restart('dev')) });
        }
        if (how !== 'task') {
          await expect.poll(() => devLaunches().length, { timeout: 30_000, message: 'its CLI launched again' }).toBe(2);
          // 1. Seen: the session its CLI runs is the agent's (on main, never: the SessionStart is refused).
          await expect.configure({ soft: true }).poll(async () => (await get('dev')).currentSessionId ?? null, { timeout: 30_000, message: 'its new session registered' })
            .toBe(devLaunches()[1].sid);
        }

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

        // 3. Two tasks, the second given while the first works.
        const first = tool('delegate_task', { id: 'dev', prompt: 'SLOW FIRST read the logs', timeoutSeconds: 90, clientRequestId: `e2e-sleep-stop-1-${how}-${newInterface}` });
        const turnsWith = (mark: string) => lines(log).filter((e) => e.id === 'dev' && typeof e.turn === 'string' && e.turn.includes(mark));
        await expect.configure({ soft: true }).poll(() => turnsWith('SLOW FIRST').length, { timeout: 60_000, message: 'the first task reached its CLI' }).toBe(1);
        const second = tool('delegate_task', { id: 'dev', prompt: 'SECOND run the tests', timeoutSeconds: 90, clientRequestId: `e2e-sleep-stop-2-${how}-${newInterface}` });
        const [one, two] = await Promise.all([first, second]);

        const after = await get('dev');
        const standIn = lines(log);
        const report = await page.evaluate(() => (window as unknown as Api).electronAPI.usage.tasks({ sinceDays: 1 }));
        const launches = standIn.filter((e) => e.id === 'dev' && e.launched);
        keep({ slept, one, two, after: { status: after.status, cliRunning: after.cliRunning, currentSessionId: after.currentSessionId }, launches, standIn, tasks: report.tasks });

        // 1. Seen: its session is the one its CLI runs.
        expect.soft(launches.length, 'launches of dev\'s CLI').toBe(2);
        expect.soft(after.currentSessionId, 'the agent\'s session').toBe(launches[1]?.sid);
        expect.soft(after.cliRunning).toBe(true);
        // 2. On the conversation it slept in.
        // restart-first: the restart resumed what the last run left, and the start after the stop resumes nothing.
        if (how === 'restart-first') expect.soft(launches[0]?.resume, 'the restart continued the session left').toBe(LEFT);
        expect.soft(launches[1]?.resume, how === 'restart-first' ? 'the start after the stop resumed nothing' : 'resumed the session it slept in').toBe(slept);
        expect.soft(launches[1]?.forked, '--fork-session only for the restart').toBe(how === 'restart');
        // 3. Both run and end, each with its answer, the second at the first's end.
        expect.soft(one.isError, one.text.slice(0, 400)).toBe(false);
        expect.soft(one.text).toContain('First task done.');
        expect.soft(two.isError, two.text.slice(0, 400)).toBe(false);
        expect.soft(two.text).toContain('Second task done.');
        const devEvents = standIn.filter((e) => e.id === 'dev' && e.sid === launches[1]?.sid);
        const firstTurn = devEvents.findIndex((e) => typeof e.turn === 'string' && e.turn.includes('SLOW FIRST'));
        const firstStop = devEvents.findIndex((e, i) => i > firstTurn && e.hook === 'on-stop.sh');
        const secondTurn = devEvents.findIndex((e) => typeof e.turn === 'string' && e.turn.includes('SECOND'));
        expect.soft(firstTurn, 'the first task\'s turn, in the new session').toBeGreaterThanOrEqual(0);
        expect.soft(secondTurn, 'the second task went in after the first ended').toBeGreaterThan(firstStop);
        expect.soft(firstStop).toBeGreaterThan(firstTurn);
        // 4. The ledger has both, from lead, completed.
        const devTasks = report.tasks.filter((t) => t.agentId === 'dev' && t.requesterAgentId === 'lead');
        expect.soft(devTasks.map((t) => t.outcome), 'dev\'s tasks from lead').toEqual(['completed', 'completed']);
      } finally {
        mcp?.kill();
        await app.close();
        if (fs.existsSync(log)) fs.copyFileSync(log, test.info().outputPath('stand-in.jsonl'));
        await removeHome(home);
      }
    });
  }
}
