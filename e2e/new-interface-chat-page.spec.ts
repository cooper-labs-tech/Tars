import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A chat's page in the new shell, read from its runner's transcripts and
 * followed live (#371's chat:history and chat:events).
 * Frames: `Chat · chats · from its transcripts, working` and `· waiting on
 * you` in chat-redesign-a.pen.
 *
 * A project whose orchestrator, Lead, is chat #1 Main, its session written
 * where Claude Code files it: your words, Lead's with a delegation, a
 * compaction, Worker's message and Tars's note. Lead runs a stand-in that
 * registers that session through the hooks, then, when told, works (and its
 * transcript gains a line), then asks a permission and records the answer.
 *
 * The person opens the chats: Main's page shows each line as what it is, the
 * last 200 of 206. Lead starts and works: the line at the end says so, and
 * the line its transcript gained arrives in the thread, in view. Lead asks to
 * run a command: the ask sits above the composer, the head says since when;
 * allow answers it. The composer is open, send waiting for words
 * (e2e/new-interface-chat-send.spec.ts sends from it). The panel says when
 * what the chat delegates shows there.
 * Then Show earlier reads the six lines before, the first line held staying
 * where it was (after the shots of the end of the thread, which the thread
 * follows).
 *
 * Last, Lead starts a new session, as /clear does: Main mirrors it, and its
 * lines arrive after a new session divider. The first session's transcript
 * disappears, as Claude Code's cleanup removes an old one: #371 names its
 * lines in one removed event, and they leave the thread, the line saying the
 * transcript is gone in their place.
 *
 * The artefact: a screenshot per state, values.json, and the stand-in's
 * answers beside them.
 */

const SPLASH = 'div.fixed.inset-0.z-\\[200\\]';
const S1 = 'e2e00000-0000-4000-8000-00000000d001';
type Api = { electronAPI: { agent: { start: (o: { id: string; prompt: string }) => Promise<unknown> } } };

let n = 0;
const at = () => new Date(Date.UTC(2026, 9, 13, 9, 0, n)).toISOString();
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const user = (text: string) => ({ type: 'user', uuid: uuid(), timestamp: at(), sessionId: S1, version: '2.1.296', message: { role: 'user', content: text } });
const said = (content: unknown[]) => ({ type: 'assistant', uuid: uuid(), timestamp: at(), sessionId: S1, version: '2.1.296', message: { role: 'assistant', content } });
const jsonl = (lines: unknown[]) => lines.map(l => JSON.stringify(l)).join('\n') + '\n';

test('a chat\'s page reads its conversation from the transcripts, follows it live, shows the runner working and its ask, and keeps the send for later', async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-chat-page-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  // The folder Claude Code names, every character but a letter or a digit as
  // `-`: macOS's own temp folder holds a `_`, which the older name kept.
  const transcripts = path.join(home, '.claude', 'projects', fs.realpathSync(project).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(transcripts, { recursive: true });
  const transcript = path.join(transcripts, `${S1}.jsonl`);
  // A hundred exchanges before it: 206 lines, of which the page opens on the last 200.
  const before = Array.from({ length: 100 }, (_, i) => [user(`Earlier question ${i + 1}`), said([{ type: 'text', text: `Earlier answer ${i + 1}` }])]).flat();
  fs.writeFileSync(transcript, jsonl([
    ...before,
    user('The terminal jumps to the bottom when an agent writes while I scroll up. Fix it.'),
    said([{ type: 'text', text: 'Worker takes the fix; I check it after.' }, { type: 'tool_use', id: 't1', name: 'mcp__claude-mgr-orchestrator__delegate_task', input: { id: 'w1', prompt: 'fix the scroll lock' } }]),
    { type: 'user', uuid: uuid(), sessionId: S1, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'NOT SHOWN' }] }, toolUseResult: {} },
    { type: 'system', subtype: 'compact_boundary', uuid: uuid(), timestamp: at(), sessionId: S1, content: 'Conversation compacted' },
    user('Message from agent "Worker" ("w1"): Done: the view keeps its place while output arrives.'),
    user('Message from Tars: [Tars] "Worker" ("w1") has finished its turn'),
  ]));
  const live = said([{ type: 'text', text: 'Reading the scroll hook now.' }]);

  const signal = (name: string) => fs.writeFileSync(path.join(home, name), '1');
  const answersFile = path.join(home, 'answers.jsonl');
  const standIn = path.join(home, 'lead-stand-in.cjs');
  fs.writeFileSync(standIn, [
    `#!${process.execPath}`,
    "const fs = require('fs'); const path = require('path');",
    "if (process.argv.includes('--version')) { console.log('2.1.296 (Claude Code)'); process.exit(0); }",
    `const S = ${JSON.stringify(S1)}; const HOME = ${JSON.stringify(home)};`,
    `const T = ${JSON.stringify(transcript)}; const LIVE = ${JSON.stringify(JSON.stringify(live))};`,
    "const post = (route, body) => fetch(process.env.CLAUDE_MGR_API_URL + route, {",
    "  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN },",
    "  body: JSON.stringify({ agent_id: process.env.CLAUDE_AGENT_ID, session_id: S, ...body }),",
    "}).then(r => r.json());",
    "const pause = ms => new Promise(r => setTimeout(r, ms));",
    "const until = async name => { while (!fs.existsSync(path.join(HOME, name))) await pause(200); };",
    "(async () => {",
    "  process.stdout.write('stand-in ready\\r\\n');",
    "  await post('/api/hooks/status', { status: 'idle', source: 'startup' });",
    "  fs.writeFileSync(path.join(HOME, 'registered'), '1');",
    "  await until('go-working');",
    "  await post('/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: 'Fix the scroll lock' });",
    "  fs.appendFileSync(T, LIVE + '\\n');",
    "  await until('go-ask');",
    "  let answer;",
    "  do { answer = await post('/api/hooks/permission', { tool: 'Bash', input: { command: 'gh pr create --fill', description: 'Open the PR' }, tool_use_id: 'toolu_1' }); if (answer.decision === 'pending') await pause(300); }",
    "  while (answer.decision === 'pending');",
    `  fs.appendFileSync(${JSON.stringify(answersFile)}, JSON.stringify(answer) + '\\n');`,
    "})();",
    "process.stdin.resume();",
    '',
  ].join('\n'), { mode: 0o755 });

  const agent = (o: Record<string, unknown>) => ({
    character: 'robot', provider: 'claude', status: 'idle', skills: [], projectPath: project,
    createdAt: '2026-10-13T08:00:00.000Z', lastActivity: '2026-10-13T08:00:00.000Z', ...o,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent({ id: 'lead', name: 'Lead', role: 'orchestrator', orchestratorMode: true, resumableSessionId: S1, cliPath: standIn }),
    agent({ id: 'w1', name: 'Worker', role: 'worker', cliPath: standIn }),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31449), DOROTHY_E2E: '1' },
  });
  const pageErrors: string[] = [];
  const seen: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/chats`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator(SPLASH)).toHaveCount(0, { timeout: 30_000 });
    const main = page.getByRole('main');
    const thread = main.getByRole('log', { name: 'Conversation' });
    const row = (kind: string) => thread.locator(`[data-chat-item][data-kind="${kind}"]`);

    // Each line as what it is.
    await expect(row('user').filter({ hasText: 'The terminal jumps to the bottom' })).toHaveCount(1, { timeout: 90_000 });
    await expect(row('text').filter({ hasText: 'Worker takes the fix' })).toHaveCount(1);
    await expect(row('tool').filter({ hasText: 'delegate_task -> Worker' })).toHaveCount(1);
    await expect(row('divider').filter({ hasText: 'compacted' })).toHaveCount(1);
    await expect(row('message').filter({ hasText: 'Done: the view keeps its place' })).toHaveCount(1);
    await expect(row('note').filter({ hasText: 'has finished its turn' })).toHaveCount(1);
    await expect(thread.getByText('NOT SHOWN')).toHaveCount(0);
    const kinds = await thread.locator('[data-chat-item]').evaluateAll(els => els.map(e => e.getAttribute('data-kind')));
    seen.opened = { lines: kinds.length, lastKinds: kinds.slice(-6) };
    expect(kinds.length).toBe(200);
    seen.speakers = (await thread.locator('[data-chat-speaker]').allInnerTexts()).slice(-5);
    await stepShot(page, '01-history');

    // The composer is open, send waiting for words; the panel says when it fills.
    const composer = main.getByRole('group', { name: 'Message composer' });
    await expect(composer.getByRole('textbox', { name: 'Message' })).toBeEnabled();
    await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(main.getByText('What this chat delegates shows here once a task names the chat it came from.')).toBeVisible();

    // Lead starts, registers its session, then works: the line at the end, and the line its transcript gains.
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'lead', prompt: '' }));
    await expect.poll(() => fs.existsSync(path.join(home, 'registered')), { timeout: 60_000, message: 'the stand-in registered its session' }).toBe(true);
    signal('go-working');
    await expect(thread.getByText('The orchestrator is working')).toBeVisible({ timeout: 60_000 });
    const live = row('text').filter({ hasText: 'Reading the scroll hook now.' });
    await expect(live).toHaveCount(1, { timeout: 60_000 });
    // At the end of the thread, the thread follows what arrives.
    await expect(live).toBeInViewport();
    seen.liveArrived = true;
    await stepShot(page, '02-working-live');

    // Lead asks to run a command: the ask sits above the composer, and allow answers it.
    signal('go-ask');
    const ask = main.locator('[data-permission-ask="lead"]');
    await expect(ask).toBeVisible({ timeout: 60_000 });
    await expect(ask).toContainText('gh pr create --fill');
    seen.ask = (await ask.innerText()).replace(/\s+/g, ' ').trim();
    // The head says since when, at the time the ask says it was asked.
    const asked = /asked at (\d{2}:\d{2})/.exec(seen.ask as string)?.[1];
    await expect(main.getByText(`waiting on you since ${asked}`)).toBeVisible();
    await stepShot(page, '03-waiting-on-you');
    await ask.getByRole('button', { name: 'allow', exact: true }).click();
    await expect.poll(() => (fs.existsSync(answersFile) ? fs.readFileSync(answersFile, 'utf8') : ''), { timeout: 30_000 }).toContain('"allow"');
    seen.answer = JSON.parse(fs.readFileSync(answersFile, 'utf8').trim().split('\n').pop()!);
    await expect(ask).toHaveCount(0, { timeout: 30_000 });
    await stepShot(page, '04-answered');

    // The six lines before the first 200: Show earlier reads them, the count said how many, and the
    // line that was first stays where it was.
    const earlier = thread.getByRole('button', { name: 'Show earlier', exact: true });
    const first = row('user').filter({ hasText: /^Earlier question 4$/ });
    await expect(thread.getByText('6 earlier lines', { exact: true })).toBeVisible();
    await expect(row('user').filter({ hasText: /^Earlier question 1$/ })).toHaveCount(0);
    await earlier.scrollIntoViewIfNeeded();
    const firstWas = (await first.boundingBox())!.y;
    await earlier.click();
    await expect(row('user').filter({ hasText: /^Earlier question 1$/ })).toHaveCount(1);
    await expect(earlier).toHaveCount(0);
    seen.afterEarlier = await thread.locator('[data-chat-item]').count();
    expect(seen.afterEarlier).toBe(207);
    seen.firstMoved = (await first.boundingBox())!.y - firstWas;
    expect(Math.abs(seen.firstMoved as number), 'the line that was first moved').toBeLessThan(4);
    await stepShot(page, '05-earlier');

    // Lead starts a new session, as /clear does, registered as hooks-routes would: Main mirrors it,
    // and its lines arrive after a new session divider.
    const S2 = 'e2e00000-0000-4000-8000-00000000d002';
    fs.writeFileSync(path.join(transcripts, `${S2}.jsonl`), jsonl([
      { ...user('Now the docs, in a new session.'), sessionId: S2 },
      { ...said([{ type: 'text', text: 'Starting on the docs.' }]), sessionId: S2 },
    ]));
    const dist = path.resolve('electron', 'dist');
    await app.evaluate((_e, { dist, S2 }) => {
      const req = process.mainModule!.require;
      const lead = req(`${dist}/core/agent-manager.js`).agents.get('lead');
      lead.currentSessionId = S2;
      lead.resumableSessionId = S2;
      req(`${dist}/services/agent-events.js`).agentStatusEmitter.emit('fleet-change', 'lead');
    }, { dist, S2 });
    await expect(row('user').filter({ hasText: 'Now the docs, in a new session.' })).toHaveCount(1, { timeout: 30_000 });
    await expect(row('divider').filter({ hasText: 'new session' })).toHaveCount(1);

    // The first session's transcript disappears: its lines leave the thread, the line saying so in their place.
    fs.rmSync(transcript);
    await expect(row('raw').filter({ hasText: 'its transcript is gone' })).toHaveCount(1, { timeout: 30_000 });
    await expect(row('user').filter({ hasText: /^Earlier question/ })).toHaveCount(0, { timeout: 15_000 });
    seen.afterRemoval = await thread.locator('[data-chat-item]').evaluateAll(els => els.map(e => `${e.getAttribute('data-kind')} ${(e.textContent ?? '').trim().slice(0, 60)}`));
    expect((seen.afterRemoval as string[]).map(s => s.split(' ')[0])).toEqual(['raw', 'divider', 'user', 'text']);
    await stepShot(page, '06-older-session-gone');

    recordValues(seen);
    expect(pageErrors, 'no uncaught page error').toEqual([]);
  } finally {
    await app.close().catch(() => {});
    if (fs.existsSync(answersFile)) fs.copyFileSync(answersFile, test.info().outputPath('stand-in-answers.jsonl'));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
