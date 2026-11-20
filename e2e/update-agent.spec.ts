import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * update_agent: an orchestrator sets an agent up end to end, on any CLI, and changes it afterwards (2.0.4, the
 * maintainer: "an orchestrator must be able to set an agent up end to end, on any CLI, and change its settings
 * afterwards").
 *
 * The real app on a sandbox HOME, and the real orchestrator MCP server (mcp-orchestrator/dist/bundle.js) run with the
 * identity Tars hands an agent (a token of its own, its id, its project, Tars's instance), spoken to over stdio as a
 * CLI speaks to it: once as the project's orchestrator, once as one of its workers. Settings name a recording
 * stand-in as codex's CLI; a second stand-in, named `claude`, runs Tars's own hooks as Claude Code does, writes its
 * transcript where Claude Code does, and continues the session `--resume` names (a new one with `--fork-session`).
 * Both record each launch's argv and pid, and stay up as a CLI does.
 *
 * Asserted, in order:
 * 1. create_agent makes a codex agent (model-a, effort low), and start_agent starts codex on model-a;
 * 2. update_agent sets model-b and effort high while codex works on the task start_agent gave it: queued behind that
 *    run (2.0.7: a change of what the CLI runs waits until the agent is free), nothing written, and codex is not
 *    touched (same process, no second launch);
 * 3. a move to claude while codex works is queued behind that change (2.0.7: never refused, never cutting the turn),
 *    and nothing is written; reverted while still queued, it is dropped, and codex is left alone;
 * 4. stopped, the queued model and effort go in; started again, codex runs on model-b;
 * 5. stopped, the agent moves to claude (model opus, effort max, the stand-in as its CLI path): taken, said to apply
 *    at its next start on a new conversation; agents.json has it;
 * 6. started, claude runs with --model opus and --effort max, on a new session (no --resume);
 * 7. its effort changed to low once its task is over: taken (or queued for the moment its run is released), its
 *    conversation kept, and claude is restarted with --effort low, --resume <its session> and --fork-session;
 * 8. refused, and nothing written, for a setting outside the inference ones (2.0.7: those any agent changes): the
 *    worker changing it (worker_may_not_update), the orchestrator changing an agent of another project
 *    (other_project), and the orchestrator changing itself (orchestrator_settings).
 * Run in the classic shell and in the new interface's. The artefact: values.json (every tool answer, the records,
 * every launch), launches.jsonl.
 */

const HOOKS = path.resolve('hooks');

const CLAUDE_STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
// Asked its version outside a terminal (Tars probes it): not a launch.
if (!process.stdin.isTTY) process.exit(0);
const id = process.env.CLAUDE_AGENT_ID;
const args = process.argv.slice(2);
const resumed = args.indexOf('--resume');
const forked = args.includes('--fork-session');
const sid = resumed === -1 || forked ? crypto.randomUUID() : args[resumed + 1];
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, '');
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
fs.appendFileSync(LAUNCHES, JSON.stringify({ bin: 'claude', agent: id || null, pid: process.pid, sid, resume: flag('--resume'), fork: forked, model: flag('--model'), effort: flag('--effort'), argv: args }) + '\n');
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(HOOKS, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: { ...process.env, CLAUDE_PID: String(process.pid) }, timeout: 20000,
});
const line = (o) => fs.appendFileSync(transcript, JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function turn(prompt) {
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
  line({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  await sleep(200);
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
}
process.stdin.setRawMode(true);
hook('session-start.sh', { hook_event_name: 'SessionStart', source: resumed === -1 ? 'startup' : 'resume' });
process.stdout.write('CLAUDE-OF-' + id + ' session ' + sid + '\r\n> ');
const dashes = args.indexOf('--');
const launchPrompt = dashes === -1 ? '' : args.slice(dashes + 1).join(' ');
let buffer = '';
let pasting = false;
let queue = Promise.resolve();
if (launchPrompt.trim()) queue = queue.then(() => turn(launchPrompt));
process.stdin.on('data', (data) => {
  for (const piece of data.toString().split(/(\x1b\[20[01]~)/)) {
    if (piece === '\x1b[200~') { pasting = true; continue; }
    if (piece === '\x1b[201~') { pasting = false; continue; }
    for (const ch of piece) {
      if (ch === '\r' && !pasting) {
        const typed = buffer;
        buffer = '';
        if (typed.trim()) queue = queue.then(() => turn(typed));
      } else if (ch === '\x7f') buffer = buffer.slice(0, -1);
      else buffer += ch;
    }
  }
});
process.stdin.resume();
`;

type Launch = { bin: string; agent: string | null; pid: number; sid?: string; resume?: string | null; fork?: boolean; model?: string | null; effort?: string | null; argv: string[] };
type Said = { text: string; isError: boolean };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

for (const newInterface of [false, true]) {
  test(`an orchestrator makes a codex agent, changes its model and effort, then moves it to claude${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-update-agent-'));
    const project = path.join(home, 'projects', 'demo');
    const elsewhere = path.join(home, 'projects', 'elsewhere');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    for (const d of [project, elsewhere, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const launchesFile = path.join(home, 'launches.jsonl');
    const codexCli = path.join(bin, 'codex');
    fs.writeFileSync(codexCli, `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(launchesFile)}, JSON.stringify({ bin: 'codex', agent: process.env.CLAUDE_AGENT_ID || null, pid: process.pid, argv: process.argv.slice(2) }) + '\\n');
process.stdout.write('codex ready\\r\\n');
setInterval(() => {}, 1 << 30);
`, { mode: 0o755 });
    const claudeCli = path.join(bin, 'claude');
    fs.writeFileSync(claudeCli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\nconst LAUNCHES = ${JSON.stringify(launchesFile)};\n${CLAUDE_STAND_IN}`, { mode: 0o755 });
    const seeded = (id: string, name: string, role: string, projectPath: string) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, permissionMode: 'bypass',
      projectPath, skills: [], createdAt: '2026-10-19T08:00:00.000Z', lastActivity: '2026-10-19T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      seeded('o1', 'Lead', 'orchestrator', project), seeded('w9', 'Helper', 'worker', project), seeded('far', 'Far', 'worker', elsewhere),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project, elsewhere]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, cliPaths: { codex: codexCli }, newInterface }));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    const port = apiPort(31447);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { home, project, newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    const servers: ChildProcessWithoutNullStreams[] = [];
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
      // The shell this run is in.
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });

      /** The orchestrator MCP server, run as `agentId` with the identity Tars hands it. */
      const mcpAs = async (agentId: string) => {
        const identity = await app.evaluate((_e, { dist, agentId }) => {
          const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
          return { token: tokens.mintRunToken(agentId).token as string, instance: tokens.tarsInstanceId() as string };
        }, { dist, agentId });
        const server = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
          env: {
            PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: identity.token,
            CLAUDE_AGENT_ID: agentId, CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: identity.instance,
          },
        });
        servers.push(server);
        // A server that dies or never answers fails the call with what it said, rather than the test's timeout.
        let said = '';
        server.stderr.on('data', (chunk) => { said = (said + chunk).slice(-2000); });
        const replies = new Map<number, (msg: { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown }) => void>();
        let buffered = '';
        server.stdout.on('data', (chunk) => {
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
        const rpc = (method: string, params: unknown) => new Promise<Parameters<NonNullable<ReturnType<typeof replies.get>>>[0]>((resolve, reject) => {
          const id = nextId++;
          const late = setTimeout(() => reject(new Error(`the orchestrator MCP server of ${agentId} did not answer ${method} in 60 s; it said: ${said}`)), 60_000);
          replies.set(id, (msg) => { clearTimeout(late); resolve(msg); });
          server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
        await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
        server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        return async (name: string, args: Record<string, unknown>): Promise<Said> => {
          const reply = await rpc('tools/call', { name, arguments: args });
          return { text: reply.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
        };
      };
      const lead = await mcpAs('o1');
      const worker = await mcpAs('w9');

      const launches = () => (fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Launch) : []);
      const records = () => {
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')) as { agents?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
        return Array.isArray(saved) ? saved : saved.agents ?? [];
      };
      const recordOf = (id: string) => records().find((a) => a.id === id);
      const agentNow = (id: string) => page.evaluate(async (id) => {
        const api = (window as unknown as { electronAPI: { agent: { list(): Promise<Array<Record<string, unknown>>> } } }).electronAPI;
        return (await api.agent.list()).find((a) => a.id === id);
      }, id);
      const launchesOf = (id: string, cli: string) => launches().filter((l) => l.agent === id && l.bin === cli);

      // ── 1. A codex agent, started on model-a ──
      const made = await lead('create_agent', { name: 'Mover', provider: 'codex', model: 'model-a', effort: 'low', permissionMode: 'bypass' });
      keep({ made });
      expect(made.isError).toBe(false);
      const id = /with ID: ([0-9a-f-]{36})/.exec(made.text)![1];
      const started = await lead('start_agent', { id, prompt: 'CODEX>> first task' });
      keep({ started });
      expect(started.isError).toBe(false);
      await expect.poll(() => launchesOf(id, 'codex').length, { timeout: 30_000 }).toBe(1);
      const first = launchesOf(id, 'codex')[0];
      expect(first.argv.join(' ')).toContain('--model model-a');

      // ── 2. Model and effort changed while codex works on its task: queued behind the run, nothing written, codex untouched ──
      const tuned = await lead('update_agent', { id, model: 'model-b', effort: 'high' });
      keep({ tuned, afterTuned: recordOf(id) });
      expect(tuned.isError, tuned.text).toBe(false);
      expect(tuned.text).toMatch(/\bqueued\b/);
      expect(tuned.text).toMatch(/the delegated run it holds ends/);
      expect(recordOf(id)).toMatchObject({ provider: 'codex', model: 'model-a', effort: 'low' });
      expect(alive(first.pid)).toBe(true);
      expect(launchesOf(id, 'codex')).toHaveLength(1);

      // ── 3. A move to claude while codex works: queued behind that change, nothing written; reverted while queued, dropped ──
      const tooSoon = await lead('update_agent', { id, provider: 'claude' });
      keep({ tooSoon, afterTooSoon: recordOf(id) });
      expect(tooSoon.isError).toBe(false);
      expect(tooSoon.text).toMatch(/\bqueued\b/);
      expect(tooSoon.text).toMatch(/the change queued before it/);
      expect(recordOf(id)).toMatchObject({ provider: 'codex', model: 'model-a' });
      expect(alive(first.pid)).toBe(true);
      const queuedChange = /\bchg-[0-9a-f]{8}\b/.exec(tooSoon.text)?.[0];
      expect(queuedChange).toBeTruthy();
      const dropped = await lead('revert_agent_change', { changeId: queuedChange });
      keep({ dropped });
      expect(dropped.isError).toBe(false);
      expect(dropped.text).toContain('cancelled');
      expect(recordOf(id)).toMatchObject({ provider: 'codex', model: 'model-a' });
      expect(alive(first.pid)).toBe(true);

      // ── 4. Stopped: the queued model and effort go in; started again, codex runs on model-b ──
      expect((await lead('stop_agent', { id, reason: 'restart it on its new model' })).isError).toBe(false);
      await expect.poll(() => alive(first.pid), { timeout: 30_000 }).toBe(false);
      await expect.poll(() => recordOf(id), { timeout: 15_000 }).toMatchObject({ provider: 'codex', model: 'model-b', effort: 'high' });
      expect((await lead('start_agent', { id, prompt: 'CODEX>> second task' })).isError).toBe(false);
      await expect.poll(() => launchesOf(id, 'codex').length, { timeout: 30_000 }).toBe(2);
      const second = launchesOf(id, 'codex')[1];
      keep({ codexLaunches: launchesOf(id, 'codex') });
      expect(second.argv.join(' ')).toContain('--model model-b');
      expect((await lead('stop_agent', { id, reason: 'moving it to claude' })).isError).toBe(false);
      await expect.poll(() => alive(second.pid), { timeout: 30_000 }).toBe(false);

      // ── 5. Moved to claude, stopped: at its next start, a new conversation ──
      const moved = await lead('update_agent', { id, provider: 'claude', model: 'opus', effort: 'max', cliPath: claudeCli });
      keep({ moved, afterMove: recordOf(id) });
      expect(moved.isError, moved.text).toBe(false);
      expect(moved.text).toMatch(/next start/);
      expect(moved.text).toMatch(/new conversation/);
      await expect.poll(() => recordOf(id), { timeout: 10_000 }).toMatchObject({ provider: 'claude', model: 'opus', effort: 'max', cliPath: claudeCli });

      // ── 6. Started: claude on opus at max, a new session ──
      const third = await lead('start_agent', { id, prompt: 'CLAUDE>> third task' });
      expect(third.isError).toBe(false);
      const thirdTask = /\bt-[0-9a-f]{8}\b/.exec(third.text)?.[0];
      expect(thirdTask, third.text).toBeTruthy();
      await expect.poll(() => launchesOf(id, 'claude').length, { timeout: 60_000 }).toBe(1);
      const onClaude = launchesOf(id, 'claude')[0];
      expect(onClaude).toMatchObject({ model: 'opus', effort: 'max', resume: null });
      await expect.poll(async () => (await agentNow(id))?.currentSessionId ?? null, { timeout: 60_000 }).toBe(onClaude.sid);
      await expect.poll(async () => (await agentNow(id))?.status, { timeout: 60_000 }).toMatch(/^(idle|completed|waiting)$/);
      // Its task over, as the ledger closes it once its turn's end is read (a moment after the status, under load more).
      await expect.poll(async () => (await lead('task_status', { taskId: thirdTask })).text, { timeout: 60_000 }).toMatch(/: completed\b/);

      // ── 7. Its effort changed at rest: restarted on low, on its conversation ──
      // Applied at once; or, in the moment between its task's close and the release of the run (its answer being read),
      // queued behind that run and applied as it ends. Either way, the same restart.
      const lowered = await lead('update_agent', { id, effort: 'low' });
      keep({ lowered });
      expect(lowered.isError, lowered.text).toBe(false);
      expect(lowered.text).toMatch(/same conversation|the delegated run it holds ends/);
      await expect.poll(() => launchesOf(id, 'claude').length, { timeout: 60_000 }).toBe(2);
      const restarted = launchesOf(id, 'claude')[1];
      keep({ claudeLaunches: launchesOf(id, 'claude') });
      expect(restarted).toMatchObject({ effort: 'low', model: 'opus', resume: onClaude.sid, fork: true });

      // ── 8. Refused, and nothing written ──
      const before = { o1: recordOf('o1'), far: recordOf('far'), mover: recordOf(id) };
      const byWorker = await worker('update_agent', { id, permissionMode: 'plan' });
      const otherProject = await lead('update_agent', { id: 'far', permissionMode: 'plan' });
      const itself = await lead('update_agent', { id: 'o1', permissionMode: 'plan' });
      keep({ byWorker, otherProject, itself });
      expect(byWorker.isError).toBe(true);
      expect(byWorker.text).toContain('worker_may_not_update');
      expect(otherProject.isError).toBe(true);
      expect(otherProject.text).toContain('other_project');
      expect(itself.isError).toBe(true);
      expect(itself.text).toContain('orchestrator_settings');
      const strip = (r: Record<string, unknown> | undefined) => ({ model: r?.model, effort: r?.effort, provider: r?.provider, role: r?.role, cliPath: r?.cliPath });
      expect(strip(recordOf('o1'))).toEqual(strip(before.o1));
      expect(strip(recordOf('far'))).toEqual(strip(before.far));
      expect(strip(recordOf(id))).toEqual(strip(before.mover));
      keep({ finalRecords: records().map((a) => ({ id: a.id, provider: a.provider, model: a.model, effort: a.effort, cliPath: a.cliPath, role: a.role })) });
    } finally {
      for (const server of servers) server.kill();
      await app.close();
      if (fs.existsSync(launchesFile)) fs.copyFileSync(launchesFile, test.info().outputPath('launches.jsonl'));
      for (const l of fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8').trim().split('\n').filter(Boolean).map((x) => JSON.parse(x) as Launch) : []) {
        if (alive(l.pid)) process.kill(l.pid, 'SIGKILL');
      }
      await removeHome(home);
    }
  });
}
