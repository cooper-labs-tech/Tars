import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Tars's data folder becomes ~/.tars (2.0.4, the maintainer's decision of 18/10), from ~/.dorothy, at the first start.
 *
 * The real app on a sandbox HOME left as Tars 2.0.3 leaves it: a full ~/.dorothy (agents, projects, the kanban's file,
 * a project's folder with a report, a socket-like file in an agent's temporary folder, settings, the instructions file),
 * and outside it what Tars wrote naming it: Claude Code's status line and an MCP server in ~/.claude, codex's config.
 *
 * Asserted, once with the classic shell and once with the new interface:
 * 1. at the start, ~/.dorothy is now ~/.tars, every file in it there, the same inode (moved, not copied), and a link at
 *    ~/.dorothy reaches it;
 * 2. the window finds everything from ~/.tars: the agents, the projects, the settings;
 * 3. an agent started from the window runs with ~/.tars in its --add-dir and its temporary folder under ~/.tars;
 * 4. the old path is rewritten in ~/.claude/settings.json, ~/.claude.json and ~/.codex/config.toml, and a path that
 *    only starts the same is left;
 * 5. a second start changes nothing: the same folders, the same files.
 * 6. (the Audit's L4 on #473) the agent given --add-dir ~/.tars is given nothing of ~/.tars-private, whose name starts
 *    the same: no argument, no variable of its environment, no file its arguments name, holds that path;
 * 7. (the Audit's L1 on #473) a ~/.dorothy that is a link to the user's data elsewhere, beside a ~/.tars that holds
 *    none of Tars's records: Tars runs on the data, the window finds the agents, the other folder is left as it is,
 *    and the window is given the notice to say so (app.dataDir).
 * Red on main (e7b38a23): nothing moves, and ~/.tars does not exist. 7 red on 850672d9: Tars runs on the empty ~/.tars.
 * The artefact: values.json (the listings before and after, the stand-in's record), a screenshot, the app's trace.
 */

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path');
// Where the private folder's path reaches the CLI: an argument, a variable, or a file an argument names (MCP config, settings).
const leaks = [];
for (const [k, v] of Object.entries(process.env)) if (String(v).includes('.tars-private')) leaks.push('env ' + k);
for (const a of process.argv.slice(2)) {
  if (a.includes('.tars-private')) leaks.push('argv ' + a);
  try { const f = a.replace(/^'|'$/g, ''); if (fs.statSync(f).isFile() && fs.readFileSync(f, 'utf8').includes('.tars-private')) leaks.push('file ' + f); } catch {}
}
fs.appendFileSync(path.join(process.env.HOME, 'stand-in.jsonl'), JSON.stringify({ argv: process.argv.slice(2), tmp: process.env.TMPDIR || null, leaks }) + '\n');
process.stdout.write('stand-in ready\n');
process.stdin.resume();
`;

type Api = { electronAPI: {
  app: { dataDir(): Promise<{ dir: string; did: string; notice?: string }> };
  agent: { list(): Promise<Array<{ id: string; name: string }>>; start(p: { id: string; prompt: string }): Promise<unknown> };
  fs: { listProjects(): Promise<Array<{ path: string; custom?: boolean }>> };
  appSettings: { get(): Promise<Record<string, unknown>> };
} };

const listing = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, '');
  return out.sort();
};

for (const newInterface of [false, true]) {
  test(`~/.dorothy becomes ~/.tars, and everything works from it${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-data-dir-'));
    const old = path.join(home, '.dorothy');
    const tars = path.join(home, '.tars');
    const project = path.join(home, 'projects', 'atlas');
    const bin = path.join(home, 'bin');
    for (const d of [project, bin, path.join(old, 'project-files', 'atlas-0123456789', 'reports'), path.join(old, 'tmp', 'a1b2c3d4e5', 't')]) fs.mkdirSync(d, { recursive: true });
    const cli = path.join(bin, 'claude');
    fs.writeFileSync(cli, `#!${process.execPath}\n${STAND_IN}`, { mode: 0o755 });
    fs.writeFileSync(path.join(old, 'agents.json'), JSON.stringify([{
      id: 'dev', name: 'Build Agent', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath: project, skills: [],
      permissionMode: 'normal', cliPath: cli, createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z',
    }], null, 2));
    fs.writeFileSync(path.join(old, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(old, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface, cliPaths: { additionalPaths: [bin] } }));
    fs.writeFileSync(path.join(old, 'kanban-tasks.json'), '[]');
    fs.writeFileSync(path.join(old, 'CLAUDE.md'), '# Tars Agent Instructions\n');
    fs.writeFileSync(path.join(old, 'project-files', 'atlas-0123456789', 'reports', 'release.md'), '# release\n');
    fs.writeFileSync(path.join(old, 'tmp', 'a1b2c3d4e5', 't', 'scratch.txt'), 'scratch');
    // What the agents are not handed, beside the folder they are.
    fs.mkdirSync(path.join(home, '.tars-private'), { mode: 0o700 });
    fs.writeFileSync(path.join(home, '.tars-private', 'settings-secrets.json'), '{"discordBotToken":"e2e-secret"}', { mode: 0o600 });
    // A file Tars never writes at a start (agents.json is saved again as it loads): moved, it keeps its inode.
    const report = path.join('project-files', 'atlas-0123456789', 'reports', 'release.md');
    const inode = fs.statSync(path.join(old, report)).ino;
    const before = listing(old);
    // What Tars 2.0.3 wrote outside its folder.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `bash ${old}/statusline.sh` }, note: `${old}-backup/keep` }, null, 2));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'claude-mgr-orchestrator': { command: `${old}/bin/tars-mcp-node`, args: [] } } }, null, 2));
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), `[mcp_servers.claude-mgr-orchestrator]\ncommand = "$HOME/.dorothy/bin/tars-mcp-node"\n`);
    const port = apiPort(newInterface ? 31403 : 31404);
    const values: Record<string, unknown> = { newInterface, before };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const launch = () => launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });

    let app: ElectronApplication = await launch();
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });

      // 1. Moved, whole, and linked.
      const after = fs.existsSync(tars) && fs.lstatSync(tars).isDirectory() ? listing(tars) : [];
      const link = fs.existsSync(old) ? fs.lstatSync(old).isSymbolicLink() : false;
      keep({ after, link });
      expect.soft(after.filter((f) => before.includes(f))).toEqual(before);
      expect.soft(fs.existsSync(path.join(tars, report)) ? fs.statSync(path.join(tars, report)).ino : null, 'moved, not copied').toBe(inode);
      expect.soft(link, '~/.dorothy is a link').toBe(true);
      expect.soft(fs.readFileSync(path.join(old, 'project-files', 'atlas-0123456789', 'reports', 'release.md'), 'utf8')).toBe('# release\n');

      // 2. Everything found from ~/.tars.
      const agents = await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
      const projects = await page.evaluate(() => (window as unknown as Api).electronAPI.fs.listProjects());
      const settings = await page.evaluate(() => (window as unknown as Api).electronAPI.appSettings.get());
      keep({ agents: agents.map((a) => a.id), projects: projects.map((p) => p.path), newInterfaceSetting: settings.newInterface });
      expect.soft(agents.map((a) => a.id)).toContain('dev');
      expect.soft(projects.map((p) => p.path)).toContain(project);
      expect.soft(settings.newInterface).toBe(newInterface);

      // 3. An agent runs on ~/.tars.
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'dev', prompt: '' }));
      const record = path.join(home, 'stand-in.jsonl');
      await expect.poll(() => fs.existsSync(record), { timeout: 60_000 }).toBe(true);
      const ran = JSON.parse(fs.readFileSync(record, 'utf8').trim().split('\n')[0]) as { argv: string[]; tmp: string | null; leaks: string[] };
      keep({ ran });
      const addDirs = ran.argv.flatMap((a, i) => (a === '--add-dir' ? [ran.argv[i + 1]] : []));
      expect.soft(addDirs.some((d) => d.replace(/^'|'$/g, '') === tars), `--add-dir ${addDirs.join(', ')}`).toBe(true);
      // The old folder itself, not any path with .dorothy in it: an agent's own TMPDIR, where a run may make HOME, is under one.
      expect.soft(addDirs.some((d) => { const p = d.replace(/^'|'$/g, ''); return p === old || p.startsWith(`${old}${path.sep}`); })).toBe(false);
      expect.soft(ran.tmp ?? '').toContain(`${path.sep}.tars${path.sep}tmp${path.sep}`);
      // 6. Nothing of ~/.tars-private, whose name starts as ~/.tars does.
      expect.soft(ran.leaks, 'where ~/.tars-private reached the agent').toEqual([]);
      expect.soft(addDirs.some((d) => d.replace(/^'|'$/g, '').startsWith(path.join(home, '.tars-private')))).toBe(false);

      // 4. The old path rewritten where Tars wrote it.
      const claudeSettings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
      const claudeJson = fs.readFileSync(path.join(home, '.claude.json'), 'utf8');
      const codex = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
      keep({ claudeSettings, codex });
      expect.soft(claudeSettings.note).toBe(`${old}-backup/keep`);
      expect.soft(JSON.stringify(claudeSettings.statusLine)).not.toContain(`${old}/`);
      expect.soft(claudeJson).not.toContain(`${old}/bin`);
      expect.soft(codex).toContain('$HOME/.tars/bin/tars-mcp-node');
      await page.waitForTimeout(800);
      await stepShot(page, newInterface ? 'agents-after-move-new-interface' : 'agents-after-move');
    } finally {
      await app.close().catch(() => undefined);
    }

    // 5. A second start changes nothing.
    const between = listing(tars).filter((f) => !f.startsWith('logs') && !f.startsWith('tmp'));
    app = await launch();
    try {
      await app.firstWindow();
      const again = listing(tars).filter((f) => !f.startsWith('logs') && !f.startsWith('tmp'));
      keep({ secondStartAdded: again.filter((f) => !between.includes(f)), secondStartLost: between.filter((f) => !again.includes(f)) });
      expect.soft(between.filter((f) => !again.includes(f)), 'files gone at the second start').toEqual([]);
      expect.soft(fs.lstatSync(old).isSymbolicLink()).toBe(true);
    } finally {
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}

for (const newInterface of [false, true]) {
  test(`a ~/.dorothy link to the user's data beside an empty ~/.tars: tars runs on the data, and says so${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(120_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-data-dir-two-'));
    const data = path.join(home, 'Volumes', 'ext', 'dorothy');
    const project = path.join(home, 'projects', 'atlas');
    for (const d of [data, project, path.join(home, '.tars')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(data, 'agents.json'), JSON.stringify([{
      id: 'dev', name: 'Build Agent', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath: project, skills: [],
      permissionMode: 'normal', createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z',
    }], null, 2));
    fs.writeFileSync(path.join(data, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    fs.symlinkSync(data, path.join(home, '.dorothy'));
    fs.writeFileSync(path.join(home, '.tars', 'notes.txt'), 'not tars');
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31401 : 31402), DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      const told = await page.evaluate(() => (window as unknown as Api).electronAPI.app.dataDir());
      const agents = await page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
      keep({ told, agents: agents.map((a) => a.id), tarsFolder: fs.readdirSync(path.join(home, '.tars')).sort() });
      expect.soft(told.dir).toBe(path.join(home, '.dorothy'));
      expect.soft(told.did).toBe('both');
      expect.soft(told.notice ?? '').toContain(path.join(home, '.tars'));
      expect.soft(agents.map((a) => a.id)).toContain('dev');
      expect.soft(fs.readdirSync(path.join(home, '.tars')), 'the other folder left as it is').toEqual(['notes.txt']);
      expect.soft(fs.realpathSync(path.join(home, '.dorothy'))).toBe(fs.realpathSync(data));
      await stepShot(page, newInterface ? 'two-data-folders-new-interface' : 'two-data-folders');
    } finally {
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
