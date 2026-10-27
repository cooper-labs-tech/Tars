import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The MCP servers each agent's CLI is started with, by its role (2.0.5, services/mcp-roles.ts, the owner's lot 3 of
 * 28/10: "un exécutant ne reçoit plus Telegram ni X").
 *
 * In the real app, in a sandbox whose ~/.claude/mcp.json holds Tars's seven servers, two claude agents of one
 * project, its orchestrator and a worker, are started from the window. Their CLI is a stand-in that records which
 * servers the file its `--mcp-config` names holds, as Claude Code reads it.
 *
 * Asserted, with the classic shell and with the new interface:
 * 1. the orchestrator's CLI gets all seven;
 * 2. the worker's gets five: no claude-mgr-telegram, no dorothy-x; the orchestrator, memory, kanban, vault and
 *    socialdata servers kept.
 * Red on main (dc623b59): both get the same file, all seven.
 * The artefact: values.json (each CLI's --mcp-config and the servers it names).
 */

const SEVEN = ['claude-mgr-orchestrator', 'tars-memory', 'claude-mgr-telegram', 'claude-mgr-kanban', 'claude-mgr-vault', 'dorothy-socialdata', 'dorothy-x'];
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } };

for (const newInterface of [false, true]) {
  test(`a worker's CLI gets five MCP servers, its orchestrator's all seven${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-mcp-roles-${newInterface ? 'ni' : 'classic'}-`));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    for (const d of [project, dir, path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'mcp.json'), JSON.stringify({
      mcpServers: Object.fromEntries(SEVEN.map(name => [name, { command: 'node', args: [path.join(home, 'srv', name, 'bundle.js')] }])),
    }));
    const log = path.join(home, 'mcp-seen.jsonl');
    // In Node, not bash: a bash stand-in is named like the shell, and the app would never see a CLI running.
    const cli = writeNodeCli(path.join(home, 'stand-in-claude.cjs'), [
      "const fs = require('fs');",
      "const i = process.argv.indexOf('--mcp-config');",
      'const file = i > 0 ? process.argv[i + 1] : null;',
      'let servers = null; try { servers = Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers).sort(); } catch {}',
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ agent: process.env.CLAUDE_AGENT_ID, file, servers }) + '\\n');`,
      "process.stdout.write('stand-in ready\\n');",
      'process.stdin.resume();',
      '',
    ].join('\n'));
    const agent = (id: string, name: string, role: string) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, orchestratorMode: role === 'orchestrator',
      projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'Project Lead', 'orchestrator'), agent('w', 'Writer', 'worker')]));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31522 + (newInterface ? 1 : 0)), DOROTHY_E2E: '1' },
    });
    const values: Record<string, unknown> = { newInterface, home };
    const errors: string[] = [];
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI, undefined, { timeout: 60_000 });
      for (const id of ['lead', 'w']) await page.evaluate((agentId) => (window as unknown as Api).electronAPI.agent.start({ id: agentId, prompt: 'go' }), id);
      const seen = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<{ agent: string; file: string | null; servers: string[] | null }>;
      await expect.poll(() => new Set(seen().map(s => s.agent)).size, { timeout: 60_000 }).toBe(2);
      const of = (id: string) => seen().find(s => s.agent === id)!;
      values.lead = of('lead');
      values.worker = of('w');
      recordValues(values);

      // 1.
      expect(of('lead').servers).toEqual([...SEVEN].sort());
      // 2.
      expect(of('w').servers).toEqual(SEVEN.filter(n => n !== 'claude-mgr-telegram' && n !== 'dorothy-x').sort());
      expect(errors).toEqual([]);
    } finally {
      recordValues(values);
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
