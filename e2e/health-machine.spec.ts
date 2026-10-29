import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The machine's memory and disk, and each agent's, on Tars's own health samples (2.0.5, services/health/machine.ts):
 * the data the shared heavy-run slot and the per-agent view will read. No window shows them in this lot.
 *
 * In the real app, in a sandbox sampled every 500 ms (DOROTHY_HEALTH_EVERY_MS), with one agent on a stand-in CLI
 * that starts a child of its own. Asserted, with the classic shell and with the new interface, on a sample of
 * ~/.tars/health-samples.jsonl:
 * 1. the machine: free memory, disk free and the cost of the read are numbers; on macOS the free share, the
 *    compressor and the swap too, on Linux the swap; a second sample has the swap's growth per minute;
 * 2. the agent's whole tree: its terminal, the CLI and its child, three processes at least, weighed in MB, by RSS
 *    on macOS and PSS on Linux.
 * Red on main (dc623b59): a sample holds neither.
 * The artefact: values.json (the last two samples as written).
 */

type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } };
type Sample = { at: number; machine?: Record<string, number | null>; agentTrees?: { measure: string; trees: Array<{ id?: string; processes: number; mb: number }> } | null };

for (const newInterface of [false, true]) {
  test(`a health sample holds the machine's memory and disk, and each agent's tree${newInterface ? ' (new interface)' : ''}`, async () => {
    test.skip(process.platform === 'win32', 'the trees are unknown on Windows; health-machine.test.ts covers what Windows gives');
    test.setTimeout(180_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-health-machine-${newInterface ? 'ni' : 'classic'}-`));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
    // In Node, not bash: a bash stand-in is named like the shell, and the app would never see a CLI running.
    const cli = writeNodeCli(path.join(home, 'stand-in-cli.cjs'), [
      "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });",
      "process.stdout.write('stand-in ready\\n');",
      'process.stdin.resume();',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
      id: 'x-weighed', name: 'Weighed Worker', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
      projectPath: project, skills: [], cliPath: cli, createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z',
    }]));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const samplesFile = path.join(dir, 'health-samples.jsonl');
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31524 + (newInterface ? 1 : 0)), DOROTHY_E2E: '1', DOROTHY_HEALTH_EVERY_MS: '500' },
    });
    const values: Record<string, unknown> = { newInterface, home };
    const errors: string[] = [];
    const samples = (): Sample[] => (fs.existsSync(samplesFile) ? fs.readFileSync(samplesFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
    const withTree = () => samples().filter(s => s.agentTrees?.trees.some(t => t.id === 'x-weighed' && t.processes >= 3));
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI, undefined, { timeout: 60_000 });
      await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'x-weighed', prompt: 'go' }));

      await expect.poll(() => withTree().length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
      const [before, last] = withTree().slice(-2);
      values.samples = [before, last];
      recordValues(values);

      // 1.
      const m = last.machine!;
      expect(m.memFreeMb).toBeGreaterThan(0);
      expect(m.diskFreeGb).toBeGreaterThan(0);
      expect(m.readMs).toBeGreaterThan(0);
      expect(m.swapUsedMb).not.toBeNull();
      if (process.platform === 'darwin') {
        expect(m.memFreePct).toBeGreaterThan(0);
        expect(m.compressedMb).not.toBeNull();
      }
      expect(m.swapGrowthMbPerMin, 'the second sample has the swap\'s growth').not.toBeNull();
      // 2.
      expect(last.agentTrees!.measure).toBe(process.platform === 'linux' ? 'pss' : 'rss');
      const tree = last.agentTrees!.trees.find(t => t.id === 'x-weighed')!;
      expect(tree.processes).toBeGreaterThanOrEqual(3);
      expect(tree.mb).toBeGreaterThan(10);
      expect(errors).toEqual([]);
    } finally {
      recordValues(values);
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
