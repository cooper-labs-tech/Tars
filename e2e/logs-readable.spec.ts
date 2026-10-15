import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { launchSandboxed, recordValues, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The Logs page reads an agent's output as its terminal showed it.
 *
 * JeanBrasse, 2026-10-01: the page showed every text glued together, unreadable.
 * It split the raw stream on line breaks with the escape codes stripped, and
 * Claude Code draws with cursor moves: "List the three files in this folder"
 * read "Listthethreefilesinthisfolder", and a retry countdown left its digits
 * on the line. The agent here has the real stream of a Claude Code 2.1.286
 * session as its kept output (__tests__/fixtures/terminal-streams), and is not
 * running, so the page reads it through a headless replay.
 *
 * The artefact: a screenshot of the tail and one of the search, and the lines
 * the page showed, in values.json.
 */

function inlineSession(name = 'claude-inline-session.jsonl.gz'): string[] {
  const file = path.resolve('__tests__/fixtures/terminal-streams', name);
  const lines = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  lines.shift();
  const decoder = new TextDecoder('utf-8');
  return lines.filter((l: { o?: string }) => l.o !== undefined)
    .map((l: { o: string }) => decoder.decode(Buffer.from(l.o, 'base64'), { stream: true }));
}

test('the Logs page reads a Claude Code session as its terminal showed it', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-logs-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'l1', name: 'Session Reader', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], output: inlineSession(),
    createdAt: '2026-10-01T08:00:00.000Z', lastActivity: '2026-10-01T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31475), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/logs`, { waitUntil: 'domcontentloaded' });

    await page.getByRole('button', { name: /Session Reader/ }).click();
    const tail = page.locator('pre').filter({ hasText: 'Claude Code' });
    await expect(tail).toBeVisible({ timeout: 30_000 });
    const tailText = await tail.innerText();
    await stepShot(page, 'tail');

    await page.getByPlaceholder(/ECONNREFUSED/).fill('three files');
    await expect(page.getByText(/1 match across 1 agent/)).toBeVisible({ timeout: 15_000 });
    const hits = await page.locator('button', { hasText: 'Session Reader' }).filter({ hasText: 'three files' }).allInnerTexts();
    await stepShot(page, 'search');

    recordValues({ tail: tailText.split('\n'), searchHits: hits });

    expect(tailText).toContain('Claude Code v2.1.286');
    expect(tailText).toContain('❯ List the three files in this folder');
    expect(tailText).not.toContain('Listthethreefiles');
    expect(tailText.split('\n').filter(l => /^\s*\d+\s*$/.test(l)), 'a countdown left its digits as lines').toEqual([]);
    expect(hits).toHaveLength(1);
  } finally {
    await app.close();
  }
});

/**
 * A stopped Claude agent that ran full screen (the Audit's gate of #274): its
 * kept output is the real recording of a full-screen session that /exit'ed,
 * which replays to its launch lines only, since the alternate screen keeps no
 * history. The page reads its conversation from its transcript instead.
 */
test('the Logs page reads a stopped full-screen Claude agent from its transcript', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-logs-fs-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const session = '5f0c2d4e-8a61-4b7e-9d3a-2c1b0e9f7a64';
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'f1', name: 'Fullscreen Reader', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
    projectPath: project, skills: [], output: inlineSession('claude-fullscreen-exit-restart.jsonl.gz'), resumableSessionId: session,
    createdAt: '2026-10-01T08:00:00.000Z', lastActivity: '2026-10-01T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31471), DOROTHY_E2E: '1' },
  });
  try {
    const dist = path.resolve('electron', 'dist');
    const file = await app.evaluate((_e, { dist, project, session }) => {
      const req = process.mainModule!.require;
      return req(`${dist}/utils/resume-session.js`).transcriptPath(project, session) as string;
    }, { dist, project, session });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const said = [
      { role: 'user', text: 'Explain how the panel repaints after a resize' },
      { role: 'assistant', text: 'Paragraph one: the repaint follows SIGWINCH.\nParagraph two: the rows are redrawn.' },
    ];
    fs.writeFileSync(file, said.map((r, i) => JSON.stringify({
      type: r.role, uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, parentUuid: null, isSidechain: false, sessionId: session,
      timestamp: new Date(Date.UTC(2026, 9, 1, 8) + i * 1000).toISOString(),
      message: r.role === 'user' ? { role: 'user', content: r.text } : { id: `msg_${i}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: r.text }] },
    })).join('\n') + '\n');

    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/logs`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Fullscreen Reader/ }).click();
    await expect(page.locator('pre').first()).toBeVisible({ timeout: 30_000 });
    const tailText = await page.locator('pre').first().innerText();
    await stepShot(page, 'fullscreen-tail');

    await page.getByPlaceholder(/ECONNREFUSED/).fill('Paragraph two');
    await expect(page.getByText(/1 match across 1 agent/)).toBeVisible({ timeout: 15_000 });
    await stepShot(page, 'fullscreen-search');
    recordValues({ fullscreenTail: tailText.split('\n') });

    expect(tailText).toContain('❯ Explain how the panel repaints after a resize');
    expect(tailText).toContain('Paragraph two: the rows are redrawn.');
  } finally {
    await app.close();
  }
});

