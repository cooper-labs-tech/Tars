import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * A repository whose own configuration names programs, as any agent of the
 * project can write into .git/config (the Audit's Hole 3 on 2.0.4). Every
 * program it names appends a line to `marker` when it runs: core.fsmonitor,
 * diff.external, a textconv, a filter's clean, smudge and process, the hooks
 * post-checkout, pre-commit, commit-msg, post-commit and reference-transaction,
 * and gpg.program with commit.gpgSign. Its history ends with three commits
 * carrying a signature of each format git verifies (OpenPGP, SSH, X.509; made
 * by nobody), with log.showSignature on and a verifier of its own for each
 * (gpg.program, gpg.ssh.program, gpg.x509.program): `git log` and `show`
 * hand them over (the Audit's M1 on #463). A submodule whose own config names an
 * fsmonitor too, and a link to a folder outside the repository with a file in it.
 * Set up with the real git, its programs off while it is built.
 */
export interface HostileRepo {
  root: string;
  repo: string;
  marker: string;
  outside: string;
  /** What ran, one line each: "<what> <args>". */
  ran(): string[];
}

const plain = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', ...args], {
  cwd, stdio: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? os.homedir(), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
}).toString();

/** The three signature formats git verifies, each by its own program. */
export const SIGNATURE_FORMATS = { openpgp: 'PGP SIGNATURE', ssh: 'SSH SIGNATURE', x509: 'SIGNED MESSAGE' } as const;

export function hostileRepo(): HostileRepo {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hostile-repo-')));
  const repo = path.join(root, 'repo');
  const sub = path.join(root, 'sub-origin');
  const outside = path.join(root, 'outside');
  const marker = path.join(root, 'marker.log');
  const program = path.join(root, 'program.sh');
  for (const d of [repo, sub, outside]) fs.mkdirSync(d, { recursive: true });
  // Each program says what it is and passes its input on, so git goes on as with a real one.
  fs.writeFileSync(program, `#!/bin/sh\necho "$1 $*" >> '${marker}'\n[ "$1" = gpg ] && exit 1\n[ "$1" = filter-process ] && exit 1\ncat 2>/dev/null\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-SECRET\n');

  // The submodule's origin, its own config hostile too once cloned in.
  plain(sub, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(sub, 's.txt'), 'sub\n');
  plain(sub, ['add', 's.txt']);
  plain(sub, ['commit', '-q', '-m', 'sub']);

  plain(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt diff=evil filter=evil\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  plain(repo, ['add', '.gitattributes', 'a.txt']);
  plain(repo, ['commit', '-q', '-m', 'one']);
  plain(repo, ['submodule', 'add', '-q', sub, 'sub']);
  plain(repo, ['commit', '-q', '-m', 'sub']);
  // A commit signed in each format, the same tree: a signature git hands its verifier, made by nobody.
  for (const [kind, label] of Object.entries(SIGNATURE_FORMATS)) {
    const parent = plain(repo, ['rev-parse', 'HEAD']).trim();
    const tree = plain(repo, ['rev-parse', 'HEAD^{tree}']).trim();
    const object = [`tree ${tree}`, `parent ${parent}`, 'author t <t@t> 1792300000 +0000', 'committer t <t@t> 1792300000 +0000',
      `gpgsig -----BEGIN ${label}-----`, ' AAAA', ` -----END ${label}-----`, '', `signed ${kind}`, ''].join('\n');
    const id = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: repo, input: object, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? os.homedir(), GIT_CONFIG_NOSYSTEM: '1' } }).toString().trim();
    plain(repo, ['update-ref', 'refs/heads/main', id]);
  }
  fs.symlinkSync(outside, path.join(repo, 'out'));

  // Then the hostile part, as an agent would write it.
  const set = (cwd: string, key: string, value: string) => plain(cwd, ['config', key, value]);
  set(repo, 'core.fsmonitor', `${program} fsmonitor`);
  set(repo, 'diff.external', `${program} external`);
  set(repo, 'diff.evil.textconv', `${program} textconv`);
  set(repo, 'diff.evil.command', `${program} diff-command`);
  set(repo, 'filter.evil.clean', `${program} filter-clean`);
  set(repo, 'filter.evil.smudge', `${program} filter-smudge`);
  set(repo, 'filter.evil.process', `${program} filter-process`);
  set(repo, 'filter.evil.required', 'true');
  set(repo, 'gpg.program', `${program} gpg`);
  // Each verifier, a program of its own: git runs gpg.program and its kin without a shell.
  const verifier = (name: string) => {
    const file = path.join(root, `${name}.sh`);
    fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> '${marker}'\nexit 1\n`, { mode: 0o755 });
    return file;
  };
  set(repo, 'log.showSignature', 'true');
  set(repo, 'gpg.openpgp.program', verifier('openpgp-verify'));
  set(repo, 'gpg.ssh.program', verifier('ssh-verify'));
  set(repo, 'gpg.x509.program', verifier('x509-verify'));
  fs.writeFileSync(path.join(root, 'allowed-signers'), 't@t ssh-ed25519 AAAA\n');
  set(repo, 'gpg.ssh.allowedSignersFile', path.join(root, 'allowed-signers'));
  set(repo, 'commit.gpgSign', 'true');
  set(repo, 'core.pager', `${program} pager`);
  set(path.join(repo, 'sub'), 'core.fsmonitor', `${program} sub-fsmonitor`);
  for (const hook of ['post-checkout', 'pre-commit', 'commit-msg', 'post-commit', 'reference-transaction', 'post-index-change']) {
    fs.writeFileSync(path.join(repo, '.git', 'hooks', hook), `#!/bin/sh\necho "hook-${hook}" >> '${marker}'\n`, { mode: 0o755 });
  }
  // Work to show: a tracked file changed, one untracked, the submodule's file changed.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
  fs.writeFileSync(path.join(repo, 'sub', 's.txt'), 'sub changed\n');
  fs.rmSync(marker, { force: true });

  return {
    root, repo, marker, outside,
    ran: () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean) : []),
  };
}
