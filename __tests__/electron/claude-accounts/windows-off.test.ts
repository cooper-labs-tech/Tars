import '../../setup/home-guard';
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { accountsFile, readAccountsSettings } from '../../../electron/services/claude-accounts/registry';

/**
 * Several Claude accounts are off on a Windows build until they are ported
 * (their folders' owner-only checks are POSIX modes, and their sign-in starts
 * claude by its bare name). This is the main process's side, the one that
 * starts agents on an account; Settings still shows the switch on Windows at this point.
 *
 * How it fails, written before the code:
 * 1. On win32 a registry that says on (copied from a Mac, edited by hand, or
 *    written through the IPC) turns the option on: agents would start with the
 *    CLAUDE_CONFIG_DIR of a folder Windows never provisioned or protected.
 * 2. Over-correction: on darwin or linux the option no longer reads as on.
 * 3. The accounts themselves are lost on win32, so a later port, or the same
 *    file back on a Mac, finds account 1 alone.
 */

const ON = {
  enabled: true,
  accounts: [
    { id: 'default', label: 'Account 1', configDir: null, enabled: true },
    { id: 'acct-a1b2c3', label: 'Work', configDir: '/somewhere/acct-a1b2c3', enabled: true },
  ],
};

beforeEach(() => {
  fs.mkdirSync(path.dirname(accountsFile()), { recursive: true });
  fs.writeFileSync(accountsFile(), JSON.stringify(ON));
});

describe('the Claude accounts option on a Windows build', () => {
  it('1. reads as off on win32, whatever the registry says', () => {
    expect(readAccountsSettings('win32').enabled).toBe(false);
  });

  it.each(['darwin', 'linux'] as const)('2. reads as the registry says on %s', (platform) => {
    expect(readAccountsSettings(platform).enabled).toBe(true);
  });

  it('3. keeps the accounts the registry lists on win32', () => {
    expect(readAccountsSettings('win32').accounts.map(a => a.id)).toEqual(['default', 'acct-a1b2c3']);
  });
});
