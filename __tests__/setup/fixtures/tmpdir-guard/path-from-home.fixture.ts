import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Run by path-isolation.test.ts, started with HOME at a home whose .local/bin holds hermes, codex, claude and gemini,
// another node first on PATH, a folder of the account's home, a stand-in system folder, then /usr/bin and /bin.
const HOME = process.env.PATH_CHILD_HOME ?? '';
const SYSTEM = process.env.PATH_CHILD_SYSTEM ?? '';
/** The PATH as this file's imports read it (10). */
const AT_IMPORT = process.env.PATH ?? '';

it('starts no CLI of the home it was started in, and keeps the suite\'s own tools', () => {
  expect(HOME).not.toBe('');
  const account = os.userInfo().homedir;
  for (const value of [process.env.PATH ?? '', AT_IMPORT]) {
    for (const dir of value.split(path.delimiter)) {
      expect(dir.startsWith(HOME + path.sep) || dir === HOME, dir).toBe(false);
      expect(dir.startsWith(account + path.sep) || dir === account, dir).toBe(false);
    }
  }
  for (const cli of ['hermes', 'codex', 'claude', 'gemini']) {
    expect(spawnSync(cli, ['--version']).error, cli).toMatchObject({ code: 'ENOENT' });
  }
  const node = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' });
  expect(fs.realpathSync(node.stdout.trim())).toBe(fs.realpathSync(process.execPath));
  for (const tool of ['npm', 'npx', 'git']) expect(spawnSync(tool, ['--version']).status, tool).toBe(0);
  expect(spawnSync('jq-stand-in').status, 'a folder outside every home').toBe(0);
  expect(process.env.PATH?.split(path.delimiter)).toContain(SYSTEM);
});
