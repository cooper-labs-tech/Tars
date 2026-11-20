import '../../setup/home-guard';
import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as nodePty from 'node-pty';
import type * as pty from 'node-pty';
import { windowsSoundCommand, agentShell, resolveShell, shellArgs, childEnv } from '../../../electron/platform';
import { spawnAgentPty } from '../../../electron/core/agent-pty';
import { killPty as endTerminal } from '../../../electron/core/pty-kill';
import { pwsh7ModulePath, withModulePath } from './pwsh7-module-path';

/**
 * Windows PowerShell 5.1 started by Tars when Tars itself was started from
 * PowerShell 7 (a developer's shell, a user's Windows Terminal, CI's step
 * shell): the child inherits PowerShell 7's PSModulePath, finds its Core-only
 * modules first, cannot load them, and loses core cmdlets. It says so on
 * stderr and may exit 0. Real spawns, the way Tars makes them, under that
 * parent environment (emulated: pwsh7-module-path.ts).
 *
 * How it fails, written before the code:
 * 1. The notification sound's fixed script (New-Object, from
 *    Microsoft.PowerShell.Utility) fails: nothing plays, stderr names
 *    New-Object, and utils/index.ts logs a failure for a sound that exists.
 * 2. An agent's terminal resolved to Windows PowerShell (the shell's
 *    fallback when pwsh is absent, or the Settings picker's choice), spawned
 *    by spawnAgentPty, has no Get-Acl and no New-Object.
 * 3. The quick terminal (shell:startPty) resolved to Windows PowerShell has
 *    neither.
 *
 * Each case starts Windows PowerShell itself, named by the setting, whatever
 * the machine has: where pwsh is installed (CI's windows-latest) it is the
 * default shell, and a pwsh would load the planted modules and prove nothing.
 *
 * What pwsh 7 children, other children, and darwin/linux get is held by
 * child-env.test.ts (pure) and launch-call-sites.test.ts (every call site).
 * win32 only: there is no Windows PowerShell elsewhere.
 */

const onWindows = process.platform === 'win32';
const made: string[] = [];
/** Each terminal a test opened, and a promise of its end. */
const opened: Array<{ end: () => void; ended: Promise<void> }> = [];

/**
 * Ends each terminal and waits for it before its folder goes: a shell whose
 * cwd it is holds it (EBUSY). `exit` first, then the app's own kill
 * (pty-kill.ts), which does not trip node-pty's console-list agent.
 */
afterEach(async () => {
  for (const t of opened.splice(0)) {
    t.end();
    await Promise.race([t.ended, new Promise(resolve => setTimeout(resolve, 15_000))]);
  }
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function track(terminal: pty.IPty, kill: () => void): void {
  const ended = new Promise<void>(resolve => { terminal.onExit(() => resolve()); });
  opened.push({
    ended,
    end: () => {
      try { terminal.write('exit\r'); } catch { /* gone */ }
      setTimeout(() => { try { kill(); } catch { /* gone */ } }, 5_000).unref();
    },
  });
}

function scratch(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-psmp-')));
  made.push(dir);
  return dir;
}

/** A valid 8 kHz mono PCM wave of `ms` silence. */
function wave(ms: number): Buffer {
  const samples = Math.round(8 * ms);
  const b = Buffer.alloc(44 + samples, 0x80);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(samples, 40);
  return b;
}

/**
 * Typed at the prompt: both cmdlets, and a line only a shell that ran both
 * prints. The typed text echoes back too, so the expected line is built from
 * pieces it does not hold whole.
 */
const PROBE = "$a = Get-Acl $env:SystemRoot; $o = New-Object System.Text.StringBuilder; 'PS' + 'MP-' + [bool]$a + '-' + [bool]$o\r";
const RAN_BOTH = 'PSMP-True-True';
const RAN_ANY = /PSMP-(True|False)-(True|False)/;

/** What a terminal printed, less its escape sequences. */
function readable(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][A-Z0-9]/g, '');
}

/** Resolves with everything printed once `done` matches it, or rejects saying what was printed. */
function collect(subscribe: (onData: (chunk: string) => void) => void, done: RegExp, within = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let all = '';
    const timer = setTimeout(() => reject(new Error(`never printed ${done}: ${JSON.stringify(readable(all).slice(-2000))}`)), within);
    subscribe(chunk => {
      all += chunk;
      if (done.test(readable(all))) { clearTimeout(timer); resolve(readable(all)); }
    });
  });
}

describe.runIf(onWindows)('Windows PowerShell 5.1 started under a PowerShell 7 parent', { timeout: 120_000 }, () => {
  it('1. the notification sound plays, nothing on stderr', async () => {
    const dir = scratch();
    const file = path.join(dir, 'ding.wav');
    fs.writeFileSync(file, wave(20));
    const env = withModulePath({ ...process.env }, pwsh7ModulePath(dir));
    const cmd = windowsSoundCommand(file, { env });
    expect(cmd.ok).toBe(true);
    if (!cmd.ok) return;
    const r = await new Promise<{ code: number; stderr: string }>(resolve => {
      execFile(cmd.file, cmd.args, { env: cmd.env, cwd: dir, windowsHide: true, timeout: 60_000 }, (err, _out, stderr) =>
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stderr: String(stderr) }));
    });
    expect(r).toEqual({ code: 0, stderr: '' });
  });

  it('2. an agent\'s terminal resolved to Windows PowerShell runs Get-Acl and New-Object', async () => {
    const dir = scratch();
    const env = withModulePath({ ...process.env } as Record<string, string | undefined>, pwsh7ModulePath(dir));
    const { shell, args } = agentShell({ setting: 'powershell', env });
    expect(path.win32.basename(shell).toLowerCase()).toBe('powershell.exe');
    const terminal = spawnAgentPty({ binaryName: 'claude', shell, args, runsCommand: false, cwd: dir, cols: 200, rows: 30, env });
    track(terminal, () => endTerminal(terminal));
    const printed = collect(onData => terminal.onData(onData), RAN_ANY);
    terminal.write(PROBE);
    expect(await printed).toContain(RAN_BOTH);
  });

  it('3. the quick terminal resolved to Windows PowerShell runs Get-Acl and New-Object', async () => {
    // As shell:startPty starts it (ipc-handlers.ts): the shell the setting
    // names, its arguments, and the parent's environment through childEnv. That
    // the handler composes these three is held by launch-call-sites.test.ts (12).
    const dir = scratch();
    const parentEnv = withModulePath({ ...process.env } as Record<string, string | undefined>, pwsh7ModulePath(dir));
    const shell = resolveShell({ setting: 'powershell', env: parentEnv });
    // Windows PowerShell itself, even where pwsh is installed (the default
    // there): a pwsh would load the planted modules and prove nothing.
    expect(path.win32.basename(shell).toLowerCase()).toBe('powershell.exe');
    const terminal = nodePty.spawn(shell, shellArgs(shell), {
      name: 'xterm-256color', cols: 200, rows: 30, cwd: dir,
      env: childEnv(shell, parentEnv) as { [key: string]: string },
    });
    track(terminal, () => endTerminal(terminal));
    const printed = collect(onData => terminal.onData(onData), RAN_ANY);
    terminal.write(PROBE);
    expect(await printed).toContain(RAN_BOTH);
  });
});
