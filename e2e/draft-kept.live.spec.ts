// Opt-in live E2E: E2E_LIVE=1 npx playwright test e2e/draft-kept.live.spec.ts (E2E_CLAUDE names the claude; by
// default the 2.1.306 of ~/.local/share/claude/versions, the version of JeanBrasse's report, else the claude on PATH).
//
// JeanBrasse's draft is sacred (his report of 22/10, Tars 2.0.3, Claude Code 2.1.306, « ça a delete mon message »):
// a task-end notice reached the orchestrator's terminal while he was typing a long message there; the beginning of
// his draft went, and the notice went out with the tail of his draft behind it. Tars never clears, edits or submits
// what the person typed: a message waits until the field is empty, and the window says one is waiting.
//
// A sandbox Tars with two real Claude Codes against the fake Messages API: the orchestrator `lead`, whose panel on
// the Dashboard is typed into as a person types (Playwright's keyboard and mouse, through xterm), and the worker `wk`.
// For each draft (one line; several lines, Shift+Enter between them; a 900-character paste, folded by Claude Code;
// the caret moved left; a click inside the text, which moves Claude Code's caret), while it sits in lead's field:
// - lead hands wk a task (run-task, lead's own token): wk starts on it, answers, and its turn's end is a notice
//   Tars writes into lead's terminal ("has finished its turn");
// - wk sends lead a message (/api/agents/lead/message, wk's own token), as send_message does.
// Asserted, once with the classic shell and once with the new interface:
// 1. nothing reaches lead's model while the draft is in the field; the draft is still on lead's screen; the panel
//    says a message is waiting;
// 2. Enter: what reaches the model is the draft, whole, and nothing of Tars's;
// 3. then the notice and the message reach the model, each after the draft, never inside its submission.
//
// Its artefact, in the run directory: values.json (per shell and draft: what reached the model, the screen, the
// notice), facts.jsonl (every chunk the panel sent, escaped), fake.log, the screens, app-trace.zip.
import { test, expect, _electron as electron, type Page, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { launchSandboxed, recordValues, markWhatsNewSeen, stepShot } from './fixture.mjs';
import { DEV_URL, PORT_OFFSET, apiPort } from './ports.mjs';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';

const WT = process.cwd();
const DIST = `${WT}/electron/dist`;
const KEY = `sk-ant-api03-e2e-live-${'0'.repeat(80)}-AAAAAAAA`;
const NOTICE = 'has finished its turn';

function resolveClaude(): string {
  const pinned = path.join(os.homedir(), '.local', 'share', 'claude', 'versions', '2.1.306');
  const named = process.env.E2E_CLAUDE || (fs.existsSync(pinned) ? pinned : '');
  const found = named || (() => { try { return execFileSync('which', ['claude']).toString().trim(); } catch { return ''; } })();
  return found ? fs.realpathSync(found) : '';
}

function seed(claude: string, newInterface: boolean): { home: string; project: string } {
  const home = fs.mkdtempSync('/tmp/tars-draft-kept-');
  const project = path.join(home, 'projects', 'kept');
  for (const dir of [path.join(home, '.claude'), path.join(home, '.tars'), project]) fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ tui: 'fullscreen', skipDangerousModePermissionPrompt: true }, null, 2));
  const version = path.basename(claude);
  const trusted = { hasTrustDialogAccepted: true, allowedTools: [], hasCompletedProjectOnboarding: true };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    numStartups: 5, installMethod: 'native', autoUpdates: false, hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true,
    lastOnboardingVersion: version, lastReleaseNotesSeen: version, customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] },
    projects: { [project]: trusted, [fs.realpathSync(project)]: trusted },
  }, null, 2));
  const agent = (id: string, name: string, role: string) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role, projectPath: project, skills: [], output: [],
    permissionMode: 'bypass', cliPath: claude, lastActivity: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(home, '.tars', 'agents.json'), JSON.stringify([agent('lead', 'Lead', 'orchestrator'), agent('wk', 'Wren', 'worker')], null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'projects.json'), JSON.stringify([project], null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }, null, 2));
  fs.writeFileSync(path.join(home, '.tars', 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude }, newInterface,
  }, null, 2));
  return { home, project };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T> | T, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out after ${ms} ms: ${what}`);
}

type Request = { url?: string; side?: boolean; stream?: boolean; last?: string; tail?: string };

interface Draft {
  name: string;
  /** What the person does in lead's field. */
  type: (page: Page) => Promise<void>;
  /** What must still be on lead's screen while the message waits. */
  onScreen: string;
  /** What the submission must carry, every piece of it. */
  carried: string[];
}

const PASTE = `PASTE${'p'.repeat(895)}`;
const DRAFTS: Draft[] = [
  {
    name: 'one line',
    type: async (page) => { await page.keyboard.type('DRAFTA je pense quil faut gerer ca avec Pencil en plus', { delay: 15 }); },
    onScreen: 'DRAFTA je pense quil faut gerer ca avec Pencil en plus',
    carried: ['DRAFTA je pense quil faut gerer ca avec Pencil en plus'],
  },
  {
    name: 'several lines',
    type: async (page) => {
      await page.keyboard.type('DRAFTB premiere ligne', { delay: 15 });
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type('deuxieme ligne', { delay: 15 });
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type('troisieme ligne', { delay: 15 });
    },
    onScreen: 'troisieme ligne',
    carried: ['DRAFTB premiere ligne', 'deuxieme ligne', 'troisieme ligne'],
  },
  {
    name: 'a 900-character paste',
    type: async (page) => {
      // Through xterm's own paste listener, as Cmd+V reaches it, without the system clipboard.
      await page.locator('[data-agent-panel="lead"] .xterm-helper-textarea').evaluate((el, text) => {
        const data = new DataTransfer();
        data.setData('text/plain', text);
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }, PASTE);
    },
    onScreen: 'Pasted text',
    carried: [PASTE.slice(0, 150)],
  },
  {
    name: 'the caret moved left',
    type: async (page) => {
      await page.keyboard.type('DRAFTD alpha beta gamma delta', { delay: 15 });
      for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
    },
    onScreen: 'DRAFTD alpha beta gamma delta',
    carried: ['DRAFTD alpha beta gamma delta'],
  },
  {
    name: 'a click inside the text',
    type: async (page) => {
      await page.keyboard.type('DRAFTE alpha beta gamma delta epsilon', { delay: 15 });
      await sleep(600);
      // A click on the "g" of "gamma", where the person would put the caret to edit.
      const at = await page.locator('[data-agent-panel="lead"] .xterm-rows').evaluate((rows) => {
        const walker = document.createTreeWalker(rows, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const i = (node.textContent ?? '').indexOf('gamma delta epsilon');
          if (i < 0) continue;
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const r = range.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        return null;
      });
      if (!at) throw new Error('the draft is not on the screen to be clicked');
      await page.mouse.click(at.x, at.y);
    },
    onScreen: 'DRAFTE alpha beta gamma delta epsilon',
    carried: ['DRAFTE alpha beta gamma delta epsilon'],
  },
];

for (const newInterface of [false, true]) {
  test(`a draft in the orchestrator's field is never touched by a task-end notice or a message (${newInterface ? 'new' : 'classic'} interface)`, async () => {
    test.skip(process.env.E2E_LIVE !== '1', 'live: E2E_LIVE=1 and a native claude');
    test.setTimeout(20 * 60_000);
    const CLAUDE = resolveClaude();
    test.skip(!CLAUDE, 'no claude: set E2E_CLAUDE or put claude on PATH');
    const shell = newInterface ? 'new' : 'classic';
    const OUT = test.info().outputPath();
    fs.mkdirSync(OUT, { recursive: true });
    const FAKE_LOG = path.join(OUT, 'fake.log');
    const FACTS = path.join(OUT, 'facts.jsonl');
    const fact = (step: string, data: Record<string, unknown>) => fs.appendFileSync(FACTS, JSON.stringify({ t: new Date().toISOString(), step, ...data }) + '\n');
    const { home } = seed(CLAUDE, newInterface);
    const port = apiPort(newInterface ? 31309 : 31308);
    const stubPort = (newInterface ? 31971 : 31970) + PORT_OFFSET;
    const values: Record<string, unknown> = { claude: CLAUDE, shell, drafts: [] as unknown[] };
    const stub = spawn(process.execPath, [path.join(WT, 'e2e', 'live', 'fake-messages-api.mjs')], {
      env: { PATH: process.env.PATH, FAKE_PORT: String(stubPort), FAKE_LOG }, stdio: 'ignore',
    });
    const requests = (): Request[] => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
      .filter((l: Request) => l.url && !l.side && l.stream);
    const textOf = (r: Request) => `${r.last ?? ''}\n${r.tail ?? ''}`;
    let app: ElectronApplication | undefined;
    try {
      await waitFor(async () => { try { await fetch(`http://127.0.0.1:${stubPort}/`); return true; } catch { return false; } }, 10_000, 'fake API up');
      app = await launchSandboxed(electron, home, {
        env: {
          NODE_ENV: 'development', DOROTHY_DEV_URL: `${DEV_URL}/`, DOROTHY_API_PORT: port, DOROTHY_E2E: '1',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${stubPort}`, ANTHROPIC_API_KEY: KEY,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        },
      });
      await app.context().tracing.start({ screenshots: true, snapshots: true }).catch(() => undefined);
      // The main process's own log, which says why a message waits and when it goes in.
      const mainLog = path.join(OUT, 'main.log');
      app.process().stdout?.on('data', (d: Buffer) => fs.appendFileSync(mainLog, d));
      app.process().stderr?.on('data', (d: Buffer) => fs.appendFileSync(mainLog, d));
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI, null, { timeout: 300_000 });

      // Every chunk a panel sends, recorded before the handler gets it.
      await app.evaluate(({ ipcMain }) => {
        const g = globalThis as unknown as { __rec: Array<{ at: number; id: string; input: string }> };
        g.__rec = [];
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
        const h = handlers.get('agent:input')!;
        handlers.set('agent:input', async (event: unknown, ...args: unknown[]) => {
          const a = args[0] as { id: string; input: string };
          g.__rec.push({ at: Date.now(), id: a?.id, input: a?.input });
          return h(event, ...args);
        });
      });
      const chunks = () => app!.evaluate(() => (globalThis as unknown as { __rec: Array<{ id: string; input: string }> }).__rec);

      const ids = await app.evaluate((_e, dist) => {
        const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
        return { lead: tokens.mintRunToken('lead').token as string, wk: tokens.mintRunToken('wk').token as string, tars: tokens.internalToken() as string };
      }, DIST);
      const api = (route: string, token: string, body: Record<string, unknown>, as?: string) => fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(as ? { 'X-Tars-Caller-Id': as } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }));
      const agentState = (id: string) => page.evaluate(async (who) => {
        const a = (await (window as unknown as { electronAPI: { agent: { list(): Promise<Array<Record<string, unknown>>> } } }).electronAPI.agent.list()).find((x) => x.id === who)!;
        return { status: String(a.status), session: !!a.currentSessionId, cli: !!a.cliRunning };
      }, id);
      const atRest = async (id: string) => waitFor(async () => { const s = await agentState(id); return s.session && s.status !== 'running'; }, 120_000, `${id} at rest`);
      const leadScreen = () => page.locator('[data-agent-panel="lead"] .xterm-rows').innerText().catch(() => '');
      const notice = page.locator('[data-agent-panel="lead"] [role="status"]').filter({ hasText: /waiting/i });

      // Lead's session, started with a first turn and at rest.
      const started = await api('/api/agents/lead/start', ids.tars, { prompt: 'LINES 1 boot' });
      fact('lead started', { status: started.status, body: started.body });
      await atRest('lead');
      const panel = page.locator('[data-agent-panel="lead"] .xterm-screen');
      await waitFor(async () => (await panel.count()) > 0 && (await panel.isVisible()), 60_000, "lead's panel on the Dashboard");
      await sleep(3000);

      // E2E_DRAFTS=1,3 runs only those drafts (numbered from 1), for a look at one of them.
      const only = (process.env.E2E_DRAFTS ?? '').split(',').filter(Boolean).map(Number);
      let n = 0;
      for (const draft of DRAFTS) {
        n += 1;
        if (only.length && !only.includes(n)) continue;
        const entry: Record<string, unknown> = { draft: draft.name };
        (values.drafts as unknown[]).push(entry);
        await atRest('lead');
        await sleep(2000);
        // Focus lead's field: a click on its prompt line, an empty field.
        const box = (await panel.boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height - 30);
        await sleep(500);
        await draft.type(page);
        await sleep(800);
        const before = requests().length;
        const seenChunks = (await chunks()).length;

        // The two messages, while the draft sits in the field.
        const task = `LINES 1 tk${n}`;
        const handed = await api('/api/agents/wk/run-task', ids.lead, { task }, 'lead');
        const sent = await api('/api/agents/lead/message', ids.wk, { message: `SENDMSG${n} the review notes are in the folder` }, 'wk');
        entry.handed = { status: handed.status, task: handed.body.taskId ?? handed.body.error };
        entry.sent = { status: sent.status, body: sent.body };
        // wk's task reaches its model and its turn ends: the notice is due in lead's terminal.
        await waitFor(() => requests().some((r) => textOf(r).includes(`tk${n}`)), 120_000, `wk took task tk${n}`);
        await atRest('wk');
        await sleep(12_000);

        // 1. Nothing reached lead's model, the draft is on screen, the panel says a message waits.
        const meanwhile = requests().slice(before).filter((r) => !textOf(r).includes(`tk${n}`));
        const screen = await leadScreen();
        entry.whileInField = {
          requests: meanwhile.map(textOf),
          draftOnScreen: screen.includes(draft.onScreen),
          notice: (await notice.count()) > 0 ? await notice.first().innerText() : null,
        };
        await stepShot(page, `${shell}-${n}-waiting`);
        expect(meanwhile.map(textOf), `${draft.name}: nothing reaches lead's model while the draft is in its field`).toEqual([]);
        expect(screen, `${draft.name}: the draft is still in lead's field`).toContain(draft.onScreen);
        await expect(notice.first(), `${draft.name}: the panel says a message is waiting`).toBeVisible({ timeout: 10_000 });

        // 2. The person sends: the draft, whole, and nothing of Tars's.
        await page.keyboard.press('Enter');
        const at = await waitFor(() => {
          const i = requests().findIndex((r, k) => k >= before && draft.carried.every((piece) => textOf(r).includes(piece)));
          return i >= 0 ? i + 1 : 0;
        }, 60_000, `${draft.name} submitted`) - 1;
        const own = requests()[at];
        entry.submitted = textOf(own);
        expect(textOf(own), `${draft.name}: the submission carries nothing of Tars's`).not.toContain(NOTICE);
        expect(textOf(own)).not.toContain(`SENDMSG${n}`);

        // 3. Then the notice and the message, each after the draft.
        await waitFor(() => requests().slice(at + 1).some((r) => textOf(r).includes(`SENDMSG${n}`)), 120_000, `SENDMSG${n} delivered after the draft`);
        await waitFor(() => requests().slice(at + 1).some((r) => textOf(r).includes(NOTICE) && textOf(r).includes('Wren')), 120_000, `the notice of tk${n} delivered after the draft`);
        entry.deliveredAfter = requests().slice(at + 1).map(textOf);
        entry.chunks = (await chunks()).slice(seenChunks).filter((c) => c.id === 'lead').map((c) => JSON.stringify(c.input));
        fact(`draft ${n} done`, entry);
        await expect(notice).toHaveCount(0, { timeout: 30_000 });
      }
      recordValues({ [shell]: values });
    } finally {
      recordValues({ [`${shell}-partial`]: values });
      if (app) {
        await app.context().tracing.stop({ path: path.join(OUT, 'app-trace.zip') }).catch(() => undefined);
        await app.close().catch(() => undefined);
      }
      stub.kill();
    }
  });
}
