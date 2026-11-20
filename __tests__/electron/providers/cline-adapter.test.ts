import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

/**
 * Cline as an agent of its own: the provider `cline`, the binary `cline` (npm `cline`, 3.0.74, measured 20-21/11/2026
 * in throwaway homes, its TUI in a PTY against a loopback endpoint):
 * - `cline -i` is its TUI. A task on its line runs on a fresh session, and is ignored on one resumed with `--id`, so a
 *   launch types the task in once its field is drawn. It is up on its field (`❯`) with its footer (`Auto-approve all
 *   enabled|disabled (Shift+Tab)`), drawn after bracketed paste turns on (3.2 then 3.6 s, measured); never on its
 *   onboarding ("Welcome to Cline", whose Enter signs in with Cline: a device code, a page to open).
 * - Its folders: `--config <dir>` (its hooks, `<dir>/hooks`) and `--data-dir <dir>` (providers, MCP settings, sessions).
 *   Its TUI reads its provider from `<data>/settings/providers.json` only: given another file through
 *   CLINE_PROVIDER_SETTINGS_PATH it showed its onboarding and wrote a default providers.json into the data folder. So a
 *   Tars agent gets a folder of its own for both, and the user's `~/.cline` is never written (measured: it was not even
 *   made). With --data-dir it starts no hub, even with CLINE_SESSION_BACKEND_MODE=hub (measured).
 * - On an endpoint, the key from OPENAI_API_KEY (a bearer reached the endpoint; CLINE_API_KEY sent none), so the agent's
 *   providers.json names the proxy and the model, with no key.
 * - `--auto-approve false` asks in its terminal ("Approve tool call? [y] Approve [n] Deny"); `-p` ran the shell tool in
 *   plan mode, so there is no plan mode.
 * - `--id <id>` resumes a session under its own id; no fork. A note typed during a turn waits for the turn's end.
 *
 * How it fails, written before the code:
 * 1. No Tars provider knows `cline`, or it reads another CLI's path setting.
 * 2. The user's ~/.cline written into: its providers, its MCP settings, its hooks, its sessions.
 * 3. An agent launched on no provider: Cline shows its onboarding, and a task typed there signs in with Cline (a device
 *    code, the owner's browser). Refused, with what to do, before anything starts.
 * 4. Tars's servers or hooks missing from the agent's folder, a worker given X and Telegram, a hook that does not run
 *    Tars's shipped hook for its event.
 * 5. Its permission mode lost (normal must ask), or plan run as something else.
 * 6. The first-run notice left on (it took an Enter and opened a page in the owner's browser), the hub backend left to
 *    chance, the hook not told the data folder it reads prompts from.
 * 7. A task put on the line (lost on a resume), typed into the onboarding or before the field (upOnScreen).
 * 8. Its session not resumed after Tars restarts (the UUID never mapped back from the agent's sessions.db, or found in
 *    another folder); or a restart, which Cline cannot fork, continuing the session whose posts its stop made a
 *    tombstone, instead of starting fresh and saying so.
 * 9. On an endpoint: the key written into a file, or the user's own provider used.
 */

vi.mock('../../../electron/services/traces-runtime', async () => {
  const { endpointLaunchFor: launchFor } = await vi.importActual<typeof import('../../../electron/services/endpoint-harness')>('../../../electron/services/endpoint-harness');
  return {
    endpointLaunchForAgent: (agentId: string | undefined, harness: string) =>
      agentId === 'on-ep' ? launchFor(harness, { proxyBase: 'http://127.0.0.1:31417/v1', model: 'org/Model-1' }) : null,
  };
});

import { ClineProvider } from '../../../electron/providers/cline-provider';
import { getProvider } from '../../../electron/providers';
import { clineAgentDir, clineUuidOf, clineUserDataDir } from '../../../electron/providers/cline-cli';
import { endpointLaunchFor } from '../../../electron/services/endpoint-harness';
import { ENDPOINT_HARNESSES } from '../../../electron/services/inference-endpoints';
import { resolveResumeSessionId } from '../../../electron/utils/resume-session';
import { hasEndOfTurn } from '../../../electron/core/end-of-turn';
import { launchPlanRefusal, planModeRefusal } from '../../../electron/providers/plan-mode';
import { setAgentNoticeSink } from '../../../electron/core/agent-notices';

const AGENT = 'a1b2c3d4-0000-4000-8000-0000000000d1';
const SID = '1795204260136_9ovct';
let root: string;
let project: string;
let notices: string[];
const USER_PROVIDERS = { version: 1, lastUsedProvider: 'anthropic', modes: {}, providers: { anthropic: { settings: { provider: 'anthropic', apiKey: 'the-users-key', model: 'm' }, tokenSource: 'manual' } } };

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-cline-adapter-')));
  project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  notices = [];
  setAgentNoticeSink((agentId, line) => { notices.push(`${agentId}: ${line}`); });
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The user's own Cline data folder, with a provider of theirs; every file and its time, to show nothing was written. */
function usersCline(withProvider = true): { dir: string; snapshot: () => string } {
  const dir = path.join(root, 'users-cline', 'data');
  vi.stubEnv('CLINE_DATA_DIR', dir);
  fs.mkdirSync(path.join(dir, 'settings'), { recursive: true });
  if (withProvider) fs.writeFileSync(path.join(dir, 'settings', 'providers.json'), JSON.stringify(USER_PROVIDERS));
  const snapshot = () => {
    const out: string[] = [];
    (function walk(d: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(`${p}:${fs.statSync(p).mtimeMs}:${fs.readFileSync(p, 'utf8').length}`); } })(path.join(root, 'users-cline'));
    return out.sort().join('\n');
  };
  return { dir, snapshot };
}
async function ready(): Promise<ClineProvider> {
  const cline = new ClineProvider();
  await cline.configureHooks('/app/hooks');
  return cline;
}
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('Cline, an agent of its own (1, 7)', () => {
  it('is the provider cline, on its own path setting, its turns reported, its notes after the turn', () => {
    const cline = getProvider('cline');
    expect(cline).toBeInstanceOf(ClineProvider);
    expect(cline.binaryName).toBe('cline');
    expect(cline.resolveBinaryPath({ cliPaths: { cline: '/opt/cline', kilo: '/opt/kilo' } } as never)).toBe('/opt/cline');
    expect(hasEndOfTurn({ provider: 'cline' })).toBe(true);
    expect(cline.noteDuringTurn).toBe('after-the-turn');
    expect(cline.taskTypedAfterLaunch).toBe(true);
    expect(cline.typedTask!({ prompt: 'do it' })).toBe('do it');
  });

  it('is up on its field with its footer, never on its onboarding or a bare welcome', () => {
    const cline = new ClineProvider();
    expect(cline.upOnScreen!(['╭───╮', '❯ What can I do for you?', '──────', 'stand-in-coder (0) $0.00 ○ Plan ● Act (Tab) project ⏵⏵ Auto-approve all enabled (Shift+Tab)'])).toBe(true);
    expect(cline.upOnScreen!(['❯ Ask anything...', 'model (0) $0.00 ● Plan ○ Act (Tab) project Auto-approve all disabled (Shift+Tab)'])).toBe(true);
    expect(cline.upOnScreen!(['Welcome to Cline', 'Connect a model provider to get started.', '│ ☺ Sign in with Cline → │', '↑/↓ navigate, Enter to select, Ctrl+C to exit'])).toBe(false);
    expect(cline.upOnScreen!(['What can I do for you?'])).toBe(false);
    expect(cline.upOnScreen!([])).toBe(false);
  });
});

describe("the agent's own folder, never the user's (2, 3, 4, 6)", () => {
  it('copies the user\'s provider into it, writes hooks and servers there, and leaves the user\'s ~/.cline as it was', async () => {
    const users = usersCline();
    const before = users.snapshot();
    const cline = await ready();
    await cline.registerMcpServer('claude-mgr-orchestrator', '/opt/node', ['/res/mcp-orchestrator/dist/bundle.js']);
    await cline.registerMcpServer('dorothy-x', '/opt/node', ['/res/mcp-x/dist/bundle.js']);
    const dir = clineAgentDir(AGENT);
    const line = cline.buildInteractiveCommand({ agentId: AGENT, binaryPath: '/opt/cline', prompt: 'do the task', orchestratorMode: false });
    expect(line).toBe(`'/opt/cline' -i --config '${dir}' --data-dir '${path.join(dir, 'data')}' --auto-approve 'true'`);
    expect(dir.startsWith(path.join(os.homedir(), '.tars-private'))).toBe(true);
    expect(readJson(path.join(dir, 'data', 'settings', 'providers.json'))).toEqual(USER_PROVIDERS);
    const servers = readJson(path.join(dir, 'data', 'settings', 'cline_mcp_settings.json')).mcpServers;
    expect(Object.keys(servers)).toEqual(['claude-mgr-orchestrator']);
    expect(servers['claude-mgr-orchestrator']).toMatchObject({ command: '/opt/node', args: ['/res/mcp-orchestrator/dist/bundle.js'] });
    for (const event of ['TaskStart', 'TaskResume', 'TaskComplete', 'TaskCancel', 'TaskError']) {
      const hook = fs.readFileSync(path.join(dir, 'hooks', `${event}.mjs`), 'utf8');
      expect(hook).toContain(pathToFileURL(path.join('/app/hooks', 'cline-hook.mjs')).href);
      expect(hook).toContain(`run(${JSON.stringify(event)})`);
    }
    const lead = cline.buildInteractiveCommand({ agentId: AGENT, binaryPath: '/opt/cline', prompt: '', orchestratorMode: true });
    expect(lead).toContain('-i --config');
    expect(Object.keys(readJson(path.join(dir, 'data', 'settings', 'cline_mcp_settings.json')).mcpServers)).toEqual(['claude-mgr-orchestrator', 'dorothy-x']);
    expect(users.snapshot()).toBe(before);
    expect(cline.getPtyEnvVars(AGENT, project, [])).toMatchObject({
      CLINE_DISABLE_CLINE_PASS_NOTICE: '1', CLINE_SESSION_BACKEND_MODE: 'local', CLINE_DATA_DIR: path.join(dir, 'data'), CLAUDE_AGENT_ID: AGENT,
    });
  });

  it('refuses a launch on no provider at all, saying what to do, before any onboarding can show', async () => {
    usersCline(false);
    const cline = await ready();
    expect(() => cline.buildInteractiveCommand({ agentId: AGENT, binaryPath: 'cline', prompt: '' })).toThrow(/cline auth|inference endpoint/);
  });

  it('finds the user\'s data where Cline does: CLINE_DATA_DIR, else CLINE_DIR/data, else ~/.cline/data', () => {
    expect(clineUserDataDir({ CLINE_DATA_DIR: '/d' }, '/home/u')).toBe('/d');
    expect(clineUserDataDir({ CLINE_DIR: '/c' }, '/home/u')).toBe(path.join('/c', 'data'));
    expect(clineUserDataDir({ HOME: '/home/u' }, '/fallback')).toBe(path.join('/home/u', '.cline', 'data'));
    expect(clineUserDataDir({ USERPROFILE: 'C:\\Users\\u' }, '/fallback')).toBe(path.join('C:\\Users\\u', '.cline', 'data'));
    expect(() => clineAgentDir('../x')).toThrow();
  });
});

describe('its permission mode (5)', () => {
  it('normal asks, auto and bypass never do, plan is refused everywhere', async () => {
    usersCline();
    const cline = await ready();
    const line = (permissionMode?: 'normal' | 'auto' | 'bypass' | 'plan') => cline.buildInteractiveCommand({ agentId: AGENT, binaryPath: 'cline', prompt: '', permissionMode });
    expect(line('normal')).toContain("--auto-approve 'false'");
    expect(line(undefined)).toContain("--auto-approve 'false'");
    expect(line('auto')).toContain("--auto-approve 'true'");
    expect(line('bypass')).toContain("--auto-approve 'true'");
    expect(() => line('plan')).toThrow(/no plan mode/);
    expect(planModeRefusal('cline', 'plan')).toMatch(/no plan mode/);
    expect(launchPlanRefusal('cline', 'plan')).toMatch(/no plan mode/);
  });
});

describe('its sessions (8)', () => {
  function sessionIn(cwd: string): void {
    const db = path.join(clineAgentDir(AGENT), 'data', 'db', 'sessions.db');
    fs.mkdirSync(path.dirname(db), { recursive: true });
    const d = new Database(db);
    d.exec('CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, pid INTEGER, cwd TEXT, status TEXT)');
    d.prepare('INSERT OR REPLACE INTO sessions (session_id, pid, cwd, status) VALUES (?, 1, ?, ?)').run(SID, cwd, 'completed');
    d.close();
  }

  it("is resumed after Tars restarts by its own id, from the agent's own database, in the agent's folder", async () => {
    usersCline();
    const agent = { id: AGENT, provider: 'cline', resumableSessionId: clineUuidOf(SID)!, projectPath: project };
    expect(resolveResumeSessionId(agent, root)).toBeNull();
    sessionIn(path.join(root, 'elsewhere'));
    expect(resolveResumeSessionId(agent, root)).toBeNull();
    sessionIn(project);
    expect(resolveResumeSessionId(agent, root)).toBe(SID);
    const cline = await ready();
    expect(cline.buildInteractiveCommand({ agentId: AGENT, binaryPath: 'cline', prompt: '', resumeSessionId: SID })).toContain(`--id '${SID}'`);
    for (const bad of [`${SID}'; rm -rf ~`, clineUuidOf(SID)!, '2026']) {
      expect(cline.buildInteractiveCommand({ agentId: AGENT, binaryPath: 'cline', prompt: '', resumeSessionId: bad })).not.toContain('--id');
    }
    expect(notices).toEqual([]);
  });

  it('a restart starts a fresh session, since Cline cannot fork, and says so where a person reads the output', async () => {
    usersCline();
    const cline = await ready();
    const line = cline.buildInteractiveCommand({ agentId: AGENT, binaryPath: 'cline', prompt: '', resumeSessionId: SID, forkSession: true });
    expect(line).not.toContain('--id');
    expect(notices).toEqual([`${AGENT}: Its conversation starts over: Cline cannot fork a session, and a restart cannot continue the one it stops.`]);
  });
});

describe('on an inference endpoint (9)', () => {
  it("names Tars's proxy and the model in the agent's providers, the token from OPENAI_API_KEY, never in a file", async () => {
    const users = usersCline();
    const before = users.snapshot();
    expect(ENDPOINT_HARNESSES).toContain('cline');
    const launch = endpointLaunchFor('cline', { proxyBase: 'http://127.0.0.1:31417/v1', model: 'org/Model-1' })!;
    expect(launch).toMatchObject({ args: [], env: {}, tokenVars: ['OPENAI_API_KEY'] });
    const cline = await ready();
    const dir = clineAgentDir('on-ep');
    cline.buildInteractiveCommand({ agentId: 'on-ep', binaryPath: 'cline', prompt: '' });
    const written = readJson(path.join(dir, 'data', 'settings', 'providers.json'));
    expect(written.lastUsedProvider).toBe('openai-compatible');
    expect(written.providers['openai-compatible'].settings).toEqual({ provider: 'openai-compatible', model: 'org/Model-1', baseUrl: 'http://127.0.0.1:31417/v1' });
    expect(JSON.stringify(written)).not.toContain('the-users-key');
    expect(users.snapshot()).toBe(before);
  });
});
