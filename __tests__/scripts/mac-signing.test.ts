import { describe, it, expect } from 'vitest';
import {
  chooseIdentity, NOTARY_PROFILE, notaryCredentials, parseIdentities, preflight, Refusal, rewriteDmgEntry,
  signatureProblems, signingEnv, spctlVerdict, staplerValid, verifyQuarantined,
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
 * 6. APPLE_ID set without APPLE_APP_PASSWORD or APPLE_TEAM_ID, and the keychain profile is used silently instead, or
 *    the refusal prints a value: it names the missing variables only.
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
    expect(parseIdentities(out)).toEqual([{ hash: HASH_A, name: ID_A }]);
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
    const ids = [{ hash: HASH_A, name: ID_A }, { hash: HASH_B, name: ID_B }];
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

  it('6. APPLE_ID with its two companions: those; with one missing: refused, naming the variables and no value', () => {
    const full = { APPLE_ID: 'someone@example.invalid', APPLE_APP_PASSWORD: 'secret-value', APPLE_TEAM_ID: 'TEAMONE111' };
    expect(notaryCredentials(full)).toEqual({ kind: 'apple-id' });
    for (const missing of ['APPLE_ID', 'APPLE_APP_PASSWORD', 'APPLE_TEAM_ID'] as const) {
      const partial: Record<string, string> = { ...full };
      delete partial[missing];
      let message = '';
      try { notaryCredentials(partial); } catch (err) { message = (err as Error).message; expect(err).toBeInstanceOf(Refusal); }
      expect(message).toContain(missing);
      for (const value of Object.values(full)) expect(message).not.toContain(value);
    }
  });

  it('8. the build gets CSC_NAME and the names electron-builder reads, and no API key that would win over them', () => {
    const id = { hash: HASH_A, name: ID_A };
    const base = { PATH: '/bin', APPLE_API_KEY: '/k.p8', APPLE_API_KEY_ID: 'K', APPLE_API_ISSUER: 'I', APPLE_APP_SPECIFIC_PASSWORD: 'stale' };
    const withProfile = signingEnv(base, id, { kind: 'profile', profile: 'Tars' });
    expect(withProfile).toMatchObject({ PATH: '/bin', CSC_NAME: HASH_A, CSC_IDENTITY_AUTO_DISCOVERY: 'true', APPLE_KEYCHAIN_PROFILE: 'Tars' });
    for (const k of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_ID']) expect(withProfile).not.toHaveProperty(k);

    const env = { ...base, APPLE_ID: 'someone@example.invalid', APPLE_APP_PASSWORD: 'pw', APPLE_TEAM_ID: 'TEAMONE111' };
    const withId = signingEnv(env, id, { kind: 'apple-id' });
    expect(withId).toMatchObject({ CSC_NAME: HASH_A, APPLE_ID: 'someone@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: 'pw', APPLE_TEAM_ID: 'TEAMONE111' });
    for (const k of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN_PROFILE']) expect(withId).not.toHaveProperty(k);
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
    expect(got.identity).toEqual({ hash: HASH_A, name: ID_A });
    expect(got.credentials).toEqual({ kind: 'profile', profile: 'Tars' });
    expect(got.env).toMatchObject({ CSC_NAME: HASH_A, APPLE_KEYCHAIN_PROFILE: 'Tars', PATH: '/bin' });
  });

  it('6. with APPLE_ID and its companions, notarytool is not asked with the password on its command line', async () => {
    const m = machine({ 'security find-identity -v -p codesigning': findOne });
    const env = { APPLE_ID: 'someone@example.invalid', APPLE_APP_PASSWORD: 'secret-value', APPLE_TEAM_ID: 'TEAMONE111' };
    const got = await preflight({ run: m.run, env, platform: 'darwin' });
    expect(got.credentials).toEqual({ kind: 'apple-id' });
    expect(m.asked.join('\n')).not.toContain('secret-value');
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
  it('11. accepted only as Notarized Developer ID', () => {
    expect(spctlVerdict(0, 'Tars.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: X (T)')).toEqual({ ok: true });
    expect(spctlVerdict(0, 'Tars.app: accepted\nsource=Developer ID\n').ok).toBe(false);
    expect(spctlVerdict(3, 'Tars.app: rejected\nsource=Unnotarized Developer ID\n').ok).toBe(false);
    expect(spctlVerdict(3, 'Tars.app: accepted\nsource=Notarized Developer ID\n').ok).toBe(false);
    expect(spctlVerdict(0, '').ok).toBe(false);
  });

  it('12. a binary signed ad hoc, without a timestamp or without the hardened runtime is named', () => {
    const good = [
      'Executable=/x/spawn-helper', 'CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+2 location=embedded',
      'Authority=Developer ID Application: Example One (TEAMONE111)', 'Authority=Developer ID Certification Authority',
      'Authority=Apple Root CA', 'Timestamp=18 Nov 2026 at 08:00:00', 'TeamIdentifier=TEAMONE111',
    ].join('\n');
    expect(signatureProblems(good)).toEqual([]);
    expect(signatureProblems(good.replace(/Timestamp=.*\n/, ''))).toEqual(['no secure timestamp']);
    expect(signatureProblems(good.replace('flags=0x10000(runtime)', 'flags=0x0(none)'))).toEqual(['no hardened runtime']);
    const adhoc = 'Executable=/x/pty.node\nCodeDirectory v=20400 size=1 flags=0x20002(adhoc,linker-signed) hashes=1+0 location=embedded\nSignature=adhoc\n';
    expect(signatureProblems(adhoc)).toEqual(expect.arrayContaining(['not signed with a Developer ID Application identity']));
    expect(signatureProblems('/x/pty.node: code object is not signed at all')).toEqual(['not signed']);
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
    const result = await verifyQuarantined({ dmg: '/nowhere/Tars-2.0.7-arm64.dmg', run: m.run, platform: 'darwin' });
    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toMatch(/hdiutil|ditto|could not/);
  });

  it('9. refused off macOS', async () => {
    const m = machine({});
    const result = await verifyQuarantined({ dmg: '/nowhere/x.dmg', run: m.run, platform: 'linux' });
    expect(result.ok).toBe(false);
    expect(m.asked).toEqual([]);
  });
});
