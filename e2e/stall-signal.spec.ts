import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A running agent that does nothing is marked stalled, and its project's
 * orchestrator is told, in the real app (PLAN-1.9.2.md item B).
 *
 * What only the app can show: the check reads the real process table under
 * real node-pty terminals. Three stand-ins named `claude` (node scripts, as an
 * npm install of Claude Code is), told apart by the agent id Tars puts in
 * their environment:
 * - the frozen worker runs nothing under it;
 * - the busy worker runs a `sleep` under it, a tool at work;
 * - the lead, the project's orchestrator, writes whatever it is typed into a
 *   file, which is how the spec reads what Tars told it.
 * Both workers are then marked running on a session whose transcript was last
 * written 40 minutes ago, and the check is run once, as its timer would.
 *
 * Nudged from the main process, since no stand-in sends Claude Code's hooks:
 * the workers' session and status, and the launch windows (resetLaunches),
 * which a real SessionStart would close.
 */

type Agent = { id: string; status: string; cliRunning?: boolean; ptyCwd?: string; stalledSince?: string };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]> } } };

test.skip(process.platform === 'win32', 'the stall watch reads the fleet through ps, and its stand-ins start /bin/sh and caffeinate, none of which Windows has: the watch does not run there yet; this runs on macOS and Linux');

test('a running agent that writes nothing and runs no tool is marked stalled, and its orchestrator is told', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-stall-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const heard = path.join(home, 'lead-heard.txt');
  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, [
    `#!${process.execPath}`,
    "const id = process.env.CLAUDE_AGENT_ID;",
    `require('fs').appendFileSync(${JSON.stringify(path.join(home, 'ids.txt'))}, process.pid + ' ' + id + '\\n');`,
    "if (id === 'busy') require('child_process').spawn('/bin/sh', ['-c', 'exec sleep 300'], { stdio: 'ignore' });",
    // As Claude Code does during a turn, an MCP wait or a subagent among them.
    "if (id === 'waiting') require('child_process').spawn('caffeinate', ['-i', '-t', '300'], { stdio: 'ignore' });",
    `if (id === 'lead') process.stdin.on('data', d => require('fs').appendFileSync(${JSON.stringify(heard)}, d));`,
    "process.stdout.write('stand-in ready\\n');",
    'process.stdin.resume();',
    '',
  ].join('\n'), { mode: 0o755 });
  const agent = (id: string, name: string, role = 'worker') => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role,
    projectPath: project, skills: [], cliPath: cli,
    createdAt: '2026-10-01T08:00:00.000Z', lastActivity: '2026-10-01T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent('lead', 'Project Lead', 'orchestrator'), agent('frozen', 'Frozen Worker'), agent('busy', 'Busy Worker'),
    agent('waiting', 'Waiting Worker'),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const dist = path.resolve('electron', 'dist');

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31472), DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
    for (const id of ['lead', 'frozen', 'busy', 'waiting']) {
      await page.evaluate(i => (window as unknown as Api).electronAPI.agent.start({ id: i, prompt: '' }), id);
    }
    await expect.poll(async () => (await list()).filter(a => a.cliRunning).length, { timeout: 60_000 }).toBe(4);

    const fortyMinutesAgo = Date.now() - 40 * 60_000;
    const transcripts = await app.evaluate((_e, { dist }) => {
      const req = process.mainModule!.require;
      const { agents } = req(`${dist}/core/agent-manager.js`);
      const { transcriptPath } = req(`${dist}/utils/resume-session.js`);
      req(`${dist}/core/agent-launch.js`).resetLaunches();
      const paths: Record<string, string> = {};
      for (const id of ['frozen', 'busy', 'waiting']) {
        const a = agents.get(id);
        a.status = 'running';
        a.currentSessionId = { frozen: '11111111-1111-4111-8111-111111111111', busy: '22222222-2222-4222-8222-222222222222', waiting: '33333333-3333-4333-8333-333333333333' }[id as 'frozen'];
        paths[id] = transcriptPath(a.ptyCwd, a.currentSessionId);
      }
      return paths;
    }, { dist });
    for (const file of Object.values(transcripts)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{"type":"user"}\n');
      fs.utimesSync(file, new Date(fortyMinutesAgo), new Date(fortyMinutesAgo));
    }

    // node is in the foreground before the script's first line has run: wait
    // for every stand-in to have started, and the busy one's tool to exist.
    const idsFile = path.join(home, 'ids.txt');
    const { execFileSync } = await import('child_process');
    const psNow = () => String(execFileSync('ps', ['-A', '-o', 'pid=,ppid=,stat=,command='])).split('\n');
    await expect.poll(() => {
      const ids = fs.existsSync(idsFile) ? fs.readFileSync(idsFile, 'utf8').trim().split('\n') : [];
      const busyPid = ids.find(l => l.endsWith(' busy'))?.split(' ')[0];
      const waitingPid = ids.find(l => l.endsWith(' waiting'))?.split(' ')[0];
      const childOf = (pid: string | undefined, what: RegExp) => !!pid && psNow().some(l => what.test(l) && l.trim().split(/\s+/)[1] === pid);
      return ids.length === 4 && childOf(busyPid, /sleep 300/) && childOf(waitingPid, /caffeinate -i -t 300/);
    }, { timeout: 30_000, message: 'the stand-ins have started, the busy one with its tool' }).toBe(true);
    const ps = psNow().filter(l => l.includes(home) || /sleep 300/.test(l));

    await app.evaluate(async (_e, { dist }) => {
      const req = process.mainModule!.require;
      await req(`${dist}/services/stall-watch.js`).checkStalls();
    }, { dist });

    const fleet = await list();
    const frozen = fleet.find(a => a.id === 'frozen');
    const busy = fleet.find(a => a.id === 'busy');
    const waiting = fleet.find(a => a.id === 'waiting');
    let told = '';
    for (const until = Date.now() + 20_000; Date.now() < until && !told.includes('Frozen Worker'); await new Promise(r => setTimeout(r, 250))) {
      told = fs.existsSync(heard) ? fs.readFileSync(heard, 'utf8') : '';
    }
    recordValues({ frozenStalledSince: frozen?.stalledSince, busyStalledSince: busy?.stalledSince ?? null, waitingStalledSince: waiting?.stalledSince ?? null, leadHeard: told, ps });

    expect(frozen?.stalledSince, 'the frozen worker was not marked').toBeDefined();
    expect(Math.abs(Date.parse(frozen!.stalledSince!) - fortyMinutesAgo)).toBeLessThan(2_000);
    expect(busy?.stalledSince, 'a worker running a tool was marked stalled').toBeUndefined();
    expect(waiting?.stalledSince, 'a worker in a long MCP wait, its caffeinate renewed, was marked stalled').toBeUndefined();
    expect(told).not.toContain('Waiting Worker');
    expect(told).toContain('Frozen Worker');
    expect(told).toMatch(/nothing to its transcript for 40 minutes/);
    expect(told).not.toContain('Busy Worker');
  } finally {
    await app.close().catch(() => { /* gone */ });
  }
});
