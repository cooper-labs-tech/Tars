import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The MCP servers Tars, or Dorothy before it, no longer ships leave Claude Code's user scope and the other CLIs at
 * Tars's start (2.0.7; an orchestrator's report of 19/11: every session started with "claude-mgr-telegram",
 * "dorothy-world" and "tasmania" failing, CONNECTION_CLOSED).
 *
 * Measured on the owner's Mac: the three are in ~/.claude.json's user scope, which every session loads,
 * claude-mgr-telegram and dorothy-world naming a Dorothy build's bundles (mcp-telegram, mcp-world) that no longer
 * exist, tasmania a scratchpad file of an agent session; dorothy-world is in ~/.codex/config.toml and
 * ~/.gemini/settings.json too. 2.0.5 took mcp-telegram out of every CLI, but asked claude whether Tars had it
 * registered, and claude answers no for an entry in its user scope, by design: it never went.
 *
 * A sandbox HOME holding those entries, as the owner's Mac does, with a server of the owner's (`honcho`) and a
 * `claude-mgr-telegram` of the owner's own, running something else, in another CLI. The app starts.
 * Asserted, once with the classic shell and once with the new interface:
 * 1. ~/.claude.json no longer holds claude-mgr-telegram nor dorothy-world, and keeps tasmania (the owner's to remove,
 *    reported, never changed), honcho, and every other key of the file;
 * 2. ~/.codex/config.toml and ~/.gemini/settings.json no longer hold dorothy-world;
 * 3. the owner's own server named claude-mgr-telegram, running another program, stays in gemini's settings.
 * Red on the 2.0.7 train (b5f207bcf): 1 and 2 (both are left).
 * The artefact: values.json (each file's servers before and after).
 */

const DOROTHY = '/Users/someone/Dorothy-fix/release/mac-arm64/Dorothy.app/Contents/Resources';
const TASMANIA = { type: 'stdio', command: 'node', args: ['/private/tmp/claude-501/-Users-someone-Dorothy-fix/4ab31f00/scratchpad/x'], env: {} };
const HONCHO = { type: 'http', url: 'https://mcp.honcho.dev' };

function claudeJson(home: string) {
  return {
    numStartups: 412,
    projects: { '/Users/someone/work': { hasTrustDialogAccepted: true } },
    mcpServers: {
      'claude-mgr-telegram': { type: 'stdio', command: 'node', args: [`${DOROTHY}/mcp-telegram/dist/bundle.js`], env: {} },
      'dorothy-world': { type: 'stdio', command: 'node', args: [`${DOROTHY}/mcp-world/dist/bundle.js`], env: {} },
      tasmania: TASMANIA,
      honcho: HONCHO,
    },
    sandboxHome: home,
  };
}

test.skip(process.platform === 'win32', 'the paths are POSIX; the matcher reads either separator and its unit tests run everywhere');

for (const newInterface of [false, true]) {
  test(`servers Tars no longer ships leave every CLI at its start, the owner's stay${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-retired-mcp-${newInterface ? 'ni' : 'classic'}-`));
    const dir = path.join(home, '.tars');
    for (const d of [dir, path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, '.gemini')]) fs.mkdirSync(d, { recursive: true });
    const claudeFile = path.join(home, '.claude.json');
    const codexFile = path.join(home, '.codex', 'config.toml');
    const geminiFile = path.join(home, '.gemini', 'settings.json');
    fs.writeFileSync(claudeFile, JSON.stringify(claudeJson(home), null, 2), { mode: 0o600 });
    fs.writeFileSync(codexFile, `[mcp_servers.dorothy-world]\ncommand = "node"\nargs = [ "/Applications/Dorothy.app/Contents/Resources/mcp-world/dist/bundle.js" ]\n`);
    fs.writeFileSync(geminiFile, JSON.stringify({ mcpServers: {
      'dorothy-world': { command: 'node', args: ['/Applications/Dorothy.app/Contents/Resources/mcp-world/dist/bundle.js'] },
      'claude-mgr-telegram': { command: 'node', args: ['/Users/someone/my-telegram/server.js'] },
    } }, null, 2));
    fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const seen: Record<string, unknown> = { newInterface, before: { claude: Object.keys(claudeJson(home).mcpServers) } };
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31538 + (newInterface ? 1 : 0)), DOROTHY_E2E: '1' },
    });
    const claude = () => JSON.parse(fs.readFileSync(claudeFile, 'utf8')) as ReturnType<typeof claudeJson>;
    const gemini = () => Object.keys((JSON.parse(fs.readFileSync(geminiFile, 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers);
    try {
      await app.firstWindow();
      // The start registers Tars's servers and retires the old ones, off the window's first paint: given 60 s.
      for (const end = Date.now() + 60_000; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) {
        const servers = Object.keys(claude().mcpServers ?? {});
        if (!servers.includes('dorothy-world') && !servers.includes('claude-mgr-telegram') && !fs.readFileSync(codexFile, 'utf8').includes('dorothy-world') && !gemini().includes('dorothy-world')) break;
      }
      const after = claude();
      Object.assign(seen, { after: { claude: Object.keys(after.mcpServers ?? {}), codex: fs.readFileSync(codexFile, 'utf8'), gemini: gemini() } });

      expect.soft(Object.keys(after.mcpServers ?? {})).not.toContain('claude-mgr-telegram');
      expect.soft(Object.keys(after.mcpServers ?? {})).not.toContain('dorothy-world');
      expect.soft(after.mcpServers?.tasmania).toEqual(TASMANIA);
      expect.soft(after.mcpServers?.honcho).toEqual(HONCHO);
      expect.soft(after.numStartups).toBe(412);
      expect.soft(after.projects).toEqual(claudeJson(home).projects);
      expect.soft(fs.statSync(claudeFile).mode & 0o777).toBe(0o600);
      expect.soft(fs.readFileSync(codexFile, 'utf8')).not.toContain('dorothy-world');
      expect.soft(gemini()).not.toContain('dorothy-world');
      expect.soft(gemini()).toContain('claude-mgr-telegram');
    } finally {
      recordValues(seen);
      await app.close().catch(() => { /* gone */ });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
