import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, listenForErrors, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Grants across projects and an agent retuned by another, in the window (#604, on #595's engine), driven by the owner
 * in the real app: Settings, AI & Providers, Across projects; and Agents, where a retune made by another agent is told.
 * Two projects: project-a (an orchestrator and two workers), project-b (an orchestrator and a worker on claude, effort
 * low). Worker One of project-a works through the real mcp-orchestrator with its own token.
 *
 * How it can fail, written before it ran (QA, 19/11):
 * 1. Settings has no Across projects, or it does not say there is no grant in a Tars that never gave one.
 * 2. A grant given in the window (from, to, the worker it names) is not saved as given, or its row does not say from,
 *    to, the worker and that the owner gave it.
 * 3. Removing it is not asked once, or it is not removed at once, row and record.
 * 4. Worker One retunes project-b's worker (its effort, through update_agent): no notice across the top of the page,
 *    or it does not say who, which agent, of which project, what and its state (the agent's card on the page as it
 *    is: recorded, not asserted).
 * 5. Undo, from the notice: the earlier effort is not back on the record, or the notice does not say it is undone.
 * 6. The agent's card, after a reload, shows no last retune.
 * 7. An uncaught error in the page.
 * In the classic shell and in the new interface's.
 * Red on #595's head (65ed59bff), which has no window: 1 finds no Across projects in Settings.
 * The artefact: values.json (the grants and the agents' records at each step, the tool's answer), step screenshots.
 */

const A_LEAD = 'aaaa1111-0000-4000-8000-0000000000a0';
const A_ONE = 'aaaa1111-0000-4000-8000-0000000000a1';
const A_TWO = 'aaaa1111-0000-4000-8000-0000000000a2';
const B_LEAD = 'bbbb2222-0000-4000-8000-0000000000b0';
const B_CODER = 'bbbb2222-0000-4000-8000-0000000000b1';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Reply = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
type Grant = { from: string; to: string; workers: string[]; grantedAt: string };
type Listed = { id: string; name: string; effort?: string | null; lastRetune?: { state: string; by?: unknown } };

for (const newInterface of [false, true]) {
  test(`grants across projects given and removed in the window, and an agent retuned by another told and undone${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(4 * 60_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-grants-window-'));
    const a = path.join(home, 'projects', 'project-a');
    const b = path.join(home, 'projects', 'project-b');
    const dir = path.join(home, '.tars');
    for (const d of [a, b, dir]) fs.mkdirSync(d, { recursive: true });
    const agent = (id: string, name: string, projectPath: string, extra: Record<string, unknown> = {}) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'normal', projectPath, skills: [],
      createdAt: '2026-11-19T08:00:00.000Z', lastActivity: '2026-11-19T08:00:00.000Z', ...extra,
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent(A_LEAD, 'A Lead', a, { role: 'orchestrator' }),
      agent(A_ONE, 'Worker One', a),
      agent(A_TWO, 'Worker Two', a),
      agent(B_LEAD, 'B Lead', b, { role: 'orchestrator' }),
      agent(B_CODER, 'B Coder', b, { effort: 'low' }),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([a, b]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));

    const port = apiPort(newInterface ? 31945 : 31944);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const tag = newInterface ? 'new-' : '';
    const errors: string[] = [];
    const servers: ChildProcessWithoutNullStreams[] = [];
    let app: ElectronApplication | undefined;
    try {
      app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
      const page: Page = await app.firstWindow();
      listenForErrors(page, errors);
      await page.setViewportSize({ width: 1440, height: 900 });
      const api = <T>(group: string, name: string, ...args: unknown[]) =>
        page.evaluate(({ group, name, args }) => ((window as unknown as Api).electronAPI[group][name])(...args), { group, name, args }) as Promise<T>;
      const grants = async () => {
        const r = await api<Grant[] | { grants: Grant[] }>('crossProject', 'list');
        return Array.isArray(r) ? r : r.grants ?? [];
      };
      const coder = async () => (await api<Listed[]>('agent', 'list')).find(x => x.id === B_CODER);

      // 1. Settings, AI & Providers, Across projects: no grant yet.
      await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
      await page.getByText('AI & Providers', { exact: true }).first().click({ timeout: 60_000 });
      await page.getByText('Across projects', { exact: true }).first().click({ timeout: 15_000 });
      const give = page.getByRole('button', { name: 'give a grant', exact: true });
      await expect(give).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/^no grant: each project's agents act in their own project only/)).toBeVisible();
      await stepShot(page, `${tag}1-no-grant`);

      // 2. A grant: from project-a to project-b, naming Worker One.
      await give.click();
      const form = page.locator('[data-grant-form]');
      await form.getByRole('button', { name: 'From', exact: true }).click();
      await page.getByRole('option').filter({ hasText: 'project-a' }).first().click();
      await form.getByRole('button', { name: 'To', exact: true }).click();
      await page.getByRole('option').filter({ hasText: 'project-b' }).first().click();
      await form.getByRole('button', { name: 'Worker One', exact: true }).click();
      await expect(form.getByRole('button', { name: 'Worker One', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(form.getByRole('button', { name: 'Worker Two', exact: true })).toHaveAttribute('aria-pressed', 'false');
      await stepShot(page, `${tag}2-giving`);
      await form.getByRole('button', { name: 'Give the grant', exact: true }).click();
      const grantRow = page.locator('[data-grant="project-a to project-b"]');
      await expect(grantRow).toBeVisible({ timeout: 15_000 });
      const given = await grants();
      keep({ given, grantRow: await grantRow.innerText() });
      expect.soft(given.map(g => ({ from: g.from, to: g.to, workers: g.workers })), 'the grant saved').toEqual([{ from: a, to: b, workers: [A_ONE] }]);
      expect.soft(await grantRow.innerText(), 'its row').toMatch(/and its workers Worker One[\s\S]*given by you, /);
      await stepShot(page, `${tag}3-given`);

      // 3. Removed, asked once, at once.
      await grantRow.getByRole('button', { name: 'remove', exact: true }).click();
      await expect(grantRow.getByText("Remove project-a's grant to project-b?", { exact: false })).toBeVisible();
      const beforeConfirm = await grants();
      await grantRow.getByRole('button', { name: 'remove', exact: true }).last().click();
      await expect(grantRow).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByText(/^no grant: /)).toBeVisible();
      const removed = await grants();
      keep({ beforeConfirm: beforeConfirm.length, removed });
      expect.soft(beforeConfirm.length, 'removed before the owner confirmed').toBe(1);
      expect.soft(removed, 'the grant removed').toEqual([]);

      // 4. Worker One retunes B Coder's effort through update_agent, with its own identity.
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('B Coder', { exact: true }).first()).toBeVisible({ timeout: 60_000 });
      const identity = await app.evaluate((_e, { dist, id }) => {
        const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
        return { token: tokens.mintRunToken(id).token as string, instance: tokens.tarsInstanceId() as string };
      }, { dist, id: A_ONE });
      const mcp = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
        env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: identity.token, CLAUDE_AGENT_ID: A_ONE, CLAUDE_PROJECT_PATH: a, TARS_INSTANCE_ID: identity.instance },
      });
      servers.push(mcp);
      const replies = new Map<number, (msg: Reply) => void>();
      let buffered = '';
      mcp.stdout.on('data', (chunk) => {
        buffered += chunk;
        for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
          const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (typeof msg.id === 'number') replies.get(msg.id)?.(msg);
        }
      });
      let nextId = 1;
      const rpc = (method: string, params: unknown) => new Promise<Reply>((resolve) => { const id = nextId++; replies.set(id, resolve); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const reply = await Promise.race([rpc('tools/call', { name: 'update_agent', arguments: { id: B_CODER, effort: 'high' } }), sleep(60_000).then(() => ({ error: 'update_agent gave no answer in 60 s' }) as Reply)]);
      const retuned = { text: reply.result?.content?.map(c => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
      const notices = page.locator('[data-retune-notices]');
      await expect(notices).toContainText('retuned B Coder', { timeout: 30_000 });
      const noticeText = await notices.innerText();
      const afterRetune = await coder();
      // The card, live: its last retune, as the page has it without a reload (soft: 6 checks it after one).
      const card = page.locator('[data-retune]').first();
      const liveCard = await card.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
      await stepShot(page, `${tag}4-retuned-notice`);
      keep({ retuned, noticeText, afterRetune, liveCard, liveCardText: liveCard ? await card.innerText() : null });
      expect.soft(retuned.isError, `update_agent: ${retuned.text}`).toBe(false);
      expect.soft(afterRetune?.effort, 'the effort Worker One asked for').toBe('high');
      expect.soft(afterRetune?.lastRetune, "the record's last retune").toMatchObject({ state: 'applied' });
      expect.soft(noticeText, 'the notice: who, which agent, of which project').toMatch(/Worker One[\s\S]*retuned B Coder \(project-b\)/);
      expect.soft(noticeText, 'the notice: what').toMatch(/low[\s\S]*high/);
      expect.soft(noticeText, 'the notice: its state').toMatch(/applied/);
      // Recorded, not asserted: at #604's head (cbc9e9149) the card shows the retune only after a reload (QA's Low in
      // reports/qa-windows-specs.md); the notice, above, is what tells the owner at once.

      // 5. Undo, from the notice.
      await notices.getByRole('button', { name: 'undo', exact: true }).first().click();
      await expect(notices).toContainText(/undone by you at /, { timeout: 15_000 });
      await expect.poll(async () => (await coder())?.effort, { timeout: 15_000 }).toBe('low');
      const afterUndo = await coder();
      await stepShot(page, `${tag}5-undone`);
      keep({ afterUndo, noticeAfterUndo: await notices.innerText() });

      // 6. The card, after a reload: B Coder's last retune, as its record says.
      await page.reload({ waitUntil: 'domcontentloaded' });
      const cardAfterReload = page.locator('[data-retune]').first();
      const reloadedCard = await cardAfterReload.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
      keep({ reloadedCard, reloadedCardText: reloadedCard ? await cardAfterReload.innerText() : null, recordAfterUndo: (await coder())?.lastRetune ?? null });
      expect.soft(reloadedCard, "the card's last retune after a reload").toBe(true);
      await stepShot(page, `${tag}6-card-after-reload`);

      // 7.
      keep({ errors });
      expect(errors).toEqual([]);
    } finally {
      for (const s of servers) s.kill();
      await app?.close().catch(() => {});
      await removeHome(home);
    }
  });
}
