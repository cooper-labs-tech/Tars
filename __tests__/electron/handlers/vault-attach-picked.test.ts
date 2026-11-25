import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * vault:attachFile follows the window's file rules (utils/window-file-access.ts, utils/picked-files.ts, 2.0.7). The
 * Vault page attaches only the paths the native dialog returned (dialog:open-files, DocumentEditor's Insert files), so
 * that is the rule: a path the user picked, and no secret, since the copy lands in ~/.tars/vault/attachments.
 *
 * How it fails, written before the code (25/11):
 * A1. A file no dialog returned is copied.
 * A2. A file the user picked in the dialog is no longer attached (the Vault page's own flow).
 * A3. A picked file that is a secret (by name, where it really lies, in a folder of credentials) is copied into
 *     ~/.tars anyway, where every agent reads it.
 */

const picked: string[] = [];
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: () => os.homedir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.7', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [...picked] })) },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));
// The vault's database: a document to attach to; what the copy is, the file system says.
vi.mock('../../../electron/services/vault-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/services/vault-db')>();
  const db = { prepare: (sql: string) => ({ get: () => (/FROM documents/.test(sql) ? { id: 'doc-1' } : { id: 'att-1' }), run: () => undefined, all: () => [] }) };
  return { ...actual, getVaultDb: () => db };
});

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { registerVaultHandlers } from '../../../electron/handlers/vault-handlers';
import { PRIVATE_DIR, VAULT_DIR } from '../../../electron/constants';
import type { AgentStatus, AppSettings } from '../../../electron/types';

function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = { agents: new Map<string, AgentStatus>(), getAppSettings: () => ({} as AppSettings), getClaudeSkills: async () => [], getMainWindow: () => ({}) };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}

// The suite's throwaway home (__tests__/setup/home-isolation.ts): stand-in files only.
const home = os.homedir();
const SECRET = 'FAKE-SECRET-of-the-test';
const attachments = path.join(VAULT_DIR, 'attachments');
const copies = () => (fs.existsSync(attachments) ? fs.readdirSync(attachments) : []);
const copiedText = () => copies().map((n) => fs.readFileSync(path.join(attachments, n), 'utf8')).join('\n');

beforeEach(() => {
  handlers.clear();
  picked.length = 0;
  fs.rmSync(attachments, { recursive: true, force: true });
  fs.mkdirSync(attachments, { recursive: true });
  for (const d of [path.join(home, '.ssh'), path.join(home, '.gemini'), PRIVATE_DIR, path.join(home, 'Pictures')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), SECRET);
  fs.writeFileSync(path.join(home, '.ssh', 'notes.txt'), SECRET);
  fs.writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), JSON.stringify({ access_token: SECRET }));
  fs.writeFileSync(path.join(PRIVATE_DIR, 'hermes-connection.json'), JSON.stringify({ token: SECRET }));
  fs.writeFileSync(path.join(home, 'Pictures', 'diagram.png'), 'a picture');
  fs.writeFileSync(path.join(home, 'Pictures', '.env'), `KEY=${SECRET}`);
  registerIpcHandlers(deps());
  registerVaultHandlers({ getMainWindow: () => null });
});

const openFiles = () => handlers.get('dialog:open-files')!({}) as Promise<string[]>;
const attach = (file: string) => handlers.get('vault:attachFile')!({}, { document_id: 'doc-1', file_path: file }) as Promise<{ success: boolean; error?: string }>;

describe('vault:attachFile', () => {
  it('A1. copies no file the dialog did not return', async () => {
    for (const f of [path.join(home, '.ssh', 'id_ed25519'), path.join(PRIVATE_DIR, 'hermes-connection.json'), path.join(home, '.gemini', 'oauth_creds.json'), path.join(home, 'Pictures', 'diagram.png')]) {
      expect(await attach(f), f).toMatchObject({ success: false });
    }
    expect(copies()).toEqual([]);
  });

  it('A2. still attaches a file the user picked in the dialog', async () => {
    picked.push(path.join(home, 'Pictures', 'diagram.png'));
    expect(await openFiles()).toEqual(picked);
    expect(await attach(picked[0])).toMatchObject({ success: true });
    expect(copiedText()).toBe('a picture');
  });

  it('A3. copies no secret into ~/.tars, even one the user picked', async () => {
    picked.push(path.join(home, 'Pictures', '.env'), path.join(home, '.ssh', 'notes.txt'), path.join(home, '.gemini', 'oauth_creds.json'));
    await openFiles();
    for (const f of picked) expect(await attach(f), f).toMatchObject({ success: false });
    expect(copiedText()).not.toContain(SECRET);
  });
});
