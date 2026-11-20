import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Settings > MCP's handlers for a Kimi Code agent, in the real app (#617, the #614 Audit's Info 7). Kimi Code reads its
 * servers from `mcpServers` in the mcp.json of its home, `$KIMI_CODE_HOME` else `~/.kimi-code` (kimi-code-provider.ts,
 * measured on 2.6.3). The window's Settings > MCP passes 'claude' alone today, so this spec takes the path any other
 * caller would: the preload bridge, `electronAPI.mcp.*`, with the provider 'kimi-code'.
 *
 * The app on a sandbox HOME whose Kimi Code home is elsewhere in the sandbox (KIMI_CODE_HOME), its mcp.json holding a
 * server of the user's (`docs`) and one of Tars's own (`claude-mgr-orchestrator`). Asserted, once with the classic
 * shell and once with the new interface:
 * 1. mcp.list for kimi-code names the user's server, and not Tars's;
 * 2. mcp.update saves a server into that mcp.json, the user's and Tars's kept whole;
 * 3. mcp.delete removes the user's server there, Tars's and the new one kept;
 * 4. nothing is written to `~/.kimi-code`, where this Kimi Code never reads.
 * Red on #601 d2da84bbc: no case for kimi-code, so the list is empty and the save and the delete answer
 * "Unknown provider".
 * The artefact: values.json (the file before and after each step, and each answer), a screenshot, the app's trace
 * with E2E_TRACE=on.
 */

type Server = { name: string; command: string; args: string[]; env: Record<string, string> };
type Answer = { success?: boolean; error?: string; servers?: Server[] };
type Api = { electronAPI: { mcp: {
  list(p: { provider: string }): Promise<Answer>;
  update(p: { provider: string; name: string; command: string; args: string[]; env: Record<string, string> }): Promise<Answer>;
  delete(p: { provider: string; name: string }): Promise<Answer>;
} } };

const TARS_OWN = { command: 'node', args: ['/Applications/Tars.app/Contents/Resources/mcp-orchestrator/dist/bundle.js'] };
const USERS = { command: 'node', args: ['/Users/someone/docs/dist/bundle.js'], env: { DOCS_ROOT: '/Users/someone/docs' } };

for (const newInterface of [false, true]) {
  test(`settings > mcp lists, saves and deletes a kimi code agent's servers in the mcp.json of its home${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-kimi-mcp-'));
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const kimiHome = path.join(home, 'elsewhere', 'kimi');
    const file = path.join(kimiHome, 'mcp.json');
    const defaultHome = path.join(home, '.kimi-code');
    fs.mkdirSync(kimiHome, { recursive: true });
    const before = { mcpServers: { docs: USERS, 'claude-mgr-orchestrator': TARS_OWN } };
    fs.writeFileSync(file, JSON.stringify(before, null, 2) + '\n');
    const port = apiPort(newInterface ? 31368 : 31367);
    const values: Record<string, unknown> = { newInterface, kimiHome, before };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> };

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', KIMI_CODE_HOME: kimiHome },
    });
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/settings`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });

      // 1. The list: the user's server, not Tars's.
      const listed = await page.evaluate(() => (window as unknown as Api).electronAPI.mcp.list({ provider: 'kimi-code' }));
      keep({ listed });
      expect.soft(listed.servers?.map((s) => s.name), 'mcp.list for kimi-code').toEqual(['docs']);
      expect.soft(listed.servers?.[0]).toMatchObject({ command: 'node', args: USERS.args, env: USERS.env });

      // 2. A server saved: into this Kimi Code's mcp.json, the other two whole.
      const saved = await page.evaluate(() => (window as unknown as Api).electronAPI.mcp.update({ provider: 'kimi-code', name: 'notes', command: 'npx', args: ['-y', 'notes-mcp'], env: { NOTES: '1' } }));
      const afterSave = read();
      keep({ saved, afterSave });
      expect.soft(saved.success, `mcp.update for kimi-code: ${saved.error ?? ''}`).toBe(true);
      expect.soft(afterSave.mcpServers?.notes).toMatchObject({ command: 'npx', args: ['-y', 'notes-mcp'], env: { NOTES: '1' } });
      expect.soft(afterSave.mcpServers?.docs).toEqual(USERS);
      expect.soft(afterSave.mcpServers?.['claude-mgr-orchestrator']).toEqual(TARS_OWN);

      // 3. The user's server deleted: Tars's and the new one kept.
      const deleted = await page.evaluate(() => (window as unknown as Api).electronAPI.mcp.delete({ provider: 'kimi-code', name: 'docs' }));
      const afterDelete = read();
      keep({ deleted, afterDelete });
      expect.soft(deleted.success, `mcp.delete for kimi-code: ${deleted.error ?? ''}`).toBe(true);
      expect.soft(Object.keys(afterDelete.mcpServers ?? {}).sort()).toEqual(['claude-mgr-orchestrator', 'notes']);

      // 4. Nothing where this Kimi Code never reads.
      const strayFile = fs.existsSync(path.join(defaultHome, 'mcp.json'));
      keep({ defaultHomeHasMcpJson: strayFile });
      expect.soft(strayFile, '~/.kimi-code/mcp.json written').toBe(false);
      await stepShot(page, newInterface ? 'kimi-mcp-new-interface' : 'kimi-mcp');
    } finally {
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
