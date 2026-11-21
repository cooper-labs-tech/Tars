import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KimiCodeProvider, kimiSessionOfCommand } from '../../electron/providers/kimi-code-provider';
import { getProvider, isValidProvider } from '../../electron/providers';
import { hasEndOfTurn } from '../../electron/core/end-of-turn';
import { endpointLaunchFor } from '../../electron/services/endpoint-harness';
import { ENDPOINT_HARNESSES } from '../../electron/services/inference-endpoints';

/**
 * Kimi Code CLI as a provider: the binary `kimi`, measured on 2.6.3 (19/11/2026) in a PTY against a loopback endpoint.
 *
 * How it fails, written before the code (19/11):
 * 1. The task goes on its command line: kimi's TUI takes none (`kimi [options]`, `-p` is one-shot), so a task there
 *    is lost or read as an option. It must be typed in once kimi runs, with the skills line.
 * 2. An agent in auto or bypass starts without `--auto` (kimi then asks, and nobody answers in an agent's terminal),
 *    or one in normal mode starts with it.
 * 3. A model alias or a session id with shell metacharacters reaches the command line; a session id not of kimi's
 *    form is passed to `--session`.
 * 4. The folder trust question is left to the agent's terminal: KIMI_CODE_TRUST_WORKSPACE must be set.
 * 5. Registering Tars's MCP server drops the user's own servers or other keys in kimi's mcp.json, or writes into
 *    another home than KIMI_CODE_HOME.
 * 6. Its turns are not read (no end of turn), so a delegated task waits on a turn it never sees end.
 * 7. A model of one family is offered by default: only the user's own default.
 * 8. On an inference endpoint, kimi is not given the proxy (a key in a variable or a file), or is refused as a
 *    harness of an endpoint.
 * 13. An agent saved in plan mode starts kimi with `--plan`, which runs commands after dialogs nobody answers: kimi-code
 *     has no plan mode, so such a launch is refused, with the reason create and update give (the Audit's I3 on #601).
 * 11. On an endpoint, kimi is started with `-m <model>`: `-m` names an alias of the user's config.toml, and the
 *     endpoint's model is no such alias, so kimi says "Model ... is not configured in config.toml" and starts no
 *     session (the conformance run, 19/11). The model is KIMI_MODEL_NAME's alone there.
 * 10. A restart that applies new settings (forkSession) resumes the session it just stopped under its own id: that id
 *     is the stop's tombstone, and every post of it would be refused as stale. Built for a fork, the line starts kimi
 *     on a new session.
 * 14. (#613's restart step, QA's gate of the stack, 21/11) That new session has none of the conversation's turns: a
 *     settings change, or the window's restart, loses them. `kimi fork -y <id>` (2.6.3, measured 21/11: 1.4 s, no
 *     terminal, it prints `Forked to session_<uuid> (...)`) makes a new session holding them, which `--session` then
 *     resumes under its new id. Run off the main thread, before the line is built (forkAhead): a kimi that fails, prints
 *     no session, or a session not of kimi's form, gives none, and the line starts a new session as before. A launch
 *     that does not fork never asks kimi to (core/agent-launch.ts, resumeOfLaunch, launch-under-way.test.ts).
 * 15. (The Audit's L3 on #601) kimi fork run in Tars's own working folder (`/` in a packaged app) rather than the
 *     agent's, whose folder its index keeps for each session: run in the agent's folder.
 * 9. On an endpoint, the launch's own variables (KIMI_MODEL_NAME, _PROVIDER_TYPE, _BASE_URL) never reach the terminal:
 *    the endpoint session fills only the token's variable (services/traces-runtime.ts openEndpointSession), so the
 *    provider must add the rest, and only for the agent on an endpoint (Tars-Backend's note, 19/11).
 */

// The fleet's endpoint choice, as traces-runtime resolves it: agent 'on-ep' runs kimi-code on an endpoint, no other.
vi.mock('../../electron/services/traces-runtime', async () => {
  const { endpointLaunchFor: launchFor } = await vi.importActual<typeof import('../../electron/services/endpoint-harness')>('../../electron/services/endpoint-harness');
  return {
    endpointLaunchForAgent: (agentId: string | undefined, harness: string) =>
      agentId === 'on-ep' ? launchFor(harness, { proxyBase: 'http://127.0.0.1:31417/v1', model: 'org/Model-1' }) : null,
  };
});

const BASE = 'http://127.0.0.1:31417/v1';

/**
 * A stand-in of kimi 2.6.3's `fork` in the test's home: it records the arguments it was given, and forks (printing
 * kimi's own line, as measured), fails, or prints nothing.
 */
function standInKimi(mode: 'forks' | 'fails' | 'silent'): { bin: string; asked: () => string[] | null; cwd: () => string | null } {
  const bin = path.join(home, `kimi-${mode}`);
  const asked = path.join(home, `kimi-${mode}.asked`);
  const cwdFile = path.join(home, `kimi-${mode}.cwd`);
  const out = {
    forks: `process.stdout.write('Forked to session_9a5cf0db-b84c-499c-b67c-a5179db5e1d5 ("Fork: Run the probe") in 1416ms\\n');`,
    fails: `process.stderr.write('Error: session not found\\n'); process.exit(1);`,
    silent: '',
  }[mode];
  fs.writeFileSync(bin, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(asked)}, JSON.stringify(process.argv.slice(2)));\nrequire('fs').writeFileSync(${JSON.stringify(cwdFile)}, process.cwd());\n${out}\n`, { mode: 0o755 });
  return {
    bin,
    asked: () => (fs.existsSync(asked) ? JSON.parse(fs.readFileSync(asked, 'utf8')) as string[] : null),
    cwd: () => (fs.existsSync(cwdFile) ? fs.readFileSync(cwdFile, 'utf8') : null),
  };
}
let home: string;
let saved: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-provider-'));
  saved = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = saved;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('KimiCodeProvider', () => {
  const p = new KimiCodeProvider();

  it('is the registry\'s kimi-code', () => {
    expect(isValidProvider('kimi-code')).toBe(true);
    expect(getProvider('kimi-code').binaryName).toBe('kimi');
  });

  it('1: the task is typed in after launch, never on the command line', () => {
    const line = p.buildInteractiveCommand({ binaryPath: '/bin/kimi', prompt: 'fix the tests', permissionMode: 'bypass' });
    expect(line).not.toContain('fix the tests');
    expect(p.taskTypedAfterLaunch).toBe(true);
    expect(p.typedTask!({ prompt: 'fix the tests', skills: ['review'] })).toBe('[IMPORTANT: Use these skills for this session: review. Invoke them with /<skill-name> when relevant to the task.] fix the tests');
    expect(p.typedTask!({ prompt: '  ' })).toBe('');
  });

  it('2: auto and bypass start with --auto, normal without', () => {
    expect(p.buildInteractiveCommand({ binaryPath: 'kimi', prompt: '', permissionMode: 'bypass' })).toBe("'kimi' --auto");
    expect(p.buildInteractiveCommand({ binaryPath: 'kimi', prompt: '', permissionMode: 'auto' })).toBe("'kimi' --auto");
    expect(p.buildInteractiveCommand({ binaryPath: 'kimi', prompt: '', permissionMode: 'normal' })).toBe("'kimi'");
  });

  it('13: never --plan: an agent saved in plan is refused at its launch, with the reason an update gives', () => {
    // Kimi's --plan still runs commands, each after a dialog nobody answers (measured): the Audit's I3 on #601.
    expect(() => p.buildInteractiveCommand({ binaryPath: 'kimi', prompt: '', permissionMode: 'plan' }))
      .toThrow('Kimi Code has no plan mode here: plan would run as manual. Ask for normal, auto or bypass.');
  });

  it('3: a model alias and a session id only in their own forms; Tars knows a kimi session by its UUID', () => {
    const uuid = 'feabbac1-fc87-4756-8076-0c6adc57127b';
    // The UUID the hook routes took (services/kimi-sessions.ts posts it), resumed under kimi's own name for it.
    expect(p.buildInteractiveCommand({ binaryPath: 'kimi', prompt: '', model: 'my/alias-1.5', resumeSessionId: uuid }))
      .toBe(`'kimi' -m 'my/alias-1.5' --session 'session_${uuid}'`);
    expect(p.buildInteractiveCommand({ binaryPath: 'kimi', prompt: '', resumeSessionId: `session_${uuid}` })).toBe(`'kimi' --session 'session_${uuid}'`);
    expect(() => p.buildInteractiveCommand({ binaryPath: 'kimi', prompt: '', model: 'a;rm -rf' })).toThrow();
    for (const bad of ['session_x; rm -rf /', '../session_feabbac1', 'session_feabbac1', `${uuid}'; rm -rf /`]) {
      expect(p.buildInteractiveCommand({ binaryPath: 'kimi', prompt: '', resumeSessionId: bad })).toBe("'kimi'");
    }
  });

  it('10: a restart that forks starts a new session, never the tombstone under its own id', () => {
    const sid = 'feabbac1-fc87-4756-8076-0c6adc57127b';
    expect(p.buildInteractiveCommand({ binaryPath: 'kimi', prompt: '', resumeSessionId: sid, forkSession: true })).toBe("'kimi'");
  });

  it('14, 15: a restart forks the session with kimi fork -y in the agent\'s folder, and resumes the fork under its new id', async () => {
    const sid = 'feabbac1-fc87-4756-8076-0c6adc57127b';
    const kimi = standInKimi('forks');
    const folder = fs.mkdtempSync(path.join(home, 'project-'));
    expect(await p.forkAhead!(kimi.bin, sid, folder)).toBe('9a5cf0db-b84c-499c-b67c-a5179db5e1d5');
    expect(kimi.asked()).toEqual(['fork', '-y', `session_${sid}`]);
    expect(kimi.cwd()).toBe(fs.realpathSync(folder));
    expect(p.buildInteractiveCommand({ binaryPath: 'kimi', prompt: '', resumeSessionId: '9a5cf0db-b84c-499c-b67c-a5179db5e1d5' })).toBe("'kimi' --session 'session_9a5cf0db-b84c-499c-b67c-a5179db5e1d5'");
  });

  it('14: a fork that fails or prints no session gives none; a session not of kimi\'s form never reaches kimi', async () => {
    const sid = 'feabbac1-fc87-4756-8076-0c6adc57127b';
    for (const mode of ['fails', 'silent'] as const) expect(await p.forkAhead!(standInKimi(mode).bin, sid, home)).toBeNull();
    const kimi = standInKimi('forks');
    expect(await p.forkAhead!(kimi.bin, 'session_x; rm -rf /', home)).toBeNull();
    expect(kimi.asked()).toBeNull();
  });

  it('4: the folder is trusted through the environment', () => {
    expect(p.getPtyEnvVars('a1', '/p', [])).toMatchObject({ KIMI_CODE_TRUST_WORKSPACE: '1', CLAUDE_AGENT_ID: 'a1', CLAUDE_PROJECT_PATH: '/p' });
  });

  it('5: Tars\'s MCP server joins the user\'s own in KIMI_CODE_HOME/mcp.json', async () => {
    fs.writeFileSync(path.join(home, 'mcp.json'), JSON.stringify({ mcpServers: { mine: { command: 'x', args: [] } }, other: true }));
    await p.registerMcpServer('claude-mgr-orchestrator', '/usr/bin/node', ['/r/bundle.js']);
    const file = JSON.parse(fs.readFileSync(path.join(home, 'mcp.json'), 'utf8'));
    expect(file).toEqual({ mcpServers: { mine: { command: 'x', args: [] }, 'claude-mgr-orchestrator': { command: '/usr/bin/node', args: ['/r/bundle.js'] } }, other: true });
    expect(p.isMcpServerRegistered('claude-mgr-orchestrator', '/r/bundle.js')).toBe(true);
    await p.removeMcpServer('claude-mgr-orchestrator');
    expect(JSON.parse(fs.readFileSync(path.join(home, 'mcp.json'), 'utf8')).mcpServers).toEqual({ mine: { command: 'x', args: [] } });
  });

  it('6: its turns are read, so it has an end of turn', () => {
    expect(p.getHookConfig().turnsReported).toBe(true);
    expect(hasEndOfTurn({ provider: 'kimi-code' })).toBe(true);
  });

  it('7: no model of any family by default', () => {
    expect(p.getModels().map((m) => m.id)).toEqual(['default']);
  });

  it('12: the session a launch line resumes is read back from it, and nothing else', () => {
    const uuid = 'feabbac1-fc87-4756-8076-0c6adc57127b';
    const line = p.buildInteractiveCommand({ binaryPath: '/opt/kimi', prompt: '', resumeSessionId: uuid, permissionMode: 'bypass' });
    expect(kimiSessionOfCommand(`cd '/p' && ${line}`)).toBe(`session_${uuid}`);
    expect(kimiSessionOfCommand(`C:\\kimi.exe --auto --session "session_${uuid}"`)).toBe(`session_${uuid}`);
    expect(kimiSessionOfCommand(p.buildInteractiveCommand({ binaryPath: '/opt/kimi', prompt: '', permissionMode: 'bypass' }))).toBeUndefined();
    expect(kimiSessionOfCommand("'kimi' --session 'session_x; rm -rf /'")).toBeUndefined();
  });

  it('11: an agent on an endpoint is started without -m; another agent keeps its alias', () => {
    expect(p.buildInteractiveCommand({ agentId: 'on-ep', binaryPath: 'kimi', prompt: '', model: 'org/Model-1', permissionMode: 'bypass' })).toBe("'kimi' --auto");
    expect(p.buildInteractiveCommand({ agentId: 'not-on-ep', binaryPath: 'kimi', prompt: '', model: 'my-alias', permissionMode: 'bypass' })).toBe("'kimi' --auto -m 'my-alias'");
  });

  it('9: an agent on an endpoint gets the launch\'s variables in its terminal; another agent does not', () => {
    expect(p.getPtyEnvVars('on-ep', '/p', [])).toMatchObject({
      KIMI_MODEL_NAME: 'org/Model-1', KIMI_MODEL_PROVIDER_TYPE: 'openai', KIMI_MODEL_BASE_URL: 'http://127.0.0.1:31417/v1',
    });
    const plain = p.getPtyEnvVars('not-on-ep', '/p', []);
    expect(Object.keys(plain).filter((k) => k.startsWith('KIMI_MODEL_'))).toEqual([]);
  });

  it('8: on an endpoint, kimi gets the proxy from its environment, the token in KIMI_MODEL_API_KEY', () => {
    expect(ENDPOINT_HARNESSES).toContain('kimi-code');
    const l = endpointLaunchFor('kimi-code', { proxyBase: BASE, model: 'org/Model-1' })!;
    expect(l.env).toEqual({ KIMI_MODEL_NAME: 'org/Model-1', KIMI_MODEL_PROVIDER_TYPE: 'openai', KIMI_MODEL_BASE_URL: BASE });
    expect(l.tokenVars).toEqual(['KIMI_MODEL_API_KEY']);
    expect(l.args).toEqual([]);
    expect(l.files ?? []).toEqual([]);
    expect(endpointLaunchFor('kimi-code', { proxyBase: BASE, model: 'a b' })).toBeNull();
  });
});
