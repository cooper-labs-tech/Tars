import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Tars's MCP servers shared between agents (2.0.5, lot 3 item G, the second step), in the real app, once with the
 * classic shell and once with the new interface.
 *
 * Tars registers its servers as a packaged Tars does at its start (setupMcpOrchestrator, on the six bundles of this
 * tree): the shared ones run once, and claude's config names each as an HTTP server on Tars's API whose header names
 * the token's variable. Two agents of one project run a stand-in for claude that reads its config as claude does
 * (~/.claude.json, `${VAR}` in a header expanded from its own environment, measured on 2.1.312) and calls the
 * orchestrator server's whoami through it.
 *
 * Asserted:
 * 1. one process serves the orchestrator server for both agents (and one each of the five other shared servers);
 * 2. each agent's whoami answers as that agent, by its name and id;
 * 3. a call with an agent's own token that names the other agent (X-Tars-Caller-Id) is refused (403), and one with
 *    no token too (401);
 * 4. the token is in no file of claude's config and in no process's command line.
 * Red on main dc623b594: claude's config holds per-agent stdio copies, there is no shared process to call.
 * The artefact: values.json (each stand-in's calls and answers, the servers' processes with their memory).
 */

type Seen = {
  entry: { type?: string; url?: string; headers?: Record<string, string> } | null;
  whoami?: { status: number; text: string };
  asOther?: number;
  noToken?: number;
  tokenInConfig?: boolean;
  tokenInCommandLines?: boolean;
  error?: string;
};

const SHARED = ['mcp-orchestrator', 'mcp-memory', 'mcp-kanban', 'mcp-vault', 'mcp-socialdata', 'mcp-x'];

function standIn(home: string, other: string): string {
  return writeNodeCli(path.join(home, 'cli-claude.cjs'), [
    "const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');",
    "if (process.argv.includes('--version')) { console.log('2.1.312 (Claude Code)'); process.exit(0); }",
    `const home = ${JSON.stringify(home)};`,
    `const others = ${JSON.stringify(other)};`,
    "const me = process.env.CLAUDE_AGENT_ID; const token = process.env.CLAUDE_MGR_API_TOKEN || '';",
    "const seen = {};",
    "const done = () => fs.writeFileSync(path.join(home, `seen-${me}.json`), JSON.stringify(seen));",
    "(async () => {",
    "  try {",
    "    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));",
    "    const entry = cfg.mcpServers && cfg.mcpServers['claude-mgr-orchestrator'];",
    "    seen.entry = entry || null;",
    "    if (!entry || entry.type !== 'http') throw new Error('no HTTP entry for the orchestrator server');",
    "    const headers = Object.fromEntries(Object.entries(entry.headers || {}).map(([k, v]) => [k, String(v).replace(/\\$\\{([A-Za-z0-9_]+)\\}/g, (_, n) => process.env[n] || '')]));",
    "    const post = (body, extra = {}, h = headers) => fetch(entry.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...h, ...extra }, body: JSON.stringify(body) });",
    "    await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '2.1.312' } } });",
    "    const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } });",
    "    const json = await r.json().catch(() => ({}));",
    "    seen.whoami = { status: r.status, text: (json.result && json.result.content || []).map(c => c.text || '').join('\\n').slice(0, 400) };",
    "    seen.asOther = (await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'X-Tars-Caller-Id': others })).status;",
    "    seen.noToken = (await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, {}, {})).status;",
    "    seen.tokenInConfig = !!token && ['.claude.json', path.join('.claude', 'mcp.json')].some(f => { try { return fs.readFileSync(path.join(home, f), 'utf8').includes(token); } catch { return false; } });",
    "    seen.tokenInCommandLines = process.platform !== 'win32' && !!token && execFileSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8', maxBuffer: 64 << 20 }).includes(token);",
    "  } catch (e) { seen.error = String(e && e.message || e); }",
    "  done();",
    "})();",
    "process.stdout.write('stand-in ready\\r\\n');",
    'process.stdin.resume();',
    '',
  ].join('\n'));
}

/** The processes running one of these bundles, with their memory. */
function serversOf(resources: string): Array<{ pid: number; mb: number; bundle: string }> {
  if (process.platform === 'win32') return [];
  const out = execFileSync('ps', ['-A', '-o', 'pid=,rss=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return out.split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    const bundle = m && SHARED.find(s => m[3].includes(path.join(resources, s, 'dist', 'bundle.js')));
    return m && bundle ? [{ pid: Number(m[1]), mb: Math.round(Number(m[2]) / 102.4) / 10, bundle }] : [];
  });
}

test.skip(process.platform === 'win32', 'the process table is read with ps');

for (const newInterface of [false, true]) {
  test(`two agents use one process of each shared MCP server, each call answered as its own agent${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-shared-mcp-${newInterface ? 'ni' : 'classic'}-`));
    const project = path.join(home, 'projects', 'harbor');
    fs.mkdirSync(project, { recursive: true });
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    const base = { character: 'robot', provider: 'claude', status: 'idle', projectPath: project, skills: [], createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z' };
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      { ...base, id: 'a', name: 'Harbor Worker', role: 'worker', cliPath: standIn(home, 'b') },
      { ...base, id: 'b', name: 'Harbor Tester', role: 'worker', cliPath: standIn(home, 'a') },
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    // The bundles of this tree where a packaged Tars has them: a development run finds none under its resources.
    const resources = path.join(home, 'resources');
    for (const s of [...SHARED, 'mcp-telegram']) {
      fs.mkdirSync(path.join(resources, s, 'dist'), { recursive: true });
      fs.copyFileSync(path.resolve(s, 'dist', 'bundle.js'), path.join(resources, s, 'dist', 'bundle.js'));
      fs.copyFileSync(path.resolve(s, 'package.json'), path.join(resources, s, 'package.json'));
    }
    const seenBy = (id: string): Seen | undefined => { try { return JSON.parse(fs.readFileSync(path.join(home, `seen-${id}.json`), 'utf8')); } catch { return undefined; } };
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31358 : 31357), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
      const dist = path.resolve('electron', 'dist');
      await app.evaluate(async (_e, { resources, dist }) => {
        const was = process.resourcesPath;
        Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true, writable: true });
        try {
          await process.mainModule!.require(`${dist}/services/mcp-orchestrator.js`).setupMcpOrchestrator({});
        } finally {
          Object.defineProperty(process, 'resourcesPath', { value: was, configurable: true, writable: true });
        }
      }, { resources, dist });
      const config = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
      keep({ config: config.mcpServers });

      type Win = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } };
      for (const id of ['a', 'b']) await page.evaluate(i => (window as unknown as Win).electronAPI.agent.start({ id: i, prompt: '' }), id);
      await expect.poll(() => [seenBy('a'), seenBy('b')].filter(Boolean).length, { timeout: 60_000 }).toBe(2);
      const a = seenBy('a')!;
      const b = seenBy('b')!;
      const servers = serversOf(resources);
      keep({ a, b, servers });

      // 1. One process each.
      expect(servers.filter(s => s.bundle === 'mcp-orchestrator')).toHaveLength(1);
      expect.soft(SHARED.map(s => servers.filter(p => p.bundle === s).length)).toEqual(SHARED.map(() => 1));
      // 2. Each answered as itself.
      expect(a.error, 'a').toBeUndefined();
      expect(b.error, 'b').toBeUndefined();
      expect(a.whoami?.text).toMatch(/^You are "Harbor Worker" \(agent id: a\)/);
      expect(b.whoami?.text).toMatch(/^You are "Harbor Tester" \(agent id: b\)/);
      // 3. Never as the other.
      expect([a.asOther, b.asOther, a.noToken, b.noToken]).toEqual([403, 403, 401, 401]);
      // 4. The token in no file and no command line.
      expect(a.entry?.headers?.Authorization).toBe('Bearer ${CLAUDE_MGR_API_TOKEN}');
      expect([a.tokenInConfig, b.tokenInConfig, a.tokenInCommandLines, b.tokenInCommandLines]).toEqual([false, false, false, false]);
    } finally {
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
