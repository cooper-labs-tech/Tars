import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * One heavy-run slot for the whole machine (2.0.5, lot 2 item A, the owner's go of 28/10), in the real app: every
 * project's agents take it in turn, by `tars-slot run -- <command>` in their own terminals, as a git hook would.
 *
 * Three agents of two projects: a and the orchestrator o in harbor, b in meridian. Each one's CLI is a stand-in that
 * runs `tars-slot run` from its terminal (the shim in ~/.tars/bin, on the terminal's PATH), whose command writes a
 * file with its pid once it runs.
 *
 * Asserted, once with the classic shell and once with the new interface:
 * 1. a holds the slot (its ceiling set to 1: #573 made it 3 when unset); b, of another project, waits, and the window
 *    reads why: held by a, at most 1 run at once;
 * 2. o asks for a release gate after b: o waits first, b second (priority before arrival);
 * 3. a's `tars-slot` is killed (SIGKILL, no give-back): the lease goes with its process, and o is granted, not b;
 * 4. o's command ends: o's `tars-slot` gives the slot back, and b is granted;
 * 5. (a second launch) the disk floor set above any disk: a's ask waits, and says the floor and the figure.
 * And from the Audit's gate of #537 (a third launch):
 * 6. (M1) ~/.tars/bin is last on the agent terminal's PATH, and TARS_SLOT names the shim, which runs without it;
 * 7. (M2) a lease taken for the turn, as heavy_slot_take takes it (held by the CLI), goes back when the agent's turn
 *    ends (its Stop's idle), and the waiter behind it is granted; the window's give-back ends the next lease, and
 *    the day's alerts say both;
 * 8. (L2) a token in the label is masked in the queue every agent reads.
 * Red on main dc623b59: there is no tars-slot, and no command ever runs.
 * The artefact: values.json (the slot's status at each step), screenshots, the app's trace with E2E_TRACE=on.
 */

type SlotTicket = { id: string; state: string; position?: number; why?: string; agentId: string; label: string; priority: string };
type SlotStatus = {
  slots: number; floors: { diskGb: number; memFreePct: number };
  machine: { at: string; memFreePct: number | null; swapUsedMb: number | null; diskFreeGb: number | null; load1: number | null } | null;
  holders: Array<SlotTicket & { pid: number; tree?: { processes: number; memoryMb: number; cpuPct: number } }>;
  waiting: SlotTicket[];
  alerts: Array<{ at: string; text: string; sentTo: string[] }>;
};
type Agent = { id: string; cliRunning?: boolean };
type Api = { electronAPI: {
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; list(): Promise<Agent[]> };
  heavySlot: { status(): Promise<SlotStatus>; giveBack(id: string): Promise<boolean> };
} };

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A stand-in CLI that runs `tars-slot run` from its terminal, as an agent's git hook would. */
function standIn(home: string, name: string, slotArgs: string[], holdMs?: number): string {
  const hold = path.join(home, 'hold.cjs');
  if (!fs.existsSync(hold)) {
    fs.writeFileSync(hold, [
      "const [name, file, ms] = process.argv.slice(2);",
      "require('fs').writeFileSync(file, String(process.pid));",
      "if (ms) setTimeout(() => process.exit(0), Number(ms)); else setInterval(() => {}, 1 << 30);",
      '',
    ].join('\n'));
  }
  const cli = path.join(home, `cli-${name}.cjs`);
  const command = [process.execPath, hold, name, path.join(home, `started-${name}`), ...(holdMs ? [String(holdMs)] : [])];
  fs.writeFileSync(cli, [
    `#!${process.execPath}`,
    "const { spawn } = require('child_process');",
    `const slot = spawn('tars-slot', ${JSON.stringify(['run', ...slotArgs, '--', ...command])}, { stdio: ['ignore', 'ignore', 'pipe'] });`,
    `slot.stderr.on('data', d => require('fs').appendFileSync(${JSON.stringify(path.join(home, `slot-${name}.log`))}, d));`,
    `slot.on('error', e => require('fs').appendFileSync(${JSON.stringify(path.join(home, `slot-${name}.log`))}, String(e)));`,
    `require('fs').writeFileSync(${JSON.stringify(path.join(home, `slot-${name}.pid`))}, String(slot.pid));`,
    "process.stdout.write('stand-in ready\\n');",
    'process.stdin.resume();',
    '',
  ].join('\n'), { mode: 0o755 });
  return cli;
}

async function launch(home: string, port: string, newInterface: boolean): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  const page = await app.firstWindow();
  await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
  await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
  return { app, page };
}

/**
 * A stand-in CLI that holds the slot for its turn, as heavy_slot_take does (its own pid, untilTurnEnds), then ends the
 * turn (the Stop's idle) when the spec writes `end-turn`. It records its terminal's PATH and TARS_SLOT.
 */
function turnHolder(home: string, label: string): string {
  const cli = path.join(home, 'cli-turn.cjs');
  fs.writeFileSync(cli, [
    `#!${process.execPath}`,
    "const fs = require('fs'); const crypto = require('crypto');",
    "const session = crypto.randomUUID();",
    `const dir = ${JSON.stringify(home)};`,
    "const post = (route, body) => fetch(process.env.CLAUDE_MGR_API_URL + route, { method: 'POST',",
    "  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN },",
    "  body: JSON.stringify({ agent_id: process.env.CLAUDE_AGENT_ID, session_id: session, ...body }) }).then(r => r.json());",
    "fs.writeFileSync(dir + '/env-turn.json', JSON.stringify({ PATH: process.env.PATH, TARS_SLOT: process.env.TARS_SLOT }));",
    "(async () => {",
    "  await post('/api/hooks/status', { status: 'idle', source: 'startup' });",
    "  await post('/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: 'run the suite' });",
    `  const asked = await post('/api/heavy-slot/ask', { pid: process.pid, untilTurnEnds: true, label: ${JSON.stringify(label)} });`,
    "  fs.writeFileSync(dir + '/ask-turn.json', JSON.stringify(asked));",
    "  const end = setInterval(async () => {",
    "    if (!fs.existsSync(dir + '/end-turn')) return;",
    "    clearInterval(end);",
    "    await post('/api/hooks/status', { status: 'idle' });",
    "    fs.writeFileSync(dir + '/turn-ended', '1');",
    "  }, 200);",
    "})();",
    "process.stdout.write('stand-in ready\\n');",
    'process.stdin.resume();',
    '',
  ].join('\n'), { mode: 0o755 });
  return cli;
}

function seed(home: string, newInterface: boolean, agents: Array<{ id: string; name: string; role: string; project: string; cli: string }>, settings: Record<string, unknown> = {}) {
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  const projects = [...new Set(agents.map(a => a.project))];
  for (const p of projects) fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents.map(a => ({
    id: a.id, name: a.name, character: 'robot', provider: 'claude', status: 'idle', role: a.role,
    projectPath: a.project, skills: [], cliPath: a.cli,
    createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z',
  })), null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface, ...settings }));
}

test.skip(process.platform === 'win32', 'the stand-ins start `tars-slot` through the POSIX shim; the Windows shim (tars-slot.cmd) is written and unit-read, not driven here');

for (const newInterface of [false, true]) {
  test(`agents of two projects take the heavy-run slot in turn: priority, and a killed holder gives it back${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-heavy-${newInterface ? 'ni' : 'classic'}-`));
    const harbor = path.join(home, 'projects', 'harbor');
    const meridian = path.join(home, 'projects', 'meridian');
    seed(home, newInterface, [
      { id: 'a', name: 'Harbor Worker', role: 'worker', project: harbor, cli: standIn(home, 'a', ['--label', 'harbor e2e suite']) },
      { id: 'b', name: 'Meridian Worker', role: 'worker', project: meridian, cli: standIn(home, 'b', ['--label', 'meridian build']) },
      { id: 'o', name: 'Harbor Lead', role: 'orchestrator', project: harbor, cli: standIn(home, 'o', ['--priority', 'gate', '--label', 'harbor release gate'], 1_500) },
    // Since #573 heavySlots is a ceiling, 3 when unset, and a further run waits for the last one to settle: the order
    // and the hand-over asked here are those of a full slot, so the ceiling is 1.
    ], { heavySlots: 1 });
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const started = (name: string) => fs.existsSync(path.join(home, `started-${name}`));
    const pidOf = (file: string) => Number(fs.readFileSync(path.join(home, file), 'utf8'));
    const { app, page } = await launch(home, apiPort(newInterface ? 31348 : 31347), newInterface);
    const status = () => page.evaluate(() => (window as unknown as Api).electronAPI.heavySlot.status());
    const start = (id: string) => page.evaluate(i => (window as unknown as Api).electronAPI.agent.start({ id: i, prompt: '' }), id);
    try {
      // 1. a holds it; b, of another project, waits behind it.
      await start('a');
      await expect.poll(() => started('a'), { timeout: 30_000 }).toBe(true);
      await start('b');
      await expect.poll(async () => (await status()).waiting.map(t => t.agentId), { timeout: 30_000 }).toEqual(['b']);
      const one = await status();
      keep({ one });
      expect.soft(one.holders.map(t => [t.agentId, t.label])).toEqual([['a', 'harbor e2e suite']]);
      expect.soft(one.waiting[0].why).toMatch(/^held by Harbor Worker \(harbor e2e suite\).*; at most 1 run at once$/);
      // What the window's Resources page reads in one call (the Frontend's notes of #535): the settings, the machine,
      // each holder's pid and its tree, the day's alerts.
      expect.soft([one.slots, one.floors]).toEqual([1, { diskGb: 15, memFreePct: 20 }]);
      expect.soft(one.machine?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect.soft(one.holders[0].pid).toBe(pidOf('slot-a.pid'));
      // Its tree: tars-slot and the command under it, read from ps (at most every 2 s, so polled).
      await expect.poll(async () => (await status()).holders[0]?.tree?.processes ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
      expect.soft((await status()).holders[0].tree?.memoryMb ?? 0).toBeGreaterThan(0);
      expect.soft(one.alerts).toEqual([]);

      // 2. o asks for a release gate after b: o first.
      await start('o');
      await expect.poll(async () => (await status()).waiting.map(t => t.agentId), { timeout: 30_000 }).toEqual(['o', 'b']);
      const two = await status();
      keep({ two });
      expect.soft(two.waiting.map(t => [t.agentId, t.priority, t.position])).toEqual([['o', 'gate', 1], ['b', 'normal', 2]]);
      await stepShot(page, newInterface ? 'heavy-slot-queue-new-interface' : 'heavy-slot-queue');

      // 3. a's tars-slot killed, no give-back: the lease goes with it, and o is granted, not b.
      process.kill(pidOf('slot-a.pid'), 'SIGKILL');
      await expect.poll(() => started('o'), { timeout: 15_000 }).toBe(true);
      const three = await status();
      keep({ three, bStartedWithO: started('b') });
      expect.soft(three.holders.map(t => t.agentId)).toEqual(['o']);
      expect.soft(started('b'), 'b ran beside o').toBe(false);

      // 4. o's command ends: its tars-slot gives the slot back, and b is granted.
      await expect.poll(() => started('b'), { timeout: 15_000 }).toBe(true);
      const four = await status();
      keep({ four, logs: Object.fromEntries(['a', 'b', 'o'].map(n => [n, fs.existsSync(path.join(home, `slot-${n}.log`)) ? fs.readFileSync(path.join(home, `slot-${n}.log`), 'utf8') : ''])) });
      expect.soft(four.holders.map(t => t.agentId)).toEqual(['b']);
      expect.soft(four.waiting).toEqual([]);
    } finally {
      for (const name of ['a', 'b', 'o']) {
        for (const file of [`started-${name}`, `slot-${name}.pid`]) {
          try { const pid = pidOf(file); if (alive(pid)) process.kill(pid, 'SIGKILL'); } catch { /* none */ }
        }
      }
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });

  test(`a heavy run waits under the disk floor, and says the floor and the figure${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-heavy-floor-${newInterface ? 'ni' : 'classic'}-`));
    const harbor = path.join(home, 'projects', 'harbor');
    seed(home, newInterface, [
      { id: 'a', name: 'Harbor Worker', role: 'worker', project: harbor, cli: standIn(home, 'a', ['--label', 'harbor e2e suite']) },
    ], { heavySlotMinDiskGb: 1_000_000 });
    const { app, page } = await launch(home, apiPort(newInterface ? 31350 : 31349), newInterface);
    const status = () => page.evaluate(() => (window as unknown as Api).electronAPI.heavySlot.status());
    try {
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'a', prompt: '' }));
      await expect.poll(async () => (await status()).waiting[0]?.why ?? '', { timeout: 30_000 }).toMatch(/^waiting for free disk: [\d.]+ GB free, the floor is 1000000 GB$/);
      await page.waitForTimeout(2_000);
      const waited = await status();
      recordValues({ newInterface, waited, started: fs.existsSync(path.join(home, 'started-a')) });
      expect.soft(waited.holders).toEqual([]);
      expect.soft(fs.existsSync(path.join(home, 'started-a')), 'the command ran under the floor').toBe(false);
    } finally {
      try { const pid = Number(fs.readFileSync(path.join(home, 'slot-a.pid'), 'utf8')); if (alive(pid)) process.kill(pid, 'SIGKILL'); } catch { /* none */ }
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });

  test(`a lease taken for the turn goes back when the turn ends, the window gives one back, and the label is masked${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-heavy-turn-${newInterface ? 'ni' : 'classic'}-`));
    const harbor = path.join(home, 'projects', 'harbor');
    const token = ['ghp_', 'E'.repeat(12), 'F'.repeat(12)].join('');
    seed(home, newInterface, [
      { id: 't', name: 'Harbor Worker', role: 'worker', project: harbor, cli: turnHolder(home, `pytest -k smoke --token ${token}`) },
      { id: 'w', name: 'Harbor Tester', role: 'worker', project: harbor, cli: standIn(home, 'w', ['--label', 'harbor e2e suite']) },
    ]);
    const { app, page } = await launch(home, apiPort(newInterface ? 31352 : 31351), newInterface);
    const status = () => page.evaluate(() => (window as unknown as Api).electronAPI.heavySlot.status());
    const start = (id: string) => page.evaluate(i => (window as unknown as Api).electronAPI.agent.start({ id: i, prompt: '' }), id);
    const values: Record<string, unknown> = { newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    try {
      // 6. The terminal's PATH: ~/.tars/bin last; TARS_SLOT names the shim.
      await start('t');
      await expect.poll(async () => (await status()).holders.map(h => h.agentId), { timeout: 30_000 }).toEqual(['t']);
      const env = JSON.parse(fs.readFileSync(path.join(home, 'env-turn.json'), 'utf8')) as { PATH: string; TARS_SLOT: string };
      const bin = path.join(home, '.tars', 'bin');
      const parts = env.PATH.split(':');
      keep({ env, ask: JSON.parse(fs.readFileSync(path.join(home, 'ask-turn.json'), 'utf8')) });
      expect.soft(parts.indexOf(bin), 'bin on the PATH').toBeGreaterThan(0);
      expect.soft(parts.indexOf(bin), 'bin last').toBe(parts.length - 1);
      expect.soft(env.TARS_SLOT).toBe(path.join(bin, 'tars-slot'));

      // 8. The label every agent reads is masked.
      const held = await status();
      keep({ held });
      expect.soft(held.holders[0].label).not.toContain(token);
      expect.soft(held.holders[0].label).toMatch(/^pytest -k smoke --token ghp_/);

      // 7. w waits behind t; t's turn ends: its lease goes back, and w is granted.
      await start('w');
      await expect.poll(async () => (await status()).waiting.map(t => t.agentId), { timeout: 30_000 }).toEqual(['w']);
      fs.writeFileSync(path.join(home, 'end-turn'), '1');
      await expect.poll(() => fs.existsSync(path.join(home, 'started-w')), { timeout: 15_000 }).toBe(true);
      const after = await status();
      keep({ after });
      expect.soft(after.holders.map(h => h.agentId)).toEqual(['w']);
      expect.soft(after.alerts.map(a => a.text)).toEqual([expect.stringMatching(/^The heavy-run slot: Harbor Worker's lease .* was given back: its turn ended/)]);

      // The owner gives w's lease back from the window: the queue is empty, and the alert says so.
      expect(await page.evaluate(id => (window as unknown as Api).electronAPI.heavySlot.giveBack(id), after.holders[0].id)).toBe(true);
      await expect.poll(async () => (await status()).holders.length, { timeout: 10_000 }).toBe(0);
      const given = await status();
      keep({ given });
      expect.soft(given.alerts.at(-1)?.text).toMatch(/Harbor Tester's lease \(harbor e2e suite\) was given back: the owner gave it back from the window/);
      await stepShot(page, newInterface ? 'heavy-slot-turn-new-interface' : 'heavy-slot-turn');
    } finally {
      for (const file of ['started-w', 'slot-w.pid']) {
        try { const pid = Number(fs.readFileSync(path.join(home, file), 'utf8')); if (alive(pid)) process.kill(pid, 'SIGKILL'); } catch { /* none */ }
      }
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
