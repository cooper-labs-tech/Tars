import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * No agent left frozen on a permission dialog all night (2.0.5, brief fix-permission-dialogs-2810.md, the owner's
 * decision of 28/10), in the real app, once with the classic shell and once with the new interface.
 *
 * The night of 27/10: agents in bypass stopped until morning on Claude Code's dialog, each on a heredoc into its own
 * scratchpad; a worker's report to an orchestrator at a dialog was refused (1212 counted 17); an ask that expired
 * left the native dialog open.
 *
 * Two agents of one project, each a stand-in for claude with the state mod: the worker w, in bypass, asks Tars about
 * two calls the way the mod's tool.check does (POST /api/hooks/permission with its own token, again while Tars
 * answers `pending`; a file tool by its path alone, `withheld`), and writes each answer, and every line typed into
 * its terminal, to a file. The orchestrator o sends w a message (POST /api/agents/w/message with its own token) when
 * the spec says so.
 *
 * Asserted:
 * 1. w's Write into its own scratchpad ($CLAUDE_CODE_TMPDIR) is allowed by Tars at once, without a question;
 * 2. a shell command, the night's own heredoc into that same scratchpad, is held for the owner (Tars never answers a
 *    shell command, the orchestrator's decision of 28/10 after the Audit's re-check): the window reads it, w waits;
 * 3. o's message to w meanwhile is not refused: it is held (`held`, the dialog's reason), and nothing is typed into
 *    w's terminal while the question stands;
 * 4. nobody answers: at the owner's delay (permissionAskMinutes, 1 here) the call is refused with a reason w reads,
 *    which tells it to write files with the Write tool, never handed back to the dialog; w runs again;
 * 5. then, and only then, o's message goes into w's terminal.
 * Red on main dc623b594: the first call waits for the window, the message is refused (409), and the expired question
 * goes back to the dialog.
 * The artefact: values.json (each answer, the message's reply, the lines w's terminal got, with their times),
 * screenshots, the app's trace with E2E_TRACE=on.
 */

type Answer = { call: string; decision: string; reason?: string; at: number };
type Typed = { at: number; text: string };
type Agent = { id: string; status: string; waitingReason?: string; permissionAsk?: { subject: string; until: string } };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]> } } };

const MARK = 'MARK-REPORT-FROM-O';

function worker(home: string): string {
  return writeNodeCli(path.join(home, 'cli-w.cjs'), [
    "const fs = require('fs'); const path = require('path'); const crypto = require('crypto');",
    "if (process.argv.includes('--version')) { console.log('2.1.312 (Claude Code)'); process.exit(0); }",
    "const session = crypto.randomUUID();",
    `const dir = ${JSON.stringify(home)};`,
    "const log = (file, entry) => fs.appendFileSync(path.join(dir, file), JSON.stringify({ at: Date.now(), ...entry }) + '\\n');",
    "process.stdin.on('data', d => log('typed-w.jsonl', { text: String(d) }));",
    "const post = (route, body) => fetch(process.env.CLAUDE_MGR_API_URL + route, { method: 'POST',",
    "  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN },",
    "  body: JSON.stringify({ agent_id: process.env.CLAUDE_AGENT_ID, session_id: session, ...body }) }).then(r => r.json());",
    "const heredoc = s => `S=${s}; mkdir -p $S/retry-probe && cat > $S/retry-probe/p.yml <<'EOF'\\nsteps:\\n  - run: echo $(whoami)\\nEOF`;",
    "const scratch = path.join(process.env.CLAUDE_CODE_TMPDIR, 'scratchpad');",
    "const calls = [",
    "  { tool_use_id: 'toolu_own', tool: 'Write', input: { file_path: path.join(scratch, 'retry-probe', 'p.yml') }, withheld: true },",
    "  { tool_use_id: 'toolu_out', tool: 'Bash', input: { command: heredoc(scratch) } },",
    "];",
    "(async () => {",
    "  process.stdout.write('stand-in ready\\r\\n');",
    "  await post('/api/hooks/status', { status: 'idle', source: 'startup' });",
    "  await post('/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: 'probe the retry config' });",
    "  for (const c of calls) {",
    "    let answer;",
    "    do answer = await post('/api/hooks/permission', { tool: c.tool, tool_use_id: c.tool_use_id, input: c.input,",
    "      reason: 'This call requires approval', via: 'mod', ...(c.withheld ? { withheld: true } : {}) });",
    "    while (answer.decision === 'pending');",
    "    log('answers-w.jsonl', { call: c.tool_use_id, decision: answer.decision, reason: answer.reason });",
    "    process.stdout.write('* ' + c.tool + ': ' + answer.decision + '\\r\\n');",
    "    if (answer.decision === 'ask') process.stdout.write('Do you want to proceed?\\r\\n');",
    "  }",
    "})();",
    '',
  ].join('\n'));
}

function orchestrator(home: string): string {
  return writeNodeCli(path.join(home, 'cli-o.cjs'), [
    "const fs = require('fs'); const path = require('path');",
    "if (process.argv.includes('--version')) { console.log('2.1.312 (Claude Code)'); process.exit(0); }",
    `const dir = ${JSON.stringify(home)};`,
    "process.stdout.write('stand-in ready\\r\\n');",
    "const wait = setInterval(async () => {",
    "  if (!fs.existsSync(path.join(dir, 'send-now'))) return;",
    "  clearInterval(wait);",
    "  const r = await fetch(process.env.CLAUDE_MGR_API_URL + '/api/agents/w/message', { method: 'POST',",
    "    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN, 'X-Tars-Caller-Id': process.env.CLAUDE_AGENT_ID },",
    `    body: JSON.stringify({ message: ${JSON.stringify(MARK)} }) });`,
    "  fs.writeFileSync(path.join(dir, 'message-reply.json'), JSON.stringify({ status: r.status, body: await r.json() }));",
    "}, 200);",
    "process.stdin.resume();",
    '',
  ].join('\n'));
}

const lines = <T>(file: string): T[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as T) : []);

for (const newInterface of [false, true]) {
  test(`a bypass agent's own-folder call is answered by Tars, the rest refused at the delay, and a message waits out the dialog${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-permission-dialogs-${newInterface ? 'ni' : 'classic'}-`));
    const project = path.join(home, 'projects', 'parallel');
    fs.mkdirSync(project, { recursive: true });
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    const base = { character: 'robot', provider: 'claude', status: 'idle', projectPath: project, skills: [], createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z' };
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      { ...base, id: 'w', name: 'Cloud Architect', role: 'worker', permissionMode: 'bypass', cliPath: worker(home) },
      { ...base, id: 'o', name: 'Parallel Lead', role: 'orchestrator', cliPath: orchestrator(home) },
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface, permissionAskMinutes: 1,
    }));
    const answers = () => lines<Answer>(path.join(home, 'answers-w.jsonl'));
    const typed = () => lines<Typed>(path.join(home, 'typed-w.jsonl'));
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31356 : 31355), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
      const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
      const w = async () => (await list()).find(a => a.id === 'w');
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'o', prompt: '' }));
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'w', prompt: '' }));

      // 1. Its own scratchpad: allowed by Tars, at once.
      await expect.poll(() => answers().length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      const own = answers()[0];
      keep({ own });
      expect(own).toMatchObject({ call: 'toolu_own', decision: 'allow' });
      expect.soft(own.reason).toMatch(/^Tars allowed it: Cloud Architect is in bypass, and .*scratchpad.*p\.yml is inside its own folders/);

      // 2. A shell command, even into its own scratchpad: held for the owner, and the window reads it.
      await expect.poll(async () => (await w())?.permissionAsk?.subject ?? '', { timeout: 15_000 }).toContain('retry-probe/p.yml <<');
      const held = await w();
      keep({ held });
      expect.soft([held?.status, held?.waitingReason]).toEqual(['waiting', 'permission']);
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await stepShot(page, newInterface ? 'permission-held-new-interface' : 'permission-held');

      // 3. o's message meanwhile: held, not refused, and not typed while the question stands.
      fs.writeFileSync(path.join(home, 'send-now'), '1');
      await expect.poll(() => fs.existsSync(path.join(home, 'message-reply.json')), { timeout: 15_000 }).toBe(true);
      const reply = JSON.parse(fs.readFileSync(path.join(home, 'message-reply.json'), 'utf8')) as { status: number; body: Record<string, unknown> };
      keep({ reply });
      expect(reply.status).toBe(200);
      expect.soft(reply.body).toMatchObject({ success: true, held: true, heldReason: expect.stringMatching(/shows a dialog/) });
      await page.waitForTimeout(3_000);
      expect(typed().filter(t => t.text.includes(MARK)), 'typed while the question stood').toEqual([]);

      // 4. Nobody answers: refused at the delay, with a reason w reads; never back to the dialog.
      await expect.poll(() => answers().length, { timeout: 90_000 }).toBe(2);
      const late = answers()[1];
      keep({ late });
      expect(late).toMatchObject({ call: 'toolu_out', decision: 'deny' });
      expect.soft(late.reason).toMatch(/^Nobody answered this permission question in Tars within 1 minute, so Tars refused it/);
      expect.soft(late.reason).toMatch(/Write tool/);
      await expect.poll(async () => (await w())?.permissionAsk ?? null, { timeout: 10_000 }).toBeNull();

      // 5. Then the message goes in.
      await expect.poll(() => typed().filter(t => t.text.includes(MARK)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      const mark = typed().find(t => t.text.includes(MARK))!;
      keep({ typed: typed(), markAfterRefusalMs: mark.at - late.at });
      expect(mark.at).toBeGreaterThanOrEqual(late.at);
      await stepShot(page, newInterface ? 'permission-refused-new-interface' : 'permission-refused');
    } finally {
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
