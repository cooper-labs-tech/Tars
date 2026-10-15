import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A bench, not a test of the product (JeanBrasse, 2026-10-13: "la page 'usage' galère à se mettre à jour quand il y a
 * beaucoup d'agents et projets en même temps, l'autre fois ça a mis un temps à s'update, et après ça a fait planter
 * l'app"): the Usage page with the machine's own data, in a sandbox.
 *
 * As heap-replica.bench.spec.ts: the sandbox's ~/.claude/projects is an APFS clone of the real one, its agents.json
 * a copy of the real fleet's (none started), and the ten largest transcripts grow by one usage line every 5 s each.
 * The window shows Usage, and two more windows show Agents and Projects, as they poll beside it. Measured:
 * - how long Usage takes from its opening to its numbers (its "Still adding up" state gone);
 * - each claude:getData, usage:by-provider and usage:tasks answer (the cost of each task, which the page asks again
 *   at each new figure), timed in the main process around its handler;
 * - the main process's heap, and each window's renderer heap, every 30 s.
 * USAGE_BENCH_MINUTES sets the length (default 10). Self-contained, so the same file runs on the 1.9.5 tag. Nothing
 * of the real home is written. Run on purpose: `USAGE_BENCH=1 TARS_HEAP_BENCH=1 npx playwright test --project=bench
 * e2e/usage-replica.bench.spec.ts` (on 1.9.5, without --project).
 */

const MINUTES = Number(process.env.USAGE_BENCH_MINUTES ?? 10);
const REAL_HOME = process.env.HEAP_REPLICA_FROM ?? os.homedir();
const OUT = () => process.env.USAGE_BENCH_OUT ?? test.info().outputPath();

test('the Usage page with the machine\'s own transcripts and fleet, Agents and Projects beside it', async () => {
  test.skip(process.env.USAGE_BENCH !== '1', 'a bench: USAGE_BENCH=1');
  test.skip(process.platform !== 'darwin', 'the clone is an APFS clone (cp -c)');
  test.setTimeout((MINUTES + 10) * 60_000);
  const out = OUT();
  fs.mkdirSync(out, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-usage-bench-'));
  const dist = path.resolve('electron', 'dist');
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    execFileSync('/bin/cp', ['-c', '-R', path.join(REAL_HOME, '.claude', 'projects'), path.join(home, '.claude', 'projects')]);
    const dir = path.join(home, '.dorothy');
    fs.mkdirSync(dir, { recursive: true });
    const real = JSON.parse(fs.readFileSync(path.join(REAL_HOME, '.dorothy', 'agents.json'), 'utf8'));
    const list = (Array.isArray(real) ? real : real.agents) as Array<Record<string, unknown>>;
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(list.map((a) => ({ ...a, status: 'idle', cliPath: '/usr/bin/false' })), null, 2));
    const projects = [...new Set(list.map((a) => a.projectPath as string).filter(Boolean))];
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects));
    // What the page reads beside the transcripts: the usage ledger, the status line's stats, and the task ledger
    // (the cost of each task, #311) with its texts.
    for (const f of ['usage-ledger.json', 'token-stats.json', 'task-ledger.jsonl']) {
      const from = path.join(REAL_HOME, '.dorothy', f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, f));
    }
    const texts = path.join(REAL_HOME, '.tars-private', 'task-texts.jsonl');
    if (fs.existsSync(texts)) {
      fs.mkdirSync(path.join(home, '.tars-private'), { recursive: true, mode: 0o700 });
      fs.copyFileSync(texts, path.join(home, '.tars-private', 'task-texts.jsonl'));
    }
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
    const transcripts = (execFileSync('/usr/bin/find', [path.join(home, '.claude', 'projects'), '-name', '*.jsonl', '-size', '+10M'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean))
      .map((f) => ({ f, size: fs.statSync(f).size })).sort((a, b) => b.size - a.size).slice(0, 10).map((x) => x.f);
    const projectBytes = Number(execFileSync('/usr/bin/du', ['-sk', path.join(home, '.claude', 'projects')], { encoding: 'utf8' }).split('\t')[0]) * 1024;
    let n = 0;
    const grow = setInterval(() => {
      for (const f of transcripts) {
        n += 1;
        fs.appendFileSync(f, JSON.stringify({ type: 'assistant', requestId: `bench_${n}`, timestamp: new Date().toISOString(),
          message: { id: `bench_msg_${n}`, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1500) }],
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } }) + '\n');
      }
    }, 5_000);

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31435), DOROTHY_E2E: '1' },
    });
    const samples: Array<Record<string, unknown>> = [];
    const values: Record<string, unknown> = { agents: list.length, projects: projects.length, projectBytes, transcripts: transcripts.map((f) => path.basename(f)) };
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded');
      // Each answer of the two handlers the page reads, timed around the handler itself.
      await app.evaluate(({ ipcMain }) => {
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
        const g = globalThis as unknown as { __usageBench: Array<{ channel: string; at: number; ms: number; bytes: number }> };
        g.__usageBench = [];
        for (const channel of ['claude:getData', 'usage:by-provider', 'usage:tasks']) {
          const original = handlers.get(channel);
          if (!original) continue;
          handlers.set(channel, async (...args: unknown[]) => {
            const at = Date.now();
            const result = await original(...args);
            let bytes = -1;
            try { bytes = JSON.stringify(result)?.length ?? 0; } catch { /* not serialisable */ }
            g.__usageBench.push({ channel, at, ms: Date.now() - at, bytes });
            return result;
          });
        }
      });
      // Agents and Projects beside it, as their own windows poll.
      await app.evaluate(({ BrowserWindow }, { dist, url }) => {
        for (const route of ['agents', 'projects']) {
          const w = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { preload: `${dist}/preload.js`, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
          void w.loadURL(`${url}/${route}`);
        }
      }, { dist, url: DEV_URL });

      const opened = Date.now();
      await page.goto(`${DEV_URL}/usage`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !document.body.innerText.includes('Still adding up') && document.body.innerText.includes('$'), undefined, { timeout: 15 * 60_000, polling: 250 });
      values.toNumbersMs = Date.now() - opened;
      recordValues(values);

      const t0 = Date.now();
      for (let s = 0; s <= MINUTES * 2; s += 1) {
        const main = await app.evaluate(() => process.memoryUsage());
        const renderers = await Promise.all(app.windows().map(async (w) => ({
          url: w.url().replace(DEV_URL, ''),
          heap: await w.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null).catch(() => null),
        })));
        const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, kb: m.memory.workingSetSize })));
        samples.push({ t: Math.round((Date.now() - t0) / 1000), mainHeapUsed: main.heapUsed, mainHeapTotal: main.heapTotal, rss: main.rss, renderers, metrics });
        fs.writeFileSync(path.join(out, 'samples.json'), JSON.stringify(samples, null, 1));
        if (s < MINUTES * 2) await page.waitForTimeout(30_000);
      }
      const calls = await app.evaluate(() => (globalThis as unknown as { __usageBench: unknown[] }).__usageBench);
      values.calls = calls;
      values.samples = samples;
      fs.writeFileSync(path.join(out, 'calls.json'), JSON.stringify(calls, null, 1));
      recordValues(values);
      expect(samples.length).toBeGreaterThan(4);
    } finally {
      clearInterval(grow);
      await app.close();
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
