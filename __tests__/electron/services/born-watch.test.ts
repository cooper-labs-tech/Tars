import { describe, it, expect } from 'vitest';
import { bornWatchPass, REPORT_AFTER_MS, type BornWatchDeps } from '../../../electron/services/born-watch';
import type { AgentStatus } from '../../../electron/types';
import type { BornProcess } from '../../../electron/core/born-processes';

/**
 * What an agent started that outlives its session, reported and never ended (2.0.5, the owner's lot 2 of 28/10):
 * kotsna's dev servers ran 10 days with no session, and nobody knew. The owner's limits: never end such a process
 * automatically (an ansible run, a `fly ssh`, a build talking to the Sparks may be among them); say it.
 *
 * How it fails, written before the code:
 * 1. An agent with no live session whose tagged processes or labelled containers run is not recorded on its
 *    record, or recorded with what a command line may hold of a secret.
 * 2. It is reported to the project's orchestrator before an hour has gone, more than once, or never when the first
 *    note could not be typed (no orchestrator running, mid-turn): it is retried at the next pass.
 * 3. Something is ended: the watch only records and says.
 * 4. An agent with a live session is recorded: what it runs is its work, not a leftover.
 * 5. The record outlives what it recorded: once they are gone, it goes.
 * 6. Windows (no environment to read): the processes are unknown, so none is claimed, and the containers still are.
 * And from the Audit's train audit (M1, AUDIT-train-2-0-5-2.md):
 * 7. A secret after a flag (`--token <v>`, mysql's `-p<v>`, `--password <v>`, `--api-key <v>`) stays in the record
 *    and the hour-on note: the log rule misses them. They follow the window's rule (redact-command-line.ts).
 */

const T0 = Date.parse('2026-10-28T10:00:00.000Z');
const agent = (id: string, over: Partial<AgentStatus> = {}) =>
  ({ id, name: `Agent ${id}`, status: 'stopped', projectPath: '/p/demo', output: [], skills: [], lastActivity: '', ...over }) as AgentStatus;

function deps(fleet: AgentStatus[], born: BornProcess[] | undefined, opts: { live?: string[]; containers?: Array<{ id: string; agentId: string; name: string }>; deliver?: string } = {}) {
  const told: Array<{ projectPath: string; message: string }> = [];
  let saves = 0;
  const d: BornWatchDeps = {
    fleet: () => fleet,
    read: async () => born,
    containers: async () => opts.containers,
    hasSession: (a) => (opts.live ?? []).includes(a.id),
    tell: async (projectPath, message) => { told.push({ projectPath, message }); return (opts.deliver ?? 'typed') as 'typed'; },
    save: () => { saves++; },
  };
  return { d, told, saves: () => saves };
}

describe('what outlives an agent\'s session', () => {
  it('1, 3. records it on the agent, secrets masked, and ends nothing', async () => {
    const a = agent('a1');
    const born = [{ pid: 9001, ppid: 1, agentId: 'a1', command: 'node next dev --token sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' }];
    const { d, told } = deps([a], born);
    await bornWatchPass(T0, d);
    expect(a.leftRunning).toMatchObject({ pids: [9001], since: new Date(T0).toISOString() });
    expect(JSON.stringify(a.leftRunning)).not.toContain('AbCdEfGh');
    expect(told).toEqual([]);
  });

  it('2. reports it once, an hour on, to the project\'s orchestrator, and retries a note that could not be typed', async () => {
    const a = agent('a1');
    const born = [{ pid: 9001, ppid: 1, agentId: 'a1', command: 'node next dev' }];
    const first = deps([a], born, { deliver: 'not-now' });
    await bornWatchPass(T0, first.d);
    await bornWatchPass(T0 + REPORT_AFTER_MS - 1, first.d);
    expect(first.told).toEqual([]);
    await bornWatchPass(T0 + REPORT_AFTER_MS, first.d);
    expect(first.told).toHaveLength(1);
    expect(first.told[0].projectPath).toBe('/p/demo');
    expect(first.told[0].message).toContain('9001');
    expect(first.told[0].message).toContain('Agent a1');
    expect(a.leftRunning?.reportedAt).toBeUndefined();

    const second = deps([a], born);
    await bornWatchPass(T0 + REPORT_AFTER_MS + 600_000, second.d);
    expect(second.told).toHaveLength(1);
    expect(a.leftRunning?.reportedAt).toBe(new Date(T0 + REPORT_AFTER_MS + 600_000).toISOString());
    await bornWatchPass(T0 + 3 * REPORT_AFTER_MS, second.d);
    expect(second.told).toHaveLength(1);
  });

  it('4. leaves an agent with a live session alone', async () => {
    const a = agent('a1', { status: 'idle' });
    const { d } = deps([a], [{ pid: 9001, ppid: 1, agentId: 'a1', command: 'node next dev' }], { live: ['a1'] });
    await bornWatchPass(T0, d);
    expect(a.leftRunning).toBeUndefined();
  });

  it('5. drops the record once what it recorded is gone', async () => {
    const a = agent('a1');
    const { d } = deps([a], [{ pid: 9001, ppid: 1, agentId: 'a1', command: 'node next dev' }]);
    await bornWatchPass(T0, d);
    expect(a.leftRunning).toBeDefined();
    const gone = deps([a], []);
    await bornWatchPass(T0 + 60_000, gone.d);
    expect(a.leftRunning).toBeUndefined();
    expect(gone.saves()).toBe(1);
  });

  it('6. counts labelled containers too, and claims no process where none can be read', async () => {
    const a = agent('a1');
    const { d } = deps([a], undefined, { containers: [{ id: 'c1', agentId: 'a1', name: 'kotsna-db' }, { id: 'c2', agentId: 'b2', name: 'other' }] });
    await bornWatchPass(T0, d);
    expect(a.leftRunning).toMatchObject({ pids: [], containers: ['kotsna-db (c1)'] });
  });

  it('7. a secret after a flag is masked in the record and in the note, by the window\'s rule', async () => {
    const a = agent('a1');
    const born = [
      { pid: 9001, ppid: 1, agentId: 'a1', command: 'node w.js --token Ab3dEf6hIj9kLm2n' },
      { pid: 9002, ppid: 1, agentId: 'a1', command: 'mysql -u root -pHunter2xyz shop' },
      { pid: 9003, ppid: 1, agentId: 'a1', command: 'deploy --api-key 9f8e7d6c5b4a3f2e1d0c --password hunter2long' },
    ];
    const { d, told } = deps([a], born);
    await bornWatchPass(T0, d);
    await bornWatchPass(T0 + REPORT_AFTER_MS, d);
    const said = JSON.stringify(a.leftRunning) + JSON.stringify(told);
    for (const secret of ['Ab3dEf6hIj9kLm2n', 'Hunter2xyz', '9f8e7d6c5b4a3f2e1d0c', 'hunter2long']) expect(said, secret).not.toContain(secret);
    expect(told).toHaveLength(1);
    expect(a.leftRunning?.commands).toContain('pid 9001: node w.js --token [redacted]');
  });
});

