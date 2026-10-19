import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { writeFakeClis } from './fake-clis.mjs';

/**
 * Every CLI talks to every other (2.0.4, the maintainer's request of 2026-10-18: "every CLI can talk to every other
 * without trouble").
 *
 * The real app on a sandbox HOME, nine agents in one project, one per CLI Tars drives: claude, codex, Qwen Code,
 * gemini, opencode, pi, amp, grok, and OpenRouter (a key provider on the claude binary). Their CLIs are the
 * stand-ins of e2e/fake-clis.mjs and e2e/fake-codex.mjs, each faithful to its real CLI where Tars depends on it:
 * where it keeps and reads its MCP servers, what its MCP servers get of its environment, how it takes a first prompt
 * and a typed task, how its turns show (hooks, session files), how it asks (an approval, Claude Code's own
 * questions). Tars registers its MCP server in each CLI's configuration as a packaged Tars does at its start.
 * A project has one orchestrator (core/agent-role.ts) and a worker hands no work to another agent (#449): before its
 * pairs, A is made the project's orchestrator the way the toggle's save does it (assignRole), in the main process and
 * without the restart the toggle asks for: a stand-in reads no instructions, and a restart is not what this measures.
 * B is then one of its workers.
 *
 * For every ordered pair (A, B), A being told in its terminal what to do, as a model decides it:
 *   delegate.reaches  A's delegate_task puts the task into B's permanent terminal, under A's sender line;
 *   delegate.answer   delegate_task returns B's answer to A;
 *   turn              Tars shows B's turn: at rest before, running while B works, at rest after;
 *   message           A's send_message reaches B's terminal under A's sender line;
 *   reply             B's send_message back reaches A under B's sender line: B's own identity, no shared token.
 * Once with the classic shell and once with the new interface.
 *
 * A cell is green or red, with what was seen. KNOWN_RED says which cells are red on main today and why; the spec
 * fails when a cell outside it is red (a regression) and when a cell in it turns green or goes red for another
 * reason (the table is then out of date: the PR that fixed it removes its rule). On main (371d3c70), in short:
 *   - codex does not start in bypass mode (--full-auto, fix/codex-works), and Qwen Code has no provider
 *     (feat/qwen-code);
 *   - gemini, opencode and pi cannot call Tars: gemini's MCP servers get no TOKEN variable, and Tars writes its server
 *     where opencode and pi do not read theirs (documented by them, not measured on a real install);
 *   - gemini's first task is never closed, and holds every later one;
 *   - Tars reads no answer and no turn from a CLI without hooks (opencode, pi, amp, grok) nor from gemini;
 *   - grok's delegation to claude runs and is reported as never started (H1, until fix/second-delegation-into-claude).
 * OpenRouter starts since #458, which made its rules go; its own tasks to gemini now wait behind gemini's first.
 * KNOWN_RED has the rules, each with what its cells must say. A project of its own since 19/10 (playwright.config.ts):
 * `npm run e2e:matrix`, run at every release gate and by `npm run e2e:auto` (OPERATIONS.md).
 * The artefact, in the run directory: matrix.json (pair, step, result, detail), matrix.md, the fakes' logs,
 * values.json, screenshots of the Agents page, reproduce.txt (the command).
 */

type Agent = { id: string; name: string; provider: string; fake: string };
const AGENTS: Agent[] = [
  { id: 'x-claude', name: 'Claude Agent', provider: 'claude', fake: 'claude' },
  { id: 'x-codex', name: 'Codex Agent', provider: 'codex', fake: 'codex' },
  { id: 'x-qwen', name: 'Qwen Agent', provider: 'qwen-code', fake: 'qwen-code' },
  { id: 'x-gemini', name: 'Gemini Agent', provider: 'gemini', fake: 'gemini' },
  { id: 'x-opencode', name: 'OpenCode Agent', provider: 'opencode', fake: 'opencode' },
  { id: 'x-pi', name: 'Pi Agent', provider: 'pi', fake: 'pi' },
  { id: 'x-amp', name: 'Amp Agent', provider: 'amp', fake: 'amp' },
  { id: 'x-grok', name: 'Grok Agent', provider: 'grok', fake: 'grok' },
  { id: 'x-openrouter', name: 'OpenRouter Agent', provider: 'openrouter', fake: 'claude' },
];
// To reproduce a few cells only: E2E_MATRIX_ONLY=claude,codex (providers), E2E_MATRIX_SHELL=classic or new.
const ONLY = process.env.E2E_MATRIX_ONLY ? new Set(process.env.E2E_MATRIX_ONLY.split(',')) : null;
const RUN = ONLY ? AGENTS.filter((a) => ONLY.has(a.provider)) : AGENTS;
const STEPS = ['delegate.reaches', 'delegate.answer', 'turn', 'message', 'reply'] as const;
type Step = (typeof STEPS)[number];
type Cell = { from: string; to: string; step: Step | 'starts'; result: 'green' | 'red'; detail: string };

/** The cells red on main d96be134, by rule: which pairs and steps, why, and what their detail must say. */
type Rule = { from?: string[]; to?: string[]; steps: Array<Step | 'starts'>; why: string; seen: RegExp };
const ALL: Step[] = ['delegate.reaches', 'delegate.answer', 'turn', 'message', 'reply'];
// First match wins: the CLIs that do not start, then what A cannot do, then what B cannot do.
const KNOWN_RED: Rule[] = [
  { from: ['codex'], to: ['codex'], steps: ['starts'], why: 'codex 0.163 refuses --full-auto, which Tars passes it in bypass mode (fix/codex-works)', seen: /refused "--full-auto"/ },
  { from: ['qwen-code'], to: ['qwen-code'], steps: ['starts'], why: 'no Qwen Code provider on main (feat/qwen-code): its agent runs as claude, with flags qwen 0.25.2 refuses', seen: /refused .*dangerously-skip-permissions/ },
  { from: ['codex'], steps: ALL, why: 'codex does not start (above)', seen: /codex's CLI is not running/ },
  { from: ['qwen-code'], steps: ALL, why: 'Qwen Code does not start (above)', seen: /qwen-code's CLI is not running/ },
  { to: ['codex'], steps: ALL, why: 'codex does not start (above)', seen: /codex's CLI is not running/ },
  { to: ['qwen-code'], steps: ALL, why: 'Qwen Code does not start (above)', seen: /qwen-code's CLI is not running/ },
  { from: ['gemini'], steps: ALL, why: 'gemini hands its MCP servers no variable named like TOKEN (documented by gemini, not measured on a real install): Tars\'s server presents the shared token, which drives no agent', seen: /identity of your own|B never got the message|no task reached B/ },
  { from: ['opencode', 'pi'], steps: ALL, why: 'Tars writes its MCP server into ~/.opencode/config.json and ~/.pi/config.json, where opencode (~/.config/opencode/opencode.json, `mcp`) and pi (~/.pi/agent/mcp.json) do not read (documented by them, not measured on a real install: neither is installed here)', seen: /no Tars server|B never got the message|no task reached B/ },
  { to: ['gemini'], from: ['amp', 'grok', 'openrouter'], steps: ['delegate.reaches', 'delegate.answer', 'turn'], why: 'gemini\'s first task is never closed: Tars waits for its turn to end (its queue counts its hooks) while run-task treats it as a CLI without hooks, so every later task waits behind it', seen: /no answer|nothing typed|still|queued|never called|never got|no task reached B/ },
  { to: ['gemini'], steps: ['delegate.answer'], why: 'run-task treats gemini as a CLI without hooks: no answer read from it', seen: /gives Tars no hook/ },
  { to: ['gemini'], steps: ['turn'], why: 'its BeforeAgent and AfterAgent reach /api/hooks/status, but the window never shows the turn', seen: /before/ },
  { to: ['gemini'], steps: ['reply'], why: 'gemini has no identity (above; documented, not measured)', seen: /identity of your own/ },
  { to: ['opencode', 'pi', 'amp', 'grok'], steps: ['delegate.answer'], why: 'a CLI without hooks: Tars reads no answer from it', seen: /gives Tars no hook/ },
  { to: ['opencode', 'pi', 'amp', 'grok'], steps: ['turn'], why: 'a CLI without hooks: running once the task goes in, never at rest again', seen: /after running/ },
  { to: ['opencode', 'pi'], steps: ['reply'], why: 'no Tars tools where opencode and pi read their MCP servers (above; documented, not measured)', seen: /no Tars server/ },
  { from: ['grok'], to: ['claude'], steps: ['delegate.answer'], why: 'the task ran in claude\'s terminal, typed without its task line, and delegate_task told grok it never started (the Audit\'s H1 symptom on #453): until fix/second-delegation-into-claude. A race: amp\'s delegation to claude went the same way once, at a load of 150', seen: /never started/ },
];

const expectedRed = (cell: Cell): Rule | undefined => KNOWN_RED.find((r) =>
  r.steps.includes(cell.step) && (!r.from || r.from.includes(cell.from)) && (!r.to || r.to.includes(cell.to)));

type Rec = Record<string, unknown> & { kind?: string; agent?: string | null; text?: string; typed?: string; tool?: string; mcp?: boolean; isError?: boolean; launch?: boolean; refused?: unknown; turn?: boolean };
type Api = { electronAPI: {
  agent: {
    start(p: { id: string; prompt: string }): Promise<unknown>;
    get(id: string): Promise<{ id: string; status: string; cliRunning?: boolean; role?: string } | null>;
    update(p: { id: string; role: string }): Promise<{ success?: boolean; error?: string }>;
    sendInput(p: { id: string; input: string }): Promise<unknown>;
  };
} };

for (const newInterface of [false, true]) {
  if (process.env.E2E_MATRIX_SHELL && process.env.E2E_MATRIX_SHELL !== (newInterface ? 'new' : 'classic')) continue;
  test(`every cli delegates to, messages and hears back from every other${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(40 * 60_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-cli-matrix-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.dorothy');
    for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
    // delegate_task waits 25 s at most in a stand-in: a pair whose task Tars holds does not hold the next pairs.
    const fakes = writeFakeClis(home, undefined, { delegateTimeoutS: 25 }) as Record<string, string>;
    const bin = path.join(home, 'bin');
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(RUN.map((a) => ({
      id: a.id, name: a.name, character: 'robot', provider: a.provider, status: 'idle', role: a === RUN[0] ? 'orchestrator' : 'worker', projectPath: project, skills: [],
      permissionMode: 'bypass', cliPath: fakes[a.fake], createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z',
    })), null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface,
      cliPaths: { claude: fakes.claude, codex: fakes.codex, gemini: fakes.gemini, opencode: fakes.opencode, pi: fakes.pi, amp: fakes.amp, grok: fakes.grok, qwencode: fakes['qwen-code'], additionalPaths: [bin] },
      codexEnabled: true, geminiEnabled: true, opencodeEnabled: true, piEnabled: true, ampEnabled: true, grokEnabled: true, qwenEnabled: true, openRouterEnabled: true,
      openRouterApiKey: 'sk-or-e2e-matrix-0000',
    }));
    const port = apiPort(newInterface ? 31424 : 31423);
    const values: Record<string, unknown> = { newInterface, home };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const lines = (file: string): Rec[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as Rec; } catch { return {}; } }) : []);
    /** Every record of one agent's CLI: its own lines in fake-cli.jsonl, or codex's file. */
    const recs = (a: Agent): Rec[] => (a.fake === 'codex' ? lines(path.join(home, 'fake-codex.jsonl')) : lines(path.join(home, 'fake-cli.jsonl')).filter((r) => r.agent === a.id));
    const typedInto = (a: Agent, since: number) => recs(a).slice(since).map((r) => String(r.typed ?? (a.fake === 'codex' && r.turn ? r.text : '') ?? '')).filter(Boolean);
    const toolResult = (a: Agent, tool: string, since: number, to?: string) => recs(a).slice(since).find((r) => r.mcp && r.tool === tool && typeof r.text === 'string' && (!to || r.to === to));
    // codex's stand-in logs no call before it is made: a call it made shows only with its result.
    const called = (a: Agent, tool: string, since: number, to: string) => recs(a).slice(since).some((r) => r.mcp && r.tool === tool && r.to === to);

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', FAKE_DELEGATE_TIMEOUT_S: '25' },
    });
    // The app's own log, written as it comes: an app that ends in the middle leaves what it said, and how it ended.
    const appLog = test.info().outputPath('app.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().on('exit', (code, signal) => fs.appendFileSync(appLog, `\n[e2e] the app's process ended: code ${code}, signal ${signal}\n`));
    const cells: Cell[] = [];
    const cell = (from: string, to: string, step: Cell['step'], green: boolean, detail: string) => cells.push({ from, to, step, result: green ? 'green' : 'red', detail: detail.replace(/\s+/g, ' ').slice(0, 300) });
    try {
      const page: Page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
      const get = (id: string) => page.evaluate((i) => (window as unknown as Api).electronAPI.agent.get(i), id);
      const type = (id: string, input: string) => page.evaluate((p) => (window as unknown as Api).electronAPI.agent.sendInput(p), { id, input });

      // Tars's MCP servers registered in every CLI's configuration, as a packaged Tars does at every start
      // (setupMcpOrchestrator). A development run finds no bundle under process.resourcesPath, the app's own.
      const resources = path.join(home, 'resources');
      fs.mkdirSync(path.join(resources, 'mcp-orchestrator', 'dist'), { recursive: true });
      fs.copyFileSync(path.resolve('mcp-orchestrator', 'dist', 'bundle.js'), path.join(resources, 'mcp-orchestrator', 'dist', 'bundle.js'));
      fs.copyFileSync(path.resolve('mcp-orchestrator', 'package.json'), path.join(resources, 'mcp-orchestrator', 'package.json'));
      const dist = path.resolve('electron', 'dist');
      await app.evaluate(async (_e, { resources, dist }) => {
        const was = process.resourcesPath;
        Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true, writable: true });
        try {
          await process.mainModule!.require(`${dist}/services/mcp-orchestrator.js`).setupMcpOrchestrator({});
        } finally {
          Object.defineProperty(process, 'resourcesPath', { value: was, configurable: true, writable: true });
        }
      }, { resources, dist });

      // Every agent's permanent session, started from the window.
      for (const a of RUN) await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), a.id);
      await expect.poll(() => RUN.filter((a) => recs(a).some((r) => r.launch)).length, { timeout: 60_000, message: 'every CLI launched' }).toBe(RUN.length);
      await page.waitForTimeout(3_000);
      const alive = new Set<string>();
      for (const a of RUN) {
        const launch = recs(a).find((r) => r.launch);
        const agent = await get(a.id);
        const ok = !!launch && !launch.refused && !!agent?.cliRunning;
        if (ok) alive.add(a.id);
        cell(a.provider, a.provider, 'starts', ok, launch?.refused ? `its CLI refused ${JSON.stringify(launch.refused)}` : `cliRunning ${agent?.cliRunning}, status ${agent?.status}`);
      }
      keep({ launches: RUN.map((a) => ({ id: a.id, launch: recs(a).find((r) => r.launch) ?? null })) });
      await stepShot(page, newInterface ? 'cli-matrix-agents-new-interface' : 'cli-matrix-agents');

      // The pairs, one after the other.
      const roles: Array<{ agent: string; update: unknown; role: string | undefined; restarted: boolean }> = [];
      for (const A of RUN) {
        if (alive.has(A.id) && (await get(A.id))?.role !== 'orchestrator') {
          // A becomes the project's orchestrator, as the toggle makes it: A and the former orchestrator restart.
          const launches = recs(A).filter((r) => r.launch).length;
          const update = await app.evaluate((_e, { id, dist }) => {
            const req = process.mainModule!.require;
            const manager = req(`${dist}/core/agent-manager.js`);
            const demoted = req(`${dist}/core/agent-role.js`).assignRole(manager.agents.get(id), 'orchestrator', manager.agents.values());
            manager.saveAgents();
            return { demoted: demoted.map((a: { id: string }) => a.id) };
          }, { id: A.id, dist });
          await page.waitForTimeout(500);
          roles.push({ agent: A.id, update, role: (await get(A.id))?.role, restarted: recs(A).filter((r) => r.launch).length > launches });
        }
        for (const B of RUN) {
          if (A === B) continue;
          if (!alive.has(A.id) || !alive.has(B.id)) {
            const dead = !alive.has(A.id) ? A : B;
            for (const step of STEPS) cell(A.provider, B.provider, step, false, `${dead.provider}'s CLI is not running`);
            continue;
          }
          const tag = `${A.provider}-${B.provider}`.toUpperCase().replace(/[^A-Z0-9]+/g, '');
          // delegate_task, and B's turn as the window reads it.
          let sinceA = recs(A).length;
          let sinceB = recs(B).length;
          const before = (await get(B.id))?.status ?? '';
          await type(A.id, `DELEGATE ${B.id} ECHO ANSWER${tag}\r`);
          const seen = new Set<string>();
          let result: Rec | undefined;
          const until = Date.now() + 45_000;
          // A turn of A's that ended without the call (not logged in, the line lost to a question) ends the wait.
          let quiet = 0;
          while (Date.now() < until && !(result = toolResult(A, 'delegate_task', sinceA, B.id))) {
            seen.add((await get(B.id))?.status ?? '');
            if (!called(A, 'delegate_task', sinceA, B.id) && recs(A).slice(sinceA).some((r) => r.answer !== undefined || r.answered || r.lost) && (quiet += 1) > 20) break;
            await page.waitForTimeout(100);
          }
          await page.waitForTimeout(1_500);
          const after = (await get(B.id))?.status ?? '';
          const sender = `Message from agent "${A.name}" ("${A.id}")`;
          const reached = typedInto(B, sinceB).find((t) => t.includes(`ANSWER${tag}`));
          cell(A.provider, B.provider, 'delegate.reaches', !!reached && reached.includes(sender), reached ? reached.slice(0, 200) : result ? `A's call: ${String(result.text).split('\n')[0]}` : called(A, 'delegate_task', sinceA, B.id) ? 'A called delegate_task: no answer and nothing typed within 45 s' : 'A never called delegate_task');
          const text = String(result?.text ?? '');
          cell(A.provider, B.provider, 'delegate.answer', !!result && !result.isError && text.includes(`echo ANSWER${tag}`), result ? text.split('\n').slice(0, 2).join(' ') : called(A, 'delegate_task', sinceA, B.id) ? 'A called delegate_task: no answer within 45 s' : 'A never called delegate_task');
          cell(A.provider, B.provider, 'turn', !!reached && before !== 'running' && seen.has('running') && after !== 'running', `${reached ? '' : 'no task reached B; '}before ${before}, during ${[...seen].filter(Boolean).join('/')}, after ${after}`);

          // send_message A to B, and B's send_message back to A.
          sinceA = recs(A).length;
          sinceB = recs(B).length;
          await type(A.id, `SEND ${B.id} SEND ${A.id} REPLY${tag}\r`);
          await expect.poll(() => !!toolResult(A, 'send_message', sinceA, B.id), { timeout: 20_000 }).toBe(true).catch(() => undefined);
          const sent = toolResult(A, 'send_message', sinceA, B.id);
          await expect.poll(() => typedInto(B, sinceB).some((t) => t.includes(`REPLY${tag}`)), { timeout: sent && !sent.isError ? 20_000 : 2_000 }).toBe(true).catch(() => undefined);
          const got = typedInto(B, sinceB).find((t) => t.includes(`REPLY${tag}`));
          cell(A.provider, B.provider, 'message', !!got && got.includes(sender), got ? got.slice(0, 200) : sent ? `A's call: ${String(sent.text).split('\n')[0]}` : 'A never called send_message');
          const back = `Message from agent "${B.name}" ("${B.id}")`;
          await expect.poll(() => typedInto(A, sinceA).some((t) => t.includes(`REPLY${tag}`) && t.includes(back)), { timeout: got ? 20_000 : 1_000 }).toBe(true).catch(() => undefined);
          const reply = typedInto(A, sinceA).find((t) => t.includes(`REPLY${tag}`) && t.includes(back));
          const bSent = toolResult(B, 'send_message', sinceB, A.id);
          cell(A.provider, B.provider, 'reply', !!reply, reply ? reply.slice(0, 200) : bSent ? `B's call: ${String(bSent.text).split('\n')[0]}` : got ? 'B never called send_message' : 'B never got the message');
          await page.waitForTimeout(500);
        }
      }

      keep({ roles });
      // The run directory: the matrix, its table, the fakes' logs, the command.
      const out = test.info().outputPath();
      fs.writeFileSync(path.join(out, 'matrix.json'), JSON.stringify(cells, null, 2));
      const providers = RUN.map((a) => a.provider);
      const mark = (from: string, to: string) => STEPS.map((s) => (cells.find((c) => c.from === from && c.to === to && c.step === s)?.result === 'green' ? 'G' : 'r')).join('');
      fs.writeFileSync(path.join(out, 'matrix.md'), [
        `# CLI matrix (${newInterface ? 'new interface' : 'classic shell'})`, '',
        `Each cell, A (row) to B (column): ${STEPS.join(', ')}; G green, r red.`, '',
        `| A \\ B | ${providers.join(' | ')} |`, `|---|${providers.map(() => '---').join('|')}|`,
        ...providers.map((f) => `| ${f} | ${providers.map((t) => (f === t ? (cells.find((c) => c.from === f && c.step === 'starts')?.result === 'green' ? 'starts' : 'DEAD') : mark(f, t))).join(' | ')} |`),
        '',
      ].join('\n'));
      for (const f of ['fake-cli.jsonl', 'fake-codex.jsonl']) if (fs.existsSync(path.join(home, f))) fs.copyFileSync(path.join(home, f), path.join(out, f));
      fs.writeFileSync(path.join(out, 'reproduce.txt'), `npx tsc -p electron/tsconfig.json && (cd mcp-orchestrator && npm run build) && E2E_TRACE=on npx playwright test e2e/cli-matrix.spec.ts\n`);
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1_500);
      await stepShot(page, newInterface ? 'cli-matrix-agents-after-new-interface' : 'cli-matrix-agents-after');

      // Against the table of what is red on main, and why.
      const unexpected = cells.filter((c) => c.result === 'red' && !expectedRed(c));
      const nowGreen = cells.filter((c) => c.result === 'green' && expectedRed(c));
      const otherReason = cells.filter((c) => { const r = c.result === 'red' ? expectedRed(c) : undefined; return !!r && !r.seen.test(c.detail); });
      keep({ cells: cells.length, red: cells.filter((c) => c.result === 'red').length, unexpected, nowGreen, otherReason });
      expect.soft(unexpected, 'cells red that the table does not expect').toEqual([]);
      expect.soft(nowGreen, 'cells green that the table still expects red: remove their rule').toEqual([]);
      expect.soft(otherReason, 'cells red for another reason than their rule').toEqual([]);
    } finally {
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
