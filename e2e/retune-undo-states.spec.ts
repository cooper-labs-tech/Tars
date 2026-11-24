import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, listenForErrors, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { writeFakeClis } from './fake-clis.mjs';

/**
 * An undo asked while its agent is at work, in the window (#604, the Audit's M1 and L2 at 2f9d72021): the agent's
 * card and the notice say what the undo is, queued, applied, cancelled or failed, and never "undone" before it is.
 * Two projects: project-a (Worker One, which retunes and asks the undos through the real mcp-orchestrator with its
 * own token) and project-b (B Lead, its orchestrator, which hands its workers a task that holds their turn; B Coder,
 * claude at effort low; B Pi, pi). A turn is held by the fake CLI's `HOLD <tag>` until the spec writes release-<tag>.
 *
 * How it can fail, written before it ran (QA, 24/11, t-ad2a63a9):
 * 1. An undo Worker One asks of B Coder's change (effort low to high) while B Coder works on a task is not queued, or
 *    is applied at once; or B Coder's card does not read it as asked: data-retune="undo-queued", "undo asked by
 *    Worker One (project-a) at HH:MM", "effort high to low · waits for ..."; or the notice does not say so:
 *    data-retune-notice="undo-queued", "Worker One (project-a) asked to undo a change to B Coder (project-b): effort
 *    high to low: it waits for ...". Reading "undone" here is the Audit's M1.
 * 2. Once the turn ends, the undo does not apply (the effort stays high), or the card does not read
 *    data-retune="undone", "undone by Worker One (project-a) at HH:MM", "applied HH:MM", or the notice
 *    data-retune-notice="undo-applied", "... undid a change to B Coder (project-b): effort high to low, applied HH:MM.".
 * 3. An undo queued, then taken back before the turn ends (revert_agent_change on the undo itself), still applies
 *    once the turn ends; or the card does not read data-retune="undo-cancelled", "undo cancelled: asked by Worker One
 *    (project-a) at HH:MM", "· cancelled", or reads undone; or the notice is not data-retune-notice="undo-cancelled",
 *    "... asked to undo a change to B Coder (project-b): effort high to low, cancelled.".
 * 4. An undo queued that fails when it applies (B Pi's provider change to claude taken back while the window has set
 *    B Pi in plan meanwhile: pi has no plan mode) is applied anyway (provider pi); or the card does not read
 *    data-retune="undo-failed", "undo failed: asked by Worker One (project-a) at HH:MM", "· failed", or reads undone;
 *    or the notice is not data-retune-notice="undo-failed", "... asked to undo a change to B Pi (project-b): provider
 *    claude to pi, failed.". The event carries no reason: "failed" is asserted, and nothing more.
 * 5. (the Audit's I-1) A provider change names on the card only what its caller asked (provider pi to claude), and the
 *    panel of the agent's window lists what was reset with it apart, "also reset": cliPath and model.
 * 6. (the Audit's I-2) After a reload, a card no longer says its undo's state and head (from the record's lastRetune).
 *    The line's values after a reload are recorded, not asserted: the record keeps none (the Audit's I-2, an Info).
 * 7. A plain retune Worker One asks of B Coder at work (effort high to medium) is not queued, or the card does not
 *    read data-retune="queued", "retune asked by Worker One (project-a) at HH:MM", or the notice data-retune-notice=
 *    "queued", "... asked to retune B Coder (project-b): effort high to medium: it waits for ...". Taken back before
 *    the turn ends (revert_agent_change), it still applies, or the card does not read data-retune="cancelled",
 *    "retune cancelled: asked by ... at HH:MM", "· cancelled", with no undo; or the notice "cancelled", "... asked to
 *    retune B Coder (project-b): effort high to medium, cancelled.", with no undo.
 * 8. A plain retune of B Pi back to pi asked at work, plan set from the window meanwhile, applies anyway, or the card
 *    does not read data-retune="failed", "retune failed: asked by ... at HH:MM", "· failed", with no undo; or the
 *    notice "failed", "... asked to retune B Pi (project-b): provider claude to pi, failed.", with no undo.
 * 9. After a second reload, the two cards do not keep "cancelled" and "failed" with their heads.
 * 10. An uncaught error in the page.
 * In the classic shell and in the new interface's.
 * Expected red at 2f9d72021: 1, 3, 4 and 6 read data-retune="undone" and "undone by", no [data-retune-notice] exists,
 * and 7 to 9 read "retuned by". At 511b018a4 (the undo's states only): 7 to 9, a failed or cancelled plain retune read
 * "retuned ...".
 * The artefact: values.json (each answer of the tools, each agent's last retune, card and notice texts), screenshots.
 */

const A_ONE = 'aaaa1111-0000-4000-8000-0000000000a1';
const B_LEAD = 'bbbb2222-0000-4000-8000-0000000000b0';
const B_CODER = 'bbbb2222-0000-4000-8000-0000000000b1';
const B_PI = 'bbbb2222-0000-4000-8000-0000000000b2';
const CLOCK = '\\d\\d:\\d\\d';
const BY = 'Worker One \\(project-a\\)';
type Said = { text: string; isError: boolean };
type Reply = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
type Retune = { changeId: string; state: string; revertOf?: string; fields?: string[]; asked?: string[] };
type Listed = { id: string; status?: string; effort?: string | null; provider?: string; permissionMode?: string; lastRetune?: Retune };

for (const newInterface of [false, true]) {
  test(`an undo asked of an agent at work reads asked, then undone, cancelled or failed, on its card and in its notice${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(8 * 60_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-retune-undo-'));
    const a = path.join(home, 'projects', 'project-a');
    const b = path.join(home, 'projects', 'project-b');
    const dir = path.join(home, '.tars');
    for (const d of [a, b, dir]) fs.mkdirSync(d, { recursive: true });
    const fakes = writeFakeClis(home, ['claude', 'pi']) as Record<string, string>;
    const agent = (id: string, name: string, projectPath: string, extra: Record<string, unknown> = {}) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'normal', projectPath, skills: [],
      createdAt: '2026-11-24T08:00:00.000Z', lastActivity: '2026-11-24T08:00:00.000Z', ...extra,
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent(A_ONE, 'Worker One', a),
      agent(B_LEAD, 'B Lead', b, { role: 'orchestrator' }),
      agent(B_CODER, 'B Coder', b, { effort: 'low' }),
      agent(B_PI, 'B Pi', b, { provider: 'pi', model: 'pi-model', cliPath: fakes.pi }),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([a, b]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface, cliPaths: { claude: fakes.claude, pi: fakes.pi },
    }));

    const port = apiPort(newInterface ? 31951 : 31950);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const tag = newInterface ? 'new-' : '';
    const errors: string[] = [];
    const servers: ChildProcessWithoutNullStreams[] = [];
    let app: ElectronApplication | undefined;
    try {
      app = await launchSandboxed(electron, home, {
        env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', DOROTHY_STATUS_EVERY_MS: '500' },
      });
      const page: Page = await app.firstWindow();
      listenForErrors(page, errors);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
      await expect(page.locator(`[data-agent-card="${B_CODER}"]`)).toBeVisible({ timeout: 60_000 });
      const api = <T>(group: string, name: string, ...args: unknown[]) =>
        page.evaluate(({ group, name, args }) => ((window as unknown as Api).electronAPI[group][name])(...args), { group, name, args }) as Promise<T>;
      const listed = async (id: string) => (await api<Listed[]>('agent', 'list')).find(x => x.id === id);

      /** The orchestrator MCP server, run as `agentId` with the identity Tars hands it. */
      const mcpAs = async (agentId: string, project: string) => {
        const identity = await app!.evaluate((_e, { dist, agentId }) => {
          const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
          return { token: tokens.mintRunToken(agentId).token as string, instance: tokens.tarsInstanceId() as string };
        }, { dist, agentId });
        const server = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
          env: {
            PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: identity.token,
            CLAUDE_AGENT_ID: agentId, CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: identity.instance,
          },
        });
        servers.push(server);
        let said = '';
        server.stderr.on('data', (chunk) => { said = (said + chunk).slice(-2000); });
        const replies = new Map<number, (msg: Reply) => void>();
        let buffered = '';
        server.stdout.on('data', (chunk) => {
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
        const rpc = (method: string, params: unknown) => new Promise<Reply>((resolve, reject) => {
          const id = nextId++;
          const late = setTimeout(() => reject(new Error(`the orchestrator MCP server of ${agentId} did not answer ${method} in 90 s; it said: ${said}`)), 90_000);
          replies.set(id, (msg) => { clearTimeout(late); resolve(msg); });
          server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
        await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
        server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
        return async (name: string, args: Record<string, unknown>): Promise<Said> => {
          const reply = await rpc('tools/call', { name, arguments: args });
          return { text: reply.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
        };
      };
      const one = await mcpAs(A_ONE, a);
      const lead = await mcpAs(B_LEAD, b);

      /** A change asked by Worker One, and its id, read from the agent's record once the window lists it. */
      const retune = async (id: string, settings: Record<string, unknown>) => {
        const said = await one('update_agent', { id, ...settings });
        await expect.poll(async () => (await listed(id))?.lastRetune?.state, { timeout: 60_000, message: `${id}: ${said.text}` }).toBe('applied');
        return { said, changeId: (await listed(id))?.lastRetune?.changeId ?? '' };
      };
      /** Worker One's revert of a change: the revert's state and, for an undo it asks, the undo's own change id. */
      const revert = async (changeId: string) => {
        const said = await one('revert_agent_change', { changeId });
        let first: { state?: string; revertChangeId?: string } | undefined;
        try { first = (JSON.parse(said.text) as { results?: Array<{ state?: string; revertChangeId?: string }> }).results?.[0]; } catch { first = undefined; }
        return { said, state: first?.state, undo: first?.revertChangeId ?? '' };
      };
      /** A task from B Lead that holds the agent's turn until release-<label> exists. */
      const hold = async (id: string, label: string) => {
        const said = await lead('delegate_task', { id, prompt: `HOLD ${label}`, timeoutSeconds: 3 });
        await expect.poll(async () => (await listed(id))?.status, { timeout: 60_000, message: `${id} at work on HOLD ${label}: ${said.text}` }).toBe('running');
        return said;
      };
      const release = (label: string) => fs.writeFileSync(path.join(home, `release-${label}`), '');
      /** Waits until the agent's last retune is `changeId` in `state`, as the window lists it. */
      const reached = (id: string, changeId: string, state: string) => expect.poll(async () => {
        const last = (await listed(id))?.lastRetune;
        return last?.changeId === changeId ? last.state : `${last?.changeId ?? 'none'} ${last?.state ?? ''}`;
      }, { timeout: 90_000 }).toBe(state);
      const lineOf = (id: string) => page.locator(`[data-agent-card="${id}"] [data-retune]`).first();
      const noticeOf = (state: string, name: string) => page.locator(`[data-retune-notice="${state}"]`).filter({ hasText: name }).first();
      const textOf = (l: Locator) => l.innerText({ timeout: 3_000 }).catch(() => null);
      const markerOf = (l: Locator) => l.getAttribute('data-retune', { timeout: 3_000 }).catch(() => null);
      /** The card's line and the notice, read once the window holds the state, and asserted. */
      const told = async (step: string, id: string, name: string, marker: string, head: RegExp, line: RegExp, notice: string, said: RegExp) => {
        const card = lineOf(id);
        const markerSeen = await expect(card).toHaveAttribute('data-retune', marker, { timeout: 10_000 }).then(() => marker, async () => markerOf(card));
        const cardText = await textOf(card);
        const n = noticeOf(notice, name);
        const noticeShown = await n.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false);
        const noticeText = noticeShown ? await textOf(n) : null;
        const allNotices = await page.locator('[data-retune-notices]').innerText({ timeout: 2_000 }).catch(() => null);
        await stepShot(page, `${tag}${step}`);
        keep({ [step]: { markerSeen, cardText, noticeShown, noticeText, allNotices, record: (await listed(id))?.lastRetune ?? null } });
        expect.soft(markerSeen, `${step}: the card's data-retune`).toBe(marker);
        expect.soft(cardText, `${step}: the card's head`).toMatch(head);
        expect.soft(cardText, `${step}: the card's line`).toMatch(line);
        expect.soft(noticeShown, `${step}: a notice data-retune-notice="${notice}" for ${name}`).toBe(true);
        expect.soft(noticeText, `${step}: the notice's words`).toMatch(said);
      };

      // ── 1. B Coder: low to high, applied; then at work, and its undo asked: queued ──
      const c1 = await retune(B_CODER, { effort: 'high' });
      const held1 = await hold(B_CODER, 'u1');
      const u1 = await revert(c1.changeId);
      keep({ c1, held1, u1 });
      expect.soft(u1.state, `the undo of a change to an agent at work: ${u1.said.text}`).toBe('queued');
      await reached(B_CODER, u1.undo, 'queued');
      expect.soft((await listed(B_CODER))?.effort, 'the effort, while its undo waits').toBe('high');
      await told('1-undo-queued', B_CODER, 'B Coder', 'undo-queued',
        new RegExp(`undo asked by ${BY} at ${CLOCK}`), /effort high to low · waits for \S/,
        'undo-queued', new RegExp(`${BY} asked to undo a change to B Coder \\(project-b\\): effort high to low: it waits for \\S[^.]*\\.`));

      // ── 2. The turn ends: the undo applies ──
      release('u1');
      await reached(B_CODER, u1.undo, 'applied');
      await expect.poll(async () => (await listed(B_CODER))?.effort, { timeout: 30_000 }).toBe('low');
      await told('2-undo-applied', B_CODER, 'B Coder', 'undone',
        new RegExp(`undone by ${BY} at ${CLOCK}`), new RegExp(`effort high to low · applied ${CLOCK}`),
        'undo-applied', new RegExp(`${BY} undid a change to B Coder \\(project-b\\): effort high to low, applied ${CLOCK}\\.`));

      // ── 3. Again, and the queued undo taken back before the turn ends: cancelled ──
      const c2 = await retune(B_CODER, { effort: 'high' });
      const held2 = await hold(B_CODER, 'u2');
      const u2 = await revert(c2.changeId);
      await reached(B_CODER, u2.undo, 'queued');
      const u2back = await revert(u2.undo);
      keep({ c2, held2, u2, u2back });
      expect.soft(u2back.state, `the queued undo taken back: ${u2back.said.text}`).toBe('cancelled');
      await reached(B_CODER, u2.undo, 'cancelled');
      await told('3-undo-cancelled', B_CODER, 'B Coder', 'undo-cancelled',
        new RegExp(`undo cancelled: asked by ${BY} at ${CLOCK}`), /effort high to low · cancelled/,
        'undo-cancelled', new RegExp(`${BY} asked to undo a change to B Coder \\(project-b\\): effort high to low, cancelled\\.`));
      release('u2');
      await expect.poll(async () => (await listed(B_CODER))?.status, { timeout: 60_000 }).not.toBe('running');
      expect.soft((await listed(B_CODER))?.effort, 'a cancelled undo never applies').toBe('high');

      // ── 4. B Pi: pi to claude (also reset: cliPath, model) ──
      const c3 = await retune(B_PI, { provider: 'claude' });
      const piLine = await textOf(lineOf(B_PI));
      await page.goto(`${DEV_URL}/agents?agent=${B_PI}`, { waitUntil: 'domcontentloaded' });
      const panel = page.locator('[data-retune-panel]').first();
      const panelShown = await panel.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
      const panelText = panelShown ? await textOf(panel) : null;
      const alsoReset = /also reset\s+([^\n]+)/.exec(panelText ?? '')?.[1] ?? null;
      await stepShot(page, `${tag}4-also-reset`);
      keep({ c3, piLine, panelText, alsoReset });
      expect.soft(piLine, 'the card names what was asked').toMatch(/provider pi to claude/);
      expect.soft(piLine, 'and not what was reset with it').not.toMatch(/cliPath|model/);
      expect.soft(alsoReset, 'the panel: also reset').toMatch(/cliPath/);
      expect.soft(alsoReset, 'the panel: also reset').toMatch(/model/);
      expect.soft(alsoReset, 'the panel: also reset').not.toMatch(/provider/);
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator(`[data-agent-card="${B_PI}"]`)).toBeVisible({ timeout: 60_000 });

      // ── 5. At work; its undo asked; plan set from the window meanwhile; the turn ends: failed ──
      const held3 = await hold(B_PI, 'u3');
      const u3 = await revert(c3.changeId);
      await reached(B_PI, u3.undo, 'queued');
      const planned = await api<{ success: boolean; error?: string }>('agent', 'update', { id: B_PI, permissionMode: 'plan' });
      keep({ held3, u3, planned });
      expect.soft(planned.success, `plan set from the window: ${planned.error ?? ''}`).toBe(true);
      release('u3');
      await reached(B_PI, u3.undo, 'failed');
      const piAfter = await listed(B_PI);
      keep({ piAfter });
      expect.soft(piAfter?.provider, 'a failed undo leaves the provider as it was').toBe('claude');
      await told('5-undo-failed', B_PI, 'B Pi', 'undo-failed',
        new RegExp(`undo failed: asked by ${BY} at ${CLOCK}`), /provider claude to pi · failed/,
        'undo-failed', new RegExp(`${BY} asked to undo a change to B Pi \\(project-b\\): provider claude to pi, failed\\.`));

      // ── 6. After a reload: each card from its record ──
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator(`[data-agent-card="${B_PI}"]`)).toBeVisible({ timeout: 60_000 });
      const reloaded: Record<string, unknown> = {};
      for (const [id, marker, head] of [
        [B_CODER, 'undo-cancelled', new RegExp(`undo cancelled: asked by ${BY} at ${CLOCK}`)],
        [B_PI, 'undo-failed', new RegExp(`undo failed: asked by ${BY} at ${CLOCK}`)],
      ] as Array<[string, string, RegExp]>) {
        const card = lineOf(id);
        const markerSeen = await expect(card).toHaveAttribute('data-retune', marker, { timeout: 15_000 }).then(() => marker, async () => markerOf(card));
        const cardText = await textOf(card);
        reloaded[id] = { markerSeen, cardText, notices: await page.locator('[data-retune-notice]').count() };
        expect.soft(markerSeen, `after a reload, ${id}'s data-retune`).toBe(marker);
        expect.soft(cardText, `after a reload, ${id}'s head`).toMatch(head);
      }
      await stepShot(page, `${tag}6-after-reload`);
      keep({ reloaded });

      /** A plain retune Worker One asks of an agent at work: queued, and its change id once the window lists it. */
      const asked = async (id: string, settings: Record<string, unknown>) => {
        const before = (await listed(id))?.lastRetune?.changeId;
        const said = await one('update_agent', { id, ...settings });
        await expect.poll(async () => { const last = (await listed(id))?.lastRetune; return last && last.changeId !== before ? last.state : 'none yet'; },
          { timeout: 60_000, message: `${id}: ${said.text}` }).toBe('queued');
        return { said, changeId: (await listed(id))?.lastRetune?.changeId ?? '' };
      };
      const undoButtons = async (id: string, notice: string, name: string) => ({
        card: await lineOf(id).getByRole('button', { name: 'undo', exact: true }).count(),
        notice: await noticeOf(notice, name).getByRole('button', { name: 'undo', exact: true }).count(),
      });

      // ── 7. A plain retune asked at work: queued; taken back before the turn ends: cancelled ──
      const held4 = await hold(B_CODER, 'u4');
      const c4 = await asked(B_CODER, { effort: 'medium' });
      keep({ held4, c4 });
      await told('7-retune-queued', B_CODER, 'B Coder', 'queued',
        new RegExp(`retune asked by ${BY} at ${CLOCK}`), /effort high to medium · waits for \S/,
        'queued', new RegExp(`${BY} asked to retune B Coder \\(project-b\\): effort high to medium: it waits for \\S[^.]*\\.`));
      const c4back = await revert(c4.changeId);
      keep({ c4back });
      expect.soft(c4back.state, `the queued retune taken back: ${c4back.said.text}`).toBe('cancelled');
      await reached(B_CODER, c4.changeId, 'cancelled');
      await told('7-retune-cancelled', B_CODER, 'B Coder', 'cancelled',
        new RegExp(`retune cancelled: asked by ${BY} at ${CLOCK}`), /effort high to medium · cancelled/,
        'cancelled', new RegExp(`${BY} asked to retune B Coder \\(project-b\\): effort high to medium, cancelled\\.`));
      const cancelledUndos = await undoButtons(B_CODER, 'cancelled', 'B Coder');
      keep({ cancelledUndos });
      expect.soft(cancelledUndos, 'a cancelled retune offers no undo').toEqual({ card: 0, notice: 0 });
      release('u4');
      await expect.poll(async () => (await listed(B_CODER))?.status, { timeout: 60_000 }).not.toBe('running');
      expect.soft((await listed(B_CODER))?.effort, 'a cancelled retune never applies').toBe('high');

      // ── 8. A plain retune of B Pi back to pi asked at work; plan set from the window meanwhile: failed ──
      const unplanned = await api<{ success: boolean; error?: string }>('agent', 'update', { id: B_PI, permissionMode: 'normal' });
      const held5 = await hold(B_PI, 'u5');
      const c5 = await asked(B_PI, { provider: 'pi' });
      const planned5 = await api<{ success: boolean; error?: string }>('agent', 'update', { id: B_PI, permissionMode: 'plan' });
      keep({ unplanned, held5, c5, planned5 });
      expect.soft(planned5.success, `plan set from the window: ${planned5.error ?? ''}`).toBe(true);
      release('u5');
      await reached(B_PI, c5.changeId, 'failed');
      expect.soft((await listed(B_PI))?.provider, 'a failed retune leaves the provider as it was').toBe('claude');
      await told('8-retune-failed', B_PI, 'B Pi', 'failed',
        new RegExp(`retune failed: asked by ${BY} at ${CLOCK}`), /provider claude to pi · failed/,
        'failed', new RegExp(`${BY} asked to retune B Pi \\(project-b\\): provider claude to pi, failed\\.`));
      const failedUndos = await undoButtons(B_PI, 'failed', 'B Pi');
      keep({ failedUndos });
      expect.soft(failedUndos, 'a failed retune offers no undo').toEqual({ card: 0, notice: 0 });

      // ── 9. A second reload: the plain retunes from their records ──
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator(`[data-agent-card="${B_PI}"]`)).toBeVisible({ timeout: 60_000 });
      const reloadedPlain: Record<string, unknown> = {};
      for (const [id, marker, head] of [
        [B_CODER, 'cancelled', new RegExp(`retune cancelled: asked by ${BY} at ${CLOCK}`)],
        [B_PI, 'failed', new RegExp(`retune failed: asked by ${BY} at ${CLOCK}`)],
      ] as Array<[string, string, RegExp]>) {
        const card = lineOf(id);
        const markerSeen = await expect(card).toHaveAttribute('data-retune', marker, { timeout: 15_000 }).then(() => marker, async () => markerOf(card));
        const cardText = await textOf(card);
        reloadedPlain[id] = { markerSeen, cardText };
        expect.soft(markerSeen, `after a second reload, ${id}'s data-retune`).toBe(marker);
        expect.soft(cardText, `after a second reload, ${id}'s head`).toMatch(head);
      }
      await stepShot(page, `${tag}9-after-second-reload`);
      keep({ reloadedPlain });

      // ── 10. ──
      keep({ errors });
      expect(errors).toEqual([]);
    } finally {
      for (const s of servers) s.kill();
      await app?.close().catch(() => {});
      await removeHome(home);
    }
  });
}
