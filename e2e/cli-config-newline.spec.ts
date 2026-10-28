import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseToml } from 'smol-toml';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Removing or saving an MCP server leaves codex's config.toml parsing (28/10). On the owner's machine, 2.0.4's first
 * start (25/10, 19:16) removed and registered again each of Tars's servers in ~/.codex/config.toml; the table it
 * removed sat right after a server of the user's (dorothy-world) with no blank line, and before codex's own [tui].
 * The removal took the newline ending the world's last line, which became `args = [".../mcp-world/dist/bundle.js"][tui]`,
 * and codex refused its whole config: no codex could start.
 *
 * The same remover served the providers and the MCP page (Settings), which the window drives: a run from source has
 * no bundled servers to register at its start (they are looked for in the packaged app's resources), so the page is
 * the path this spec takes through the real app. The providers' path is the unit test's (cli-config-files.test.ts).
 *
 * The real app on a sandbox HOME whose ~/.codex/config.toml holds that shape: the user's server, a server right after
 * it with no blank line, codex's [tui] right after that. Asserted, once with the classic shell and once with the new
 * interface:
 * 1. mcp.delete of the middle server from the window: the file parses, the user's server and [tui]
 *    whole, and it ends with a newline; a table codex adds of its own at the end still parses;
 * 2. mcp.update of a server whose command holds a quote and a Windows path: the file still parses, and the command
 *    reads back as it was given.
 * Red on main dc623b59: the file does not parse after the delete, nor after the save.
 * The artefact: values.json (the file before and after each step), a screenshot, the app's trace with E2E_TRACE=on.
 */

const BEFORE = [
  'model = "gpt-5.3-codex"',
  '',
  '[mcp_servers.dorothy-world]',
  'command = "node"',
  'args = ["/Users/someone/mcp-world/dist/bundle.js"]',
  '[mcp_servers.docs]',
  'command = "node"',
  'args = ["/Users/someone/docs/dist/bundle.js"]',
  '[tui]',
  'notice = true',
  '',
].join('\n');

type Saved = { success?: boolean; error?: string };
type Api = { electronAPI: { mcp: {
  delete(p: { provider: string; name: string }): Promise<Saved>;
  update(p: { provider: string; name: string; command: string; args: string[]; env: Record<string, string> }): Promise<Saved>;
} } };

const parses = (text: string): string | undefined => { try { parseToml(text); return undefined; } catch (err) { return String(err); } };

for (const newInterface of [false, true]) {
  test(`the mcp page leaves codex's config.toml parsing, the user's servers and codex's own tables whole${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-cli-config-'));
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const config = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, BEFORE);
    const port = apiPort(newInterface ? 31344 : 31343);
    const values: Record<string, unknown> = { newInterface, before: BEFORE };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });

      // 1. The middle server deleted from the window.
      const deleted = await page.evaluate(() => (window as unknown as Api).electronAPI.mcp.delete({ provider: 'codex', name: 'docs' }));
      const afterDelete = fs.readFileSync(config, 'utf8');
      keep({ deleted, afterDelete, afterDeleteParse: parses(afterDelete) });
      expect(parses(afterDelete), 'config.toml does not parse after the delete').toBeUndefined();
      const parsed = parseToml(afterDelete) as { mcp_servers?: Record<string, { args?: string[] }>; tui?: unknown };
      expect.soft(parsed.mcp_servers?.['dorothy-world']?.args).toEqual(['/Users/someone/mcp-world/dist/bundle.js']);
      expect.soft(parsed.mcp_servers?.docs).toBeUndefined();
      expect.soft(parsed.tui).toEqual({ notice: true });
      expect.soft(afterDelete.endsWith('\n')).toBe(true);
      fs.appendFileSync(config, '[notice]\nhide_full_access_warning = true\n');
      expect.soft(parses(fs.readFileSync(config, 'utf8')), 'a table codex adds at the end').toBeUndefined();

      // 2. A server whose command holds a quote and a Windows path, saved from the window.
      const command = 'C:\\Program Files\\a "b"\\node.exe';
      const saved = await page.evaluate((c) => (window as unknown as Api).electronAPI.mcp.update({ provider: 'codex', name: 'docs', command: c, args: ['C:\\Users\\x\\d.js'], env: {} }), command);
      const afterSave = fs.readFileSync(config, 'utf8');
      keep({ saved, afterSave, afterSaveParse: parses(afterSave) });
      expect(parses(afterSave), 'config.toml does not parse after the save').toBeUndefined();
      expect.soft(saved.success).toBe(true);
      expect.soft((parseToml(afterSave) as { mcp_servers: Record<string, { command: string }> }).mcp_servers.docs.command).toBe(command);
      await stepShot(page, newInterface ? 'cli-config-new-interface' : 'cli-config');
    } finally {
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
