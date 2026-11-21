import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Kilo CLI as an agent of its own: the provider `kilo`, the binary `kilo` (Kilo-Org/kilocode), a build of opencode.
 * Measured on 7.8.27 (20/11/2026) in throwaway homes:
 * - it takes opencode's flags (`--model`, `--auto`, `--session`, `--fork`, `--prompt`, its --help);
 * - it draws opencode's bottom bar (`tab agents  ctrl+p commands`) 13 to 47 s after it starts on a loaded machine, and
 *   took a key written the moment that bar appeared 64 to 106 ms later, three fresh starts out of three, whether its
 *   terminal answered its queries (kitty keyboard, DECRQM, XTGETTCAP, kitty graphics, colours) or not;
 * - it keeps its sessions in opencode's schema, in its own database, `$XDG_DATA_HOME/kilo/kilo.db` (`kilo debug paths`);
 * - it reads its own config, never opencode's.
 *
 * How it fails, written before the code:
 * 1. Run as an opencode agent, its endpoint's provider handed in OPENCODE_CONFIG_CONTENT, which Kilo ignores (only
 *    KILO_CONFIG_CONTENT put the endpoint's model on its bar): it falls back to its own Kilo Gateway, and the task
 *    leaves for a service the user did not choose.
 * 2. Tars's MCP servers written into opencode's folder, which Kilo never reads (`kilo mcp list` saw none there, and saw
 *    one in kilo.json, kilo.jsonc, opencode.json or config.json of `$XDG_CONFIG_HOME/kilo`): the agent has no Tars tools.
 *    Or a Kilo agent's servers written into the user's opencode files, or opencode's into Kilo's.
 * 3. Its turns looked for in opencode.db: delegate_task never sees one end.
 * 4. Its session resumed against opencode.db: it begins anew after every restart.
 * 5. A task typed before its bar is drawn, and lost.
 * 6. Its binary read from opencode's path setting: a Kilo agent starts opencode.
 * 7. Its launch noted in opencode's reader, or opencode's in Kilo's: a turn read from the wrong database, or none.
 * 8. A claim not measured: how a note typed mid-turn reaches Kilo has not been measured, so nothing is said of it.
 *
 * With #613's fixes, which Kilo shares through OpencodeBuildProvider and the reader (the Audit's re-read, for #614):
 * 9. A Kilo restart's line read as a resume of S rather than a fork of it, or its prompt lost: the fork never bound.
 * 10. A task typed into a Kilo forking a session at its home view's bar: on opencode 1.19.6 it started a new session
 *     without the history; Kilo's own timing is measured by its conformance run's restart step.
 * 11. (M2) Two Kilo agents with the same four skills, launched before either binds, ruling each other out.
 * 12. (The #614 Audit's Info 5) A Kilo worker keeps all seven of Tars's servers, X and Telegram among them, against
 *     the owner's rule of 28/10 that a worker gets neither. Measured on 7.8.27 (20/11): `KILO_CONFIG_CONTENT` with
 *     `{"mcp":{"<name>":{"enabled":false}}}` switches that server of kilo.json off for the run (`kilo mcp list` shows
 *     it disabled), and an entry for a server kilo.json does not define is ignored, with no error. So a worker's
 *     inline config switches the two off, merged with an endpoint's provider; an orchestrator, or an agent whose role
 *     the launch was not told, keeps all seven. opencode's own switch is not measured: its workers are as before.
 * 13. (#613's M4, merged into #614 on 21/11) Its bottom bar wrapped over two rows by a long folder or a narrow pane,
 *     read as never up: Kilo takes opencode's rule whole (OpencodeBuildProvider), the wrapped bar included, after a
 *     resume and a restart's fork alike, and still never the bare home view on a launch on a session.
 */

// The fleet's endpoint choice, as traces-runtime resolves it: agent 'on-ep' runs on an endpoint, no other.
vi.mock('../../../electron/services/traces-runtime', async () => {
  const { endpointLaunchFor: launchFor } = await vi.importActual<typeof import('../../../electron/services/endpoint-harness')>('../../../electron/services/endpoint-harness');
  return {
    endpointLaunchForAgent: (agentId: string | undefined, harness: string) =>
      agentId === 'on-ep' ? launchFor(harness, { proxyBase: 'http://127.0.0.1:31417/v1', model: 'org/Model-1' }) : null,
  };
});

import { KiloProvider } from '../../../electron/providers/kilo-provider';
import { OpenCodeProvider } from '../../../electron/providers/opencode-provider';
import { getProvider } from '../../../electron/providers';
import { endpointLaunchFor, ENDPOINT_TOKEN_VAR } from '../../../electron/services/endpoint-harness';
import { ENDPOINT_HARNESSES } from '../../../electron/services/inference-endpoints';
import { resolveResumeSessionId } from '../../../electron/utils/resume-session';
import { opencodeDbPath, opencodeUuidOf, opencodeLaunchOf } from '../../../electron/providers/opencode-cli';
import { opencodeWatchFor, type HookPost } from '../../../electron/services/opencode-sessions';
import { hasEndOfTurn } from '../../../electron/core/end-of-turn';

const BASE = 'http://127.0.0.1:31417/v1';
const SES = 'ses_e0a2b2f04ffeyXxkOfD77KQMP5';
const DDL = `
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL, directory text NOT NULL,
  title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
`;

let root: string;
let project: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-kilo-adapter-')));
  project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  vi.stubEnv('XDG_DATA_HOME', path.join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'config'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A database in opencode's schema, `name`'s own (opencode.db or kilo.db), with a session of `project` and one turn. */
function turnIn(name: string, id: string, agentId: string, at: number): void {
  const file = opencodeDbPath(process.env, os.homedir(), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(DDL);
  db.prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'p', 's', ?, 't', '7.8.27', ?, ?)").run(id, project, at, at);
  const msg = (mid: string, t: number, data: Record<string, unknown>, text: string) => {
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(mid, id, t, t, JSON.stringify(data));
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(`prt_${mid}`, mid, id, t, t, JSON.stringify({ type: 'text', text }));
  };
  msg('msg_000001', at + 1, { role: 'user', time: { created: at + 1 } }, `[Tars: you are agent "Worker" (id ${agentId}), worker of project /x.]\nRun the probe.`);
  msg('msg_000002', at + 2, {
    role: 'assistant', modelID: 'stand-in-coder', providerID: 'tars-endpoint', finish: 'stop', time: { created: at + 2, completed: at + 7 },
    tokens: { input: 20, output: 12, reasoning: 0, cache: { read: 100, write: 0 } }, cost: 0,
  }, 'PROBE-OK');
  db.close();
}

describe('Kilo, an agent of its own (6, 5, 8)', () => {
  it('is the provider kilo, on its own binary and path setting, with opencode\'s flags', () => {
    const kilo = getProvider('kilo');
    expect(kilo).toBeInstanceOf(KiloProvider);
    expect(kilo.binaryName).toBe('kilo');
    expect(kilo.resolveBinaryPath({ cliPaths: { kilo: '/opt/kilo', opencode: '/opt/opencode' } } as never)).toBe('/opt/kilo');
    const line = kilo.buildInteractiveCommand({ binaryPath: '/opt/kilo', prompt: 'go', permissionMode: 'bypass', resumeSessionId: SES, forkSession: true });
    expect(line.startsWith("'/opt/kilo'")).toBe(true);
    expect(line).toContain(' --auto');
    expect(line).toContain(`--session '${SES}' --fork`);
    expect(line).toContain("--prompt 'go'");
    expect(hasEndOfTurn({ provider: 'kilo' })).toBe(true);
    expect((kilo as KiloProvider).noteDuringTurn).toBeUndefined();
  });

  it('is up on its bottom bar, never on its logo', () => {
    const kilo = new KiloProvider();
    expect(kilo.upOnScreen([
      '                       ┃  Code  · Auto Free Kilo Gateway',
      '                       ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '                                                                       tab agents  ctrl+p commands',
      "                            ● Tip Commit your project's AGENTS.md file to Git for team sharing",
      '  ~/project                                                                                                     7.8.27',
    ])).toBe(true);
    expect(kilo.upOnScreen(['                                   ██  ██ ██████ ████ ██▀▀', '                                   ▀▀  ▀▀ ▀▀▀▀▀▀ ▀▀▀▀ ▀▀'])).toBe(false);
  });
});

describe('on an inference endpoint (1)', () => {
  it("gets the endpoint's provider in KILO_CONFIG_CONTENT, never in opencode's variable", () => {
    expect(ENDPOINT_HARNESSES).toContain('kilo');
    const launch = endpointLaunchFor('kilo', { proxyBase: BASE, model: 'org/Model-1' })!;
    expect(launch.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    const config = JSON.parse(launch.env.KILO_CONFIG_CONTENT);
    expect(config.provider['tars-endpoint'].options.baseURL).toBe(BASE);
    expect(config.provider['tars-endpoint'].models['org/Model-1']).toBeDefined();
    expect(launch.tokenVars).toEqual([ENDPOINT_TOKEN_VAR]);
    expect(launch.modelArg).toBe('tars-endpoint/org/Model-1');

    const kilo = new KiloProvider();
    const env = kilo.getPtyEnvVars('on-ep', project, []);
    expect(env.KILO_CONFIG_CONTENT).toBeDefined();
    expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    expect(env.CLAUDE_PROVIDER).toBe('kilo');
    expect(kilo.getPtyEnvVars('not-on-ep', project, []).KILO_CONFIG_CONTENT).toBeUndefined();
    expect(kilo.buildInteractiveCommand({ agentId: 'on-ep', binaryPath: 'kilo', prompt: '', model: 'x' })).toContain("--model 'tars-endpoint/org/Model-1'");
    // opencode keeps its own.
    expect(new OpenCodeProvider().getPtyEnvVars('on-ep', project, []).KILO_CONFIG_CONTENT).toBeUndefined();
  });
});

describe("Tars's MCP servers (2)", () => {
  it("go into Kilo's own kilo.json, never opencode's files, and opencode's never into Kilo's", async () => {
    const config = path.join(root, 'config');
    const kilo = new KiloProvider();
    await kilo.registerMcpServer('tars-probe', '/bin/node', ['/srv/probe/bundle.js']);
    const written = JSON.parse(fs.readFileSync(path.join(config, 'kilo', 'kilo.json'), 'utf8'));
    expect(written.mcp['tars-probe']).toEqual({ type: 'local', command: ['/bin/node', '/srv/probe/bundle.js'], enabled: true });
    expect(fs.existsSync(path.join(config, 'opencode'))).toBe(false);
    expect(kilo.isMcpServerRegistered('tars-probe', '/srv/probe/bundle.js')).toBe(true);
    expect(new OpenCodeProvider().isMcpServerRegistered('tars-probe', '/srv/probe/bundle.js')).toBe(false);

    await new OpenCodeProvider().registerMcpServer('tars-other', '/bin/node', ['/srv/other.js']);
    expect(JSON.parse(fs.readFileSync(path.join(config, 'kilo', 'kilo.json'), 'utf8')).mcp['tars-other']).toBeUndefined();

    await kilo.removeMcpServer('tars-probe');
    expect(JSON.parse(fs.readFileSync(path.join(config, 'kilo', 'kilo.json'), 'utf8')).mcp['tars-probe']).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(config, 'opencode', 'opencode.json'), 'utf8')).mcp['tars-other']).toBeDefined();
  });
});

describe('its sessions, in its own database (3, 4, 7)', () => {
  it("are resumed from kilo.db, never from opencode's", () => {
    const uuid = opencodeUuidOf(SES)!;
    const agent = { id: 'k1', provider: 'kilo', resumableSessionId: uuid, projectPath: project };
    turnIn('opencode', SES, 'k1', 1);
    expect(resolveResumeSessionId(agent, root)).toBeNull();
    turnIn('kilo', SES, 'k1', 1);
    expect(resolveResumeSessionId(agent, root)).toBe(SES);
  });

  it("are read by Kilo's own watch from kilo.db, and a Kilo launch is not opencode's", async () => {
    const kiloWatch = opencodeWatchFor('kilo')!;
    const opencodeWatch = opencodeWatchFor('opencode')!;
    expect(kiloWatch).toBeDefined();
    expect(kiloWatch).not.toBe(opencodeWatch);
    expect(opencodeWatchFor('claude')).toBeUndefined();

    const posts: Array<{ agentId: string; post: HookPost }> = [];
    kiloWatch.setDeps({ now: () => 1_000, post: async (agentId, post) => { posts.push({ agentId, post }); } });
    const AGENT = 'a1b2c3d4-0000-4000-8000-00000000000a';
    kiloWatch.noteLaunch(AGENT, project);
    expect(opencodeWatch.watching).toBe(false);

    // The same turn in opencode's database only: nothing of Kilo's.
    turnIn('opencode', SES, AGENT, 2_000);
    await kiloWatch.tick();
    expect(posts).toEqual([]);

    turnIn('kilo', SES, AGENT, 2_000);
    await kiloWatch.tick();
    const uuid = opencodeUuidOf(SES);
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((p) => p.agentId === AGENT && p.post.body.session_id === uuid)).toBe(true);
    expect(posts.some((p) => p.post.path === '/api/hooks/output' && JSON.stringify(p.post.body).includes('PROBE-OK'))).toBe(true);
  });
});

describe("a Kilo launch's own line (9, 10)", () => {
  const HOME = ['  ╹▀▀▀▀▀▀▀▀▀▀', '                                    tab agents  ctrl+p commands', '  ~/project                                   7.8.27'];
  const SESSION_VIEW = ['  ╹▀▀▀▀▀▀▀▀▀▀', '   /home/someone/project                            132  ctrl+p commands'];
  it('a restart is read as a fork of S with its prompt, and waits for its session\'s view; a fresh launch takes the home view', () => {
    const kilo = new KiloProvider();
    const fork = kilo.buildInteractiveCommand({ binaryPath: '/opt/kilo', prompt: "it's the task", resumeSessionId: SES, forkSession: true });
    expect(opencodeLaunchOf(fork)).toEqual({ forkOf: SES, prompt: "it's the task" });
    expect(opencodeLaunchOf(kilo.buildInteractiveCommand({ binaryPath: '/opt/kilo', prompt: '', resumeSessionId: SES }))).toEqual({ resume: SES });
    expect(kilo.upOnScreen(HOME, fork)).toBe(false);
    expect(kilo.upOnScreen(SESSION_VIEW, fork)).toBe(true);
    expect(kilo.upOnScreen(HOME, kilo.buildInteractiveCommand({ binaryPath: '/opt/kilo', prompt: '' }))).toBe(true);
  });
});

describe("a Kilo bar wrapped over two rows (13)", () => {
  /** The rows of QA's gate (gatestack613), opencode's bar at 120 columns: Kilo draws the same one. */
  const WRAPPED = [
    '  ╹' + '▀'.repeat(115),
    '   /private/var/folders/yp/j2nr6k4915z_bnf3tjv22t940000gn/T/dorothy-e2e-conformance-kilo-GRATOx/ 132 ctrl+p         ',
    '   projects/project-a                                                                                    commands       ',
  ];
  const HOME_NARROW = ['  ╹▀▀▀▀▀▀▀▀▀▀', '  tab agents ctrl+p', '            commands'];
  it("is up on its session's view wrapped, resumed or forked; never on the home view wrapped on a launch on a session", () => {
    const kilo = new KiloProvider();
    const fork = kilo.buildInteractiveCommand({ binaryPath: '/opt/kilo', prompt: '', resumeSessionId: SES, forkSession: true });
    const resume = kilo.buildInteractiveCommand({ binaryPath: '/opt/kilo', prompt: '', resumeSessionId: SES });
    expect(kilo.upOnScreen(WRAPPED, fork)).toBe(true);
    expect(kilo.upOnScreen(WRAPPED, resume)).toBe(true);
    expect(kilo.upOnScreen(HOME_NARROW, fork)).toBe(false);
  });
});

describe('two Kilo agents with the same four skills (11, the Audit\'s M2)', () => {
  it('launched before either binds, each binds its own session in kilo.db, by what its own line said', async () => {
    const SKILLS = ['vercel-react-best-practices', 'web-design-guidelines', 'frontend-design', 'supabase-postgres-best-practices'];
    const A = 'a1b2c3d4-0000-4000-8000-0000000000a1';
    const B = 'a1b2c3d4-0000-4000-8000-0000000000b1';
    const header = (id: string) => `[Tars: you are agent "W" (id ${id}), worker of project /x.] Run the probe.`;
    const kilo = new KiloProvider();
    const lineOf = (id: string) => kilo.buildInteractiveCommand({ binaryPath: '/opt/kilo', prompt: header(id), skills: SKILLS });
    const watch = opencodeWatchFor('kilo')!;
    const posts: Array<{ agentId: string; post: HookPost }> = [];
    watch.setDeps({ now: () => 1_000, post: async (agentId, post) => { posts.push({ agentId, post }); } });
    watch.noteLaunch(A, project, opencodeLaunchOf(lineOf(A)));
    watch.noteLaunch(B, project, opencodeLaunchOf(lineOf(B)));
    const file = opencodeDbPath(process.env, os.homedir(), 'kilo');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.exec(DDL);
    for (const [sid, id] of [['ses_kiloagenta000000000000', A], ['ses_kiloagentb000000000000', B]] as const) {
      db.prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'p', 's', ?, 't', '7.8.27', 2000, 2000)").run(sid, project);
      db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, 2001, 2001, ?)').run(`msg_${sid}`, sid, JSON.stringify({ role: 'user', time: { created: 2001 } }));
      const prompt = opencodeLaunchOf(lineOf(id)).prompt!;
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, 2001, 2001, ?)').run(`prt_${sid}`, `msg_${sid}`, sid, JSON.stringify({ type: 'text', text: prompt }));
    }
    db.close();
    await watch.tick();
    const by = (id: string) => [...new Set(posts.filter((p) => p.agentId === id).map((p) => p.post.body.session_id))];
    expect(by(A)).toEqual([opencodeUuidOf('ses_kiloagenta000000000000')]);
    expect(by(B)).toEqual([opencodeUuidOf('ses_kiloagentb000000000000')]);
  });
});

describe("a Kilo worker's servers (12, the #614 Audit's Info 5)", () => {
  it('a worker gets X and Telegram switched off in its own inline config; an orchestrator, or a role untold, keeps all seven', () => {
    const kilo = new KiloProvider();
    const worker = kilo.getPtyEnvVars('not-on-ep', project, [], undefined, { orchestrator: false });
    expect(JSON.parse(worker.KILO_CONFIG_CONTENT).mcp).toEqual({ 'claude-mgr-telegram': { enabled: false }, 'dorothy-x': { enabled: false } });
    expect(kilo.getPtyEnvVars('not-on-ep', project, [], undefined, { orchestrator: true }).KILO_CONFIG_CONTENT).toBeUndefined();
    expect(kilo.getPtyEnvVars('not-on-ep', project, []).KILO_CONFIG_CONTENT).toBeUndefined();
    // On an endpoint: one inline config, the endpoint's provider and the switch together.
    const onEp = JSON.parse(kilo.getPtyEnvVars('on-ep', project, [], undefined, { orchestrator: false }).KILO_CONFIG_CONTENT);
    expect(onEp.provider['tars-endpoint'].options.baseURL).toBe(BASE);
    expect(onEp.mcp).toEqual({ 'claude-mgr-telegram': { enabled: false }, 'dorothy-x': { enabled: false } });
    expect(JSON.parse(kilo.getPtyEnvVars('on-ep', project, [], undefined, { orchestrator: true }).KILO_CONFIG_CONTENT).mcp).toBeUndefined();
    // opencode's own switch is not measured: a worker of its keeps them, as before.
    expect(new OpenCodeProvider().getPtyEnvVars('not-on-ep', project, [], undefined, { orchestrator: false }).OPENCODE_CONFIG_CONTENT).toBeUndefined();
  });
});
