import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { hostileRepo } from '../__tests__/fixtures/hostile-repo';
import { launchSandboxed, markWhatsNewSeen, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Opening Review on a hostile repository runs none of its programs (2.0.4, the Audit's Hole 3), in the real app.
 *
 * The project is a repository whose own configuration names a program at every place git runs one: core.fsmonitor,
 * diff.external, a textconv and a diff command, a filter's clean, smudge and process (required), gpg.program with
 * commit.gpgSign, a pager, the hooks, and a submodule whose own fsmonitor too, plus a link to a folder outside it
 * (__tests__/fixtures/hostile-repo.ts). Each program writes a line to a marker file when it runs.
 *
 * Asserted: Review lists the repository's changes
 * (a.txt changed, b.txt new), shows a.txt's patch and b.txt's, the repository's summary is read, a file reached
 * through the link out of the repository is not shown, and the marker never appears.
 * Red on main d96be134: the fsmonitor, the submodule's fsmonitor, the post-index-change hook and the filter run.
 * Since #488 Review scans each project for its repositories before it reads one (services/review-repositories.ts):
 * the repository is opened from that scan, its project's working tree in the Repositories column, so the scan's git
 * calls are under the same assertion as the reads.
 * The artefact: values.json (what Review answered, what ran), screenshots, E2E_TRACE=on.
 */

type Api = { electronAPI: { review: {
  repo(repoPath: string): Promise<unknown>;
  file(repoPath: string, file: string, baseBranch?: string): Promise<unknown>;
} } };

test(`review on a repository whose configuration names programs runs none of them`, async () => {
  test.setTimeout(240_000);
  const h = hostileRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-review-hostile-'));
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([]));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([h.repo]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const values: Record<string, unknown> = { repo: h.repo };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31410), DOROTHY_E2E: '1' },
  });
  try {
    const page: Page = await app.firstWindow();
    await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${DEV_URL}/review`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(1, { timeout: 30_000 });

    // The repository, its changes, and each file's patch. The project is one repository: its row in the column is
    // its working tree, the branch and no agent.
    const row = page.getByRole('navigation', { name: 'Repositories' }).getByRole('button').filter({ hasText: 'no agent' });
    await expect(row).toHaveCount(1, { timeout: 60_000 });
    await row.click();
    const files = page.getByRole('region', { name: 'Changed files' });
    await expect(files.getByRole('button').filter({ hasText: 'a.txt' })).toBeVisible({ timeout: 30_000 });
    await expect(files.getByRole('button').filter({ hasText: 'b.txt' })).toBeVisible();
    await files.getByRole('button').filter({ hasText: 'a.txt' }).click();
    await expect(page.getByText('+two', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await stepShot(page, `01-hostile-repo-a-patch-new`);
    await files.getByRole('button').filter({ hasText: 'b.txt' }).click();
    await expect(page.getByText('+new', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

    // The summary, and a file through the link out of the repository.
    const summary = await page.evaluate((repo) => (window as unknown as Api).electronAPI.review.repo(repo), h.repo);
    const linked = await page.evaluate((repo) => (window as unknown as Api).electronAPI.review.file(repo, 'out/secret.txt'), h.repo);
    const body = await page.locator('body').innerText();
    keep({ summary, linked, ran: h.ran() });
    expect.soft(JSON.stringify(linked)).not.toContain('OUTSIDE-SECRET');
    expect.soft(body).not.toContain('OUTSIDE-SECRET');
    expect(h.ran(), 'programs the repository named, run by Tars').toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    await removeHome(home);
    fs.rmSync(h.root, { recursive: true, force: true });
  }
});
