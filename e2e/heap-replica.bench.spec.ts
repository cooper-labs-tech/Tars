import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { copyFromRealHome, launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A bench, not a test of the product (the crash of 2026-10-13 00:26): the main
 * process's heap with the machine's own data, in a sandbox.
 *
 * The sandbox's ~/.claude/projects is an APFS clone of the real one (written
 * blocks only are new), its agents.json a copy of the real fleet's (45 agents,
 * none started), and the window shows the Agents page, which builds the agent
 * list twice a second and asks claude:getData every 10 s. The ten largest
 * transcripts grow by one usage line every 5 s each, as live sessions do.
 * HEAP_REPLICA_MINUTES sets the length (default 10). Nothing of the real home
 * is written: the clone and the copy live in the sandbox, removed at the end.
 *
 * Out of every suite (playwright.config.ts): run on purpose with
 * `HEAP_HUNT_OUT=<dir> TARS_HEAP_BENCH=1 npx playwright test --project=bench e2e/heap-replica.bench.spec.ts`.
 */

/** Where the samples go: HEAP_HUNT_OUT, else this run's own output folder. */
const outDir = () => process.env.HEAP_HUNT_OUT ?? test.info().outputPath();
const MINUTES = Number(process.env.HEAP_REPLICA_MINUTES ?? 10);
const REAL_HOME = process.env.HEAP_REPLICA_FROM ?? os.homedir();

test('the main process heap with the machine\'s own transcripts and fleet', async () => {
  test.skip(process.env.TARS_HEAP_BENCH !== '1', 'a bench: TARS_HEAP_BENCH=1 and --project=bench');
  test.skip(process.platform !== 'darwin', 'the clone is an APFS clone (cp -c)');
  test.skip(!fs.existsSync(path.join(REAL_HOME, '.tars', 'agents.json')) || !fs.existsSync(path.join(REAL_HOME, '.claude', 'projects')), 'no fleet or no transcripts to replicate');
  test.setTimeout((MINUTES + 8) * 60_000);
  const OUT = outDir();
  fs.mkdirSync(OUT, { recursive: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-heap-replica-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    copyFromRealHome(path.join(REAL_HOME, '.claude', 'projects'), path.join(home, '.claude', 'projects'));
    const dir = path.join(home, '.tars');
    fs.mkdirSync(dir, { recursive: true });
    const real = JSON.parse(fs.readFileSync(path.join(REAL_HOME, '.tars', 'agents.json'), 'utf8'));
    const list = (Array.isArray(real) ? real : real.agents) as Array<Record<string, unknown>>;
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(list.map((a) => ({ ...a, status: 'idle', cliPath: '/usr/bin/false' })), null, 2));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
    const transcripts = (execFileSync('/usr/bin/find', [path.join(home, '.claude', 'projects'), '-name', '*.jsonl', '-size', '+10M'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean))
      .map((f) => ({ f, size: fs.statSync(f).size })).sort((a, b) => b.size - a.size).slice(0, 10).map((x) => x.f);
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
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31456), DOROTHY_E2E: '1' },
    });
    const samples: Array<Record<string, number>> = [];
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      const t0 = Date.now();
      for (let s = 0; s <= MINUTES * 2; s += 1) {
        const m = await app.evaluate(() => process.memoryUsage());
        samples.push({ t: Math.round((Date.now() - t0) / 1000), heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, rss: m.rss });
        fs.writeFileSync(path.join(OUT, 'samples.json'), JSON.stringify(samples, null, 1));
        if (s < MINUTES * 2) await page.waitForTimeout(30_000);
      }
      recordValues({ samples, transcripts: transcripts.map((f) => path.basename(f)), agents: list.length });
      expect(samples.length).toBeGreaterThan(4);
    } finally {
      clearInterval(grow);
      await app.close();
    }
  } finally {
    await removeHome(home);
  }
});
