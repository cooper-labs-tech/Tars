#!/usr/bin/env node
/**
 * A macOS release of Tars, signed with a "Developer ID Application" identity, notarized by Apple and stapled, so
 * that a copy downloaded through Safari (quarantined) opens without Gatekeeper's "damaged" or "could not verify".
 * `npm run release` (scripts/release.mjs) calls it in three places:
 *
 *   preflight  before anything is built: a valid Developer ID Application identity in the keychain, and notary
 *              credentials that answer (the keychain profile "Tars", or APPLE_ID, APPLE_APP_PASSWORD and
 *              APPLE_TEAM_ID). Either missing stops the release there: a mac release is never signed ad hoc.
 *              It hands the build the variables electron-builder reads: CSC_NAME, and APPLE_KEYCHAIN_PROFILE or
 *              APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID. electron-builder then signs every Mach-O
 *              of the app with the hardened runtime and a secure timestamp (@electron/osx-sign), and notarizes and
 *              staples the app (mac.notarize) before it makes the dmg and the zip.
 *   finishDmg  after the build: the dmg signed (with a secure timestamp, which electron-builder's own dmg signing
 *              does not give), notarized and stapled, then its block map and its entry in latest-mac.yml
 *              recomputed, since the staple changes its bytes.
 *   verifyQuarantined  before anything is published: the dmg and the app it holds, copied and quarantined as Safari
 *              does, judged as Gatekeeper judges a download (codesign --verify --deep --strict, spctl as
 *              "Notarized Developer ID", stapler validate), and every Mach-O inside signed with a Developer ID
 *              Application identity, a secure timestamp and the hardened runtime.
 *
 * The credentials are the owner's alone: nothing here creates or changes a keychain item, and no Apple ID,
 * password or team ID is printed. `node scripts/mac-signing.mjs check` runs the preflight on its own;
 * `node scripts/mac-signing.mjs verify <dmg>` runs the checks on a dmg.
 */
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as defaultRun } from './prune-releases.mjs';

/** A reason to stop a release. scripts/release.mjs reports it and exits 1. */
export class Refusal extends Error {}

/** The notarytool keychain profile the owner stores once (`xcrun notarytool store-credentials Tars`). */
export const NOTARY_PROFILE = 'Tars';

const ID_TRIO = ['APPLE_ID', 'APPLE_APP_PASSWORD', 'APPLE_TEAM_ID'];

const OWNER_IDENTITY = 'the owner creates a "Developer ID Application" certificate in the team\'s Apple Developer account and installs it, with its private key, in the login keychain of this Mac';
const OWNER_PROFILE = `the owner stores it once with \`xcrun notarytool store-credentials ${NOTARY_PROFILE}\`, or sets APPLE_ID, APPLE_APP_PASSWORD and APPLE_TEAM_ID`;

/**
 * The valid "Developer ID Application" identities in `security find-identity -v -p codesigning`'s output. A line
 * with anything after the quoted name (CSSMERR_TP_CERT_REVOKED, _EXPIRED) is not one, nor is any other type.
 */
export function parseIdentities(text) {
  const found = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(Developer ID Application: [^"]+)"\s*$/.exec(line);
    if (m) found.push({ hash: m[1], name: m[2] });
  }
  return found;
}

/** The identity that signs: the only one, or the one CSC_NAME names (by hash or by part of its name). */
export function chooseIdentity(identities, cscName) {
  if (identities.length === 0) {
    throw new Refusal(`no valid "Developer ID Application" identity in the keychain (security find-identity -v -p codesigning): ${OWNER_IDENTITY}. A mac release is never signed ad hoc.`);
  }
  if (cscName) {
    const named = identities.filter(i => i.hash === cscName.toUpperCase() || i.name.includes(cscName));
    if (named.length !== 1) throw new Refusal(`CSC_NAME names ${named.length === 0 ? 'none' : 'more than one'} of the ${identities.length} valid "Developer ID Application" identities of the keychain`);
    return named[0];
  }
  if (identities.length > 1) {
    throw new Refusal(`the keychain holds ${identities.length} valid "Developer ID Application" identities: set CSC_NAME to the hash of the one that signs (security find-identity -v -p codesigning)`);
  }
  return identities[0];
}

/** The keychain profile, or the three variables together. Never a value in a refusal. */
export function notaryCredentials(env) {
  const present = ID_TRIO.filter(name => env[name]);
  if (present.length === 0) return { kind: 'profile', profile: NOTARY_PROFILE };
  if (present.length === ID_TRIO.length) return { kind: 'apple-id' };
  const missing = ID_TRIO.filter(name => !env[name]);
  throw new Refusal(`${ID_TRIO.join(', ')} go together, and ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set: set ${missing.length === 1 ? 'it' : 'them'}, or unset all three to use the keychain profile "${NOTARY_PROFILE}"`);
}

/**
 * The environment of the build: CSC_NAME, and the variables electron-builder's mac.notarize reads (app-builder-lib
 * 26 MacTargetHelper.getNotarizeOptions: APPLE_ID with APPLE_APP_SPECIFIC_PASSWORD first, then an API key, then a
 * keychain profile). An API key left in the shell would win over the profile, so it is not passed on.
 */
export function signingEnv(baseEnv, identity, credentials) {
  const env = { ...baseEnv };
  for (const key of ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_KEYCHAIN_PROFILE', 'APPLE_KEYCHAIN']) delete env[key];
  env.CSC_NAME = identity.hash;
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
  if (credentials.kind === 'profile') {
    for (const key of ID_TRIO) delete env[key];
    env.APPLE_KEYCHAIN_PROFILE = credentials.profile;
  } else {
    env.APPLE_APP_SPECIFIC_PASSWORD = baseEnv.APPLE_APP_PASSWORD;
  }
  return env;
}

/**
 * Before anything is built. The keychain profile is asked with `notarytool history`, which needs only the profile
 * and the network. The three variables are not tried: notarytool would take the password on its command line.
 */
export async function preflight({ run = defaultRun, env = process.env, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Refusal(`a mac release is signed and notarized on macOS only, and this is ${platform}`);
  const found = await run('security', ['find-identity', '-v', '-p', 'codesigning']);
  if (found.missing || found.code !== 0) throw new Refusal(`security find-identity could not list the codesigning identities (exit ${found.code})`);
  const identity = chooseIdentity(parseIdentities(found.stdout), env.CSC_NAME);
  const credentials = notaryCredentials(env);
  if (credentials.kind === 'profile') {
    const asked = await run('xcrun', ['notarytool', 'history', '--keychain-profile', NOTARY_PROFILE]);
    if (asked.missing || asked.code !== 0) {
      throw new Refusal(`notarytool does not answer with the keychain profile "${NOTARY_PROFILE}" (exit ${asked.code}): ${OWNER_PROFILE}`);
    }
  }
  return { identity, credentials, env: signingEnv(env, identity, credentials) };
}

/** latest-mac.yml with the sha512 and size of one dmg's entry changed, and nothing else. */
export function rewriteDmgEntry(yml, dmgName, { sha512, size }) {
  const lines = yml.split('\n');
  const at = lines.indexOf(`  - url: ${dmgName}`);
  if (at < 0) throw new Refusal(`latest-mac.yml has no entry for ${dmgName}`);
  let shaLine = -1;
  let sizeLine = -1;
  for (let i = at + 1; i < lines.length && lines[i].startsWith('    '); i++) {
    if (lines[i].startsWith('    sha512: ')) shaLine = i;
    if (lines[i].startsWith('    size: ')) sizeLine = i;
  }
  if (shaLine < 0 || sizeLine < 0) throw new Refusal(`the entry of ${dmgName} in latest-mac.yml has no ${shaLine < 0 ? 'sha512' : 'size'}`);
  lines[shaLine] = `    sha512: ${sha512}`;
  lines[sizeLine] = `    size: ${size}`;
  return lines.join('\n');
}

/** spctl's verdict: accepted, as a notarized Developer ID, and exit 0. */
export function spctlVerdict(code, output) {
  const text = String(output);
  if (code === 0 && /: accepted\b/.test(text) && /^source=Notarized Developer ID$/m.test(text)) return { ok: true };
  const source = /^source=(.*)$/m.exec(text)?.[1];
  return { ok: false, why: `exit ${code}, ${/: rejected\b/.test(text) ? 'rejected' : /: accepted\b/.test(text) ? 'accepted' : 'no verdict'}${source ? `, source=${source}` : ''}` };
}

/** What is wrong with one binary's signature, from `codesign -dvv --verbose=4`. */
export function signatureProblems(output) {
  const text = String(output);
  if (/code object is not signed at all|not signed/.test(text) && !/^Authority=/m.test(text) && !/^Signature=/m.test(text)) return ['not signed'];
  const problems = [];
  if (!/^Authority=Developer ID Application: /m.test(text)) problems.push('not signed with a Developer ID Application identity');
  if (!/^Timestamp=/m.test(text)) problems.push('no secure timestamp');
  const flags = /^CodeDirectory .*flags=0x[0-9a-f]+\(([^)]*)\)/m.exec(text)?.[1] ?? '';
  if (!flags.split(',').includes('runtime')) problems.push('no hardened runtime');
  return problems;
}

/** stapler validate: its success line and exit 0. */
export function staplerValid(code, output) {
  return code === 0 && /The validate action worked!/.test(String(output));
}

const MACHO = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca']);

/** Every Mach-O file under a folder, symbolic links left alone (a framework's Versions/Current). */
export function machOFiles(root) {
  const found = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || statSync(full).size < 4) continue;
      const head = Buffer.alloc(4);
      const fd = openSync(full, 'r');
      try { readSync(fd, head, 0, 4, 0); } finally { closeSync(fd); }
      if (MACHO.has(head.toString('hex'))) found.push(full);
    }
  };
  walk(root);
  return found;
}

/** The quarantine Safari puts on a download. */
const quarantine = () => `0083;${Math.floor(Date.now() / 1000).toString(16)};Safari;`;

/**
 * The dmg and its app, as a download through Safari is: copied, quarantined, then judged. Every check runs; the
 * result lists what passed and what failed, and a step that could not run is a failure.
 */
export async function verifyQuarantined({ dmg, run = defaultRun, platform = process.platform, log = () => {} }) {
  const failures = [];
  const passed = [];
  if (platform !== 'darwin') return { ok: false, failures: [`the checks run on macOS only, and this is ${platform}`], passed };
  const step = async (what, cmd, args) => {
    const r = await run(cmd, args);
    if (r.missing) failures.push(`${what}: could not run ${cmd}`);
    return r;
  };
  const work = mkdtempSync(join(tmpdir(), 'tars-gatekeeper-'));
  const copy = join(work, basename(dmg));
  const mount = join(work, 'mnt');
  let mounted = false;
  try {
    const copied = await step('copy of the dmg', 'ditto', [dmg, copy]);
    if (copied.code !== 0) {
      if (!copied.missing) failures.push(`copy of the dmg: ditto exited ${copied.code}`);
      return { ok: false, failures, passed };
    }
    const q = await step('quarantine of the dmg', 'xattr', ['-w', 'com.apple.quarantine', quarantine(), copy]);
    if (q.code !== 0) { if (!q.missing) failures.push(`quarantine of the dmg: xattr exited ${q.code}`); return { ok: false, failures, passed }; }

    const dmgSpctl = await step('spctl on the dmg', 'spctl', ['-a', '-vv', '-t', 'open', '--context', 'context:primary-signature', copy]);
    if (!dmgSpctl.missing) {
      const v = spctlVerdict(dmgSpctl.code, `${dmgSpctl.stdout}${dmgSpctl.stderr}`);
      (v.ok ? passed : failures).push(`spctl -t open on the dmg: ${v.ok ? 'accepted, Notarized Developer ID' : v.why}`);
    }
    const dmgStaple = await step('stapler on the dmg', 'xcrun', ['stapler', 'validate', copy]);
    if (!dmgStaple.missing) (staplerValid(dmgStaple.code, `${dmgStaple.stdout}${dmgStaple.stderr}`) ? passed : failures).push(`stapler validate on the dmg: exit ${dmgStaple.code}`);

    const attached = await step('mount of the dmg', 'hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, copy]);
    if (attached.code !== 0) { if (!attached.missing) failures.push(`mount of the dmg: hdiutil exited ${attached.code}`); return { ok: false, failures, passed }; }
    mounted = true;
    const appName = readdirSync(mount).find(n => n.endsWith('.app'));
    if (!appName) { failures.push('the dmg holds no .app'); return { ok: false, failures, passed }; }
    const app = join(work, appName);
    const appCopied = await step('copy of the app', 'ditto', [join(mount, appName), app]);
    if (appCopied.code !== 0) { if (!appCopied.missing) failures.push(`copy of the app: ditto exited ${appCopied.code}`); return { ok: false, failures, passed }; }
    await step('unmount', 'hdiutil', ['detach', mount]);
    mounted = false;
    const qa = await step('quarantine of the app', 'xattr', ['-w', 'com.apple.quarantine', quarantine(), app]);
    if (qa.code !== 0 && !qa.missing) failures.push(`quarantine of the app: xattr exited ${qa.code}`);

    const verify = await step('codesign on the app', 'codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    if (!verify.missing) (verify.code === 0 ? passed : failures).push(`codesign --verify --deep --strict on the app: exit ${verify.code}${verify.code === 0 ? '' : `, ${String(verify.stderr).trim().split('\n').pop()}`}`);
    const appSpctl = await step('spctl on the app', 'spctl', ['--assess', '--type', 'exec', '-vv', app]);
    if (!appSpctl.missing) {
      const v = spctlVerdict(appSpctl.code, `${appSpctl.stdout}${appSpctl.stderr}`);
      (v.ok ? passed : failures).push(`spctl --assess --type exec on the app: ${v.ok ? 'accepted, Notarized Developer ID' : v.why}`);
    }
    const appStaple = await step('stapler on the app', 'xcrun', ['stapler', 'validate', app]);
    if (!appStaple.missing) (staplerValid(appStaple.code, `${appStaple.stdout}${appStaple.stderr}`) ? passed : failures).push(`stapler validate on the app: exit ${appStaple.code}`);

    const binaries = machOFiles(app);
    let nestedBad = 0;
    for (const file of binaries) {
      const shown = await step(`codesign on ${file.slice(app.length + 1)}`, 'codesign', ['-dvv', '--verbose=4', file]);
      if (shown.missing) break;
      const problems = signatureProblems(`${shown.stdout}${shown.stderr}`);
      if (problems.length) { nestedBad++; failures.push(`${file.slice(app.length + 1)}: ${problems.join(', ')}`); }
    }
    if (binaries.length && nestedBad === 0) passed.push(`${binaries.length} Mach-O files, each signed with a Developer ID Application identity, a secure timestamp and the hardened runtime`);
    log(`checked a quarantined copy of ${basename(dmg)} and of ${appName}`);
  } finally {
    if (mounted) await run('hdiutil', ['detach', mount]);
    rmSync(work, { recursive: true, force: true });
  }
  return { ok: failures.length === 0, failures, passed };
}

/**
 * After electron-builder: the dmg signed with a secure timestamp, notarized and stapled (@electron/notarize submits
 * a .dmg as it is and staples it), then its block map and its entry in latest-mac.yml recomputed by
 * electron-builder's own blockmap, which reproduces the manifest byte for byte (measured on 2.0.6's dmg, 18/11).
 */
export async function finishDmg({ releaseDir, version, identity, credentials, env = process.env, run = defaultRun, log = () => {}, notarize, buildBlockMap }) {
  const ymlPath = join(releaseDir, 'latest-mac.yml');
  const dmgName = `Tars-${version}-arm64.dmg`;
  const dmg = join(releaseDir, dmgName);
  if (!existsSync(dmg)) throw new Refusal(`${dmg} does not exist`);
  const require = createRequire(import.meta.url);
  notarize ??= (await import('@electron/notarize')).notarize;
  buildBlockMap ??= require('app-builder-lib/out/targets/blockmap/blockmap').buildBlockMap;

  const signed = await run('codesign', ['--force', '--sign', identity.hash, '--timestamp', dmg]);
  if (signed.missing || signed.code !== 0) throw new Refusal(`codesign could not sign ${dmgName} (exit ${signed.code})`);
  log(`${dmgName} signed with a secure timestamp`);

  const options = credentials.kind === 'profile'
    ? { appPath: dmg, keychainProfile: credentials.profile }
    : { appPath: dmg, appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_PASSWORD, teamId: env.APPLE_TEAM_ID };
  try {
    await notarize(options);
  } catch (err) {
    // Its message is notarytool's, which names the submission, never a credential.
    throw new Refusal(`notarization of ${dmgName} failed: ${String(err?.message ?? err).split('\n')[0]}`);
  }
  log(`${dmgName} notarized and stapled`);

  const info = await buildBlockMap(dmg, 'gzip', `${dmg}.blockmap`);
  writeFileSync(ymlPath, rewriteDmgEntry(readFileSync(ymlPath, 'utf8'), dmgName, info));
  log(`${dmgName}.blockmap and its entry in latest-mac.yml recomputed`);
}

async function cli(argv) {
  const [command, target] = argv;
  if (command === 'check') {
    const got = await preflight();
    console.log(`ready: a valid Developer ID Application identity (${got.identity.hash.slice(0, 8)}...), notary credentials: ${got.credentials.kind === 'profile' ? `keychain profile "${got.credentials.profile}"` : 'APPLE_ID, APPLE_APP_PASSWORD and APPLE_TEAM_ID'}`);
    return 0;
  }
  if (command === 'verify' && target) {
    const result = await verifyQuarantined({ dmg: realpathSync(target), log: line => console.log(line) });
    for (const line of result.passed) console.log(`PASS ${line}`);
    for (const line of result.failures) console.log(`FAIL ${line}`);
    console.log(result.ok ? 'ALL PASS' : `${result.failures.length} FAIL`);
    return result.ok ? 0 : 1;
  }
  console.error('usage: node scripts/mac-signing.mjs check | verify <dmg>');
  return 2;
}

function invokedDirectly() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  cli(process.argv.slice(2)).then(code => process.exit(code), err => {
    if (err instanceof Refusal) { console.error(`mac signing: ${err.message}`); process.exit(1); }
    throw err;
  });
}
