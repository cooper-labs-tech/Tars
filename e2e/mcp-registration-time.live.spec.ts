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
 * A dev or E2E Tars finds no bundle under process.resourcesPath, so its start-up registration registers nothing; the
 * work a packaged Tars does is timed by running setupMcpOrchestrator again with resourcesPath at this tree's bundles.
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
      // What the main process says about the registration, for the record of what it did.
      const said: string[] = [];
      for (const stream of [app.process().stdout, app.process().stderr]) {
        stream?.on('data', (chunk: Buffer) => {
          for (const line of String(chunk).split('\n')) if (/mcp|register/i.test(line)) said.push(line.replace(home, '<home>').slice(0, 240));
        });
      }
      values[`${start}Said`] = said;
      try {
        await app.firstWindow();
        values[start] = await app.evaluate(async (_e, [dist, wt]) => {
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
          // What the registration wrote by the time the gate opened: the servers codex and claude were given.
          const fs = req('fs') as typeof import('fs');
          const os = req('os') as typeof import('os');
          const read = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
          const codexToml = read(`${process.env.CODEX_HOME || `${os.homedir()}/.codex`}/config.toml`);
          const claudeMcp = read(`${os.homedir()}/.claude/mcp.json`);
          const written = {
            codex: [...codexToml.matchAll(/^\[mcp_servers\.("?)([^\]".]+)\1\]/gm)].map((m) => m[2]),
            claude: (() => { try { return Object.keys(JSON.parse(claudeMcp).mcpServers ?? {}); } catch { return []; } })(),
          };
          // A dev or E2E Tars finds no bundle under process.resourcesPath (Electron's own folder), so the start-up
          // registration above registered nothing. The work a packaged Tars does is measured here: the same function,
          // run once more with resourcesPath pointed at this tree's built bundles (mcp-*/dist/bundle.js).
          const registeredRun: Record<string, unknown> = {};
          const kept = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
          try {
            Object.defineProperty(process, 'resourcesPath', { value: wt, configurable: true, writable: true });
            const orchestrator = req(`${dist}/services/mcp-orchestrator.js`) as { setupMcpOrchestrator(s: unknown): Promise<void> };
            const appSettings = JSON.parse(read(`${os.homedir()}/.tars/app-settings.json`) || '{}');
            const t0 = Date.now();
            await orchestrator.setupMcpOrchestrator(appSettings);
            registeredRun.s = s(Date.now() - t0);
            const codexAfter = read(`${process.env.CODEX_HOME || `${os.homedir()}/.codex`}/config.toml`);
            registeredRun.written = {
              codex: [...codexAfter.matchAll(/^\[mcp_servers\.("?)([^\]".]+)\1\]/gm)].map((m) => m[2]),
              claude: (() => { try { return Object.keys(JSON.parse(read(`${os.homedir()}/.claude/mcp.json`)).mcpServers ?? {}); } catch { return []; } })(),
            };
          } catch (err) {
            registeredRun.error = String(err).slice(0, 300);
          } finally {
            if (kept) Object.defineProperty(process, 'resourcesPath', kept);
          }
          return {
            registeredRun,
            written,
            outcome,
            windowAtS: s(windowAtS * 1000),
            // The gate's own record where it keeps one; else the moment this wait ended, the end itself when it waited.
            gateOpenedAfterStartS: s((openedAt ?? Date.now()) - startedAt),
            // What a launch issued at the start waits at most: from the gate's begin to its opening.
            registrationS: openedAt !== undefined && beganAt !== undefined ? s(openedAt - beganAt) : null,
            exact: openedAt !== undefined || outcome === 'registered',
            boundS: gate.MCP_REGISTRATION_WAIT_MS / 1000,
          };
        }, [DIST, WT] as const);
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
