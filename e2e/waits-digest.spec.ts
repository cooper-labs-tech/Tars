import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * One digest instead of the "still waits ... minutes on" notices (2.0.6, option b).
 *
 * The defect: each message that waited behind an agent's work told its sender on its own, ten minutes on: a sender
 * with ten messages waiting was woken ten times. Now a sender hears of them in one digest at most every 30 minutes, a
 * line each (to whom, since when, why).
 *
 * The real app on a sandbox HOME, its waits' minute shortened to MINUTE_MS (DOROTHY_WAITS_MINUTE_MS, under DOROTHY_E2E):
 * a wait behind work is due after 10 of them, the digest's period is 30. The real orchestrator MCP server
 * (mcp-orchestrator/dist/bundle.js) runs as the orchestrator `lead` and as the worker `dev`. w1, w2, w3 are claude
 * workers whose CLI is a stand-in named `claude` that runs Tars's hooks around each turn, RUN_S long. dev's terminal is
 * a stand-in that records every write with its time: the notices Tars types for it.
 *
 * Asserted, once with the classic shell and once with the new interface:
 * a. lead puts w1, w2, w3 to work; dev's send_message to w1 and w2 during their turns are notes that wait for the turn's
 *    end;
 * b. 10 minutes on, dev hears of what is due then, w1 at least (w2, sent a moment after, may fall due a moment later and
 *    wait for the 30, as W1 holds in the units);
 * c. dev's note to w3, sent after that notice, falls due 10 minutes later, inside the 30: dev hears nothing until the
 *    30 are over, then one notice with the three lines.
 * Red on 51e902884 (main, 2.0.5): each note tells dev on its own, 10 real minutes on, so nothing comes in the run and b
 * fails. Red on the mutant that drops the digest's period (a sender told whenever a line is new): w3's line comes alone,
 * inside the 30, and c fails.
 * The artefact: values.json (the tool answers, every notice dev received with its time), a screenshot, the app's trace
 * with E2E_TRACE=on.
 */

const MINUTE_MS = 1000;
const RUN_S = 75;

const HOOKS = path.resolve('hooks');

/** A worker's CLI, a stand-in named `claude`: Tars's hooks around each turn, a transcript, each turn RUN_S long. */
const TURN_STAND_IN = (log: string) => String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const sid = crypto.randomUUID();
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
const log = (entry) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(${JSON.stringify(HOOKS)}, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: process.env, timeout: 20000,
});
const reply = (text) => fs.appendFileSync(transcript, JSON.stringify({
  type: 'assistant', timestamp: new Date().toISOString(), message: { id: crypto.randomUUID(), role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } },
}) + '\n');
const tag = (line) => (line.match(/(TASK|NOTE)-[A-Z0-9]+/) ?? ['?'])[0];
let busy = false;
async function turn(prompt) {
  busy = true;
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  log({ prompt: tag(prompt) });
  await new Promise((r) => setTimeout(r, ${RUN_S} * 1000));
  reply('done');
  log({ answered: tag(prompt) });
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
  busy = false;
}
hook('session-start.sh', { hook_event_name: 'SessionStart', source: 'startup' });
log({ launched: true });
process.stdout.write('stand-in ready\n');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
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
      if (!line.trim()) continue;
      if (busy) log({ folded: tag(line) });
      else turn(line);
    }
  }
});
process.stdin.resume();
`;

/** dev's terminal: records every write, with its time. */
const RECORDER = (file: string) => [
  `#!${process.execPath}`,
  "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
  `process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(file)}, JSON.stringify({ at: Date.now(), data: d.toString() }) + '\\n'));`,
  "process.stdout.write('stand-in ready\\n');",
  '',
].join('\n');

type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Array<{ id: string; cliRunning?: boolean }>> };
} };
type ToolAnswer = { text: string; isError: boolean };

/** The orchestrator MCP server with one agent's identity, as Tars hands it to that agent's CLI. */
function mcpAs(home: string, project: string, port: string, agentId: string, token: string, instance: string) {
  const mcp: ChildProcessWithoutNullStreams = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
    env: {
      PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: token,
      CLAUDE_AGENT_ID: agentId, CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: instance,
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

for (const newInterface of [false, true]) {
  test(`what still waits is told its sender in one digest, at most every 30 minutes${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-waits-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const workerLog = path.join(home, 'workers.jsonl');
    const workerCli = path.join(bin, 'claude');
    fs.writeFileSync(workerCli, `#!${process.execPath}\n${TURN_STAND_IN(workerLog)}`, { mode: 0o755 });
    const devReceived = path.join(home, 'dev.received.jsonl');
    const devCli = path.join(home, 'dev-cli.cjs');
    fs.writeFileSync(devCli, RECORDER(devReceived), { mode: 0o755 });
    const agent = (id: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, projectPath: project, skills: [], permissionMode: 'auto',
      createdAt: '2026-10-29T08:00:00.000Z', lastActivity: '2026-10-29T08:00:00.000Z', ...extra,
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent('lead', 'Project Lead', 'orchestrator'),
      agent('dev', 'Dev Agent', 'worker', { cliPath: devCli }),
      agent('w1', 'Worker One', 'worker', { cliPath: workerCli }),
      agent('w2', 'Worker Two', 'worker', { cliPath: workerCli }),
      agent('w3', 'Worker Three', 'worker', { cliPath: workerCli }),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { additionalPaths: [bin] }, newInterface,
    }));
    const port = apiPort(newInterface ? 31400 : 31416);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { newInterface, minuteMs: MINUTE_MS, runSeconds: RUN_S };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const steps = () => (fs.existsSync(workerLog) ? fs.readFileSync(workerLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) as Array<{ at: number; prompt?: string; launched?: boolean }>;
    const DIGEST = '[Tars] Your messages not yet in their terminal';
    /** Every notice dev received that is a digest of its waits, with when it came. */
    const digests = () => (fs.existsSync(devReceived) ? fs.readFileSync(devReceived, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [] as Array<{ at: number; data: string }>)
      .filter((w: { data: string }) => w.data.includes(DIGEST)) as Array<{ at: number; data: string }>;
    /** The old notices, one per message: none must come. */
    const singles = () => (fs.existsSync(devReceived) ? fs.readFileSync(devReceived, 'utf8') : '').split('[Tars] Your message to ').length - 1;

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', DOROTHY_WAITS_MINUTE_MS: String(MINUTE_MS) },
    });
    const servers: Array<{ kill(): void }> = [];
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });

      const running = async (id: string) => (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).find((a) => a.id === id)?.cliRunning ?? false;
      for (const id of ['dev', 'w1', 'w2', 'w3']) {
        await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), id);
        await expect.poll(() => running(id), { timeout: 30_000 }).toBe(true);
      }
      await expect.poll(() => steps().filter((e) => e.launched).length, { timeout: 30_000 }).toBe(3);
      const ids = await app.evaluate((_e, { dist }) => {
        const req = process.mainModule!.require;
        const tokens = req(`${dist}/core/agent-tokens.js`);
        const { agents } = req(`${dist}/core/agent-manager.js`);
        // dev's stand-in tells Tars nothing: its session is registered and at rest, as a Claude Code's at its prompt.
        const dev = agents.get('dev');
        dev.sessionRegisteredAt = new Date().toISOString();
        dev.status = 'idle';
        return { lead: tokens.mintRunToken('lead').token as string, dev: tokens.mintRunToken('dev').token as string, instance: tokens.tarsInstanceId() as string };
      }, { dist });
      const lead = mcpAs(home, project, port, 'lead', ids.lead, ids.instance);
      const dev = mcpAs(home, project, port, 'dev', ids.dev, ids.instance);
      servers.push(lead, dev);

      // a. The three workers at work, then dev's notes to two of them.
      const tasks = [];
      for (const [i, id] of ['w1', 'w2', 'w3'].entries()) tasks.push(await lead.call('send_message', { id, message: `TASK-${i + 1} a long review` }));
      await expect.poll(() => steps().filter((e) => e.prompt?.startsWith('TASK-')).length, { timeout: 30_000 }).toBe(3);
      const note1 = await dev.call('send_message', { id: 'w1', message: 'NOTE-1 the build is green' });
      const note2 = await dev.call('send_message', { id: 'w2', message: 'NOTE-2 the branch moved' });
      const sentAt = Date.now();

      // b. Ten minutes on: one digest, both lines.
      await expect.poll(() => digests().length, { timeout: 25 * MINUTE_MS }).toBe(1);
      const first = digests()[0];
      // c. A third note after that digest: due ten minutes on, inside the thirty.
      const note3 = await dev.call('send_message', { id: 'w3', message: 'NOTE-3 the gate passed' });
      const quietUntil = first.at + 30 * MINUTE_MS - 2 * MINUTE_MS;
      await page.waitForTimeout(Math.max(0, quietUntil - Date.now()));
      const digestsInWindow = digests().length;
      await expect.poll(() => digests().length, { timeout: 15 * MINUTE_MS }).toBe(2);
      const second = digests()[1];

      keep({ tasks, note1, note2, note3, sentAt, digests: digests(), singles: singles(), digestsInWindow, steps: steps() });
      await stepShot(page, newInterface ? 'agents-new-interface' : 'agents');

      expect.soft(note1.text).toContain('as a note for information');
      expect.soft(note3.text).toContain('as a note for information');
      // b.
      expect.soft(first.at - sentAt, 'the first digest came ten minutes on').toBeGreaterThanOrEqual(9 * MINUTE_MS);
      expect.soft(first.data).toContain('"Worker One"');
      // NOTE-2 went a moment after NOTE-1: due a moment later, it may wait for the 30, as the units' W1 holds.
      expect.soft(first.data).not.toContain('"Worker Three"');
      expect.soft(first.data).toMatch(/still waits for "Worker One"'s work to end/);
      // c.
      expect.soft(digestsInWindow, 'told again inside the thirty minutes').toBe(1);
      expect.soft(second.at - first.at, 'the second digest came once the thirty were over').toBeGreaterThanOrEqual(30 * MINUTE_MS - 1000);
      for (const name of ['"Worker One"', '"Worker Two"', '"Worker Three"']) expect.soft(second.data).toContain(name);
      expect.soft(singles(), 'a notice of its own for a message').toBe(0);
    } finally {
      for (const s of servers) s.kill();
      await app.close().catch(() => undefined);
      if (fs.existsSync(devReceived)) fs.copyFileSync(devReceived, test.info().outputPath('dev.received.jsonl'));
      await removeHome(home);
    }
  });
}
