import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A codex probe never outlives its give-up nor the quit (the Audit's report on probe orphans, 20/11). QA found four
 * orphans of PID 1, 4 to 6 h old: a codex stand-in's `--help` and `login status`, left by the create-agent spec after
 * the sandboxed app quit within 10 s of a codex launch. Every one-shot CLI probe now goes through core/cli-probe.ts.
 *
 * The real app on a sandbox HOME, two codex agents, each on a stand-in of its own that never answers a probe: its
 * `--help` and its `login status` hang, each with a child of its own deaf to SIGTERM, as a daemon a CLI starts; its
 * session runs. Every process a stand-in starts notes its pid.
 * 1. The give-up, while Tars runs: c1 starts. Its launch's `--help` read is given up on at 10 s. 14 s after it began,
 *    that probe and its child are gone, and no second `--help` was read (#608 read one in the background).
 * 2. The quit, within 10 s of a launch: c2 starts, and once its `--help` runs, the app quits. 2 s after the app is
 *    gone, no probe of either stand-in is left, nor what it started: c1's `login status`, begun at its give-up, and
 *    c2's `--help` among them.
 * Red at 715455c8b (#608's head): 1's child survives and two `--help` were read; 2 leaves the probes as orphans of
 * PID 1. The artefact: values.json (each note, what was alive when, the timings) and notes.jsonl.
 */

test.skip(process.platform === 'win32', 'the stand-ins are node scripts started by their shebang; on Windows a probe\'s tree is ended by taskkill /T, held by cli-probe.test.ts and version-probe-windows.test.ts; this runs on macOS and Linux');

type Note = { bin: string; role: string; pid: number; parent?: number; at: number };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } };

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const commandOf = (pid: number) => { try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch { return ''; } };

test('a codex probe never outlives its give-up nor the quit', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-probe-orphans-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const notesFile = path.join(home, 'notes.jsonl');
  const standIn = (name: string) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!${process.execPath}
const fs = require('fs'); const { spawn } = require('child_process');
const argv = process.argv.slice(2);
const role = argv[0] === '--help' ? 'help' : argv[0] === 'login' && argv[1] === 'status' ? 'login' : 'session';
const note = (r, pid, parent) => fs.appendFileSync(${JSON.stringify(notesFile)}, JSON.stringify({ bin: ${JSON.stringify(name)}, role: r, pid, parent, at: Date.now() }) + '\\n');
note(role, process.pid);
if (role === 'session') process.stdout.write('${name} ready\\r\\n');
else {
  // A probe that never answers, and a child of its own deaf to SIGTERM; the sandbox's path on its line, for the cleanup.
  const c = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", ${JSON.stringify(home)}], { stdio: 'ignore' });
  note(role + '-child', c.pid, process.pid);
}
setInterval(() => {}, 1 << 30);
`, { mode: 0o755 });
    return file;
  };
  const agent = (id: string, cliPath: string) => ({
    id, name: id, character: 'robot', provider: 'codex', status: 'idle', role: 'worker', permissionMode: 'normal',
    projectPath: project, skills: [], cliPath, createdAt: '2026-11-20T08:00:00.000Z', lastActivity: '2026-11-20T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('c1', standIn('codex-one')), agent('c2', standIn('codex-two'))], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false }));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  const notes = (): Note[] => (fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as Note) : []);
  const until = async (what: string, ok: () => boolean, ms = 60_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (ok()) return;
    throw new Error(`never: ${what}`);
  };
  const probes = (of: string) => notes().filter(n => n.bin === of && n.role !== 'session');
  const values: Record<string, unknown> = { home };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31601), DOROTHY_E2E: '1' },
  });
  let closed = false;
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    const start = (id: string) => page.evaluate(i => { void (window as unknown as Api).electronAPI.agent.start({ id: i, prompt: '' }); }, id);

    // 1. The give-up, while Tars runs.
    await start('c1');
    await until("c1's --help began", () => probes('codex-one').some(n => n.role === 'help'));
    const firstHelp = probes('codex-one').find(n => n.role === 'help')!;
    await until('14 s after it began', () => Date.now() >= firstHelp.at + 14_000, 30_000);
    const ofFirst = probes('codex-one').filter(n => n.pid === firstHelp.pid || n.parent === firstHelp.pid);
    const aliveAfterGiveUp = ofFirst.filter(n => alive(n.pid));
    const helpsOfC1 = probes('codex-one').filter(n => n.role === 'help').length;
    keep({ firstHelp, ofFirst, aliveAfterGiveUp, helpsOfC1, notesAfterGiveUp: notes() });

    // 2. The quit, within 10 s of a launch.
    await start('c2');
    await until("c2's --help began", () => probes('codex-two').some(n => n.role === 'help'));
    const c2Help = probes('codex-two').find(n => n.role === 'help')!;
    const quitWithinMs = Date.now() - c2Help.at;
    const runningAtQuit = notes().filter(n => n.role !== 'session' && alive(n.pid));
    await app.close();
    closed = true;
    await new Promise(r => setTimeout(r, 2_000));
    const leftAfterQuit = notes().filter(n => n.role !== 'session' && alive(n.pid)).map(n => ({ ...n, command: commandOf(n.pid) }));
    keep({ quitWithinMs, runningAtQuit, leftAfterQuit, notes: notes() });
    fs.copyFileSync(notesFile, test.info().outputPath('notes.jsonl'));

    expect.soft(ofFirst.length, "c1's first --help and its child were noted").toBe(2);
    expect.soft(aliveAfterGiveUp, 'left running after its give-up').toEqual([]);
    expect.soft(helpsOfC1, '--help reads for one launch').toBe(1);
    expect.soft(quitWithinMs, 'the quit came within 10 s of the launch').toBeLessThan(10_000);
    expect.soft(runningAtQuit.length, 'probes were running when the quit began').toBeGreaterThan(0);
    expect.soft(leftAfterQuit, 'left running after the quit').toEqual([]);
  } finally {
    if (!closed) await app.close().catch(() => undefined);
    // Ours only, by pid: what a stand-in noted and still runs, its line checked for this sandbox first.
    for (const n of notes()) if (alive(n.pid) && commandOf(n.pid).includes(home)) { try { process.kill(n.pid, 'SIGKILL'); } catch { /* gone */ } }
    await removeHome(home);
  }
});
