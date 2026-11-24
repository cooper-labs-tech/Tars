import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Plan asked through the API is still taken where the CLI has one, and refused with its reason where it has none
 * (QA, #640).
 *
 * Lead, the project's orchestrator, is started from the window and, with its terminal's own token, asks /start in
 * plan for four workers in normal mode, each on a stand-in that writes the arguments it was started with:
 *   Claude worker (claude): 200, launched with --permission-mode plan;
 *   Qwen worker (qwen-code): 200, launched with --approval-mode plan;
 *   Local worker (local, Claude Code on Tasmania): plan is not what refuses it (Tasmania is not running: 409);
 *   Router worker (openrouter, the claude binary through an API key, whose line has no plan): 400 with the reason
 *   since #640, and no launch. Before #640 it answered 200 and the stand-in was launched with no plan.
 * The artefact: values.json with each answer and each worker's launches.
 */

test('plan asked through the API is taken for Claude Code and Qwen Code, refused with its reason for an API-key provider', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-plan-api-'));
  const real = fs.realpathSync(home);
  const project = path.join(real, 'projects', 'demo');
  fs.mkdirSync(project, { recursive: true });
  const dir = path.join(home, '.tars');
  fs.mkdirSync(dir, { recursive: true });
  const argsFile = path.join(real, 'stand-in-args.jsonl');
  const standIn = (name: string) => {
    const file = path.join(real, name);
    fs.writeFileSync(file, [
      `#!${process.execPath}`,
      'const id = process.env.CLAUDE_AGENT_ID;',
      `if (id) require('fs').appendFileSync(${JSON.stringify(argsFile)} + '.' + id, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      `if (id && process.env.CLAUDE_MGR_API_TOKEN) require('fs').writeFileSync(${JSON.stringify(argsFile)} + '.' + id + '.token', process.env.CLAUDE_MGR_API_TOKEN);`,
      "process.stdout.write('stand-in ready\\n');",
      'process.stdin.resume();',
      '',
    ].join('\n'), { mode: 0o755 });
    return file;
  };
  const claude = standIn('claude-stand-in.cjs');
  const qwen = standIn('qwen-stand-in.cjs');
  const agent = (o: Record<string, unknown>) => ({
    character: 'robot', status: 'idle', skills: [], projectPath: project, role: 'worker', permissionMode: 'normal',
    createdAt: '2026-10-12T08:00:00.000Z', lastActivity: '2026-10-12T08:00:00.000Z', ...o,
  });
  const WORKERS = [
    { id: 'w-claude', name: 'Claude worker', provider: 'claude', cliPath: claude },
    { id: 'w-qwen', name: 'Qwen worker', provider: 'qwen-code', cliPath: qwen },
    { id: 'w-local', name: 'Local worker', provider: 'local', cliPath: claude },
    { id: 'w-router', name: 'Router worker', provider: 'openrouter', cliPath: claude },
  ];
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent({ id: 'l1', name: 'Lead', provider: 'claude', role: 'orchestrator', orchestratorMode: true, cliPath: claude }),
    ...WORKERS.map(agent),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9',
    cliPaths: { claude, qwencode: qwen },
    openRouterEnabled: true, openRouterApiKey: 'sk-e2e-not-a-key',
  }));
  const launches = (id: string) => (fs.existsSync(`${argsFile}.${id}`)
    ? fs.readFileSync(`${argsFile}.${id}`, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as string[]) : []);
  const after = (argv: string[] | undefined, flag: string) => (argv && argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31452), DOROTHY_E2E: '1' },
  });
  const seen: Record<string, unknown> = {};
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    const leadStarted = await page.evaluate(() => (window as unknown as { electronAPI: { agent: { start: (a: { id: string; prompt: string }) => Promise<unknown> } } })
      .electronAPI.agent.start({ id: 'l1', prompt: 'lead' }));
    expect(leadStarted, JSON.stringify(leadStarted)).toMatchObject({ success: true });
    const tokenFile = `${argsFile}.l1.token`;
    await expect.poll(() => fs.existsSync(tokenFile), { timeout: 60_000, message: 'Lead\'s CLI was started with a token of its own' }).toBe(true);
    const token = fs.readFileSync(tokenFile, 'utf8');

    for (const w of WORKERS) {
      const response = await fetch(`http://127.0.0.1:${apiPort(31452)}/api/agents/${w.id}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: 'Read the project and say what you would change. Do not edit anything.', permissionMode: 'plan' }),
      });
      seen[w.id] = { status: response.status, answer: await response.json() };
    }
    // Long enough for every launch to have written its arguments.
    await page.waitForTimeout(5_000);
    for (const w of WORKERS) seen[w.id] = { ...(seen[w.id] as object), launches: launches(w.id) };
    recordValues(seen);

    const got = (id: string) => seen[id] as { status: number; answer: { error?: string }; launches: string[][] };
    expect.soft(got('w-claude').status, JSON.stringify(got('w-claude'))).toBe(200);
    expect.soft(after(got('w-claude').launches[0], '--permission-mode'), 'Claude worker launched in plan').toBe('plan');
    expect.soft(got('w-qwen').status, JSON.stringify(got('w-qwen'))).toBe(200);
    expect.soft(after(got('w-qwen').launches[0], '--approval-mode'), 'Qwen worker launched in plan').toBe('plan');
    expect.soft(String(got('w-local').answer.error ?? ''), 'Local worker: plan is not what refuses it').not.toMatch(/no plan mode/);
    expect.soft(got('w-router').status, JSON.stringify(got('w-router'))).toBe(400);
    expect.soft(got('w-router').answer.error).toBe('OpenRouter has no plan mode here: plan would run as manual. Ask for normal, auto or bypass.');
    expect.soft(got('w-router').launches, 'Router worker was never launched').toEqual([]);
  } finally {
    await app.close().catch(() => {});
    for (const w of WORKERS) if (fs.existsSync(`${argsFile}.${w.id}`)) fs.copyFileSync(`${argsFile}.${w.id}`, test.info().outputPath(`${w.id}-launches.jsonl`));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
