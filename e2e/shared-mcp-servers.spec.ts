import { test, expect, _electron as electron } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as http from 'http';
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
 * 4. the token is in no file of claude's config and in no process's command line;
 * And from the Audit's gate of #541:
 * 5. (M1) a long call's progress events reach the CLI: wait_for_agent's keep-alive (every 60 s), which keeps claude
 *    from giving the call up after 30 minutes, comes through the door as an event stream. The agent waited on is in a
 *    turn that never ends (the QA's F2 on #541: idle, the wait returned at once and no keep-alive was ever sent), so
 *    the event comes a minute in;
 * 6. (H1) claude's MCP calls carry the token to whatever holds the port, unproven: an agent started while another
 *    process holds Tars's port does not start until Tars binds it, and that process never receives a token.
 * Red on main dc623b594: claude's config holds per-agent stdio copies, there is no shared process to call.
 * The artefact: values.json (each stand-in's calls and answers, the servers' processes with their memory).
 */

type Seen = {
  waitType?: string;
  progress?: { after: number; event: { method?: string; params?: Record<string, unknown> } | null };
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
  // One file per agent: each stand-in names the other agent it tries to pass for.
  return writeNodeCli(path.join(home, `cli-claude-${other}.cjs`), [
    "const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');",
    "if (process.argv.includes('--version')) { console.log('2.1.312 (Claude Code)'); process.exit(0); }",
    `const home = ${JSON.stringify(home)};`,
    `const others = ${JSON.stringify(other)};`,
    "const me = process.env.CLAUDE_AGENT_ID; const token = process.env.CLAUDE_MGR_API_TOKEN || '';",
    "const seen = {};",
    // Its own hooks, with its own token: a session, and for the agent waited on, a turn that never ends.
    "const session = require('crypto').randomUUID();",
    "const hook = (route, body) => fetch(process.env.CLAUDE_MGR_API_URL + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ agent_id: me, session_id: session, ...body }) });",
    "const done = () => fs.writeFileSync(path.join(home, `seen-${me}.json`), JSON.stringify(seen));",
    "(async () => {",
    "  try {",
    "    await hook('/api/hooks/status', { status: 'idle', source: 'startup' });",
    "    if (me !== 'a') {",
    "      await hook('/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: 'a turn that does not end' });",
    "      fs.writeFileSync(path.join(home, `turn-${me}`), '1');",
    "    }",
    // What claude reads: the --mcp-config Tars starts it with (the role file), then its user scope.
    "    const at = process.argv.indexOf('--mcp-config');",
    "    const files = [...(at >= 0 ? [process.argv[at + 1]] : []), path.join(home, '.claude.json')];",
    "    const cfg = { mcpServers: Object.assign({}, ...files.reverse().map(f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {}; } catch { return {}; } })) };",
    "    const entry = cfg.mcpServers && cfg.mcpServers['claude-mgr-orchestrator'];",
    "    seen.entry = entry || null;",
    "    if (!entry || entry.type !== 'http') throw new Error('no HTTP entry for the orchestrator server');",
    "    const headers = Object.fromEntries(Object.entries(entry.headers || {}).map(([k, v]) => [k, String(v).replace(/\\$\\{([A-Za-z0-9_]+)\\}/g, (_, n) => process.env[n] || '')]));",
    "    const post = (body, extra = {}, h = headers, signal) => fetch(entry.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...h, ...extra }, body: JSON.stringify(body), signal });",
    // Tars's shared servers answer an event stream, as claude reads it: each `data:` line a message.
    "    const messages = text => text.split('\\n').filter(l => l.startsWith('data:')).map(l => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);",
    "    await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '2.1.312' } } });",
    "    const r = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } });",
    "    const json = messages(await r.text()).find(m => m.id === 2) || {};",
    "    seen.whoami = { status: r.status, text: (json.result && json.result.content || []).map(c => c.text || '').join('\\n').slice(0, 400) };",
    "    seen.asOther = (await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'X-Tars-Caller-Id': others })).status;",
    "    seen.noToken = (await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, {}, {})).status;",
    "    seen.tokenInConfig = !!token && ['.claude.json', path.join('.claude', 'mcp.json')].some(f => { try { return fs.readFileSync(path.join(home, f), 'utf8').includes(token); } catch { return false; } });",
    "    seen.tokenInCommandLines = process.platform !== 'win32' && !!token && execFileSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8', maxBuffer: 64 << 20 }).includes(token);",
    // 5. A long call's keep-alive: wait_for_agent on the other agent, which never ends its turn here.
    "    if (me === 'a') {",
    "      while (!fs.existsSync(path.join(home, `turn-${others}`))) await new Promise(r => setTimeout(r, 200));",
    "      const stop = new AbortController();",
    "      const started = Date.now();",
    "      const r2 = await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'wait_for_agent', arguments: { id: others, timeoutSeconds: 300 }, _meta: { progressToken: 'keep' } } }, {}, headers, stop.signal);",
    "      seen.waitType = r2.headers.get('content-type');",
    "      const reader = r2.body.getReader(); let got = '';",
    "      for (;;) { const c = await reader.read(); if (c.done) break; got += new TextDecoder().decode(c.value); if (got.includes('notifications/progress')) break; }",
    "      seen.progress = { after: Date.now() - started, event: messages(got).find(m => m.method === 'notifications/progress') || null };",
    "      stop.abort();",
    "    }",
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
    test.setTimeout(360_000);
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
      const config = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'mcp.json'), 'utf8')) as { mcpServers?: Record<string, unknown> };
      const userFile = path.join(home, '.claude.json');
      const user = (fs.existsSync(userFile) ? JSON.parse(fs.readFileSync(userFile, 'utf8')) : {}) as { mcpServers?: Record<string, { type?: string }> };
      keep({ config: config.mcpServers, user: user.mcpServers });
      // The user scope every claude session loads holds no shared entry (the Audit's M3 on #541).
      expect(Object.values(user.mcpServers ?? {}).filter(e => e.type === 'http')).toEqual([]);

      type Win = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } };
      for (const id of ['a', 'b']) await page.evaluate(i => (window as unknown as Win).electronAPI.agent.start({ id: i, prompt: '' }), id);
      await expect.poll(() => [seenBy('a'), seenBy('b')].filter(Boolean).length, { timeout: 150_000 }).toBe(2);
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
      // 5. The keep-alive's progress event came through the door, as an event stream.
      expect(a.waitType).toContain('text/event-stream');
      expect(a.progress?.event).toMatchObject({ method: 'notifications/progress', params: { progressToken: 'keep' } });
      // A real wait: the agent waited on is in its turn, and the keep-alive comes a minute in.
      expect(a.progress?.after ?? 0).toBeGreaterThanOrEqual(50_000);
    } finally {
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });

  test(`an agent started while another process holds Tars's port starts once Tars binds it, and that process gets no token${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-shared-mcp-port-${newInterface ? 'ni' : 'classic'}-`));
    const project = path.join(home, 'projects', 'harbor');
    fs.mkdirSync(project, { recursive: true });
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    // Its first act is a call with its token, as claude's initialize of a shared server would be.
    const cli = writeNodeCli(path.join(home, 'cli-early.cjs'), [
      "const fs = require('fs');",
      "if (process.argv.includes('--version')) { console.log('2.1.312 (Claude Code)'); process.exit(0); }",
      `const out = ${JSON.stringify(path.join(home, 'early.json'))};`,
      "fetch(process.env.CLAUDE_MGR_API_URL + '/api/agents/' + process.env.CLAUDE_AGENT_ID, { headers: { Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN } })",
      "  .then(async r => fs.writeFileSync(out, JSON.stringify({ at: Date.now(), status: r.status, body: (await r.text()).slice(0, 200) })),",
      "        e => fs.writeFileSync(out, JSON.stringify({ at: Date.now(), error: String(e) })));",
      "process.stdout.write('stand-in ready\\r\\n');",
      'process.stdin.resume();',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
      id: 'early', name: 'Harbor Worker', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath: project,
      skills: [], cliPath: cli, createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z',
    }], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    // Another process holds Tars's port when it launches, and records every request that reaches it.
    const port = Number(apiPort(newInterface ? 31362 : 31361));
    const heard: Array<{ at: number; url?: string; authorization?: string }> = [];
    const squatter = http.createServer((req, res) => { heard.push({ at: Date.now(), url: req.url, authorization: req.headers.authorization }); res.end('{}'); });
    await new Promise<void>(r => squatter.listen(port, '127.0.0.1', r));
    let released = 0;
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: String(port), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      type Win = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } };
      // Started while the port is held: it must wait for Tars.
      void page.evaluate(() => (window as unknown as Win).electronAPI.agent.start({ id: 'early', prompt: '' }).catch(() => undefined));
      await page.waitForTimeout(4_000);
      const early = path.join(home, 'early.json');
      const startedBeforeBind = fs.existsSync(early);
      released = Date.now();
      await new Promise<void>(r => squatter.close(() => r()));
      await expect.poll(() => fs.existsSync(early), { timeout: 90_000 }).toBe(true);
      const call = JSON.parse(fs.readFileSync(early, 'utf8')) as { at: number; status?: number; error?: string };
      recordValues({ newInterface, heard, call, released, startedBeforeBind });
      expect(startedBeforeBind, 'the agent started while another process held the port').toBe(false);
      expect(heard.filter(h => h.authorization), 'a token reached the process holding the port').toEqual([]);
      expect(call.status).toBe(200);
      expect(call.at).toBeGreaterThanOrEqual(released);
    } finally {
      await new Promise<void>(r => (squatter.listening ? squatter.close(() => r()) : r()));
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
