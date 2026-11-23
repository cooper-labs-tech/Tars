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
 * 3. An auto agent's line without `--approval-mode auto_edit`: it runs in a mode other than the one the window shows.
 * 3b. A plan for gemini let through: Tars has no plan mode for gemini (hasPlanMode is claude's and Qwen Code's), so a
 *    gemini agent in plan is refused before any line is built (planModeRefusal, at creation, by the API and by an
 *    update); a line that mapped plan would be a branch nothing reaches (the Audit's I-1 on #636).
 * 4. A normal agent's line with an approval mode: gemini no longer asks before a tool, as the user chose it would.
 * 5. The flags put after `-i <task>`, or between a flag and its value: gemini reads them as part of something else.
 *
 * Resume (measured the same day): gemini's hooks report its session's UUID (`session_id`, SessionStart `source:
 * "startup"`), and `--resume <that uuid>` continues it (SessionStart `source: "resume"`, the same id, the first task's
 * turns in its next request); gemini also takes `latest` or an index there.
 * 6. A gemini agent started again (Tars restarted, a durable restart) without `--resume <its session>`: a new session,
 *    the agent's conversation gone.
 * 7. A session id that is not a UUID put on its line: `latest`, an index or a crafted word would resume another
 *    session, or reach the shell.
 * 8. A fork resumed in place: gemini has no fork, so a launch asked to fork starts a new session rather than writing
 *    into the one it forks from.
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

describe('a gemini agent runs in its permission mode\'s approval mode (2, 3, 3b, 4, 5)', () => {
  it.each([
    ['bypass', 'yolo'],
    ['auto', 'auto_edit'],
  ])('%s: --approval-mode %s, before -i', async (permissionMode, mode) => {
    const w = words(await line({ permissionMode, prompt: 'go' }));
    expect(w[w.indexOf('--approval-mode') + 1]).toBe(mode);
    expect(w.indexOf('--approval-mode')).toBeGreaterThan(0);
    expect(w.indexOf('--approval-mode')).toBeLessThan(w.indexOf('-i'));
  });

  it('plan: refused for gemini before any line is built, and no line maps it', async () => {
    const { planModeRefusal } = await import('../../../electron/providers/plan-mode');
    expect(planModeRefusal('gemini', 'plan')).toMatch(/no plan mode/);
    const { geminiApprovalMode } = await import('../../../electron/providers/gemini-provider');
    expect(geminiApprovalMode('plan')).toBeNull();
  });

  it.each([['normal'], [undefined]])('%s: no approval mode, so gemini asks before a tool', async (permissionMode) => {
    const w = words(await line({ permissionMode, prompt: 'go' }));
    expect(w).not.toContain('--approval-mode');
    expect(w).not.toContain('--yolo');
    expect(w).not.toContain('-y');
  });
});

describe('a gemini agent resumes its own session (6, 7, 8)', () => {
  const SESSION = '707f5907-38d6-47f7-b7ac-e6f16d78c1b2';

  it('passes --resume <its session> before -i', async () => {
    const w = words(await line({ resumeSessionId: SESSION, prompt: 'go on' }));
    expect(w[w.indexOf('--resume') + 1]).toBe(SESSION);
    expect(w.indexOf('--resume')).toBeLessThan(w.indexOf('-i'));
  });

  it('passes --resume with no task', async () => {
    const w = words(await line({ resumeSessionId: SESSION }));
    expect(w[w.indexOf('--resume') + 1]).toBe(SESSION);
  });

  it.each([['latest'], ['5'], ["x'; touch /tmp/owned; '"], ['']])('never resumes %j, which is no session of its own', async (id) => {
    const command = await line({ resumeSessionId: id, prompt: 'go' });
    expect(words(command)).not.toContain('--resume');
    expect(command).not.toContain('owned');
  });

  it('starts a new session when asked to fork, gemini having no fork', async () => {
    const w = words(await line({ resumeSessionId: SESSION, forkSession: true, prompt: 'go' }));
    expect(w).not.toContain('--resume');
    expect(w).not.toContain(SESSION);
  });
});
