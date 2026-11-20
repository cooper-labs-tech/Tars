import '../../setup/home-guard';
import { describe, it, expect, vi } from 'vitest';

/**
 * Slack's `usage` reads the stats Tars reads for the Usage page and Telegram's /usage.
 *
 * It read them through setGetClaudeStatsRef, and nothing in the app called it: in
 * the app, `usage` answered "No usage data available yet." whatever the data (found
 * by the D1 contract, #176). Written before the fix.
 *
 * The bot and its command handling are the real ones; Slack's client, the terminal
 * and the stats reader are not.
 */

const stats = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../../../electron/services/claude-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../electron/services/claude-service')>()),
  getClaudeStats: async () => stats.value,
}));
vi.mock('@slack/bolt', () => ({
  App: class {
    event() {}
    message() {}
    use() {}
    start() { return Promise.resolve(); }
    stop() { return Promise.resolve(); }
  },
  LogLevel: { DEBUG: 'debug', INFO: 'info' },
}));
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '1.8.0' },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));
vi.mock('../../../electron/core/window-manager', () => ({ getMainWindow: () => null }));

import { handleSlackCommand } from '../../../electron/services/slack-bot';
import type { AppSettings } from '../../../electron/types';

async function usage(): Promise<string[]> {
  const said: string[] = [];
  await handleSlackCommand('usage', 'C1', async text => { said.push(text); }, {} as AppSettings);
  return said;
}

describe('Slack\'s usage', () => {
  it('answers with the stats Tars reads for the Usage page', async () => {
    stats.value = { modelUsage: { 'claude-opus-4-5-20251101': { inputTokens: 1_000_000, outputTokens: 100_000 } } };
    const said = await usage();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(':bar_chart: *Usage Stats*');
    // A million tokens in at $5 and a hundred thousand out at $25, per million.
    expect(said[0]).toContain('Total Cost: $7.50');
  });

  it('says there is no data only when there is none', async () => {
    stats.value = null;
    expect(await usage()).toEqual([':bar_chart: No usage data available yet.']);
  });
});
