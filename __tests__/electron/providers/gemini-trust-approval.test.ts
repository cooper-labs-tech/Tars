import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { pinPlatform } from './win-fake-disk';

/**
 * A gemini agent's line trusts its folder and runs in its permission mode's approval mode.
 *
 * Measured on gemini 0.70.0 (23/11), its TUI in a PTY, isolated, on a stand-in of Gemini's API:
 * - its folder trust is on by default: in a folder it was never told to trust, it opens on "Do you trust the files in
 *   this folder?" (1. Trust folder, 2. Trust parent folder, 3. Don't trust), and a task typed then is taken by the
 *   question: Enter chose its first answer and the task was gone. `--skip-trust` trusts the current folder for that
 *   session, writing nothing;
 * - in its default approval mode, every tool call waits on a question, Tars's own MCP tools included ("Allow execution
 *   of MCP tool "whoami" from server "tars"?"), which nobody answers in an agent's terminal. `--approval-mode` takes
 *   default, auto_edit, yolo or plan.
 *
 * How it fails, written before the code:
 * 1. A gemini agent's line without `--skip-trust`: its first task, typed or on its line, goes to the trust question.
 * 2. A bypass agent's line without `--approval-mode yolo`: its first tool call, a reply to Tars among them, waits on a
 *    question for ever, and the task never ends.
 * 3. An auto agent's line without `--approval-mode auto_edit`, a plan agent's without `--approval-mode plan`: it runs in
 *    a mode other than the one the window shows.
 * 4. A normal agent's line with an approval mode: gemini no longer asks before a tool, as the user chose it would.
 * 5. The flags put after `-i <task>`, or between a flag and its value: gemini reads them as part of something else.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-trust-test-'));
});

afterEach(() => {
  unpin();
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function line(extra: Record<string, unknown> = {}) {
  const { GeminiProvider } = await import('../../../electron/providers/gemini-provider');
  return new GeminiProvider().buildInteractiveCommand({ binaryPath: '/usr/local/bin/gemini', ...extra } as never);
}

/** The line's words, as a POSIX shell splits it (single quotes only, as the provider writes it). */
function words(command: string): string[] {
  return [...command.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]));
}

describe('a gemini agent trusts its folder on its line (1, 5)', () => {
  it('passes --skip-trust with no task', async () => {
    expect(words(await line())).toContain('--skip-trust');
  });

  it('passes --skip-trust before -i and its task', async () => {
    const w = words(await line({ prompt: 'review the diff' }));
    expect(w).toContain('--skip-trust');
    expect(w.indexOf('--skip-trust')).toBeLessThan(w.indexOf('-i'));
    expect(w[w.indexOf('-i') + 1]).toBe('review the diff');
  });
});

describe('a gemini agent runs in its permission mode\'s approval mode (2, 3, 4, 5)', () => {
  it.each([
    ['bypass', 'yolo'],
    ['auto', 'auto_edit'],
    ['plan', 'plan'],
  ])('%s: --approval-mode %s, before -i', async (permissionMode, mode) => {
    const w = words(await line({ permissionMode, prompt: 'go' }));
    expect(w[w.indexOf('--approval-mode') + 1]).toBe(mode);
    expect(w.indexOf('--approval-mode')).toBeGreaterThan(0);
    expect(w.indexOf('--approval-mode')).toBeLessThan(w.indexOf('-i'));
  });

  it.each([['normal'], [undefined]])('%s: no approval mode, so gemini asks before a tool', async (permissionMode) => {
    const w = words(await line({ permissionMode, prompt: 'go' }));
    expect(w).not.toContain('--approval-mode');
    expect(w).not.toContain('--yolo');
    expect(w).not.toContain('-y');
  });
});
