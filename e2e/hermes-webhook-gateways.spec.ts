import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * What a Hermes gateway's message may do, on the real webhook route of the real app (2.0.4, the Audit's NOW-3, R4.1
 * to R4.3).
 *
 * Measured on ce9c0084 (unit, api-who-may-drive-an-agent.test.ts): the webhook took `permission_mode: bypass` for an
 * agent in normal and typed the message, and its 404 listed every agent with its project and status. One secret
 * opened it for every gateway, and reached every project.
 *
 * An install as Hermes left it: the default gateway's secret in ~/.tars-private, and the user has allowed it project
 * alpha. Then the window adds a gateway "VPS" and allows it alpha too, as Settings, Hermes will (hermes:gateways:*).
 * Wren (normal) and Bea (bypass) work on alpha, Olga on beta. Their claude is a stand-in that records its arguments
 * and what is typed into it. Asserted, in both shells, over HTTP on the app's own port:
 * 0. the default gateway asking bypass for Wren is refused, and its 404 for an agent it does not know names nobody
 *    (on ce9c0084: 200 and her session started in bypass; the 404 listed every agent);
 * 1. VPS's message reaches Wren: her session starts on it, in her own mode;
 * 2. VPS asking bypass, or auto, for Wren is refused 403, nothing typed and no session started; asking plan for Bea
 *    starts her session in plan;
 * 3. Olga, of a project neither gateway was allowed, is not found by id, by name, by project path or in a dry run:
 *    404;
 * 5. no refusal names an agent, a project or a mode it is in;
 * 6. one gateway's secret on another's route is refused 403, a rotated secret opens nothing, the new one does;
 * 7. each secret is in its own file of ~/.tars-private, 0600, in its 0700 folder, and in no file of ~/.dorothy.
 * The artefact: values.json (each call and its answer, the launches) and the screenshot.
 */

const WREN = 'aaaa1111-0000-4000-8000-0000000000a1';
const BEA = 'bbbb2222-0000-4000-8000-0000000000b2';
const OLGA = 'cccc3333-0000-4000-8000-0000000000c3';
type View = { id: string; label: string; projects: string[]; path: string };
type Api = { electronAPI: { hermes: { gateways: {
  list(): Promise<{ success: true; gateways: View[] }>;
  add(p: { label: string }): Promise<{ success: true; gateway: View; secret: string }>;
  secret(p: { id: string }): Promise<{ success: true; secret: string }>;
  rotate(p: { id: string }): Promise<{ success: true; secret: string }>;
  setProjects(p: { id: string; projects: string[] }): Promise<{ success: true; gateway: View }>;
} } } };

for (const newInterface of [false, true]) {
  test(`a Hermes gateway's message never raises a mode, reaches only its projects and names nothing${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(3 * 60_000);
    const home = fs.mkdtempSync('/tmp/dorothy-e2e-hermes-gw-');
    const alpha = path.join(home, 'projects', 'alpha');
    const beta = path.join(home, 'projects', 'beta');
    const dir = path.join(home, '.dorothy');
    const bin = path.join(home, 'bin');
    for (const d of [alpha, beta, dir, bin]) fs.mkdirSync(d, { recursive: true });

    // claude, as a stand-in: its arguments and what is typed into it, one JSON line each.
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
    const typedInto = (id: string) => records().filter(r => r.who === id && r.typed).map(r => r.typed).join('');

    const agent = (id: string, name: string, projectPath: string, permissionMode: string) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode, projectPath, skills: [], cliPath: claude,
      createdAt: '2026-10-19T08:00:00.000Z', lastActivity: '2026-10-19T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent(WREN, 'Wren', alpha, 'normal'), agent(BEA, 'Bea', alpha, 'bypass'), agent(OLGA, 'Olga', beta, 'normal')], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([alpha, beta]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }, null, 2));
    // The default gateway as an install left it: the secret Hermes holds, and alpha allowed it.
    const priv = path.join(home, '.tars-private');
    fs.mkdirSync(priv, { recursive: true, mode: 0o700 });
    const heldSecret = randomBytes(32).toString('hex');
    fs.writeFileSync(path.join(priv, 'hermes-webhook-secret'), heldSecret, { mode: 0o600 });
    fs.writeFileSync(path.join(priv, 'hermes-gateways.json'), JSON.stringify({ gateways: [{ id: 'default', label: 'Hermes', projects: [alpha] }] }), { mode: 0o600 });

    const port = apiPort(newInterface ? 31319 : 31318);
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const calls: Array<{ what: string; status: number; body: unknown }> = [];
    let app: ElectronApplication | undefined;
    try {
      app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
      const appLog = test.info().outputPath('app.log');
      app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
      app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
      const page: Page = await app.firstWindow();
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
      const hook = async (what: string, secret: string, route: string, body: Record<string, unknown>) => {
        const res = await fetch(`http://127.0.0.1:${port}${route}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }, body: JSON.stringify(body),
        });
        const answer = { what, status: res.status, body: await res.json().catch(() => ({})) };
        calls.push(answer);
        keep({ calls });
        return answer;
      };
      const names = [WREN, BEA, OLGA, 'Wren', 'Bea', 'Olga', alpha, beta];
      const naming = (body: unknown) => names.filter(n => JSON.stringify(body).includes(n));

      // 0. The default gateway, the secret Hermes already holds: never a wider mode, and a 404 that names nobody.
      const oldRaise = await hook('default raising Wren to bypass', heldSecret, '/api/webhooks/hermes', { agent_id: WREN, message: 'HOOK-0 run anything', permission_mode: 'bypass' });
      const oldRoster = await hook('default to nobody', heldSecret, '/api/webhooks/hermes', { agent_id: 'nobody', message: 'HOOK-0 roster' });
      expect.soft(oldRaise.status, JSON.stringify(oldRaise.body)).toBe(403);
      expect.soft(naming(oldRaise.body)).toEqual([]);
      expect.soft(oldRoster.status).toBe(404);
      expect.soft(naming(oldRoster.body), 'the 404 names agents').toEqual([]);

      // The gateways, as the window sets them up (hermes:gateways:*).
      const gateways = {
        list: () => page.evaluate(() => (window as unknown as Api).electronAPI.hermes.gateways.list()),
        add: (label: string) => page.evaluate((l) => (window as unknown as Api).electronAPI.hermes.gateways.add({ label: l }), label),
        setProjects: (id: string, projects: string[]) => page.evaluate((a) => (window as unknown as Api).electronAPI.hermes.gateways.setProjects(a), { id, projects }),
        secret: (id: string) => page.evaluate((i) => (window as unknown as Api).electronAPI.hermes.gateways.secret({ id: i }), id),
        rotate: (id: string) => page.evaluate((i) => (window as unknown as Api).electronAPI.hermes.gateways.rotate({ id: i }), id),
      };
      const before = await gateways.list();
      const added = await gateways.add('VPS');
      const vps = added.gateway;
      await gateways.setProjects(vps.id, [alpha]);
      const defaultSecret = (await gateways.secret('default')).secret;
      const vpsSecret = added.secret;
      keep({ before: before.gateways, vps });
      expect(before.gateways.map(g => [g.id, g.projects])).toEqual([['default', [alpha]]]);
      expect(defaultSecret, 'the secret Hermes holds was replaced').toBe(heldSecret);
      expect(vps.path).toBe(`/api/webhooks/hermes/${vps.id}`);

      // 1. VPS reaches Wren: her session starts on the message, in her own mode.
      const first = await hook('vps to Wren', vpsSecret, vps.path, { agent_name: 'wren', message: 'HOOK-1 the nightly check' });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      await expect.poll(() => launchesOf(WREN).length, { timeout: 30_000 }).toBe(1);
      expect(launchesOf(WREN)[0]).toContain('--permission-mode default');
      expect(launchesOf(WREN)[0]).toContain('HOOK-1 the nightly check');

      // 2. A wider mode for Wren: refused, nothing typed, no session. A narrower one for Bea: her session in plan.
      for (const permission_mode of ['bypass', 'auto']) {
        const raised = await hook(`vps raising Wren to ${permission_mode}`, vpsSecret, vps.path, { agent_id: WREN, message: `HOOK-2 ${permission_mode}`, permission_mode });
        expect.soft(raised.status, JSON.stringify(raised.body)).toBe(403);
        expect.soft(naming(raised.body)).toEqual([]);
        expect.soft(JSON.stringify(raised.body)).not.toContain('normal');
      }
      const lowered = await hook('vps lowering Bea to plan', vpsSecret, vps.path, { agent_name: 'Bea', message: 'HOOK-3 look only', permission_mode: 'plan' });
      expect(lowered.status, JSON.stringify(lowered.body)).toBe(200);
      await expect.poll(() => launchesOf(BEA).length, { timeout: 30_000 }).toBe(1);
      expect.soft(launchesOf(BEA)[0]).toContain('--permission-mode plan');
      expect.soft(launchesOf(BEA)[0]).not.toContain('--dangerously-skip-permissions');

      // 3, 5. What neither gateway was allowed: 404, naming nothing.
      for (const [what, secret, route, body] of [
        ['vps to Olga by id', vpsSecret, vps.path, { agent_id: OLGA, message: 'HOOK-4 by id' }],
        ['vps to Olga by name', vpsSecret, vps.path, { agent_name: 'Olga', message: 'HOOK-4 by name' }],
        ['vps to beta by path', vpsSecret, vps.path, { agent_name: 'Wren', project_path: beta, message: 'HOOK-4 by path' }],
        ['vps dry run on Olga', vpsSecret, vps.path, { agent_id: OLGA, message: 'HOOK-4 dry', dry_run: true }],
        ['default to Olga', defaultSecret, '/api/webhooks/hermes', { agent_name: 'Olga', message: 'HOOK-5 default' }],
      ] as const) {
        const refused = await hook(what, secret, route, body);
        expect.soft(refused.status, what).toBe(404);
        expect.soft(naming(refused.body), what).toEqual([]);
      }

      // 6. One gateway's secret on another's route; a rotated secret.
      for (const [what, secret, route] of [['default on vps', defaultSecret, vps.path], ['vps on default', vpsSecret, '/api/webhooks/hermes']] as const) {
        const crossed = await hook(what, secret, route, { agent_id: WREN, message: 'HOOK-6 crossed', dry_run: true });
        expect.soft(crossed.status, what).toBe(403);
        expect.soft(naming(crossed.body), what).toEqual([]);
      }
      const fresh = (await gateways.rotate(vps.id)).secret;
      expect.soft((await hook('the old vps secret', vpsSecret, vps.path, { agent_id: WREN, message: 'HOOK-7 old', dry_run: true })).status).toBe(401);
      expect.soft((await hook('the new vps secret', fresh, vps.path, { agent_id: WREN, message: 'HOOK-7 new', dry_run: true })).status).toBe(200);

      expect.soft(typedInto(WREN), 'a refused message was typed into Wren').not.toMatch(/HOOK-0|HOOK-2|HOOK-5|HOOK-6|HOOK-7/);
      expect.soft(launchesOf(WREN), 'a refused message started a session').toHaveLength(1);
      expect.soft(launchesOf(OLGA), 'Olga was started').toEqual([]);

      // 7. The secrets on disk.
      const secretFiles = fs.readdirSync(priv).filter(f => f.startsWith('hermes-webhook-')).sort();
      const modes = Object.fromEntries([...secretFiles, 'hermes-gateways.json'].map(f => [f, (fs.statSync(path.join(priv, f)).mode & 0o777).toString(8)]));
      const inData = (() => {
        const found: string[] = [];
        const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile() && fs.statSync(p).size < 5_000_000 && [fresh, defaultSecret].some(s => fs.readFileSync(p, 'utf8').includes(s))) found.push(path.relative(home, p)); } };
        walk(dir);
        return found;
      })();
      keep({ secretFiles, modes, privateFolder: (fs.statSync(priv).mode & 0o777).toString(8), secretsInDorothy: inData, launches: { wren: launchesOf(WREN), bea: launchesOf(BEA), olga: launchesOf(OLGA) } });
      expect.soft(secretFiles).toEqual(['hermes-webhook-secret', `hermes-webhook-${vps.id}.secret`].sort());
      expect.soft(Object.values(modes)).toEqual(Object.values(modes).map(() => '600'));
      expect.soft((fs.statSync(priv).mode & 0o777).toString(8)).toBe('700');
      expect.soft(inData, 'a secret in the folder every agent is handed').toEqual([]);
      await stepShot(page, newInterface ? 'hermes-gateways-new-interface' : 'hermes-gateways');
    } finally {
      await app?.close();
      await removeHome(home);
    }
  });
}
