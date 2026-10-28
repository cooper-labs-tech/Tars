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
 * Three agents of one project, each a stand-in for claude with the state mod, asking Tars the way the mod's
 * tool.check does (POST /api/hooks/permission with its own token, again while Tars answers `pending`; a file tool by
 * its path alone, `withheld`), writing each answer and every line typed into its terminal to a file: the worker w in
 * bypass, the worker n in the default mode, and the orchestrator o, which sends w a message when the spec says so.
 * Tars allows nothing by itself (the orchestrator's decision of 28/10, after the Audit's third gate of #538).
 *
 * Asserted:
 * 1. w's shell command, the night's own heredoc into its own scratchpad, is held for the owner: the window reads it
 *    whole, and the owner allows it from the window;
 * 2. w's Write into that scratchpad is held by its path, withheld: the window's allow is refused, Tars allows nothing;
 * 3. o's message to w meanwhile is not refused: it is held (`held`, the dialog's reason), and nothing is typed into
 *    w's terminal while the question stands;
 * 4. nobody answers: at the owner's delay (permissionAskMinutes, 1 here) the Write is refused with a reason w reads,
 *    never handed back to the dialog; w runs again;
 * 5. then, and only then, o's message goes into w's terminal;
 * 6. n, not in bypass, has its Write on Claude Code's own dialog at once, as before #538: one step.
 * 7. (the Audit's M1 on #538 at ff0e3f2d) w's Bash with a timeout and a heredoc past 2,000 characters, which the mod
 *    cannot show whole, arrives withheld with the fields it shows and why: held with `withheldWhy`, its timeout in
 *    the window's line, the window's allow refused, and refused at the delay with the why; never left at the dialog.
 * Red on main dc623b594: the message is refused (409), the expired question goes back to the dialog, and n's Write
 * waits in Tars for the window.
 * The artefact: values.json (each answer, the message's reply, the lines w's terminal got, with their times),
 * screenshots, the app's trace with E2E_TRACE=on.
 */

/** What the mod says of a heredoc past 2,000 characters (mods/tars-state/hooks/register.ts). */
const LONG_WHY = 'command: 3,014 characters, past the 2,000 the window shows';

type Answer = { call: string; decision: string; reason?: string; at: number };
type Typed = { at: number; text: string };
type Agent = { id: string; status: string; waitingReason?: string; permissionAsk?: { subject: string; until: string; withheld?: true; withheldWhy?: string } };
type Api = { electronAPI: { agent: {
  start(p: { id: string; prompt: string }): Promise<unknown>;
  list(): Promise<Agent[]>;
  answerPermission(id: string, decision: 'allow' | 'deny' | 'ask', reason?: string): Promise<{ success: boolean }>;
} } };

const MARK = 'MARK-REPORT-FROM-O';

function worker(home: string, name: string, calls: string): string {
  return writeNodeCli(path.join(home, `cli-${name}.cjs`), [
    "const fs = require('fs'); const path = require('path'); const crypto = require('crypto');",
    "if (process.argv.includes('--version')) { console.log('2.1.312 (Claude Code)'); process.exit(0); }",
    "const session = crypto.randomUUID();",
    `const dir = ${JSON.stringify(home)};`,
    "const log = (file, entry) => fs.appendFileSync(path.join(dir, file), JSON.stringify({ at: Date.now(), ...entry }) + '\\n');",
    `process.stdin.on('data', d => log('typed-${name}.jsonl', { text: String(d) }));`,
    "const post = (route, body) => fetch(process.env.CLAUDE_MGR_API_URL + route, { method: 'POST',",
    "  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN },",
    "  body: JSON.stringify({ agent_id: process.env.CLAUDE_AGENT_ID, session_id: session, ...body }) }).then(r => r.json());",
    "const heredoc = s => `S=${s}; mkdir -p $S/retry-probe && cat > $S/retry-probe/p.yml <<'EOF'\\nsteps:\\n  - run: echo $(whoami)\\nEOF`;",
    "const scratch = path.join(process.env.CLAUDE_CODE_TMPDIR, 'scratchpad');",
    `const calls = ${calls};`,
    "(async () => {",
    "  process.stdout.write('stand-in ready\\r\\n');",
    "  await post('/api/hooks/status', { status: 'idle', source: 'startup' });",
    "  await post('/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: 'probe the retry config' });",
    "  for (const c of calls) {",
    "    while (c.after && !fs.existsSync(path.join(dir, c.after))) await new Promise(r => setTimeout(r, 200));",
    "    let answer;",
    "    do answer = await post('/api/hooks/permission', { tool: c.tool, tool_use_id: c.tool_use_id, input: c.input,",
    "      reason: 'This call requires approval', via: 'mod', ...(c.withheld ? { withheld: true } : {}), ...(c.why ? { withheld_why: c.why } : {}) });",
    "    while (answer.decision === 'pending');",
    `    log('answers-${name}.jsonl', { call: c.tool_use_id, decision: answer.decision, reason: answer.reason });`,
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
  test(`Tars allows nothing itself: the owner allows a shell command, a bypass agent's Write is held and refused at the delay, another agent's goes to its dialog, and a message waits out the question${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(360_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-permission-dialogs-${newInterface ? 'ni' : 'classic'}-`));
    const project = path.join(home, 'projects', 'parallel');
    fs.mkdirSync(project, { recursive: true });
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    const base = { character: 'robot', provider: 'claude', status: 'idle', projectPath: project, skills: [], createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z' };
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      { ...base, id: 'w', name: 'Cloud Architect', role: 'worker', permissionMode: 'bypass', cliPath: worker(home, 'w', "[{ tool_use_id: 'toolu_shell', tool: 'Bash', input: { command: heredoc(scratch) } }, { tool_use_id: 'toolu_file', tool: 'Write', input: { file_path: path.join(scratch, 'retry-probe', 'p.yml') }, withheld: true }, { tool_use_id: 'toolu_long', tool: 'Bash', input: { description: 'write the notes', timeout: '600000' }, withheld: true, why: " + JSON.stringify(LONG_WHY) + ", after: 'long-now' }]") },
      { ...base, id: 'n', name: 'Docs Writer', role: 'worker', permissionMode: 'normal', cliPath: worker(home, 'n', "[{ tool_use_id: 'toolu_n', tool: 'Write', input: { file_path: path.join(scratch, 'n.md') }, withheld: true }]") },
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

      const answer = (decision: 'allow' | 'deny' | 'ask') => page.evaluate(d => (window as unknown as Api).electronAPI.agent.answerPermission('w', d), decision);

      // 1. The shell command: held for the owner, whole, and the owner allows it from the window.
      await expect.poll(async () => (await w())?.permissionAsk?.subject ?? '', { timeout: 30_000 }).toContain('retry-probe/p.yml <<');
      const shell = await w();
      keep({ shell });
      expect.soft([shell?.status, shell?.waitingReason]).toEqual(['waiting', 'permission']);
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });
      await stepShot(page, newInterface ? 'permission-held-new-interface' : 'permission-held');
      expect(await answer('allow')).toEqual({ success: true });
      await expect.poll(() => answers().length, { timeout: 15_000 }).toBe(1);
      expect(answers()[0]).toMatchObject({ call: 'toolu_shell', decision: 'allow' });

      // 2. The Write: held by its path, withheld; the window cannot allow it.
      await expect.poll(async () => (await w())?.permissionAsk?.withheld ?? false, { timeout: 15_000 }).toBe(true);
      const file = await w();
      keep({ file });
      expect(file?.permissionAsk?.subject).toMatch(/^Write .*retry-probe\/p\.yml$/);
      expect(await answer('allow'), 'the window allowed content it never showed').toEqual({ success: false });

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
      expect(late).toMatchObject({ call: 'toolu_file', decision: 'deny' });
      expect.soft(late.reason).toMatch(/^Nobody answered this permission question in Tars within 1 minute, so Tars refused it/);
      expect.soft(late.reason).toMatch(/never allows a file tool by itself/);
      await expect.poll(async () => (await w())?.permissionAsk ?? null, { timeout: 10_000 }).toBeNull();

      // 5. Then the message goes in.
      await expect.poll(() => typed().filter(t => t.text.includes(MARK)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      const mark = typed().find(t => t.text.includes(MARK))!;
      keep({ typed: typed(), markAfterRefusalMs: mark.at - late.at });
      expect(mark.at).toBeGreaterThanOrEqual(late.at);
      await stepShot(page, newInterface ? 'permission-refused-new-interface' : 'permission-refused');

      // 6. n, not in bypass: its Write on Claude Code's own dialog at once.
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'n', prompt: '' }));
      await expect.poll(() => lines<Answer>(path.join(home, 'answers-n.jsonl')).length, { timeout: 30_000 }).toBe(1);
      const n = lines<Answer>(path.join(home, 'answers-n.jsonl'))[0];
      keep({ n });
      expect(n).toMatchObject({ call: 'toolu_n', decision: 'ask' });
      expect(n.at - late.at, 'n was not held').toBeLessThan(60_000);

      // 7. w's long heredoc, withheld: held deny-only with why, its timeout in the line, refused at the delay.
      fs.writeFileSync(path.join(home, 'long-now'), '1');
      await expect.poll(async () => (await w())?.permissionAsk?.withheldWhy ?? '', { timeout: 15_000 }).toBe(LONG_WHY);
      const long = await w();
      keep({ long });
      expect.soft(long?.permissionAsk?.subject).toBe('Bash (timeout 600000 ms)');
      await stepShot(page, newInterface ? 'permission-withheld-new-interface' : 'permission-withheld');
      expect(await answer('allow'), 'the window allowed a command it never showed whole').toEqual({ success: false });
      await expect.poll(() => answers().length, { timeout: 90_000 }).toBe(3);
      const longLate = answers()[2];
      keep({ longLate });
      expect(longLate).toMatchObject({ call: 'toolu_long', decision: 'deny' });
      expect.soft(longLate.reason).toMatch(/^Nobody answered this permission question in Tars within 1 minute/);
      expect.soft(longLate.reason).toContain(LONG_WHY);
    } finally {
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
