import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * How long the start-up registration of the MCP servers takes (2.0.7, the Audit's L-a on #657): every launch waits for
 * it (core/mcp-registration.ts), and a launch counted as starting only 15 s from its begin (CLI_BOOT_MS). Measured, not
 * asserted against a guess: Tars started twice on one sandbox home, a first start (every server registered with every
 * CLI found) and the next (already registered), with this machine's own claude, codex and Qwen Code named in the
 * settings, never the real home. Read from the main process: how long after the app's process started the gate opened
 * (the registration's end), and how it opened.
 *
 * Asserted only that each registration ended before the gate's bound (MCP_REGISTRATION_WAIT_MS). The artefact:
 * values.json (each start's numbers, the CLIs found).
 *
 * Live: E2E_LIVE=1; macOS and Linux.
 */

const WT = path.resolve('.');
const DIST = `${WT}/electron/dist`;

function found(bin: string): string {
  try { return fs.realpathSync(execFileSync('which', [bin]).toString().trim()); } catch { return ''; }
}

test('the start-up registration of the MCP servers ends, and how long it takes, on a first start and the next', async () => {
  test.skip(process.env.E2E_LIVE !== '1', 'live: E2E_LIVE=1');
  test.skip(process.platform === 'win32', 'macOS and Linux');
  test.setTimeout(6 * 60_000);
  const clis = { claude: found('claude'), codex: found('codex'), qwencode: found('qwen') };
  const home = fs.mkdtempSync('/tmp/tars-mcp-time-');
  fs.mkdirSync(path.join(home, '.tars'), { recursive: true });
  fs.writeFileSync(path.join(home, '.tars', 'agents.json'), JSON.stringify({ version: 3, agents: [] }));
  fs.writeFileSync(path.join(home, '.tars', 'projects.json'), '[]');
  fs.writeFileSync(path.join(home, '.tars', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(home, '.tars', 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', codexEnabled: true, qwenEnabled: true,
    cliPaths: { ...Object.fromEntries(Object.entries(clis).filter(([, p]) => p)), additionalPaths: [...new Set(Object.values(clis).filter(Boolean).map((p) => path.dirname(p)))] },
  }));
  const values: Record<string, unknown> = { clis: Object.fromEntries(Object.entries(clis).map(([k, p]) => [k, p ? path.basename(p) : null])) };
  try {
    for (const start of ['first', 'next']) {
      const app = await launchSandboxed(electron, home, {
        env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_E2E: '1', DOROTHY_API_PORT: apiPort(31447), CODEX_HOME: path.join(home, '.codex') },
      });
      try {
        await app.firstWindow();
        values[start] = await app.evaluate(async (_e, [dist]) => {
          const req = (process as unknown as { mainModule: { require(m: string): Record<string, unknown> } }).mainModule.require;
          const gate = req(`${dist}/core/mcp-registration.js`) as {
            untilMcpRegistered(): Promise<string>; MCP_REGISTRATION_WAIT_MS: number;
            mcpGateOpenedAt?: () => number | undefined; mcpRegistrationBeganAt?: () => number | undefined;
          };
          const startedAt = Date.now() - process.uptime() * 1000;
          const windowAtS = process.uptime();
          const outcome = await gate.untilMcpRegistered();
          const openedAt = gate.mcpGateOpenedAt?.();
          const beganAt = gate.mcpRegistrationBeganAt?.();
          const s = (ms: number) => Math.round(ms / 100) / 10;
          return {
            outcome,
            windowAtS: s(windowAtS * 1000),
            // The gate's own record where it keeps one; else the moment this wait ended, the end itself when it waited.
            gateOpenedAfterStartS: s((openedAt ?? Date.now()) - startedAt),
            // What a launch issued at the start waits at most: from the gate's begin to its opening.
            registrationS: openedAt !== undefined && beganAt !== undefined ? s(openedAt - beganAt) : null,
            exact: openedAt !== undefined || outcome === 'registered',
            boundS: gate.MCP_REGISTRATION_WAIT_MS / 1000,
          };
        }, [DIST] as const);
        recordValues(values);
      } finally {
        await app.close();
      }
    }
    for (const start of ['first', 'next']) {
      expect((values[start] as { outcome: string }).outcome, `${start} start: the registration did not end before the bound`).not.toBe('timed-out');
    }
  } finally {
    recordValues(values);
    await removeHome(home);
  }
});
