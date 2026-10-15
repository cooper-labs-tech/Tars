import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { launchSandboxed, recordValues, seedSandbox, settleFleet } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Quitting Tars with its terminals running ends the app at once, cleanly, and
 * everything it started with it.
 *
 * Found on 2026-09-27: a quit took 16 to 67 s under load, once about
 * an hour, although before-quit, will-quit and exit all ran within 142 ms, and
 * electron.exe outlived its `exit` event. Measured here, two
 * causes, one of them the app's:
 * - Killing a ConPTY terminal closes its pseudo console, and its shell exits a
 *   moment later, while Electron tears Node down: node-pty's exit thread then
 *   calls into it. electron.exe started directly with 6 terminals ended at
 *   before-quit, idle: 7 quits of 10 hung until killed, 3 ended in 0xC0000409;
 *   under 8 busy loops 4 of 5 crashed. After a crash Windows Error Reporting
 *   holds the dying process (and its profile) for as long as it takes to write
 *   its report.
 * - On a machine whose every core runs a busy loop, Chromium's own shutdown
 *   waits on children whose threads it has put at idle priority: a bare
 *   Electron 44 app, one blank window and nothing of Tars, took 20 to 59 s to
 *   quit under 8 busy loops (85 ms idle), and Tars with no terminal 43 to 87 s.
 *   Not the app's: with E2E_QUIT_LOAD set, the times are recorded, not held
 *   against it.
 *
 * How it fails, written before the fix:
 * 1. The app does not exit cleanly: its exit code is not 0 (0xC0000409 is the
 *    crash on the way out).
 * 2. Idle, the app's own `exit` comes later than MAIN_EXIT_BUDGET_MS after
 *    the quit (app.quit(), as Quit Tars).
 * 2b. The hang: the main process, or anything the app started, is still alive
 *    AFTER_EXIT_BUDGET_MS past the app's own `exit`, named by pid and creation
 *    time so a reused pid is never counted. The hang lasted until the process
 *    was killed; the bound is well past the slowest clean quit measured on a
 *    loaded machine (11.3 s from quit to main exit, the `exit` mark at 0.8 s,
 *    2026-09-28, about 74 electron and node processes of other runs beside it).
 *    The main process itself, where the hang lived, is held tighter:
 *    MAIN_AFTER_EXIT_BUDGET_MS past `exit`. Its time from the quit is
 *    recorded (mainExitMs), not held against the app: past `exit` it is
 *    Chromium's shutdown, starved on a busy machine (below).
 * 3. Something the app started (a terminal's shell or CLI, a console list
 *    helper, a Chromium child) is still alive AFTER_EXIT_BUDGET_MS past the
 *    app's `exit` (2b). How long each ran on after the main process exited
 *    is recorded (leftovers, over LEFTOVER_BUDGET_MS), not held: on a loaded
 *    machine a Chromium utility process was measured at 17.6 s past a main
 *    exit that had itself taken 10.8 s, a clean quit (2026-09-28).
 * 4. A terminal's shell outlives the quit (what desktop-shell.win32.spec.ts asserts, kept).
 * 5. The profile cannot be removed once everything has ended (EBUSY).
 * The race does not lose every time, so the spec quits QUITS times (6), each
 * in a fresh app: on the old build 8 idle quits of 16 exited 0xC0000409, and
 * each of three runs of this spec failed.
 *
 *   E2E_PORT_OFFSET=40 npx playwright test e2e/quit-time.win32.spec.ts
 *   E2E_QUIT_LOAD=8 ...  the same on a busy machine, times recorded only
 */

test.skip(process.platform !== 'win32', 'the Windows quit: ConPTY and node-pty\'s exit thread');

const DIST = path.resolve('electron', 'dist');
const LOAD = Number(process.env.E2E_QUIT_LOAD ?? 0);
const QUITS = Number(process.env.E2E_QUITS ?? 6);
const MAIN_EXIT_BUDGET_MS = 5_000;
const LEFTOVER_BUDGET_MS = 3_000;
const AFTER_EXIT_BUDGET_MS = 60_000;
// Worst benign main linger measured: ~10.5 s past `exit` (loaded, 2026-09-28); the hang this spec is for lives in main.
const MAIN_AFTER_EXIT_BUDGET_MS = 20_000;
const COMMAND = 'E2E_PORT_OFFSET=40 npx playwright test e2e/quit-time.win32.spec.ts';
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/**
 * Every process under `Root`, named by pid and creation time, watched until
 * all of them have exited or `Seconds` have passed: when each was first seen
 * and when it was last seen alive, in ms since the epoch (Date.now()'s clock).
 */
const WATCH = `
param([int]$Root, [int]$Seconds, [string]$Out, [string]$Ready)
$start = Get-Date
$key = { param($p) "$($p.ProcessId)@$($p.CreationDate.ToFileTimeUtc())" }
$seen = @{}
$first = $true
while (((Get-Date) - $start).TotalSeconds -lt $Seconds) {
  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name,CommandLine)
  $byPid = @{}; foreach ($p in $all) { $byPid[[int]$p.ProcessId] = $p }
  if ($first) {
    $r = $byPid[$Root]
    if (-not $r) { break }
    $seen[(& $key $r)] = @{ pid = [int]$r.ProcessId; name = $r.Name; cmd = [string]$r.CommandLine; firstMs = $t; lastMs = $t }
  }
  $alive = @{}
  foreach ($k in @($seen.Keys)) {
    $e = $seen[$k]; $p = $byPid[$e.pid]
    if ($p -and (& $key $p) -eq $k) { $alive[$e.pid] = $p; $e.lastMs = $t }
  }
  do {
    $grew = $false
    foreach ($p in $all) {
      $parent = $alive[[int]$p.ParentProcessId]
      if (-not $parent -or $parent.CreationDate -gt $p.CreationDate) { continue }
      $k = & $key $p
      if ($seen.ContainsKey($k)) { continue }
      $seen[$k] = @{ pid = [int]$p.ProcessId; name = $p.Name; cmd = [string]$p.CommandLine; firstMs = $t; lastMs = $t }
      $alive[[int]$p.ProcessId] = $p; $grew = $true
    }
  } while ($grew)
  if ($first) { Set-Content -Encoding ascii $Ready ([string]$t); $first = $false }
  if ($alive.Count -eq 0) { break }
  Start-Sleep -Milliseconds 100
}
@{ processes = @($seen.Values) } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 $Out
`;

type Watched = { pid: number; name: string; cmd: string; firstMs: number; lastMs: number };

function busyLoops(n: number): ChildProcess[] {
  return Array.from({ length: n }, () => spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }));
}

/** One launch with six terminals (four agents' CLIs and two shells), one quit, and what it left. */
async function launchAndQuit(round: number) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-quit-time-'));
  const work = test.info().outputPath(`quit-${round}`);
  fs.mkdirSync(work, { recursive: true });
  seedSandbox(home);
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31464), DOROTHY_E2E: '1' },
  });
  // On Windows Playwright starts the app through cmd.exe, which ends with it
  // and hands on its exit code.
  const child = app.process();
  const rootPid = child.pid!;
  let exitAt = 0;
  let closeAt = 0;
  child.on('exit', () => { exitAt = Date.now(); });
  child.on('close', () => { closeAt = Date.now(); });
  let quitting = false;
  const printed: string[] = [];
  const keep = (chunk: Buffer) => { if (quitting) printed.push(...String(chunk).split(/\r?\n/).filter(Boolean)); };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const load: ChildProcess[] = [];
  let watcher: ChildProcess | undefined;
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await settleFleet(app);
    // Two shells besides the four agents: killAllPty ends every map.
    await app.evaluate(async ({ ipcMain }, cwd) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (e: unknown, ...a: unknown[]) => Promise<{ id: string }>> })._invokeHandlers;
      const create = handlers.get('pty:create')!;
      for (let i = 0; i < 2; i++) await create({}, { cwd, cols: 80, rows: 24 });
    }, home);
    await page.waitForTimeout(4_000);
    // The launched electron.exe (the cmd.exe root's child), for 2b's tighter bound.
    const mainPid = await app.evaluate(() => process.pid);
    const shellPids = await app.evaluate((_e, dist) => {
      const pm = process.mainModule!.require(`${dist}/core/pty-manager.js`);
      return [...pm.ptyProcesses.values(), ...pm.quickPtyProcesses.values()].map((p: { pid: number }) => p.pid);
    }, DIST);

    // The app's own view of its quit, written as it happens.
    const marks = path.join(work, 'marks.txt');
    await app.evaluate(({ app: running }, file) => {
      const fsm = process.getBuiltinModule('node:fs');
      const mark = (what: string) => fsm.appendFileSync(file, `${what} ${Date.now()}\n`);
      running.on('before-quit', () => mark('before-quit'));
      running.on('will-quit', () => mark('will-quit'));
      process.on('exit', () => mark('exit'));
    }, marks);

    load.push(...busyLoops(LOAD));
    await page.waitForTimeout(LOAD > 0 ? 2_000 : 0);

    const script = path.join(work, 'watch.ps1');
    const out = path.join(work, 'tree.json');
    const ready = path.join(work, 'ready.txt');
    fs.writeFileSync(script, WATCH);
    watcher = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-Root', String(rootPid), '-Seconds', '240', '-Out', out, '-Ready', ready], { stdio: 'ignore', windowsHide: true });
    const watcherDone = new Promise<void>(resolve => watcher!.on('exit', () => resolve()));
    await expect.poll(() => fs.existsSync(ready), { timeout: 60_000 }).toBe(true);

    // Playwright's close is app.quit(), which is what Quit Tars calls, and then
    // it drops its inspector session. Quitting through the tray item with the
    // session kept measures something no user meets: Node's exit then waits for
    // the debugger to disconnect ("Waiting for the debugger to disconnect..."),
    // which Playwright does only once it sees the browser go.
    const quitAt = Date.now();
    quitting = true;
    const closing = app.close().catch(() => {});
    await expect.poll(() => exitAt, { timeout: 240_000, intervals: [50] }).toBeGreaterThan(0);
    await closing;
    await watcherDone;
    await expect.poll(() => closeAt, { timeout: 30_000, intervals: [50] }).toBeGreaterThan(0);
    for (const p of load) p.kill();

    const tree = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\uFEFF/, '')) as { processes: Watched[] };
    const mainExitMs = exitAt - quitAt;
    const started = tree.processes.filter(p => p.pid !== rootPid);
    const since = (ms: number) => ms - quitAt;
    const leftovers = started
      .map(p => ({ pid: p.pid, name: p.name, cmd: p.cmd.slice(0, 160), aliveMsAfterMainExit: since(p.lastMs) - mainExitMs }))
      .filter(p => p.aliveMsAfterMainExit > LEFTOVER_BUDGET_MS);
    const shellsAlive = shellPids.filter(pid => started.some(p => p.pid === pid && since(p.lastMs) > mainExitMs + LEFTOVER_BUDGET_MS));
    const crashReports = started.filter(p => /WerFault/i.test(p.name)).map(p => p.cmd);
    const marksEarly = fs.existsSync(marks) ? fs.readFileSync(marks, 'utf8') : '';
    const exitMark = /^exit (\d+)$/m.exec(marksEarly);
    const appExitMs = exitMark ? Number(exitMark[1]) - quitAt : null;
    // 2b: the main process (electron.exe, a child of the cmd.exe root) is among them.
    const aliveAfterExit = appExitMs === null ? [] : started
      .map(p => ({ pid: p.pid, name: p.name, cmd: p.cmd.slice(0, 160), aliveMsAfterAppExit: since(p.lastMs) - appExitMs }))
      .filter(p => p.aliveMsAfterAppExit > AFTER_EXIT_BUDGET_MS);
    // The main process by pid and creation time: the entry the watcher saw first
    // with its pid, before the quit, not a later process that reused it.
    const mainEntry = started.filter(p => p.pid === mainPid).sort((a, b) => a.firstMs - b.firstMs)[0];
    const mainAliveMsAfterAppExit = mainEntry && appExitMs !== null ? since(mainEntry.lastMs) - appExitMs : null;
    let profileRemoved = 'yes';
    try {
      fs.rmSync(path.join(home, 'electron-profile'), { recursive: true, force: true });
    } catch (err) {
      profileRemoved = String(err);
    }
    const marksRead = fs.existsSync(marks)
      ? Object.fromEntries(fs.readFileSync(marks, 'utf8').trim().split(/\r?\n/).map(l => l.split(' ')).map(([k, v]) => [k, Number(v) - quitAt]))
      : {};
    return {
      round, shellPids, exitCode: child.exitCode, appExitMs, mainExitMs, stdioCloseMs: closeAt - quitAt,
      treeGoneMs: since(tree.processes.reduce((m, p) => Math.max(m, p.lastMs), 0)),
      appMarksMs: marksRead, crashReports, mainPid, mainSeen: !!mainEntry, mainAliveMsAfterAppExit, aliveAfterExit, leftovers, shellsAlive, profileRemoved,
      printedOnQuit: printed.slice(-20),
      processes: started.map(p => ({ pid: p.pid, name: p.name, cmd: p.cmd.slice(0, 300), firstMs: since(p.firstMs), lastMs: since(p.lastMs) })),
    };
  } finally {
    for (const p of load) p.kill();
    if (watcher && watcher.exitCode === null) watcher.kill();
    if (!exitAt) await app.close().catch(() => {});
    // The cleanup never stands in for the round's own result: a profile still
    // held is measured above (profileRemoved, 5) and asserted on there.
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (err) {
      console.warn(`[quit-time] round ${round}: the sandbox could not be removed: ${err}`);
    }
  }
}

test('quitting with six terminals running exits cleanly and at once, and leaves nothing running', async () => {
  test.setTimeout(QUITS * 150_000 + (LOAD > 0 ? QUITS * 300_000 : 0));
  const quits = [];
  for (let round = 1; round <= QUITS; round++) {
    quits.push(await launchAndQuit(round));
    recordValues({ command: COMMAND, load: LOAD, quits });
  }
  const summary = quits.map(q => ({ round: q.round, exitCode: q.exitCode, appExitMs: q.appExitMs, mainExitMs: q.mainExitMs, crashReports: q.crashReports.length, mainAliveMsAfterAppExit: q.mainAliveMsAfterAppExit, aliveAfterExit: q.aliveAfterExit.length, leftovers: q.leftovers.length, shellsAlive: q.shellsAlive.length, profileRemoved: q.profileRemoved }));
  recordValues({ summary });
  for (const q of quits) {
    expect(q.exitCode, `quit ${q.round}: the app did not exit cleanly`).toBe(0);
    expect(q.appExitMs, `quit ${q.round}: the app never reached its exit`).not.toBeNull();
    if (LOAD === 0) {
      expect(q.appExitMs!, `quit ${q.round}: the app's exit came late after the quit`).toBeLessThan(MAIN_EXIT_BUDGET_MS);
      expect(q.mainSeen, `quit ${q.round}: the main process ${q.mainPid} was not in the watched tree`).toBe(true);
      expect(q.mainAliveMsAfterAppExit!, `quit ${q.round}: the main process hung past its exit`).toBeLessThanOrEqual(MAIN_AFTER_EXIT_BUDGET_MS);
      expect(q.aliveAfterExit, `quit ${q.round}: a process the app started hung past its exit`).toEqual([]);
    }
    expect(q.crashReports, `quit ${q.round}: Windows Error Reporting ran for a crash on the way out`).toEqual([]);
    expect(q.shellsAlive, `quit ${q.round}: a terminal outlived the quit`).toEqual([]);
    expect(q.shellPids, `quit ${q.round}: six terminals running at the quit`).toHaveLength(6);
    expect(q.profileRemoved, `quit ${q.round}: the profile was still held`).toBe('yes');
  }
});
