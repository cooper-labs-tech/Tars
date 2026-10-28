import { it } from 'vitest';
import { execFileSync } from 'node:child_process';

it('removes a key from the repository it runs in', () => {
  execFileSync('git', ['config', '--unset', 'core.guardprobe']);
});
