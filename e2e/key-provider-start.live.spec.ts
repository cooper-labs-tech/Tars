import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync, spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, PORT_OFFSET, apiPort } from './ports.mjs';

/**
 * An agent created on an API-key provider answers its first task, with nobody at its terminal (2.0.4).
 *
 * Measured on 17/10: an agent on the deepseek provider started claude with the provider's key as ANTHROPIC_API_KEY,
 * and Claude Code stopped at launch on "Detected a custom API key in your environment. Do you want to use this API
 * key?", No preselected. Nothing answers that in an agent's terminal, so no key-provider agent ever started by
 * itself; and the first Enter typed there, Tars's own included, answered No (measured on 2.1.302).
 *
 * Here the real chain an orchestrator uses: Lead, the project's orchestrator, creates an agent on deepseek with
 * create_agent and hands it a first task with delegate_task, both through the real mcp-orchestrator over stdio with
 * Lead's identity. The agent runs the real claude (E2E_CLAUDE, or the one on the PATH) against a stand-in of the
 * vendor (e2e/live/fake-messages-api.mjs), reached through the sandbox's ~/.claude/settings.json, whose `env` wins
 * over the vendor's URL Tars sets (measured on 2.1.302); the key, the thing under test, is the one Tars hands over.
 *
 * Asserted: the task's answer comes back to Lead; every request the stand-in got carried the key as a Bearer
 * (ANTHROPIC_AUTH_TOKEN) and no x-api-key; the question never showed in the agent's terminal; and no file of the
 * sandbox holds the key, or its last 20 characters, but app-settings.json, where it already was. Both shells.
 *
 * Live: E2E_LIVE=1 and a native claude. The artefact: values.json (the tools' answers, every request the stand-in
 * got with the role of its credential, the terminal's last lines, where the key is on disk) and the screenshot.
 */

const LEAD = 'dddd4444-0000-4000-8000-0000000000d4';
/** What a test started, ended after it even when it ran out of time: a stand-in left on its port answers the next run. */
const started: ChildProcess[] = [];
test.afterEach(() => { for (const child of started.splice(0)) child.kill(); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ANSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMNOZc]/g;
type Reply = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };

function resolveClaude(): string {
  const named = process.env.E2E_CLAUDE;
  const found = named || (() => { try { return execFileSync('which', ['claude']).toString().trim(); } catch { return ''; } })();
  return found ? fs.realpathSync(found) : '';
}

/** The files under `root` that hold `secret`, or its last 20 characters, by path relative to `root`. */
function holding(root: string, secret: string): { full: string[]; end: string[] } {
  const found = { full: [] as string[], end: [] as string[] };
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(at); continue; }
      if (!entry.isFile() || fs.statSync(at).size > 20 * 1024 * 1024) continue;
      const data = fs.readFileSync(at);
      if (data.includes(secret)) found.full.push(path.relative(root, at));
      else if (data.includes(secret.slice(-20))) found.end.push(path.relative(root, at));
    }
  };
  walk(root);
  return found;
}

for (const newInterface of [false, true]) {
  test(`an agent created on deepseek answers its first task with nobody at its terminal${newInterface ? ' (new interface)' : ''}`, async () => {
    test.skip(process.env.E2E_LIVE !== '1', 'live: E2E_LIVE=1 and a native claude');
    const CLAUDE = resolveClaude();
    test.skip(!CLAUDE, 'no claude: set E2E_CLAUDE or put claude on PATH');
    test.setTimeout(5 * 60_000);

    // /tmp, not os.tmpdir(): the CLI's cwd is its physical path, and /var is /private/var on macOS.
    const home = fs.mkdtempSync('/tmp/dorothy-e2e-key-provider-');
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.dorothy');
    for (const d of [project, dir, path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
    execFileSync('git', ['init', '-q', project]);

    const KEY = `sk-${randomBytes(16).toString('hex')}`;
    const nonce = randomBytes(4).toString('hex');
    const STUB = (newInterface ? 31988 : 31987) + PORT_OFFSET;
    const OUT = test.info().outputPath();
    fs.mkdirSync(OUT, { recursive: true });
    const FAKE_LOG = path.join(OUT, 'fake.log');
    const version = path.basename(CLAUDE);

    // Claude Code's own state, as a user who has run it: onboarded, the project trusted, and no answer to any key.
    const trusted = { hasTrustDialogAccepted: true, allowedTools: [], hasCompletedProjectOnboarding: true };
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      numStartups: 5, installMethod: 'native', autoUpdates: false, theme: 'dark', hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true,
      lastOnboardingVersion: version, lastReleaseNotesSeen: version,
      projects: { [project]: trusted, [fs.realpathSync(project)]: trusted },
    }, null, 2));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      theme: 'dark', skipDangerousModePermissionPrompt: true, env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB}` },
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
      id: LEAD, name: 'Lead', character: 'robot', provider: 'claude', status: 'idle', role: 'orchestrator', permissionMode: 'normal',
      projectPath: project, skills: [], createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z',
    }], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude: CLAUDE }, deepSeekApiKey: KEY, newInterface,
    }, null, 2));

    const stub: ChildProcess = spawn(process.execPath, [path.resolve('e2e', 'live', 'fake-messages-api.mjs')], {
      env: { PATH: process.env.PATH, FAKE_PORT: String(STUB), FAKE_LOG, FAKE_KEY: KEY }, stdio: 'ignore',
    });
    started.push(stub);
    await expect.poll(() => fs.existsSync(FAKE_LOG) && fs.readFileSync(FAKE_LOG, 'utf8').includes('"listening"'),
      { timeout: 10_000, message: `the stand-in is not listening on ${STUB}: is another process holding the port?` }).toBe(true);
    const requests = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
      .filter((r: { url?: string }) => r.url) as Array<{ url: string; last: string; side: boolean; auth: { bearer: string | null; xApiKey: string | null } }>;

    const port = apiPort(newInterface ? 31309 : 31308);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { newInterface, claude: version, home };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const servers: ChildProcessWithoutNullStreams[] = [];
    let app: ElectronApplication | undefined;
    try {
      app = await launchSandboxed(electron, home, {
        env: {
          NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
        },
      });
      const page = await app.firstWindow();
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });

      // What Tars hands an orchestrator's tools: a token naming it, and the instance they check before sending it.
      const identity = await app.evaluate((_e, { dist, id }) => {
        const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
        return { token: tokens.mintRunToken(id).token as string, instance: tokens.tarsInstanceId() as string };
      }, { dist, id: LEAD });
      const mcp = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
        env: {
          PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: identity.token,
          CLAUDE_AGENT_ID: LEAD, CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: identity.instance,
        },
      });
      servers.push(mcp);
      started.push(mcp);
      const replies = new Map<number, (msg: Reply) => void>();
      // A server that dies answers nothing: every call still waiting is answered with what it said, not left to hang.
      let mcpErr = '';
      mcp.stderr.on('data', (d) => { mcpErr = (mcpErr + d).slice(-2000); });
      mcp.on('exit', (code) => {
        for (const [, reply] of replies) reply({ error: `mcp-orchestrator exited (${code}): ${mcpErr}` });
        replies.clear();
      });
      let buffered = '';
      mcp.stdout.on('data', (chunk) => {
        buffered += chunk;
        for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
          const line = buffered.slice(0, at);
          buffered = buffered.slice(at + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (typeof msg.id === 'number') replies.get(msg.id)?.(msg);
        }
      });
      let nextId = 1;
      const rpc = (method: string, params: unknown) => new Promise<Reply>((resolve) => {
        const id = nextId++;
        replies.set(id, resolve);
        mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const lead = async (tool: string, args: Record<string, unknown>) => {
        const reply = await rpc('tools/call', { name: tool, arguments: args });
        return { text: reply.result?.content?.map(c => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
      };

      // Lead creates an agent on deepseek, then hands it its first task, and nobody touches its terminal.
      const created = await lead('create_agent', { name: 'Deep', provider: 'deepseek', projectPath: project, permissionMode: 'bypass' });
      keep({ created });
      expect(created.isError, created.text).toBe(false);
      const deep = created.text.match(/with ID: ([0-9a-f-]{36})/)?.[1];
      expect(deep, created.text).toBeTruthy();
      // Bounded here too: an agent held at launch never answers, and the witness on the old build must end on what its
      // terminal shows, not on the test's own timeout.
      const delegated = await Promise.race([
        lead('delegate_task', { id: deep, prompt: `LINES 1 KEYOK${nonce}`, timeoutSeconds: 90 }),
        sleep(150_000).then(() => ({ text: 'delegate_task gave no answer in 150 s', isError: true })),
      ]);

      const output = await app.evaluate((_e, { dist, id }) => {
        const agent = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get(id);
        return { text: (agent?.output ?? []).join(''), status: agent?.status as string | undefined };
      }, { dist, id: deep });
      const screen = output.text.replace(ANSI, ' ').replace(/\s+/g, ' ');
      const claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
      keep({
        agent: deep, delegated, status: output.status,
        questionShown: screen.includes('Detected a custom API key'), terminalTail: screen.slice(-600),
        requests: requests(), customApiKeyResponses: claudeJson.customApiKeyResponses ?? null,
        keyOnDisk: holding(home, KEY),
      });
      await stepShot(page, newInterface ? 'answered-new-interface' : 'answered');

      expect(screen, 'Claude Code asked about the key, and nobody was there to answer').not.toContain('Detected a custom API key');
      expect(delegated.text, `the task's answer never came back to Lead: ${delegated.text}`).toContain(`KEYOK${nonce} line 1 of 1`);
      const task = requests().filter(r => !r.side && r.last === `LINES 1 KEYOK${nonce}`);
      expect(task.length, 'the task never reached the vendor').toBeGreaterThan(0);
      for (const r of requests()) {
        expect(r.auth, `a request went out with ${JSON.stringify(r.auth)}`).toEqual({ bearer: 'the key', xApiKey: null });
      }
      expect(holding(home, KEY), 'the key was written somewhere it was not').toEqual({ full: [path.join('.dorothy', 'app-settings.json')], end: [] });
    } finally {
      for (const server of servers) server.kill();
      stub.kill();
      await app?.close();
      await sleep(500);
      await removeHome(home);
    }
  });
}
