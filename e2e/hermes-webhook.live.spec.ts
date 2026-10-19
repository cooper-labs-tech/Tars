import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A real Hermes gateway's cron job on Tars's webhook (2.0.4, the Audit's NOW-3, R4.1 to R4.3), in the real app.
 *
 * Hermes calls Tars from its cron: a no_agent job whose script posts to the webhook with the gateway's secret, read
 * from Hermes's own .env (__tests__/fixtures/hermes-cron-bench.py, run by Hermes's scheduler, run_job, in a throwaway
 * HERMES_HOME). The window adds the gateway "VPS" and allows it project alpha, as Settings, Hermes will. Wren (normal)
 * works on alpha, Olga on beta; their claude is a stand-in that records its arguments and what is typed into it.
 * Asserted, in both shells, from the jobs' own output:
 * 1. a job's message reaches Wren: 200, and her session starts on it, in her own mode;
 * 2. a job asking bypass for Wren is refused 403, naming nothing, and nothing reaches her;
 * 3. a job naming Olga, of a project VPS was not allowed, gets 404, naming nothing;
 * 4. the secret is in Hermes's .env and Tars's private folder, and in no argument either process ran with.
 *
 * Runs where a Hermes checkout is: TARS_HERMES_TREE (a Hermes source tree: 0.21.5 is the tag v2026.9.24) and
 * TARS_HERMES_PYTHON (a python with its dependencies, an install's venv). Skipped elsewhere, the CI included. The
 * artefact: values.json (each job's output, Wren's launches, Hermes's version) and the screenshot.
 */

const TREE = process.env.TARS_HERMES_TREE;
const PYTHON = process.env.TARS_HERMES_PYTHON;
const live = !!TREE && !!PYTHON && fs.existsSync(path.join(TREE, 'cron', 'scheduler.py'));
const BENCH = path.resolve('__tests__', 'fixtures', 'hermes-cron-bench.py');

const WREN = 'aaaa1111-0000-4000-8000-0000000000a1';
const OLGA = 'cccc3333-0000-4000-8000-0000000000c3';
type View = { id: string; label: string; projects: string[]; path: string };
type Api = { electronAPI: { hermes: { gateways: {
  add(p: { label: string }): Promise<{ success: true; gateway: View; secret: string }>;
  setProjects(p: { id: string; projects: string[] }): Promise<{ success: true; gateway: View }>;
} } } };

for (const newInterface of [false, true]) {
  test(`a real Hermes cron job on the webhook: its gateway's projects, never a wider mode, naming nothing${newInterface ? ' (new interface)' : ''}`, async () => {
    test.skip(!live, 'TARS_HERMES_TREE and TARS_HERMES_PYTHON name a Hermes checkout and its python');
    test.setTimeout(4 * 60_000);
    const home = fs.mkdtempSync('/tmp/dorothy-e2e-hermes-cron-');
    const hermesHome = path.join(home, 'hermes-home');
    const alpha = path.join(home, 'projects', 'alpha');
    const beta = path.join(home, 'projects', 'beta');
    const dir = path.join(home, '.dorothy');
    const bin = path.join(home, 'bin');
    for (const d of [alpha, beta, dir, bin, hermesHome]) fs.mkdirSync(d, { recursive: true });

    const record = path.join(home, 'claude.jsonl');
    const claude = path.join(bin, 'claude');
    fs.writeFileSync(claude, [
      `#!${process.execPath}`,
      "const fs = require('fs');",
      `const out = ${JSON.stringify(record)};`,
      "const who = process.env.CLAUDE_AGENT_ID || '';",
      "fs.appendFileSync(out, JSON.stringify({ who, argv: process.argv.slice(2) }) + '\\n');",
      "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
      "process.stdin.on('data', d => fs.appendFileSync(out, JSON.stringify({ who, typed: String(d) }) + '\\n'));",
      "process.stdout.write('claude stand-in ready\\n');",
      '',
    ].join('\n'), { mode: 0o755 });
    const records = () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<{ who: string; argv?: string[]; typed?: string }>;
    const launchesOf = (id: string) => records().filter(r => r.who === id && r.argv).map(r => r.argv!.join(' '));

    const agent = (id: string, name: string, projectPath: string) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'normal', projectPath, skills: [], cliPath: claude,
      createdAt: '2026-10-19T08:00:00.000Z', lastActivity: '2026-10-19T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent(WREN, 'Wren', alpha), agent(OLGA, 'Olga', beta)], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([alpha, beta]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }, null, 2));

    const port = apiPort(newInterface ? 31327 : 31326);
    const values: Record<string, unknown> = { newInterface, tree: TREE };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    let app: ElectronApplication | undefined;
    try {
      app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
      const appLog = test.info().outputPath('app.log');
      app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
      app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
      const page: Page = await app.firstWindow();
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });

      const added = await page.evaluate(() => (window as unknown as Api).electronAPI.hermes.gateways.add({ label: 'VPS' }));
      await page.evaluate((a) => (window as unknown as Api).electronAPI.hermes.gateways.setProjects(a), { id: added.gateway.id, projects: [alpha] });
      const url = `http://127.0.0.1:${port}${added.gateway.path}`;

      /** One job of the gateway's Hermes, run now by its own scheduler: what its script printed. */
      const job = (body: Record<string, unknown>) => {
        const ran = spawnSync(PYTHON!, [BENCH, TREE!, hermesHome, url, JSON.stringify(body)], {
          encoding: 'utf8', timeout: 120_000,
          env: { PATH: process.env.PATH ?? '', HOME: home, TARS_WEBHOOK_SECRET: added.secret },
        });
        const last = (ran.stdout || '').trim().split('\n').pop() || '{}';
        let out: { version?: string; ok?: boolean; output?: string; error?: string } = {};
        try { out = JSON.parse(last); } catch { out = { error: `${ran.stderr}`.slice(-2000) }; }
        let answer: { status?: number; body?: unknown } = {};
        try { answer = JSON.parse(String(out.output ?? '{}')); } catch { /* the job printed nothing JSON */ }
        return { ...out, answer, argv: ran.error ? String(ran.error) : undefined };
      };
      const names = [WREN, OLGA, 'Wren', 'Olga', alpha, beta];
      const naming = (body: unknown) => names.filter(n => JSON.stringify(body).includes(n));

      const reached = job({ agent_name: 'Wren', message: 'LIVE-1 from a Hermes cron' });
      keep({ reached });
      expect(reached.ok, JSON.stringify(reached)).toBe(true);
      expect(reached.answer.status, JSON.stringify(reached)).toBe(200);
      await expect.poll(() => launchesOf(WREN).length, { timeout: 30_000 }).toBe(1);
      expect.soft(launchesOf(WREN)[0]).toContain('LIVE-1 from a Hermes cron');
      expect.soft(launchesOf(WREN)[0]).toContain('--permission-mode default');

      const raised = job({ agent_id: WREN, message: 'LIVE-2 run anything', permission_mode: 'bypass' });
      const outside = job({ agent_name: 'Olga', message: 'LIVE-3 elsewhere' });
      keep({ raised, outside, version: reached.version, launches: { wren: launchesOf(WREN), olga: launchesOf(OLGA) } });
      expect.soft(raised.answer.status, JSON.stringify(raised)).toBe(403);
      expect.soft(naming(raised.answer.body)).toEqual([]);
      expect.soft(outside.answer.status, JSON.stringify(outside)).toBe(404);
      expect.soft(naming(outside.answer.body)).toEqual([]);
      expect.soft(records().filter(r => r.typed).map(r => r.typed).join(''), 'a refused job reached an agent').not.toMatch(/LIVE-2|LIVE-3/);
      expect.soft(launchesOf(WREN), 'a refused job started a session').toHaveLength(1);
      expect.soft(launchesOf(OLGA)).toEqual([]);

      // 4. Where the secret is: Hermes's .env, Tars's private folder; no argument of either.
      const envMode = (fs.statSync(path.join(hermesHome, '.env')).mode & 0o777).toString(8);
      const inArgs = records().some(r => (r.argv ?? []).join(' ').includes(added.secret));
      keep({ envMode, secretInAnAgentsArgs: inArgs });
      expect.soft(envMode).toBe('600');
      expect.soft(inArgs).toBe(false);
      await stepShot(page, newInterface ? 'hermes-cron-new-interface' : 'hermes-cron');
    } finally {
      await app?.close();
      await removeHome(home);
    }
  });
}
