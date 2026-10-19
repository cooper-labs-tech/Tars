import { expect, test, _electron as electron, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { linksLeaving } from './home-links.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * How fast the Usage page shows on real data (t-10b17f1c, the maintainer's request of 18/10). A measurement, not a
 * test of behaviour, run only on purpose (TARS_HEAP_BENCH=1, --project=bench, as the heap benches), and skipped unless
 * E2E_USAGE_REAL_HOME names a home prepared from a machine's data as APFS clones
 * (the bench's prepare-real-home.sh: never the live files) and E2E_IPC_TIMER the main-process timer that
 * NODE_OPTIONS loads (the bench's ipc-timer.cjs). Each launch runs on its own clone of that home, removed after, and
 * not before every link in the clone is seen to stay inside it, whatever its spelling (e2e/home-links.mjs): a Claude
 * account folder's links to the live ~/.claude, copied as they are, let the bench of 18/10 run two measures with the
 * live folders in reach (the Audit's L1 on #467). The bench refuses to start on such a clone, and says which links.
 *
 * Recorded into values.json, times and sizes only, never what the data says:
 * - when each card first showed, from the page's load: cold (the app starts on the Usage page, nothing read yet),
 *   reload (the window's store gone, the main process's one-minute caches warm), back (the Usage link clicked from
 *   Agents, everything warm);
 * - every IPC call the Usage page made meanwhile: channel, milliseconds in the main process, bytes returned;
 * - each of the page's calls made again from the window and timed there (the main process plus the transfer);
 * - how many agents, tasks and models the data holds over the default timeframe.
 *
 * And one rule it holds the page to, cold: the tasks' reading (usage:tasks) is asked once the transcripts' figures
 * (claude:getData) have answered, never beside their first scan. Asked together (86ce2fed), the two readings shared the
 * main process's one thread and slowed each other: the scan took 36.5 and 46.7 s instead of 20.4 and 21.7, and the
 * figures showed 16 to 20 s later than before the change.
 */

const REAL = process.env.E2E_USAGE_REAL_HOME ?? '';
const TIMER = process.env.E2E_IPC_TIMER ?? '';
const CARDS = ['header', 'stats', 'budget', 'byProvider', 'costChart', 'tasks', 'averages'] as const;
type Card = (typeof CARDS)[number];

/** Which cards show, read the same way on the page before and after t-10b17f1c. */
function probe(): Record<string, boolean> {
  const panelOf = (caption: RegExp): HTMLElement | null => {
    const leaf = Array.from(document.querySelectorAll('div')).find((e) => e.children.length === 0 && caption.test((e.textContent ?? '').trim()));
    return (leaf?.closest('.border') as HTMLElement | null) ?? null;
  };
  const loaded = (el: Element | null) => !!el && !el.querySelector('[data-loading]');
  const stats = panelOf(/^TOTAL COST$/);
  const chart = panelOf(/^(HOURLY|DAILY|WEEKLY|MONTHLY) COST ·/);
  const tasks = document.querySelector('[data-tasks-panel]');
  return {
    header: document.querySelector('h1')?.textContent?.trim() === 'Usage',
    stats: loaded(stats) && /\$\d/.test(stats?.textContent ?? ''),
    budget: /Budget & limits|No provider has reported a limit/.test(document.body.innerText),
    byProvider: loaded(panelOf(/^BY PROVIDER ·/)),
    costChart: loaded(chart) && !!chart?.querySelector('[style*="height"]'),
    tasks: loaded(tasks) && !(tasks?.textContent ?? '').includes('Reading the transcripts of the tasks'),
    averages: !!document.querySelector('[data-task-averages="agent"] [data-average-row]'),
  };
}

/** The time each card first showed, in ms from t0, polled every 25 ms for three minutes at most. */
async function watch(page: Page, t0: number): Promise<Record<Card, number | null>> {
  const shown = Object.fromEntries(CARDS.map((card) => [card, null])) as Record<Card, number | null>;
  const end = Date.now() + 180_000;
  while (Date.now() < end && CARDS.some((card) => shown[card] === null)) {
    let flags: Record<string, boolean> = {};
    try { flags = await page.evaluate(probe); } catch { /* the page is loading */ }
    const now = Date.now();
    for (const card of CARDS) if (shown[card] === null && flags[card]) shown[card] = now - t0;
    await page.waitForTimeout(25);
  }
  return shown;
}

type Call = { channel: string; at: number; ms: number; bytes: number | null; failed: boolean; page: string };

/** The Usage page's calls between two moments: the timer's log, and what a late timer kept in the main process. */
function callsBetween(logged: Call[], from: number, to: number): Call[] {
  return logged.filter((c) => c.at >= from && c.at <= to && c.page.startsWith('/usage')).map((c) => ({ ...c, at: c.at - from }));
}

test('the Usage page on real data: when each card shows, and every call it makes', async () => {
  test.skip(!REAL || !TIMER, 'a measurement on a prepared clone of real data: E2E_USAGE_REAL_HOME and E2E_IPC_TIMER');
  test.setTimeout(900_000);
  const runs: unknown[] = [];
  for (let run = 1; run <= 2; run++) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-usage-speed-'));
    const home = path.join(base, 'home');
    execFileSync('cp', ['-cR', REAL, home]);
    // Nothing is launched on a clone with a way out: every link stays inside it, or the bench stops here.
    const leaving = linksLeaving(home);
    if (leaving.length > 0) await removeHome(base);
    expect(leaving, `links of the clone of ${REAL} that lead out of it: the bench refuses to run on it`).toEqual([]);
    const times = path.join(base, 'ipc-times.jsonl');
    const launched = Date.now();
    const app = await launchSandboxed(electron, home, {
      env: {
        NODE_ENV: 'development',
        DOROTHY_DEV_URL: `${DEV_URL}/usage`,
        DOROTHY_API_PORT: apiPort(31505),
        DOROTHY_E2E: '1',
        NODE_OPTIONS: `--require ${TIMER}`,
        TARS_IPC_TIMES: times,
      },
    });
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      const scenarios: Record<string, unknown> = {};
      // The timer is NODE_OPTIONS's: should Electron not take it, the handlers are timed from here on instead, around
      // themselves (as usage-replica.bench.spec.ts), and the cold scenario misses the calls made before.
      const early = await app.evaluate(() => (globalThis as unknown as { __tarsIpcTimer?: boolean }).__tarsIpcTimer === true);
      if (!early) {
        await app.evaluate(({ ipcMain }) => {
          const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
          const g = globalThis as unknown as { __tarsCalls: unknown[] };
          g.__tarsCalls = [];
          for (const [channel, original] of [...handlers]) {
            handlers.set(channel, async (...args: unknown[]) => {
              const at = Date.now();
              const result = await original(...args);
              let page = '';
              try { page = (args[0] as { sender: { getURL(): string } }).sender.getURL().replace(/^https?:\/\/[^/]+/, ''); } catch { /* gone */ }
              let bytes: number | null = null;
              try { bytes = JSON.stringify(result ?? null).length; } catch { /* not JSON */ }
              g.__tarsCalls.push({ channel, at, ms: Date.now() - at, bytes, failed: false, page });
              return result;
            });
          }
        });
      }
      scenarios.timer = early ? 'NODE_OPTIONS, from launch' : 'around the handlers, from after the first load';
      const logged = async (): Promise<Call[]> => [
        ...(fs.existsSync(times) ? fs.readFileSync(times, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Call) : []),
        ...(early ? [] : await app.evaluate(() => (globalThis as unknown as { __tarsCalls: Call[] }).__tarsCalls)),
      ];

      const t0 = await page.evaluate(() => performance.timeOrigin);
      const cold = await watch(page, t0);
      const coldCalls = callsBetween(await logged(), t0, Date.now());
      const figures = coldCalls.find((c) => c.channel === 'claude:getData');
      const tasksAsked = coldCalls.find((c) => c.channel === 'usage:tasks');
      const tasksAfterFigures = !!figures && !!tasksAsked && tasksAsked.at >= figures.at + figures.ms;
      scenarios.cold = { fromLaunchMs: Math.round(t0 - launched), shown: cold, calls: coldCalls, tasksAfterFigures };
      expect.soft(tasksAfterFigures, 'cold, usage:tasks is asked once claude:getData has answered').toBe(true);

      await page.reload({ waitUntil: 'domcontentloaded' });
      const t1 = await page.evaluate(() => performance.timeOrigin);
      scenarios.reload = { shown: await watch(page, t1), calls: callsBetween(await logged(), t1, Date.now()) };

      await page.getByRole('link', { name: 'Agents', exact: true }).first().click();
      await page.waitForTimeout(3_000);
      const t2 = Date.now();
      await page.getByRole('link', { name: 'Usage', exact: true }).first().click();
      scenarios.back = { shown: await watch(page, t2), calls: callsBetween(await logged(), t2, Date.now()) };

      // Each of the page's calls again, timed from the window: twice, the second warm.
      scenarios.fromWindow = await page.evaluate(async () => {
        const api = (window as unknown as { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> }).electronAPI;
        const time = async (name: string, call: () => Promise<unknown>) => {
          const t = performance.now();
          const answer = await call();
          return { name, ms: Math.round((performance.now() - t) * 10) / 10, chars: JSON.stringify(answer ?? null).length };
        };
        const out = [];
        for (let i = 0; i < 2; i++) {
          out.push(await time('claude.getData', () => api.claude.getData()));
          out.push(await time('usage.byProvider', () => api.usage.byProvider()));
          out.push(await time('usage.tasks', () => api.usage.tasks({ sinceDays: 14 })));
          out.push(await time('appSettings.get', () => api.appSettings.get()));
          out.push(await time('cliPaths.detect', () => api.cliPaths.detect()));
        }
        return out;
      });

      // How much the data holds over the default timeframe (14 days): counts, no names.
      scenarios.data = await page.evaluate(async () => {
        type Task = { agentId: string; byModel?: Record<string, number>; model?: string | null; provider?: string | null };
        const api = (window as unknown as { electronAPI: { usage: { tasks(q: { sinceDays: number }): Promise<{ tasks: Task[] }> } } }).electronAPI;
        const report = await api.usage.tasks({ sinceDays: 14 });
        // As Average per model groups them: each task under the model it spent most on (task-costs.ts dominantModel).
        const dominant = (t: Task) => {
          let best: string | null = null;
          for (const [model, cost] of Object.entries(t.byModel ?? {})) if (best === null || cost > (t.byModel ?? {})[best]) best = model;
          return best ?? t.model ?? t.provider ?? 'claude';
        };
        const models = new Set(report.tasks.map(dominant));
        return { tasks: report.tasks.length, agents: new Set(report.tasks.map((t) => t.agentId)).size, models: models.size };
      });
      runs.push({ run, ...scenarios });
      recordValues({ runs });
    } finally {
      await app.close();
      await removeHome(base);
    }
  }
});
