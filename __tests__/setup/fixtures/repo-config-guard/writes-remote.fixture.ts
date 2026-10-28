import { it } from 'vitest';
import { execFileSync } from 'node:child_process';

// A git started with no cwd runs in the folder the run started in: the suite's own repository.
it('writes a remote and the helper it needs into the repository it runs in', () => {
  execFileSync('git', ['config', 'remote.a.url', 'testx::foo']);
  execFileSync('git', ['config', 'protocol.testx.allow', 'always']);
});
