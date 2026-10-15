// Opt-in live E2E: E2E_LIVE=1 npx playwright test e2e/turn-usage.live.spec.ts
//
// Each turn's usage in the task ledger (mods step 4, JeanBrasse's go of 2026-10-06),
// in a sandbox Tars with real Claude Code against the fake Messages API
// (e2e/live/fake-messages-api.mjs), so no quota is spent. One agent, on the
// state mod, given two turns:
// - "RUNBG first": a turn of two requests (a background Bash, then the reply);
// - "LINES 3 second": a turn of one, in the same task, since the Bash left
//   running in the background keeps the first task open (task-ledger.ts).
// The mod reports each turn's usage from Claude Code's turn.complete, which
// comes after the Stop that ended its task; the ledger files it under that
// task. Then:
// - with the transcript there, usage.tasks prices each task from it, as before
//   (`from: 'transcript'`), and its tokens are the turns' tokens;
// - with the transcript gone, usage.tasks still prices both, from the turns,
//   at the same figures (this fake writes no cache, so the two must agree).
//
// Needs a native claude at 2.1.289 or newer: E2E_CLAUDE, or the `claude` on
// PATH. Its artefact, in the run directory: facts.jsonl, values.json, fake.log.
import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, PORT_OFFSET, apiPort } from './ports.mjs';

const WT = process.cwd();
const DIST = `${WT}/electron/dist`;
const PORT = apiPort(31462);
const STUB = 31962 + PORT_OFFSET;
const KEY = `sk-ant-api03-e2e-live-${'0'.repeat(80)}-AAAAAAAA`;
let FACTS = '';

function resolveClaude(): string {
  const named = process.env.E2E_CLAUDE;
  const found = named || (() => { try { return execFileSync('which', ['claude']).toString().trim(); } catch { return ''; } })();
  return found ? fs.realpathSync(found) : '';
}

function seed(claude: string): { home: string; project: string } {
  const home = fs.mkdtempSync('/tmp/tars-usage-');
  const project = path.join(home, 'projects', 'usage');
  for (const dir of [path.join(home, '.claude'), path.join(home, '.dorothy'), project]) fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', skipDangerousModePermissionPrompt: true }, null, 2));
  const version = path.basename(claude);
  const trusted = { hasTrustDialogAccepted: true, allowedTools: [], hasCompletedProjectOnboarding: true };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    numStartups: 5, installMethod: 'native', autoUpdates: false, theme: 'dark',
    hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true,
    lastOnboardingVersion: version, lastReleaseNotesSeen: version,
    customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
    projects: { [project]: trusted, [fs.realpathSync(project)]: trusted },
  }, null, 2));
  fs.writeFileSync(path.join(home, '.dorothy', 'agents.json'), JSON.stringify([{
    id: 'worker', name: 'Usage Worker', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], output: [], permissionMode: 'bypass', cliPath: claude, lastActivity: new Date().toISOString(),
  }], null, 2));
  fs.writeFileSync(path.join(home, '.dorothy', 'projects.json'), JSON.stringify([project], null, 2));
  fs.writeFileSync(path.join(home, '.dorothy', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }, null, 2));
  fs.writeFileSync(path.join(home, '.dorothy', 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude },
  }, null, 2));
  return { home, project };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const fact = (step: string, data: unknown) => {
  fs.appendFileSync(FACTS, JSON.stringify({ t: new Date().toISOString(), step, data }) + '\n');
};
async function waitFor<T>(fn: () => Promise<T> | T, ms: number, what: string, seen?: () => Promise<unknown>): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out after ${ms} ms: ${what}${seen ? `; last seen ${JSON.stringify(await seen())}` : ''}`);
}

type Usage = Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
type Row = { id: string; text: string; costUSD: number | null; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } | null; from?: string | null };

test("each turn's usage is kept in the task ledger, and prices a task whose transcript is gone at the same figures", async () => {
  test.skip(process.env.E2E_LIVE !== '1', 'live: E2E_LIVE=1 and a native claude');
  test.setTimeout(6 * 60_000);
  const CLAUDE = resolveClaude();
  test.skip(!CLAUDE, 'no claude: set E2E_CLAUDE or put claude on PATH');
  const OUT = test.info().outputPath();
  fs.mkdirSync(OUT, { recursive: true });
  FACTS = path.join(OUT, 'facts.jsonl');
  const FAKE_LOG = path.join(OUT, 'fake.log');
  const { home: HOME, project } = seed(CLAUDE);
  const stub = spawn(process.execPath, [path.join(WT, 'e2e', 'live', 'fake-messages-api.mjs')], {
    env: { PATH: process.env.PATH, FAKE_PORT: String(STUB), FAKE_LOG }, stdio: 'ignore',
  });
  let app: Awaited<ReturnType<typeof launchSandboxed>> | undefined;
  try {
    await waitFor(async () => { try { await fetch(`http://127.0.0.1:${STUB}/`); return true; } catch { return false; } }, 30_000, 'fake API up');
    app = await launchSandboxed(electron, HOME, {
      env: {
        NODE_ENV: 'development', DOROTHY_DEV_URL: `${DEV_URL}/`, DOROTHY_API_PORT: PORT, DOROTHY_E2E: '1',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB}`, ANTHROPIC_API_KEY: KEY,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      },
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI, null, { timeout: 300_000 });
    const settingsPath = path.join(HOME, '.claude', 'settings.json');
    await waitFor(() => { try { return !!JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks; } catch { return false; } }, 60_000, 'hooks configured');

    /** The ledger's tasks, with each turn's usage as it was filed. */
    const ledger = () => app!.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      const tasks = req(`${dist}/services/task-ledger.js`).liveTaskLedger()?.tasks() ?? [];
      return tasks.map((t: { id: string; text: string; sessionIds: string[]; usageByModel?: unknown; usageTurns?: number; endedAt: number | null }) =>
        ({ id: t.id, text: t.text, sessionIds: t.sessionIds, usageByModel: t.usageByModel ?? null, usageTurns: t.usageTurns ?? 0, endedAt: t.endedAt }));
    }, { dist: DIST });
    const report = () => app!.evaluate(async (_e, { dist }) => {
      const req = process.mainModule!.require;
      const r = await req(`${dist}/services/task-watch.js`).tasksReport({ sinceDays: 1 });
      return r.tasks.map((t: Row) => ({ id: t.id, text: t.text, costUSD: t.costUSD, tokens: t.tokens, from: t.from ?? null }));
    }, { dist: DIST });
    const agentState = () => app!.evaluate((_e, { dist }) => {
      const a = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get('worker');
      return a && { status: a.status, output: a.lastCleanOutput ?? null, session: a.currentSessionId ?? null };
    }, { dist: DIST });

    // Two tasks: a turn of two requests, then one of one.
    await page.evaluate(() => (window as unknown as { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } }).electronAPI.agent.start({ id: 'worker', prompt: 'RUNBG first' }));
    await waitFor(async () => { const s = await agentState(); return s?.status === 'idle' || s?.status === 'waiting'; }, 120_000, 'the first task over', agentState);
    await waitFor(async () => (await ledger()).some(t => t.usageTurns > 0), 20_000, 'the first turn\'s usage filed');
    await page.evaluate(() => (window as unknown as { electronAPI: { agent: { sendInput(p: { id: string; input: string }): Promise<unknown> } } }).electronAPI.agent.sendInput({ id: 'worker', input: 'LINES 3 second\r' }));
    await waitFor(async () => { const s = await agentState(); return (s?.status === 'idle' || s?.status === 'waiting') && String(s.output).includes('second line 3 of 3'); }, 120_000, 'the second task over', agentState);
    await waitFor(async () => (await ledger()).reduce((n, t) => n + t.usageTurns, 0) >= 2, 20_000, 'the second turn\'s usage filed', ledger);

    const tasks = await ledger();
    fact('ledger', tasks);
    const used = tasks.filter(t => t.usageTurns > 0);
    const fromTranscript = await report();
    fact('report with the transcript', fromTranscript);

    // The transcript gone: what the turns alone give.
    const session = (await agentState())!.session!;
    const transcripts = [project, fs.realpathSync(project)].map(p => path.join(HOME, '.claude', 'projects', p.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`));
    const removed = transcripts.filter(f => fs.existsSync(f));
    for (const f of removed) fs.renameSync(f, `${f}.moved`);
    const fromTurns = await report();
    fact('report without it', { removed, fromTurns });
    recordValues({ claude: CLAUDE, tasks, fromTranscript, fromTurns, removed });

    // Two turns, the first's two requests summed (10 and 5 each from this fake), the second's one.
    const model = Object.keys(used[0].usageByModel as Usage)[0];
    const sum = (k: 'input' | 'output') => used.reduce((n, t) => n + (t.usageByModel as Usage)[model][k], 0);
    expect(used.reduce((n, t) => n + t.usageTurns, 0)).toBe(2);
    expect({ input: sum('input'), output: sum('output') }).toEqual({ input: 30, output: 15 });
    // The figures, unchanged where the transcript is: priced from it, its tokens the turns'.
    const row = (rows: Row[], id: string) => rows.find(r => r.id === id)!;
    for (const t of used) {
      expect(row(fromTranscript, t.id).from).toBe('transcript');
      expect(row(fromTranscript, t.id).tokens).toMatchObject({ input: (t.usageByModel as Usage)[model].input, output: (t.usageByModel as Usage)[model].output });
    }
    // Without it, still counted, from the turns, at the same figures.
    expect(removed.length).toBeGreaterThan(0);
    for (const t of used) {
      expect(row(fromTurns, t.id).from).toBe('turns');
      expect(row(fromTurns, t.id).costUSD).toBe(row(fromTranscript, t.id).costUSD);
      expect(row(fromTurns, t.id).tokens).toEqual(row(fromTranscript, t.id).tokens);
    }
  } finally {
    // Its background `sleep 600` ends with its terminal.
    await app?.evaluate(async (_e, { dist }) => {
      const req = process.mainModule!.require;
      const a = req(`${dist}/core/agent-manager.js`).agents.get('worker');
      if (a) await req(`${dist}/core/agent-stop.js`).stopAgent(a, { by: 'you', reason: 'the spec is over' }, { save: () => undefined, announce: () => undefined });
    }, { dist: DIST }).catch(() => {});
    await app?.close().catch(() => {});
    stub.kill();
  }
});
