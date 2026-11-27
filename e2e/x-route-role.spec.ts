import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The API follows the role's MCP list (services/mcp-roles.ts; the Audit's P-1 on #657). A worker's CLI is started
 * without the X server. A process of that worker holding the agent's own token (CLAUDE_MGR_API_TOKEN, which every
 * agent terminal gets) must not get X's work done by calling the route itself: POST /api/x/request.
 *
 * In the real app, in a sandbox with posting on and made-up X keys, X's API is a recording stand-in on the loopback
 * (DOROTHY_X_API_URL, read under DOROTHY_E2E only). The project's orchestrator (claude) and a worker of each CLI
 * Tars runs on this branch are started from the window: claude, a key provider through claude (OpenRouter), codex,
 * gemini, Qwen Code, opencode, pi, amp and grok. Each CLI is a stand-in. Started in its terminal, it posts to the route
 * with the token it was given, as a curl or a script of the agent's would, and records what it had and what came back.
 *
 * Asserted:
 * 1. every agent's process had its own token in its environment;
 * 2. the orchestrator's post is answered 200 and reaches the stand-in of X, signed;
 * 3. each worker's post is refused 403 with the door's words, "dorothy-x is an orchestrator's server", and nothing
 *    of it reaches the stand-in of X.
 * Red on main's electron/ with only the stand-in's seam added (the commit before the fix): every worker's post goes to
 * the stand-in of X. Never run it on an electron/ that does not read DOROTHY_X_API_URL: its posts would go to X itself.
 * The artefact: values.json (each agent's provider, whether it had a token, the route's status and answer, the line
 * its CLI was started with, and what the stand-in of X received).
 */

const WORKERS = ['claude', 'openrouter', 'codex', 'gemini', 'qwen-code', 'opencode', 'pi', 'amp', 'grok'] as const;
const REFUSAL = { error: 'dorothy-x is an orchestrator\'s server' };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } };
type Seen = { agent: string; hadToken: boolean; status: number; answer: unknown; argv: string[] };

test('a worker\'s own token does not post on X through the API, whatever its CLI; the orchestrator\'s does', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-x-route-role-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const priv = path.join(home, '.tars-private');
  for (const d of [project, dir, path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(priv, { recursive: true, mode: 0o700 });
  // Made-up keys: nothing here is a credential of anyone's.
  fs.writeFileSync(path.join(priv, 'settings-secrets.json'), JSON.stringify({
    xApiKey: 'e2e-consumer-key', xApiSecret: 'e2e-consumer-secret', xAccessToken: 'e2e-access-token', xAccessTokenSecret: 'e2e-access-secret',
    openRouterApiKey: 'e2e-made-up-openrouter-key',
  }), { mode: 0o600 });

  // X's API, recorded: whatever reaches it is what Tars would have posted.
  const received: Array<{ method?: string; url?: string; signed: boolean; body: string }> = [];
  const x = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, signed: /^OAuth .*oauth_consumer_key="e2e-consumer-key"/.test(String(req.headers.authorization)), body });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { id: String(received.length), text: 'ok' } }));
    });
  });
  await new Promise<void>(r => x.listen(0, '127.0.0.1', r));

  const log = path.join(home, 'x-route-seen.jsonl');
  // In Node, not bash: a bash stand-in is named like the shell, and the app would never see a CLI running. It posts
  // only in an agent's terminal (CLAUDE_AGENT_ID), once, and never for a --version or a subcommand Tars may run.
  const cli = writeNodeCli(path.join(home, 'stand-in-cli.cjs'), [
    "const fs = require('fs');",
    "if (process.argv.includes('--version') || !process.env.CLAUDE_AGENT_ID) { process.stdout.write('9.9.9\\n'); process.exit(0); }",
    'const token = process.env.CLAUDE_MGR_API_TOKEN || "";',
    'const record = (status, answer) => fs.appendFileSync(' + JSON.stringify(log) + ', JSON.stringify({ agent: process.env.CLAUDE_AGENT_ID, hadToken: token.length > 0, status, answer, argv: process.argv.slice(2) }) + "\\n");',
    "fetch(process.env.CLAUDE_MGR_API_URL + '/api/x/request', {",
    "  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },",
    "  body: JSON.stringify({ method: 'POST', endpoint: '/2/tweets', body: { text: 'from ' + process.env.CLAUDE_AGENT_ID } }),",
    '}).then(async r => record(r.status, await r.json().catch(() => null)), e => record(0, String(e)));',
    "process.stdout.write('stand-in ready\\n');",
    'process.stdin.resume();',
    '',
  ].join('\n'));
  const agent = (id: string, provider: string, role: string) => ({
    id, name: id, character: 'robot', provider, status: 'idle', role, orchestratorMode: role === 'orchestrator',
    projectPath: project, skills: [], cliPath: cli, createdAt: '2026-11-27T08:00:00.000Z', lastActivity: '2026-11-27T08:00:00.000Z',
  });
  const ids = ['lead', ...WORKERS.map(p => `w-${p}`)];
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('lead', 'claude', 'orchestrator'), ...WORKERS.map(p => agent(`w-${p}`, p, 'worker'))]));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', xPostingEnabled: true }));

  const app = await launchSandboxed(electron, home, {
    env: {
      NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31530), DOROTHY_E2E: '1',
      DOROTHY_X_API_URL: `http://127.0.0.1:${(x.address() as AddressInfo).port}`,
    },
  });
  const values: Record<string, unknown> = { home };
  const errors: string[] = [];
  const seen = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Seen[];
  try {
    const page = await app.firstWindow();
    listenForErrors(page, errors);
    await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI, undefined, { timeout: 60_000 });
    for (const id of ids) {
      values[`start-${id}`] = await page.evaluate((agentId) => (window as unknown as Api).electronAPI.agent.start({ id: agentId, prompt: 'go' }).then(r => r, e => String(e)), id);
    }
    await expect.poll(() => ids.filter(id => !seen().some(s => s.agent === id)), { timeout: 120_000 }).toEqual([]);
    const of = (id: string) => seen().find(s => s.agent === id)!;
    for (const id of ids) values[id] = of(id);
    values.received = received;
    recordValues(values);

    // 1.
    for (const id of ids) expect.soft(of(id).hadToken, id).toBe(true);
    // 2.
    expect(of('lead').status).toBe(200);
    expect(received.filter(r => r.body.includes('"from lead"'))).toEqual([expect.objectContaining({ method: 'POST', url: '/2/tweets', signed: true })]);
    // 3.
    for (const p of WORKERS) {
      expect.soft({ status: of(`w-${p}`).status, answer: of(`w-${p}`).answer }, p).toEqual({ status: 403, answer: REFUSAL });
    }
    expect(received.map(r => JSON.parse(r.body).text)).toEqual(['from lead']);
    expect(errors).toEqual([]);
  } finally {
    values.received = received;
    recordValues(values);
    await app.close().catch(() => undefined);
    await new Promise(r => x.close(r));
    await removeHome(home);
  }
});
