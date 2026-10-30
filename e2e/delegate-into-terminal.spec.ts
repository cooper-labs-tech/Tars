import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * delegate_task gives the task to the agent's own permanent terminal (2.0.4, the maintainer's decision of
 * 2026-10-18: "the whole point of Tars is permanent agents, absolutely not ephemeral ones").
 *
 * The real app on a sandbox HOME, and the real orchestrator MCP server (mcp-orchestrator/dist/bundle.js) run with
 * the identity Tars hands agent `lead`, spoken to over stdio as Claude Code speaks to it. Agent `dev` is a claude
 * agent whose CLI is a stand-in named `claude` that does what Claude Code does around a turn: it runs Tars's own
 * hook scripts (SessionStart, UserPromptSubmit, Stop) and writes its replies, with their usage, in the transcript
 * where Claude Code keeps it. Its answer to a task is longer than the 4000 bytes the hooks keep. Agent `oc` is an
 * opencode agent and `ap` an amp agent, whose CLIs are stand-ins with no hook at all, which log how they were launched
 * and what is typed into them.
 *
 * Asserted, once with the classic shell and once with the new interface:
 * 1. a delegation to `dev` goes into the terminal its card shows: the stand-in started from the window gets it,
 *    in the session it registered, and no other `claude` is launched;
 * 2. the answer returned is the transcript's final message for that task, in full (past 4000 bytes), with its end
 *    reason, tokens and cost;
 * 3. a second delegation given while the first works is queued, the window's banner shows the task in hand (who
 *    gave it, its first line) and the one waiting, and the second returns its own answer once the first is done;
 * 4. the agent's one conversation then holds both tasks, in order, under one session;
 * 5. a delegation to `oc`, whose CLI gives Tars no hook, starts its permanent session with the task and is said
 *    delivered, with what Tars does not read (no answer, tokens or cost invented); its session is the TUI with the
 *    task as `--prompt`, never `opencode run`, which exits after the task;
 * 5b. a delegation to `ap` (amp, no interactive form that takes a prompt) starts its TUI with no `-x`, which exits
 *    after the task, and the task is typed into it once it runs;
 * 6. start_agent, the deprecated alias, answers at once with a task id, and the task goes into the same terminal;
 * 7. (the Audit's M2 on #461) an Esc cuts a task's turn: Claude Code 2.1.302 puts the cut prompt back into an empty
 *    field (auto_restore_cancel), and the stand-in does too. The task ends interrupted, and the next one goes in
 *    alone, never sent with the cut one.
 * Red on main (9df7c099): delegate_task tries a run over ACP first, a hidden copy of dev outside its terminal; with
 * no ACP agent there it falls back to typing, and returns the hooks' copy, cut at 4000 bytes, with no tokens or cost.
 * The artefact: values.json (every tool answer, the stand-ins' logs, dev's transcript, the ledger's tasks, the
 * banner as read), screenshots of the Usage page, the app's trace with E2E_TRACE=on.
 */

const HOOKS = path.resolve('hooks');
const LONG = `The release notes are reviewed. ${'Every section was read against the changelog and the code. '.repeat(90)}END-OF-ANSWER`;

/** Claude Code around each turn: its hooks, and one transcript line per reply, with text and usage. */
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
const reply = (text, input, output) => fs.appendFileSync(transcript, JSON.stringify({
  type: 'assistant', requestId: 'req_' + id + '_' + (++n), timestamp: new Date().toISOString(),
  message: { id: 'msg_' + id + '_' + n, role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }], usage: { input_tokens: input, output_tokens: output } },
}) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cancelTurn = null;
async function turn(prompt) {
  log({ turn: prompt });
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  fs.appendFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } }) + '\n');
  reply('Reading it now.', 100000, 0);
  if (prompt.includes('HALT')) {
    // Esc in a turn, as Claude Code 2.1.302 does it: the turn ends with no Stop, the transcript says so, and an
    // empty field gets the cut prompt back (auto_restore_cancel).
    await new Promise((r) => { cancelTurn = r; setTimeout(r, 60000); });
    cancelTurn = null;
    fs.appendFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }) + '\n');
    if (buffer === '') buffer = prompt;
    log({ cancelled: prompt, field: buffer });
    return;
  }
  if (prompt.includes('SLOW')) await sleep(12000);
  if (prompt.includes('LONG')) reply(LONG, 400000, 100000);
  else reply('Second task done: the tests pass.', 200000, 50000);
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
}

hook('session-start.sh', { hook_event_name: 'SessionStart', source: 'startup' });
log({ launched: process.argv.slice(2) });
process.stdout.write('stand-in ready\n');
process.stdin.setRawMode(true);
let buffer = '';
let queue = Promise.resolve();
const dashes = process.argv.indexOf('--');
if (dashes !== -1 && process.argv.slice(dashes + 1).join(' ').trim()) queue = queue.then(() => turn(process.argv.slice(dashes + 1).join(' ')));
let pasting = false;
process.stdin.on('data', (data) => {
  const typed = data.toString();
  if (typed === '\x1b' && cancelTurn) { cancelTurn(); return; }
  // Enter outside a paste ends a message: since #569 the sender line ends its own line inside its paste, as in claude.
  for (const piece of typed.split(/(\x1b\[20[01]~)/)) {
    if (piece === '\x1b[200~') { pasting = true; continue; }
    if (piece === '\x1b[201~') { pasting = false; continue; }
    for (const ch of piece) {
      if ((ch === '\r' || ch === '\n') && !pasting) {
        const line = buffer;
        buffer = '';
        if (line.trim()) queue = queue.then(() => turn(line));
      } else buffer = ch === '\x7f' ? buffer.slice(0, -1) : ch === '\x03' ? '' : buffer + ch;
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

type Banner = { task: { ref: string; from: string; startedAt: string; firstLine: string } | null; waiting: Array<{ ref: string; from: string; firstLine: string }> };
type Agent = { id: string; status: string; cliRunning?: boolean; currentSessionId?: string; taskBanner?: Banner };
type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]>; get(id: string): Promise<Agent | null> };
  usage: { tasks(q?: { sinceDays?: number }): Promise<{ tasks: Array<{ id: string; agentId: string; source: string; requesterAgentId: string | null; outcome: string; sessionIds: string[]; costUSD: number | null }> }> };
} };

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

for (const newInterface of [false, true]) {
  test(`delegate_task gives the task to the agent's own terminal and returns its full answer${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(480_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-delegate-terminal-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const claude = path.join(bin, 'claude');
    fs.writeFileSync(claude, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\nconst LONG = ${JSON.stringify(LONG)};\n${STAND_IN}`, { mode: 0o755 });
    const opencode = path.join(bin, 'opencode');
    fs.writeFileSync(opencode, `#!${process.execPath}\n${NO_HOOK_CLI}`, { mode: 0o755 });
    const amp = path.join(bin, 'amp');
    fs.writeFileSync(amp, `#!${process.execPath}\n${NO_HOOK_CLI}`, { mode: 0o755 });
    const agent = (id: string, name: string, role: string, provider: string, cliPath: string) => ({
      id, name, character: 'robot', provider, status: 'idle', role, projectPath: project, skills: [], permissionMode: 'normal', cliPath,
      createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent('lead', 'Project Lead', 'orchestrator', 'claude', claude),
      agent('dev', 'Build Agent', 'worker', 'claude', claude),
      agent('oc', 'Review Agent', 'worker', 'opencode', opencode),
      agent('ap', 'Amp Agent', 'worker', 'amp', amp),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { additionalPaths: [bin] }, newInterface,
    }));
    fs.writeFileSync(path.join(dir, 'model-catalog.json'), JSON.stringify({
      anthropic: { models: { 'claude-opus-5': { id: 'claude-opus-5', name: 'Claude Opus 5', cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 } } } },
    }));
    fs.writeFileSync(path.join(dir, 'model-catalog.meta.json'), JSON.stringify({ fetchedAt: Date.now() }));
    const port = apiPort(newInterface ? 31421 : 31422);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { newInterface, answerBytes: Buffer.byteLength(LONG) };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    let mcp: ChildProcessWithoutNullStreams | undefined;
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
      const get = (id: string) => page.evaluate((i) => (window as unknown as Api).electronAPI.agent.get(i), id);

      // dev's permanent session, started from the window, as its card shows it.
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'dev', prompt: '' }));
      await expect.poll(async () => { const a = await get('dev'); return !!(a?.cliRunning && a.currentSessionId); }, { timeout: 60_000 }).toBe(true);
      const devSession = (await get('dev'))!.currentSessionId;

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

      // 1 to 3. Two delegations at once: the first works for 12 s, the second waits its turn.
      const first = tool('delegate_task', { id: 'dev', prompt: 'SLOW LONG review the release notes', timeoutSeconds: 240, clientRequestId: `e2e-into-terminal-1-${newInterface}` });
      // In dev's terminal (an older Tars tries a run over ACP first, and falls back to the terminal when it fails).
      const devTurnsWith = (mark: string) => lines(path.join(home, 'stand-in.jsonl')).filter((e) => e.id === 'dev' && typeof e.turn === 'string' && e.turn.includes(mark));
      await expect.poll(() => devTurnsWith('SLOW LONG').length, { timeout: 180_000 }).toBe(1);
      const second = tool('delegate_task', { id: 'dev', prompt: 'run the tests', timeoutSeconds: 240, clientRequestId: `e2e-into-terminal-2-${newInterface}` });
      let banner: Banner | undefined;
      await expect.configure({ soft: true }).poll(async () => {
        banner = (await get('dev'))?.taskBanner;
        return banner?.waiting.length ?? 0;
      }, { timeout: 15_000, message: 'the banner shows the second task waiting' }).toBe(1);
      const [one, two] = await Promise.all([first, second]);

      // 5. A CLI with no hook: its session is started with the task, and the task said delivered.
      const toOc = await tool('delegate_task', { id: 'oc', prompt: 'NOHOOK look at the logs', timeoutSeconds: 60 });
      // Its CLI writes its first line a moment after Tars answered: read once it has.
      await expect.poll(() => lines(path.join(home, 'opencode.jsonl')).filter((e) => e.launched).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      // 5b. amp: its TUI, then the task typed in once it runs.
      const toAmp = await tool('delegate_task', { id: 'ap', prompt: 'AMPTASK sort the inbox', timeoutSeconds: 60 });
      await expect.poll(() => JSON.stringify(lines(path.join(home, 'amp.jsonl')).filter((e) => e.typed)), { timeout: 30_000 }).toContain('AMPTASK sort the inbox');
      // 6. The deprecated alias: answered at once with a task id, into the same terminal.
      const started = await tool('start_agent', { id: 'dev', prompt: 'ALIAS tidy the changelog' });
      await expect.poll(() => lines(path.join(home, 'stand-in.jsonl')).filter((e) => typeof e.turn === 'string' && e.turn.includes('ALIAS')).length, { timeout: 30_000 }).toBe(1);
      // 7. An Esc cuts a task's turn, and Claude Code puts the cut prompt back into the field.
      const halted = tool('delegate_task', { id: 'dev', prompt: 'HALT-ME write the long report', timeoutSeconds: 120 });
      await expect.poll(() => devTurnsWith('HALT-ME').length, { timeout: 60_000 }).toBe(1);
      await page.evaluate(() => (window as unknown as { electronAPI: { agent: { sendInput(p: { id: string; input: string }): Promise<unknown> } } }).electronAPI.agent.sendInput({ id: 'dev', input: '\x1b' }));
      const cutAnswer = await halted;
      const afterCut = await tool('delegate_task', { id: 'dev', prompt: 'AFTERCUT one more thing', timeoutSeconds: 120 });
      const afterTurns = devTurnsWith('AFTERCUT');
      keep({ cutAnswer, afterCut, afterTurns });
      expect.soft(cutAnswer.text).toContain('ended: interrupted');
      expect.soft(afterCut.text).toContain('Second task done');
      expect.soft(afterTurns.length, 'turns that carried the next task').toBe(1);
      expect.soft(afterTurns.map((e) => e.turn).join('\n'), 'the cut task sent again with the next').not.toContain('HALT-ME');

      const standIn = lines(path.join(home, 'stand-in.jsonl'));
      const noHook = lines(path.join(home, 'opencode.jsonl'));
      const ampLog = lines(path.join(home, 'amp.jsonl'));
      // Filed under the physical path the CLI runs in (/private/var on macOS), as Claude Code files it.
      const transcript = fs.readFileSync(path.join(home, '.claude', 'projects', fs.realpathSync(project).replace(/[^a-zA-Z0-9]/g, '-'), `${devSession}.jsonl`), 'utf8');
      const report = await page.evaluate(() => (window as unknown as Api).electronAPI.usage.tasks({ sinceDays: 1 }));
      keep({ one, two, toOc, toAmp, ampLog, started, banner, devSession, standIn, noHook, tasks: report.tasks, transcriptLines: transcript.trim().split('\n').length });
      await page.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      await stepShot(page, newInterface ? 'usage-new-interface' : 'usage');

      const devLaunches = standIn.filter((e) => e.id === 'dev' && e.launched);
      const devTurns = standIn.filter((e) => e.id === 'dev' && typeof e.turn === 'string');
      // 1. Into the terminal its card shows: one launch of dev's CLI, the window's; every task in its session.
      expect.soft(devLaunches.length, 'launches of dev\'s CLI').toBe(1);
      expect.soft(devTurns.map((e) => e.sid), 'sessions dev\'s tasks ran in').toEqual(devTurns.map(() => devSession));
      // Since #569 the sender line ends its own line, and the task is the line under it.
      expect.soft(devTurns[0]?.turn).toMatch(/^Message from agent "Project Lead" \("lead"\), task t-[0-9a-f]{8}: \nSLOW LONG review the release notes$/);
      // 2. The full final message, its end, tokens and cost.
      expect.soft(one.isError, one.text.slice(0, 300)).toBe(false);
      expect.soft(one.text).toContain(LONG);
      expect.soft(one.text).toContain('ended: end_turn');
      expect.soft(one.text).toContain('600000 tokens');
      expect.soft(one.text).toContain('$0.7000');
      // 3. The second waited its turn, shown on the banner, and returned its own answer.
      expect.soft(banner?.task).toMatchObject({ from: 'Project Lead', firstLine: 'SLOW LONG review the release notes' });
      expect.soft(banner?.waiting.map((w) => ({ from: w.from, firstLine: w.firstLine }))).toEqual([{ from: 'Project Lead', firstLine: 'run the tests' }]);
      expect.soft(two.isError, two.text.slice(0, 300)).toBe(false);
      expect.soft(two.text).toContain('Second task done: the tests pass.');
      expect.soft(two.text).not.toContain('END-OF-ANSWER');
      // 4. One conversation holds both, in order.
      expect.soft(devTurns.slice(0, 2).map((e) => /: \n(.*)$/.exec(e.turn)?.[1])).toEqual(['SLOW LONG review the release notes', 'run the tests']);
      expect.soft(transcript.indexOf('SLOW LONG review')).toBeLessThan(transcript.indexOf('run the tests'));
      const devTasks = report.tasks.filter((t) => t.agentId === 'dev' && t.requesterAgentId === 'lead');
      expect.soft(devTasks.length, 'dev\'s tasks from lead in the ledger').toBeGreaterThanOrEqual(2);
      expect.soft(devTasks.every((t) => t.sessionIds.every((s) => s === devSession))).toBe(true);
      // 5. No hook: started with the task, delivered, nothing invented.
      expect.soft(noHook.filter((e) => e.launched).length, 'launches of oc\'s CLI').toBe(1);
      expect.soft(JSON.stringify(noHook)).toContain('NOHOOK look at the logs');
      const ocArgv = (noHook.find((e) => e.launched)?.launched ?? []) as string[];
      expect.soft(ocArgv, 'opencode started as its TUI, with the task as --prompt').toContain('--prompt');
      expect.soft(ocArgv[ocArgv.indexOf('--prompt') + 1] ?? '').toContain('NOHOOK look at the logs');
      expect.soft(ocArgv, 'opencode run exits after the task').not.toContain('run');
      expect.soft(toOc.isError).toBe(false);
      expect.soft(toOc.text).toMatch(/^Task t-[0-9a-f]{8}: The task went into Review Agent's terminal\./);
      expect.soft(toOc.text).toMatch(/cannot see when its turn ends/);
      expect.soft(toOc.text).not.toMatch(/\d tokens|\$\d/);
      // 5b. amp: one launch, no -x, the task typed in, said delivered.
      const ampLaunches = ampLog.filter((e) => e.launched);
      expect.soft(ampLaunches.length, 'launches of ap\'s CLI').toBe(1);
      expect.soft(ampLaunches[0]?.launched ?? [], 'amp -x exits after the task').not.toContain('-x');
      expect.soft(JSON.stringify(ampLaunches[0]?.launched ?? []), 'the task on amp\'s command line').not.toContain('AMPTASK');
      expect.soft(ampLog.filter((e) => typeof e.typed === 'string' && e.typed.includes('AMPTASK')).length, 'the task typed into amp').toBeGreaterThanOrEqual(1);
      expect.soft(toAmp.isError).toBe(false);
      expect.soft(toAmp.text).toMatch(/Amp Agent's terminal/);
      // 6. The alias.
      expect.soft(started.isError).toBe(false);
      expect.soft(started.text).toMatch(/Task t-[0-9a-f]{8}/);
    } finally {
      mcp?.kill();
      await app.close();
      for (const f of ['stand-in.jsonl', 'opencode.jsonl', 'amp.jsonl']) if (fs.existsSync(path.join(home, f))) fs.copyFileSync(path.join(home, f), test.info().outputPath(f));
      await removeHome(home);
    }
  });
}
