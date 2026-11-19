import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }));

import { endRemoteSession, sweepPrepFiles, tunnelAdmits, PREP_DIR } from '../../../electron/services/remote-agents';
import { remoteHosts } from '../../../electron/services/remote-hosts';

/**
 * What runs ssh for an agent on a remote host (services/remote-agents.ts), after the Audit's gate of #600 (FIX FIRST at
 * dfccd9fc3). Written before the fixes.
 *
 * How it fails:
 * 1. (M1, L4) Ending an agent's session on its host fails (the host unreachable, ssh refused) and nothing says so: a
 *    stop reads "stopped" while the CLI goes on there. The end must say whether the host said it ended, and if not,
 *    why, in ssh's own words.
 * 2. (M1) The end reads the agent's place as it is now, so a session on a former host is never reached: it must take
 *    the place to end, whatever the agent's is now.
 * 3. A place on a host the owner removed: the end must say there is no such host any more, not pass for done.
 * 4. (L2, I-a, I-d) The stop's ssh joins the owner's ControlMaster, trusts an unknown host key, or runs the owner's
 *    RemoteCommand.
 * 5. (I-e) A file that prepares a host, left by a Tars that died between writing it and its terminal's start (it holds
 *    a token that died with that Tars), stays in ~/.tars-private for good: Tars's start must remove them.
 * 6. (the gate's must-fix) The tunnel's listener admits a call with no token, with the shared token, with Tars's own
 *    pass, or with the token of an agent on this computer: on every route, /api/health and /api/local-file included,
 *    only an agent placed on a host passes, by its own token.
 */

let bin: string;
let log: string;
const pathBefore = process.env.PATH;

/** An ssh stand-in on PATH: its arguments one a line, its exit code FAKE_SSH_EXIT, its words on stderr. */
beforeEach(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-agents-bin-'));
  log = path.join(bin, 'ssh.args');
  fs.writeFileSync(path.join(bin, 'ssh'), [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > '${log}'`,
    'code="${FAKE_SSH_EXIT:-0}"',
    '[ "$code" = 0 ] || echo "ssh: connect to host buildbox port 22: Connection refused" >&2',
    'exit "$code"',
    '',
  ].join('\n'), { mode: 0o755 });
  process.env.PATH = `${bin}:${pathBefore}`;
  remoteHosts().set({ id: 'build-1', name: 'Build host', sshTarget: 'buildbox', workRoot: '/home/agent/work' });
});
afterEach(() => {
  process.env.PATH = pathBefore;
  delete process.env.FAKE_SSH_EXIT;
  remoteHosts().remove('build-1');
  fs.rmSync(bin, { recursive: true, force: true });
});

const place = { hostId: 'build-1', folder: '/home/agent/work/p' };

describe('ending an agent session on a host', () => {
  it("1, 4. says it ended when the host said so, on an ssh that takes nothing of the owner's multiplexing", async () => {
    expect(await endRemoteSession({ id: 'agent-1', remote: place })).toEqual({ ended: true, host: 'Build host' });
    const args = fs.readFileSync(log, 'utf8').split('\n');
    expect(args).toEqual(expect.arrayContaining(['ControlMaster=no', 'ControlPath=none', 'StrictHostKeyChecking=yes', 'RemoteCommand=none', '--', 'buildbox']));
    expect(args.join('\n')).toMatch(/tars-remote 'stop' 'agent-1'/);
  });

  it("1. says it did not, and why, in ssh's own words", async () => {
    process.env.FAKE_SSH_EXIT = '255';
    const r = await endRemoteSession({ id: 'agent-1', remote: place });
    expect(r).toMatchObject({ ended: false, host: 'Build host' });
    expect(r.ended === false && r.why).toMatch(/Connection refused/);
  });

  it('2. ends the place it is given, the former one, not the agent\'s current one', async () => {
    remoteHosts().set({ id: 'build-2', name: 'Other host', sshTarget: 'otherbox', workRoot: '/w' });
    try {
      expect(await endRemoteSession({ id: 'agent-1', remote: { hostId: 'build-2', folder: '/w/p' } })).toEqual({ ended: true, host: 'Other host' });
      expect(fs.readFileSync(log, 'utf8').split('\n')).toContain('otherbox');
    } finally {
      remoteHosts().remove('build-2');
    }
  });

  it('3. a host the owner removed: not ended, and why', async () => {
    const r = await endRemoteSession({ id: 'agent-1', remote: { hostId: 'gone', folder: '/x/p' } });
    expect(r).toMatchObject({ ended: false });
    expect(r.ended === false && r.why).toMatch(/no longer one of the owner's hosts/);
  });
});

describe("Tars's start", () => {
  it('5. removes the files that prepare a host a Tars that died left behind', () => {
    fs.mkdirSync(PREP_DIR(), { recursive: true, mode: 0o700 });
    for (const name of ['a-1.sh', 'b-2.sh']) fs.writeFileSync(path.join(PREP_DIR(), name), "export CLAUDE_MGR_API_TOKEN='dead'\n", { mode: 0o600 });
    expect(sweepPrepFiles()).toBe(2);
    expect(fs.readdirSync(PREP_DIR())).toEqual([]);
    expect(sweepPrepFiles()).toBe(0);
  });
});

describe("the tunnel's listener", () => {
  const remoteAgent = { id: 'r1', remote: place };
  const localAgent = { id: 'l1', remote: undefined };
  const agentOf = (id: string) => [remoteAgent, localAgent].find((a) => a.id === id);

  it('6. admits only an agent placed on a host, by its own token', () => {
    expect(tunnelAdmits({ ok: true, agentId: 'r1', terminal: true }, agentOf)).toBe(true);
    expect(tunnelAdmits({ ok: true, agentId: 'l1', terminal: true }, agentOf)).toBe(false);
    expect(tunnelAdmits({ ok: true, agentId: 'gone', terminal: true }, agentOf)).toBe(false);
    expect(tunnelAdmits({ ok: true }, agentOf)).toBe(false); // the shared token
    expect(tunnelAdmits({ ok: true, internal: true }, agentOf)).toBe(false); // Tars's own pass
    expect(tunnelAdmits({ ok: false, status: 401, error: 'Unauthorized' }, agentOf)).toBe(false); // no token
  });
});
