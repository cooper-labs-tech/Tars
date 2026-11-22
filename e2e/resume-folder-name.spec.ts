import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent of a project whose path holds an underscore and a space resumes
 * its conversation after a relaunch (1.9.6).
 *
 * Claude Code files a project's transcripts under a folder named after its
 * path, every character that is not an ASCII letter or digit turned into `-`
 * (measured on claude 2.1.296, 2026-10-13: `/private/tmp/tars naming_~probe`
 * is `-private-tmp-tars-naming--probe`). Tars looked for them on macOS and
 * Linux with only `/` and `.` turned, so it never found the conversation of
 * such a project: no `--resume`, a new conversation at every launch.
 *
 * The stand-in CLI files its transcript as Claude Code does, registers its
 * session through the real hooks, and records each launch's argv.
 * Asserted: the second launch, after the relaunch, resumes the first's session.
 * The artefact: values.json with both launches.
 */

const HOOKS = path.resolve('hooks');

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
const resumed = args.indexOf('--resume');
const sid = resumed === -1 ? crypto.randomUUID() : args[resumed + 1];
// Claude Code's folder: every non-alphanumeric of the real cwd to '-'.
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
if (!fs.existsSync(transcript)) fs.writeFileSync(transcript, JSON.stringify({ type: 'user', sessionId: sid, message: { role: 'user', content: 'hello' } }) + '\n');
fs.appendFileSync(path.join(process.env.HOME, 'launches.jsonl'), JSON.stringify({ at: new Date().toISOString(), sid, cwd: process.cwd(), resume: resumed === -1 ? null : args[resumed + 1] }) + '\n');
spawnSync('/bin/bash', [path.join(HOOKS, 'session-start.sh')], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, hook_event_name: 'SessionStart', source: resumed === -1 ? 'startup' : 'resume' }),
  env: process.env, timeout: 20000,
});
process.stdout.write('stand-in session ' + sid + '\r\n> ');
process.stdin.resume();
`;

type Agent = { id: string; cliRunning?: boolean; currentSessionId?: string; resumableSessionId?: string };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; stop(id: string): Promise<unknown>; list(): Promise<Agent[]> } } };

test('an agent of a project whose path holds an underscore and a space resumes its conversation after a relaunch', async () => {
  test.setTimeout(300_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-folder-'));
  const project = path.join(home, 'projects', 'my_proj with space');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const cli = path.join(bin, 'claude');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'w', name: 'Worker', character: 'robot', provider: 'claude', status: 'idle', role: 'worker', permissionMode: 'normal',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-13T08:00:00.000Z', lastActivity: '2026-10-13T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const launches = () => (fs.existsSync(path.join(home, 'launches.jsonl'))
    ? fs.readFileSync(path.join(home, 'launches.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const port = apiPort(31451);
  const values: Record<string, unknown> = {};

  const run = async (label: string) => {
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      const list = () => page.evaluate(() => (window as unknown as Api).electronAPI.agent.list());
      const before = launches().length;
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'w', prompt: '' }));
      await expect.poll(() => launches().length, { timeout: 60_000 }).toBe(before + 1);
      await expect.poll(async () => (await list()).find((a) => a.id === 'w')?.currentSessionId ?? null, { timeout: 60_000 }).not.toBeNull();
      values[label] = { launch: launches().at(-1), agent: (await list()).find((a) => a.id === 'w') };
    } finally {
      await app.close();
    }
  };

  await run('first');
  await run('second');
  recordValues(values);
  const [first, second] = launches();
  expect(first.resume).toBeNull();
  expect(second.resume, 'the relaunch resumes the first session').toBe(first.sid);
  await removeHome(home);
});
