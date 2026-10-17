import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The git that makes an agent's worktree runs in the C locale, on every host.
 *
 * makeAgentWorktree shows git's own refusal ("fatal: ...") as the reason a
 * worktree could not be made (#417, #420). A translated git writes that line
 * in its own language, so the calls carry LC_ALL=C.
 * e2e/agent-update-worktree-reason.spec.ts proves it with a French git on
 * macOS and Linux, and skips on Windows, where none of its stand-ins can run.
 * This runs on every host, Windows included (the Audit's Low on #425). git is
 * a stub here: nothing reaches a real one.
 *
 * How it can fail, written down before this test (2026-10-17). The code it
 * pins came first (#417), so each case is shown to bite by a mutant of it:
 * 1. A git call that makes the worktree runs without LC_ALL=C.
 * 2. One call has it and another does not: the branch probe, or the add.
 * 3. Setting it drops the rest of the environment, so git runs without the
 *    PATH or the HOME it needs.
 * 4. What the window is told is not git's own refusal, read in that locale.
 */

const { gitCalls, tmpHome } = vi.hoisted(() => ({
  gitCalls: [] as Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv | undefined }>,
  tmpHome: `${(process.env.TMPDIR || process.env.TEMP || '/tmp').replace(/[\\/]$/, '')}/tars-worktree-locale-${process.pid}-${Date.now()}`,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron-updater', () => ({ autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn() } }));
vi.mock('electron', () => ({
  app: { getPath: () => tmpHome, getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '2.0.3', getName: () => 'Tars', on: vi.fn(), whenReady: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
  ipcMain: { handle: (channel: string, handler: unknown) => { handlers.set(channel, handler as Handler); } },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

// git, by its name or by the full path of a git.exe (gitCommand() on win32):
// the probe finds no branch, and the add refuses the way git does.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const isGit = (file: unknown) => /(^|[\\/])git(\.exe)?$/i.test(String(file));
  const execFileSync = ((file: string, args?: readonly string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    if (!isGit(file)) return (real.execFileSync as (...a: unknown[]) => unknown)(file, args, opts);
    gitCalls.push({ file, args: [...(args ?? [])], env: opts?.env });
    if (args?.[0] === 'rev-parse') throw Object.assign(new Error('Command failed: git rev-parse'), { status: 1, stderr: Buffer.from('') });
    throw Object.assign(new Error('Command failed: git worktree add'), {
      status: 128,
      stderr: Buffer.from("Preparing worktree (new branch 'feature-x')\nfatal: could not create directory of '.worktrees/feature-x': Permission denied\n"),
    });
  }) as typeof real.execFileSync;
  return { ...real, execFileSync, default: { ...real, execFileSync } };
});

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const handlers = new Map<string, Handler>();

import { registerIpcHandlers, type IpcHandlerDependencies } from '../../../electron/handlers/ipc-handlers';
import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import type { AppSettings } from '../../../electron/types';

fs.mkdirSync(tmpHome, { recursive: true });
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-worktree-locale-project-'));

function deps(): IpcHandlerDependencies {
  const fixed: Record<string, unknown> = { agents, ptyProcesses, saveAgents: vi.fn(), getAppSettings: () => ({} as AppSettings) };
  return new Proxy(fixed, {
    get(target, key: string) {
      if (key in target) return target[key];
      target[key] = key.endsWith('ptyProcesses') ? new Map() : vi.fn();
      return target[key];
    },
  }) as unknown as IpcHandlerDependencies;
}
registerIpcHandlers(deps());

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterAll(() => {
  Object.defineProperty(process, 'platform', hostPlatform);
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/** agent:create asked for a worktree on a new branch, as a given platform. */
async function create(platform: NodeJS.Platform): Promise<string> {
  gitCalls.length = 0;
  Object.defineProperty(process, 'platform', { ...hostPlatform, value: platform });
  try {
    await handlers.get('agent:create')!({}, { projectPath: project, skills: [], worktree: { enabled: true, branchName: 'feature-x' } });
    return 'made';
  } catch (err) {
    return (err as Error).message;
  } finally {
    Object.defineProperty(process, 'platform', hostPlatform);
  }
}

describe.each(['darwin', 'linux', 'win32'] as const)('the worktree git, as %s', (platform) => {
  it('1, 2. every call carries LC_ALL=C: the branch probe and the add', async () => {
    await create(platform);

    expect(gitCalls.map(c => c.args.slice(0, 2))).toEqual([['rev-parse', '--verify'], ['worktree', 'add']]);
    for (const call of gitCalls) expect(call.env?.LC_ALL, call.args.join(' ')).toBe('C');
  });

  it('3. keeps the rest of the environment as it is', async () => {
    await create(platform);

    const withoutLocale = (env: NodeJS.ProcessEnv | undefined) => Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => key !== 'LC_ALL'));
    for (const call of gitCalls) expect(withoutLocale(call.env), call.args.join(' ')).toEqual(withoutLocale(process.env));
  });

  it('4. tells the window git\'s own refusal, without its progress or "fatal: "', async () => {
    const answer = await create(platform);

    expect(answer).toBe("The worktree could not be made: could not create directory of '.worktrees/feature-x': Permission denied");
  });
});
