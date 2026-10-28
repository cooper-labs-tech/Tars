import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A task goes into an agent once (the DB brief fix-twin-deliveries-2810.md, the orchestrators' feedback of 28/10), in
 * the real app.
 *
 * Measured over the transcripts of 23 to 28/10 (reports/fix-twin-deliveries-2810.md):
 * - a launch task retyped by Tars into the session that already held it ("Message from Tars: [Tars: you are agent
 *   ..."), 300 s, 894 s and 3899 s after the first: the delivery check typed it again 15 s after the session
 *   registered, while the CLI's UserPromptSubmit hooks still ran (36 s under load on 27/10), and the CLI queued the
 *   copy and ran it later as a second turn; then it read the agent `error`, "never began";
 * - a note "has ended its turn with background work still running" typed twice into Parallel's orchestrator,
 *   18 times in 4 days, the second each time on the worker's idle prompt (Claude Code's, 60 s after its rest).
 *
 * The ways this fails, each checked on its own (soft):
 * F1 a task the CLI takes 40 s late (its UserPromptSubmit hooks slow) is typed into it again, or the agent is said
 *    `error` / never began;
 * F2 (regression net) a task the CLI really dropped (idle at its prompt, nothing of it in its transcript) is never
 *    typed again, or is typed twice;
 * F3 a stop then a start leaves two live CLIs of one agent;
 * F4 the note that a worker ended its turn with background work still running reaches its requester twice.
 *
 * The CLIs are stand-ins named `claude` (node scripts) that run Tars's own hooks, keep a transcript as Claude Code
 * does (the prompt's entry written once its UserPromptSubmit hooks end), take their launch prompt, and record every
 * prompt they are handed, typed while busy included.
 */

type Api = { electronAPI: { agent: {
  start(p: { id: string; prompt: string }): Promise<unknown>;
  stop(id: string): Promise<unknown>;
  get(id: string): Promise<{ id: string; status: string; error?: string; cliRunning?: boolean }>;
  list(): Promise<Array<{ id: string; cliRunning?: boolean; currentSessionId?: string; status: string }>>;
  sendInput(p: { id: string; input: string }): Promise<unknown>;
} } };

const HOOKS = path.resolve('hooks');

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const id = process.env.CLAUDE_AGENT_ID;
const args = process.argv.slice(2);
const resumed = args.indexOf('--resume');
const sid = resumed === -1 ? crypto.randomUUID() : args[resumed + 1];
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, '');
const record = (file, o) => fs.appendFileSync(path.join(process.env.HOME, file), JSON.stringify({ at: new Date().toISOString(), id, ...o }) + '\n');
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(HOOKS, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: process.env, timeout: 20000,
});
const line = (o) => fs.appendFileSync(transcript, JSON.stringify({ sessionId: sid, timestamp: new Date().toISOString(), ...o }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dashes = args.indexOf('--');
const launchPrompt = dashes === -1 ? '' : args.slice(dashes + 1).join(' ');
record('launches.jsonl', { pid: process.pid, sid, prompt: launchPrompt });
let busy = false;
/** Claude Code at rest at its prompt for a while: its idle_prompt notification. */
const idlePrompt = () => hook('notification.sh', { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });

async function turn(prompt) {
  busy = true;
  record('prompts.jsonl', { sid, prompt });
  // Its UserPromptSubmit hooks slow (a loaded machine): the prompt's entry and the post come 40 s late.
  if (prompt.includes('SLOW>>')) await sleep(40000);
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', message: { role: 'user', content: prompt } });
  // Told to call Tars's API with its own terminal's token, as its MCP tools do.
  const call = /CALL>> (\S+) (\S+)(?: (.*))?$/.exec(prompt);
  if (call) {
    const answer = await fetch(process.env.CLAUDE_MGR_API_URL + call[2], {
      method: call[1], headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN, 'X-Tars-Caller-Id': id },
      ...(call[1] === 'GET' ? {} : { body: call[3] || '{}' }),
    });
    record('calls.jsonl', { status: answer.status });
  }
  // A background task left running at the end of the turn.
  if (prompt.includes('BG>>')) {
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Bash', input: { command: 'sleep 600', run_in_background: true } }] } });
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'Command running in background with ID: bgjob1' }] }, toolUseResult: { backgroundTaskId: 'bgjob1' } });
  }
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  await sleep(200);
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
  line({ type: 'system', subtype: 'turn_duration', durationMs: 1 });
  busy = false;
  // At rest at its prompt: Claude Code says so, 60 s on.
  if (prompt.includes('BG>>')) { await sleep(62000); idlePrompt(); record('idle-prompted.jsonl', { sid }); }
}

process.stdin.setRawMode(true);
hook('session-start.sh', { hook_event_name: 'SessionStart', source: resumed === -1 ? 'startup' : 'resume' });
process.stdout.write('SCREEN-OF-' + id + '\r\n> ');
let buffer = '';
let pasting = false;
let queue = Promise.resolve();
// A launch prompt it drops: it sits at its prompt, idle, and says so.
if (launchPrompt.includes('DROP>>')) { record('dropped.jsonl', { sid }); setTimeout(idlePrompt, 3000); }
else if (launchPrompt.trim()) queue = queue.then(() => turn(launchPrompt));
process.stdin.on('data', (data) => {
  for (const piece of data.toString().split(/(\x1b\[20[01]~)/)) {
    if (piece === '\x1b[200~') { pasting = true; continue; }
    if (piece === '\x1b[201~') { pasting = false; continue; }
    for (const ch of piece) {
      if (ch === '\r' && !pasting) {
        const typed = buffer;
        buffer = '';
        if (typed.trim()) { record('typed.jsonl', { sid, busy, prompt: typed }); queue = queue.then(() => turn(typed)); }
      } else buffer += ch;
    }
  }
});
process.stdin.resume();
`;

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !String(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)])).trim().startsWith('Z'); } catch { return false; }
};

test.skip(process.platform === 'win32', 'the stand-ins are typed into a POSIX shell, and the CLI count reads ps; the rules are platform-free and their unit tests (delivery-proof.test.ts, agent-watch.test.ts) run everywhere');

for (const newInterface of [false, true]) {
  test(`a task goes into an agent once${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(300_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-once-${newInterface ? 'ni' : 'classic'}-`));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const cli = path.join(bin, 'claude');
    fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`, { mode: 0o755 });
    const agent = (id: string, name: string, role = 'worker') => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, permissionMode: 'normal',
      projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'Project Lead', 'orchestrator'), agent('slow', 'Slow Hooks'), agent('drop', 'Dropper'), agent('bg', 'Background Worker'), agent('again', 'Stopped And Started')], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const port = apiPort(31510 + (newInterface ? 1 : 0));
    const seen: Record<string, unknown> = { newInterface };
    const soft = expect.soft;
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      const start = (id: string, prompt: string) => page.evaluate((p) => (window as unknown as Api).electronAPI.agent.start(p), { id, prompt });
      const get = (id: string) => page.evaluate((i) => (window as unknown as Api).electronAPI.agent.get(i), id);
      const type = (id: string, input: string) => page.evaluate((p) => (window as unknown as Api).electronAPI.agent.sendInput(p), { id, input });
      const handed = (who: string, word: string) => lines(path.join(home, 'prompts.jsonl')).filter((p) => p.id === who && String(p.prompt).includes(word));
      const typedInto = (who: string, word: string) => lines(path.join(home, 'typed.jsonl')).filter((p) => p.id === who && String(p.prompt).includes(word));

      // Every scenario at once.
      await start('lead', '');
      await start('slow', 'SLOW>> the slow task');
      await start('drop', 'DROP>> the dropped task');
      await start('again', '');

      // ── F1: taken 40 s late, typed once, never `error` ──
      const statuses: string[] = [];
      for (const until = Date.now() + 55_000; Date.now() < until;) {
        statuses.push((await get('slow')).status);
        if (handed('slow', 'the slow task').length && lines(path.join(home, 'prompts.jsonl')).some((p) => p.id === 'slow') && statuses.at(-1) === 'idle') break;
        await new Promise((r) => setTimeout(r, 1_000));
      }
      seen.slow = { statuses: [...new Set(statuses)], handed: handed('slow', 'the slow task').length, typed: typedInto('slow', 'the slow task').length, agent: await get('slow') };
      soft(typedInto('slow', 'the slow task').length, 'F1: the task is never typed again').toBe(0);
      soft(handed('slow', 'the slow task').length, 'F1: it is handed once').toBe(1);
      soft(statuses, 'F1: never said error').not.toContain('error');

      // ── F2: really dropped, typed once more, on proof ──
      await soft.poll(() => typedInto('drop', 'the dropped task').length, { timeout: 40_000, message: 'F2: a task the CLI dropped is typed again' }).toBe(1);
      await new Promise((r) => setTimeout(r, 20_000));
      seen.drop = { typed: typedInto('drop', 'the dropped task').length, handed: handed('drop', 'the dropped task').length, agent: await get('drop') };
      soft(typedInto('drop', 'the dropped task').length, 'F2: and only once').toBe(1);

      // ── F3: a stop then a start leaves one CLI ──
      await expect.poll(async () => (await get('again')).cliRunning, { timeout: 30_000 }).toBe(true);
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.stop('again'));
      await start('again', 'AGAIN>> after the start');
      await expect.poll(() => handed('again', 'after the start').length, { timeout: 30_000 }).toBe(1);
      await new Promise((r) => setTimeout(r, 3_000));
      const cliPids = lines(path.join(home, 'launches.jsonl')).filter((l) => l.id === 'again').map((l) => l.pid as number);
      seen.again = { launches: cliPids, alive: cliPids.filter(alive) };
      soft(cliPids.filter(alive).length, 'F3: one CLI of the agent').toBe(1);

      // ── F4: the background-work note, told once ──
      await start('bg', '');
      await expect.poll(async () => (await get('bg')).cliRunning, { timeout: 30_000 }).toBe(true);
      // The lead hands it a task, as delegate_task's terminal path types it: the lead is its requester.
      await type('lead', `CALL>> POST /api/agents/bg/dispatch ${JSON.stringify({ message: 'BG>> leave a job running', intent: 'task' })}\r`);
      await expect.poll(() => handed('bg', 'leave a job running').length, { timeout: 30_000 }).toBe(1);
      // Its idle prompt, 62 s after its rest, then a moment for a second note.
      await expect.poll(() => lines(path.join(home, 'idle-prompted.jsonl')).filter((l) => l.id === 'bg').length, { timeout: 90_000 }).toBe(1);
      await new Promise((r) => setTimeout(r, 6_000));
      const notes = lines(path.join(home, 'prompts.jsonl')).filter((p) => p.id === 'lead' && /Background Worker.*background work still running/.test(String(p.prompt)));
      seen.bgNotes = notes.map((n) => n.prompt);
      soft(notes.length, 'F4: the note is told once').toBe(1);
    } finally {
      recordValues(seen);
      await app.close().catch(() => { /* gone */ });
    }
  });
}
