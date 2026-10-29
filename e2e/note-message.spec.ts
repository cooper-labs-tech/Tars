import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A note is no task (2.0.6, option a): send_message with mode 'note' or 'note-now', from the orchestrator, is
 * labelled a note, creates no task and no end notice, and leaves the task in hand the asker's.
 *
 * The defect: a message for information had no mode of its own. Sent as a message, it was a task: a link to its
 * sender, a "has finished its turn" notice at its end, a task in the ledger under the sender's name.
 *
 * The real app on a sandbox HOME, and the real orchestrator MCP server (mcp-orchestrator/dist/bundle.js) run with the
 * identity of the orchestrator `lead`, spoken to over stdio as Claude Code speaks to it. `lead` has a terminal of its
 * own, a stand-in that records every byte typed into it: the notices Tars types for it. `oc` is a claude worker whose
 * CLI is a stand-in named `claude` that does what Claude Code does around a turn (Tars's own hook scripts, a
 * transcript line per reply), each turn RUN_S long; a line typed during a turn is taken into that turn, as Claude Code
 * takes it, and a line typed at rest opens a turn. Every step is logged with its time.
 *
 * Asserted, once with the classic shell and once with the new interface:
 * a. lead's send_message to oc with mode 'queue' (TASK-ONE) is a task: it runs, and lead's terminal is told once that
 *    oc has finished its turn;
 * b. during that turn, lead's send_message with mode 'note-now' (NOTE-NOW) is answered as a note, with no task id,
 *    and typed into the turn under way; with mode 'note' (NOTE-OPT), answered as a note that goes in once the turn
 *    ends, and typed only after TASK-ONE answered;
 * c. NOTE-OPT's own turn runs, and lead is told nothing of it: lead's terminal reads "has finished its turn" once in
 *    all, for TASK-ONE, which NOTE-NOW did not hide;
 * d. the ledger's task opened by NOTE-OPT's turn names no asker; TASK-ONE's names lead.
 * Red on 54d26ef37 (2.0.5): both notes are refused as invalid_mode. Red on the mutant that gives a note its sender's
 * link (onAccepted's requestFor in /dispatch): NOTE-OPT's end tells lead, c fails. Red on the mutant that records a
 * note's hand-off in the ledger (WriteOrigin.note ignored in pty-manager.ts): NOTE-OPT's turn takes NOTE-NOW's
 * hand-off and is lead's task, d fails (an earlier d, which looked for NOTE-OPT's words, missed it: bench2.log).
 * Green on the mutant that lets a note move the hand-off mark: the unit tests hold that one (N1, N2), and in the app
 * TASK-ONE's end is told lead either way.
 * The artefact: values.json (every tool answer, oc's log, the bytes lead received, the ledger's tasks), a screenshot
 * of the Usage page, the app's trace with E2E_TRACE=on.
 */

const RUN_S = 8;
/** After the last turn, how long lead's terminal is watched for a notice that must not come. */
const QUIET_S = 12;

const HOOKS = path.resolve('hooks');

/** oc's CLI, a stand-in named `claude`: hooks around each turn, a transcript, a line typed mid-turn taken into it. */
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
const tag = (line) => (line.match(/(TASK|NOTE)-[A-Z]+/) ?? ['?'])[0];
let busy = false;
async function turn(prompt) {
  busy = true;
  const task = tag(prompt);
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  log({ prompt: task });
  await new Promise((r) => setTimeout(r, ${RUN_S} * 1000));
  reply('answer for ' + task);
  log({ answered: task });
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'answer for ' + task });
  busy = false;
}
hook('session-start.sh', { hook_event_name: 'SessionStart', source: 'startup' });
log({ launched: true });
process.stdout.write('stand-in ready\n');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let buffer = '';
process.stdin.on('data', (data) => {
  buffer += data.toString();
  let end;
  while ((end = buffer.search(/[\r\n]/)) !== -1) {
    const line = buffer.slice(0, end).replace(/\x1b\[20[01]~/g, '');
    buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    if (busy) log({ folded: tag(line), line });
    else turn(line);
  }
});
process.stdin.resume();
`;

/** lead's terminal: records every byte typed into it. */
const STAND_IN = (file: string) => [
  `#!${process.execPath}`,
  "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
  `process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(file)}, d));`,
  "process.stdout.write('stand-in ready\\n');",
  '',
].join('\n');

type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Array<{ id: string; cliRunning?: boolean }>> };
  usage: { tasks(q?: { sinceDays?: number }): Promise<{ tasks: Array<{ id: string; agentId: string; requesterAgentId: string | null; source: string; outcome: string; text: string }> }> };
} };
type ToolAnswer = { text: string; isError: boolean };
type OcEntry = { at: number; launched?: boolean; prompt?: string; answered?: string; folded?: string; line?: string };

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
  test(`a note is no task: labelled, typed when asked, and no end notice for it${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-note-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const ocLog = path.join(home, 'oc-turns.jsonl');
    const ocCli = path.join(bin, 'claude');
    fs.writeFileSync(ocCli, `#!${process.execPath}\n${TURN_STAND_IN(ocLog)}`, { mode: 0o755 });
    const leadReceived = path.join(home, 'lead.received');
    const leadCli = path.join(home, 'lead-cli.cjs');
    fs.writeFileSync(leadCli, STAND_IN(leadReceived), { mode: 0o755 });
    const agent = (id: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, projectPath: project, skills: [], permissionMode: 'auto',
      createdAt: '2026-10-29T08:00:00.000Z', lastActivity: '2026-10-29T08:00:00.000Z', ...extra,
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent('lead', 'Project Lead', 'orchestrator', { cliPath: leadCli }),
      agent('oc', 'Review Agent', 'worker', { cliPath: ocCli }),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { additionalPaths: [bin] }, newInterface,
    }));
    const port = apiPort(newInterface ? 31414 : 31415);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { newInterface, runSeconds: RUN_S, quietSeconds: QUIET_S };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const ocSteps = () => (fs.existsSync(ocLog) ? fs.readFileSync(ocLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) as OcEntry[];
    const leadBytes = () => (fs.existsSync(leadReceived) ? fs.readFileSync(leadReceived, 'utf8') : '');
    const notices = () => leadBytes().split('has finished its turn').length - 1;

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    const servers: Array<{ kill(): void }> = [];
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });

      // Both terminals, started from the window: lead's records what it is told, oc's runs turns.
      const running = async (id: string) => (await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list())).find((a) => a.id === id)?.cliRunning ?? false;
      for (const id of ['lead', 'oc']) {
        await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), id);
        await expect.poll(() => running(id), { timeout: 30_000 }).toBe(true);
      }
      await expect.poll(() => ocSteps().some((e) => e.launched), { timeout: 30_000 }).toBe(true);
      const ids = await app.evaluate((_e, { dist }) => {
        const req = process.mainModule!.require;
        const tokens = req(`${dist}/core/agent-tokens.js`);
        const { agents } = req(`${dist}/core/agent-manager.js`);
        // lead's stand-in tells Tars nothing: its session is registered and at rest, as a Claude Code's at its prompt.
        const lead = agents.get('lead');
        lead.sessionRegisteredAt = new Date().toISOString();
        lead.status = 'idle';
        return { lead: tokens.mintRunToken('lead').token as string, instance: tokens.tarsInstanceId() as string };
      }, { dist });
      const lead = mcpAs(home, project, port, 'lead', ids.lead, ids.instance);
      servers.push(lead);

      // a. A message is a task.
      const task = await lead.call('send_message', { id: 'oc', message: 'TASK-ONE review the notes', mode: 'queue' });
      await expect.poll(() => ocSteps().some((e) => e.prompt === 'TASK-ONE'), { timeout: 30_000 }).toBe(true);

      // b. Two notes during its turn: one now, one at the turn's end.
      const noteNow = await lead.call('send_message', { id: 'oc', message: 'NOTE-NOW the build is green', mode: 'note-now' });
      const noteOpt = await lead.call('send_message', { id: 'oc', message: 'NOTE-OPT the release is cut', mode: 'note' });

      // c. TASK-ONE ends, NOTE-OPT's turn runs and ends, then lead's terminal is watched for a notice that must not come.
      await expect.poll(() => ocSteps().some((e) => e.answered === 'TASK-ONE'), { timeout: 60_000 }).toBe(true);
      await expect.poll(() => notices(), { timeout: 30_000 }).toBeGreaterThanOrEqual(1).catch(() => undefined);
      const noticesAfterTask = notices();
      await expect.poll(() => ocSteps().some((e) => e.answered === 'NOTE-OPT'), { timeout: 60_000 }).toBe(true).catch(() => undefined);
      await page.waitForTimeout(QUIET_S * 1000);

      const steps = ocSteps();
      const report = await page.evaluate(() => (window as unknown as Api).electronAPI.usage.tasks({ sinceDays: 1 }));
      const tasks = report.tasks.filter((t) => t.agentId === 'oc');
      const link = await app.evaluate((_e, { dist }) => {
        const a = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get('oc');
        return { requestedBy: a.requestedBy ?? null, workHandedAt: a.workHandedAt ?? null };
      }, { dist });
      keep({ task, noteNow, noteOpt, ocSteps: steps, leadBytes: leadBytes(), noticesAfterTask, notices: notices(), tasks, link });
      await page.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await stepShot(page, newInterface ? 'usage-new-interface' : 'usage');

      // a. The message ran as a task.
      expect.soft(task.isError, task.text).toBe(false);
      // b. Both notes answered as notes, no task id; NOTE-NOW typed into the turn, NOTE-OPT after it.
      expect.soft(noteNow.isError, noteNow.text).toBe(false);
      expect.soft(noteNow.text).toContain('as a note for information, not a task: it is in its terminal');
      expect.soft(noteNow.text).not.toMatch(/t-[0-9a-f]{8}/);
      expect.soft(noteOpt.isError, noteOpt.text).toBe(false);
      expect.soft(noteOpt.text).toContain('as a note for information, not a task: it goes in once its current turn ends');
      expect.soft(noteOpt.text).not.toMatch(/t-[0-9a-f]{8}/);
      const at = (pick: (e: OcEntry) => boolean) => steps.find(pick)?.at ?? NaN;
      const taskEnd = at((e) => e.answered === 'TASK-ONE');
      expect.soft(at((e) => e.folded === 'NOTE-NOW'), 'NOTE-NOW typed into the turn under way').toBeLessThan(taskEnd);
      expect.soft(steps.find((e) => e.folded === 'NOTE-NOW')?.line ?? '', 'labelled a note from lead').toMatch(/Note for information from "Project Lead", your project's orchestrator: it is not a task/);
      expect.soft(steps.some((e) => e.folded === 'NOTE-OPT'), 'NOTE-OPT never typed into the turn').toBe(false);
      expect.soft(at((e) => e.prompt === 'NOTE-OPT'), 'NOTE-OPT typed once TASK-ONE answered').toBeGreaterThanOrEqual(taskEnd);
      expect.soft(at((e) => e.answered === 'NOTE-OPT'), "NOTE-OPT's turn ran").toBeGreaterThan(taskEnd);
      // c. One notice in all, for TASK-ONE: NOTE-NOW did not hide it, NOTE-OPT's turn added none.
      expect.soft(noticesAfterTask, "TASK-ONE's end told lead").toBe(1);
      expect.soft(notices(), "NOTE-OPT's end told lead nothing").toBe(1);
      // d. The ledger: lead asked one task, TASK-ONE; the turn NOTE-OPT opened is a task of nobody's, under whichever
      // text a hand-off would have given it (a note's hand-off taken by that turn reads NOTE-NOW's words).
      const askedByLead = tasks.filter((t) => t.requesterAgentId === 'lead');
      expect.soft(askedByLead.map((t) => t.text), JSON.stringify(tasks)).toEqual(['TASK-ONE review the notes']);
      expect.soft(tasks.length, "NOTE-OPT's turn is a task of the ledger's").toBe(2);
    } finally {
      for (const s of servers) s.kill();
      await app.close().catch(() => undefined);
      if (fs.existsSync(ocLog)) fs.copyFileSync(ocLog, test.info().outputPath('oc-turns.jsonl'));
      await removeHome(home);
    }
  });
}
