import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The kanban's one-shot `claude -p` (utils/kanban-generate.ts) never outlives the quit, nor what it started. It was a
 * shell's `exec` that nothing tracked, so the probes #616 ends at the quit (core/cli-probe.ts) did not include it.
 *
 * The real app on a sandbox HOME. `claude` on the PATH Tars builds is a stand-in: asked anything else, it answers and
 * exits; asked `-p`, it never answers, and starts a child of its own deaf to SIGTERM, as a daemon a CLI starts. Each
 * process it starts notes its pid. A task is generated through POST /api/kanban/generate. Once the stand-in and its
 * child run, the app quits, well within the call's 30 s.
 * Asserted: 2 s after the app is gone, neither process is alive.
 * Red at #616's head (cb20f994f): both are left, orphans of PID 1. The artefact: values.json and notes.jsonl.
 */

test.skip(process.platform === 'win32', 'the stand-in is a node script started by its shebang through /bin/sh; on Windows the call goes through probeCli by argv, whose tree taskkill /T ends (cli-probe.test.ts); this runs on macOS and Linux');

type Note = { role: string; pid: number; at: number };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const commandOf = (pid: number) => { try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return ''; } };

test("the kanban's claude -p ends with the quit, and what it started", async () => {
  test.setTimeout(180_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-kanban-probe-quit-'));
  const dir = path.join(home, '.tars');
  // ~/.local/bin comes before the inherited PATH in the one Tars builds (utils/path-builder.ts).
  const bin = path.join(home, '.local', 'bin');
  for (const d of [dir, bin]) fs.mkdirSync(d, { recursive: true });
  const notesFile = path.join(home, 'notes.jsonl');
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs'); const { spawn } = require('child_process');
const argv = process.argv.slice(2);
const note = (role, pid) => fs.appendFileSync(${JSON.stringify(notesFile)}, JSON.stringify({ role, pid, at: Date.now() }) + '\\n');
if (argv[0] !== '-p') { process.stdout.write(argv[0] === '--version' ? '2.1.332 (Claude Code)\\n' : '\\n'); process.exit(0); }
note('kanban', process.pid);
// A child of its own, deaf to SIGTERM; the sandbox's path on its line, for the cleanup.
const c = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", ${JSON.stringify(home)}], { stdio: 'ignore' });
note('kanban-child', c.pid);
setInterval(() => {}, 1 << 30);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const notes = (): Note[] => (fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Note) : []);
  const until = async (what: string, ok: () => boolean, ms = 60_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (ok()) return;
    throw new Error(`never: ${what}`);
  };
  const values: Record<string, unknown> = { home };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const port = apiPort(31603);
  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  let closed = false;
  try {
    await app.firstWindow();
    const tokenFile = path.join(home, '.tars-private', 'api-token');
    await until('the API token is written', () => fs.existsSync(tokenFile));
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    let answered: unknown = 'not yet';
    // Not awaited: the call waits on claude, and the quit is what ends it.
    void fetch(`http://127.0.0.1:${port}/api/kanban/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: 'Ship the thing', availableProjects: [] }),
    }).then(r => r.json(), e => String(e)).then(a => { answered = a; });
    await until('claude -p and its child run', () => notes().length === 2 && notes().every(n => alive(n.pid)));
    const runningAtQuit = notes();
    const quitAfterMs = Date.now() - Math.min(...runningAtQuit.map(n => n.at));
    await app.close();
    closed = true;
    await new Promise(r => setTimeout(r, 2_000));
    const leftAfterQuit = notes().filter(n => alive(n.pid)).map(n => ({ ...n, command: commandOf(n.pid) }));
    keep({ runningAtQuit, quitAfterMs, leftAfterQuit, answered, notes: notes() });
    fs.copyFileSync(notesFile, test.info().outputPath('notes.jsonl'));

    expect.soft(quitAfterMs, 'the quit came within the call\'s 30 s').toBeLessThan(30_000);
    expect(leftAfterQuit, 'left running after the quit').toEqual([]);
  } finally {
    if (!closed) await app.close().catch(() => undefined);
    // Ours only, by pid: what the stand-in noted and still runs, its line checked for this sandbox first.
    for (const n of notes()) if (alive(n.pid) && commandOf(n.pid).includes(home)) { try { process.kill(n.pid, 'SIGKILL'); } catch { /* gone */ } }
    await removeHome(home);
  }
});
