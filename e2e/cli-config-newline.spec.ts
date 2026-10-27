import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Tars's start leaves codex's config.toml parsing (28/10). On the owner's machine, 2.0.4's first start (25/10,
 * 19:16) removed and registered again each of Tars's servers in ~/.codex/config.toml; the table it removed sat
 * right after a server of the user's (dorothy-world) with no blank line, and before codex's own [tui]. The removal
 * took the newline ending the world's last line, which became `args = [".../mcp-world/dist/bundle.js"][tui]`, and
 * codex refused its whole config: no codex could start.
 *
 * The real app on a sandbox HOME whose ~/.codex/config.toml holds that shape: the user's server, Tars's orchestrator
 * server on an old path right after it, codex's [tui] right after that.
 *
 * Asserted, once with the classic shell and once with the new interface:
 * 1. Tars registers its orchestrator server again at its start (the path is its own now);
 * 2. the file parses, the user's server and [tui] kept whole, and it ends with a newline;
 * 3. a table codex adds of its own at the end (as it keeps a setting) still parses.
 * Red on main dc623b59: the file does not parse after the start.
 * The artefact: values.json (the file before and after), a screenshot, the app's trace with E2E_TRACE=on.
 */

const BEFORE = [
  'model = "gpt-5.3-codex"',
  '',
  '[mcp_servers.dorothy-world]',
  'command = "node"',
  'args = ["/Users/someone/mcp-world/dist/bundle.js"]',
  '[mcp_servers.claude-mgr-orchestrator]',
  'command = "/old/node"',
  'args = ["/Users/someone/.dorothy/mcp-orchestrator/dist/bundle.js"]',
  '[tui]',
  'notice = true',
  '',
].join('\n');

for (const newInterface of [false, true]) {
  test(`a start leaves codex's config.toml parsing, the user's servers and codex's own tables whole${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-cli-config-'));
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const config = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, BEFORE);
    const bundle = path.resolve('mcp-orchestrator', 'dist', 'bundle.js');
    const port = apiPort(newInterface ? 31344 : 31343);
    const values: Record<string, unknown> = { newInterface, before: BEFORE };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });

      // 1. Registered again at the start: its own path is in the file.
      await expect.poll(() => fs.readFileSync(config, 'utf8').includes(bundle), { timeout: 60_000 }).toBe(true);
      await page.waitForTimeout(1_000);
      const after = fs.readFileSync(config, 'utf8');
      let parsed: { mcp_servers?: Record<string, { args?: string[] }>; tui?: unknown } | undefined;
      let parseError: string | undefined;
      try { parsed = parseToml(after) as typeof parsed; } catch (err) { parseError = String(err); }
      keep({ after, parseError });

      // 2. It parses, the user's server and [tui] whole, and it ends with a newline.
      expect(parseError, 'config.toml does not parse after the start').toBeUndefined();
      expect.soft(parsed?.mcp_servers?.['dorothy-world']?.args).toEqual(['/Users/someone/mcp-world/dist/bundle.js']);
      expect.soft(parsed?.mcp_servers?.['claude-mgr-orchestrator']?.args).toEqual([bundle]);
      expect.soft(parsed?.tui).toEqual({ notice: true });
      expect.soft(after.endsWith('\n')).toBe(true);

      // 3. codex keeps a setting of its own: a table at the end.
      fs.appendFileSync(config, '[notice]\nhide_full_access_warning = true\n');
      expect.soft(() => parseToml(fs.readFileSync(config, 'utf8'))).not.toThrow();
      await stepShot(page, newInterface ? 'cli-config-new-interface' : 'cli-config');
    } finally {
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
