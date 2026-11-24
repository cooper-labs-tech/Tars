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
    fs.writeFileSync(store(), JSON.stringify({ '/Users/me/code': 'TRUST_PARENT', '/Users/me/untrusted': 'DO_NOT_TRUST' }));
    await line();
    expect(read()).toMatchObject({ '/Users/me/code': 'TRUST_PARENT', '/Users/me/untrusted': 'DO_NOT_TRUST', [path.join(tmpDir, '.tars')]: 'TRUST_FOLDER' });
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

describe('never a folder that trusts too much (3)', () => {
  it('writes neither the home folder nor the root, even when the line adds them', async () => {
    await line({ secondaryProjectPath: tmpDir });
    const trusted = fs.existsSync(store()) ? read() : {};
    expect(trusted[tmpDir]).toBeUndefined();
    expect(trusted['/']).toBeUndefined();
  });
});
