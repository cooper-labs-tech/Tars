import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent created on a worktree gets its project's dependencies as a clone
 * (Noah's choice 17, 05/10), in the real app: the window's agent:create on a
 * project whose node_modules was installed for the worktree's lock, at its
 * root and in a sub-package. Each agent used to run its own `npm ci` into its
 * worktree (46 GB in .worktrees on 01/10).
 *
 * Asserted: the worktree's node_modules hold the project's packages, for the
 * root and the sub-package; a sub-package whose lock differs gets none. The
 * artefact: values.json with what each package got and how long the create
 * took.
 */

type Api = { electronAPI: { agent: {
  create(config: Record<string, unknown>): Promise<{ id?: string; worktreePath?: string } & Record<string, unknown>>;
} } };

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function pkg(dir: string, deps: Record<string, string>, installed: Record<string, string> | null): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir), dependencies: deps }));
  const packages: Record<string, unknown> = { '': { name: path.basename(dir) } };
  for (const [name, version] of Object.entries(deps)) packages[`node_modules/${name}`] = { version };
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  if (installed) {
    const recorded: Record<string, unknown> = {};
    for (const [name, version] of Object.entries(installed)) {
      fs.mkdirSync(path.join(dir, 'node_modules', name), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node_modules', name, 'index.js'), `module.exports = '${version}';\n`);
      recorded[`node_modules/${name}`] = { version };
    }
    fs.writeFileSync(path.join(dir, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: recorded }));
  }
}

test.skip(process.platform === 'win32', 'the dependencies are cloned with APFS clonefile or a reflink cp (worktree-deps.ts), which Windows has neither of: there an agent on a worktree installs as before; this runs on macOS, and on a Linux disk that can reflink');

test('an agent created on a worktree gets its project\'s dependencies, cloned', async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-deps-'));
  const project = path.join(home, 'projects', 'shop');
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(dir, { recursive: true });
  pkg(project, { left: '1.0.0' }, { left: '1.0.0' });
  pkg(path.join(project, 'mcp-x'), { right: '2.0.0' }, { right: '2.0.0' });
  // Installed for an older lock than the one the branch carries: not cloned.
  pkg(path.join(project, 'landing'), { web: '3.0.0' }, { web: '2.9.0' });
  fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules/\n.worktrees/\n');
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.email', 't@t.example');
  git(project, 'config', 'user.name', 'T');
  git(project, 'add', '-A');
  git(project, 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'agents.json'), '[]');
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31460), DOROTHY_E2E: '1' },
  });
  const pageErrors: string[] = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);

    const began = Date.now();
    const created = await page.evaluate(project => (window as unknown as Api).electronAPI.agent.create({
      projectPath: project, skills: [], name: 'Deps agent', worktree: { enabled: true, branchName: 'feat/deps' },
    }), project);
    const tookMs = Date.now() - began;
    const wt = path.join(project, '.worktrees', 'feat', 'deps');
    const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null);
    const got = {
      root: read(path.join(wt, 'node_modules', 'left', 'index.js')),
      mcpX: read(path.join(wt, 'mcp-x', 'node_modules', 'right', 'index.js')),
      landing: fs.existsSync(path.join(wt, 'landing', 'node_modules')),
    };
    recordValues({ created: { worktreePath: created.worktreePath }, tookMs, got, pageErrors });

    expect(fs.existsSync(wt), 'the worktree was not created').toBe(true);
    expect(got.root).toBe("module.exports = '1.0.0';");
    expect(got.mcpX).toBe("module.exports = '2.0.0';");
    expect(got.landing, 'a node_modules installed for another lock was cloned').toBe(false);
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close().catch(() => { /* gone */ });
  }
});
