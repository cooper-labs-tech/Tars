import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Tars turning its status line off must not delete somebody else's.
 *
 * `statusLine` is Claude Code's setting, not Tars's. A user can point it at a
 * script of their own, and Claude Code can write it itself. `disableStatusLine`
 * deleted the key by name whatever it held, and the startup sync called it on
 * every launch for anyone who had never opened that switch, because the
 * setting defaulted to false two hundred lines above a check reading `!== false`
 * as "on". Measured on a bit-identical copy of the real file: ten keys before
 * the app started, nine after, and no save involved.
 *
 * The file is written here in a temp HOME. The live one is never opened.
 */

const { tmpHome, tmpData } = vi.hoisted(() => {
  const base = `${process.env.TMPDIR?.replace(/\/$/, '') || '/tmp'}/tars-statusline-${process.pid}-${Date.now()}`;
  return { tmpHome: base, tmpData: `${base}/data` };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
// The main process's own app: on win32 the status line is the bundled
// hooks/statusline.mjs, found through app.getAppPath(), which is this checkout.
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }));
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/constants')>();
  return { ...actual, DATA_DIR: tmpData, dataPath: (f: string) => path.join(tmpData, f) };
});

const SETTINGS = path.join(tmpHome, '.claude', 'settings.json');
const OUR_SCRIPT = path.join(tmpData, 'statusline.sh');
/** What turning it on points the entry at: the Node status line, on every platform since 2.0.4 (no launcher prepared here). */
const OUR_COMMAND = `node "${path.join(process.cwd(), 'hooks', 'statusline.mjs').replace(/\\/g, '/')}"`;

/** The shape of the real file: the key under test, and the nine around it. */
function settingsWith(statusLine: unknown): Record<string, unknown> {
  const file: Record<string, unknown> = {
    includeCoAuthoredBy: true,
    permissions: { allow: ['Bash(npm run test:*)'], defaultMode: 'acceptEdits' },
    model: 'opus',
    hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '~/.claude/hooks/stop.sh' }] }] },
    enabledPlugins: { 'vercel@marketplace': true },
    extraKnownMarketplaces: { marketplace: { source: { source: 'github', repo: 'x/y' } } },
    tui: { theme: 'dark' },
    skipDangerousModePermissionPrompt: true,
    theme: 'dark',
  };
  if (statusLine !== undefined) file.statusLine = statusLine;
  return file;
}

function write(file: Record<string, unknown>): void {
  fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(file, null, 2));
}

const onDisk = () => JSON.parse(fs.readFileSync(SETTINGS, 'utf-8')) as Record<string, unknown>;

async function load() {
  vi.resetModules();
  return import('../../../electron/utils/statusline');
}

beforeEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.mkdirSync(tmpData, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('turning the Tars status line off', () => {
  it('leaves a status line pointing at somebody else\'s script alone', async () => {
    const theirs = { type: 'command', command: '/Users/you/bin/my-own-statusline.sh', padding: 0 };
    write(settingsWith(theirs));

    const { disableStatusLine } = await load();
    disableStatusLine();

    // Their setting, their script. Turning ours off means stop using ours,
    // never delete whichever status line happens to be configured.
    expect(onDisk().statusLine).toEqual(theirs);
    expect(Object.keys(onDisk())).toHaveLength(10);
  });

  it('removes the entry when it is the one Tars installed', async () => {
    write(settingsWith({ type: 'command', command: OUR_SCRIPT, padding: 0 }));

    const { disableStatusLine } = await load();
    disableStatusLine();

    expect(onDisk().statusLine).toBeUndefined();
    // And only that one: the other nine are still there. A write that did not
    // read first would have left one key in the file.
    expect(Object.keys(onDisk())).toHaveLength(9);
    expect(onDisk().hooks).toEqual(settingsWith(undefined).hooks);
  });

  it('takes its own script off disk either way', async () => {
    fs.writeFileSync(OUR_SCRIPT, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    write(settingsWith({ type: 'command', command: '/somewhere/else.sh' }));

    const { disableStatusLine } = await load();
    disableStatusLine();

    // Off means stop running ours, which is true whoever owns the entry.
    expect(fs.existsSync(OUR_SCRIPT)).toBe(false);
  });

  it('touches nothing when no status line is configured at all', async () => {
    write(settingsWith(undefined));
    const before = fs.readFileSync(SETTINGS, 'utf-8');

    const { disableStatusLine } = await load();
    disableStatusLine();

    // Not even a rewrite: an absent key is not something to remove, and
    // rewriting the file to change nothing is a chance to lose something.
    expect(fs.readFileSync(SETTINGS, 'utf-8')).toBe(before);
  });
});

describe('turning it on', () => {
  it('points the entry at Tars\'s own script and keeps the rest of the file', async () => {
    write(settingsWith(undefined));

    const { enableStatusLine } = await load();
    enableStatusLine();

    expect((onDisk().statusLine as { command: string }).command).toBe(OUR_COMMAND);
    expect(Object.keys(onDisk())).toHaveLength(10);
    expect(onDisk().model).toBe('opus');
  });

  it('replaces somebody else\'s entry, which is what asking for ours means', async () => {
    write(settingsWith({ type: 'command', command: '/Users/you/bin/my-own-statusline.sh' }));

    const { enableStatusLine } = await load();
    enableStatusLine();

    // The asymmetry is deliberate: switching ours on is a choice about which
    // script runs, switching it off is not a licence to delete theirs.
    expect((onDisk().statusLine as { command: string }).command).toBe(OUR_COMMAND);
  });
});

/**
 * The other half of the fix, which is a default that has to stay absent.
 *
 * Read from the source because there is nowhere else to read it: this lives in
 * `main.ts`, which starts the application when imported. What it protects is a
 * value NOT being written, and the failure is a launch deleting a key out of
 * another program's configuration, so it is worth a case that cannot run.
 */
describe('the startup sync', () => {
  const mainSource = () => fs.readFileSync(path.join(process.cwd(), 'electron', 'main.ts'), 'utf-8');

  it('does not default statusLineEnabled, so absent stays unchosen', () => {
    expect(mainSource()).not.toMatch(/statusLineEnabled:\s*(true|false)/);
  });

  it('acts only on an explicit choice, never on an absent one', () => {
    const source = mainSource();
    // `!== false` was the whole bug: absent read as on for the comment above it
    // and as off for the default below it, and the else branch deleted the key.
    expect(source).not.toContain('appSettings.statusLineEnabled !== false');
    expect(source).toContain('appSettings.statusLineEnabled === true');
    expect(source).toContain('appSettings.statusLineEnabled === false');
  });
});
