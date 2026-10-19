import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The CLI matrix of e2e/cli-matrix.spec.ts with the real CLIs installed on this machine, on their cheapest models.
 * Opt-in, never in the default suite: it spends real tokens. TARS_CLI_MATRIX_LIVE=1 runs it; TARS_CLI_MATRIX_AMP=1
 * adds amp, which must be logged in.
 *
 * claude on claude-haiku-5-5 at low effort, codex on gpt-6-luna at low effort, Qwen Code on deepseek-v4-flash, amp
 * on its default. Logins: claude needs TARS_CLI_MATRIX_CLAUDE_TOKEN (a `claude setup-token` token, handed to the app as
 * CLAUDE_CODE_OAUTH_TOKEN): from a sandbox HOME it does not reach the keychain's sign-in, "Not logged in" (seen on
 * 2026-10-18, claude 2.1.302). codex's
 * auth.json and qwen's settings.json copied into the sandbox HOME for the run and removed with it; nothing of them is
 * printed or kept in the artefact. A ChatGPT login rotates its refresh token when codex refreshes it: an auth.json
 * the run refreshed (same account, still readable) is put back in ~/.codex, or the real codex would be signed out.
 *
 * One short delegation per ordered pair (A, B), in plain words, as a person would ask: A is told to give B, with
 * delegate_task, the task "send A the word R<pair> with send_message, then answer with the word D<pair>". Read from
 * the terminals Tars keeps (tokens only) and the window's status:
 *   delegate.reaches  B's terminal shows the task under A's sender line;
 *   delegate.answer   A's terminal shows D<pair>, the answer delegate_task returned;
 *   turn              Tars showed B running, then at rest;
 *   reply             A's terminal shows R<pair> under B's sender line: B's own identity.
 * Nothing is asserted cell by cell (a model may answer otherwise); the run fails only when a pair could not be tried.
 * The artefact: matrix.json, matrix.md, the screenshots, reproduce.txt.
 */

const live = process.env.TARS_CLI_MATRIX_LIVE === '1';
const which = (bin: string): string => { try { return fs.realpathSync(execFileSync('/usr/bin/which', [bin], { encoding: 'utf8' }).trim()); } catch { return ''; } };

type Agent = { id: string; name: string; provider: string; bin: string; model?: string; effort?: string };
const CANDIDATES: Agent[] = [
  { id: 'l-claude', name: 'Claude Live', provider: 'claude', bin: 'claude', model: 'claude-haiku-5-5', effort: 'low' },
  { id: 'l-codex', name: 'Codex Live', provider: 'codex', bin: 'codex', model: 'gpt-6-luna', effort: 'low' },
  { id: 'l-qwen', name: 'Qwen Live', provider: 'qwen-code', bin: 'qwen', model: 'deepseek-v4-flash' },
  ...(process.env.TARS_CLI_MATRIX_AMP === '1' ? [{ id: 'l-amp', name: 'Amp Live', provider: 'amp', bin: 'amp' }] : []),
];
type Cell = { from: string; to: string; step: string; result: 'green' | 'red'; detail: string };
type Api = { electronAPI: { agent: {
  start(p: { id: string; prompt: string }): Promise<unknown>;
  get(id: string): Promise<{ status: string; cliRunning?: boolean; output?: string[] } | null>;
  sendInput(p: { id: string; input: string }): Promise<unknown>;
} } };
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\s+/g, ' ');

for (const newInterface of [false, true]) {
  test(`live: every installed cli delegates to every other on its cheapest model${newInterface ? ' (new interface)' : ''}`, async () => {
    test.skip(!live, 'live: TARS_CLI_MATRIX_LIVE=1 (real CLIs and their models, real tokens)');
    test.setTimeout(60 * 60_000);
    const agents = CANDIDATES.map((a) => ({ ...a, path: which(a.bin) })).filter((a) => a.path);
    test.skip(agents.length < 2, 'live: fewer than two of claude, codex, qwen installed');

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-cli-matrix-live-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.dorothy');
    for (const d of [project, dir, path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, '.qwen')]) fs.mkdirSync(d, { recursive: true });
    const real = os.homedir();
    const trusted = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [project]: trusted, [fs.realpathSync(project)]: trusted } }, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark', skipDangerousModePermissionPrompt: true }, null, 2));
    for (const [from, to] of [[path.join(real, '.codex', 'auth.json'), path.join(home, '.codex', 'auth.json')], [path.join(real, '.qwen', 'settings.json'), path.join(home, '.qwen', 'settings.json')]]) {
      if (fs.existsSync(from)) fs.copyFileSync(from, to);
    }
    const codexAuth = { real: path.join(real, '.codex', 'auth.json'), copy: path.join(home, '.codex', 'auth.json') };
    const authText = (f: string) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
    const accountOf = (text: string) => { try { const j = JSON.parse(text); return j?.tokens?.account_id ?? null; } catch { return undefined; } };
    const authAtStart = authText(codexAuth.copy);
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents.map((a) => ({
      id: a.id, name: a.name, character: 'robot', provider: a.provider, status: 'idle', role: 'orchestrator', projectPath: project, skills: [],
      permissionMode: 'bypass', cliPath: a.path, ...(a.model ? { model: a.model } : {}), ...(a.effort ? { effort: a.effort } : {}),
      createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z',
    })), null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface,
      cliPaths: Object.fromEntries([...agents.map((a) => [a.bin === 'qwen' ? 'qwen' : a.bin, a.path]), ['additionalPaths', [...new Set(agents.map((a) => path.dirname(a.path)))]]]),
      codexEnabled: true, qwenEnabled: true, ampEnabled: true,
    }));
    const port = apiPort(newInterface ? 31426 : 31425);
    const values: Record<string, unknown> = { newInterface, agents: agents.map((a) => ({ id: a.id, provider: a.provider, model: a.model ?? null, effort: a.effort ?? null })) };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const cells: Cell[] = [];
    const cell = (from: string, to: string, step: string, green: boolean, detail: string) => cells.push({ from, to, step, result: green ? 'green' : 'red', detail: detail.slice(0, 300) });

    const app: ElectronApplication = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', ...(process.env.TARS_CLI_MATRIX_CLAUDE_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN: process.env.TARS_CLI_MATRIX_CLAUDE_TOKEN } : {}) } });
    try {
      const page: Page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      const get = (id: string) => page.evaluate((i) => (window as unknown as Api).electronAPI.agent.get(i), id);
      const screen = async (id: string) => plain(((await get(id))?.output ?? []).join(''));
      const type = (id: string, input: string) => page.evaluate((p) => (window as unknown as Api).electronAPI.agent.sendInput(p), { id, input });

      // Tars's MCP servers registered as a packaged Tars does (see cli-matrix.spec.ts).
      const resources = path.join(home, 'resources');
      fs.mkdirSync(path.join(resources, 'mcp-orchestrator', 'dist'), { recursive: true });
      fs.copyFileSync(path.resolve('mcp-orchestrator', 'dist', 'bundle.js'), path.join(resources, 'mcp-orchestrator', 'dist', 'bundle.js'));
      fs.copyFileSync(path.resolve('mcp-orchestrator', 'package.json'), path.join(resources, 'mcp-orchestrator', 'package.json'));
      const dist = path.resolve('electron', 'dist');
      await app.evaluate(async (_e, { resources, dist }) => {
        const was = process.resourcesPath;
        Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true, writable: true });
        try { await process.mainModule!.require(`${dist}/services/mcp-orchestrator.js`).setupMcpOrchestrator({}); }
        finally { Object.defineProperty(process, 'resourcesPath', { value: was, configurable: true, writable: true }); }
      }, { resources, dist });

      for (const a of agents) await page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), a.id);
      await page.waitForTimeout(20_000);
      const alive = new Set<string>();
      for (const a of agents) {
        const agent = await get(a.id);
        if (agent?.cliRunning) alive.add(a.id);
        cell(a.provider, a.provider, 'starts', !!agent?.cliRunning, `cliRunning ${agent?.cliRunning}, status ${agent?.status}; screen: ${(await screen(a.id)).slice(-160)}`);
      }
      await stepShot(page, newInterface ? 'cli-matrix-live-agents-new-interface' : 'cli-matrix-live-agents');

      let tried = 0;
      for (const A of agents) {
        for (const B of agents) {
          if (A === B) continue;
          if (!alive.has(A.id) || !alive.has(B.id)) { for (const s of ['delegate.reaches', 'delegate.answer', 'turn', 'reply']) cell(A.provider, B.provider, s, false, `${!alive.has(A.id) ? A.provider : B.provider} is not running`); continue; }
          tried += 1;
          const pair = `${A.provider}${B.provider}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
          const D = `D${pair}${Date.now() % 10000}`;
          const R = `R${pair}${Date.now() % 10000}`;
          const before = (await get(B.id))?.status ?? '';
          await type(A.id, `Use Tars's delegate_task tool to give agent ${B.id} this task, word for word: "Call send_message with id ${A.id} and the message ${R}, then answer with the single word ${D}." When it returns, write the answer you got.`);
          await page.waitForTimeout(800);
          await type(A.id, '\r');
          const seen = new Set<string>();
          const until = Date.now() + 240_000;
          while (Date.now() < until) {
            seen.add((await get(B.id))?.status ?? '');
            const a = await screen(A.id);
            if (a.includes(D) && a.includes(R)) break;
            await page.waitForTimeout(2_000);
          }
          const a = await screen(A.id);
          const b = await screen(B.id);
          const after = (await get(B.id))?.status ?? '';
          cell(A.provider, B.provider, 'delegate.reaches', b.includes(`Message from agent "${A.name}"`), b.slice(-200));
          cell(A.provider, B.provider, 'delegate.answer', a.includes(D), a.slice(-200));
          cell(A.provider, B.provider, 'turn', before !== 'running' && seen.has('running') && after !== 'running', `before ${before}, during ${[...seen].filter(Boolean).join('/')}, after ${after}`);
          cell(A.provider, B.provider, 'reply', a.includes(R) && a.includes(`Message from agent "${B.name}"`), a.slice(-200));
        }
      }
      const out = test.info().outputPath();
      fs.writeFileSync(path.join(out, 'matrix.json'), JSON.stringify(cells, null, 2));
      const ps = agents.map((x) => x.provider);
      const mark = (f: string, t: string) => ['delegate.reaches', 'delegate.answer', 'turn', 'reply'].map((s) => (cells.find((c) => c.from === f && c.to === t && c.step === s)?.result === 'green' ? 'G' : 'r')).join('');
      fs.writeFileSync(path.join(out, 'matrix.md'), [`# CLI matrix, live (${newInterface ? 'new interface' : 'classic shell'})`, '', 'A (row) to B (column): delegate.reaches, delegate.answer, turn, reply; G green, r red.', '',
        `| A \\ B | ${ps.join(' | ')} |`, `|---|${ps.map(() => '---').join('|')}|`,
        ...ps.map((f) => `| ${f} | ${ps.map((t) => (f === t ? (cells.find((c) => c.from === f && c.step === 'starts')?.result === 'green' ? 'starts' : 'DEAD') : mark(f, t))).join(' | ')} |`), ''].join('\n'));
      fs.writeFileSync(path.join(out, 'reproduce.txt'), 'TARS_CLI_MATRIX_LIVE=1 npx playwright test e2e/cli-matrix.live.spec.ts\n');
      keep({ cells, tried });
      expect(cells.filter((c) => c.step !== 'starts').length, 'every pair has its cells').toBe(agents.length * (agents.length - 1) * 4);
    } finally {
      await app.close().catch(() => undefined);
      // codex refreshed its login in the copy: the same account's newer tokens go back, atomically, and only over the
      // real file as it was copied. Changed meanwhile (the user's own codex refreshed it, or a new sign-in), the real
      // file is newer than anything here, and stays as it is (the Audit's L1 on #464).
      const after = authText(codexAuth.copy);
      if (authAtStart && after && after !== authAtStart && accountOf(after) !== undefined && accountOf(after) === accountOf(authAtStart)) {
        if (authText(codexAuth.real) !== authAtStart) {
          console.log('[cli-matrix live] ~/.codex/auth.json changed during the run: the refresh made in the sandbox is not written back');
        } else {
          const tmp = `${codexAuth.real}.tars-e2e-${process.pid}`;
          fs.writeFileSync(tmp, after, { mode: 0o600 });
          fs.renameSync(tmp, codexAuth.real);
        }
      }
      await removeHome(home);
    }
  });
}
