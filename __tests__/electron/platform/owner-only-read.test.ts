import { describe, it, expect } from 'vitest';

import { sddlOpenness, ownerOnlyDirProblemSync } from '../../../electron/platform/owner-only';

/**
 * Whether a folder is closed to every account but its owner, on Windows: read
 * back from its security descriptor, the way ownerOnlyDirSync leaves one. The
 * Claude accounts' folders must be (services/claude-accounts/provision.ts,
 * folderProblem): on macOS and Linux that is their mode and their uid; Windows
 * has neither, and the accounts were off there for want of this check (the
 * parity program's P6).
 *
 * How it fails, written before the code (2026-10-17):
 * 1. A folder closed as ownerOnlyDirSync leaves it (this user its owner, its
 *    list protected, this user and SYSTEM in it) is refused.
 * 2. A folder another account can open is taken as closed: an Allow entry for
 *    another user, Users, Everyone, Authenticated Users or Administrators; a
 *    list that is not protected from its parent's, or an entry inherited.
 * 3. A folder another account owns (another user, Administrators) is taken as
 *    this user's.
 * 4. A Deny entry, which opens nothing, is taken as an opening; SYSTEM by its
 *    alias (SY) or its SID not recognised.
 * 5. What is not a security descriptor (nothing, an error, garbage) is taken
 *    as closed: a folder that cannot be read is refused.
 * 6. The descriptor is asked of a PowerShell the PATH finds, or with the
 *    folder's path inside the command, where a quote or a $ in it would run:
 *    the program from %SystemRoot%, the path through the environment.
 * 7. darwin and linux run anything: there the mode decides, not this.
 */

const ME = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1002';
const WHOAMI = `"desk\\\\sam","${ME}"\r\n`;

/** As icacls /inheritance:r /grant:r *<me>:(OI)(CI)(F) *S-1-5-18:(OI)(CI)(F) leaves a folder. */
const CLOSED = `O:${ME}G:${ME}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${ME})`;

describe('reading a security descriptor', () => {
  it('1, 4. takes a folder ownerOnlyDirSync closed as closed, SYSTEM by its alias or its SID, a Deny entry opening nothing', () => {
    expect(sddlOpenness(CLOSED, ME)).toBeNull();
    expect(sddlOpenness(`O:${ME}D:P(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;${ME})`, ME)).toBeNull();
    expect(sddlOpenness(`O:${ME}D:PAI(D;OICI;FA;;;WD)(A;OICI;FA;;;${ME})`, ME)).toBeNull();
  });

  it.each([
    ['another user', `(A;OICI;FA;;;${OTHER})`],
    ['Users', '(A;OICI;0x1200a9;;;BU)'],
    ['Everyone', '(A;OICI;FR;;;WD)'],
    ['Authenticated Users', '(A;OICI;0x1301bf;;;AU)'],
    ['Administrators', '(A;OICI;FA;;;BA)'],
  ])('2. refuses a folder %s can open', (_who, ace) => {
    expect(sddlOpenness(`O:${ME}G:${ME}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${ME})${ace}`, ME)).toMatch(/open to other users/);
  });

  it("2. refuses a list that takes its parent's, or holds an inherited entry", () => {
    expect(sddlOpenness(`O:${ME}D:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;${ME})`, ME)).toMatch(/open to other users/);
    expect(sddlOpenness(`O:${ME}D:PAI(A;OICI;FA;;;SY)(A;OICIID;FA;;;${ME})`, ME)).toMatch(/open to other users/);
  });

  it('3. refuses a folder another account owns', () => {
    expect(sddlOpenness(CLOSED.replace(`O:${ME}`, `O:${OTHER}`), ME)).toMatch(/belongs to another user/);
    expect(sddlOpenness(CLOSED.replace(`O:${ME}`, 'O:BA'), ME)).toMatch(/belongs to another user/);
  });

  it('5. refuses what is not a security descriptor', () => {
    for (const text of ['', 'Get-Acl : Cannot find path', 'O:', `D:PAI(A;OICI;FA;;;${ME})`, 'garbage']) {
      expect(sddlOpenness(text, ME), text).toMatch(/could not be read/);
    }
  });
});

describe('a folder on Windows', () => {
  it('6. is read by the PowerShell under %SystemRoot%, its path in the environment, never in the command', () => {
    const asked: { file: string; args: string[]; env?: Record<string, string | undefined> }[] = [];
    const deps = {
      platform: 'win32' as const,
      env: { SystemRoot: 'D:\\Win', Path: 'C:\\planted' },
      execFileSync: () => WHOAMI,
      readSddl: (file: string, args: string[], env: Record<string, string | undefined>) => {
        asked.push({ file, args, env });
        return CLOSED;
      },
    };
    const dir = "C:\\Users\\Sam O'Neil\\.claude-accounts\\acct-a1b2c3 $(calc)";
    expect(ownerOnlyDirProblemSync(dir, deps)).toBeNull();
    expect(asked[0].file).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(asked[0].args.join(' ')).not.toContain(dir);
    expect(asked[0].env?.TARS_ACL_PATH).toBe(dir);
  });

  it('1, 2, 5. answers what the descriptor says, and refuses one it cannot read', () => {
    const deps = (sddl: string | Error) => ({
      platform: 'win32' as const,
      execFileSync: () => WHOAMI,
      readSddl: () => { if (sddl instanceof Error) throw sddl; return sddl; },
    });
    expect(ownerOnlyDirProblemSync('C:\\x', deps(CLOSED))).toBeNull();
    expect(ownerOnlyDirProblemSync('C:\\x', deps(`${CLOSED}(A;OICI;FA;;;BU)`))).toMatch(/open to other users/);
    expect(ownerOnlyDirProblemSync('C:\\x', deps(new Error('Access is denied')))).toMatch(/could not be read/);
  });

  it.each(['darwin', 'linux'] as const)('7. on %s runs nothing', (platform) => {
    const deps = {
      platform,
      execFileSync: () => { throw new Error('nothing runs here'); },
      readSddl: () => { throw new Error('nothing runs here'); },
    };
    expect(ownerOnlyDirProblemSync('/home/sam/.claude-accounts', deps)).toBeNull();
  });
});
