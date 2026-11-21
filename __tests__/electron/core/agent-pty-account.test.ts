/**
 * The account an agent's CLI starts on reaches its process through
 * spawnAgentPty, the one line every agent terminal starts on, whichever of the
 * five spawn sites called it (DESIGN-COMPTES-CLAUDE.md B3).
 *
 * What goes wrong if it is wrong, first:
 * - with no resolver (the option has never been wired, or is off) anything in
 *   the environment changes: a CLAUDE_CONFIG_DIR the user set on purpose stays;
 * - an inherited CLAUDE_CONFIG_DIR surviving on account 1 (another login), or
 *   winning over the account's own;
 * - a shell with no agent (quick terminal, installers) asked about an account;
 * - the resolver told another folder than the one the CLI starts in (the trust
 *   and approvals it copies are that folder's).
 */
import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';

const spawnCalls: Array<{ env: Record<string, string> }> = [];

vi.mock('node-pty', () => ({
  spawn: vi.fn((_shell: string, _args: string[], opts: { env: Record<string, string> }) => {
    spawnCalls.push({ env: opts.env });
    return { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), write: vi.fn(), pid: 1, resize: vi.fn() };
  }),
}));
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() }, BrowserWindow: vi.fn(), Notification: vi.fn() }));
vi.mock('../../../electron/utils/broadcast', () => ({ broadcastToAllWindows: vi.fn() }));

import { spawnAgentPty, setAccountEnvResolver } from '../../../electron/core/agent-pty';

const asked: Array<{ agentId: string; cwd: string }> = [];

function spawnWith(env: Record<string, string | undefined>, cwd = '/work/app') {
  spawnAgentPty({ binaryName: 'claude', shell: '/bin/bash', args: ['-l'], cwd, cols: 80, rows: 24, env });
  return spawnCalls[spawnCalls.length - 1].env;
}

beforeEach(() => {
  spawnCalls.length = 0;
  asked.length = 0;
});

afterEach(() => setAccountEnvResolver(undefined));

describe('with no resolver', () => {
  it('leaves the environment as the caller built it, CLAUDE_CONFIG_DIR included', () => {
    const env = spawnWith({ CLAUDE_AGENT_ID: 'a1', CLAUDE_CONFIG_DIR: '/mine', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/x', PATH: '/usr/bin' });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/mine');
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/x');
    expect('TARS_CLAUDE_ACCOUNT' in env).toBe(false);
  });
});

describe('with a resolver', () => {
  it('puts the account in, over anything inherited, and asks with the folder the CLI starts in', () => {
    setAccountEnvResolver((agentId, cwd) => {
      asked.push({ agentId, cwd });
      return { accountId: 'acct-aaaaaa', set: { CLAUDE_CONFIG_DIR: '/h/.claude-accounts/acct-aaaaaa', TARS_CLAUDE_ACCOUNT: 'acct-aaaaaa' }, unset: ['CLAUDE_SECURESTORAGE_CONFIG_DIR'] };
    });
    const env = spawnWith({ CLAUDE_AGENT_ID: 'a1', CLAUDE_CONFIG_DIR: '/inherited', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/x', TARS_CLAUDE_ACCOUNT: 'default' }, '/work/app/sub');
    expect(asked).toEqual([{ agentId: 'a1', cwd: '/work/app/sub' }]);
    expect(env.CLAUDE_CONFIG_DIR).toBe('/h/.claude-accounts/acct-aaaaaa');
    expect(env.TARS_CLAUDE_ACCOUNT).toBe('acct-aaaaaa');
    expect('CLAUDE_SECURESTORAGE_CONFIG_DIR' in env).toBe(false);
  });

  it('removes what account 1 must not inherit', () => {
    setAccountEnvResolver(() => ({ accountId: 'default', set: { TARS_CLAUDE_ACCOUNT: 'default' }, unset: ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'] }));
    const env = spawnWith({ CLAUDE_AGENT_ID: 'a1', CLAUDE_CONFIG_DIR: '/inherited', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/x', TARS_CLAUDE_ACCOUNT: 'acct-bbbbbb' });
    expect('CLAUDE_CONFIG_DIR' in env).toBe(false);
    expect('CLAUDE_SECURESTORAGE_CONFIG_DIR' in env).toBe(false);
    expect(env.TARS_CLAUDE_ACCOUNT).toBe('default');
  });

  it('starts on account 1, with nothing inherited, when the resolver throws (QA and the Audit, gate of #267)', () => {
    // A launch never fails over an account, and it does not start on whatever
    // folder Tars inherited either: an inherited CLAUDE_CONFIG_DIR is another login.
    setAccountEnvResolver(() => { throw new Error('registry unreadable'); });
    const env = spawnWith({ CLAUDE_AGENT_ID: 'a1', CLAUDE_CONFIG_DIR: '/inherited', CLAUDE_SECURESTORAGE_CONFIG_DIR: '/x', TARS_CLAUDE_ACCOUNT: 'acct-bbbbbb' });
    expect(spawnCalls).toHaveLength(1);
    expect('CLAUDE_CONFIG_DIR' in env).toBe(false);
    expect('CLAUDE_SECURESTORAGE_CONFIG_DIR' in env).toBe(false);
    expect(env.TARS_CLAUDE_ACCOUNT).toBe('default');
  });

  it('leaves the environment alone when the resolver has nothing for this agent', () => {
    setAccountEnvResolver(() => null);
    const env = spawnWith({ CLAUDE_AGENT_ID: 'a1', CLAUDE_CONFIG_DIR: '/mine' });
    expect(env.CLAUDE_CONFIG_DIR).toBe('/mine');
  });

  it('never asks about a shell that runs no agent', () => {
    setAccountEnvResolver((agentId, cwd) => { asked.push({ agentId, cwd }); return null; });
    spawnWith({ PATH: '/usr/bin' });
    expect(asked).toEqual([]);
  });
});
