import '../../setup/home-guard';
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readDacls, currentUserSid, normalizeSddl } from './read-dacl';

/**
 * The helper the ACL tests read access lists with (read-dacl.ts).
 *
 * On CI (windows-latest, run 36419462139) it returned nothing and 22 tests
 * failed with "no DACL in ": the step's shell is PowerShell 7, the Windows
 * PowerShell 5.1 it started inherited PSModulePath, found PowerShell 7's
 * Microsoft.PowerShell.Security first, could not load it, and so had no
 * Get-Acl. It printed that to stderr, which the helper dropped, and exited 0.
 *
 * How it can fail, written before the code:
 *  1. A PSModulePath that puts a module 5.1 cannot load first (PowerShell 7's)
 *     leaves the read empty.
 *  2. A read that fails says only "no DACL in": not the command's stderr,
 *     not its exit code, not the path.
 *  3. A read that returns fewer lists than it was asked for is taken as whole,
 *     and the lists are matched to the wrong paths.
 *  4. The user's SID is read the same fragile way.
 *  5. An entry is compared by how SDDL spells its trustee, not by who it is:
 *     on CI (run 36421786193) the runner's account is the built-in
 *     Administrator, RID 500, which SDDL writes \`LA\`, never its SID, so an
 *     access list of exactly that user and SYSTEM failed against one built
 *     from the SID. Any alias does the same (SY, BA, BU, WD, a domain's).
 *  6. An alias that cannot be resolved is passed through, and a list is
 *     compared half by alias, half by SID.
 *  7. Normalizing loses what must stay exact: the protected flag, the kind,
 *     flags and rights of each entry, or an entry altogether.
 *
 * Case 1 is the CI condition, made here with a module manifest that asks for
 * PowerShell 7.0, first on the PSModulePath the test hands down.
 */

const onWindows = process.platform === 'win32';
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-read-dacl-'));
  made.push(dir);
  return dir;
}

/** A Microsoft.PowerShell.Security that Windows PowerShell 5.1 finds and cannot load, as on CI. */
function pwsh7LikeModules(): string {
  const root = path.join(scratch(), 'modules');
  const dir = path.join(root, 'Microsoft.PowerShell.Security');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Microsoft.PowerShell.Security.psd1'), [
    '@{',
    "  ModuleVersion = '7.0.0.0'",
    "  GUID = 'a94c8c7e-9810-47c0-b8af-65089c13a35a'",
    "  CompatiblePSEditions = @('Core')",
    "  PowerShellVersion = '7.0'",
    "  CmdletsToExport = @('Get-Acl', 'Set-Acl')",
    '}',
  ].join('\r\n'));
  return root;
}

describe('normalizeSddl (cases 5 to 7, any platform)', () => {
  const machine = 'S-1-5-21-111-222-333';
  const sidOf = (alias: string): string => {
    const known: Record<string, string> = { LA: `${machine}-500`, BA: 'S-1-5-32-544', SY: 'S-1-5-18', WD: 'S-1-1-0' };
    const sid = known[alias];
    if (!sid) throw new Error(`no SID for ${alias}`);
    return sid;
  };

  it('5: the built-in Administrator written LA is the same entry as its SID', () => {
    expect(normalizeSddl('D:PAI(A;;FA;;;LA)(A;;FA;;;SY)', sidOf)).toEqual(
      normalizeSddl(`D:PAI(A;;FA;;;${machine}-500)(A;;FA;;;S-1-5-18)`, sidOf));
  });

  it('5, 7: every trustee becomes its SID; kind, flags, rights and the protected flag are kept', () => {
    expect(normalizeSddl(`D:PAI(A;OICI;FA;;;BA)(A;ID;0x1200a9;;;${machine}-1001)(D;;FA;;;WD)(A;;FA;;;LA)(A;;FA;;;SY)`, sidOf)).toEqual({
      protectedFromParent: true,
      aces: [
        `(A;;FA;;;${machine}-500)`,
        '(A;;FA;;;S-1-5-18)',
        `(A;ID;0x1200a9;;;${machine}-1001)`,
        '(A;OICI;FA;;;S-1-5-32-544)',
        '(D;;FA;;;S-1-1-0)',
      ].sort(),
    });
    expect(normalizeSddl('D:AI(A;ID;FA;;;SY)', sidOf).protectedFromParent).toBe(false);
  });

  it('6: an alias that cannot be resolved is an error, not a string passed through', () => {
    expect(() => normalizeSddl('D:PAI(A;;FA;;;XX)', sidOf)).toThrow(/XX/);
  });

  it('7: a list with no DACL is an error', () => {
    expect(() => normalizeSddl('O:SYG:SY', sidOf)).toThrow(/no DACL/);
  });
});

describe.runIf(onWindows)('readDacls', { timeout: 120_000 }, () => {
  it('5: reads trustees as SIDs, never as aliases', () => {
    const [list] = readDacls(scratch());
    expect(list.aces.length).toBeGreaterThan(0);
    for (const ace of list.aces) expect(ace, ace).toMatch(/;S-1-[\d-]+\)$/);
  });

  it('1: reads a file and a directory with PowerShell 7 modules first on PSModulePath, as on CI', () => {
    const dir = scratch();
    const file = path.join(dir, 'f.txt');
    fs.writeFileSync(file, 'x');
    const saved = process.env.PSModulePath;
    process.env.PSModulePath = `${pwsh7LikeModules()};${saved ?? ''}`;
    try {
      const [ofFile, ofDir] = readDacls(file, dir);
      expect(ofFile.aces.length).toBeGreaterThan(0);
      expect(ofDir.aces.length).toBeGreaterThan(0);
    } finally {
      process.env.PSModulePath = saved;
    }
  });

  it('2, 3: a read that fails names the path, the exit code and what the command said', () => {
    const missing = path.join(scratch(), 'not-there');
    let caught: Error | undefined;
    try {
      readDacls(missing);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught, 'a missing file must not read as a list').toBeDefined();
    expect(caught!.message).toContain(missing);
    expect(caught!.message).toMatch(/exit \d+/);
    expect(caught!.message).toMatch(/stderr: \S/);
  });

  it('4: the SID is read with PowerShell 7 modules first on PSModulePath too', () => {
    const saved = process.env.PSModulePath;
    process.env.PSModulePath = `${pwsh7LikeModules()};${saved ?? ''}`;
    try {
      expect(currentUserSid()).toMatch(/^S-1-5-21-\d+-\d+-\d+-\d+$/);
    } finally {
      process.env.PSModulePath = saved;
    }
  });
});
