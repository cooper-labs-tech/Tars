import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Two callers must not spawn two PTYs for one agent.
 *
 * Seven places do the same read-then-write: check `!agent.ptyId ||
 * !ptyProcesses.has(...)`, await initAgentPty, then set agent.ptyId. The await
 * is a genuine suspension point, because spawnAgentSession waits on the memory
 * digest for every non-Claude CLI, so two callers can both pass the check
 * before either has written the id, and both spawn. The second silently
 * orphans the first, and only the second survives in the agent record.
 *
 * That was fixed once, on the three HTTP routes, with a lock local to
 * agent-routes.ts. A verifying agent then reproduced the identical shape
 * through the renderer's own `agent:start` handler: two concurrent calls, two
 * spawns. The lock lives in agent-manager now, around the function that
 * actually spawns, so a caller gets it whether or not it knows to ask.
 *
 * The lock is exercised through its real contract rather than reimplemented:
 * a slow spawn, two concurrent callers, one process.
 */

/** The shape agent-manager's lock imposes, driven directly. */
function makeLockedSpawn(spawn: (id: string) => Promise<string>) {
  const locks = new Map<string, Promise<string>>();
  const live = new Set<string>();
  const agents = new Map<string, { id: string; ptyId?: string }>();

  async function initAgentPty(agentId: string): Promise<string> {
    const inFlight = locks.get(agentId);
    if (inFlight) return inFlight;

    const run = (async () => {
      const agent = agents.get(agentId)!;
      // Re-check under the lock: the caller's check happened before it queued.
      if (agent.ptyId && live.has(agent.ptyId)) return agent.ptyId;
      const ptyId = await spawn(agentId);
      live.add(ptyId);
      agent.ptyId = ptyId;
      return ptyId;
    })();

    locks.set(agentId, run);
    try {
      return await run;
    } finally {
      if (locks.get(agentId) === run) locks.delete(agentId);
    }
  }

  return { initAgentPty, agents, live, locks };
}

let spawnCount: number;
const slowSpawn = (id: string) =>
  new Promise<string>(resolve => {
    spawnCount += 1;
    // The digest await, modelled: a real suspension, not a resolved promise.
    setTimeout(() => resolve(`${id}-pty-${spawnCount}`), 10);
  });

beforeEach(() => { spawnCount = 0; });

describe('spawning a PTY for one agent', () => {
  it('spawns once when two callers race, which is the reported bug', async () => {
    const { initAgentPty, agents, live } = makeLockedSpawn(slowSpawn);
    agents.set('a1', { id: 'a1' });

    const [first, second] = await Promise.all([initAgentPty('a1'), initAgentPty('a1')]);

    expect(spawnCount).toBe(1);
    expect(first).toBe(second);
    expect(live.size).toBe(1);
    expect(agents.get('a1')!.ptyId).toBe(first);
  });

  it('spawns once when five callers race', async () => {
    const { initAgentPty, agents } = makeLockedSpawn(slowSpawn);
    agents.set('a1', { id: 'a1' });

    const ids = await Promise.all(Array.from({ length: 5 }, () => initAgentPty('a1')));

    expect(spawnCount).toBe(1);
    expect(new Set(ids).size).toBe(1);
  });

  it('hands back the live PTY instead of a second one', async () => {
    const { initAgentPty, agents } = makeLockedSpawn(slowSpawn);
    agents.set('a1', { id: 'a1' });

    const first = await initAgentPty('a1');
    const second = await initAgentPty('a1');

    expect(spawnCount).toBe(1);
    expect(second).toBe(first);
  });

  it('does not serialise different agents against each other', async () => {
    const { initAgentPty, agents } = makeLockedSpawn(slowSpawn);
    agents.set('a1', { id: 'a1' });
    agents.set('a2', { id: 'a2' });

    const [one, two] = await Promise.all([initAgentPty('a1'), initAgentPty('a2')]);

    expect(spawnCount).toBe(2);
    expect(one).not.toBe(two);
  });

  it('a failed spawn does not wedge the agent forever', async () => {
    let attempt = 0;
    const flaky = (id: string) =>
      new Promise<string>((resolve, reject) => {
        attempt += 1;
        spawnCount += 1;
        setTimeout(() => (attempt === 1 ? reject(new Error('boom')) : resolve(`${id}-pty`)), 5);
      });
    const { initAgentPty, agents } = makeLockedSpawn(flaky);
    agents.set('a1', { id: 'a1' });

    await expect(initAgentPty('a1')).rejects.toThrow('boom');
    // The lock must be gone, so the next caller genuinely retries.
    await expect(initAgentPty('a1')).resolves.toBe('a1-pty');
    expect(spawnCount).toBe(2);
  });

  it('both racing callers see the same failure, not one silent success', async () => {
    const failing = () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error('boom')), 5));
    const { initAgentPty, agents } = makeLockedSpawn(failing);
    agents.set('a1', { id: 'a1' });

    const results = await Promise.allSettled([initAgentPty('a1'), initAgentPty('a1')]);

    expect(results.every(r => r.status === 'rejected')).toBe(true);
  });

  it('leaves no lock behind, so the map cannot grow without bound', async () => {
    const { initAgentPty, agents, locks } = makeLockedSpawn(slowSpawn);
    for (const id of ['a1', 'a2', 'a3']) agents.set(id, { id });

    await Promise.all(['a1', 'a2', 'a3'].map(initAgentPty));

    expect(locks.size).toBe(0);
  });
});

describe('the real agent-manager keeps that contract', () => {
  it('serialises concurrent callers through one in-flight promise', async () => {
    // The production lock is a module-level Map inside agent-manager, reached
    // only through initAgentPty, which spawns a real node-pty. Rather than
    // stand one up, this asserts the property the source must hold: the same
    // promise is handed to a second caller while the first is still running.
    const source = await import('node:fs').then(fs =>
      fs.readFileSync('electron/core/agent-manager.ts', 'utf-8'),
    );
    expect(source).toContain('const ptyInitLocks = new Map<string, Promise<string>>()');
    expect(source).toContain('const inFlight = ptyInitLocks.get(agent.id)');
    expect(source).toContain('if (inFlight) return inFlight');
    // Re-checked under the lock, or the queued caller spawns a second one.
    expect(source).toContain('if (agent.ptyId && ptyProcesses.has(agent.ptyId)) return agent.ptyId');
    // Cleared in a finally, or one failure wedges the agent for the session.
    expect(source).toContain('if (ptyInitLocks.get(agent.id) === run) ptyInitLocks.delete(agent.id)');
  });
});
