import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An opencode agent and a pi agent find Tars's MCP servers where their CLIs read them, and speak to Tars as
 * themselves (the QA's CLI matrix of 18/10, its Backend row: Tars wrote them into ~/.opencode/config.json and
 * ~/.pi/config.json, where neither CLI reads).
 *
 * The real app on a sandbox HOME. Each agent's CLI is a stand-in that does at its start what the real one does, as
 * read in its published code on 19/10:
 * - opencode 1.19.3: merges `config.json`, `opencode.json` and `opencode.jsonc` of `$XDG_CONFIG_HOME/opencode`, else
 *   `~/.config/opencode`, and starts each `mcp.<name>` of type `local` as `command[0]` with `command.slice(1)`, its
 *   environment `{ ...process.env, ...environment }`;
 * - pi 1.3.0 (`@earendil-works/pi-coding-agent`): reads `mcpServers` of `$PI_CODING_AGENT_DIR/mcp.json`, else
 *   `~/.pi/agent/mcp.json`, and starts each stdio server with `{ ...process.env, ...env }`.
 * Neither reads anywhere else. Each stand-in starts Tars's orchestrator server from what it found, initializes it over
 * stdio and calls `whoami`, and logs the answer.
 *
 * Asserted:
 * 1. each CLI finds `claude-mgr-orchestrator` where it reads;
 * 2. the server it starts answers `whoami` with that agent's own id: the agent's token reached it;
 * 3. nothing of Tars's is left in `~/.opencode/config.json` or `~/.pi/config.json`.
 * Red on main (e2363ae0): neither finds a server.
 * The artefact: values.json (what each stand-in found and was answered, the files as Tars left them), the app's trace.
 */

/** The CLI at its start: the servers where it reads them, Tars's orchestrator started and asked who it is. */
const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
const kind = path.basename(process.argv[1]);
const home = os.homedir();
const log = (entry) => fs.appendFileSync(path.join(process.env.HOME, kind + '.jsonl'), JSON.stringify({ at: new Date().toISOString(), id: process.env.CLAUDE_AGENT_ID, ...entry }) + '\n');
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };
let servers = {};
if (kind === 'opencode') {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
  for (const f of ['config.json', 'opencode.json', 'opencode.jsonc']) {
    for (const [name, s] of Object.entries(readJson(path.join(dir, f))?.mcp ?? {})) {
      if (s && s.type === 'local' && Array.isArray(s.command)) servers[name] = { command: s.command[0], args: s.command.slice(1), env: s.environment ?? {} };
    }
  }
} else {
  const dir = process.env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent');
  for (const [name, s] of Object.entries(readJson(path.join(dir, 'mcp.json'))?.mcpServers ?? {})) {
    if (s && s.command) servers[name] = { command: s.command, args: s.args ?? [], env: s.env ?? {} };
  }
}
log({ launched: process.argv.slice(2), servers: Object.keys(servers) });
process.stdout.write(kind + ' stand-in ready\n');
process.stdin.resume();
const orchestrator = servers['claude-mgr-orchestrator'];
if (orchestrator) {
  const child = spawn(orchestrator.command, orchestrator.args, { env: { ...process.env, ...orchestrator.env }, stdio: ['pipe', 'pipe', 'ignore'] });
  let buffered = '';
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id === 1) {
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
      } else if (msg.id === 2) {
        log({ whoami: (msg.result?.content ?? []).map((c) => c.text ?? '').join('\n'), isError: !!msg.result?.isError || !!msg.error });
        child.kill();
      }
    }
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: kind, version: '1' } } });
}
`;

type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } };

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test(`opencode and pi find Tars's MCP servers where they read them, and speak as themselves`, async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-opencode-pi-mcp-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  for (const name of ['opencode', 'pi']) fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${STAND_IN}`, { mode: 0o755 });
  const agent = (id: string, name: string, provider: string) => ({
    id, name, character: 'robot', provider, status: 'idle', role: 'worker', projectPath: project, skills: [], permissionMode: 'normal',
    cliPath: path.join(bin, provider), createdAt: '2026-10-19T08:00:00.000Z', lastActivity: '2026-10-19T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('oc', 'Review Agent', 'opencode'), agent('pi', 'Notes Agent', 'pi')], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { additionalPaths: [bin], opencode: path.join(bin, 'opencode'), pi: path.join(bin, 'pi') },
  }));
  const port = apiPort(31390);
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(1, { timeout: 30_000 });
    // Tars's MCP servers registered in every CLI's configuration, as a packaged Tars does at every start
    // (setupMcpOrchestrator). A development run finds no bundle under process.resourcesPath, the app's own.
    const resources = path.join(home, 'resources');
    fs.mkdirSync(path.join(resources, 'mcp-orchestrator', 'dist'), { recursive: true });
    fs.copyFileSync(path.resolve('mcp-orchestrator', 'dist', 'bundle.js'), path.join(resources, 'mcp-orchestrator', 'dist', 'bundle.js'));
    fs.copyFileSync(path.resolve('mcp-orchestrator', 'package.json'), path.join(resources, 'mcp-orchestrator', 'package.json'));
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
    const written = { opencode: path.join(home, '.config', 'opencode', 'opencode.json'), pi: path.join(home, '.pi', 'agent', 'mcp.json') };

    for (const id of ['oc', 'pi']) await page.evaluate((i) => (window as unknown as Api).electronAPI.agent.start({ id: i, prompt: '' }), id);
    const answered = (kind: string) => lines(path.join(home, `${kind}.jsonl`)).find((e) => typeof e.whoami === 'string');
    await expect.configure({ soft: true }).poll(() => !!answered('opencode') && !!answered('pi'), { timeout: 60_000, message: 'both asked whoami' }).toBe(true);

    const oc = lines(path.join(home, 'opencode.jsonl'));
    const pi = lines(path.join(home, 'pi.jsonl'));
    const legacy = { opencode: path.join(home, '.opencode', 'config.json'), pi: path.join(home, '.pi', 'config.json') };
    const legacyText = Object.fromEntries(Object.entries(legacy).map(([k, f]) => [k, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null]));
    keep({ oc, pi, legacy: legacyText, written: Object.fromEntries(Object.entries(written).map(([k, f]) => [k, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null])) });

    // 1. Found where each reads.
    expect.soft(oc.find((e) => e.launched)?.servers ?? [], 'opencode found').toContain('claude-mgr-orchestrator');
    expect.soft(pi.find((e) => e.launched)?.servers ?? [], 'pi found').toContain('claude-mgr-orchestrator');
    // 2. Each speaks as itself.
    expect.soft(answered('opencode')?.isError, String(answered('opencode')?.whoami).slice(0, 300)).toBe(false);
    expect.soft(answered('opencode')?.whoami ?? '').toContain('You are "Review Agent" (agent id: oc)');
    expect.soft(answered('pi')?.isError, String(answered('pi')?.whoami).slice(0, 300)).toBe(false);
    expect.soft(answered('pi')?.whoami ?? '').toContain('You are "Notes Agent" (agent id: pi)');
    // 3. Nothing of Tars's left where nothing reads.
    for (const [kind, text] of Object.entries(legacyText)) expect.soft(text ?? '', `${kind}'s old file`).not.toContain('claude-mgr-orchestrator');
  } finally {
    await app.close();
    for (const f of ['opencode.jsonl', 'pi.jsonl']) if (fs.existsSync(path.join(home, f))) fs.copyFileSync(path.join(home, f), test.info().outputPath(f));
    await removeHome(home);
  }
});
