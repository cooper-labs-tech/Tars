import { it } from 'vitest';
import { execFileSync } from 'node:child_process';

// What another agent's `git push -u` writes into the configuration every worktree shares.
it('adds a tracking branch to the repository it runs in', () => {
  execFileSync('git', ['config', 'branch.side.remote', 'origin']);
  execFileSync('git', ['config', 'branch.side.merge', 'refs/heads/side']);
});
