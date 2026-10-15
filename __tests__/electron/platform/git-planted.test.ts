import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { gitCommand } from '../../../electron/platform/git-command';
import { currentBranch } from '../../../electron/services/agent-truth';

/**
 * A project that carries a git.exe of its own, on Windows: Tars must run the
 * git on the PATH, never that one. Real processes, real git.
 *
 * The planted git.exe is a copy of node.exe: started as `git rev-parse ...`,
 * it runs the file `rev-parse` it finds in the project, which writes
 * planted-ran.txt. The first test is the witness: a bare `git`, started in the
 * project the way Tars started it, runs the planted one, so the folder bites.
 *
 * NoDefaultCurrentDirectoryInExePath is taken out of this process's own
 * environment for the file: a Claude Code shell sets it, CI does not, and
 * with it set the bare name would be safe here and nowhere else.
 */

const onWindows = process.platform === 'win32';
const VAR = 'NoDefaultCurrentDirectoryInExePath';

describe.runIf(onWindows)('a git.exe planted in a project is never the git Tars runs', { timeout: 60_000 }, () => {
  let root: string;
  let repo: string;
  let ran: string;
  let saved: string | undefined;

  beforeAll(() => {
    saved = process.env[VAR];
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-git-planted-'));
    repo = path.join(root, 'project');
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync(gitCommand(), args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'real-branch');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first');
    try {
      fs.linkSync(process.execPath, path.join(repo, 'git.exe'));
    } catch {
      fs.copyFileSync(process.execPath, path.join(repo, 'git.exe'));
    }
    ran = path.join(repo, 'planted-ran.txt');
    fs.writeFileSync(path.join(repo, 'rev-parse'), "require('fs').writeFileSync(require('path').join(__dirname, 'planted-ran.txt'), 'ran');\n");
    delete process.env[VAR];
  });

  afterAll(() => {
    if (saved === undefined) delete process.env[VAR];
    else process.env[VAR] = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('witness: a bare git started in the project runs the planted git.exe', () => {
    spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, stdio: 'pipe' });
    expect(fs.existsSync(ran), 'the planted git.exe did not run: this test proves nothing').toBe(true);
    fs.rmSync(ran);
  });

  it('gitCommand is the git on the PATH: the branch is read, the planted one never runs', () => {
    expect(path.isAbsolute(gitCommand())).toBe(true);
    const out = execFileSync(gitCommand(), ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    expect(out).toBe('real-branch');
    expect(fs.existsSync(ran)).toBe(false);
  });

  it("the agents' branch (agent-truth) is read with it", async () => {
    currentBranch(repo);
    await expect.poll(() => currentBranch(repo), { timeout: 10_000 }).toBe('real-branch');
    expect(fs.existsSync(ran)).toBe(false);
  });

  it('the status line, run in the project, reads the branch with the git on the PATH', async () => {
    const home = fs.mkdtempSync(path.join(root, 'home-'));
    fs.mkdirSync(path.join(home, '.dorothy'));
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE_|DOROTHY_|TARS_)/.test(k) && k !== VAR) env[k] = v;
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, '../../../hooks/statusline.mjs')], {
        cwd: repo, env: { ...env, HOME: home, USERPROFILE: home }, windowsHide: true,
      });
      let text = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { text += d; });
      child.on('error', reject);
      child.on('close', () => resolve(text));
      child.stdin.end(JSON.stringify({ session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', model: { display_name: 'Opus' } }));
    });
    expect(fs.existsSync(ran), 'the status line ran the planted git.exe').toBe(false);
    expect(out).toContain('real-branch');
  });
});
