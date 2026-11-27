import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { harnessVersions, isolatedProbeEnv, versionIn, type HarnessVersionDeps } from '../../../electron/services/harness-version';

/**
 * The exact version of the harness a traced session runs, read from the binary Tars launched, once per binary path
 * and modification time. An npm package says its own version (read, never run); anything else is asked `--version`
 * in a throwaway home, as the harness benches require: a sandbox HOME, npm's prefix in the run's own folder, never the
 * owner's configuration. No CLI runs here: the probe is a stand-in, and the binaries are files that are never executed.
 *
 * How it fails, written before the code (27/11):
 * V1. The version is parsed wrong: a word, a leading v, a build suffix (amp's -gce258b) or a trailing label
 *     ("(Claude Code)") is kept or lost; a line with no version gives one.
 * V2. An npm binary is run when its package says its version; or a package.json that does not list the binary in
 *     its bin (a project's own, above a script) is taken for the harness's.
 * V3. A bare name is looked up on Tars's own PATH rather than the terminals' PATH; a binary that is not there is run
 *     anyway, or throws.
 * V4. The probe inherits the owner's environment: HOME, CODEX_HOME, XDG folders, npm's prefix, an API key; or one of
 *     the folders it is given lies outside its throwaway folder (it could write into the owner's home, or install a
 *     package globally through an update prompt).
 * V5. The throwaway folder is left behind, after an answer or a failure.
 * V6. The cache is keyed on the name, not the file: a binary upgraded in place (new modification time) keeps its old
 *     version; or the same binary is probed again for every session.
 * V7. A probe that fails (a timeout, an exit code) throws to the caller, or its null is kept for good: the next
 *     session never asks again.
 * V8. Two sessions starting together probe the same binary twice.
 */

let dir: string;
let probes: Array<{ binary: string; env: NodeJS.ProcessEnv; sandboxSeen: boolean }>;
let answer: (binary: string) => Promise<{ stdout: string; stderr: string }>;

function deps(over: Partial<HarnessVersionDeps> = {}): HarnessVersionDeps {
  return {
    path: () => path.join(dir, 'bin'),
    platform: 'darwin',
    tmpRoot: path.join(dir, 'tmp'),
    env: { HOME: '/Users/owner', CODEX_HOME: '/Users/owner/.codex', OPENAI_API_KEY: 'sk-owner', npm_config_prefix: '/opt/owner-npm', XDG_CONFIG_HOME: '/Users/owner/.config', PATH: '/owner/path' },
    probe: async (binary, env) => {
      probes.push({ binary, env, sandboxSeen: !!env.HOME && fs.existsSync(env.HOME) });
      return answer(binary);
    },
    ...over,
  };
}

function file(p: string, content = '#!/bin/sh\n', mode = 0o755): string {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, { mode });
  return p;
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-version-')));
  fs.mkdirSync(path.join(dir, 'tmp'));
  probes = [];
  answer = async () => ({ stdout: '0.25.2\n', stderr: '' });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the version in a --version answer', () => {
  it('V1: keeps the version itself, its build suffix included, and nothing else', () => {
    expect(versionIn('codex-cli 0.170.0\n')).toBe('0.170.0');
    expect(versionIn('2.1.288 (Claude Code)\n')).toBe('2.1.288');
    expect(versionIn('0.0.1788811227-gce258b\n')).toBe('0.0.1788811227-gce258b');
    expect(versionIn('v1.19.3')).toBe('1.19.3');
    expect(versionIn('Hermes Agent v0.23.4 (2026.11.20)\n')).toBe('0.23.4');
    expect(versionIn('kimi, version 1.4.0rc2\n')).toBe('1.4.0rc2');
    expect(versionIn('goose 1.21.0-beta.3+abc\n')).toBe('1.21.0-beta.3+abc');
    expect(versionIn('no version here\n')).toBeNull();
    expect(versionIn('')).toBeNull();
  });
});

describe('the harness version of a binary', () => {
  it('V2: an npm binary is read from its own package, never run', async () => {
    const pkg = path.join(dir, 'lib', 'node_modules', '@vendor', 'agent-cli');
    file(path.join(pkg, 'package.json'), JSON.stringify({ name: '@vendor/agent-cli', version: '0.170.0', bin: { agent: 'bin/agent.js' } }), 0o644);
    const script = file(path.join(pkg, 'bin', 'agent.js'), '#!/usr/bin/env node\n');
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.symlinkSync(script, path.join(dir, 'bin', 'agent'));
    expect(await harnessVersions(deps()).of('agent')).toBe('0.170.0');
    expect(await harnessVersions(deps()).of(path.join(dir, 'bin', 'agent'))).toBe('0.170.0');
    expect(probes).toEqual([]);
  });

  it('V2: a package.json that does not list the binary is not the harness\'s', async () => {
    file(path.join(dir, 'project', 'package.json'), JSON.stringify({ name: 'my-app', version: '9.9.9', bin: { other: 'tools/other.js' } }), 0o644);
    const bin = file(path.join(dir, 'project', 'tools', 'fake-qwen'));
    expect(await harnessVersions(deps()).of(bin)).toBe('0.25.2');
    expect(probes).toHaveLength(1);
  });

  it('V3: a bare name is found on the terminals\' PATH; one that is nowhere gives null without a probe', async () => {
    file(path.join(dir, 'bin', 'qwen'));
    const v = harnessVersions(deps());
    expect(await v.of('qwen')).toBe('0.25.2');
    expect(probes[0].binary).toBe(path.join(dir, 'bin', 'qwen'));
    expect(await v.of('codex')).toBeNull();
    expect(await v.of(path.join(dir, 'bin', 'missing'))).toBeNull();
    // A file that cannot be run is not a binary.
    file(path.join(dir, 'bin', 'plain'), 'text', 0o644);
    expect(await v.of('plain')).toBeNull();
    expect(probes).toHaveLength(1);
  });

  it('V4: the probe runs in a throwaway home, with nothing of the owner\'s', async () => {
    const bin = file(path.join(dir, 'bin', 'qwen'));
    await harnessVersions(deps()).of(bin);
    const { env, sandboxSeen } = probes[0];
    expect(sandboxSeen).toBe(true);
    const sandbox = path.dirname(env.HOME!);
    expect(sandbox.startsWith(path.join(dir, 'tmp') + path.sep)).toBe(true);
    for (const [name, value] of Object.entries(env)) {
      if (name === 'PATH' || value === '1' || value === 'false') continue;
      expect(`${name}=${value}`.startsWith(`${name}=${sandbox}${path.sep}`), `${name}=${value}`).toBe(true);
    }
    expect(env.PATH).toBe(path.join(dir, 'bin'));
    expect(env.npm_config_prefix!.startsWith(sandbox)).toBe(true);
    expect(env.CODEX_HOME!.startsWith(sandbox)).toBe(true);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('/Users/owner');
    expect(JSON.stringify(env)).not.toContain('/opt/owner-npm');
  });

  it('V4: on Windows the system\'s own variables pass, and every user folder is the throwaway one', () => {
    const sandbox = path.join(dir, 'tmp', 'probe');
    const env = isolatedProbeEnv(sandbox, {
      path: 'C:\\agents\\bin', platform: 'win32',
      from: { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', PATHEXT: '.COM;.EXE;.CMD', APPDATA: 'C:\\Users\\owner\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\owner', OPENAI_API_KEY: 'sk' },
    });
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.PATHEXT).toBe('.COM;.EXE;.CMD');
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'npm_config_prefix']) {
      expect(env[name]!.startsWith(sandbox), name).toBe(true);
    }
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('V5: the throwaway folder is gone after an answer and after a failure', async () => {
    const bin = file(path.join(dir, 'bin', 'qwen'));
    await harnessVersions(deps()).of(bin);
    answer = async () => { throw new Error('qwen --version did not answer in 10000 ms'); };
    file(path.join(dir, 'bin', 'other'));
    expect(await harnessVersions(deps()).of(path.join(dir, 'bin', 'other'))).toBeNull();
    expect(probes).toHaveLength(2);
    for (const p of probes) expect(fs.existsSync(path.dirname(p.env.HOME!))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'tmp'))).toEqual([]);
  });

  it('V6: probed once per binary and modification time, again once it is upgraded in place', async () => {
    const bin = file(path.join(dir, 'bin', 'qwen'));
    const v = harnessVersions(deps());
    expect(await v.of(bin)).toBe('0.25.2');
    expect(await v.of('qwen')).toBe('0.25.2');
    expect(probes).toHaveLength(1);
    answer = async () => ({ stdout: '0.26.0\n', stderr: '' });
    fs.utimesSync(bin, new Date(), new Date(Date.now() + 60_000));
    expect(await v.of(bin)).toBe('0.26.0');
    expect(probes).toHaveLength(2);
  });

  it('V7: a failed probe gives null, and the next session asks again', async () => {
    const bin = file(path.join(dir, 'bin', 'qwen'));
    const v = harnessVersions(deps());
    answer = async () => { throw new Error('exited with 1'); };
    expect(await v.of(bin)).toBeNull();
    answer = async () => ({ stdout: '', stderr: 'qwen 0.25.2\n' });
    expect(await v.of(bin)).toBe('0.25.2');
    expect(probes).toHaveLength(2);
  });

  it('V8: two sessions at once share one probe', async () => {
    const bin = file(path.join(dir, 'bin', 'qwen'));
    let release!: () => void;
    answer = () => new Promise(r => { release = () => r({ stdout: '0.25.2', stderr: '' }); });
    const v = harnessVersions(deps());
    const both = Promise.all([v.of(bin), v.of(bin)]);
    await new Promise(r => setTimeout(r, 20));
    release();
    expect(await both).toEqual(['0.25.2', '0.25.2']);
    expect(probes).toHaveLength(1);
  });
});
