import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { pinPlatform } from './win-fake-disk';

/**
 * The folders a gemini agent's line adds are trusted in gemini's own store, so gemini asks nothing about them.
 *
 * Measured on gemini 0.70.0 (24/11), its TUI in a PTY, isolated, on a stand-in of Gemini's API: a folder added with
 * `--include-directories`, as Tars adds `~/.tars` (and an agent's secondary folder, a template's vault), opens a question
 * whenever it is not trusted in `~/.gemini/trustedFolders.json`: "Do you trust the following folders being added to this
 * workspace?" (Yes; Yes, and remember the directories as trusted; No). `--skip-trust` trusts the workspace only, not
 * the added folders. A task on the line runs under the question, but the question stays on the screen, and a task
 * typed into the terminal answers it and is lost: the harness conformance's first gemini run, its delegated task never
 * begun. With the folder in trustedFolders.json as `TRUST_FOLDER` beforehand, no question.
 *
 * How it fails, written before the code:
 * 1. The added folders not in trustedFolders.json once the line is built: gemini asks, and the first typed task is lost.
 * 2. The user's own entries there removed or changed.
 * 3. A folder that trusts too much written there: the home folder, or the root, whose trust would cover every folder
 *    below it (as for claude and codex, utils/trust-too-much.ts).
 * 4. A trustedFolders.json that is not JSON replaced: the user's trust gone.
 * 5. The file written again when every folder is already there.
 * 6. A parent trusted (`TRUST_PARENT`) where the folder alone was asked for.
 *
 * The file is the user's, read by gemini 0.70.0 as `JSON.parse(stripJsonComments(content))`, its keys compared
 * case-insensitively on macOS and Windows (`normalizePath`), written by gemini atomically at mode 0600 (its
 * `saveTrustedFolders`), measured in its bundle on 24/11. Written after the code above, on the orchestrator's review
 * (the rule #634 set for gemini's settings file), and red on it where marked:
 * 7. A decision the user made about the same folder (TRUST_PARENT, DO_NOT_TRUST) overwritten with Tars's (red).
 * 8. On macOS, the folder written again under its own spelling when the user's file has it in another case, which gemini
 *    reads as the same folder (red).
 * 9. A file Tars creates more open than gemini's own, 0600 (red).
 * 10. An existing file's mode changed (holds: the shared writer keeps it).
 * 11. A commented file, which gemini reads, replaced or rewritten without its comments: until #634's JSONC writer is in,
 *     Tars writes nothing to it and says so, the line is still built, and gemini asks (holds).
 * 12. A file that is JSON but not an object left without a word (red).
 */

let tmpDir: string;
let unpin: () => void;

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => tmpDir };
});

beforeEach(() => {
  vi.resetModules();
  unpin = pinPlatform('linux');
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-added-trust-test-')));
  fs.mkdirSync(path.join(tmpDir, '.tars'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  unpin();
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

const store = () => path.join(tmpDir, '.gemini', 'trustedFolders.json');
const read = () => JSON.parse(fs.readFileSync(store(), 'utf8')) as Record<string, string>;

async function line(extra: Record<string, unknown> = {}) {
  const { GeminiProvider } = await import('../../../electron/providers/gemini-provider');
  return new GeminiProvider().buildInteractiveCommand({ binaryPath: '/usr/local/bin/gemini', prompt: 'go', ...extra } as never);
}

describe("a gemini agent's added folders are trusted in gemini's store (1, 6)", () => {
  it('trusts ~/.tars, the folder every gemini line adds, as TRUST_FOLDER', async () => {
    await line();
    expect(read()[path.join(tmpDir, '.tars')]).toBe('TRUST_FOLDER');
  });

  it('trusts the secondary folder the line adds too', async () => {
    const secondary = path.join(tmpDir, 'work', 'other');
    fs.mkdirSync(secondary, { recursive: true });
    const command = await line({ secondaryProjectPath: secondary });
    expect(command).toContain(secondary);
    expect(read()[secondary]).toBe('TRUST_FOLDER');
  });
});

describe("the user's own trust is kept (2, 4, 5)", () => {
  it('keeps the entries already there', async () => {
    fs.mkdirSync(path.dirname(store()), { recursive: true });
    fs.writeFileSync(store(), JSON.stringify({ '/home/me/code': 'TRUST_PARENT', '/home/me/untrusted': 'DO_NOT_TRUST' }));
    await line();
    expect(read()).toMatchObject({ '/home/me/code': 'TRUST_PARENT', '/home/me/untrusted': 'DO_NOT_TRUST', [path.join(tmpDir, '.tars')]: 'TRUST_FOLDER' });
  });

  it('leaves a file that is not JSON as it was', async () => {
    fs.mkdirSync(path.dirname(store()), { recursive: true });
    fs.writeFileSync(store(), '{ not json');
    await line();
    expect(fs.readFileSync(store(), 'utf8')).toBe('{ not json');
  });

  it('does not write the file again when every folder is already trusted', async () => {
    await line();
    const before = fs.statSync(store()).mtimeMs;
    const content = fs.readFileSync(store(), 'utf8');
    await new Promise((r) => setTimeout(r, 20));
    await line();
    expect(fs.readFileSync(store(), 'utf8')).toBe(content);
    expect(fs.statSync(store()).mtimeMs).toBe(before);
  });
});

describe("the file is the user's: read and written as gemini does (7 to 12)", () => {
  const tars = () => path.join(tmpDir, '.tars');
  const seed = (content: string, mode = 0o600) => {
    fs.mkdirSync(path.dirname(store()), { recursive: true });
    fs.writeFileSync(store(), content, { mode });
    fs.chmodSync(store(), mode);
  };

  it('7. keeps the decision the user made about the same folder', async () => {
    seed(JSON.stringify({ [tars()]: 'DO_NOT_TRUST' }));
    await line();
    expect(read()[tars()]).toBe('DO_NOT_TRUST');
  });

  it('8. on macOS, reads a key in another case as the same folder, as gemini does, and adds nothing', async () => {
    unpin();
    unpin = pinPlatform('darwin');
    const content = JSON.stringify({ [tars().toUpperCase()]: 'TRUST_FOLDER' });
    seed(content);
    await line();
    expect(fs.readFileSync(store(), 'utf8')).toBe(content);
  });

  it('9. creates the file at 0600, as gemini creates it', async () => {
    await line();
    expect(fs.statSync(store()).mode & 0o777).toBe(0o600);
  });

  it("10. keeps an existing file's mode", async () => {
    seed(JSON.stringify({ '/home/me/code': 'TRUST_FOLDER' }), 0o640);
    await line();
    expect(read()[tars()]).toBe('TRUST_FOLDER');
    expect(fs.statSync(store()).mode & 0o777).toBe(0o640);
  });

  it('11. leaves a commented file exactly as it was, says so, and the line is still built', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const content = '{\n  // the user\'s own note\n  "/home/me/code": "TRUST_FOLDER"\n}\n';
    seed(content);
    const command = await line();
    expect(command).toContain('--include-directories');
    expect(fs.readFileSync(store(), 'utf8')).toBe(content);
    expect(warn.mock.calls.flat().join(' ')).toContain(store());
  });

  it('12. leaves a file that is JSON but not an object, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    seed('["/home/me/code"]\n');
    await line();
    expect(fs.readFileSync(store(), 'utf8')).toBe('["/home/me/code"]\n');
    expect(warn.mock.calls.flat().join(' ')).toContain(store());
  });
});

describe('never a folder that trusts too much (3)', () => {
  it('writes neither the home folder nor the root, even when the line adds them', async () => {
    await line({ secondaryProjectPath: tmpDir });
    const trusted = fs.existsSync(store()) ? read() : {};
    expect(trusted[tmpDir]).toBeUndefined();
    expect(trusted['/']).toBeUndefined();
  });
});
