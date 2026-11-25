import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The window's Obsidian vault channels follow the window's file rules
 * (utils/window-file-access.ts, 2.0.7): obsidian:addVault, obsidian:readFile,
 * obsidian:writeFile and obsidian:scan.
 *
 * How it fails, written before the code (25/11):
 * V1. addVault saves the home, the home with a trailing separator, a folder
 *     above it, or a link to the home.
 * V2. addVault saves ~/.tars, ~/.tars-private, or a folder in either.
 * V3. addVault saves a CLI's home or a folder in one (~/.claude, ~/.codex,
 *     ~/.gemini, ~/.grok, ~/.config/...), or a credential place (~/.ssh,
 *     ~/.aws): any folder of the home whose name starts with a dot.
 * V4. readFile, with a real vault registered, reads a secret by its name in
 *     the vault (id_ed25519, .env, credentials.json), or reads through a link
 *     in the vault to a file outside it (a markdown file too), or through a
 *     folder link out of it.
 * V5. writeFile writes a file that is not markdown, a dotfile, a file in a dot
 *     folder of the vault (.obsidian, .claude), or through a link out of the
 *     vault (a note linked to a key, a folder linked to the home).
 * V6. A vault stored before, or by an agent (obsidianVaultPaths lives in
 *     ~/.tars/app-settings.json, which every agent can write), that the rule
 *     refuses is used anyway by scan, readFile or writeFile; or is dropped
 *     silently: scan and getVaultInfo must say which is refused and why.
 * V7. A real vault in the home breaks: added, scanned, a note read, a note
 *     edited, a new note written.
 * V8. scan's preview of a note reads through a link out of the vault.
 */

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerObsidianHandlers } from '../../../electron/handlers/obsidian-handlers';
import { DATA_DIR, PRIVATE_DIR } from '../../../electron/constants';
import type { AppSettings } from '../../../electron/types';

// The suite's throwaway home (__tests__/setup/home-isolation.ts): stand-in files only.
const home = os.homedir();
const KEY = 'FAKE-PRIVATE-KEY-of-the-test';
const TOKEN = 'FAKE-ACCESS-TOKEN-of-the-test';
const vault = path.join(home, 'Documents', 'Notes');
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-vault-access-')));

let settings: AppSettings;
function register(vaults: string[] = []) {
  handlers.clear();
  settings = { obsidianVaultPaths: vaults } as AppSettings;
  registerObsidianHandlers({ getAppSettings: () => settings, setAppSettings: (s) => { settings = s; }, saveAppSettings: vi.fn() });
}

/** A link, or false where the system refuses one (a file link on Windows without the right). */
function link(target: string, at: string, type: 'file' | 'junction'): boolean {
  try {
    fs.rmSync(at, { force: true, recursive: false });
    fs.symlinkSync(target, at, type);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  for (const d of ['.ssh', '.gemini', '.claude', '.codex', '.grok', '.config/opencode', '.aws', 'Documents/Notes/sub']) {
    fs.mkdirSync(path.join(home, d), { recursive: true });
  }
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), KEY);
  fs.writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), JSON.stringify({ access_token: TOKEN }));
  fs.writeFileSync(path.join(PRIVATE_DIR, 'hermes-connection.json'), JSON.stringify({ token: TOKEN }));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
  fs.writeFileSync(path.join(home, 'outside.md'), `# outside the vault ${TOKEN}`);
  fs.rmSync(path.join(home, '.zshrc'), { force: true });
  fs.writeFileSync(path.join(vault, 'note.md'), '# a note');
  fs.writeFileSync(path.join(vault, 'sub', 'inner.md'), '# inner');
  fs.writeFileSync(path.join(vault, 'id_ed25519'), KEY);
  fs.writeFileSync(path.join(vault, '.env'), `TOKEN=${TOKEN}`);
  fs.writeFileSync(path.join(vault, 'credentials.json'), JSON.stringify({ token: TOKEN }));
  register();
});

afterAll(() => {
  fs.rmSync(box, { recursive: true, force: true });
});

const addVault = (p: string) => handlers.get('obsidian:addVault')!({}, p) as Promise<{ success: boolean; error?: string }>;
const readFile = (f: string, v: string) => handlers.get('obsidian:readFile')!({}, f, v) as Promise<{ file?: { content: string }; error?: string }>;
const writeFile = (f: string, c: string, v: string) => handlers.get('obsidian:writeFile')!({}, f, c, v) as Promise<{ success?: boolean; error?: string }>;
type Scan = { vaults: Array<{ vaultPath: string; files: Array<{ path: string; preview?: string }> }>; refused?: Array<{ vaultPath: string; reason: string }> };
const scan = () => handlers.get('obsidian:scan')!({}) as Promise<Scan>;
const vaultInfo = () => handlers.get('obsidian:getVaultInfo')!({}) as Promise<{ configured: boolean; vaultPaths: string[]; refused?: Array<{ vaultPath: string; reason: string }> }>;

describe('obsidian:addVault', () => {
  it('V1. refuses the home, a folder above it, and a link to it', async () => {
    const homeLink = path.join(box, 'to-home');
    link(home, homeLink, 'junction');
    for (const p of [home, home + path.sep, path.dirname(home), path.parse(home).root, homeLink]) {
      expect(await addVault(p), p).toMatchObject({ success: false });
    }
    expect(settings.obsidianVaultPaths).toEqual([]);
  });

  it("V2. refuses Tars's own folders and what is in them", async () => {
    for (const p of [DATA_DIR, PRIVATE_DIR, path.join(PRIVATE_DIR, 'notes'), path.join(DATA_DIR, 'vault')]) {
      expect(await addVault(p), p).toMatchObject({ success: false });
    }
    expect(settings.obsidianVaultPaths).toEqual([]);
  });

  it("V3. refuses a CLI's home, a credential place, and any dot folder of the home", async () => {
    for (const d of ['.claude', '.codex', '.gemini', '.grok', '.config/opencode', '.ssh', '.aws', '.gemini/tmp']) {
      expect(await addVault(path.join(home, d)), d).toMatchObject({ success: false });
    }
    expect(settings.obsidianVaultPaths).toEqual([]);
  });
});

describe('a real vault in the home', () => {
  it('V7. is added, scanned, read, edited, and takes a new note', async () => {
    expect(await addVault(vault)).toMatchObject({ success: true });
    const s = await scan();
    expect(s.vaults.map((v) => v.vaultPath)).toEqual([vault]);
    expect(s.vaults[0].files.map((f) => path.relative(vault, f.path)).sort()).toEqual(['note.md', path.join('sub', 'inner.md')]);
    expect((await readFile(path.join(vault, 'note.md'), vault)).file?.content).toBe('# a note');
    expect(await writeFile(path.join(vault, 'note.md'), '# edited', vault)).toMatchObject({ success: true });
    expect(fs.readFileSync(path.join(vault, 'note.md'), 'utf8')).toBe('# edited');
    expect(await writeFile(path.join(vault, 'sub', 'new.md'), '# new', vault)).toMatchObject({ success: true });
    expect(fs.readFileSync(path.join(vault, 'sub', 'new.md'), 'utf8')).toBe('# new');
  });
});

describe('obsidian:readFile', () => {
  it('V4. never reads a secret by name, nor through a link out of the vault', async () => {
    register([vault]);
    for (const name of ['id_ed25519', '.env', 'credentials.json']) {
      const r = await readFile(path.join(vault, name), vault);
      expect(r.file, name).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain(KEY);
    }
    const links: Array<[string, string, 'file' | 'junction']> = [
      [path.join(home, '.ssh', 'id_ed25519'), path.join(vault, 'leak.md'), 'file'],
      [path.join(home, 'outside.md'), path.join(vault, 'out.md'), 'file'],
      [home, path.join(vault, 'up'), 'junction'],
    ];
    for (const [target, at, type] of links) {
      if (!link(target, at, type)) continue;
      const file = type === 'junction' ? path.join(at, '.ssh', 'id_ed25519') : at;
      const r = await readFile(file, vault);
      expect(r.file, file).toBeUndefined();
      expect(JSON.stringify(r)).not.toMatch(new RegExp(`${KEY}|${TOKEN}`));
    }
    const viaUp = await readFile(path.join(vault, 'up', 'outside.md'), vault);
    expect(viaUp.file).toBeUndefined();
  });
});

describe('obsidian:writeFile', () => {
  it('V5. writes markdown in the vault only: no other kind, no dotfile, no dot folder, no link out', async () => {
    register([vault]);
    fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
    const refused = [
      path.join(vault, 'script.sh'), path.join(vault, 'notes.json'), path.join(vault, '.hidden.md'),
      path.join(vault, '.obsidian', 'workspace.md'), path.join(vault, '.claude', 'settings.json'),
    ];
    for (const f of refused) {
      expect(await writeFile(f, 'written', vault), f).not.toMatchObject({ success: true });
      expect(fs.existsSync(f), f).toBe(false);
    }
    if (link(path.join(home, '.ssh', 'id_ed25519'), path.join(vault, 'leak.md'), 'file')) {
      expect(await writeFile(path.join(vault, 'leak.md'), 'overwritten', vault)).not.toMatchObject({ success: true });
      expect(fs.readFileSync(path.join(home, '.ssh', 'id_ed25519'), 'utf8')).toBe(KEY);
    }
    if (link(home, path.join(vault, 'up'), 'junction')) {
      for (const rel of ['.zshrc', path.join('.claude', 'settings.json'), 'outside.md', 'fresh.md']) {
        expect(await writeFile(path.join(vault, 'up', rel), 'overwritten', vault), rel).not.toMatchObject({ success: true });
      }
      expect(fs.existsSync(path.join(home, '.zshrc'))).toBe(false);
      expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).toBe('{}');
      expect(fs.existsSync(path.join(home, 'fresh.md'))).toBe(false);
    }
  });
});

describe('a vault stored before, or by an agent', () => {
  it('V6. is not used when the rule refuses it, and the answer says so, with why', async () => {
    register([home, path.join(home, '.gemini'), vault]);
    const s = await scan();
    expect(s.vaults.map((v) => v.vaultPath)).toEqual([vault]);
    expect(s.refused?.map((r) => r.vaultPath)).toEqual([home, path.join(home, '.gemini')]);
    for (const r of s.refused ?? []) expect(r.reason.length).toBeGreaterThan(10);
    expect(JSON.stringify(s)).not.toMatch(new RegExp(`${KEY}|${TOKEN}`));
    const info = await vaultInfo();
    expect(info.refused?.map((r) => r.vaultPath)).toEqual([home, path.join(home, '.gemini')]);
    expect((await readFile(path.join(home, '.ssh', 'id_ed25519'), home)).file).toBeUndefined();
    expect((await readFile(path.join(home, '.gemini', 'oauth_creds.json'), path.join(home, '.gemini'))).file).toBeUndefined();
    expect(await writeFile(path.join(home, '.zshrc'), 'echo owned', home)).not.toMatchObject({ success: true });
    expect(await writeFile(path.join(home, 'notes.md'), '# a note in the home', home)).not.toMatchObject({ success: true });
    expect(fs.existsSync(path.join(home, '.zshrc'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'notes.md'))).toBe(false);
  });

  it('V8. its previews never read through a link out of the vault', async () => {
    register([vault]);
    if (!link(path.join(home, '.ssh', 'id_ed25519'), path.join(vault, 'leak.md'), 'file')) return;
    const s = await scan();
    expect(JSON.stringify(s)).not.toContain(KEY);
  });
});
