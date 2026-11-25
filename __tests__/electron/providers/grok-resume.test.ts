import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { pinPlatform } from './win-fake-disk';

/**
 * A grok agent started again resumes its own session.
 *
 * Measured on grok 1.0.92 (23/11), its TUI in a PTY, isolated, against a local stand-in model: its hooks report its
 * session's id (`session_id`, a uuid, SessionStart `source: "new"`), and `--resume <that id>` continues it
 * (SessionStart `source: "load"`, the same id, the first task's turns in its next request). Its --help: `-r, --resume
 * [<SESSION_ID_OR_TITLE>]` ("the most recent if omitted") and `--fork-session` ("when resuming, create a new session
 * ID instead of reusing the original").
 *
 * How it fails, written before the code:
 * 1. A grok agent started again (Tars restarted, a durable restart) without `--resume <its session>`: a new session,
 *    the agent's conversation gone.
 * 2. A session id that is not a uuid put on its line: a title or a crafted word would resume another session, or reach
 *    the shell; an empty one would resume the most recent session, whoever's it is.
 * 3. A fork resumed in place: the launch asked to fork writes into the session it forks from.
 * 4. The resume placed after the task: grok reads it as part of the prompt.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-resume-test-'));
});

afterEach(() => {
  unpin();
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function line(extra: Record<string, unknown> = {}) {
  const { GrokProvider } = await import('../../../electron/providers/grok-provider');
  return new GrokProvider().buildInteractiveCommand({ binaryPath: '/usr/local/bin/grok', ...extra } as never);
}

/** The line's words, as a POSIX shell splits it (single quotes only, as the provider writes it). */
function words(command: string): string[] {
  return [...command.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]));
}

const SESSION = '01a209b5-4b52-7662-8587-8afff0fb0bd0';

describe('a grok agent resumes its own session (1, 4)', () => {
  it('passes --resume <its session> before its task', async () => {
    const w = words(await line({ resumeSessionId: SESSION, prompt: 'go on' }));
    expect(w[w.indexOf('--resume') + 1]).toBe(SESSION);
    expect(w.indexOf('--resume')).toBeLessThan(w.indexOf('go on'));
  });

  it('passes --resume with no task', async () => {
    const w = words(await line({ resumeSessionId: SESSION }));
    expect(w[w.indexOf('--resume') + 1]).toBe(SESSION);
  });
});

describe('a grok agent never resumes what is not its own session (2, 3)', () => {
  it.each([['a session title'], ["x'; touch /tmp/owned; '"], ['']])('never resumes %j', async (id) => {
    const command = await line({ resumeSessionId: id, prompt: 'go' });
    expect(words(command)).not.toContain('--resume');
    expect(words(command)).not.toContain('-r');
    expect(command).not.toContain('owned');
  });

  it('forks with grok\'s own --fork-session, so the session it forks from is left as it was', async () => {
    const w = words(await line({ resumeSessionId: SESSION, forkSession: true, prompt: 'go' }));
    expect(w[w.indexOf('--resume') + 1]).toBe(SESSION);
    expect(w).toContain('--fork-session');
  });
});
