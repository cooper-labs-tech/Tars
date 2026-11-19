import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { writeFakeClis } from './fake-clis.mjs';

/**
 * Any agent retunes any agent, and one project drives another's agents through the owner's allowlist (2.0.7, the
 * owner's word of 19/11 through Tars-Orchestrator: t-f3f96092, t-e04cb794, t-b9a332b3, t-5f4d852d). An outside
 * project's agents adjust another project's fleet: its harness, model and effort, its tasks, its working folders.
 *
 * The real app on a sandbox HOME, the real orchestrator MCP server (mcp-orchestrator/dist/bundle.js) run with the
 * identity Tars hands an agent, once per caller, and the CLI stand-ins of e2e/fake-clis.mjs (claude, qwen-code, pi)
 * and e2e/fake-codex.mjs (codex) as project B's agents, each answering from its own session files as its real CLI
 * does. Project A has an orchestrator, a worker the grant names and a worker it does not; project B is
 * a git repository with a bare remote (an orchestrator and four workers on claude, codex, pi, qwen-code).
 *
 * Asserted, in order:
 * 1. read-back: a worker of A lists B's agents with their harness, model, effort and status, and nothing of their
 *    tasks' content;
 * 2. no grant yet: A's workers and A's orchestrator hand B's workers no work and stop none (refused, naming the
 *    allowlist), allowCrossProject or not; but A's orchestrator, with allowCrossProject, hands B's orchestrator a
 *    task and reads its answer (task_status, get_agent_output), as projects' orchestrators talk to each other;
 * 3. a worker of A changes the harness, model and effort of a B agent and of B's orchestrator through update_agent:
 *    applied at once (no CLI runs there), on the record, on the agent's card in the window, and in the window's
 *    notice event with who did it; a field outside the list (permission mode), alone or with a model, is refused and
 *    nothing is written;
 * 4. the owner grants A -> B in the window (crossProject.set), naming one worker of A;
 * 5. that worker delegates to B's codex, pi and qwen-code agents: each answers, and task_status gives the asker the
 *    final answer; the worker the grant does not name is still refused; B's orchestrator, in a session, gets a note
 *    from Tars for each outside delegation;
 * 6. a change to an agent mid-turn (a task holding its turn) is queued, not written, its turn not cut; once the turn
 *    ends it is applied, the log keeps when, and the asker still reads the task's answer;
 * 7. a batch over all of B, applied or queued agent by agent under one batch id, then reverted in one call: every
 *    agent back to its earlier effort;
 * 8. the change log, through agent_changes: who, which agent, before, after, applied or queued, when;
 * 9. a worktree for B's agent: the granted worker makes one in B under .worktrees/<branch> with push off (the worker the grant
 *    does not name is refused), moves an agent onto it and back, and removes it; B's main checkout keeps its HEAD,
 *    its branch and its working tree through all of it; `git push` from the worktree fails loudly naming why, and a
 *    push from the main checkout still works;
 * 10. through the grant, the named worker creates a ready agent in B in one call (codex, its model and effort, a
 *    worktree on the branch it names with push off): on the record and on disk, its push refused; a second creation
 *    on a branch another worktree holds is refused and leaves nothing made (no agent, no worktree); the worker the
 *    grant does not name is refused; the named worker changes a setting beyond the inference ones of a B agent;
 *    removing the agent while its worktree holds uncommitted work is refused, saying why, and leaves both; once the
 *    work is committed it is removed with its worktree. B's main checkout is untouched throughout;
 * 11. the window undoes an agent's last retune (agent.revertChange): its earlier value back, filed under the window.
 * Run in the classic shell and in the new interface's. The artefact: values.json (every tool answer, the records,
 * the change log, the git states).
 */

type Said = { text: string; isError: boolean };

const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};

for (const newInterface of [false, true]) {
  test(`one project retunes and drives another's agents through the owner's allowlist${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(420_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-across-projects-'));
    const A = path.join(home, 'projects', 'project-a');
    const B = path.join(home, 'projects', 'project-b');
    const remote = path.join(home, 'remotes', 'project-b.git');
    const dir = path.join(home, '.tars');
    for (const d of [A, B, dir, path.dirname(remote)]) fs.mkdirSync(d, { recursive: true });

    // B: a repository on main, pushed to a bare remote.
    expect(git(path.dirname(remote), ['init', '-q', '--bare', remote]).code).toBe(0);
    for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'e2e@tars.test'], ['config', 'user.name', 'e2e']]) expect(git(B, args).code).toBe(0);
    fs.writeFileSync(path.join(B, 'README.md'), 'project b\n');
    for (const args of [['add', 'README.md'], ['commit', '-q', '-m', 'first'], ['remote', 'add', 'origin', remote], ['push', '-q', 'origin', 'main']]) expect(git(B, args).code).toBe(0);
    const mainState = () => ({ head: git(B, ['rev-parse', 'HEAD']).out, branch: git(B, ['symbolic-ref', '--short', 'HEAD']).out, status: git(B, ['status', '--porcelain', '--untracked-files=all', '--ignored=no']).out });
    const mainBefore = mainState();

    const fakes = writeFakeClis(home, ['claude', 'qwen-code', 'pi', 'codex']) as Record<string, string>;
    const seeded = (id: string, name: string, role: string, projectPath: string, provider = 'claude', more: Record<string, unknown> = {}) => ({
      id, name, character: 'robot', provider, status: 'idle', role, permissionMode: 'bypass', projectPath, skills: [],
      createdAt: '2026-11-19T08:00:00.000Z', lastActivity: '2026-11-19T08:00:00.000Z', ...more,
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      seeded('a-o', 'A-Orchestrator', 'orchestrator', A),
      seeded('a-w', 'A-Worker', 'worker', A),
      seeded('a-x', 'A-Other', 'worker', A),
      seeded('b-o', 'B-Orchestrator', 'orchestrator', B, 'claude', { effort: 'medium' }),
      seeded('b-c', 'B-Claude', 'worker', B, 'claude', { model: 'sonnet', effort: 'medium' }),
      seeded('b-codex', 'B-Codex', 'worker', B, 'codex', { model: 'gpt-5.4', effort: 'medium' }),
      seeded('b-pi', 'B-Pi', 'worker', B, 'pi', { effort: 'medium' }),
      seeded('b-qwen', 'B-Qwen', 'worker', B, 'qwen-code', { effort: 'medium' }),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([A, B]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, newInterface,
      cliPaths: { claude: fakes.claude, codex: fakes.codex, pi: fakes.pi, qwencode: fakes['qwen-code'], additionalPaths: [path.join(home, 'bin')] },
    }));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    const port = apiPort(31453);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { home, A, B, newInterface, mainBefore };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', DOROTHY_STATUS_EVERY_MS: '500' },
    });
    const servers: ChildProcessWithoutNullStreams[] = [];
    try {
      const page: Page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
      // The window's notice: every retune Tars announces, as the window receives it.
      await page.evaluate(() => {
        const w = window as unknown as { retuned: unknown[]; electronAPI: { agent: { onRetuned: (cb: (e: unknown) => void) => void } } };
        w.retuned = [];
        w.electronAPI.agent.onRetuned((e) => { w.retuned.push(e); });
      });
      const notices = () => page.evaluate(() => (window as unknown as { retuned: Array<Record<string, unknown>> }).retuned);

      /** The orchestrator MCP server, run as `agentId` with the identity Tars hands it. */
      const mcpAs = async (agentId: string, project: string) => {
        const identity = await app.evaluate((_e, { dist, agentId }) => {
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
        const replies = new Map<number, (msg: { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown }) => void>();
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
        const rpc = (method: string, params: unknown) => new Promise<Parameters<NonNullable<ReturnType<typeof replies.get>>>[0]>((resolve, reject) => {
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
      const lead = await mcpAs('a-o', A);
      const named = await mcpAs('a-w', A);
      const other = await mcpAs('a-x', A);

      const records = () => {
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')) as { agents?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
        return Array.isArray(saved) ? saved : saved.agents ?? [];
      };
      const recordOf = (id: string) => records().find((a) => a.id === id) ?? {};
      const card = (id: string) => page.locator(`[data-agent-card="${id}"]`);
      // A task still working is named by its ref (t-xxxxxxxx); one that ended within the wait by the ledger's id, on the
      // answer's last line (`... | task <uuid>`), which task_status and get_agent_output read as well.
      const taskIdOf = (said: Said) => /\bt-[0-9a-f]{8}\b/.exec(said.text)?.[0]
        ?? /\| task ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/.exec(said.text)?.[1];

      // ── 1. Read-back: another project's agents, their inference settings and status, no task content ──
      const listed = await other('list_agents', { project: B });
      keep({ listed });
      expect(listed.isError).toBe(false);
      const listedRows = JSON.parse(listed.text.slice(listed.text.indexOf('['))) as Array<Record<string, unknown>>;
      expect(listedRows.map((r) => r.id).sort()).toEqual(['b-c', 'b-codex', 'b-o', 'b-pi', 'b-qwen']);
      expect(listedRows.find((r) => r.id === 'b-codex')).toMatchObject({ provider: 'codex', model: 'gpt-5.4', effort: 'medium', status: 'idle' });
      for (const row of listedRows) for (const key of ['currentTask', 'lastCleanOutput', 'checkpoint', 'askedBy', 'output']) expect(row).not.toHaveProperty(key);

      // ── 2. No grant: no work handed across, allowCrossProject or not ──
      const ungranted = await Promise.all([
        named('delegate_task', { id: 'b-pi', prompt: 'ECHO never1', timeoutSeconds: 5, allowCrossProject: true }),
        lead('delegate_task', { id: 'b-pi', prompt: 'ECHO never2', timeoutSeconds: 5, allowCrossProject: true }),
        lead('stop_agent', { id: 'b-pi', reason: 'no grant yet', allowCrossProject: true }),
      ]);
      keep({ ungranted });
      for (const said of ungranted) {
        expect(said.isError).toBe(true);
        expect(said.text).toContain('cross_project_not_granted');
      }
      // Orchestrator to orchestrator, with no grant: a task and its answer, as projects' leads talk to each other.
      const o2o = await lead('delegate_task', { id: 'b-o', prompt: 'ECHO oo1', timeoutSeconds: 120, allowCrossProject: true });
      const o2oTask = taskIdOf(o2o);
      const o2oStatus = o2oTask ? await lead('task_status', { taskId: o2oTask }) : undefined;
      const o2oOutput = o2oTask ? await lead('get_agent_output', { id: 'b-o', taskId: o2oTask }) : undefined;
      const o2oWorker = await lead('delegate_task', { id: 'b-codex', prompt: 'ECHO never4', timeoutSeconds: 5, allowCrossProject: true });
      keep({ o2o, o2oStatus, o2oOutput, o2oWorker });
      expect(o2o.isError).toBe(false);
      expect(o2o.text).toContain('echo oo1');
      expect(o2oStatus?.text).toContain('echo oo1');
      expect(o2oOutput?.text).toContain('echo oo1');
      expect(o2oWorker.isError).toBe(true);
      expect(o2oWorker.text).toContain('cross_project_not_granted');
      expect(o2oWorker.text).toMatch(/owner/);

      // ── 3. A worker of A retunes a B worker and B's orchestrator; a field outside the list is refused ──
      const retuned = await other('update_agent', { id: 'b-c', provider: 'codex', model: 'gpt-5.5', effort: 'high' });
      const retunedLead = await other('update_agent', { id: 'b-o', model: 'opus', effort: 'max' });
      keep({ retuned, retunedLead, afterRetune: { 'b-c': recordOf('b-c'), 'b-o': recordOf('b-o') } });
      expect(retuned.isError).toBe(false);
      expect(retuned.text).toMatch(/\bapplied\b/);
      expect(recordOf('b-c')).toMatchObject({ provider: 'codex', model: 'gpt-5.5', effort: 'high' });
      expect(retunedLead.isError).toBe(false);
      // B's orchestrator may still be in a turn (its task's end, or the note Tars types it about its worker's change):
      // the change to it goes in at once or as that turn ends, never cutting it.
      expect(retunedLead.text).toMatch(/\bapplied\b|once its turn ends/);
      await expect.poll(() => recordOf('b-o'), { timeout: 30_000 }).toMatchObject({ model: 'opus', effort: 'max', role: 'orchestrator' });
      // On the agent's card, and in the window's notice, with who did it.
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await expect(card('b-c')).toContainText('gpt-5.5', { timeout: 30_000 });
      await expect(card('b-c')).toContainText(/codex/i);
      await page.evaluate(() => {
        const w = window as unknown as { retuned: unknown[]; electronAPI: { agent: { onRetuned: (cb: (e: unknown) => void) => void } } };
        w.retuned = w.retuned ?? [];
        w.electronAPI.agent.onRetuned((e) => { w.retuned.push(e); });
      });
      const viaWindow = await page.evaluate(() => (window as unknown as { electronAPI: { agent: { get: (id: string) => Promise<Record<string, unknown>> } } }).electronAPI.agent.get('b-c'));
      keep({ viaWindow: { lastRetune: (viaWindow as Record<string, unknown>)?.lastRetune } });
      expect((viaWindow as Record<string, unknown>)?.lastRetune).toMatchObject({ by: { id: 'a-x', name: 'A-Other', projectPath: A }, state: 'applied' });
      const refusedAlone = await other('update_agent', { id: 'b-c', permissionMode: 'plan' });
      const refusedMixed = await other('update_agent', { id: 'b-c', model: 'gpt-5.6', permissionMode: 'plan' });
      keep({ refusedAlone, refusedMixed });
      for (const said of [refusedAlone, refusedMixed]) expect(said.isError).toBe(true);
      expect(refusedAlone.text).toContain('permissionMode');
      expect(recordOf('b-c')).toMatchObject({ model: 'gpt-5.5', permissionMode: 'bypass' });

      // ── 4. The owner grants A -> B in the window, naming one worker ──
      const granted = await page.evaluate(({ A, B }) => (window as unknown as { electronAPI: { crossProject: { set: (g: unknown) => Promise<unknown> } } }).electronAPI.crossProject.set({ from: A, to: B, workers: ['a-w'] }), { A, B });
      keep({ granted });
      expect(granted).toMatchObject({ ok: true });

      // B's orchestrator is in a session since the task A's orchestrator handed it: Tars's notes go there.
      const fakeLog = () => (fs.existsSync(path.join(home, 'fake-cli.jsonl')) ? fs.readFileSync(path.join(home, 'fake-cli.jsonl'), 'utf8') : '');
      await expect.poll(() => /echo oo1/.test(fakeLog()), { timeout: 60_000 }).toBe(true);

      // ── 5. The named worker delegates to B's codex, pi and qwen-code agents and reads each answer ──
      const answers: Record<string, unknown> = {};
      for (const [id, tag] of [['b-codex', 'cx1'], ['b-pi', 'pi1'], ['b-qwen', 'qw1']] as const) {
        const delegated = await named('delegate_task', { id, prompt: `ECHO ${tag}`, timeoutSeconds: 120 });
        const taskId = taskIdOf(delegated);
        const status = taskId ? await named('task_status', { taskId }) : undefined;
        answers[id] = { delegated, status };
        expect(delegated.isError).toBe(false);
        expect(delegated.text).toContain(`echo ${tag}`);
        expect(status?.isError).toBe(false);
        expect(status?.text).toContain(`echo ${tag}`);
      }
      const stillRefused = await other('delegate_task', { id: 'b-pi', prompt: 'ECHO never3', timeoutSeconds: 5 });
      keep({ answers, stillRefused });
      expect(stillRefused.isError).toBe(true);
      expect(stillRefused.text).toContain('cross_project_not_granted');
      // Tars's note to B's orchestrator, typed into its session, for each outside delegation.
      await expect.poll(() => (fakeLog().match(/Note for information from \\?"Tars\\?"[^\n]*A-Worker[^\n]*delegat/g) ?? []).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(3);

      // ── 6. A change to an agent mid-turn is queued, then applied once its turn ends ──
      const held = await named('delegate_task', { id: 'b-qwen', prompt: 'HOLD q1', timeoutSeconds: 3 });
      const heldTask = taskIdOf(held);
      expect(heldTask).toBeTruthy();
      await expect.poll(() => recordOf('b-qwen').status, { timeout: 30_000 }).toBe('running');
      const queued = await other('update_agent', { id: 'b-qwen', model: 'qwen3-coder-plus' });
      const queuedLog = await other('agent_changes', { agentId: 'b-qwen' });
      keep({ held, queued, queuedLog, whileQueued: recordOf('b-qwen') });
      expect(queued.isError).toBe(false);
      expect(queued.text).toMatch(/\bqueued\b/);
      expect(recordOf('b-qwen').model).toBeUndefined();
      const releasedAt = Date.now();
      fs.writeFileSync(path.join(home, 'release-q1'), '');
      await expect.poll(() => recordOf('b-qwen').model, { timeout: 60_000 }).toBe('qwen3-coder-plus');
      const appliedLog = await other('agent_changes', { agentId: 'b-qwen' });
      const heldStatus = await named('task_status', { taskId: heldTask });
      keep({ appliedLog, heldStatus });
      const qwenChanges = JSON.parse(appliedLog.text.slice(appliedLog.text.indexOf('['))) as Array<Record<string, unknown>>;
      const lastQwen = qwenChanges.find((c) => (c.after as Record<string, unknown>)?.model === 'qwen3-coder-plus')!;
      expect(lastQwen).toMatchObject({ state: 'applied', by: { id: 'a-x' } });
      expect(Date.parse(String(lastQwen.effectiveAt))).toBeGreaterThanOrEqual(releasedAt);
      expect(heldStatus.text).toContain('released q1');

      // ── 7. A batch over all of B, then reverted in one call ──
      const effortsBefore = Object.fromEntries(['b-o', 'b-c', 'b-codex', 'b-pi', 'b-qwen'].map((id) => [id, recordOf(id).effort ?? null]));
      const batch = await other('update_agent', { project: B, effort: 'low' });
      keep({ effortsBefore, batch });
      expect(batch.isError).toBe(false);
      const batchAnswer = JSON.parse(batch.text.slice(batch.text.indexOf('{'))) as { batchId: string; results: Array<{ id: string; state: string }> };
      expect(batchAnswer.results.map((r) => r.id).sort()).toEqual(['b-c', 'b-codex', 'b-o', 'b-pi', 'b-qwen']);
      for (const r of batchAnswer.results) expect(['applied', 'queued']).toContain(r.state);
      await expect.poll(() => ['b-o', 'b-c', 'b-codex', 'b-pi', 'b-qwen'].every((id) => recordOf(id).effort === 'low'), { timeout: 60_000 }).toBe(true);
      const reverted = await other('revert_agent_change', { batchId: batchAnswer.batchId });
      keep({ reverted });
      expect(reverted.isError).toBe(false);
      await expect.poll(() => Object.fromEntries(Object.keys(effortsBefore).map((id) => [id, recordOf(id).effort ?? null])), { timeout: 60_000 }).toEqual(effortsBefore);

      // ── 8. The change log ──
      const log = await lead('agent_changes', { project: B });
      keep({ log });
      const entries = JSON.parse(log.text.slice(log.text.indexOf('['))) as Array<Record<string, unknown>>;
      const first = entries.find((c) => c.agentId === 'b-c' && (c.after as Record<string, unknown>)?.model === 'gpt-5.5')!;
      expect(first).toMatchObject({ by: { id: 'a-x', name: 'A-Other', projectPath: A }, before: { provider: 'claude', model: 'sonnet', effort: 'medium' }, after: { provider: 'codex', model: 'gpt-5.5', effort: 'high' }, state: 'applied' });
      expect(Date.parse(String(first.askedAt))).toBeGreaterThan(0);
      expect(Date.parse(String(first.effectiveAt))).toBeGreaterThanOrEqual(Date.parse(String(first.askedAt)));
      expect(entries.filter((c) => c.batchId === batchAnswer.batchId)).toHaveLength(5);
      expect(entries.filter((c) => c.revertOf && entries.find((o) => o.id === c.revertOf)?.batchId === batchAnswer.batchId).length).toBeGreaterThan(0);
      const notices3 = await notices();
      keep({ notices: notices3 });
      expect(notices3.some((n) => n.agentId === 'b-qwen' && (n.by as Record<string, unknown>)?.id === 'a-x')).toBe(true);

      // ── 9. A worktree in B for one of its agents: made, used, left; B's main checkout untouched; its push refused loudly ──
      const branch = 'work/b-c-first';
      const notGranted = await other('worktree_new', { project: B, branch: 'work/b-c-refused' });
      const made = await named('worktree_new', { project: B, branch, noPush: true });
      keep({ notGranted, made, mainAfterNew: mainState() });
      expect(notGranted.isError).toBe(true);
      expect(notGranted.text).toContain('cross_project_not_granted');
      expect(made.isError).toBe(false);
      const wt = path.join(B, '.worktrees', ...branch.split('/'));
      expect(fs.existsSync(path.join(wt, 'README.md'))).toBe(true);
      expect(mainState()).toEqual(mainBefore);
      const moved = await named('update_agent', { id: 'b-c', worktree: branch });
      keep({ moved, movedRecord: recordOf('b-c'), mainAfterMove: mainState() });
      expect(moved.isError).toBe(false);
      expect(recordOf('b-c')).toMatchObject({ worktreePath: wt, branchName: branch });
      expect(mainState()).toEqual(mainBefore);
      // The push from the worktree fails, naming why; from the main checkout it still works.
      fs.writeFileSync(path.join(wt, 'work.txt'), 'the work\n');
      expect(git(wt, ['add', 'work.txt']).code).toBe(0);
      expect(git(wt, ['-c', 'user.email=e2e@tars.test', '-c', 'user.name=e2e', 'commit', '-q', '-m', 'the work']).code).toBe(0);
      const wtPush = git(wt, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
      const wtPushUrl = git(wt, ['push', remote, `HEAD:refs/heads/${branch}`]);
      const mainPush = git(B, ['push', 'origin', 'main:refs/heads/from-main']);
      keep({ wtPush, wtPushUrl, mainPush, mainAfterPush: mainState() });
      for (const refused of [wtPush, wtPushUrl]) {
        expect(refused.code).not.toBe(0);
        expect(refused.err).toContain('push-turned-off-by-tars');
      }
      expect(git(remote, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).code).not.toBe(0);
      expect(mainPush.code).toBe(0);
      expect(git(remote, ['rev-parse', '--verify', '-q', 'refs/heads/from-main']).code).toBe(0);
      expect(mainState()).toEqual(mainBefore);
      // Back to the project folder, then the worktree removed.
      const movedBack = await named('update_agent', { id: 'b-c', worktree: null });
      const removed = await named('worktree_remove', { project: B, branch });
      keep({ movedBack, removed, finalRecord: recordOf('b-c'), mainAfterRemove: mainState() });
      expect(movedBack.isError).toBe(false);
      expect(recordOf('b-c').worktreePath).toBeUndefined();
      expect(fs.existsSync(wt)).toBe(false);
      expect(mainState()).toEqual(mainBefore);

      // ── 10. A ready agent created in B in one call; a half-made one never; removed only without uncommitted work ──
      const readyBranch = 'work/b-ready';
      const createdByOther = await other('create_agent', { name: 'B-Ready', projectPath: B, provider: 'codex', model: 'gpt-5.5', effort: 'high', worktree: { branch: 'work/b-never' } });
      const created = await named('create_agent', { name: 'B-Ready', projectPath: B, provider: 'codex', model: 'gpt-5.5', effort: 'high', worktree: { branch: readyBranch, noPush: true } });
      keep({ createdByOther, created });
      expect(createdByOther.isError).toBe(true);
      expect(createdByOther.text).toContain('cross_project_not_granted');
      expect(created.isError).toBe(false);
      const readyId = /ID: ([0-9a-f-]{36})/.exec(created.text)?.[1];
      expect(readyId).toBeTruthy();
      const readyWt = path.join(B, '.worktrees', ...readyBranch.split('/'));
      expect(recordOf(readyId!)).toMatchObject({ projectPath: B, provider: 'codex', model: 'gpt-5.5', effort: 'high', worktreePath: readyWt, branchName: readyBranch, role: 'worker' });
      expect(fs.existsSync(path.join(readyWt, 'README.md'))).toBe(true);
      const readyPush = git(readyWt, ['push', 'origin', `HEAD:refs/heads/${readyBranch}`]);
      expect(readyPush.code).not.toBe(0);
      expect(readyPush.err).toContain('push-turned-off-by-tars');
      // On a branch another worktree holds, with a gate checkout of it already there and work in it (the Audit's M3 on
      // #595): refused, naming its holder, nothing made, and that checkout and its work left alone.
      const gate = await named('worktree_new', { project: B, branch: readyBranch, existing: true });
      const gatePath = /Worktree (.+?): /.exec(gate.text)?.[1];
      keep({ gate });
      expect(gate.isError).toBe(false);
      expect(gatePath).toBeTruthy();
      fs.writeFileSync(path.join(gatePath!, 'qa-notes.txt'), 'mid-gate\n');
      const agentsBefore = records().length;
      const worktreesBefore = git(B, ['worktree', 'list', '--porcelain']).out;
      const halfMade = await named('create_agent', { name: 'B-Twice', projectPath: B, provider: 'codex', worktree: { branch: readyBranch, noPush: true } });
      keep({ halfMade, worktreesAfterHalfMade: git(B, ['worktree', 'list', '--porcelain']).out });
      expect(halfMade.isError).toBe(true);
      expect(records().length).toBe(agentsBefore);
      expect(git(B, ['worktree', 'list', '--porcelain']).out).toBe(worktreesBefore);
      expect(halfMade.text).toContain('branch_held');
      expect(fs.readFileSync(path.join(gatePath!, 'qa-notes.txt'), 'utf8')).toBe('mid-gate\n');
      expect(mainState()).toEqual(mainBefore);
      // A setting beyond the inference ones, across projects: the named worker yes, the other no.
      const modeByNamed = await named('update_agent', { id: readyId, permissionMode: 'normal' });
      const modeByOther = await other('update_agent', { id: readyId, permissionMode: 'auto' });
      keep({ modeByNamed, modeByOther });
      expect(modeByNamed.isError).toBe(false);
      expect(recordOf(readyId!).permissionMode).toBe('normal');
      expect(modeByOther.isError).toBe(true);
      // Removal refused while its worktree holds uncommitted work, then done once it is committed.
      fs.writeFileSync(path.join(readyWt, 'draft.txt'), 'not committed\n');
      const refusedRemoval = await named('remove_agent', { id: readyId });
      keep({ refusedRemoval });
      expect(refusedRemoval.isError).toBe(true);
      expect(refusedRemoval.text).toContain('draft.txt');
      expect(recordOf(readyId!).id).toBe(readyId);
      expect(fs.existsSync(path.join(readyWt, 'draft.txt'))).toBe(true);
      expect(git(readyWt, ['add', 'draft.txt']).code).toBe(0);
      expect(git(readyWt, ['-c', 'user.email=e2e@tars.test', '-c', 'user.name=e2e', 'commit', '-q', '-m', 'the draft']).code).toBe(0);
      const removedAgent = await named('remove_agent', { id: readyId });
      keep({ removedAgent, mainAtEnd: mainState() });
      expect(removedAgent.isError).toBe(false);
      expect(records().some((a) => a.id === readyId)).toBe(false);
      expect(fs.existsSync(readyWt)).toBe(false);
      expect(mainState()).toEqual(mainBefore);

      // ── 11. The window undoes an agent's last retune ──
      const piModelBefore = recordOf('b-pi').model ?? null;
      const piRetuned = await other('update_agent', { id: 'b-pi', model: 'pi-model-x' });
      await expect.poll(() => recordOf('b-pi').model, { timeout: 60_000 }).toBe('pi-model-x');
      const undone = await page.evaluate(() => (window as unknown as { electronAPI: { agent: { revertChange: (s: unknown) => Promise<Record<string, unknown>> } } }).electronAPI.agent.revertChange({ agentId: 'b-pi' }));
      keep({ piRetuned, undone });
      expect(undone).toMatchObject({ ok: true });
      await expect.poll(() => recordOf('b-pi').model ?? null, { timeout: 60_000 }).toBe(piModelBefore);
      const undoLog = await lead('agent_changes', { agentId: 'b-pi', limit: 1 });
      expect(JSON.parse(undoLog.text.slice(undoLog.text.indexOf('[')))[0]).toMatchObject({ by: { kind: 'window' }, after: { model: piModelBefore } });
    } finally {
      for (const server of servers) server.kill();
      await app.close().catch(() => {});
    }
  });
}
