import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

/**
 * The file handlers judge where a path really lands, not how it is spelled
 * (security, every platform).
 *
 * fs:read-text-file, fs:write-text-file, fs:read-project-files and
 * local-file:// checked the path as spelled against their roots, then
 * readFileSync / writeFileSync / readFile followed the links on the way.
 * ~/.tars is a root of the first two and every agent can write in it, so
 * `ln -s ~ ~/.tars/h` opened the whole home, ~/.ssh and ~/.tars-private
 * included, with no project added at all; a symlink inside a cloned
 * repository did the same through the project that holds it.
 *
 * How it can fail, written before the fix (2026-09-28):
 * 1. fs:read-text-file reads the home, ~/.ssh or ~/.tars-private through a
 *    link under ~/.tars.
 * 2. fs:write-text-file overwrites a file there, or creates a new one, the
 *    same way.
 * 3. A link inside a project (a folder link, or a symlinked file) reads or
 *    writes outside the project.
 * 4. fs:read-project-files reads outside through a link in the relative part,
 *    or through a base that is a link.
 * 5. local-file:// serves a file outside through a link.
 * 6. A link that stays inside the project is refused, or a new file in the
 *    project can no longer be created: the Brain page breaks.
 * 7. ~/.claude/CLAUDE.md symlinked to a dotfiles repository can no longer be
 *    read, saved or listed by the Brain page.
 * 8. That exception lets a file link to ~/.ssh or ~/.tars-private through.
 * 9. That exception reaches local-file://, which stays strict.
 * 10. fs:read-project-files, how the Brain graph finds CLAUDE.md files,
 *     refuses the dotfiles-linked markdown file, or accepts a linked file that
 *     is not markdown or lies in a blocked place.
 *
 * Folder links are junctions where the type is read (Windows, no privilege
 * needed) and symlinks elsewhere. A FILE symlink needs a privilege Windows
 * gives only in Developer Mode or to an administrator: where it is refused,
 * those cases are skipped and say why; utils/real-target.test.ts judges the
 * same files, and 7 and 10 are witnessed below with the link stood in for.
 */

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false, autoInstallOnAppQuit: true,
    on: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn(),
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => os.homedir(), getAppPath: () => process.cwd(), isPackaged: false,
    getVersion: () => '1.9.1', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: (scheme: string, handler: unknown) => { protocols.set(scheme, handler as Protocol); }, registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
type Protocol = (request: { url: string }) => Promise<Response>;
const handlers = new Map<string, Handler>();
const protocols = new Map<string, Protocol>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { setupProtocolHandler } from '../../../electron/core/window-manager';
import { DATA_DIR, PRIVATE_DIR } from '../../../electron/constants';
import type { AgentStatus } from '../../../electron/types';

const onWindows = process.platform === 'win32';
const agents = new Map<string, AgentStatus>();
const linkDir = (to: string, at: string) => { if (!fs.existsSync(at)) fs.symlinkSync(to, at, 'junction'); };

function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = { agents, getClaudeSkills: async () => [] };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}

// The suite's throwaway home (__tests__/setup/home-isolation.ts).
const home = os.homedir();
const ssh = path.join(home, '.ssh');
const KEY = path.join(ssh, 'id_rsa');
const SECRET = path.join(PRIVATE_DIR, 'hermes-webhook-secret');
const PROFILE = path.join(home, '.bashrc');
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-real-path-project-')));
const docs = path.join(project, 'docs');

afterAll(() => { fs.rmSync(project, { recursive: true, force: true }); });

/** Why a file symlink cannot be made here, or undefined when it can. */
function fileLinksRefused(): string | undefined {
  const probe = path.join(project, 'probe-link');
  try {
    fs.symlinkSync(path.join(project, 'probe-target'), probe, 'file');
    fs.unlinkSync(probe);
    return undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM') throw err;
    return `skipped: file symlinks are refused here (${code}), which Windows does without Developer Mode; they run on macOS, Linux and a Windows runner that has the privilege`;
  }
}
const NO_FILE_LINKS = fileLinksRefused();
if (NO_FILE_LINKS) console.warn(`fs-roots-links.test.ts: ${NO_FILE_LINKS}`);

beforeEach(() => {
  handlers.clear();
  agents.clear();
  fs.mkdirSync(ssh, { recursive: true });
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(KEY, 'the key');
  fs.writeFileSync(SECRET, 'the secret');
  fs.writeFileSync(PROFILE, 'the profile');
  fs.writeFileSync(path.join(docs, 'a.md'), 'a doc');
  fs.writeFileSync(path.join(DATA_DIR, 'projects.json'), JSON.stringify([project]));
  linkDir(home, path.join(DATA_DIR, 'h'));
  linkDir(ssh, path.join(DATA_DIR, 's'));
  linkDir(PRIVATE_DIR, path.join(DATA_DIR, 'p'));
  linkDir(ssh, path.join(project, 'escape'));
  linkDir(docs, path.join(project, 'docs-link'));
  registerIpcHandlers(deps());
});

const readText = (file: string) => handlers.get('fs:read-text-file')!({}, file) as Promise<{ content: string; error?: string }>;
const writeText = (file: string, content: string) => handlers.get('fs:write-text-file')!({}, { filePath: file, content }) as Promise<{ success: boolean; error?: string }>;
const readProject = (base: string, rel: string) =>
  handlers.get('fs:read-project-files')!({}, { paths: [base], relative: [rel] }) as Promise<{ files: Record<string, string> }>;

/** Nothing outside moved. */
function untouched() {
  expect(fs.readFileSync(KEY, 'utf8')).toBe('the key');
  expect(fs.readFileSync(SECRET, 'utf8')).toBe('the secret');
  expect(fs.readFileSync(PROFILE, 'utf8')).toBe('the profile');
  expect(fs.readdirSync(ssh).sort()).toEqual(['id_rsa']);
  expect(fs.readdirSync(PRIVATE_DIR).sort()).toEqual(['hermes-webhook-secret']);
  expect(fs.existsSync(path.join(home, '.new-profile'))).toBe(false);
}

describe('1, 2. a link under ~/.tars', () => {
  const through = [
    ['the home', path.join(DATA_DIR, 'h', '.ssh', 'id_rsa'), path.join(DATA_DIR, 'h', '.bashrc'), path.join(DATA_DIR, 'h', '.new-profile')],
    ['~/.ssh', path.join(DATA_DIR, 's', 'id_rsa'), path.join(DATA_DIR, 's', 'id_rsa'), path.join(DATA_DIR, 's', 'authorized_keys')],
    ['~/.tars-private', path.join(DATA_DIR, 'p', 'hermes-webhook-secret'), path.join(DATA_DIR, 'p', 'hermes-webhook-secret'), path.join(DATA_DIR, 'p', 'new')],
  ] as const;

  for (const [name, readable, existing, fresh] of through) {
    it(`to ${name}: read refused`, async () => {
      const out = await readText(readable);
      expect(out.content).toBe('');
      expect(out.error).toBeTruthy();
    });

    it(`to ${name}: write refused, an existing file and a new one`, async () => {
      expect((await writeText(existing, 'overwritten')).success).toBe(false);
      expect((await writeText(fresh, 'planted')).success).toBe(false);
      untouched();
    });
  }
});

describe('3. a link inside a project', () => {
  it('a folder link out of it: read and write refused', async () => {
    expect((await readText(path.join(project, 'escape', 'id_rsa'))).content).toBe('');
    expect((await writeText(path.join(project, 'escape', 'id_rsa'), 'overwritten')).success).toBe(false);
    expect((await writeText(path.join(project, 'escape', 'authorized_keys'), 'planted')).success).toBe(false);
    untouched();
  });

  it.skipIf(NO_FILE_LINKS)('a symlinked file out of it: read and write refused', async () => {
    const file = path.join(project, 'CLAUDE.md');
    if (!fs.existsSync(file)) fs.symlinkSync(KEY, file, 'file');
    expect((await readText(file)).content).toBe('');
    expect((await writeText(file, 'overwritten')).success).toBe(false);
    untouched();
  });
});

describe('4. fs:read-project-files', () => {
  it('refuses a link in the relative part, and a base that is a link out', async () => {
    expect((await readProject(project, path.join('escape', 'id_rsa'))).files).toEqual({});
    expect((await readProject(path.join(project, 'escape'), 'id_rsa')).files).toEqual({});
  });

  it.skipIf(NO_FILE_LINKS)('refuses a symlinked file out of the project', async () => {
    const file = path.join(project, 'AGENTS.md');
    if (!fs.existsSync(file)) fs.symlinkSync(KEY, file, 'file');
    expect((await readProject(project, 'AGENTS.md')).files).toEqual({});
  });
});

describe('6. a link that stays inside the project, and a new file', () => {
  it('fs:read-text-file still reads through it; fs:write-text-file writes an instruction file and nothing else', async () => {
    expect((await readText(path.join(project, 'docs-link', 'a.md'))).content).toBe('a doc');
    // Since 2.0.4 the window writes the instruction files the Brain edits and
    // nothing else (the Audit's Hole 1, window-file-access.test.ts W4 and W5).
    expect((await writeText(path.join(project, 'docs-link', 'a.md'), 'edited')).success).toBe(false);
    expect(fs.readFileSync(path.join(docs, 'a.md'), 'utf8')).toBe('a doc');
    expect((await writeText(path.join(project, 'docs-link', 'b.md'), 'new')).success).toBe(false);
    expect(fs.existsSync(path.join(docs, 'b.md'))).toBe(false);
    expect((await writeText(path.join(project, 'CLAUDE.local.md'), 'new')).success).toBe(false);
    // The project's CLAUDE.md is a link out of it by now (the case above): its .claude/CLAUDE.md.
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    expect(await writeText(path.join(project, '.claude', 'CLAUDE.md'), 'new')).toEqual({ success: true });
    expect(fs.readFileSync(path.join(project, '.claude', 'CLAUDE.md'), 'utf8')).toBe('new');
  });

  it('fs:read-project-files still reads through it', async () => {
    expect(Object.values((await readProject(project, path.join('docs-link', 'a.md'))).files)).toEqual(['a doc']);
    expect(Object.values((await readProject(path.join(project, 'docs-link'), 'a.md')).files)).toEqual(['a doc']);
  });
});

// Not on Windows: there local-file:// serves no file at all (its pathname,
// `/C:/...`, resolves to `C:\C:\...`). Runs on macOS and Linux.
describe.skipIf(onWindows)('5, 9. local-file://', () => {
  beforeEach(() => {
    protocols.clear();
    setupProtocolHandler();
  });
  const serve = async (file: string) => {
    const url = new URL('local-file://');
    url.pathname = file;
    return (await protocols.get('local-file')!({ url: url.href })).status;
  };

  it('5. refuses a file outside through a link, and since 2.0.4 a project\'s file too', async () => {
    expect(await serve(path.join(DATA_DIR, 'h', '.ssh', 'id_rsa'))).toBe(403);
    expect(await serve(path.join(DATA_DIR, 'p', 'hermes-webhook-secret'))).toBe(403);
    expect(await serve(path.join(project, 'escape', 'id_rsa'))).toBe(403);
    // What it serves since 2.0.4 is window-file-access.test.ts's W6.
    expect(await serve(path.join(project, 'docs-link', 'a.md'))).toBe(403);
  });

  it.skipIf(NO_FILE_LINKS)('9. refuses a file link to a markdown file outside: no dotfiles exception here', async () => {
    const notes = path.join(home, 'notes');
    fs.mkdirSync(notes, { recursive: true });
    fs.writeFileSync(path.join(notes, 'journal.md'), 'the journal');
    const at = path.join(project, 'journal.md');
    if (!fs.existsSync(at)) fs.symlinkSync(path.join(notes, 'journal.md'), at, 'file');
    expect(await serve(at)).toBe(403);
  });
});

describe.skipIf(NO_FILE_LINKS)('7, 8, 10. a file link out of every root', () => {
  const dotfiles = path.join(home, 'dotfiles');
  const globalMd = path.join(home, '.claude', 'CLAUDE.md');
  const link = (to: string, at: string) => { if (!fs.existsSync(at)) fs.symlinkSync(to, at, 'file'); };

  it('7. ~/.claude/CLAUDE.md linked to a dotfiles repository is read and saved, and a project\'s too', async () => {
    fs.mkdirSync(dotfiles, { recursive: true });
    fs.mkdirSync(path.dirname(globalMd), { recursive: true });
    fs.writeFileSync(path.join(dotfiles, 'CLAUDE.md'), 'global instructions');
    link(path.join(dotfiles, 'CLAUDE.md'), globalMd);
    expect((await readText(globalMd)).content).toBe('global instructions');
    expect((await writeText(globalMd, 'edited in the Brain page')).success).toBe(true);
    expect(fs.readFileSync(path.join(dotfiles, 'CLAUDE.md'), 'utf8')).toBe('edited in the Brain page');
    fs.writeFileSync(path.join(dotfiles, 'AGENTS.md'), 'shared agents');
    link(path.join(dotfiles, 'AGENTS.md'), path.join(project, 'AGENTS.shared.md'));
    expect((await readText(path.join(project, 'AGENTS.shared.md'))).content).toBe('shared agents');
  });

  it('10. fs:read-project-files reads the dotfiles markdown link, not a linked non-markdown or blocked file', async () => {
    fs.mkdirSync(dotfiles, { recursive: true });
    fs.mkdirSync(path.dirname(globalMd), { recursive: true });
    fs.writeFileSync(path.join(dotfiles, 'CLAUDE.md'), 'global instructions');
    fs.writeFileSync(path.join(dotfiles, 'mcp.json'), '{"mcpServers":{}}');
    link(path.join(dotfiles, 'CLAUDE.md'), globalMd);
    link(path.join(dotfiles, 'mcp.json'), path.join(project, '.mcp.json'));
    link(PROFILE, path.join(project, 'PROFILE.md'));
    expect(Object.values((await readProject(path.join(home, '.claude'), 'CLAUDE.md')).files)).toEqual(['global instructions']);
    expect((await readProject(project, '.mcp.json')).files).toEqual({});
    expect((await readProject(project, 'PROFILE.md')).files).toEqual({});
  });

  it('8. a file link to ~/.ssh or ~/.tars-private is still refused, to read and to write', async () => {
    link(KEY, path.join(DATA_DIR, 'k.md'));
    link(SECRET, path.join(project, 'NOTES.md'));
    for (const file of [path.join(DATA_DIR, 'k.md'), path.join(project, 'NOTES.md')]) {
      expect((await readText(file)).content, file).toBe('');
      expect((await writeText(file, 'overwritten')).success, file).toBe(false);
    }
    expect((await readProject(project, 'NOTES.md')).files).toEqual({});
    untouched();
  });
});

// Where no file link can be made, a link is stood in for by
// realpathSync.native reporting a name elsewhere, as it does for a link. The
// file at the name is a real one, so what the handler returns is its text:
// the assertion is only whether the read is let through.
describe('7, 10. simulated file links', () => {
  it('let the markdown one through, refuse the non-markdown and the blocked one', async () => {
    const dotfiles = path.join(home, 'dotfiles');
    fs.mkdirSync(dotfiles, { recursive: true });
    fs.writeFileSync(path.join(dotfiles, 'CLAUDE.md'), 'global instructions');
    fs.writeFileSync(path.join(dotfiles, 'mcp.json'), '{}');
    fs.writeFileSync(path.join(PRIVATE_DIR, 'talk.md'), 'the talk');
    const links: Record<string, string> = {
      'SIM-CLAUDE.md': path.join(dotfiles, 'CLAUDE.md'),
      'SIM-mcp.json': path.join(dotfiles, 'mcp.json'),
      'SIM-TALK.md': path.join(PRIVATE_DIR, 'talk.md'),
    };
    for (const name of Object.keys(links)) fs.writeFileSync(path.join(project, name), 'the name itself');
    const nodeFs = createRequire(import.meta.url)('node:fs') as { realpathSync: { native: (p: string, ...rest: unknown[]) => string } };
    const native = nodeFs.realpathSync.native;
    nodeFs.realpathSync.native = (p: string, ...rest: unknown[]) => {
      const name = Object.keys(links).find(n => p === path.join(project, n));
      return name ? links[name] : native(p, ...rest);
    };
    try {
      expect(Object.keys((await readProject(project, 'SIM-CLAUDE.md')).files)).toHaveLength(1);
      expect((await readProject(project, 'SIM-mcp.json')).files).toEqual({});
      expect((await readProject(project, 'SIM-TALK.md')).files).toEqual({});
      expect((await readText(path.join(project, 'SIM-CLAUDE.md'))).error).toBeUndefined();
      expect((await readText(path.join(project, 'SIM-mcp.json'))).error).toBeTruthy();
      expect((await readText(path.join(project, 'SIM-TALK.md'))).error).toBeTruthy();
    } finally {
      nodeFs.realpathSync.native = native;
      fs.rmSync(path.join(PRIVATE_DIR, 'talk.md'), { force: true });
    }
  });
});
