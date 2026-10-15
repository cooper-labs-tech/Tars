import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort, PORT_OFFSET } from './ports.mjs';

/**
 * The effort real Claude Code sends, in each request, for agents Tars starts (JeanBrasse, 2026-10-13: "la moitié du temps
 * les agents se réveillent avec le mauvais niveau d'effort par rapport à leur paramètre").
 *
 * effort-every-start.spec.ts pins the launch side with a stand-in: every path hands the CLI the agent's own
 * `--effort`. This one asks the real CLI what it does with it. Two agents on the native claude, talking to the stub
 * Messages API (which logs `output_config.effort` of each request), in a sandbox HOME whose ~/.claude/settings.json
 * saves another level for the model, as `/effort` writes it:
 * 1. A, started at max, sends max;
 * 2. a plain write of settings.json (another level, as Tars rewrites that file for its hooks and status line):
 *    A still sends max;
 * 3. B, started at high, is typed `/effort low`, which saves low in settings.json: A still sends max, B sends low;
 * 4. B, its session last run at low and its record now max, is put to sleep (sleepNow, the pass's own) and woken: the CLI resumes that session
 *    (`--resume`, no fork) with `--effort max` and sends max, not its last level and not the saved one. The session is read once the woken
 *    CLI has taken its turn, so that a fork, or a session of its own, has registered: it must be the one B slept in.
 * The artefact: values.json (each request's effort), the stub's log, and the app trace.
 */

const WT = path.resolve('.');
const DIST = `${WT}/electron/dist`;
const STUB = 31984 + PORT_OFFSET;
const KEY = `sk-ant-api03-e2e-live-${'0'.repeat(80)}-AAAAAAAA`;
const MODEL = 'claude-opus-5-5';

function resolveClaude(): string {
  const named = process.env.E2E_CLAUDE;
  const found = named || (() => { try { return execFileSync('which', ['claude']).toString().trim(); } catch { return ''; } })();
  return found ? fs.realpathSync(found) : '';
}

test('real claude sends each agent its own effort: at launch, after settings.json is rewritten, after /effort elsewhere, and at a wake', async () => {
  test.skip(process.env.E2E_LIVE !== '1', 'live: E2E_LIVE=1 and a native claude');
  const CLAUDE = resolveClaude();
  test.skip(!CLAUDE, 'no claude: set E2E_CLAUDE or put claude on PATH');
  test.setTimeout(8 * 60_000);
  const OUT = test.info().outputPath();
  fs.mkdirSync(OUT, { recursive: true });
  const FAKE_LOG = path.join(OUT, 'fake.log');

  const home = fs.mkdtempSync('/tmp/tars-effort-live-');
  const projects = { a: path.join(home, 'projects', 'alpha'), b: path.join(home, 'projects', 'beta') };
  for (const dir of [path.join(home, '.claude'), path.join(home, '.dorothy'), projects.a, projects.b]) fs.mkdirSync(dir, { recursive: true });
  for (const p of Object.values(projects)) execFileSync('git', ['init', '-q', p]);
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const saved = (level: string) => ({ modelSettings: { [MODEL]: { effortLevel: level } } });
  fs.writeFileSync(settingsFile, JSON.stringify({ tui: 'fullscreen', theme: 'dark', skipDangerousModePermissionPrompt: true, ...saved('medium') }, null, 2));
  const version = path.basename(CLAUDE);
  const trusted = { hasTrustDialogAccepted: true, allowedTools: [], hasCompletedProjectOnboarding: true };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    numStartups: 5, installMethod: 'native', autoUpdates: false, theme: 'dark', hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true,
    lastOnboardingVersion: version, lastReleaseNotesSeen: version, customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
    projects: Object.fromEntries(Object.values(projects).flatMap((p) => [[p, trusted], [fs.realpathSync(p), trusted]])),
  }, null, 2));
  const agent = (id: string, name: string, projectPath: string, effort: string) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath, skills: [], output: [],
    permissionMode: 'bypass', cliPath: CLAUDE, model: MODEL, effort, lastActivity: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(home, '.dorothy', 'agents.json'), JSON.stringify([agent('a', 'Alpha', projects.a, 'max'), agent('b', 'Beta', projects.b, 'high')], null, 2));
  fs.writeFileSync(path.join(home, '.dorothy', 'projects.json'), JSON.stringify(Object.values(projects), null, 2));
  fs.writeFileSync(path.join(home, '.dorothy', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }, null, 2));
  fs.writeFileSync(path.join(home, '.dorothy', 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude: CLAUDE } }, null, 2));

  const stub = spawn(process.execPath, [path.join(WT, 'e2e', 'live', 'fake-messages-api.mjs')], {
    env: { PATH: process.env.PATH, FAKE_PORT: String(STUB), FAKE_LOG }, stdio: 'ignore',
  });
  type Req = { last?: string; tail?: string; effort?: string | null; side?: boolean };
  /** A turn that carries `word`: at its start, or at its end behind a local command's caveat. */
  const carries = (r: Req, word: string) => !r.side && [r.last, r.tail].some((text) => (text ?? '').includes(word));
  const requests = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Req) : []);
  const values: Record<string, unknown> = { claude: CLAUDE };
  const seen: Array<{ step: string; agent: string; sent: string | null; own: string; settings: string }> = [];
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const app = await launchSandboxed(electron, home, {
      env: {
        NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31437), DOROTHY_E2E: '1',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB}`, ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      },
    });
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
      type A = { status: string; currentSessionId?: string; cliRunning?: boolean };
      const agentOf = (id: string) => page.evaluate((i) => (window as unknown as { electronAPI: { agent: { get(id: string): Promise<A> } } }).electronAPI.agent.get(i), id);
      const call = (name: string, arg: unknown) => page.evaluate(([name, arg]) =>
        (window as unknown as { electronAPI: { agent: Record<string, (a: unknown) => Promise<unknown>> } }).electronAPI.agent[name as string](arg), [name, arg] as const);
      const type = (id: string, text: string) => app.evaluate((_e, [dist, id, text]) => {
        const req = (process as unknown as { mainModule: { require(m: string): Record<string, unknown> } }).mainModule.require;
        const a = (req(`${dist}/core/agent-manager.js`).agents as Map<string, { ptyId?: string }>).get(id);
        const { ptyProcesses, writeProgrammaticInput } = req(`${dist}/core/pty-manager.js`) as { ptyProcesses: Map<string, unknown>; writeProgrammaticInput: (p: unknown, t: string, s: boolean) => unknown };
        return a?.ptyId ? writeProgrammaticInput(ptyProcesses.get(a.ptyId), text, true) : null;
      }, [DIST, id, text] as const);
      const settingsLevel = () => {
        try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')).modelSettings?.[MODEL]?.effortLevel ?? 'none'; } catch { return 'unreadable'; }
      };
      /** One turn: the effort of the request that carried `word`. */
      const turn = async (step: string, id: string, word: string, own: string) => {
        await expect.poll(async () => (await agentOf(id)).status, { timeout: 60_000 }).toMatch(/^(idle|waiting|completed)$/);
        expect(await type(id, word)).not.toBeNull();
        await expect.poll(() => requests().some((r) => carries(r, word)), { timeout: 90_000, message: `${step}: ${word} reached the model` }).toBe(true);
        const sent = requests().filter((r) => carries(r, word)).at(-1)!.effort ?? null;
        seen.push({ step, agent: id, sent, own, settings: settingsLevel() });
        values.seen = seen;
        recordValues(values);
        expect.soft(sent, `${step}: ${id} sent ${sent}, its own is ${own}`).toBe(own);
      };
      const running = (id: string) => expect.poll(async () => { const a = await agentOf(id); return !!(a.cliRunning && a.currentSessionId); }, { timeout: 90_000 }).toBe(true);

      // ── 1. Launch ──
      await call('start', { id: 'a', prompt: '' });
      await running('a');
      await turn('launch', 'a', 'EFFA1', 'max');

      // ── 2. settings.json rewritten, as Tars writes it ──
      const now = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      fs.writeFileSync(settingsFile, JSON.stringify({ ...now, ...saved('xhigh') }, null, 2));
      await new Promise((r) => setTimeout(r, 3_000));
      await turn('after a plain write of settings.json', 'a', 'EFFA2', 'max');

      // ── 3. /effort in another session ──
      await call('start', { id: 'b', prompt: '' });
      await running('b');
      await turn('launch', 'b', 'EFFB1', 'high');
      await type('b', '/effort low');
      await expect.poll(settingsLevel, { timeout: 30_000, message: '/effort low saved in settings.json' }).toBe('low');
      // What /effort leaves on B's screen, closed as a person would, with Esc.
      await app.evaluate((_e, [dist]) => {
        const req = (process as unknown as { mainModule: { require(m: string): Record<string, unknown> } }).mainModule.require;
        const b = (req(`${dist}/core/agent-manager.js`).agents as Map<string, { ptyId?: string }>).get('b')!;
        ((req(`${dist}/core/pty-manager.js`).ptyProcesses as Map<string, { write(d: string): void }>).get(b.ptyId!))!.write('\x1b');
      }, [DIST] as const);
      await new Promise((r) => setTimeout(r, 3_000));
      await turn('after /effort low in another session', 'a', 'EFFA3', 'max');
      await turn('its own /effort low', 'b', 'EFFB2', 'low');

      // ── 4. A wake, its session last run at low, its record now max ──
      const sid = (await agentOf('b')).currentSessionId!;
      await app.evaluate((_e, [dist]) => {
        const req = (process as unknown as { mainModule: { require(m: string): Record<string, unknown> } }).mainModule.require;
        const b = (req(`${dist}/core/agent-manager.js`).agents as Map<string, Record<string, unknown>>).get('b')!;
        b.effort = 'max';
      }, [DIST] as const);
      // Put to sleep as the pass of every minute does once the rule allows it (agent-sleep.spec.ts drives the rule).
      await app.evaluate(async (_e, [dist]) => {
        const req = (process as unknown as { mainModule: { require(m: string): Record<string, unknown> } }).mainModule.require;
        const b = (req(`${dist}/core/agent-manager.js`).agents as Map<string, unknown>).get('b');
        await (req(`${dist}/services/agent-sleep.js`) as { sleepNow(a: unknown, why: string): Promise<void> }).sleepNow(b, 'e2e: rested');
      }, [DIST] as const);
      await expect.poll(async () => (await agentOf('b')).status, { timeout: 30_000 }).toBe('asleep');
      expect(await call('wake', 'b')).toMatchObject({ success: true });
      await running('b');
      await turn('wake, last run at low, record max', 'b', 'EFFB3', 'max');
      values.wakeResumed = { before: sid, after: (await agentOf('b')).currentSessionId };
      recordValues(values);
      expect.soft(values.wakeResumed, 'wake: B resumed the session it slept in, not a fork or a new one').toEqual({ before: sid, after: sid });
    } finally {
      values.requests = requests();
      recordValues(values);
      await app.close();
    }
  } finally {
    stub.kill();
    // removeHome retries: a real claude can write ~/.claude.json after app.close() (the QA's Info on #404).
    await removeHome(home);
  }
});
