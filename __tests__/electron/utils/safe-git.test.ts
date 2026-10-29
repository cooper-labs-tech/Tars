import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { hostileRepo, type HostileRepo } from '../../fixtures/hostile-repo';

/**
 * No program a repository names runs in Tars's main process (the Audit's
 * Hole 3 on 2.0.4). Opening Review ran git status and diff on a project
 * folder, and git runs what that repository's configuration names: any agent
 * of the project, or anything it runs, can write .git/config.
 *
 * Every way it can fail, written before the code (2026-10-18):
 *  G1. `status` runs core.fsmonitor, or refreshes the index through a clean
 *      filter; `diff` runs diff.external, a diff command or a textconv; `log -p`
 *      and `show` the same.
 *  G2. A filter's clean, smudge or process runs when a file is compared to the
 *      index or checked out (`worktree add`, `add`), or a filter marked
 *      required makes the call fail instead of passing the file as it is.
 *  G3. A hook runs: post-checkout on `worktree add`, pre-commit, commit-msg
 *      and post-commit on a commit, reference-transaction on a ref update; or
 *      gpg.program signs a commit.
 *  G4. Git recurses into a submodule, whose own config runs its fsmonitor.
 *  G5. A file of Review is read through a link out of the repository.
 *  G6. The environment Tars runs in reaches git: GIT_DIR or GIT_WORK_TREE
 *      point it elsewhere, GIT_CONFIG_PARAMETERS turns a program back on, or
 *      the system configuration names one.
 *  G7. Any git call of the main process skips all this: one written
 *      elsewhere, with execFile('git', ...) of its own, or with git's resolved
 *      path, execFile(gitCommand(), ...), since #358 (the Audit's L1 on #358).
 *  G8. (The Audit's M1 on #463, written before its code.) `log`, `show` or
 *      `whatchanged` verify a signed commit, log.showSignature on, and run the
 *      verifier the repository names: gpg.program and gpg.openpgp.program,
 *      gpg.ssh.program, gpg.x509.program. Review's log is one of them.
 *  G9. (The QA's main red of 2.0.4, written before the fix) A fetch over
 *      https, http, ssh or git never reaches its remote: `protocol.allow=never`
 *      refused every transport, so a chat runner's `git fetch` (chat-runners.ts)
 *      never left Tars.
 *  G10. A transport a repository can turn into a program is allowed: ext::
 *      runs a command, fd:: talks to a file descriptor, a file:// or local
 *      path runs git-upload-pack here, which `remote.<name>.uploadpack` can
 *      name, and any other `<helper>::` runs git-remote-<helper>. Or the
 *      repository allows one itself (`protocol.ext.allow=always` in its
 *      config is a policy of its own, which `protocol.allow` on the command
 *      line does not override), git:// runs its core.gitProxy, or it rewrites an http remote into one
 *      (`url.<ext::...>.insteadOf`). Or it allows a helper that is installed
 *      (the Audit's M1 on #495: `protocol.<x>.allow=always`, then an `<x>::`
 *      remote or `remote.<name>.vcs=<x>`, and git runs git-remote-<x> from
 *      the PATH: ftp, ftps, keybase on a Mac with them).
 *  G11. Allowed, ssh and http run what the repository names for them: its
 *      core.sshCommand on an ssh fetch, its core.askPass or a credential
 *      helper of its own for that remote (`credential.<url>.helper`) when an
 *      https or http remote asks for a password.
 */

import { safeGit, safeGitSync, safeGitEnv } from '../../../electron/utils/safe-git';
import { reviewDiff, fileDiff, repoSummary, resetReviewCache } from '../../../electron/services/git-review';

let h: HostileRepo;
beforeEach(() => {
  h = hostileRepo();
  resetReviewCache();
});

describe('a repository\'s own programs never run', () => {
  it('G1. Review: its status, its diff, a file, its summary and its log run nothing the repository names', async () => {
    const diff = await reviewDiff(h.repo, 'main');
    await fileDiff(h.repo, 'a.txt');
    await repoSummary(h.repo);
    await safeGit(h.repo, ['log', '-p', '-2']);
    await safeGit(h.repo, ['show', 'HEAD~1']);
    expect(h.ran(), 'programs the repository named').toEqual([]);
    // And the work is still read: the change, and the untracked file.
    expect(diff.files.map((f) => f.path).sort()).toEqual(expect.arrayContaining(['a.txt', 'b.txt']));
  });

  it('G8. a signed commit\'s verifier never runs: log, show and whatchanged, Review\'s log included', async () => {
    // The witness: the repository's own git runs a verifier for each format.
    execFileSync('git', ['log', '-3'], { cwd: h.repo, stdio: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_CONFIG_NOSYSTEM: '1' } });
    expect(h.ran().map((l) => l.split(' ')[0]).sort(), 'the fixture names no verifier git runs').toEqual(expect.arrayContaining(['openpgp-verify', 'ssh-verify', 'x509-verify']));
    fs.rmSync(h.marker, { force: true });
    await repoSummary(h.repo);
    await safeGit(h.repo, ['log', '-3']);
    await safeGit(h.repo, ['log', '--show-signature', '-3']);
    await safeGit(h.repo, ['show', 'HEAD']);
    // git 2.54 refuses `whatchanged` unless told --i-still-use-this ("nominated for removal"), which an older
    // git does not know: asked again with it there, so the verifier is still given its chance to run.
    await safeGit(h.repo, ['whatchanged', '-3']).catch((err: { stderr?: string; message?: string }) => {
      if (!/nominated for removal/.test(`${err?.stderr ?? ''}${err?.message ?? ''}`)) throw err;
      return safeGit(h.repo, ['whatchanged', '--i-still-use-this', '-3']);
    });
    safeGitSync(h.repo, ['log', '-1', '--format=%G?']);
    expect(h.ran(), 'programs the repository named').toEqual([]);
  });

  it('G2, G3. a worktree, an add and a commit: no filter, no hook, no signature, and a required filter does not fail them', async () => {
    const wt = path.join(h.root, 'wt');
    safeGitSync(h.repo, ['worktree', 'add', '-b', 'side', wt, 'HEAD']);
    expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8')).toBe('one\n');
    await safeGit(h.repo, ['add', 'a.txt', 'b.txt']);
    await safeGit(h.repo, ['commit', '-q', '-m', 'saved'], { env: { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    safeGitSync(h.repo, ['worktree', 'remove', '--force', wt]);
    expect(h.ran(), 'programs the repository named').toEqual([]);
  });

  it('G4. a submodule is not entered', async () => {
    await safeGit(h.repo, ['status', '--porcelain']);
    await safeGit(h.repo, ['diff', 'HEAD']);
    expect(h.ran().filter((l) => l.startsWith('sub-'))).toEqual([]);
  });

  it('G5. Review never reads a file through a link out of the repository', async () => {
    const shown = await fileDiff(h.repo, 'out/secret.txt').catch((e: Error) => `refused: ${e.message}`);
    expect(shown).not.toContain('OUTSIDE-SECRET');
    const all = await reviewDiff(h.repo, 'main');
    expect(all.patch).not.toContain('OUTSIDE-SECRET');
  });

  it('G6. the environment it runs git in is its own', async () => {
    const env = safeGitEnv({ PATH: '/usr/bin', HOME: '/h', GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere', GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='x'", GIT_EXTERNAL_DIFF: 'x', GIT_EDITOR: 'x', GIT_ASKPASS: 'x', SSH_ASKPASS: 'x', LANG: 'fr_FR.UTF-8' });
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_PARAMETERS', 'GIT_EXTERNAL_DIFF', 'GIT_EDITOR', 'GIT_ASKPASS', 'SSH_ASKPASS']) expect(env[k], k).toBeUndefined();
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/h', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
    const prior = { ...process.env };
    try {
      process.env.GIT_CONFIG_PARAMETERS = `'core.fsmonitor'='${path.join(h.root, 'program.sh')} from-env'`;
      process.env.GIT_DIR = path.join(h.root, 'nowhere');
      await safeGit(h.repo, ['status', '--porcelain']);
    } finally {
      process.env = prior;
    }
    expect(h.ran()).toEqual([]);
  });

  it('G7. no git call of the main process is made anywhere but through safe-git', () => {
    const root = path.resolve('electron');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'dist' && e.name !== 'node_modules') walk(p); continue; }
        if (!/\.ts$/.test(e.name) || p.endsWith(path.join('utils', 'safe-git.ts'))) continue;
        const text = fs.readFileSync(p, 'utf8');
        if (/(execFile|execFileSync|spawn|spawnSync|run)\(\s*(['"]git(\.exe)?['"]|gitCommand\(\))/.test(text)) offenders.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('a fetch reaches its remote, by a transport that runs nothing the repository names', () => {
  /** A remote that records each request and answers it `status`. */
  async function remote(status: number) {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url ?? '');
      res.writeHead(status, status === 401 ? { 'WWW-Authenticate': 'Basic realm="r"' } : {});
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`;
    return { seen, url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }
  const tryGit = (args: string[]) => safeGit(h.repo, args).then(() => '', (err: unknown) => String((err as { stderr?: string })?.stderr ?? err));

  it('G9. a fetch over http reaches the remote', async () => {
    const r = await remote(404);
    try {
      const said = await tryGit(['fetch', r.url]);
      expect(said, 'git refused the transport').not.toMatch(/not allowed/);
      expect(r.seen.length, 'requests the remote got').toBeGreaterThan(0);
    } finally {
      await r.close();
    }
  });

  it('G9. a fetch over https or ssh opens its connection to the remote', async () => {
    let connections = 0;
    const server = net.createServer((socket) => { connections++; socket.destroy(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      for (const url of [`https://127.0.0.1:${port}/repo.git`, `ssh://git@127.0.0.1:${port}/repo.git`]) {
        const before = connections;
        const said = await tryGit(['fetch', url]);
        expect(said, url).not.toMatch(/not allowed/);
        expect(connections, `${url}: connections`).toBeGreaterThan(before);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('G10. ext::, fd::, a file:// or local path and another helper are refused, and run nothing', async () => {
    const marker = path.join(h.root, 'ext-ran');
    const bare = path.join(h.root, 'bare.git');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    for (const k of ['ext', 'fd', 'file', 'git']) execFileSync('git', ['config', `protocol.${k}.allow`, 'always'], { cwd: h.repo });
    const proxy = path.join(h.root, 'git-proxy.sh');
    fs.writeFileSync(proxy, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    execFileSync('git', ['config', 'core.gitProxy', proxy], { cwd: h.repo });
    execFileSync('git', ['config', `url.ext::sh -c touch% ${marker}#.insteadOf`, 'http://rewritten.invalid/'], { cwd: h.repo });
    for (const url of [`ext::sh -c touch% ${marker}`, 'fd::3', `file://${bare}`, bare, 'tarsnohelper::x', 'http://rewritten.invalid/repo.git', 'git://127.0.0.1:1/repo.git']) {
      const said = await tryGit(['fetch', url, 'HEAD']);
      expect(said, url).toMatch(/not allowed|unable to find remote helper|does not appear to be a git repository|transport/);
    }
    expect(fs.existsSync(marker), 'ext:: ran its command').toBe(false);
  });

  it('G10. a helper that is installed and that the repository allows itself is refused, by an <x>:: remote or remote.<name>.vcs', async () => {
    const marker = path.join(h.root, 'helper-ran');
    const bin = path.join(h.root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git-remote-tarstestx'), `#!/bin/sh\necho "$*" >> '${marker}'\nexit 1\n`, { mode: 0o755 });
    execFileSync('git', ['config', 'protocol.tarstestx.allow', 'always'], { cwd: h.repo });
    execFileSync('git', ['config', 'remote.viahelper.url', 'tarstestx::somewhere'], { cwd: h.repo });
    execFileSync('git', ['config', 'remote.viavcs.url', 'https://example.invalid/x'], { cwd: h.repo });
    execFileSync('git', ['config', 'remote.viavcs.vcs', 'tarstestx'], { cwd: h.repo });
    const was = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${was ?? ''}`;
    try {
      for (const remoteName of ['viahelper', 'viavcs']) await tryGit(['fetch', remoteName]);
    } finally {
      process.env.PATH = was;
    }
    expect(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '', 'git-remote-tarstestx ran with').toBe('');
  });

  it('G11. an ssh fetch runs no core.sshCommand the repository names, an http one no core.askPass', async () => {
    const marker = path.join(h.root, 'transport-program-ran');
    const program = path.join(h.root, 'named-program.sh');
    fs.writeFileSync(program, `#!/bin/sh\necho "$0 $*" >> '${marker}'\nexit 1\n`, { mode: 0o755 });
    execFileSync('git', ['config', 'core.sshCommand', program], { cwd: h.repo });
    execFileSync('git', ['config', 'core.askPass', program], { cwd: h.repo });
    await tryGit(['fetch', 'ssh://127.0.0.1:1/repo.git']);
    const r = await remote(401);
    execFileSync('git', ['config', `credential.${new URL(r.url).origin}.helper`, `!${program}`], { cwd: h.repo });
    try {
      await tryGit(['fetch', r.url]);
      expect(r.seen.length, 'the http remote was reached').toBeGreaterThan(0);
    } finally {
      await r.close();
    }
    expect(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '', 'programs the repository named').toBe('');
  });
});
