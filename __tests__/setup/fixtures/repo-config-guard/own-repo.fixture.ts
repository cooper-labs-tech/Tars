import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

it('writes the configuration of a repository of its own, in its temporary folder', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'own-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'remote.a.url', 'testx::foo'], { cwd: repo });
  execFileSync('git', ['config', 'protocol.testx.allow', 'always'], { cwd: repo });
});
