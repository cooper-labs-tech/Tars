import { describe, it, expect } from 'vitest';
import { buildFleetResources, type FleetInput } from '../../../electron/services/fleet-resources';

/**
 * What each agent and each project costs, readable (2.0.5, lot 3 item D; brief lot3-agent-resources-2810.md, moved to
 * the Backend; the Frontend's contract on #539, `FleetResources`). 1212's orchestrator could not tell which agents held
 * the memory (its tars-feedback-2810.md, item 8).
 *
 * How it fails, written before the code (28/10):
 * F1. An agent's memory and CPU are its terminal's process alone, not its whole tree (its CLI, the CLI's servers and
 *     tools, the builds they run); or another agent's processes are counted in it.
 * F2. Its processes are not listed, or their command lines carry a secret (a token, a URL's password) to the window
 *     and the orchestrators.
 * F3. The disk is measured on every read (a walk of a worktree's node_modules on each tick): it is measured only when
 *     asked, cached with when, and a read before says nothing rather than a made-up figure.
 * F4. A project's figures are not the sum of its agents', or agents are not grouped by their project.
 * F5. An agent with no terminal, or a machine whose process table cannot be read (Windows, a ps that failed), throws
 *     or reads 0: its figures are null, the window says it cannot read them.
 * F6. Its status and since when are missing.
 * And from the Audit's gate of #546 (M1) and the orchestrator's decision (task t-2be3810b):
 * F7. A process has no pid, so the window cannot name it apart from another of the same program.
 * F8. A command line keeps a secret after a flag named for one (`--token <value>`, mysql's `-p<value>`): it is masked
 *     whole (redact-command-line.ts).
 */

const T = '2026-10-28T10:00:00.000Z';
const input = (over: Partial<FleetInput> = {}): FleetInput => ({
  readAt: Date.parse(T),
  agents: [
    { id: 'a', name: 'Harbor Worker', status: 'running', statusSince: '2026-10-28T09:30:00.000Z', projectPath: '/w/harbor', worktreePath: '/w/harbor/.worktrees/a', terminalPid: 100 },
    { id: 'o', name: 'Harbor Lead', status: 'waiting', statusSince: '2026-10-28T09:55:00.000Z', projectPath: '/w/harbor', terminalPid: 300 },
    { id: 'm', name: 'Meridian Worker', status: 'idle', statusSince: '2026-10-28T08:00:00.000Z', projectPath: '/w/meridian', terminalPid: 200 },
    { id: 's', name: 'Asleep', status: 'idle', statusSince: '2026-10-28T07:00:00.000Z', asleepSince: '2026-10-28T07:30:00.000Z', projectPath: '/w/meridian' },
  ],
  table: [
    { pid: 100, ppid: 1, kb: 2048, cpu: 0.5, command: '/bin/bash -l' },
    { pid: 101, ppid: 100, kb: 512 * 1024, cpu: 40, command: '/Users/x/.local/bin/claude --dangerously-skip-permissions' },
    { pid: 102, ppid: 101, kb: 256 * 1024, cpu: 10, command: `node server.js --token ${['ghp_', 'A'.repeat(12), 'B'.repeat(12)].join('')}` },
    { pid: 200, ppid: 1, kb: 1024, cpu: 0, command: 'claude' },
    { pid: 300, ppid: 1, kb: 4096, cpu: 1, command: 'psql postgres://app:hunter2secret@db/x' },
    { pid: 999, ppid: 1, kb: 9e6, cpu: 99, command: 'someone else' },
  ],
  disk: new Map([['/w/harbor/.worktrees/a', { bytes: 5e9, at: Date.parse('2026-10-28T09:00:00.000Z') }]]),
  tmpOf: (id) => `/h/.tars/tmp/${id}`,
  ...over,
});

const agentOf = (r: ReturnType<typeof buildFleetResources>, id: string) => r.projects.flatMap(p => p.agents).find(a => a.id === id)!;

describe('the fleet\'s resources', () => {
  it('F1. each agent\'s memory and CPU are its whole tree\'s, no one else\'s', () => {
    const r = buildFleetResources(input());
    expect(agentOf(r, 'a')).toMatchObject({ memMb: 770, cpuPct: 50.5 });
    expect(agentOf(r, 'a').processes.map(p => p.name)).toEqual(['claude', 'node', 'bash']);
    expect(agentOf(r, 'm')).toMatchObject({ memMb: 1, cpuPct: 0 });
  });

  it('F2. its processes are listed by memory, their command lines masked', () => {
    const r = buildFleetResources(input());
    const text = JSON.stringify(r);
    expect(text).not.toContain('A'.repeat(12) + 'B'.repeat(12));
    expect(text).not.toContain('hunter2secret');
    expect(agentOf(r, 'a').processes[1]).toMatchObject({ name: 'node', memMb: 256, cpuPct: 10, command: expect.stringMatching(/^node server\.js --token /) });
  });

  it('F7, F8. each process has its pid, and a secret after a flag is masked whole', () => {
    const r = buildFleetResources(input({ table: [
      { pid: 100, ppid: 1, kb: 2048, cpu: 0.5, command: '/bin/bash -l' },
      { pid: 103, ppid: 100, kb: 1024, cpu: 0, command: 'mysql -uroot -pS3cretPassw0rd9 shop' },
    ] }));
    expect(agentOf(r, 'a').processes.map(p => [p.pid, p.command])).toEqual([[100, '/bin/bash -l'], [103, 'mysql -uroot -p[redacted] shop']]);
  });

  it('F3. the disk is what was measured, with when; nothing made up before', () => {
    const r = buildFleetResources(input());
    expect(agentOf(r, 'a').worktrees).toEqual([{ path: '/w/harbor/.worktrees/a', bytes: 5e9 }]);
    expect(agentOf(r, 'a').tmp).toEqual({ path: '/h/.tars/tmp/a', bytes: null });
    expect(agentOf(r, 'o').worktrees).toEqual([]);
    expect(r.diskMeasuredAt).toBe(Date.parse('2026-10-28T09:00:00.000Z'));
    expect(buildFleetResources(input({ disk: new Map() })).diskMeasuredAt).toBeNull();
  });

  it('F4. agents grouped by project, each project its agents\' sums', () => {
    const r = buildFleetResources(input());
    expect(r.projects.map(p => [p.name, p.agents.map(a => a.id)])).toEqual([['harbor', ['a', 'o']], ['meridian', ['m', 's']]]);
    expect(r.projects[0].totals).toEqual({ memMb: 774, cpuPct: 51.5, diskBytes: 5e9, processes: 4 });
  });

  it('F5. no terminal, or no table: null figures, never a throw or a zero', () => {
    expect(agentOf(buildFleetResources(input()), 's')).toMatchObject({ memMb: null, cpuPct: null, processes: [] });
    const r = buildFleetResources(input({ table: null, readAt: null }));
    expect(r.readAt).toBeNull();
    expect(agentOf(r, 'a')).toMatchObject({ memMb: null, cpuPct: null, processes: [] });
    expect(r.projects[0].totals).toMatchObject({ memMb: null, cpuPct: null });
  });

  it('F6. each agent\'s status and since when; asleep says since when it sleeps', () => {
    const r = buildFleetResources(input());
    expect(agentOf(r, 'a')).toMatchObject({ status: 'working', statusSince: Date.parse('2026-10-28T09:30:00.000Z') });
    expect(agentOf(r, 'o')).toMatchObject({ status: 'waiting' });
    expect(agentOf(r, 's')).toMatchObject({ status: 'asleep', statusSince: Date.parse('2026-10-28T07:30:00.000Z') });
  });
});
