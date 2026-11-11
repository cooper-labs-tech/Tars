/**
 * Claude Code started for an account on Windows (services/claude-accounts/auth.ts
 * and usage-probe.ts; the parity program's P6, the plumbing behind the gate
 * that still keeps the accounts off there, platform/claude-accounts.ts).
 *
 * Windows starts neither a bare name (libuv applies no PATHEXT) nor an npm
 * .cmd shim (Node refuses one without a shell since CVE-2024-27980), and
 * `claude auth status`, `claude auth logout`, the sign-in terminal and the
 * usage probe all started `claude` by its name or as configured.
 *
 * How it fails, written before the code (2026-10-17):
 * 1. win32: a command starts the binary as given, not as the platform layer
 *    resolves it (resolveCliBinary: node.exe and the shim's script for an npm
 *    install, the .exe of a native one).
 * 2. win32: a binary the resolver cannot start throws out of the check, or
 *    reads as signed out: the check fails, with the resolver's reason.
 * 3. win32: the usage probe opens a console window (detached makes one of its
 *    own there), or is ended through a process group Windows does not have,
 *    which leaves what it started: it is ended as every probe there, its tree
 *    by taskkill (endProbe).
 * 4. win32: the PATH is written again beside Windows's own `Path`, and which
 *    one a program reads is a matter of chance.
 * 5. darwin and linux change: the binary as given, the PATH as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CMD_SHIM_NODE } from '../services/cli-updater-windows-fakes';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const SCRIPT = 'C:\\Users\\sam\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
/** An id no process has: main's own probe ended `-pid`, a whole group. */
const NO_SUCH_PID = 1_073_741_823;

const SIGNED_IN = '{"loggedIn": true, "authMethod": "claude.ai", "email": "sam@example.com", "subscriptionType": "max"}\n';
const host = vi.hoisted(() => ({
  stubbed: false,
  spawned: [] as { file: string; args: string[]; options: Record<string, unknown> }[],
  answer: '',
  taskkills: [] as string[][],
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const spawn = ((file: string, args: string[], options: Record<string, unknown>) => {
    if (!host.stubbed) return (actual.spawn as (...a: unknown[]) => unknown)(file, args, options);
    host.spawned.push({ file, args, options });
    const child = Object.assign(new EventEmitter(), {
      pid: NO_SUCH_PID, exitCode: null as number | null, signalCode: null as string | null,
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      kill: () => true,
    });
    // auth answers and exits; the probe never answers and is ended.
    if (args.includes('auth')) {
      setImmediate(() => {
        child.stdout.end(host.answer);
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
    }
    return child;
  }) as unknown as typeof actual.spawn;
  const execFile = ((file: string, ...rest: unknown[]) => {
    if (host.stubbed && /taskkill\.exe$/i.test(file)) {
      host.taskkills.push(rest[0] as string[]);
      const done = rest[rest.length - 1];
      if (typeof done === 'function') setImmediate(() => (done as (e: null) => void)(null));
      return undefined;
    }
    return (actual.execFile as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.execFile;
  return { ...actual, spawn, execFile, default: { ...actual, spawn, execFile } };
});

vi.mock('../../../electron/platform/cli-binary', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../electron/platform/cli-binary')>();
  return {
    ...real,
    // The resolver itself is held by cli-binary.test.ts: here, what Windows would answer for an npm install.
    resolveCliBinary: (name: string, env: Record<string, string | undefined>, platform: NodeJS.Platform, fs?: unknown) => {
      if (platform !== 'win32' || !host.stubbed) return real.resolveCliBinary(name, env, platform, fs as never);
      if (name === 'claude') return { ok: true, file: NODE, prefixArgs: [SCRIPT], via: 'npm-shim-node' };
      return { ok: false, reason: 'not-found', name, detail: `${name} is not on the PATH with an extension from PATHEXT (.COM;.EXE;.BAT;.CMD).` };
    },
  };
});

import { claudeAuthStatus, claudeAuthLogout, loginCommand } from '../../../electron/services/claude-accounts/auth';
import { probeUsage, usageProbeEnv } from '../../../electron/services/claude-accounts/usage-probe';

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const readAs = (platform: NodeJS.Platform) => {
  Object.defineProperty(process, 'platform', { ...hostPlatform, value: platform });
  // Windows's own spelling of the PATH, which the product must write over, not beside.
  if (platform === 'win32') process.env.Path = 'C:\\Windows\\system32';
};
const dir = 'C:\\Users\\sam\\.claude-accounts\\acct-a1b2c3';

beforeEach(() => {
  host.stubbed = true;
  host.spawned.length = 0;
  host.taskkills.length = 0;
  host.answer = SIGNED_IN;
});
afterEach(() => {
  host.stubbed = false;
  Object.defineProperty(process, 'platform', hostPlatform);
  delete process.env.Path;
  vi.restoreAllMocks();
});

const pathKeys = (env: Record<string, unknown>) => Object.keys(env).filter((k) => k.toLowerCase() === 'path');

describe('on Windows', () => {
  it('1, 4. asks claude auth status of node and the npm script, the PATH written once', async () => {
    readAs('win32');
    const state = await claudeAuthStatus('claude', dir);
    expect(state).toMatchObject({ signedIn: true, email: 'sam@example.com' });
    expect(host.spawned[0].file).toBe(NODE);
    expect(host.spawned[0].args).toEqual([SCRIPT, 'auth', 'status']);
    expect(host.spawned[0].options).toMatchObject({ windowsHide: true, detached: false });
    expect(pathKeys(host.spawned[0].options.env as Record<string, unknown>)).toHaveLength(1);
  });

  it('1. signs out through node and the npm script too', async () => {
    readAs('win32');
    host.answer = '';
    await claudeAuthLogout('claude', dir);
    expect(host.spawned[0].file).toBe(NODE);
    expect(host.spawned[0].args).toEqual([SCRIPT, 'auth', 'logout']);
  });

  it('2. fails a check whose binary cannot be started, with the reason, and starts nothing', async () => {
    readAs('win32');
    await expect(claudeAuthStatus('missing', dir)).rejects.toThrow(/could not run: .*PATHEXT/);
    expect(host.spawned).toEqual([]);
  });

  it('1, 4. opens the sign-in terminal on node and the npm script, the PATH written once', () => {
    readAs('win32');
    const command = loginCommand('claude', dir, { Path: 'C:\\Windows\\system32', SystemRoot: 'C:\\Windows' });
    expect(command.file).toBe(NODE);
    expect(command.args).toEqual([SCRIPT, 'auth', 'login', '--claudeai']);
    expect(command.env.CLAUDE_CONFIG_DIR).toBe(dir);
    expect(pathKeys(command.env)).toHaveLength(1);
  });

  it('1, 3, 4. starts the usage probe on node and the npm script, with no console window, and ends its tree by taskkill', async () => {
    readAs('win32');
    const killed = vi.spyOn(process, 'kill');
    await expect(probeUsage('claude', usageProbeEnv(dir), 50)).rejects.toThrow(/did not answer/);
    expect(host.spawned[0].file).toBe(NODE);
    expect(host.spawned[0].args[0]).toBe(SCRIPT);
    expect(host.spawned[0].options).toMatchObject({ windowsHide: true, detached: false });
    expect(pathKeys(host.spawned[0].options.env as Record<string, unknown>)).toHaveLength(1);
    expect(host.taskkills.some((args) => args.includes(String(NO_SUCH_PID)))).toBe(true);
    expect(killed.mock.calls.some(([pid]) => Number(pid) < 0)).toBe(false);
  });
});

describe.each(['darwin', 'linux'] as const)('on %s', (platform) => {
  it('5. starts the binary as given, in a group of its own, and the PATH as before', async () => {
    readAs(platform);
    await claudeAuthStatus('/opt/claude/bin/claude', dir);
    expect(host.spawned[0].file).toBe('/opt/claude/bin/claude');
    expect(host.spawned[0].args).toEqual(['auth', 'status']);
    expect(host.spawned[0].options).toMatchObject({ detached: true });
    expect(pathKeys(host.spawned[0].options.env as Record<string, unknown>)).toEqual(['PATH']);
    const command = loginCommand('/opt/claude/bin/claude', dir, { PATH: '/usr/bin' });
    expect(command.file).toBe('/opt/claude/bin/claude');
    expect(command.args).toEqual(['auth', 'login', '--claudeai']);
  });
});

/** The real thing on a Windows host: a claude installed by npm, behind its .cmd shim. */
describe.skipIf(hostPlatform.value !== 'win32')('on a real Windows', () => {
  it('1. reads claude auth status through the npm shim', async () => {
    host.stubbed = false;
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-auth-win-'));
    fs.writeFileSync(path.join(bin, 'cli.js'), `process.stdout.write(${JSON.stringify(SIGNED_IN)})`);
    fs.writeFileSync(path.join(bin, 'claude.cmd'), CMD_SHIM_NODE('cli.js'));
    await expect(claudeAuthStatus(path.join(bin, 'claude.cmd'), dir)).resolves.toMatchObject({ signedIn: true });
  }, 30_000);
});
