/**
 * The folder guards, the registry's ids and `claude auth status`, one check at
 * a time (QA's gate of #263: each of these killed a mutant the other tests
 * let through, because every bad folder failed two checks at once).
 *
 * What goes wrong if it is wrong, first:
 * - a folder with a good id under another parent, or a folder under the root
 *   whose name is not an id, taken as an account folder, and written into;
 * - a folder open to its group, or owned by another user, taken as Tars's own;
 * - an id with anything after its six digits (a path, a seventh digit, a
 *   newline) read from the registry, or turned into a folder;
 * - an entry that says nothing about enabled read as disabled;
 * - a random id already in the list handed out again;
 * - `claude auth status` JSON that does not say whether it is signed in read
 *   as an answer, an e-mail kept from a signed-out answer, a binary that does
 *   not run read as signed out.
 */
import '../../setup/home-guard';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { claudeAccountsNotPorted } from '../../setup/platform-limits';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Under the fleet's load 5 s is too short for the tests that run a binary.
vi.setConfig({ testTimeout: 30_000 });

const rb = vi.hoisted(() => ({ queue: [] as Buffer[] }));
vi.mock('crypto', async importOriginal => {
  const orig = await importOriginal<typeof import('crypto')>();
  return { ...orig, randomBytes: (n: number) => (rb.queue.length ? rb.queue.shift()! : orig.randomBytes(n)) };
});

import { accountDirProblem, provisionAccountDir } from '../../../electron/services/claude-accounts/provision';
import { accountDir, accountsFile, addAccount, defaultAccountsSettings, normalizeAccountsSettings, readAccountsSettings } from '../../../electron/services/claude-accounts/registry';
import { claudeAuthStatus } from '../../../electron/services/claude-accounts/auth';

const home = () => fs.realpathSync(os.homedir());
const root = () => path.join(home(), '.claude-accounts');
let n = 0;
const freshId = () => `acct-${(0xa00000 + n++).toString(16)}`;

function ownFolder(p: string, mode = 0o700): string {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  fs.chmodSync(p, mode);
  return p;
}

afterEach(() => {
  vi.restoreAllMocks();
  rb.queue.length = 0;
});

describe.skipIf(claudeAccountsNotPorted())('folder guards, one check at a time', () => {
  it('a real, owner-only folder with a good id under another parent is not an account folder', () => {
    ownFolder(root());
    const elsewhere = ownFolder(path.join(home(), 'elsewhere', freshId()));
    expect(accountDirProblem(elsewhere)).not.toBeNull();
  });

  it('a real, owner-only folder under the root whose name is not an id is not an account folder', () => {
    ownFolder(root());
    const odd = ownFolder(path.join(root(), 'not-an-id'));
    expect(accountDirProblem(odd)).not.toBeNull();
  });

  it('provisioning refuses a good id under another parent, and writes nothing there', () => {
    const elsewhere = ownFolder(path.join(home(), 'elsewhere2', freshId()));
    expect(() => provisionAccountDir(elsewhere, home())).toThrow();
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('a folder open to its group is open to other users', () => {
    ownFolder(root());
    const dir = ownFolder(path.join(root(), freshId()), 0o770);
    expect(accountDirProblem(dir)).toMatch(/other users/);
  });

  it("a folder that is not this user's is refused", () => {
    ownFolder(root());
    const dir = ownFolder(path.join(root(), freshId()));
    vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1);
    expect(accountDirProblem(dir)).toMatch(/another user/);
  });
});

describe.skipIf(claudeAccountsNotPorted())('registry ids', () => {
  it('an id with anything after its six digits is not an account, whatever it points at', () => {
    fs.mkdirSync(path.dirname(accountsFile()), { recursive: true });
    fs.writeFileSync(accountsFile(), JSON.stringify({ accounts: [
      { id: 'default', label: 'Account 1' },
      { id: 'acct-a1a1a1/../../Documents', label: 'Traversal' },
      { id: 'acct-a1a1a10', label: 'Seven digits' },
      { id: 'acct-a1a1a1\n', label: 'Newline' },
    ] }));
    expect(readAccountsSettings().accounts.map(a => a.id)).toEqual(['default']);
  });

  it('a folder is never derived from an id that is not one', () => {
    expect(() => accountDir('acct-a1a1a1/../x', root())).toThrow();
    expect(() => accountDir('../Documents', root())).toThrow();
  });

  it('an entry that does not say is enabled', () => {
    const s = normalizeAccountsSettings({ accounts: [{ id: 'default', label: 'Account 1' }, { id: 'acct-b2b2b2', label: 'Two' }] }, root());
    expect(s.accounts.find(a => a.id === 'acct-b2b2b2')?.enabled).toBe(true);
  });

  it('a random id already in the list is drawn again', () => {
    const settings = { ...defaultAccountsSettings(), accounts: [...defaultAccountsSettings().accounts, { id: 'acct-000001', label: 'Two', configDir: path.join(root(), 'acct-000001'), enabled: true }] };
    rb.queue.push(Buffer.from('000001', 'hex'), Buffer.from('000002', 'hex'));
    expect(addAccount(settings, 'Three', root()).account.id).toBe('acct-000002');
  });
});

describe.skipIf(claudeAccountsNotPorted())('claude auth status, what it answers', () => {
  function fakeAnswer(stdout: string, code: number): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-answer-'));
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\nexit ${code}\n`, { mode: 0o755 });
    return bin;
  }

  it('JSON that does not say whether it is signed in is an error, not an answer', async () => {
    await expect(claudeAuthStatus(fakeAnswer('{"authMethod":"none"}', 1), null)).rejects.toThrow(/signed in/);
  });

  it('a signed-out answer carries no e-mail, whatever the output held', async () => {
    const info = await claudeAuthStatus(fakeAnswer('{"loggedIn":false,"email":"x@example.com","subscriptionType":"max"}', 1), null);
    expect(info).toEqual({ signedIn: false, email: null, subscriptionType: null, orgName: null });
  });

  it('a binary that does not run says so', async () => {
    await expect(claudeAuthStatus(path.join(os.tmpdir(), 'no-such-dir-guards', 'claude'), null)).rejects.toThrow(/could not run/);
  });
});
