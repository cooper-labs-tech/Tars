import { test, expect, _electron as electron, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * One hook runner everywhere (2.0.4, parity P4). In the real app, a sandbox Tars writes its hook launcher and wires
 * the hooks and the status line of ~/.claude/settings.json through it. A stand-in CLI that Tars starts then runs the
 * very commands written there, as Claude Code runs a hook (`/bin/sh -c`, the hook's JSON on stdin), with a PATH that
 * holds nothing: no bash, jq, curl, awk or node can be found. Its session registers, its turn reads `running` and
 * then `idle` in Tars. Outside Tars (no terminal token) the Stop hook answers at once, as the runner would, and the
 * status line still writes the quota counters the Usage page reads.
 *
 * On the build before this change, the commands are the bare .sh paths on macOS and Linux, which need bash, jq and
 * curl; with that PATH no session ever registers. The artefact: values.json with the launcher's Node, the commands,
 * each hook's answer and time, and what Tars saw.
 */

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const sid = crypto.randomUUID();
const home = process.env.HOME;
const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
const commandOf = (event) => settings.hooks[event][0].hooks[0].command;
const record = (o) => fs.appendFileSync(path.join(home, 'hooks-run.jsonl'), JSON.stringify(o) + '\n');
// As Claude Code: /bin/sh -c "<command>", the JSON on stdin; here with a PATH that finds nothing.
const run = (event, payload) => {
  const started = Date.now();
  const r = spawnSync('/bin/sh', ['-c', commandOf(event)], {
    input: JSON.stringify({ session_id: sid, cwd: process.cwd(), hook_event_name: event, ...payload }),
    env: { ...process.env, PATH: '/nonexistent' }, encoding: 'utf8', timeout: 20000,
  });
  record({ event, status: r.status, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - started });
};
const waitFor = (file) => new Promise((resolve) => { const t = setInterval(() => { if (fs.existsSync(file)) { clearInterval(t); resolve(); } }, 100); });
process.stdin.setRawMode(true);
run('SessionStart', { source: 'startup' });
process.stdout.write('STAND-IN session ' + sid + '\r\n> ');
(async () => {
  run('UserPromptSubmit', { prompt: 'hello' });
  run('PostToolUse', { tool_name: 'Read', tool_input: { file_path: 'a' } });
  await waitFor(path.join(home, 'go-stop'));
  run('Stop', { stop_hook_active: false, last_assistant_message: 'done' });
})();
process.stdin.resume();
`;

type Agent = { id: string; status: string; currentSessionId?: string };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; get(id: string): Promise<Agent> } } };
const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test.skip(process.platform === 'win32', 'the stand-in CLI is a POSIX script; the Windows launcher is held by its unit cases');

test('every hook and the status line run through the launcher, with no bash, jq, curl or node on the PATH', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-launcher-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\n${STAND_IN}`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'hk', name: 'Hooks Worker', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'normal',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-17T08:00:00.000Z', lastActivity: '2026-10-17T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, statusLineEnabled: true, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const values: Record<string, unknown> = {};
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const launcher = path.join(dir, 'bin', 'tars-hook');

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31430), DOROTHY_E2E: '1' },
  });
  try {
    const page: Page = await app.firstWindow();
    const settings = () => (fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {});
    await expect.poll(() => settings().hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? '', { timeout: 60_000 }).toMatch(/tars-hook"? /);
    await expect.poll(() => settings().statusLine?.command ?? '', { timeout: 30_000 }).toContain('statusline.mjs');
    const written = settings();
    values.commands = Object.fromEntries(Object.entries(written.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).map(([k, v]) => [k, v[0].hooks[0].command]));
    values.statusLine = written.statusLine.command;
    for (const command of [...Object.values(values.commands as Record<string, string>), written.statusLine.command]) {
      expect(command.startsWith(`"${launcher}" `), command).toBe(true);
    }
    expect(fs.statSync(launcher).mode & 0o777).toBe(0o700);
    const named = /^NODE='(.+)'$/m.exec(fs.readFileSync(launcher, 'utf8'))?.[1];
    values.launcherNode = named;
    expect(named && path.isAbsolute(named)).toBe(true);
    const version = spawnSync(named!, ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.trim();
    values.launcherNodeVersion = version;
    expect(Number(version.split('.')[0])).toBeGreaterThanOrEqual(16);

    // In Tars: the stand-in's session registers and its turn is seen running, then at rest.
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'hk', prompt: 'hello' }));
    const agent = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.get('hk'));
    const ran = path.join(home, 'hooks-run.jsonl');
    await expect.poll(() => lines(ran).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(3);
    const sid = (await agent()).currentSessionId;
    values.registeredSession = sid;
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    await expect.poll(async () => (await agent()).status, { timeout: 30_000 }).toBe('running');
    fs.writeFileSync(path.join(home, 'go-stop'), '');
    await expect.poll(() => lines(ran).length, { timeout: 30_000 }).toBe(4);
    await expect.poll(async () => (await agent()).status, { timeout: 30_000 }).toBe('idle');
    const inTars = lines(ran);
    values.inTars = inTars;
    for (const r of inTars) expect([r.event, r.status, r.stderr]).toEqual([r.event, 0, '']);

    // Outside Tars: no terminal token. The Stop hook answers in the launcher; the status line writes its counters.
    const outside = { HOME: home, PATH: '/nonexistent' };
    const started = Date.now();
    const stop = spawnSync('/bin/sh', ['-c', (values.commands as Record<string, string>).Stop], { input: '{"session_id":"x"}', env: outside, encoding: 'utf8' });
    values.outsideStop = { status: stop.status, stdout: stop.stdout, ms: Date.now() - started };
    expect([stop.status, stop.stdout, stop.stderr]).toEqual([0, '{"continue":true,"suppressOutput":true}\n', '']);
    const line = spawnSync('/bin/sh', ['-c', written.statusLine.command], {
      input: JSON.stringify({ session_id: 'outside-1', model: { display_name: 'Opus' }, cost: { total_cost_usd: 0.5 }, rate_limits: { five_hour: { used_percentage: 42 } } }),
      env: outside, encoding: 'utf8',
    });
    values.outsideStatusLine = { status: line.status, stdout: line.stdout.slice(0, 200) };
    expect(line.status).toBe(0);
    expect(line.stdout).toContain('Opus');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'rate-limits.json'), 'utf8'))).toMatchObject({ five_hour: { used_percentage: 42 } });
  } finally {
    recordValues(values);
    await app.close();
    await removeHome(home);
  }
});
