import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { isTerminalsOwnCli, parentPid, parentPidFromProcStat } from '../../../electron/core/terminal-cli';

/**
 * Whose SessionStart may register a session for an agent: only the CLI Tars
 * launched in that agent's terminal.
 *
 * Measured on 2026-10-13 (claude 2.1.296): a `claude -p` run from an agent's
 * own Bash tool inherited CLAUDE_AGENT_ID, its token and Tars's hooks; its
 * SessionStart registered it as the agent's session, its Stop marked the
 * agent completed with its one-word answer, the real session's posts were
 * dropped as stale, and a restart resumed the wrong conversation. Claude Code
 * hands its hooks CLAUDE_PID, its own pid: the agent's claude was the
 * terminal's process itself (pty pid 86550, parent Tars), the nested one
 * 81386, whose hook saw CLAUDE_PID=81386.
 *
 * How it fails, written before the code:
 *  1. A nested CLI (its pid is not the terminal's, nor a child of it)
 *     registers: the bug.
 *  2. Over-correction: the terminal's own CLI is refused when it is the
 *     terminal's process itself (the shell exec'd it, as measured).
 *  3. Over-correction: refused when a shell in the terminal started it, so
 *     it is the terminal process's child.
 *  4. A post that names no CLI pid (Gemini, a claude that does not set
 *     CLAUDE_PID, a hook from before this change) is refused, where it
 *     registered before: nothing to compare, so nothing changes.
 *  5. A malformed pid ("abc", "0", "-3", "1.5", "12 34", a number past any
 *     pid) is taken for one, or reaches `ps` as an argument: refused.
 *  6. The parent cannot be read (the process is gone, `ps` fails): taken as
 *     the terminal's. Refused: nothing shows it is.
 *  7. The agent has no terminal Tars knows of: refused, where it registered
 *     before. Nothing to compare: accepted as before.
 *  8. Windows, where there is no `ps`: every session refused, or the lookup
 *     throws. Only the equal pid is checked there; anything else is accepted
 *     as before.
 *  9. (The Audit's L1 on #380) On the exec launch the terminal's process IS
 *     the agent's CLI (`bash -l -c "cd ... && exec claude"`), so its children
 *     are the CLI's own tools: a claude its Bash tool started straight under
 *     it is accepted as "the terminal's child". Only a terminal that runs a
 *     shell the CLI was typed into has the CLI as its child.
 * 10. (L2) A Linux without `ps` (no procps) refuses every typed-in agent's
 *     session: its parent is read from /proc/<pid>/stat there, whose command
 *     name may itself hold spaces and parentheses.
 */

const PTY = 4242;
const ppids = (map: Record<number, number>) => async (pid: number) => map[pid];

describe('isTerminalsOwnCli', () => {
  it('1. refuses a CLI that is neither the terminal process nor its child', async () => {
    // agent's claude = pty (exec'd); its Bash tool's zsh 5000; nested claude 5001
    expect(await isTerminalsOwnCli(PTY, '5001', { platform: 'darwin', parentPid: ppids({ 5001: 5000, 5000: PTY }) })).toBe(false);
    // nested claude started by the agent's claude directly
    expect(await isTerminalsOwnCli(PTY, '5001', { platform: 'linux', parentPid: ppids({ 5001: 4300, 4300: PTY }) })).toBe(false);
  });

  it('2. accepts the terminal process itself', async () => {
    expect(await isTerminalsOwnCli(PTY, String(PTY), { platform: 'darwin', parentPid: async () => { throw new Error('not asked'); } })).toBe(true);
  });

  it('3. accepts a CLI the terminal\'s shell started', async () => {
    expect(await isTerminalsOwnCli(PTY, '4300', { platform: 'darwin', parentPid: ppids({ 4300: PTY }) })).toBe(true);
    expect(await isTerminalsOwnCli(PTY, '4300', { platform: 'linux', parentPid: ppids({ 4300: PTY }) })).toBe(true);
  });

  it('4. accepts a post that names no CLI pid, as before', async () => {
    for (const none of [undefined, null, '']) {
      expect(await isTerminalsOwnCli(PTY, none, { platform: 'darwin', parentPid: ppids({}) })).toBe(true);
    }
  });

  it('5. refuses a malformed pid, without asking for its parent', async () => {
    const asked: number[] = [];
    const parentPid = async (pid: number) => { asked.push(pid); return PTY; };
    for (const bad of ['abc', '0', '-3', '1.5', '12 34', '99999999999', ' 4300', {}, 4300.5]) {
      expect(await isTerminalsOwnCli(PTY, bad, { platform: 'darwin', parentPid }), JSON.stringify(bad)).toBe(false);
    }
    expect(asked).toEqual([]);
  });

  it('6. refuses when the parent cannot be read', async () => {
    expect(await isTerminalsOwnCli(PTY, '4300', { platform: 'darwin', parentPid: async () => undefined })).toBe(false);
    expect(await isTerminalsOwnCli(PTY, '4300', { platform: 'darwin', parentPid: async () => { throw new Error('ps failed'); } })).toBe(false);
  });

  it('7. accepts when the agent has no terminal Tars knows of', async () => {
    expect(await isTerminalsOwnCli(undefined, '5001', { platform: 'darwin', parentPid: ppids({}) })).toBe(true);
  });

  it('8. on Windows checks the equal pid only, and never asks for a parent', async () => {
    const parentPid = async () => { throw new Error('no ps on win32'); };
    expect(await isTerminalsOwnCli(PTY, String(PTY), { platform: 'win32', parentPid })).toBe(true);
    expect(await isTerminalsOwnCli(PTY, '5001', { platform: 'win32', parentPid })).toBe(true);
  });
});

describe('the launch the terminal ran', () => {
  it('9. refuses the CLI\'s own child when the terminal\'s process is the CLI (exec launch)', async () => {
    const parentPid = async () => PTY;
    expect(await isTerminalsOwnCli(PTY, '5001', { platform: 'darwin', parentPid, execLaunch: true })).toBe(false);
    expect(await isTerminalsOwnCli(PTY, String(PTY), { platform: 'darwin', parentPid, execLaunch: true })).toBe(true);
  });

  it('9. accepts the child when the terminal runs a shell the CLI was typed into', async () => {
    expect(await isTerminalsOwnCli(PTY, '4300', { platform: 'darwin', parentPid: async () => PTY, execLaunch: false })).toBe(true);
  });
});

describe('10. the parent from /proc on Linux', () => {
  it('reads the fourth field after the command name, whatever the name holds', () => {
    expect(parentPidFromProcStat('5001 (claude) S 4300 5001 4300 0 -1 4194560')).toBe(4300);
    expect(parentPidFromProcStat('5001 (my (odd) cli) R 4242 5001 4300 0')).toBe(4242);
    expect(parentPidFromProcStat('garbage')).toBeUndefined();
    expect(parentPidFromProcStat('5001 (x) S abc 1')).toBeUndefined();
  });

  it('takes /proc on Linux before asking ps, and ps when /proc cannot be read', async () => {
    const proc = (pid: number) => (pid === 5001 ? '5001 (claude) S 4300 5001' : undefined);
    expect(await parentPid(5001, { platform: 'linux', readProcStat: proc, ps: async () => { throw new Error('no ps'); } })).toBe(4300);
    expect(await parentPid(5002, { platform: 'linux', readProcStat: proc, ps: async () => 7 })).toBe(7);
    expect(await parentPid(5001, { platform: 'darwin', readProcStat: proc, ps: async () => 9 })).toBe(9);
  });
});

describe.skipIf(process.platform === 'win32')('parentPid, against real processes', () => {
  it('reads a live child\'s parent, and nothing for a pid that is gone', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
    try {
      expect(await parentPid(child.pid!)).toBe(process.pid);
    } finally {
      child.kill();
    }
    await new Promise((r) => child.on('exit', r));
    expect(await parentPid(child.pid!)).toBeUndefined();
  });
});
