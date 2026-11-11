import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Each chat runs its own conversation with the orchestrator (ORCHESTRATOR-PER-CHAT.md v2.2, 4.2 and 4.3, PR D),
 * in the real app, through the window's channels and the agents' API.
 *
 * A sandbox HOME with one project, a git repository whose origin's main is one commit and whose root has another
 * branch checked out; the orchestrator "Lead" (model opus-test) and a worker. The CLIs are stand-ins named
 * `claude`: they run Tars's own hook scripts with the JSON Claude Code gives them and the CLAUDE_PID it hands them
 * (its own pid), keep a transcript where Claude Code keeps it and a scratchpad in the CLAUDE_CODE_TMPDIR Tars gives
 * them, continue the session `--resume` names, record every launch's argv and folder, and hold a turn whose prompt
 * says HOLD until told to end it. The RAM figure is the E2E's: 10 GB, so two chats work at once.
 * Every runner's session here is registered by #380's rule: its CLI is its terminal's process or that shell's child
 * (2, 3, 4, 10, 18).
 *
 * Asserted, in order:
 * 0. a chat whose record an agent edited to name the worker shows no runner, answers runner_mismatch, and never
 *    launches, types into or counts that worker, before it runs or after; an agent agents.json marks as a runner
 *    that no chat names is a plain worker since the launch (L1);
 * 1. a send in Main starts the orchestrator, with its model, its instructions and its tool block, its brief kept;
 * 2. a first send in chat A makes its runner: "Lead · Release", a worker of kind chat, in .worktrees/chat-<id> on
 *    chat/<id>, started from origin/main and not from the root's branch, launched like the orchestrator (model,
 *    instructions, --disallowed-tools), in its worktree, and told it is the orchestrator in that chat, its role the
 *    orchestrator's brief; while it is made (a git fetch held by a remote that never answers), a send to Main, whose
 *    orchestrator runs, is typed at once (L5);
 * 3. with both slots taken, a send in chat B puts A, idle, to sleep and starts B: two runners, two sessions, two
 *    worktrees, though each turn's Stop hook leaves a process under the CLI for a second after it; A asleep is, for
 *    #384's retention, an agent whose CLI does not run: a pass keeps all of it, one 8 days on takes its session's
 *    scratchpad, never its folder while A is in the fleet, nor its conversation (4 resumes it);
 * 4. the next send in A puts B to sleep and resumes A's session (--resume <its id>);
 * 5. with Main and A both in a turn, a send in B answers chat_limit, with its sentence and who works, and so does a
 *    Start of B from the window (M1);
 * 6. two sends in one tick for one free slot: one runner starts, the other answers chat_limit;
 * 7. a worker's reply to "requester" reaches the chat that asked; one to the orchestrator's id reaches it (R5);
 * 8. chat B's runner cannot cancel chat C's queued task (not_your_task); Main's orchestrator cannot without a
 *    reason, and can with one, and chat C is told (R6);
 * 9. a steer by Main's orchestrator, or a restart by chat B's runner, of the worker busy with chat C's work is refused,
 *    worker_busy_for_other_chat, naming chat C (PR B's rule, the chat case);
 * 10. a chat whose runner was stopped goes on with its conversation, under a new id (--fork-session), not a new one;
 * 11. a chat whose runner's CLI ended by itself goes on with the same session (--resume <its id>);
 * 12. under 2 GB free, a first send answers with the reason and makes no worktree (R7);
 * 13. scripts/worktree.mjs status lists the runners' worktrees, and its prune keeps them;
 * 14. deleting chat B removes its runner and its worktree, its branch kept;
 * 15. a permission ask from chat C's runner shows in chat C, and the window's answer reaches its CLI;
 * 16. the orchestrator's brief changed: runner A, started from the window, reads it at that launch (L3), takes a slot
 *    like a send (M1), and keeps it, the window's words being a turn;
 * 17. the Orchestrator toggle on a runner is refused, and the orchestrator keeps the role (M2);
 * 18. the role moves to the worker: Main follows the project's orchestrator, its sessions kept, and its next send
 *    reaches the new one;
 * 19. the orchestrator moves to a CLI whose conversations Tars cannot resume while chat C's runner works, with work
 *    out at a worker: a send to C is refused at once and nothing is typed (2.0.1; 2.0.0 typed it); C is left to
 *    finish, its turn ending as it would and the worker's answer still reaching it, neither copied onto that CLI nor
 *    restarted on it; and a chat whose runner is not running answers provider_unsupported too (L4).
 * Mn and Ln are the Audit's findings on #379.
 * The artefact: values.json (each answer, the launches, the worktrees), launches.jsonl, prompts.jsonl, sessions.jsonl
 * (what each SessionStart handed its CLI), permissions.jsonl (each answer to a permission ask) and hooks.log (what
 * Tars answered each hook). The sandbox HOME is removed once they are kept.
 */

const HOOKS = path.resolve('hooks');
/** The orchestrator's brief: its role in its bootstrap, and its runners'. */
const BRIEF = 'Lead the demo team: plan, delegate, review.';
const WORKTREE_TOOL = path.resolve('scripts', 'worktree.mjs');

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const id = process.env.CLAUDE_AGENT_ID;
const args = process.argv.slice(2);
// As Claude Code: --resume <id> continues that session, in its own transcript; with --fork-session, under a new id.
const resumed = args.indexOf('--resume');
const forked = args.includes('--fork-session');
const sid = resumed === -1 || forked ? crypto.randomUUID() : args[resumed + 1];
// Where Claude Code keeps it: the folder's path, every character but a letter or a digit as '-' (platform/claude-project-dir.ts).
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, '');
// The session's scratchpad, where Claude Code makes it: CLAUDE_CODE_TMPDIR/claude-<uid>/<project folder>/<session>.
const scratch = process.env.CLAUDE_CODE_TMPDIR
  ? path.join(process.env.CLAUDE_CODE_TMPDIR, 'claude-' + process.getuid(), process.cwd().replace(/[^a-zA-Z0-9]/g, '-'), sid, 'scratchpad')
  : null;
if (scratch) {
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'notes.md'), 'scratch of ' + sid);
}
const record = (file, o) => fs.appendFileSync(path.join(process.env.HOME, file), JSON.stringify({ at: new Date().toISOString(), id, ...o }) + '\n');
const dashes = args.indexOf('--');
const launchPrompt = dashes === -1 ? '' : args.slice(dashes + 1).join(' ');
record('launches.jsonl', { pid: process.pid, ppid: process.ppid, sid, resume: resumed === -1 ? null : args[resumed + 1], fork: forked, prompt: launchPrompt, argv: args, cwd: process.cwd(), scratch, transcript });
// As Claude Code: its hooks are handed CLAUDE_PID, its own pid, which Tars compares with its terminal's (#380).
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(HOOKS, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: { ...process.env, CLAUDE_PID: String(process.pid) }, timeout: 20000,
});
const line = (o) => fs.appendFileSync(transcript, JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function turn(prompt) {
  record('prompts.jsonl', { sid, prompt });
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } });
  // A turn told to hold runs until the test lets it end.
  if (prompt.includes('HOLD>>')) {
    const release = path.join(process.env.HOME, 'release-' + id);
    while (!fs.existsSync(release)) await sleep(100);
    fs.rmSync(release, { force: true });
  }
  // A turn told to ask runs a permission question through Tars, as the state mod does, until the window answers.
  if (prompt.includes('ASKPERM>>')) {
    for (let i = 0; i < 10; i++) {
      const answer = await fetch(process.env.CLAUDE_MGR_API_URL + '/api/hooks/permission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN },
        body: JSON.stringify({ agent_id: id, session_id: sid, tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'toolu_e2e_ask' }),
      }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
      record('permissions.jsonl', { sid, answer });
      if (answer.decision && answer.decision !== 'pending') break;
    }
  }
  line({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  await sleep(200);
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'done' });
  // The Stop hook's tail: a process still under the CLI for a second after the turn's end reached Tars, as a
  // hook's exit takes on a loaded machine. A full limit must look again rather than call the chat working.
  spawn('/bin/sleep', ['1'], { stdio: 'ignore' });
  // A turn told to exit ends the CLI after it, as /exit does.
  if (prompt.includes('EXIT>>')) process.exit(0);
}

process.stdin.setRawMode(true);
// What SessionStart hands the CLI: Tars's bootstrap, as Claude Code would read it.
const started = hook('session-start.sh', { hook_event_name: 'SessionStart', source: resumed === -1 ? 'startup' : 'resume' });
let context = null;
try { context = JSON.parse(String(started.stdout || '{}')).hookSpecificOutput?.additionalContext ?? null; } catch {}
record('sessions.jsonl', { sid, context });
process.stdout.write('SCREEN-OF-' + id + ' session ' + sid + '\r\n> ');
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

type Agent = {
  id: string; name?: string; role?: string; kind?: string; chatId?: string; status: string; cliRunning?: boolean;
  worktreePath?: string; branchName?: string; projectPath: string; currentSessionId?: string; savedPrompt?: string; provider?: string; taskQueue?: Array<{ ref: string; requesterAgentId: string; state: string }>;
};
type ChatRecord = {
  id: string; number: number; title: string; runnerId: string | null; inbox: boolean; settledAt: string | null; sessionIds: string[];
  runner?: { id: string; live: boolean; permissionAsk?: { tool: string; fingerprint?: string } | null } | null;
};
type Answer = Record<string, unknown>;
type Launch = {
  id: string; pid: number; ppid: number; sid: string; resume: string | null; fork: boolean; prompt: string; argv: string[]; cwd: string;
  scratch: string | null; transcript: string;
};

const lines = <T>(file: string): T[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test("chats: each runs its own conversation, within the RAM's limit, and owns its work", async () => {
  test.setTimeout(420_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-runners-'));
  const project = path.join(home, 'projects', 'demo');
  const origin = path.join(home, 'origin.git');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });

  // origin's main, and the root on another branch: a runner starts from the first, never from the second.
  const env = { ...process.env, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com' };
  const gitSeed = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' });
  gitSeed(home, 'init', '-q', '--bare', origin);
  gitSeed(home, 'init', '-q', '-b', 'main', project);
  fs.writeFileSync(path.join(project, 'README.md'), 'on main\n');
  gitSeed(project, 'add', '.');
  gitSeed(project, 'commit', '-q', '-m', 'main');
  gitSeed(project, 'remote', 'add', 'origin', origin);
  gitSeed(project, 'push', '-q', '-u', 'origin', 'main');
  gitSeed(project, 'checkout', '-q', '-b', 'feature-x');
  fs.writeFileSync(path.join(project, 'feature.txt'), 'only on feature-x\n');
  gitSeed(project, 'add', '.');
  gitSeed(project, 'commit', '-q', '-m', 'feature');
  const originMain = git(project, 'rev-parse', 'origin/main');
  const rootHead = git(project, 'rev-parse', 'HEAD');

  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`, { mode: 0o755 });
  const agent = (id: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role, permissionMode: 'normal',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-12T08:00:00.000Z', lastActivity: '2026-10-12T08:00:00.000Z', ...extra,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('o1', 'Lead', 'orchestrator', { model: 'opus-test', savedPrompt: BRIEF }), agent('w1', 'Worker', 'worker'),
    // Marked in agents.json as a chat's runner, which no chat names (L1).
    agent('x1', 'Marked', 'worker', { kind: 'chat', chatId: 'ed17ed00-0000-4000-8000-000000000002' }),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  // chats.json as Tars writes it, with one record an agent edited (the file is in ~/.tars, which agents may
  // write): chat #2 names the worker as its runner.
  const at = '2026-10-12T08:00:00.000Z';
  const record = (id: string, number: number, title: string, runnerId: string, inbox: boolean) => ({
    id, projectPath: project, number, title, titleSource: 'user', runnerId, sessionIds: [], pinned: false,
    snoozedUntil: null, settledAt: null, inbox, createdAt: at, updatedAt: at, lastActivityAt: at,
  });
  fs.writeFileSync(path.join(dir, 'chats.json'), JSON.stringify({ version: 1, numbers: { [project]: 2 }, chats: [
    record('c0ffee00-0000-4000-8000-000000000001', 1, 'Main', 'o1', true),
    record('ed17ed00-0000-4000-8000-000000000002', 2, 'Edited', 'w1', false),
  ] }, null, 2));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const launchesFile = path.join(home, 'launches.jsonl');
  const promptsFile = path.join(home, 'prompts.jsonl');
  const sessionsFile = path.join(home, 'sessions.jsonl');
  const permissionsFile = path.join(home, 'permissions.jsonl');
  const port = apiPort(31455);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = { home, project, originMain, rootHead };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', TARS_CHAT_RAM_GB: '10' },
  });
  try {
    const page: Page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
    const call = (ns: string, name: string, arg?: unknown) => page.evaluate(([ns, name, arg]) => {
      const api = (window as unknown as { electronAPI: Record<string, Record<string, (a?: unknown) => Promise<Answer>>> }).electronAPI;
      return api[ns as string][name as string](arg);
    }, [ns, name, arg] as const);
    const chats = async () => (await call('chat', 'list') as unknown as { chats: ChatRecord[] }).chats;
    const send = (chatId: string, text: string) => call('chat', 'send', { chatId, text, clientRequestId: `e2e-${Math.random()}` });
    const fleet = async () => await page.evaluate(() => (window as unknown as { electronAPI: { agent: { list(): Promise<Agent[]> } } }).electronAPI.agent.list());
    const agentOf = async (id: string) => (await fleet()).find((a) => a.id === id);
    const runnerOf = async (chatId: string) => (await fleet()).find((a) => a.kind === 'chat' && a.chatId === chatId);
    const launchesOf = (id: string) => lines<Launch>(launchesFile).filter((l) => l.id === id);
    const promptsOf = (id: string) => lines<{ id: string; prompt: string }>(promptsFile).filter((l) => l.id === id).map((l) => l.prompt);
    const contextOf = (id: string) => lines<{ id: string; context: string | null }>(sessionsFile).find((l) => l.id === id)?.context ?? '';
    const atRest = (id: string) => expect.poll(async () => (await agentOf(id))?.status, { timeout: 30_000 }).toMatch(/^(idle|completed)$/);
    const release = (id: string) => fs.writeFileSync(path.join(home, `release-${id}`), '');
    type WindowAgentApi = { agent: {
      start(p: { id: string; prompt: string }): Promise<Answer>; update(p: Record<string, unknown>): Promise<Answer>;
      answerPermission(id: string, decision: string, reason?: string, fingerprint?: string): Promise<Answer>;
    } };
    const startFromWindow = (id: string, prompt: string) => page.evaluate(([id, prompt]) => (window as unknown as { electronAPI: WindowAgentApi }).electronAPI.agent.start({ id, prompt }), [id, prompt] as const);
    const updateFromWindow = (params: Record<string, unknown>) => page.evaluate((p) => (window as unknown as { electronAPI: WindowAgentApi }).electronAPI.agent.update(p), params);
    /** What the sleep rule says of an agent now, as a full limit reads it. */
    const refusalOf = (id: string) => app.evaluate(async (_e, { dist, id }) => {
      const req = process.mainModule!.require;
      const { agents } = req(`${dist}/core/agent-manager.js`);
      const { sleepRefusal, factsOf } = req(`${dist}/services/agent-sleep.js`);
      const { readProcesses } = req(`${dist}/services/stall-watch.js`);
      const { ptyProcesses, fieldInUse } = req(`${dist}/core/pty-manager.js`);
      const agent = agents.get(id);
      const facts = factsOf(agent, await readProcesses(), Date.now());
      const terminal = agent?.ptyId ? ptyProcesses.get(agent.ptyId) : undefined;
      return {
        refusal: sleepRefusal(facts, { anyAge: true }), owed: facts.owed, owes: facts.owes, pending: facts.pending,
        field: terminal ? fieldInUse(terminal) : null, cli: facts.cliRunning, resumable: facts.resumable,
      };
    }, { dist, id });
    /** The pid of an agent's terminal process, as the session registration reads it. */
    const terminalPidOf = (id: string) => app.evaluate((_e, { dist, id }) => {
      const req = process.mainModule!.require;
      const agent = req(`${dist}/core/agent-manager.js`).agents.get(id);
      const terminal = agent?.ptyId ? req(`${dist}/core/pty-manager.js`).ptyProcesses.get(agent.ptyId) : undefined;
      return (terminal?.pid as number | undefined) ?? null;
    }, { dist, id });
    /** The sessions Tars refused an agent, as it writes each refusal into the agent's kept output (#380). */
    const refusedSessionsOf = (id: string) => app.evaluate((_e, { dist, id }) => {
      const agent = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get(id);
      return ((agent?.output ?? []) as string[]).filter((chunk) => chunk.includes('[Tars] Refused a session')).map((chunk) => chunk.trim());
    }, { dist, id });
    /**
     * Tars takes a session only from the CLI it launched in the agent's terminal (#380): the agent's last launch is
     * its terminal's process or, typed into the shell there (darwin and linux), that shell's child, and the session
     * its hooks named, with that CLI's pid, is the agent's, taken at its SessionStart: never refused there and then
     * adopted from a later post.
     */
    const ownSession = async (id: string) => {
      const last = launchesOf(id).at(-1)!;
      expect([last.pid, last.ppid]).toContain(await terminalPidOf(id));
      await expect.poll(async () => (await agentOf(id))?.currentSessionId ?? null, { timeout: 30_000 }).toBe(last.sid);
      expect(await refusedSessionsOf(id)).toEqual([]);
    };
    /** One pass of the temporary folders' retention (#384) with what main.ts hands it, its clock `days` on. */
    const tmpPass = (days: number) => app.evaluate(async (_e, { dist, days }) => {
      const req = process.mainModule!.require;
      const { agents } = req(`${dist}/core/agent-manager.js`);
      const { ptyProcesses } = req(`${dist}/core/pty-manager.js`);
      const { agentsRunningOverAcp } = req(`${dist}/services/acp/delegate.js`);
      const { enforceTmpRetention } = req(`${dist}/services/agent-tmp.js`);
      const result = await enforceTmpRetention({
        now: () => Date.now() + days * 86_400_000,
        liveAgentIds: () => [
          ...[...agents.values()].filter((a) => !!a.ptyId && ptyProcesses.has(a.ptyId)).map((a) => a.id),
          ...agentsRunningOverAcp(),
        ],
        knownAgentIds: () => [...agents.keys()],
        sessionsOf: (agentId: string) => {
          const a = agents.get(agentId);
          return [a?.currentSessionId, a?.resumableSessionId].filter((sid) => !!sid);
        },
        log: () => {},
      });
      return result.removed as Array<{ path: string; reason: string }>;
    }, { dist, days });
    const lastContextOf = (id: string) => lines<{ id: string; context: string | null }>(sessionsFile).filter((l) => l.id === id).map((l) => l.context ?? '').pop() ?? '';
    // Each in one spelling: git may print a temporary folder as /var/... or /private/var/....
    const real = (p: string) => (fs.existsSync(p) ? fs.realpathSync(p) : path.join(fs.realpathSync(path.dirname(p)), path.basename(p)));
    const worktrees = () => git(project, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => real(l.slice(9)));

    // 0. The edited record: no runner shown, nothing sent, the worker it names never launched for it. And the agent
    //    agents.json marked as a runner no chat names is a plain worker since the launch (L1).
    const marked = await agentOf('x1');
    keep({ marked });
    expect(marked?.kind).toBeUndefined();
    expect(marked?.chatId).toBeUndefined();
    const edited = (await chats()).find((c) => c.number === 2)!;
    expect(edited).toMatchObject({ title: 'Edited', runner: null });
    const toEdited = await send(edited.id, 'EDITED>> hello');
    keep({ toEdited });
    expect(toEdited).toMatchObject({ error: 'runner_mismatch' });

    // 1. Main: the orchestrator, started by the first send, as the orchestrator.
    const main = (await chats()).find((c) => c.number === 1)!;
    const toMain = await send(main.id, 'MAIN>> hello');
    keep({ toMain });
    expect(toMain).toMatchObject({ success: true, runnerId: 'o1', how: 'launched' });
    await expect.poll(() => promptsOf('o1'), { timeout: 30_000 }).toContain('MAIN>> hello');
    await atRest('o1');
    const leadArgv = launchesOf('o1')[0].argv;
    expect(leadArgv).toEqual(expect.arrayContaining(['--model', 'opus-test', '--append-system-prompt-file', '--disallowed-tools']));
    expect(contextOf('o1')).toContain('orchestrator of project');
    expect(contextOf('o1')).not.toContain('You are the orchestrator in');
    // A chat's message is a turn, never the orchestrator's brief.
    expect((await agentOf('o1'))?.savedPrompt).toBe(BRIEF);
    expect(contextOf('o1')).toContain(`## Your role\n${BRIEF}`);

    // 2. Chat A's runner, made by its first send. While it is made, its git fetch held by a remote that never
    //    answers, a send to Main, whose orchestrator runs, is typed at once, not behind the lock (L5).
    const chatA = await call('chat', 'create', { projectPath: project, title: 'Release' }) as unknown as ChatRecord;
    const chatB = await call('chat', 'create', { projectPath: project, title: 'Bug' }) as unknown as ChatRecord;
    const sockets = new Set<net.Socket>();
    const silent = net.createServer((socket) => { sockets.add(socket); });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    git(project, 'remote', 'set-url', 'origin', `http://127.0.0.1:${(silent.address() as net.AddressInfo).port}/demo.git`);
    const toAPending = send(chatA.id, 'A>> first');
    await page.waitForTimeout(1_500);
    const sentAt = Date.now();
    const whileMade = await Promise.race([send(main.id, 'MAIN>> while A is made'), page.waitForTimeout(10_000).then(() => ({ timedOut: true }))]);
    const waitedMs = Date.now() - sentAt;
    for (const socket of sockets) socket.destroy();
    silent.close();
    git(project, 'remote', 'set-url', 'origin', origin);
    const toA = await toAPending;
    keep({ toA, whileMade, waitedMs });
    expect(whileMade).toMatchObject({ success: true, how: 'typed' });
    expect(toA).toMatchObject({ success: true, how: 'launched' });
    const runnerA = (await runnerOf(chatA.id))!;
    keep({ runnerA });
    expect(runnerA).toMatchObject({ name: 'Lead · Release', role: 'worker', kind: 'chat', chatId: chatA.id, projectPath: project });
    expect(runnerA.worktreePath).toMatch(new RegExp(`^${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.worktrees/chat-[0-9a-f]{8}$`));
    expect(runnerA.branchName).toBe(`chat/${path.basename(runnerA.worktreePath!).slice(5)}`);
    expect(worktrees()).toContain(real(runnerA.worktreePath!));
    expect(git(runnerA.worktreePath!, 'rev-parse', 'HEAD')).toBe(originMain);
    expect(originMain).not.toBe(rootHead);
    await expect.poll(() => promptsOf(runnerA.id), { timeout: 30_000 }).toContain('A>> first');
    await atRest(runnerA.id);
    const launchA = launchesOf(runnerA.id)[0];
    // Its session is the one the CLI Tars launched in its terminal registered (#380).
    await ownSession(runnerA.id);
    expect(launchA.argv).toEqual(expect.arrayContaining(['--model', 'opus-test', '--append-system-prompt-file', '--disallowed-tools']));
    expect(fs.realpathSync(launchA.cwd)).toBe(fs.realpathSync(runnerA.worktreePath!));
    // Told, through its SessionStart, that it is the orchestrator in this chat, one of several.
    const contextA = contextOf(runnerA.id);
    keep({ contextA });
    expect(contextA).toContain(`(agent id: ${runnerA.id}), orchestrator of project ${project}.`);
    expect(contextA).toContain(`You are the orchestrator in the chat "Release" (#${chatA.number}): the project's other chats may be running at once`);
    // Its role is the orchestrator's brief, not its chat's first message.
    expect(contextA).toContain(`## Your role\n${BRIEF}`);
    expect(contextA).not.toContain('A>> first');
    expect(await call('system', 'chatLimit')).toMatchObject({ limit: 2, working: 2 });
    await expect.poll(() => promptsOf('o1'), { timeout: 30_000 }).toContain('MAIN>> while A is made');
    await atRest('o1');

    // 3. Both slots taken: B's first send puts A, idle, to sleep. What the sleep rule says of A just before is kept
    //    for the artefact: a refusal there is why a send answers chat_limit.
    const refusalOfA = await refusalOf(runnerA.id);
    const toB = await send(chatB.id, 'B>> first');
    keep({ refusalOfA, toB });
    expect(toB).toMatchObject({ success: true, how: 'launched' });
    const runnerB = (await runnerOf(chatB.id))!;
    await expect.poll(async () => (await agentOf(runnerA.id))?.status, { timeout: 15_000 }).toBe('asleep');
    await expect.poll(() => promptsOf(runnerB.id), { timeout: 30_000 }).toContain('B>> first');
    await atRest(runnerB.id);
    const launchB = launchesOf(runnerB.id)[0];
    await ownSession(runnerB.id);
    expect(launchB.argv).toEqual(expect.arrayContaining(['--model', 'opus-test', '--disallowed-tools']));
    expect(launchB.sid).not.toBe(launchA.sid);
    expect(worktrees()).toEqual(expect.arrayContaining([real(runnerA.worktreePath!), real(runnerB.worktreePath!)]));
    // A asleep has no terminal: for the retention (#384) it is an agent whose CLI does not run. A pass now keeps all
    // of it; one 8 days on takes its session's scratchpad, as any sleeping agent's, and never its folder while A is
    // in the fleet, nor its conversation, kept in ~/.claude/projects: step 4 resumes it.
    const scratchA = launchA.scratch!;
    const sessionDirA = path.dirname(scratchA);
    const folderA = path.resolve(sessionDirA, '..', '..', '..', '..');
    expect(fs.existsSync(path.join(scratchA, 'notes.md'))).toBe(true);
    const removedNow = await tmpPass(0);
    const removedLater = await tmpPass(8);
    keep({ scratchA, removedNow, removedLater });
    expect(removedNow.filter((r) => r.path.startsWith(folderA))).toEqual([]);
    expect(fs.existsSync(path.join(folderA, 'c'))).toBe(true);
    expect(fs.existsSync(launchA.transcript)).toBe(true);
    expect(fs.existsSync(sessionDirA)).toBe(false);
    expect(removedLater.map((r) => [r.path, r.reason])).toEqual(expect.arrayContaining([[sessionDirA, 'untouched for 7 days']]));

    // 4. A again: B sleeps, A resumes its own session.
    const toA2 = await send(chatA.id, 'A>> second');
    keep({ toA2 });
    expect(toA2).toMatchObject({ success: true, how: 'launched' });
    await expect.poll(async () => (await agentOf(runnerB.id))?.status, { timeout: 15_000 }).toBe('asleep');
    await expect.poll(() => launchesOf(runnerA.id).length, { timeout: 30_000 }).toBe(2);
    expect(launchesOf(runnerA.id)[1]).toMatchObject({ resume: launchA.sid, fork: false, sid: launchA.sid });
    await expect.poll(() => promptsOf(runnerA.id), { timeout: 30_000 }).toContain('A>> second');
    await atRest(runnerA.id);
    await ownSession(runnerA.id);

    // 5. Main and A both in a turn: a send in B answers chat_limit, and says who works.
    expect(await send(chatA.id, 'HOLD>> a')).toMatchObject({ success: true, how: 'typed' });
    expect(await send(main.id, 'HOLD>> m')).toMatchObject({ success: true, how: 'typed' });
    await expect.poll(async () => [(await agentOf(runnerA.id))?.status, (await agentOf('o1'))?.status], { timeout: 30_000 }).toEqual(['running', 'running']);
    const limited = await send(chatB.id, 'B>> second');
    keep({ limited });
    expect(limited).toMatchObject({ error: 'chat_limit', limit: 2, ramGb: 10 });
    expect(String(limited.reason)).toContain('2 chats are already working, the most this Mac runs at once (10 GB of RAM, one chat per 5 GB)');
    expect((limited.working as Array<{ title: string }>).map((w) => w.title).sort()).toEqual(['Main', 'Release']);
    // A Start from the window takes the same slots (M1): refused with the sentence, and B stays asleep.
    const launchesOfB = launchesOf(runnerB.id).length;
    const startedB = await startFromWindow(runnerB.id, 'WINDOW>> start B');
    keep({ startedB });
    expect(startedB).toMatchObject({ success: false });
    expect(String(startedB.error)).toContain('2 chats are already working, the most this Mac runs at once');
    expect(launchesOf(runnerB.id)).toHaveLength(launchesOfB);
    expect((await agentOf(runnerB.id))?.status).toBe('asleep');
    release(runnerA.id);
    release('o1');
    await atRest(runnerA.id);
    await atRest('o1');

    // 6. One free slot, two sends in one tick: one starts, the other answers chat_limit.
    const settled = await call('chat', 'settle', { chatId: chatA.id, settled: true });
    keep({ settled });
    await expect.poll(async () => (await agentOf(runnerA.id))?.status, { timeout: 15_000 }).toBe('asleep');
    const chatC = await call('chat', 'create', { projectPath: project, title: 'Docs' }) as unknown as ChatRecord;
    const chatD = await call('chat', 'create', { projectPath: project, title: 'Design' }) as unknown as ChatRecord;
    const both = await Promise.all([send(chatC.id, 'C>> one'), send(chatD.id, 'D>> one')]);
    keep({ both });
    expect(both.filter((a) => a.how === 'launched')).toHaveLength(1);
    expect(both.filter((a) => a.error === 'chat_limit')).toHaveLength(1);
    const startedChat = both[0].how === 'launched' ? chatC : chatD;
    const runnerC = (await runnerOf(startedChat.id))!;
    await atRest(runnerC.id);

    // The worker's terminal, registered: a message waits for its CLI's first session.
    await page.evaluate(() => (window as unknown as { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } }).electronAPI.agent.start({ id: 'w1', prompt: '' }));
    await expect.poll(async () => (await agentOf('w1'))?.currentSessionId ?? null, { timeout: 30_000 }).not.toBeNull();
    await atRest('w1');
    // The edited record's agent runs now: it holds no slot (Main and C do), and the edited chat still reaches it not.
    const withWorker = await call('system', 'chatLimit');
    const toEditedAgain = await send(edited.id, 'EDITED>> again');
    keep({ withWorker, toEditedAgain });
    expect(withWorker).toMatchObject({ working: 2 });
    expect(toEditedAgain).toMatchObject({ error: 'runner_mismatch' });

    // A token naming each agent, as its MCP servers present one. A run's token, held beside the terminal's: a
    // terminal's own token minted again would void the one its CLI holds, and its hooks would be refused.
    const tokens = await app.evaluate((_e, { dist, ids }) => {
      const req = process.mainModule!.require;
      const out: Record<string, string> = {};
      for (const id of ids) out[id] = req(`${dist}/core/agent-tokens.js`).mintRunToken(id).token;
      return out;
    }, { dist, ids: ['o1', 'w1', runnerB.id, runnerC.id] });
    const api = (route: string, as: string, body: Record<string, unknown>) => fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[as]}`, 'X-Tars-Caller-Id': as },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }).then(async (r) => ({ status: r.status, body: await r.json() as Answer }));

    // 7. R5: the worker answers whoever asked for its current task, unless it names an id.
    const asked = await api('/api/agents/w1/message', runnerC.id, { message: 'R5>> report to me' });
    keep({ asked });
    expect(asked.status).toBe(200);
    await expect.poll(() => promptsOf('w1').some((p) => p.includes('R5>> report to me')), { timeout: 30_000 }).toBe(true);
    const toRequester = await api('/api/agents/requester/message', 'w1', { message: 'REPLY>> for my asker' });
    const toLeadById = await api('/api/agents/o1/message', 'w1', { message: 'ID>> for the lead' });
    keep({ asked, toRequester, toLeadById });
    expect(toRequester.status).toBe(200);
    expect(toRequester.body).toMatchObject({ deliveredTo: { id: runnerC.id, how: 'requester' } });
    await expect.poll(() => promptsOf(runnerC.id).some((p) => p.includes('REPLY>> for my asker')), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => promptsOf('o1').some((p) => p.includes('ID>> for the lead')), { timeout: 30_000 }).toBe(true);
    expect(promptsOf(runnerC.id).some((p) => p.includes('ID>> for the lead'))).toBe(false);
    await atRest('w1');
    await atRest(runnerC.id);
    await atRest('o1');

    // 8. Ownership (R6): a request held behind a draft in the worker's field is queued.
    await page.evaluate(() => (window as unknown as { electronAPI: { agent: { sendInput(p: { id: string; input: string }): Promise<unknown> } } }).electronAPI.agent.sendInput({ id: 'w1', input: 'x' }));
    const held = await api('/api/agents/w1/message', runnerC.id, { message: 'QUEUED>> later' });
    expect(held.body).toMatchObject({ held: true });
    const queued = (await agentOf('w1'))!.taskQueue!.find((r) => r.requesterAgentId === runnerC.id && r.state === 'queued')!;
    const byOtherChat = await api(`/api/tasks/${queued.ref}/cancel`, runnerB.id, {});
    const byLeadNoReason = await api(`/api/tasks/${queued.ref}/cancel`, 'o1', {});
    const byLead = await api(`/api/tasks/${queued.ref}/cancel`, 'o1', { reason: 'the docs moved to Main' });
    keep({ queued, byOtherChat, byLeadNoReason, byLead });
    expect(byOtherChat).toMatchObject({ status: 403, body: { error: 'not_your_task' } });
    expect(byLeadNoReason).toMatchObject({ status: 400, body: { error: 'reason_required' } });
    expect(byLead).toMatchObject({ status: 200, body: { success: true, cancelled: queued.ref } });
    expect((await agentOf('w1'))!.taskQueue?.some((r) => r.ref === queued.ref) ?? false).toBe(false);
    await expect.poll(() => promptsOf(runnerC.id).some((p) => p.includes('cancelled') && p.includes('the docs moved to Main')), { timeout: 30_000 }).toBe(true);
    // The draft goes, and nothing of the cancelled message is typed after it.
    await page.evaluate(() => (window as unknown as { electronAPI: { agent: { sendInput(p: { id: string; input: string }): Promise<unknown> } } }).electronAPI.agent.sendInput({ id: 'w1', input: '\x7f' }));
    await page.waitForTimeout(1_500);
    expect(promptsOf('w1').some((p) => p.includes('QUEUED>> later'))).toBe(false);

    // 9. The worker busy with chat C's work: Main's orchestrator may not steer it, nor chat B's runner restart it;
    //    the refusal names chat C (PR B's rule, the chat case; ORCHESTRATOR-PER-CHAT.md 4.3, M1).
    await atRest('w1');
    // The hold is off its first line: the note C is sent when it ends quotes that line, and must not hold C.
    const forC = await api('/api/agents/w1/dispatch', runnerC.id, { message: 'Work for chat C\nHOLD>> until released' });
    expect(forC.status).toBe(200);
    await expect.poll(async () => (await agentOf('w1'))?.status, { timeout: 30_000 }).toBe('running');
    const steerByMain = await api('/api/agents/w1/dispatch', 'o1', { message: 'STEER>> drop that', mode: 'steer' });
    const restartByB = await api('/api/agents/w1/dispatch', runnerB.id, { message: 'RESTART>> mine now', mode: 'restart', reason: 'mine' });
    keep({ forC, steerByMain, restartByB });
    const chatOfC = { title: startedChat.title, number: startedChat.number };
    expect(steerByMain).toMatchObject({ status: 409, body: { code: 'worker_busy_for_other_chat', chat: chatOfC } });
    expect(restartByB).toMatchObject({ status: 409, body: { code: 'worker_busy_for_other_chat', chat: chatOfC } });
    expect(String(steerByMain.body.error)).toContain(`the chat "${startedChat.title}" (#${startedChat.number})`);
    release('w1');
    await atRest('w1');
    expect(promptsOf('w1').some((p) => p.includes('STEER>>') || p.includes('RESTART>>'))).toBe(false);

    // 10. Stopped, not asleep: the chat's next send still goes on with its conversation.
    await atRest(runnerC.id);
    await page.evaluate((id) => (window as unknown as { electronAPI: { agent: { stop(id: string): Promise<unknown> } } }).electronAPI.agent.stop(id), runnerC.id);
    await expect.poll(async () => (await agentOf(runnerC.id))?.cliRunning ?? false, { timeout: 15_000 }).toBe(false);
    const afterStop = await send(startedChat.id, 'C>> after a stop');
    keep({ afterStop });
    expect(afterStop).toMatchObject({ success: true, how: 'launched' });
    await expect.poll(() => launchesOf(runnerC.id).length, { timeout: 30_000 }).toBe(2);
    // The stopped session is a tombstone: continued under a new id, whose hooks count.
    const [firstC, againC] = launchesOf(runnerC.id);
    expect(againC).toMatchObject({ resume: firstC.sid, fork: true });
    expect(againC.sid).not.toBe(firstC.sid);
    await expect.poll(() => promptsOf(runnerC.id).some((p) => p.includes('C>> after a stop')), { timeout: 30_000 }).toBe(true);
    await atRest(runnerC.id);
    await ownSession(runnerC.id);

    // 11. Its CLI ended by itself: no tombstone, the next send resumes the same session.
    expect(await send(startedChat.id, 'EXIT>> bye')).toMatchObject({ success: true, how: 'typed' });
    await expect.poll(async () => (await agentOf(runnerC.id))?.cliRunning ?? true, { timeout: 30_000 }).toBe(false);
    // Back at its shell, it holds no slot: Main alone works.
    const exitedLimit = await call('system', 'chatLimit');
    const exitedView = (await chats()).find((c) => c.id === startedChat.id)?.runner;
    keep({ exitedLimit, exitedView });
    expect(exitedLimit).toMatchObject({ working: 1 });
    expect(exitedView).toMatchObject({ id: runnerC.id, live: false });
    const afterExit = await send(startedChat.id, 'C>> after an exit');
    keep({ afterExit });
    expect(afterExit).toMatchObject({ success: true, how: 'launched' });
    await expect.poll(() => launchesOf(runnerC.id).length, { timeout: 30_000 }).toBe(3);
    expect(launchesOf(runnerC.id)[2]).toMatchObject({ resume: againC.sid, fork: false, sid: againC.sid });
    await expect.poll(() => promptsOf(runnerC.id).some((p) => p.includes('C>> after an exit')), { timeout: 30_000 }).toBe(true);
    await atRest(runnerC.id);

    // 12. R7: under the 2 GB floor, a first send makes no worktree, and says why.
    await app.evaluate((_e, { dist }) => { process.mainModule!.require(`${dist}/core/disk-space.js`).setFreeSpaceReader(() => 1024 ** 3); }, { dist });
    const chatE = await call('chat', 'create', { projectPath: project, title: 'Floor' }) as unknown as ChatRecord;
    const before = worktrees();
    const floored = await send(chatE.id, 'E>> one');
    await app.evaluate((_e, { dist }) => { process.mainModule!.require(`${dist}/core/disk-space.js`).setFreeSpaceReader(undefined); }, { dist });
    keep({ floored });
    expect(floored).toMatchObject({ error: 'disk_full' });
    expect(String(floored.reason)).toContain('free');
    expect(worktrees()).toEqual(before);
    expect(await runnerOf(chatE.id)).toBeUndefined();

    // 13. The worktree tool sees the runners' worktrees, and its cleanup keeps them while their runners exist.
    const tool = (...args: string[]) => execFileSync(process.execPath, [WORKTREE_TOOL, ...args], { cwd: project, env: { ...process.env, HOME: home }, encoding: 'utf8' });
    const status = tool('status');
    const pruned = tool('prune', '--dry-run', '--no-github', '--older-than', '0');
    keep({ status, pruned });
    for (const r of [runnerA, runnerB, runnerC]) {
      const name = path.basename(r.worktreePath!);
      expect(status).toContain(name);
      expect(pruned.split('\n').find((l) => l.startsWith(`kept ${name}: `))).toContain(`it is the worktree of the Tars agent ${r.name}`);
    }

    // 14. Deleting chat B: its runner and its worktree go, its branch stays.
    const deleted = await call('chat', 'delete', { chatId: chatB.id });
    keep({ deleted, worktreesAtEnd: worktrees(), launches: lines(launchesFile) });
    expect(deleted).toMatchObject({ success: true });
    expect(await agentOf(runnerB.id)).toBeUndefined();
    expect(worktrees()).not.toContain(real(runnerB.worktreePath!));
    expect(git(project, 'branch', '--list', runnerB.branchName!)).toContain(runnerB.branchName!);
    // The worker the edited record named: launched once, by the test, and never given its words.
    expect(launchesOf('w1')).toHaveLength(1);
    expect(promptsOf('w1').some((p) => p.includes('EDITED>>'))).toBe(false);

    // 15. A permission ask from chat C's runner shows in chat C, and the window's answer reaches its CLI.
    const viewOfC = async () => (await chats()).find((c) => c.id === startedChat.id)?.runner;
    expect(await send(startedChat.id, 'ASKPERM>> clean the build')).toMatchObject({ success: true });
    await expect.poll(async () => (await viewOfC())?.permissionAsk?.tool ?? null, { timeout: 30_000 }).toBe('Bash');
    const askView = await viewOfC();
    keep({ askView });
    expect(askView).toMatchObject({ id: runnerC.id, permissionAsk: { tool: 'Bash' } });
    // Every allow names the fingerprint of the question read (#588's M1).
    await page.evaluate(([id, fp]) => (window as unknown as { electronAPI: WindowAgentApi }).electronAPI.agent.answerPermission(id, 'allow', undefined, fp), [runnerC.id, askView?.permissionAsk?.fingerprint] as const);
    await expect.poll(() => lines<{ id: string; answer: { decision?: string } }>(permissionsFile).filter((l) => l.id === runnerC.id).map((l) => l.answer.decision).pop() ?? null, { timeout: 30_000 }).toBe('allow');
    await expect.poll(async () => (await viewOfC())?.permissionAsk ?? null, { timeout: 30_000 }).toBeNull();
    await atRest(runnerC.id);

    // 16. The orchestrator's brief changed: runner A, started from the window, reads it at that launch (L3), takes a
    //     slot like a send (M1), and keeps it, the window's words being a turn.
    // The change is made where no path tells the runners (agent:update would resync every one of them): what a
    // launch reads is then the gate's own doing.
    const NEW_BRIEF = 'Lead the demo team: plan, delegate, review, and ask for a test first.';
    await app.evaluate((_e, { dist, brief }) => { process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get('o1').savedPrompt = brief; }, { dist, brief: NEW_BRIEF });
    expect((await agentOf(runnerA.id))?.savedPrompt).toBe(BRIEF);
    const refusalOfC = await refusalOf(runnerC.id);
    const startedA = await startFromWindow(runnerA.id, 'WINDOW>> start A');
    keep({ refusalOfC, startedA });
    expect(startedA).toMatchObject({ success: true });
    await expect.poll(() => lastContextOf(runnerA.id), { timeout: 30_000 }).toContain(`## Your role\n${NEW_BRIEF}`);
    expect((await agentOf(runnerA.id))?.savedPrompt).toBe(NEW_BRIEF);
    await expect.poll(() => promptsOf(runnerA.id), { timeout: 30_000 }).toContain('WINDOW>> start A');

    // 17. The Orchestrator toggle on a runner is refused (M2): the project's orchestrator keeps the role.
    const toggled = await updateFromWindow({ id: runnerA.id, role: 'orchestrator' });
    keep({ toggled });
    expect(toggled).toMatchObject({ success: false });
    expect(String(toggled.error)).toMatch(/runs a chat/);
    expect((await agentOf('o1'))?.role).toBe('orchestrator');
    expect((await agentOf(runnerA.id))?.role).toBe('worker');

    // 18. The role moves to the worker: Main follows the project's orchestrator, its sessions kept, and its next send
    //     reaches the new one (the orchestrator's decision of 2026-10-13).
    const mainBefore = (await chats()).find((c) => c.number === 1)!;
    const w1Launches = launchesOf('w1').length;
    const aLaunches = launchesOf(runnerA.id).length;
    expect(await updateFromWindow({ id: 'w1', role: 'orchestrator' })).toMatchObject({ success: true });
    // Rebound when the role moved, before any list of the chats could do it: read from the file.
    const mainOnDisk = (JSON.parse(fs.readFileSync(path.join(dir, 'chats.json'), 'utf8')) as { chats: ChatRecord[] }).chats.find((c) => c.number === 1);
    keep({ mainOnDisk });
    expect(mainOnDisk?.runnerId).toBe('w1');
    expect((await chats()).find((c) => c.number === 1)?.runnerId).toBe('w1');
    expect((await agentOf('o1'))?.role).toBe('worker');
    await expect.poll(() => launchesOf('w1').length, { timeout: 60_000 }).toBeGreaterThan(w1Launches);
    await ownSession('w1');
    await atRest('w1');
    const mainAfter = (await chats()).find((c) => c.number === 1)!;
    keep({ mainBefore, mainAfter });
    expect(mainAfter.sessionIds).toEqual(expect.arrayContaining(mainBefore.sessionIds));
    expect(mainAfter.sessionIds).toContain(launchesOf('w1')[0].sid);
    const toNewLead = await send(main.id, 'MAIN>> after the move');
    keep({ toNewLead });
    expect(toNewLead).toMatchObject({ success: true, runnerId: 'w1' });
    await expect.poll(() => promptsOf('w1').some((p) => p.includes('MAIN>> after the move')), { timeout: 30_000 }).toBe(true);
    expect(promptsOf('o1').some((p) => p.includes('MAIN>> after the move'))).toBe(false);
    await atRest('w1');
    // Runner A follows the new orchestrator: Tars restarts it once its turn of step 16 ends. Step 19's first send
    // needs A's slot, which A gives up only at rest: still in that turn, or starting again, it answered chat_limit
    // (QA's run of 2.0.1 met both). Its new session up, then at rest.
    await expect.poll(() => launchesOf(runnerA.id).length, { timeout: 60_000 }).toBeGreaterThan(aLaunches);
    await ownSession(runnerA.id);
    await atRest(runnerA.id);

    // 19. The orchestrator moves to a CLI whose conversations Tars cannot resume (L4) while chat C's runner is in a
    //     turn, with work out at a worker. A send to C is refused at once, its runner running or not (2.0.1): C is
    //     left to finish, its turn not cut, the worker's answer still reaching it, and it is neither copied onto that
    //     CLI nor restarted on it. The holds are off the first lines: a note quotes a request's first line.
    const forWorker = await api('/api/agents/o1/dispatch', runnerC.id, { message: 'Work for C, before the move\nHOLD>> until released' });
    expect(forWorker.status).toBe(200);
    await expect.poll(async () => (await agentOf('o1'))?.status, { timeout: 30_000 }).toBe('running');
    expect(await send(startedChat.id, 'C>> before the lead moves\nHOLD>> until released')).toMatchObject({ success: true });
    // In its turn: a launch, when C slept, is recorded before the turn's prompt, and its status runs ahead of both.
    await expect.poll(() => promptsOf(runnerC.id).some((p) => p.includes('C>> before the lead moves')), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await agentOf(runnerC.id))?.status, { timeout: 30_000 }).toBe('running');
    const cLaunches = launchesOf(runnerC.id).length;
    const cTurns = promptsOf(runnerC.id).length;
    expect(await updateFromWindow({ id: 'w1', provider: 'gemini' })).toMatchObject({ success: true });
    const whileRunning = await send(startedChat.id, 'C>> while the lead is off claude');
    // The worker, still in its turn, answers whoever asked for it: C.
    const workerAnswer = await api('/api/agents/requester/message', 'o1', { message: 'ANSWER>> for C' });
    keep({ forWorker, whileRunning, workerAnswer });
    expect(whileRunning).toMatchObject({ error: 'provider_unsupported' });
    expect(String(whileRunning.reason)).toContain("This chat's runner, still running on claude, is left to finish");
    expect(workerAnswer.status).toBe(200);
    expect(workerAnswer.body).toMatchObject({ deliveredTo: { id: runnerC.id, how: 'requester' } });
    release('o1');
    release(runnerC.id);
    await expect.poll(() => promptsOf(runnerC.id).some((p) => p.includes('ANSWER>> for C')), { timeout: 30_000 }).toBe(true);
    await atRest(runnerC.id);
    const cAfter = await agentOf(runnerC.id);
    keep({ cAfter, cTurnsAfter: promptsOf(runnerC.id).slice(cTurns) });
    expect(cAfter?.provider ?? 'claude').toBe('claude');
    expect(cAfter?.cliRunning).toBe(true);
    expect(launchesOf(runnerC.id)).toHaveLength(cLaunches);
    expect(promptsOf(runnerC.id).some((p) => p.includes('C>> while the lead is off claude'))).toBe(false);
    // A chat whose runner is not running is refused too, without being told of a runner that runs.
    const suspended = await send(chatA.id, 'A>> after the lead moved');
    keep({ suspended });
    expect(suspended).toMatchObject({ error: 'provider_unsupported' });
    expect(String(suspended.reason)).not.toContain('still running');
  } finally {
    for (const id of ['o1', 'w1']) fs.writeFileSync(path.join(home, `release-${id}`), '');
    await app.close();
    // Kept with the run, then the sandbox goes: each run left its HOME behind, 20 MB of worktrees and logs.
    const hooksLog = path.join(dir, 'logs', 'hooks.log');
    for (const file of [launchesFile, promptsFile, sessionsFile, permissionsFile, hooksLog]) if (fs.existsSync(file)) fs.copyFileSync(file, test.info().outputPath(path.basename(file)));
    await removeHome(home);
  }
});
