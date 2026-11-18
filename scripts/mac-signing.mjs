#!/usr/bin/env node
/**
 * A macOS release of Tars, signed with a "Developer ID Application" identity, notarized by Apple and stapled, so
 * that a copy downloaded through Safari (quarantined) opens without Gatekeeper's "damaged" or "could not verify".
 * `npm run release` (scripts/release.mjs) calls it in three places:
 *
 *   preflight  before anything is built: a valid Developer ID Application identity in the keychain, and the
 *              notarytool keychain profile "Tars", answering. Either missing stops the release there: a mac
 *              release is never signed ad hoc. The Apple ID variables are refused: @electron/notarize would put
 *              the app-specific password on notarytool's command line, which every process of the user reads.
 *              It hands the build the variables electron-builder reads: CSC_NAME and APPLE_KEYCHAIN_PROFILE.
 *              electron-builder then signs every Mach-O of the app with the hardened runtime and a secure
 *              timestamp (@electron/osx-sign), and notarizes and staples the app (mac.notarize) before it makes
 *              the dmg and the zip.
 *   finishDmg  after the build: the dmg signed (with a secure timestamp, which electron-builder's own dmg signing
 *              does not give), notarized and stapled, then its block map and its entry in latest-mac.yml
 *              recomputed, since the staple changes its bytes.
 *   verifyQuarantined  before anything is published: the dmg and the app it holds, copied and quarantined as Safari
 *              does, judged as Gatekeeper judges a download (codesign --verify --deep --strict, spctl as
 *              "Notarized Developer ID" of the signing identity's team, stapler validate), and every Mach-O
 *              inside signed with a Developer ID Application identity of that team, a secure timestamp and the
 *              hardened runtime. The Team ID is read at run time from the identity, never written here.
 *
 * The credentials are the owner's alone: nothing here creates or changes a keychain item, and no Apple ID or
 * password is printed. `node scripts/mac-signing.mjs check` runs the preflight on its own;
 * `node scripts/mac-signing.mjs verify <dmg> [--team <Team ID>]` runs the checks on a dmg (the team defaults to the
 * keychain's Developer ID Application identity's).
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

/** The variables that would hand notarytool a password on its command line (the Audit's M1 on #591). */
const PASSWORD_VARIABLES = ['APPLE_ID', 'APPLE_APP_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_APP_SPECIFIC_PASSWORD'];

const OWNER_IDENTITY = 'the owner creates a "Developer ID Application" certificate in the team\'s Apple Developer account and installs it, with its private key, in the login keychain of this Mac';
const OWNER_PROFILE = `the owner stores it once with \`xcrun notarytool store-credentials ${NOTARY_PROFILE} --apple-id <apple-id> --team-id <team-id>\`, which asks for the app-specific password at a prompt`;

/**
 * The valid "Developer ID Application" identities in `security find-identity -v -p codesigning`'s output. A line
 * with anything after the quoted name (CSSMERR_TP_CERT_REVOKED, _EXPIRED) is not one, nor is any other type.
 */
export function parseIdentities(text) {
  const found = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(Developer ID Application: [^"]+ \(([0-9A-Z]{10})\))"\s*$/.exec(line);
    if (m) found.push({ hash: m[1], name: m[2], team: m[3] });
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

/**
 * The keychain profile, and nothing else. With an Apple ID and its app-specific password, @electron/notarize 3.1.1
 * (lib/notarytool.js authorizationArgs) runs `notarytool submit ... --password <password> --wait`: readable through
 * ps by every process of the user, every agent included, for the minutes of each notarization. Never a value in the
 * refusal.
 */
export function notaryCredentials(env) {
  const set = PASSWORD_VARIABLES.filter(name => env[name]);
  if (set.length) {
    throw new Refusal(`${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} set: a mac release does not notarize with an Apple ID and its password, which notarytool would carry on its command line, readable by every process of this user. Unset ${set.length === 1 ? 'it' : 'them'}; ${OWNER_PROFILE}`);
  }
  return { kind: 'profile', profile: NOTARY_PROFILE };
}

/**
 * The environment of the build: CSC_NAME and the keychain profile, the variables electron-builder reads
 * (app-builder-lib 26 MacTargetHelper.getNotarizeOptions takes an Apple ID first, then an API key, then a profile,
 * so neither of the first two is passed on), and no CSC_LINK or CSC_KEY_PASSWORD, with which it would sign with a
 * certificate file instead of the identity chosen.
 */
export function signingEnv(baseEnv, identity, credentials) {
  const env = { ...baseEnv };
  for (const key of [...PASSWORD_VARIABLES, 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN_PROFILE', 'APPLE_KEYCHAIN', 'CSC_LINK', 'CSC_KEY_PASSWORD']) delete env[key];
  env.CSC_NAME = identity.hash;
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
  env.APPLE_KEYCHAIN_PROFILE = credentials.profile;
  return env;
}

/**
 * Before anything is built. The keychain profile is asked with `notarytool history`, which needs only the profile
 * and the network.
 */
export async function preflight({ run = defaultRun, env = process.env, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new Refusal(`a mac release is signed and notarized on macOS only, and this is ${platform}`);
  const found = await run('security', ['find-identity', '-v', '-p', 'codesigning']);
  if (found.missing || found.code !== 0) throw new Refusal(`security find-identity could not list the codesigning identities (exit ${found.code})`);
  const identity = chooseIdentity(parseIdentities(found.stdout), env.CSC_NAME);
  const credentials = notaryCredentials(env);
  const asked = await run('xcrun', ['notarytool', 'history', '--keychain-profile', NOTARY_PROFILE]);
  if (asked.missing || asked.code !== 0) {
    throw new Refusal(`notarytool does not answer with the keychain profile "${NOTARY_PROFILE}" (exit ${asked.code}): ${OWNER_PROFILE}`);
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

/** spctl's verdict: accepted, as a notarized Developer ID of `team` (the origin's parenthesis), and exit 0. */
export function spctlVerdict(code, output, team) {
  const text = String(output);
  const origin = /^origin=Developer ID Application: .* \(([0-9A-Z]{10})\)$/m.exec(text)?.[1];
  if (code === 0 && /: accepted\b/.test(text) && /^source=Notarized Developer ID$/m.test(text) && origin === team) return { ok: true };
  const source = /^source=(.*)$/m.exec(text)?.[1];
  const verdict = /: rejected\b/.test(text) ? 'rejected' : /: accepted\b/.test(text) ? 'accepted' : 'no verdict';
  return { ok: false, why: `exit ${code}, ${verdict}${source ? `, source=${source}` : ''}${origin === team ? '' : `, signed by team ${origin ?? 'none'}, not ${team}`}` };
}

/** What is wrong with one binary's signature, from `codesign -dvv --verbose=4`, against the signing team. */
export function signatureProblems(output, team) {
  const text = String(output);
  if (/code object is not signed at all|not signed/.test(text) && !/^Authority=/m.test(text) && !/^Signature=/m.test(text)) return ['not signed'];
  const problems = [];
  if (!/^Authority=Developer ID Application: /m.test(text)) problems.push('not signed with a Developer ID Application identity');
  if (!/^Timestamp=/m.test(text)) problems.push('no secure timestamp');
  const flags = /^CodeDirectory .*flags=0x[0-9a-f]+\(([^)]*)\)/m.exec(text)?.[1] ?? '';
  if (!flags.split(',').includes('runtime')) problems.push('no hardened runtime');
  if (!problems.includes('not signed with a Developer ID Application identity')) {
    const signedBy = /^TeamIdentifier=([0-9A-Z]{10})$/m.exec(text)?.[1];
    if (signedBy !== team) problems.push(`signed by team ${signedBy ?? 'none'}, not ${team}`);
  }
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

/**
 * What the start check runs inside the app's binary as Node: better-sqlite3 and node-pty from its own app.asar, as the
 * app requires them (node-pty finds spawn-helper in app.asar.unpacked), a shell spawned through the pty, one line out.
 */
const START_SCRIPT = [
  "const m = process.argv[1] + '/app.asar/node_modules/';",
  "const Database = require(m + 'better-sqlite3'); const db = new Database(':memory:');",
  "const x = db.prepare('select 42 as x').get().x; db.close();",
  "const t = require(m + 'node-pty').spawn('/bin/sh', ['-c', 'echo pty-ok'], { env: { PATH: '/usr/bin:/bin' } });",
  "let o = ''; t.onData(c => { o += c; });",
  "const timer = setTimeout(() => { console.log('tars-start-check timeout'); process.exit(3); }, 20000);",
  "t.onExit(e => { clearTimeout(timer); console.log('tars-start-check sqlite=' + x + ' pty=' + o.trim() + ' exit=' + e.exitCode); });",
].join('\n');
const START_LINE = 'tars-start-check sqlite=42 pty=pty-ok exit=0';

/**
 * The app started once, as nothing else in the checks does: its binary run as Node (ELECTRON_RUN_AS_NODE=1, how its MCP
 * servers and tars-slot run it), in a clean environment, under the signature and entitlements it ships with. A plist
 * without allow-jit signs, notarizes and staples, and V8 aborts here (exit 133); a native module library validation
 * refuses fails its require.
 */
export async function startCheck({ app, run = defaultRun }) {
  const bin = join(app, 'Contents', 'MacOS', basename(app, '.app'));
  const r = await run('env', ['-i', 'PATH=/usr/bin:/bin', 'ELECTRON_RUN_AS_NODE=1', bin, '-e', START_SCRIPT, join(app, 'Contents', 'Resources')]);
  if (r.missing) return { ok: false, why: `could not run ${bin}` };
  if (r.code === 0 && String(r.stdout).split('\n').some(l => l.trim() === START_LINE)) return { ok: true };
  const said = `${r.stderr ?? ''}\n${r.stdout ?? ''}`.split('\n').map(l => l.replace(/^#\s*/, '').trim()).find(Boolean);
  // run() gives -1 when no exit code came back: the system killed it (as macOS does a process whose code it refuses).
  const ended = r.code === -1 ? 'killed by a signal' : `exit ${r.code}`;
  return { ok: false, why: `${ended}${said ? `: ${said.slice(0, 200)}` : ', no result line'}` };
}

/** The quarantine Safari puts on a download. */
const quarantine = () => `0083;${Math.floor(Date.now() / 1000).toString(16)};Safari;`;

/**
 * The dmg and its app, as a download through Safari is: copied, quarantined, then judged against `team`, the Team
 * ID of the identity that signed them. Every check runs; the result lists what passed and what failed, and a step
 * that could not run is a failure.
 */
export async function verifyQuarantined({ dmg, team, run = defaultRun, platform = process.platform, log = () => {} }) {
  const failures = [];
  const passed = [];
  if (platform !== 'darwin') return { ok: false, failures: [`the checks run on macOS only, and this is ${platform}`], passed };
  if (!/^[0-9A-Z]{10}$/.test(String(team ?? ''))) return { ok: false, failures: ['no Team ID to pin the signatures to (the signing identity\'s, or --team)'], passed };
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
      const v = spctlVerdict(dmgSpctl.code, `${dmgSpctl.stdout}${dmgSpctl.stderr}`, team);
      (v.ok ? passed : failures).push(`spctl -t open on the dmg: ${v.ok ? `accepted, Notarized Developer ID of team ${team}` : v.why}`);
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
      const v = spctlVerdict(appSpctl.code, `${appSpctl.stdout}${appSpctl.stderr}`, team);
      (v.ok ? passed : failures).push(`spctl --assess --type exec on the app: ${v.ok ? `accepted, Notarized Developer ID of team ${team}` : v.why}`);
    }
    const appStaple = await step('stapler on the app', 'xcrun', ['stapler', 'validate', app]);
    if (!appStaple.missing) (staplerValid(appStaple.code, `${appStaple.stdout}${appStaple.stderr}`) ? passed : failures).push(`stapler validate on the app: exit ${appStaple.code}`);
    const started = await startCheck({ app, run });
    (started.ok ? passed : failures).push(`the app started as Node (better-sqlite3, a shell through node-pty): ${started.ok ? 'ok' : started.why}`);

    const binaries = machOFiles(app);
    let nestedBad = 0;
    for (const file of binaries) {
      const shown = await step(`codesign on ${file.slice(app.length + 1)}`, 'codesign', ['-dvv', '--verbose=4', file]);
      if (shown.missing) break;
      const problems = signatureProblems(`${shown.stdout}${shown.stderr}`, team);
      if (problems.length) { nestedBad++; failures.push(`${file.slice(app.length + 1)}: ${problems.join(', ')}`); }
    }
    if (binaries.length && nestedBad === 0) passed.push(`${binaries.length} Mach-O files, each signed with a Developer ID Application identity of team ${team}, a secure timestamp and the hardened runtime`);
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
export async function finishDmg({ releaseDir, version, identity, credentials, run = defaultRun, log = () => {}, notarize, buildBlockMap }) {
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

  if (credentials.kind !== 'profile') throw new Refusal('the dmg is notarized with the keychain profile only');
  try {
    await notarize({ appPath: dmg, keychainProfile: credentials.profile });
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
  const [command, target, flag, value] = argv;
  if (command === 'check') {
    const got = await preflight();
    console.log(`ready: a valid Developer ID Application identity (${got.identity.hash.slice(0, 8)}..., team ${got.identity.team}), notary credentials: the keychain profile "${got.credentials.profile}"`);
    return 0;
  }
  if (command === 'verify' && target) {
    // The team the signatures must carry: --team, else the keychain's Developer ID Application identity's.
    let team = flag === '--team' ? value : undefined;
    if (!team) {
      const found = await defaultRun('security', ['find-identity', '-v', '-p', 'codesigning']);
      team = chooseIdentity(parseIdentities(found.stdout), process.env.CSC_NAME).team;
    }
    const result = await verifyQuarantined({ dmg: realpathSync(target), team, log: line => console.log(line) });
    for (const line of result.passed) console.log(`PASS ${line}`);
    for (const line of result.failures) console.log(`FAIL ${line}`);
    console.log(result.ok ? 'ALL PASS' : `${result.failures.length} FAIL`);
    return result.ok ? 0 : 1;
  }
  console.error('usage: node scripts/mac-signing.mjs check | verify <dmg> [--team <Team ID>]');
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
