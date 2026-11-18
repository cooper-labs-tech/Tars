import { describe, it, expect } from 'vitest';
import {
  chooseIdentity, NOTARY_PROFILE, notaryCredentials, parseIdentities, preflight, Refusal, rewriteDmgEntry,
  signatureProblems, signingEnv, spctlVerdict, staplerValid, startCheck, verifyQuarantined,
} from '../../scripts/mac-signing.mjs';

/**
 * A signed and notarized macOS release (scripts/mac-signing.mjs, called by `npm run release`, scripts/release.mjs).
 * Today a dmg downloaded through Safari is refused by Gatekeeper: the app carries only Electron's linker signature,
 * nothing notarizes it (measured 24/09 and again 18/11: build.afterSign null, 0 codesigning identities).
 *
 * How it fails, written before the code (18/11):
 * Finding the signing identity (`security find-identity -v -p codesigning`):
 * 1. An "Apple Development", "Mac Developer" or "Developer ID Installer" identity is taken for the one that signs
 *    a release: only "Developer ID Application" passes Gatekeeper outside the App Store.
 * 2. A revoked or expired identity is taken (security lists it with a CSSMERR_ suffix), or the count line
 *    "N valid identities found" is read as an identity.
 * 3. No identity, and the release goes on: electron-builder then signs ad hoc, which a quarantined copy fails.
 * 4. Several Developer ID identities, and one is picked at random; or CSC_NAME names one that is not there, and
 *    another is used.
 * Notary credentials:
 * 5. Neither APPLE_ID nor a keychain profile, and notarization is skipped (electron-builder only warns, measured in
 *    app-builder-lib 26.15.3 notarizeIfProvided): the release would ship signed but not notarized.
 * 6. (replaced by the Audit's M1 on #591, 18/11) APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID or
 *    APPLE_APP_SPECIFIC_PASSWORD set, and notarization runs with them: @electron/notarize 3.1.1 puts the
 *    app-specific password on notarytool's command line (lib/notarytool.js authorizationArgs), which every process of
 *    the user reads through ps for the minutes of a notarization. Refused, naming the profile to store and no value.
 * 7. The keychain profile "Tars" does not exist (notarytool history fails), and the build starts anyway: an hour of
 *    building lost at the notarization, or worse, skipped.
 * 8. The build is handed the wrong variables: electron-builder reads APPLE_APP_SPECIFIC_PASSWORD (not
 *    APPLE_APP_PASSWORD, the repository's name) and APPLE_KEYCHAIN_PROFILE, and prefers an APPLE_API_KEY left in the
 *    shell over the profile; CSC_NAME must be the identity chosen.
 * 9. Run on Linux or Windows: a mac release is refused there before anything else, never attempted.
 * The dmg, signed, notarized and stapled after electron-builder made it:
 * 10. Stapling changes the dmg's bytes, and latest-mac.yml keeps the old sha512 and size: the rewrite changes the
 *     dmg's entry only, never the zip's (the update path) nor the top-level path and sha512, and refuses a manifest
 *     with no entry for that dmg.
 * The checks on a quarantined copy (what a download through Safari is):
 * 11. spctl answers "accepted" for a Developer ID signature that is not notarized, and the check passes: it must be
 *     "source=Notarized Developer ID". A "rejected", or a non-zero exit, passes.
 * 12. A nested binary (node-pty's spawn-helper, a .node of better-sqlite3) is signed ad hoc, or without a secure
 *     timestamp, or without the hardened runtime, and nothing says so.
 * 13. stapler validate's failure reads as a pass.
 * 14. The verification passes when one of its steps could not run (hdiutil, ditto, xattr, codesign missing).
 * Written before the code of the second round (the Audit's L2 on #591, 18/11):
 * 15. A nested binary, or the app or the dmg, signed with another team's Developer ID passes: the Team ID is the
 *     signing identity's, read at run time from it (the parenthesis of its name), never written in the repository.
 * 16. A CSC_LINK or CSC_KEY_PASSWORD left in the shell reaches the build, which would sign with that p12 instead.
 * 17. The checks run with no Team ID to pin, and pass any team.
 * Written before the code of the third round (the Audit's L5 on #591, 18/11):
 * 18. Nothing starts the quarantined app: one that aborts at launch passes every check (a plist without allow-jit
 *     signs, notarizes and staples, and V8 aborts, exit 133, measured). Its binary is run once as Node, as the MCP
 *     servers run it, loading better-sqlite3 and spawning a shell through node-pty from its own app.asar: any exit
 *     but 0 fails, with the exit and stderr's first line.
 * 19. An exit 0 whose output lacks the exact result line (a module that did not load, a shell that printed nothing)
 *     passes.
 * 20. A binary that could not be run passes, or the check runs in the release's own environment (a stray
 *     ELECTRON_ or NODE_ variable of the shell changing what it proves).
 */

type Answer = { code: number; stdout?: string; stderr?: string; missing?: boolean };
/** A machine that answers each command line it is asked from a table, and fails any it was not told about. */
function machine(answers: Record<string, Answer | ((args: string[]) => Answer)>) {
  const asked: string[] = [];
  const run = async (cmd: string, args: string[]) => {
    const line = [cmd, ...args].join(' ');
    asked.push(line);
    const key = Object.keys(answers).find(k => line.startsWith(k));
    if (!key) return { code: 127, stdout: '', stderr: `not on this machine: ${line}`, missing: true };
    const a = answers[key];
    const got = typeof a === 'function' ? a(args) : a;
    return { stdout: '', stderr: '', missing: false, ...got };
  };
  return { run, asked };
}

const HASH_A = 'A'.repeat(40);
const HASH_B = 'B'.repeat(40);
const ID_A = `Developer ID Application: Example One (TEAMONE111)`;
const ID_B = `Developer ID Application: Example Two (TEAMTWO222)`;
const FIND = (lines: string[]) => [...lines.map((l, i) => `  ${i + 1}) ${l}`), `     ${lines.length} valid identities found`, ''].join('\n');

describe('the signing identity', () => {
  it('1. only "Developer ID Application" identities count', () => {
    const out = FIND([
      `${'C'.repeat(40)} "Apple Development: someone (ABCDEF1234)"`,
      `${'D'.repeat(40)} "Mac Developer: someone (ABCDEF1234)"`,
      `${'E'.repeat(40)} "Developer ID Installer: Example One (TEAMONE111)"`,
      `${HASH_A} "${ID_A}"`,
    ]);
    expect(parseIdentities(out)).toEqual([{ hash: HASH_A, name: ID_A, team: 'TEAMONE111' }]);
  });

  it('2. a revoked or expired identity, and the count line, are not identities', () => {
    const out = [
      `  1) ${HASH_B} "${ID_B}" (CSSMERR_TP_CERT_REVOKED)`,
      `  2) ${'F'.repeat(40)} "Developer ID Application: Old (OLDTEAM000)" (CSSMERR_TP_CERT_EXPIRED)`,
      '     2 valid identities found',
    ].join('\n');
    expect(parseIdentities(out)).toEqual([]);
    expect(parseIdentities('     0 valid identities found\n')).toEqual([]);
  });

  it('3. none: refused, saying what the owner does', () => {
    expect(() => chooseIdentity([], undefined)).toThrow(Refusal);
    expect(() => chooseIdentity([], undefined)).toThrow(/Developer ID Application/);
  });

  it('4. several: refused without CSC_NAME, refused when CSC_NAME names none of them, else the one it names', () => {
    const ids = [{ hash: HASH_A, name: ID_A, team: 'TEAMONE111' }, { hash: HASH_B, name: ID_B, team: 'TEAMTWO222' }];
    expect(() => chooseIdentity(ids, undefined)).toThrow(/CSC_NAME/);
    expect(() => chooseIdentity(ids, 'Nobody')).toThrow(Refusal);
    expect(chooseIdentity(ids, HASH_B)).toEqual(ids[1]);
    expect(chooseIdentity(ids, 'Example One')).toEqual(ids[0]);
    expect(chooseIdentity([ids[0]], undefined)).toEqual(ids[0]);
    expect(() => chooseIdentity([ids[0]], 'Example Two')).toThrow(Refusal);
  });
});

describe('the notary credentials', () => {
  it('5. nothing set: the keychain profile named Tars', () => {
    expect(NOTARY_PROFILE).toBe('Tars');
    expect(notaryCredentials({})).toEqual({ kind: 'profile', profile: 'Tars' });
  });

  it('6. any of the password variables: refused, saying why and how to store the profile, and naming no value', () => {
    const values = { APPLE_ID: 'someone@example.invalid', APPLE_APP_PASSWORD: 'secret-value', APPLE_TEAM_ID: 'TEAMONE111', APPLE_APP_SPECIFIC_PASSWORD: 'other-secret' };
    for (const set of [['APPLE_ID', 'APPLE_APP_PASSWORD', 'APPLE_TEAM_ID'], ['APPLE_ID'], ['APPLE_APP_PASSWORD'], ['APPLE_TEAM_ID'], ['APPLE_APP_SPECIFIC_PASSWORD']] as const) {
      const env = Object.fromEntries(set.map(k => [k, values[k]]));
      let message = '';
      try { notaryCredentials(env); } catch (err) { message = (err as Error).message; expect(err).toBeInstanceOf(Refusal); }
      expect(message, set.join(',')).toMatch(/command line/);
      expect(message).toMatch(/notarytool store-credentials Tars/);
      for (const value of Object.values(values)) expect(message).not.toContain(value);
    }
  });

  it('8, 16. the build gets CSC_NAME and the profile, and nothing that would sign or notarize with something else', () => {
    const id = { hash: HASH_A, name: ID_A, team: 'TEAMONE111' };
    const base = {
      PATH: '/bin', APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'K', APPLE_API_ISSUER: 'I', APPLE_APP_SPECIFIC_PASSWORD: 'stale',
      CSC_LINK: '/somewhere/cert.p12', CSC_KEY_PASSWORD: 'p12-secret',
    };
    const env = signingEnv(base, id, { kind: 'profile', profile: 'Tars' });
    expect(env).toMatchObject({ PATH: '/bin', CSC_NAME: HASH_A, CSC_IDENTITY_AUTO_DISCOVERY: 'true', APPLE_KEYCHAIN_PROFILE: 'Tars' });
    for (const k of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_ID', 'APPLE_APP_PASSWORD', 'APPLE_TEAM_ID', 'CSC_LINK', 'CSC_KEY_PASSWORD']) {
      expect(env, k).not.toHaveProperty(k);
    }
    expect(base).not.toHaveProperty('CSC_NAME');
  });
});

describe('the preflight, before anything is built', () => {
  const findOne = { code: 0, stdout: FIND([`${HASH_A} "${ID_A}"`]) };

  it('9. refused off macOS, before asking anything', async () => {
    for (const platform of ['linux', 'win32']) {
      const m = machine({});
      await expect(preflight({ run: m.run, env: {}, platform })).rejects.toThrow(/macOS/);
      expect(m.asked).toEqual([]);
    }
  });

  it('3. refused with no identity, and notarytool is never asked', async () => {
    const m = machine({ 'security find-identity -v -p codesigning': { code: 0, stdout: '     0 valid identities found\n' } });
    await expect(preflight({ run: m.run, env: {}, platform: 'darwin' })).rejects.toThrow(/Developer ID Application/);
    expect(m.asked.some(l => l.includes('notarytool'))).toBe(false);
  });

  it('14. refused when security itself cannot run', async () => {
    const m = machine({ 'security find-identity': { code: 1, stderr: 'boom' } });
    await expect(preflight({ run: m.run, env: {}, platform: 'darwin' })).rejects.toThrow(Refusal);
  });

  it('7. refused when the keychain profile does not answer, and its output is not repeated', async () => {
    const m = machine({
      'security find-identity -v -p codesigning': findOne,
      'xcrun notarytool history --keychain-profile Tars': { code: 69, stderr: 'Error: No Keychain password item found for profile: Tars someone@example.invalid' },
    });
    let message = '';
    try { await preflight({ run: m.run, env: {}, platform: 'darwin' }); } catch (err) { message = (err as Error).message; expect(err).toBeInstanceOf(Refusal); }
    expect(message).toMatch(/notarytool store-credentials/);
    expect(message).not.toContain('someone@example.invalid');
  });

  it('passes with one identity and a profile that answers, and hands the build its environment', async () => {
    const m = machine({
      'security find-identity -v -p codesigning': findOne,
      'xcrun notarytool history --keychain-profile Tars': { code: 0, stdout: 'Successfully received submission history.' },
    });
    const got = await preflight({ run: m.run, env: { PATH: '/bin' }, platform: 'darwin' });
    expect(got.identity).toEqual({ hash: HASH_A, name: ID_A, team: 'TEAMONE111' });
    expect(got.credentials).toEqual({ kind: 'profile', profile: 'Tars' });
    expect(got.env).toMatchObject({ CSC_NAME: HASH_A, APPLE_KEYCHAIN_PROFILE: 'Tars', PATH: '/bin' });
  });

  it('6. with the password variables set, refused, and nothing is asked with them', async () => {
    const m = machine({ 'security find-identity -v -p codesigning': findOne });
    const env = { APPLE_ID: 'someone@example.invalid', APPLE_APP_PASSWORD: 'secret-value', APPLE_TEAM_ID: 'TEAMONE111' };
    await expect(preflight({ run: m.run, env, platform: 'darwin' })).rejects.toThrow(/command line/);
    expect(m.asked.join('\n')).not.toContain('secret-value');
    expect(m.asked.some(l => l.includes('notarytool'))).toBe(false);
  });
});

describe('the manifest after the dmg is stapled', () => {
  const YML = [
    'version: 2.0.7',
    'files:',
    '  - url: Tars-2.0.7-arm64-mac.zip',
    '    sha512: ZIPSHA==',
    '    size: 100',
    '  - url: Tars-2.0.7-arm64.dmg',
    '    sha512: OLDDMG==',
    '    size: 200',
    'path: Tars-2.0.7-arm64-mac.zip',
    'sha512: ZIPSHA==',
    "releaseDate: '2026-11-18T08:00:00.000Z'",
    '',
  ].join('\n');

  it('10. changes the dmg entry alone', () => {
    const out = rewriteDmgEntry(YML, 'Tars-2.0.7-arm64.dmg', { sha512: 'NEWDMG==', size: 205 });
    expect(out).toBe(YML.replace('OLDDMG==', 'NEWDMG==').replace('size: 200', 'size: 205'));
  });

  it('10. refuses a manifest that names no such dmg, or whose dmg entry lacks its sha512 or size', () => {
    expect(() => rewriteDmgEntry(YML, 'Tars-2.0.8-arm64.dmg', { sha512: 'X', size: 1 })).toThrow(Refusal);
    expect(() => rewriteDmgEntry(YML.replace('    size: 200\n', ''), 'Tars-2.0.7-arm64.dmg', { sha512: 'X', size: 1 })).toThrow(Refusal);
    expect(() => rewriteDmgEntry(YML.replace('    sha512: OLDDMG==\n', ''), 'Tars-2.0.7-arm64.dmg', { sha512: 'X', size: 1 })).toThrow(Refusal);
  });
});

describe('what a quarantined copy is judged', () => {
  it('11, 15. accepted only as Notarized Developer ID, signed by the signing identity\'s team', () => {
    const ours = 'Tars.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Example One (TEAMONE111)';
    expect(spctlVerdict(0, ours, 'TEAMONE111')).toEqual({ ok: true });
    expect(spctlVerdict(0, ours, 'TEAMTWO222').ok).toBe(false);
    expect(spctlVerdict(0, 'Tars.app: accepted\nsource=Notarized Developer ID\n', 'TEAMONE111').ok).toBe(false);
    expect(spctlVerdict(0, 'Tars.app: accepted\nsource=Developer ID\norigin=Developer ID Application: Example One (TEAMONE111)', 'TEAMONE111').ok).toBe(false);
    expect(spctlVerdict(3, 'Tars.app: rejected\nsource=Unnotarized Developer ID\n', 'TEAMONE111').ok).toBe(false);
    expect(spctlVerdict(3, ours, 'TEAMONE111').ok).toBe(false);
    expect(spctlVerdict(0, '', 'TEAMONE111').ok).toBe(false);
  });

  it('12, 15. a binary signed ad hoc, without a timestamp, without the hardened runtime, or by another team is named', () => {
    const good = [
      'Executable=/x/spawn-helper', 'CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+2 location=embedded',
      'Authority=Developer ID Application: Example One (TEAMONE111)', 'Authority=Developer ID Certification Authority',
      'Authority=Apple Root CA', 'Timestamp=18 Nov 2026 at 08:00:00', 'TeamIdentifier=TEAMONE111',
    ].join('\n');
    expect(signatureProblems(good, 'TEAMONE111')).toEqual([]);
    expect(signatureProblems(good, 'TEAMTWO222')).toEqual(['signed by team TEAMONE111, not TEAMTWO222']);
    expect(signatureProblems(good.replace('TeamIdentifier=TEAMONE111', ''), 'TEAMONE111')).toEqual(['signed by team none, not TEAMONE111']);
    expect(signatureProblems(good.replace(/Timestamp=.*\n/, ''), 'TEAMONE111')).toEqual(['no secure timestamp']);
    expect(signatureProblems(good.replace('flags=0x10000(runtime)', 'flags=0x0(none)'), 'TEAMONE111')).toEqual(['no hardened runtime']);
    const adhoc = 'Executable=/x/pty.node\nCodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0 location=embedded\nSignature=adhoc\nTeamIdentifier=not set\n';
    expect(signatureProblems(adhoc, 'TEAMONE111')).toEqual(expect.arrayContaining(['not signed with a Developer ID Application identity']));
    expect(signatureProblems('/x/pty.node: code object is not signed at all', 'TEAMONE111')).toEqual(['not signed']);
  });

  it('13. stapler validate passes only on its success line and exit 0', () => {
    expect(staplerValid(0, 'Processing: Tars.dmg\nThe validate action worked!\n')).toBe(true);
    expect(staplerValid(65, 'Processing: Tars.dmg\nTars.dmg does not have a ticket stapled to it.\n')).toBe(false);
    expect(staplerValid(0, 'Processing: Tars.dmg\n')).toBe(false);
    // The success line with a failing exit: added after the mutation bench found the exit code untested (18/11).
    expect(staplerValid(65, 'Processing: Tars.dmg\nThe validate action worked!\n')).toBe(false);
  });

  it('14. a check that could not run fails the verification, and says which', async () => {
    const m = machine({});
    const result = await verifyQuarantined({ dmg: '/nowhere/Tars-2.0.7-arm64.dmg', team: 'TEAMONE111', run: m.run, platform: 'darwin' });
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toMatch(/hdiutil|ditto|could not/);
  });

  it('9. refused off macOS', async () => {
    const m = machine({});
    const result = await verifyQuarantined({ dmg: '/nowhere/x.dmg', team: 'TEAMONE111', run: m.run, platform: 'linux' });
    expect(result.ok).toBe(false);
    expect(m.asked).toEqual([]);
  });

  const APP = '/work/Tars.app';
  const START = 'env -i PATH=/usr/bin:/bin ELECTRON_RUN_AS_NODE=1 /work/Tars.app/Contents/MacOS/Tars -e ';

  it('18. the app is started once as Node, in a clean environment, and an abort fails it', async () => {
    const m = machine({ 'env -i': { code: 133, stderr: '#\n# Fatal process out of memory: Failed to reserve virtual memory for CodeRange\n' } });
    const result = await startCheck({ app: APP, run: m.run });
    expect(result.ok).toBe(false);
    expect(result.why).toMatch(/exit 133/);
    expect(result.why).toMatch(/CodeRange/);
    expect(m.asked).toHaveLength(1);
    expect(m.asked[0].startsWith(START)).toBe(true);
    expect(m.asked[0].endsWith(' /work/Tars.app/Contents/Resources')).toBe(true);
  });

  it('19. passes only on exit 0 with the exact result line', async () => {
    const line = 'tars-start-check sqlite=42 pty=pty-ok exit=0';
    expect((await startCheck({ app: APP, run: machine({ 'env -i': { code: 0, stdout: `${line}\n` } }).run })).ok).toBe(true);
    expect((await startCheck({ app: APP, run: machine({ 'env -i': { code: 0, stdout: '' } }).run })).ok).toBe(false);
    expect((await startCheck({ app: APP, run: machine({ 'env -i': { code: 0, stdout: 'tars-start-check sqlite=42 pty= exit=0\n' } }).run })).ok).toBe(false);
    expect((await startCheck({ app: APP, run: machine({ 'env -i': { code: 1, stdout: `${line}\n` } }).run })).ok).toBe(false);
    // Killed by the system (measured: SIGKILL, 137, for the signed app with its pty.node re-signed ad hoc), which run()
    // reports as -1 with nothing printed: said so, not as "exit -1".
    const killed = await startCheck({ app: APP, run: machine({ 'env -i': { code: -1 } }).run });
    expect(killed.ok).toBe(false);
    expect(killed.why).toMatch(/killed|signal/);
  });

  it('20. a binary that could not be run fails', async () => {
    const result = await startCheck({ app: APP, run: machine({}).run });
    expect(result.ok).toBe(false);
    expect(result.why).toMatch(/could not run/);
  });

  it('17. no Team ID to pin: refused before anything runs', async () => {
    const m = machine({});
    const result = await verifyQuarantined({ dmg: '/nowhere/x.dmg', run: m.run, platform: 'darwin' });
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toMatch(/Team ID/);
    expect(m.asked).toEqual([]);
  });
});
