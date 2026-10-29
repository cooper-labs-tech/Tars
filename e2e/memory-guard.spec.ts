import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A project's MEMORY.md past what Claude Code loads of it is told to its orchestrator and shown to the window (2.0.6,
 * option c). Claude Code 2.1.312 loads the first 200 lines, then 25,000 characters (the 24.4 KB it names), measured
 * with the real CLI on 29/10 (reports/memory-guard-runs/probe-claude.sh): the probe's 150 lines of 200 characters
 * end at L123, "27 of 150 lines were cut off, starting at line 124". The same file is seeded here, in the project's
 * own Claude folder, with an orchestrator running a stand-in CLI that logs what is typed into it, and the guard
 * reading every 500 ms (DOROTHY_MEMORY_GUARD_EVERY_MS).
 *
 * Asserted:
 * 1. the orchestrator is told once, by Tars, with what is cut and the file's path;
 * 2. not again while the file stays as it is;
 * 3. again once it grew;
 * 4. the window's Memory row for the project carries the same guard.
 * Red on main bed5cd9ed: no guard, no note, no `guard` on the row. Skipped on Windows, where the stand-in's terminal
 * starts through ConPTY (the guard's paths and parts are held by memory-guard.test.ts on every platform). The
 * artefact: values.json (the notes typed, the row's guard).
 */

/** The probe's file (reports/memory-guard-runs/make-memory.py): numbered lines, line 5 being 320 characters. */
function probeFile(count: number, width: number): string {
  const out: string[] = [];
  for (let n = 1; n <= count; n++) {
    const head = `- L${String(n).padStart(3, '0')} memory entry`;
    out.push(n === 5
      ? `${head} ${'x'.repeat(320 - head.length - ' LONGLINE-TAIL-OK'.length - 1)} LONGLINE-TAIL-OK`
      : `${head} ${'y'.repeat(Math.max(0, width - head.length - 1))}`.slice(0, Math.max(width, head.length)));
  }
  return out.join('\n') + '\n';
}

test.skip(process.platform === 'win32', 'the stand-in orchestrator starts through ConPTY there; the guard itself is held by its unit on every platform');

for (const newInterface of [false, true]) {
test(`a MEMORY.md past what Claude Code loads is told to its orchestrator once, again when it grows, and shown${newInterface ? ' (new interface)' : ''}`, async () => {
  test.setTimeout(240_000);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-memory-guard-')));
  const project = path.join(home, 'projects', 'harbor');
  fs.mkdirSync(project, { recursive: true });
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  const memoryDir = path.join(home, '.claude', 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const memory = path.join(memoryDir, 'MEMORY.md');
  fs.writeFileSync(memory, probeFile(150, 200));
  const typed = path.join(home, 'typed.jsonl');
  // A claude that registers its session, then logs every write into its terminal.
  const cli = writeNodeCli(path.join(home, 'cli-orchestrator.cjs'), [
    "const fs = require('fs');",
    "if (process.argv.includes('--version')) { console.log('2.1.312 (Claude Code)'); process.exit(0); }",
    `process.stdin.on('data', b => fs.appendFileSync(${JSON.stringify(typed)}, JSON.stringify(b.toString('utf8')) + '\\n'));`,
    "fetch(process.env.CLAUDE_MGR_API_URL + '/api/hooks/status', {",
    "  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN },",
    "  body: JSON.stringify({ agent_id: process.env.CLAUDE_AGENT_ID, session_id: require('crypto').randomUUID(), status: 'idle', source: 'startup' }),",
    "}).catch(() => {});",
    "process.stdout.write('stand-in ready\\r\\n');",
    'process.stdin.resume();', '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'o1', name: 'Harbor Lead', character: 'robot', provider: 'claude', status: 'idle', role: 'orchestrator', projectPath: project,
    skills: [], cliPath: cli, createdAt: '2026-10-29T08:00:00.000Z', lastActivity: '2026-10-29T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
  const values: Record<string, unknown> = { newInterface };
  const notes = () => (fs.existsSync(typed) ? fs.readFileSync(typed, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as string) : [])
    .join('').split('Message from Tars').slice(1);

  const app = await launchSandboxed(electron, home, {
    env: {
      NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31574 : 31573),
      DOROTHY_E2E: '1', DOROTHY_MEMORY_GUARD_EVERY_MS: '500',
    },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    type Row = { memoryDir: string; guard?: Record<string, unknown> };
    type Api = { electronAPI: {
      agent: { start(p: { id: string; prompt: string }): Promise<unknown> };
      memory: { listProjects(extra?: string[]): Promise<{ projects: Row[] }> };
    } };
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'o1', prompt: '' }));

    // 1. Told once, by Tars, with what is cut and where.
    await expect.poll(() => notes().length, { timeout: 60_000, message: 'a note from Tars typed into the orchestrator' }).toBeGreaterThanOrEqual(1);
    const first = notes()[0];
    values.first = first;
    recordValues(values);
    expect(first).toContain('MEMORY.md is 29.6 KB in 150 lines. Claude Code reads only its first 24.4 KB: 27 of its 150 lines, from line 124, never reach an agent (5.3 KB).');
    expect(first).toContain(memory);
    // 2. Not again while it stays as it is (six passes).
    await page.waitForTimeout(3_000);
    expect(notes()).toHaveLength(1);
    // 3. Again once it grew.
    fs.appendFileSync(memory, probeFile(10, 200));
    await expect.poll(() => notes().length, { timeout: 30_000, message: 'told again once it grew' }).toBe(2);
    values.second = notes()[1];
    expect(notes()[1]).toMatch(/MEMORY\.md is 31\.\d KB in 160 lines\./);
    // 4. The window's row.
    const rows = await page.evaluate(p => (window as unknown as Api).electronAPI.memory.listProjects([p]).then(r => r.projects), project);
    const row = rows.find(r => r.memoryDir === memoryDir);
    values.guard = row?.guard;
    recordValues(values);
    expect(row?.guard).toMatchObject({ state: 'cut', lines: 160, limit: { size: 25_000, lines: 200 }, cut: { by: 'size', fromLine: 124 } });
    expect(String(row?.guard?.notice)).toMatch(/^MEMORY\.md is 31\.\d KB in 160 lines\. Claude Code reads only its first 24\.4 KB/);
  } finally {
    recordValues(values);
    await app.close().catch(() => undefined);
    await removeHome(home);
  }
});
}
