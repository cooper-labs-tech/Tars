import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialStoreDirs } from '../../../electron/platform';
import { moveTestHome } from '../../setup/test-home';

/**
 * What the two Telegram send guards refuse on Windows: the
 * app's `isSafeTelegramPath` (the /api/telegram/send-* routes) and the MCP
 * server every agent is given. Both refused POSIX dotfiles under the home
 * only; Windows keeps its credentials in %APPDATA% and %LOCALAPPDATA%: the
 * GitHub CLI's hosts.yml, gcloud's credentials.db, browser profiles (cookies,
 * saved passwords), Tars's own Electron profile, DPAPI's master keys, the
 * Credential Manager's files. One `send_telegram_document` sent any of them.
 *
 * How it can fail, written before the code:
 * 1. a file in one of those stores is sent, by either guard;
 * 2. the check compares case: `%APPDATA%\github cli\HOSTS.YML` is the same file;
 * 3. the store is looked for only where APPDATA says, or only in the default
 *    place, when the two differ (a redirected or a sandboxed profile);
 * 4. `.azure` (Azure CLI tokens) is sent;
 * 5. darwin/linux get a list at all: their guard stays as it was;
 * 6. ordinary files under AppData (a download, a log) are refused too: the
 *    witness that the guard is not refusing everything.
 */

describe('the Windows credential stores', () => {
  it('5. none on darwin and linux', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(credentialStoreDirs({ platform, home: '/Users/demo', env: { APPDATA: '/x', LOCALAPPDATA: '/y' } })).toEqual([]);
    }
  });

  it('1, 3, 4. win32: the stores under APPDATA, LOCALAPPDATA and their default places, and the home\'s .azure', () => {
    const dirs = credentialStoreDirs({
      platform: 'win32', home: 'C:\\Users\\n', env: { APPDATA: 'D:\\Roam', LOCALAPPDATA: 'D:\\Loc' },
    }).map(d => d.toLowerCase());
    for (const want of [
      'D:\\Roam\\GitHub CLI', 'C:\\Users\\n\\AppData\\Roaming\\GitHub CLI',
      'D:\\Roam\\gcloud', 'D:\\Roam\\tars', 'D:\\Roam\\Microsoft\\Credentials', 'D:\\Roam\\Microsoft\\Protect',
      'D:\\Loc\\Microsoft\\Credentials', 'D:\\Loc\\Google\\Chrome\\User Data', 'D:\\Loc\\Microsoft\\Edge\\User Data',
      'D:\\Roam\\Mozilla', 'C:\\Users\\n\\AppData\\Local\\Google\\Chrome\\User Data', 'C:\\Users\\n\\.azure',
    ]) expect(dirs, want).toContain(want.toLowerCase());
  });
});

// ── Both guards, the real ones, on this machine's layout (win32 only) ─────────

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const tools = new Map<string, Handler>();
const FAKE_SDK: Record<string, () => unknown> = {
  '@modelcontextprotocol/sdk/server/mcp.js': () => ({
    McpServer: class {
      tool(name: string, _d: string, _s: unknown, handler: Handler) { tools.set(name, handler); }
      async connect() {}
    },
  }),
  '@modelcontextprotocol/sdk/server/stdio.js': () => ({ StdioServerTransport: class {} }),
};
const SERVER_DIR = path.join(__dirname, '..', '..', '..', 'mcp-telegram');
/** Where the server's own import lands (see telegram-private-dir.test.ts for why). */
function whereTheServerFinds(specifier: string): string {
  try {
    const url = execFileSync(process.execPath, [
      '--input-type=module', '--eval', 'process.stdout.write(import.meta.resolve(process.env.SPECIFIER))',
    ], { cwd: SERVER_DIR, env: { ...process.env, SPECIFIER: specifier }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return fileURLToPath(url);
  } catch {
    return specifier;
  }
}

vi.mock('https', () => {
  const refuse = () => { throw new Error('a test reached the network'); };
  return { default: { get: refuse, request: refuse }, get: refuse, request: refuse };
});

import { isSafeTelegramPath } from '../../../electron/services/api-routes/utils';

describe.runIf(process.platform === 'win32')('2, 6. both Telegram guards refuse the stores, in any case, and nothing else', () => {
  const home = os.homedir();
  // The profile folders under the suite's home, as Windows lays them out, and
  // APPDATA and LOCALAPPDATA moved there for these tests (moveTestHome): the
  // suite's own isolation moves the home, and these two may still name the
  // real profile, which lies outside it.
  const roaming = path.join(home, 'AppData', 'Roaming');
  const local = path.join(home, 'AppData', 'Local');
  let restoreHome: () => void = () => {};
  const SECRETS = [
    path.join(roaming, 'GitHub CLI', 'hosts.yml'),
    path.join(roaming, 'github cli', 'HOSTS.YML'),
    path.join(roaming, 'gcloud', 'credentials.db'),
    path.join(roaming, 'TARS', 'Cookies'),
    path.join(roaming, 'Microsoft', 'Protect', 'S-1-5-21', 'key'),
    path.join(roaming, 'Microsoft', 'Credentials', 'ABCDEF'),
    path.join(local, 'Microsoft', 'Credentials', 'ABCDEF'),
    path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Login Data'),
    path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cookies'),
    path.join(roaming, 'Mozilla', 'Firefox', 'Profiles', 'x.default', 'logins.json'),
    path.join(home, '.azure', 'msal_token_cache.json'),
    path.join(home, '.AWS', 'credentials'),
  ];
  const ORDINARY = [path.join(home, 'Downloads', 'report.pdf'), path.join(local, 'Temp', 'notes.txt'), path.join(roaming, 'Code', 'User', 'settings.json')];

  let server: { windowsCredentialStoreDirs: (home: string, env: NodeJS.ProcessEnv) => string[] };
  beforeAll(async () => {
    restoreHome = moveTestHome(home);
    fs.mkdirSync(path.join(home, '.dorothy'), { recursive: true });
    fs.writeFileSync(path.join(home, '.dorothy', 'app-settings.json'), JSON.stringify({ telegramBotToken: 'not-a-real-bot', telegramChatId: '1' }));
    for (const [specifier, fake] of Object.entries(FAKE_SDK)) vi.doMock(whereTheServerFinds(specifier), fake);
    server = await import('../../../mcp-telegram/src/index');
  });
  afterAll(() => {
    restoreHome();
    fs.rmSync(path.join(home, '.dorothy'), { recursive: true, force: true });
  });

  it('the server keeps the same list as the app (it is built on its own)', () => {
    const env = { APPDATA: 'D:\\Roam', LOCALAPPDATA: 'D:\\Loc' };
    expect(server.windowsCredentialStoreDirs('C:\\Users\\n', env)).toEqual(credentialStoreDirs({ platform: 'win32', home: 'C:\\Users\\n', env }));
  });

  it('the app\'s own routes', () => {
    for (const file of SECRETS) expect(isSafeTelegramPath(file), file).toBe(false);
    for (const file of ORDINARY) expect(isSafeTelegramPath(file), file).toBe(true);
  });

  for (const [tool, arg] of [['send_telegram_document', 'document_path'], ['send_telegram_photo', 'photo_path'], ['send_telegram_video', 'video_path']] as const) {
    it(`the MCP server's ${tool}`, async () => {
      const send = tools.get(tool);
      expect(send, `${tool} was never registered`).toBeDefined();
      for (const file of SECRETS) {
        const r = await send!({ [arg]: file });
        expect(r.content[0].text, file).toContain('Refused');
      }
      for (const file of ORDINARY) {
        const r = await send!({ [arg]: file });
        expect(r.content[0].text, file).toContain('File not found');
      }
    });
  }
});
