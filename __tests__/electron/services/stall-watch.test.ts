import '../../setup/home-guard';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { stallOf, toolAtWork, cliProcess, parseProcesses, signOfLife, startStallWatch, stopStallWatch, STALL_AFTER_MS, MOD_SILENCE_MS, type Proc } from '../../../electron/services/stall-watch';

/**
 * Telling a running agent that is doing nothing from one that is busy
 * (PLAN-1.9.2.md item B).
 *
 * Measured on 28/09: a Claude Code 2.1.283 froze mid-turn, its main thread in
 * openat, 0 % CPU, one child a zombie nobody reaped; Tars showed it running
 * and the night was lost. Measured on 01/10 over 21 live claude processes:
 * during a turn each keeps a `caffeinate -i -t 300` child, renewed (all were
 * under 300 s old); a Bash tool runs as a `zsh -c source ...shell-snapshots...`
 * child; its MCP servers are children too (Tars's bundles, Pen's server,
 * `npm exec @sentry/mcp-server`). A frozen event loop renews nothing: the last
 * caffeinate exits unreaped, which is the zombie of 28/09.
 *
 * So: running, no write to its transcript for 30 minutes, and no tool at
 * work, meaning no live process under its CLI but its MCP servers and
 * caffeinate. A long Bash command (a build, a test run) writes nothing to the
 * transcript while it runs and is not a stall.
 *
 * How it fails, written before the code (2026-10-01):
 * 1. A long tool (a build of 40 minutes) is reported as a stall.
 * 2. A frozen CLI is missed because its MCP servers, its caffeinate or a
 *    zombie child count as work.
 * 3. A stall is reported before 30 minutes, or for an agent that is not
 *    running (waiting on a question, idle, stopped).
 * 4. An agent whose transcript cannot be found is reported: nothing is known.
 * 5. The CLI is not found under the terminal: the shell is taken for it in an
 *    interactive terminal, where claude is the shell's child, or claude is
 *    missed where the shell exec'd it.
 * 6. ps's lines are misread: a command with spaces, a zombie, the header.
 *
 * And from the Audit's gate of #283 (2026-10-01): an agent inside a long MCP
 * call (wait_for_agent, delegate_task, an hour and more) or running a
 * subagent has nothing under it but its MCP servers and caffeinate, and writes
 * nothing to its transcript, yet it works.
 * 7. A live caffeinate renewed by the event loop (not a zombie, under 300 s
 *    old) is not taken for a sign of life, and working agents read stalled.
 * 8. Over-correction: a caffeinate older than its 300 s, or a zombie one,
 *    spares a frozen CLI; with no caffeinate at all (Linux has none) nothing
 *    is ever stalled.
 * 9. ps's elapsed time is misread ([[dd-]hh:]mm:ss).
 * 10. The quit leaves the watch's timer running (main.ts's quit, after #235).
 *
 * And with the state mod (mods step 1, 2026-10-05): a session that runs it
 * sends a heartbeat from inside Claude Code's own event loop every 15 s, which
 * a frozen loop stops sending. The heartbeat replaces the rule above for that
 * session, and the rule above stays for every other one.
 * 11. A mod session whose heartbeat stopped five minutes ago, its CLI still
 *     there, is not marked; or one is marked while its heartbeat comes.
 * 12. A mod session is still judged by the transcript and caffeinate (a long
 *     silent turn marked though its heartbeat comes), or a session without
 *     the mod is judged by a heartbeat it never sends.
 * 13. A mod session is marked once its CLI is gone (the terminal closed).
 */

const NOW = Date.UTC(2026, 9, 1, 4, 0, 0);
const MIN = 60_000;

const p = (pid: number, ppid: number, command: string, stat = 'S+', age = 3600): Proc => ({ pid, ppid, stat, age, command });

/** An interactive agent terminal: the shell, claude under it, its MCP servers and caffeinate. */
function terminal(extra: Proc[] = []): Proc[] {
  return [
    p(100, 1, '/bin/zsh -l'),
    p(101, 100, '/Users/x/.local/bin/claude --dangerously-skip-permissions'),
    p(102, 101, '/Applications/Tars.app/Contents/MacOS/Tars /Applications/Tars.app/Contents/Resources/mcp-orchestrator/dist/bundle.js'),
    p(103, 101, '/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/mcp-server-darwin-arm64 --app desktop'),
    p(104, 101, 'npm exec @sentry/mcp-server'),
    // The caffeinate of a turn whose event loop froze: exited, never reaped.
    p(105, 101, '(caffeinate)', 'Z'),
    ...extra,
  ];
}

const running = { status: 'running', provider: 'claude' } as const;

describe('the CLI under a terminal', () => {
  it('5. is claude under the shell in an interactive terminal, and the terminal itself where the shell exec\'d it', () => {
    expect(cliProcess(100, terminal())?.pid).toBe(101);
    expect(cliProcess(200, [p(200, 1, 'claude --resume 1111'), p(201, 200, 'caffeinate -i -t 300')])?.pid).toBe(200);
    expect(cliProcess(300, [p(300, 1, '/bin/bash -l')])).toBeUndefined();
    // Installed by npm: node runs the claude script.
    expect(cliProcess(400, [p(400, 1, '/bin/zsh -l'), p(401, 400, '/usr/local/bin/node /usr/local/bin/claude --resume 2222')])?.pid).toBe(401);
    expect(cliProcess(500, [p(500, 1, '/bin/zsh -l'), p(501, 500, 'node build.js claude')])).toBeUndefined();
  });
});

describe('a tool at work', () => {
  it('1. is a live process under the CLI that is neither an MCP server nor caffeinate', () => {
    const procs = terminal([p(106, 101, '/bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-1.sh && npm run build'), p(107, 106, 'node build.js')]);
    expect(toolAtWork(101, procs)).toContain('shell-snapshots');
  });

  it('2. is not an MCP server, caffeinate or a zombie', () => {
    expect(toolAtWork(101, terminal([p(106, 101, 'caffeinate -i -t 300', 'Z')]))).toBeUndefined();
    // A tool's shell that ended and was never reaped: a zombie is no work.
    expect(toolAtWork(101, terminal([p(107, 101, '(zsh)', 'Z')]))).toBeUndefined();
  });
});

describe('a stall', () => {
  const silentFor = (ms: number) => NOW - ms;

  it('2. is a running CLI silent for 30 minutes with no tool at work, since its last write', () => {
    const procs = terminal([p(106, 101, '(caffeinate)', 'Z')]);
    expect(stallOf({ ...running, transcriptWrittenAt: silentFor(31 * MIN), terminalPid: 100, procs, now: NOW })).toBe(silentFor(31 * MIN));
  });

  it('1. is not a long tool at work, however long the silence', () => {
    const procs = terminal([p(106, 101, '/bin/zsh -c source /Users/x/.claude/shell-snapshots/s.sh && sleep 3000')]);
    expect(stallOf({ ...running, transcriptWrittenAt: silentFor(45 * MIN), terminalPid: 100, procs, now: NOW })).toBeUndefined();
  });

  it('3. is not 29 minutes of silence, nor an agent that is not running', () => {
    expect(stallOf({ ...running, transcriptWrittenAt: silentFor(29 * MIN), terminalPid: 100, procs: terminal(), now: NOW })).toBeUndefined();
    for (const status of ['waiting', 'idle', 'completed', 'error', 'stopped']) {
      expect(stallOf({ status, provider: 'claude', transcriptWrittenAt: silentFor(60 * MIN), terminalPid: 100, procs: terminal(), now: NOW }), status).toBeUndefined();
    }
    expect(STALL_AFTER_MS).toBe(30 * MIN);
  });

  it('4. is not known without a transcript, a process table or a CLI under the terminal', () => {
    expect(stallOf({ ...running, transcriptWrittenAt: undefined, terminalPid: 100, procs: terminal(), now: NOW })).toBeUndefined();
    expect(stallOf({ ...running, transcriptWrittenAt: silentFor(60 * MIN), terminalPid: 100, procs: undefined, now: NOW })).toBeUndefined();
    expect(stallOf({ ...running, transcriptWrittenAt: silentFor(60 * MIN), terminalPid: 999, procs: terminal(), now: NOW })).toBeUndefined();
  });

  it('is told only of Claude Code, whose transcript Tars reads', () => {
    expect(stallOf({ status: 'running', provider: 'codex', transcriptWrittenAt: silentFor(60 * MIN), terminalPid: 100, procs: terminal(), now: NOW })).toBeUndefined();
    expect(stallOf({ status: 'running', provider: undefined, transcriptWrittenAt: silentFor(60 * MIN), terminalPid: 100, procs: terminal(), now: NOW })).toBe(silentFor(60 * MIN));
  });
});

describe("ps's lines", () => {
  it('6, 9. keep a command with its spaces, mark a zombie, read the elapsed time, and skip what is not a process', () => {
    const procs = parseProcesses([
      '  PID  PPID STAT     ELAPSED COMMAND',
      '  101   100 S+   2-01:02:03 /Users/x/.local/bin/claude --resume 1111 --model opus',
      '  105   101 Z+         05:07 (caffeinate)',
      '  106   101 S+      01:00:00 caffeinate -i -t 300',
      '',
      'garbage',
    ].join('\n'));
    expect(procs).toEqual([
      { pid: 101, ppid: 100, stat: 'S+', age: 2 * 86_400 + 3723, command: '/Users/x/.local/bin/claude --resume 1111 --model opus' },
      { pid: 105, ppid: 101, stat: 'Z+', age: 307, command: '(caffeinate)' },
      { pid: 106, ppid: 101, stat: 'S+', age: 3600, command: 'caffeinate -i -t 300' },
    ]);
  });
});

describe("a sign of life (the Audit's gate of #283)", () => {
  const silent = { ...running, transcriptWrittenAt: NOW - 45 * MIN, terminalPid: 100, now: NOW };
  /** Under the CLI: its MCP servers, and a caffeinate of the given state and age. */
  const waiting = (stat: string, age: number) => [
    p(100, 1, '/bin/zsh -l'),
    p(101, 100, '/Users/x/.local/bin/claude'),
    p(102, 101, '/Applications/Tars.app/Contents/MacOS/Tars /Applications/Tars.app/Contents/Resources/mcp-orchestrator/dist/bundle.js'),
    p(103, 101, 'caffeinate -i -t 300', stat, age),
  ];

  it('7. spares an agent in a long MCP wait or a subagent: its caffeinate is live and renewed', () => {
    expect(signOfLife(101, waiting('S+', 120))).toBe(true);
    expect(stallOf({ ...silent, procs: waiting('S+', 120) })).toBeUndefined();
  });

  it('8. does not spare a frozen CLI: a zombie caffeinate, one past its 300 s, or none at all', () => {
    expect(stallOf({ ...silent, procs: waiting('Z+', 120) })).toBe(NOW - 45 * MIN);
    expect(stallOf({ ...silent, procs: waiting('S+', 400) })).toBe(NOW - 45 * MIN);
    expect(stallOf({ ...silent, procs: waiting('S+', 120).slice(0, 3) })).toBe(NOW - 45 * MIN);
  });
});

describe('the watch itself', () => {
  afterEach(() => { stopStallWatch(); vi.useRealTimers(); });

  it('10. leaves no timer once stopped, and starts once however often it is started', () => {
    vi.useFakeTimers();
    const before = vi.getTimerCount();
    startStallWatch();
    startStallWatch();
    expect(vi.getTimerCount()).toBe(before + 1);
    stopStallWatch();
    expect(vi.getTimerCount()).toBe(before);
  });
});

describe('a session that runs the state mod (mods step 1)', () => {
  const silent = { ...running, transcriptWrittenAt: NOW - 45 * MIN, terminalPid: 100, now: NOW };
  // Nothing at work under the CLI, and its caffeinate a zombie: the rule above marks this one.
  const frozenLooking = terminal();

  it('11. is marked when its heartbeat has been silent past MOD_SILENCE_MS, from the last beat', () => {
    const lastBeat = NOW - MOD_SILENCE_MS - 1000;
    expect(stallOf({ ...silent, procs: frozenLooking, beatAt: lastBeat })).toBe(lastBeat);
  });

  it('11, 12. is not marked while its heartbeat comes, however long its transcript has been silent', () => {
    expect(stallOf({ ...silent, procs: frozenLooking, beatAt: NOW - 20_000 })).toBeUndefined();
  });

  it('12. a silent heartbeat marks it even when caffeinate would spare it, and the transcript is not asked', () => {
    const lastBeat = NOW - MOD_SILENCE_MS - 1000;
    const caffeinated = terminal([p(106, 101, 'caffeinate -i -t 300', 'S+', 60)]);
    expect(stallOf({ ...silent, transcriptWrittenAt: NOW - MIN, procs: caffeinated, beatAt: lastBeat })).toBe(lastBeat);
  });

  it('12. a session without the mod keeps the rule above: no beat, no change', () => {
    expect(stallOf({ ...silent, procs: frozenLooking })).toBe(NOW - 45 * MIN);
  });

  it('13. is not marked once its CLI is gone', () => {
    const lastBeat = NOW - MOD_SILENCE_MS - 1000;
    expect(stallOf({ ...silent, procs: [p(100, 1, '/bin/zsh -l')], beatAt: lastBeat })).toBeUndefined();
  });
});

