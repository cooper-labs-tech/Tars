import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { writeFakeClis } from './fake-clis.mjs';

/**
 * An agent whose CLI runs on a remote Linux host (2.0.7, item 14, part B), in the real app, against a container on
 * this computer (e2e/remote-host/Dockerfile: sshd with key auth only, tmux, git, curl, jq, node; about 250 MB). Never a
 * real remote machine. It needs a container runtime (docker), and says so when there is none.
 *
 * project-a has its orchestrator, Lead, on this computer (its own mcp-orchestrator over stdio with its own token, as
 * its CLI starts it), and a worker, Remote One. The container is the host. A key pair is made in the sandbox's home,
 * whose ~/.ssh/config names the host and whose known_hosts holds its key, filled once as the owner would, outside
 * Tars; Tars's ssh reads that config through DOROTHY_E2E_SSH_CONFIG (ssh takes its home from the password database, not
 * HOME). The claude stand-in (e2e/fake-clis.mjs) is copied into the container, and hands its hooks CLAUDE_PID as
 * Claude Code does (FAKE_CLAUDE_PID).
 *
 * Asserted:
 * 1. The window adds the host (remoteHosts.set). Lead's update_agent with a host the owner never added is refused;
 *    with the owner's, Remote One is placed in /home/agent/work/project-a.
 * 2. Lead hands Remote One `ECHO from-the-host` (start_agent). Its CLI runs in the container, in the tmux session
 *    tars-<id>, in that folder, with its token; its SessionStart registers through the tunnel, the host CLI's pid
 *    accepted; its Stop brings the answer back: task_status reads "echo from-the-host".
 * 3. Lead's message `SEND <Lead> hello from the host`: the CLI on the host calls Tars's MCP server through the tunnel,
 *    with its own token, and Tars answers it.
 * 4. What the host holds and what it does not: the environment file is gone once read; no command line of either
 *    machine holds the agent's token (read from the CLI's own /proc/<pid>/environ); the host's own
 *    ~/.claude/settings.json was never written; the agent's folder is trusted in its ~/.claude.json; the API answers on
 *    the host's loopback through the tunnel, and not on the container's network address.
 *    The tunnel reaches a listener of its own (the Audit's gate of #600): from the host, /api/health and
 *    /api/local-file answer 401 without a token, and /api/health answers with the agent's; a request target that
 *    does not parse ("//") is answered 400 (the re-audit's L5).
 * 4b. (M1) The window cannot remove the host while Remote One is placed on it (host_in_use).
 * 4c. (L1) The window's restart ends the session on the host and starts it again there: a new tmux pane, a new session.
 * 5. stop_agent: the tmux session is gone, the tunnel's port closed, Remote One stopped.
 * 6. (M1) Started again, its link dropped (this computer's ssh ended by its pid): the session goes on on the host; the
 *    move back to this computer (update_agent remote null) ends it there. The host can then be removed.
 * The artefact: values.json (each tool's answer, the host's log, what the host held), the app's trace.
 * Red on three mutants (reports kept with the PR): the placement without the launch, as at 288a8cddd (the CLI starts
 * on this computer, nothing runs in the container); a remote agent's CLI pid compared with its local terminal's (its
 * session is refused); the host's preparation leaving the agent's folder untrusted (the first task goes to the trust
 * question).
 */

const LEAD = 'cccc3333-0000-4000-8000-00000000c001';
const REMOTE = 'cccc3333-0000-4000-8000-00000000c002';
const IMAGE = 'tars-e2e-remote-host:1';
const HOST_ID = 'test-host';
const SSH_ALIAS = 'tars-test-host';
const FOLDER = '/home/agent/work/project-a';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Reply = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
type Win = { electronAPI: {
  agent: {
    get(id: string): Promise<{ status: string; currentSessionId?: string; remote?: { hostId: string; folder: string } } | null>;
    restart(id: string): Promise<{ success: boolean; error?: string }>;
  };
  remoteHosts: {
    set(host: unknown): Promise<{ success: boolean; error?: string }>;
    remove(id: string): Promise<{ success: boolean; error?: string; code?: string }>;
    list(): Promise<unknown[]>;
  };
} };

const dockerOk = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' }).status === 0;

function docker(args: string[], input?: string): string {
  return execFileSync('docker', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 600_000 }).trim();
}

/** A command in the container, as the host's account, `input` on its stdin; its exit code and output. */
function onHost(id: string, script: string, input?: string): { code: number; out: string } {
  const r = spawnSync('docker', ['exec', ...(input !== undefined ? ['-i'] : []), '-u', 'agent', id, 'sh', '-c', script], { encoding: 'utf8', timeout: 30_000, input });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}`.trim() };
}

/** The host: the container started, the owner's key let in, the stand-in claude on its PATH, the agent's folder. */
function startHost(home: string): { id: string; port: string } {
  if (spawnSync('docker', ['image', 'inspect', IMAGE]).status !== 0) docker(['build', '-t', IMAGE, path.resolve('e2e', 'remote-host')]);
  const id = docker(['run', '-d', '--rm', '-p', '127.0.0.1::22', IMAGE]);
  const port = docker(['port', id, '22/tcp']).split('\n')[0].split(':').pop()!;
  const sshDir = path.join(home, '.ssh');
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'tars-e2e', '-f', path.join(sshDir, 'id_ed25519')]);
  const root = (script: string, input?: string) => docker(['exec', '-i', id, 'sh', '-c', script], input);
  root('cat > /home/agent/.ssh/authorized_keys', fs.readFileSync(path.join(sshDir, 'id_ed25519.pub'), 'utf8'));
  root('mkdir -p /home/agent/fake /home/agent/bin && cat > /home/agent/fake/fake-clis.mjs', fs.readFileSync(path.resolve('e2e', 'fake-clis.mjs'), 'utf8'));
  root('cat > /home/agent/bin/claude && chmod 755 /home/agent/bin/claude', [
    '#!/usr/bin/env node',
    "process.env.FAKE_CLI_KIND = 'claude';",
    "process.env.FAKE_CLI_LOG = '/home/agent/fake-cli.jsonl';",
    "process.env.FAKE_CLAUDE_PID = '1';",
    "import('/home/agent/fake/fake-clis.mjs').then((m) => m.run());",
    '',
  ].join('\n'));
  root(`printf '%s\\n' 'export PATH="$HOME/bin:$PATH"' > /home/agent/.profile && mkdir -p ${FOLDER} && chown -R agent:agent /home/agent && chmod 600 /home/agent/.ssh/authorized_keys`);
  // Its key, accepted once, as the owner would, outside Tars.
  let keys = '';
  for (let i = 0; i < 40 && !keys; i++) {
    keys = spawnSync('ssh-keyscan', ['-p', port, '-t', 'ed25519', '127.0.0.1'], { encoding: 'utf8' }).stdout?.trim() ?? '';
    if (!keys) execFileSync('sleep', ['0.5']);
  }
  if (!keys) throw new Error('the test host never answered on its ssh port');
  fs.writeFileSync(path.join(sshDir, 'known_hosts'), `${keys}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(sshDir, 'config'), [
    `Host ${SSH_ALIAS}`,
    '  HostName 127.0.0.1',
    `  Port ${port}`,
    '  User agent',
    `  IdentityFile ${path.join(sshDir, 'id_ed25519')}`,
    '  IdentitiesOnly yes',
    `  UserKnownHostsFile ${path.join(sshDir, 'known_hosts')}`,
    '  StrictHostKeyChecking yes',
    '',
  ].join('\n'), { mode: 0o600 });
  return { id, port };
}

function seed(home: string) {
  const projectA = path.join(home, 'projects', 'project-a');
  const dir = path.join(home, '.tars');
  for (const d of [projectA, dir]) fs.mkdirSync(d, { recursive: true });
  const fakes = writeFakeClis(home, ['claude']) as Record<string, string>;
  const agent = (id: string, name: string, role: string) => ({
    id, name, character: 'robot', provider: 'claude', status: 'idle', role, projectPath: projectA, skills: [], permissionMode: 'bypass',
    cliPath: fakes.claude, createdAt: '2026-11-20T07:00:00.000Z', lastActivity: '2026-11-20T07:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent(LEAD, 'Lead', 'orchestrator'), agent(REMOTE, 'Remote One', 'worker')]));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([projectA]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { claude: fakes.claude } }));
  return { projectA };
}

/** The stand-in's log on the host: every launch, hook, tool call and answer. */
function hostLog(id: string): Array<Record<string, unknown>> {
  const { out } = onHost(id, 'cat /home/agent/fake-cli.jsonl 2>/dev/null');
  return out ? out.split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** An orchestrator's own mcp-orchestrator over stdio, with its own token, as its CLI starts it. */
async function orchestratorTools(app: ElectronApplication, port: string, home: string, agentId: string, projectPath: string, servers: ChildProcessWithoutNullStreams[]) {
  const dist = path.resolve('electron', 'dist');
  const id = await app.evaluate((_e, { dist, agentId }) => {
    const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
    return { token: tokens.mintRunToken(agentId).token as string, instance: tokens.tarsInstanceId() as string };
  }, { dist, agentId });
  const mcp = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
    env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: id.token, CLAUDE_AGENT_ID: agentId, CLAUDE_PROJECT_PATH: projectPath, TARS_INSTANCE_ID: id.instance },
  });
  servers.push(mcp);
  const replies = new Map<number, (msg: Reply) => void>();
  let buffered = '';
  mcp.stdout.on('data', (chunk) => {
    buffered += chunk;
    for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (typeof msg.id === 'number') replies.get(msg.id)?.(msg);
    }
  });
  let nextId = 1;
  const rpc = (method: string, params: unknown) => new Promise<Reply>((resolve) => { const n = nextId++; replies.set(n, resolve); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return async (tool: string, args: Record<string, unknown>) => {
    const reply = await Promise.race([rpc('tools/call', { name: tool, arguments: args }), sleep(120_000).then(() => ({ error: `${tool} gave no answer in 120 s` }) as Reply)]);
    return { tool, args, text: reply.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
  };
}

async function openWindow(app: ElectronApplication, errors: string[]): Promise<Page> {
  const page = await app.firstWindow();
  listenForErrors(page, errors);
  await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
  await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI, undefined, { timeout: 60_000 });
  return page;
}

test.skip(!dockerOk, 'needs a container runtime: docker answers nothing here (on macOS, start colima or Docker Desktop)');

test("an agent placed on a remote host runs there in tmux, reports through its tunnel, answers its task, and ends with its stop", async () => {
  test.setTimeout(420_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-remote-'));
  const { projectA } = seed(home);
  const values: Record<string, unknown> = { home, platform: process.platform, image: IMAGE };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const errors: string[] = [];
  const servers: ChildProcessWithoutNullStreams[] = [];
  const host = startHost(home);
  keep({ container: host.id.slice(0, 12), sshPort: host.port });
  const port = apiPort(31570);
  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', DOROTHY_E2E_SSH_CONFIG: path.join(home, '.ssh', 'config') },
  });
  try {
    const page = await openWindow(app, errors);
    const agent = (id: string) => page.evaluate((i) => (window as unknown as Win).electronAPI.agent.get(i), id);
    const lead = await orchestratorTools(app, port, home, LEAD, projectA, servers);
    // Tars's servers registered as a packaged Tars registers them at its start (shared-mcp-servers.spec.ts does the
    // same): a development run finds no bundle under its resources, and its agents' role files would hold none.
    const resources = path.join(home, 'resources');
    for (const s of ['mcp-orchestrator', 'mcp-memory', 'mcp-kanban', 'mcp-vault', 'mcp-socialdata', 'mcp-x']) {
      fs.mkdirSync(path.join(resources, s, 'dist'), { recursive: true });
      fs.copyFileSync(path.resolve(s, 'dist', 'bundle.js'), path.join(resources, s, 'dist', 'bundle.js'));
      fs.copyFileSync(path.resolve(s, 'package.json'), path.join(resources, s, 'package.json'));
    }
    const dist = path.resolve('electron', 'dist');
    await app.evaluate(async (_e, { resources, dist }) => {
      const was = process.resourcesPath;
      Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true, writable: true });
      try {
        await process.mainModule!.require(`${dist}/services/mcp-orchestrator.js`).setupMcpOrchestrator({});
      } finally {
        Object.defineProperty(process, 'resourcesPath', { value: was, configurable: true, writable: true });
      }
    }, { resources, dist });
    const roleFile = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'mcp.json'), 'utf8')) as { mcpServers?: Record<string, { type?: string; url?: string }> };
    keep({ roleFileHere: roleFile.mcpServers });
    expect(roleFile.mcpServers?.['claude-mgr-orchestrator']?.url).toBe(`http://127.0.0.1:${port}/api/mcp/claude-mgr-orchestrator`);

    // 1. The owner's host, from the window; the placement, by the project's orchestrator.
    const added = await page.evaluate((h) => (window as unknown as Win).electronAPI.remoteHosts.set(h), { id: HOST_ID, name: 'Test host', sshTarget: SSH_ALIAS, workRoot: '/home/agent/work' });
    const nowhere = await lead('update_agent', { id: REMOTE, remote: { hostId: 'nowhere' } });
    const placed = await lead('update_agent', { id: REMOTE, remote: { hostId: HOST_ID } });
    keep({ added, nowhere, placed });
    expect(added).toMatchObject({ success: true });
    expect(nowhere.isError).toBe(true);
    expect(placed.isError, placed.text).toBe(false);
    expect((await agent(REMOTE))?.remote).toEqual({ hostId: HOST_ID, folder: FOLDER });

    // 2. The task, on the host.
    const started = await lead('start_agent', { id: REMOTE, prompt: 'ECHO from-the-host' });
    keep({ started });
    expect(started.isError, started.text).toBe(false);
    const taskId = /\bt-[0-9a-f]{8}\b/.exec(started.text)?.[0];
    await expect.poll(() => hostLog(host.id).some((e) => e.answer === 'echo from-the-host'), { timeout: 90_000 }).toBe(true);
    const launched = hostLog(host.id).find((e) => e.launch === true);
    keep({ launched, hostLogAfterTask: hostLog(host.id) });
    expect(launched).toMatchObject({ cwd: FOLDER, token: true, instance: true, question: null });
    expect(onHost(host.id, `tmux has-session -t tars-${REMOTE}`).code).toBe(0);
    expect(hostLog(host.id).filter((e) => e.hook === 'SessionStart')).toEqual([expect.objectContaining({ exit: 0 })]);
    await expect.poll(async () => (await agent(REMOTE))?.currentSessionId, { timeout: 30_000 }).toBe(launched?.sid);
    if (taskId) {
      await expect.poll(async () => (await lead('task_status', { taskId })).text, { timeout: 60_000 }).toMatch(/echo from-the-host/);
      keep({ taskStatus: await lead('task_status', { taskId }) });
    }

    // 3. A tool of Tars's, called from the host.
    const sent = await lead('send_message', { id: REMOTE, message: `SEND ${LEAD} hello from the host` });
    keep({ sent });
    await expect.poll(() => hostLog(host.id).find((e) => e.mcp === true && e.tool === 'send_message' && e.isError !== undefined), { timeout: 90_000 }).toBeTruthy();
    const called = hostLog(host.id).filter((e) => e.mcp === true && e.tool === 'send_message');
    keep({ called });
    expect(called.find((e) => e.calling)).toMatchObject({ token: true, agentId: REMOTE });
    expect(called.find((e) => e.isError !== undefined)).toMatchObject({ isError: false });

    // 4. What the host holds.
    const pane = onHost(host.id, `tmux display-message -p -t tars-${REMOTE} '#{pane_pid}'`).out;
    const environ = onHost(host.id, `tr '\\0' '\\n' < /proc/${pane}/environ`).out.split('\n');
    const token = environ.find((l) => l.startsWith('CLAUDE_MGR_API_TOKEN='))?.slice('CLAUDE_MGR_API_TOKEN='.length) ?? '';
    const tunnel = environ.find((l) => l.startsWith('CLAUDE_MGR_API_URL='))?.slice('CLAUDE_MGR_API_URL='.length) ?? '';
    const rport = tunnel.split(':').pop() ?? '';
    const hostCommandLines = onHost(host.id, "for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < \"$f\"; echo; done").out;
    const macCommandLines = execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8' });
    const agentFiles = onHost(host.id, `ls /home/agent/.tars-remote/agents/${REMOTE}`).out.split('\n').sort();
    const settingsWritten = onHost(host.id, 'test -e /home/agent/.claude/settings.json').code === 0;
    const trusted = JSON.parse(onHost(host.id, 'cat /home/agent/.claude.json').out).projects?.[FOLDER]?.hasTrustDialogAccepted;
    const status = (route: string) => onHost(host.id, `curl -s -m 3 -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${rport}${route}'`).out;
    const healthNoToken = status('/api/health');
    const localFileNoToken = status('/api/local-file?path=/etc/hosts');
    // A target that does not parse (the re-audit's L5): answered 400, never thrown.
    const badTarget = onHost(host.id, `curl -s -m 3 --path-as-is -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${rport}//'`).out;
    const onNetwork = onHost(host.id, `curl -s -m 3 http://$(hostname -i):${rport}/api/health || echo refused`);
    keep({ tokenFound: token.length > 20, tunnel, agentFiles, settingsWritten, trusted, healthNoToken, localFileNoToken, badTarget, onNetwork: onNetwork.out });
    expect(badTarget).toBe('400');
    expect(token.length).toBeGreaterThan(20);
    expect(tunnel).toMatch(/^http:\/\/127\.0\.0\.1:4[0-9]{4}$/);
    expect(hostCommandLines.includes(token)).toBe(false);
    expect(macCommandLines.includes(token)).toBe(false);
    expect(agentFiles).toEqual(['mcp.json', 'mcp.tmpl', 'settings.json']);
    expect(settingsWritten).toBe(false);
    expect(trusted).toBe(true);
    // The tunnel's listener: nothing without the agent's token, the two routes the API's own port exempts included.
    expect(healthNoToken).toBe('401');
    expect(localFileNoToken).toBe('401');
    expect(onNetwork.out).toBe('refused');
    // With it (the header on curl's stdin, never on a command line): answered.
    const healthWithToken = onHost(host.id, `curl -s -m 3 -H @- http://127.0.0.1:${rport}/api/health`, `Authorization: Bearer ${token}\n`).out;
    keep({ healthWithToken });
    expect(healthWithToken).toBe('{"ok":true}');

    // 4b. The host cannot be removed while Remote One is placed on it.
    const removeRefused = await page.evaluate((h) => (window as unknown as Win).electronAPI.remoteHosts.remove(h), HOST_ID);
    keep({ removeRefused });
    expect(removeRefused).toMatchObject({ success: false, code: 'host_in_use' });
    expect(removeRefused.error).toMatch(/Remote One/);

    // 4c. The window's restart: the session on the host ended, then started again there.
    const sessionBefore = (await agent(REMOTE))?.currentSessionId;
    const restarted = await page.evaluate((i) => (window as unknown as Win).electronAPI.agent.restart(i), REMOTE);
    keep({ restarted });
    expect(restarted).toMatchObject({ success: true });
    await expect.poll(async () => { const s = (await agent(REMOTE))?.currentSessionId; return !!s && s !== sessionBefore; }, { timeout: 60_000 }).toBe(true);
    const paneAfter = onHost(host.id, `tmux display-message -p -t tars-${REMOTE} '#{pane_pid}'`).out;
    keep({ paneBefore: pane, paneAfter, launches: hostLog(host.id).filter((e) => e.launch === true).length });
    expect(paneAfter).toMatch(/^[0-9]+$/);
    expect(paneAfter).not.toBe(pane);
    expect(hostLog(host.id).filter((e) => e.launch === true)).toHaveLength(2);

    // 5. The stop ends the session on the host and its tunnel.
    const stopped = await lead('stop_agent', { id: REMOTE, reason: 'its task on the host is done' });
    keep({ stopped });
    expect(stopped.isError, stopped.text).toBe(false);
    await expect.poll(() => onHost(host.id, `tmux has-session -t tars-${REMOTE}`).code, { timeout: 30_000 }).not.toBe(0);
    await expect.poll(() => onHost(host.id, `curl -s -m 2 http://127.0.0.1:${rport}/api/health || echo closed`).out, { timeout: 30_000 }).toBe('closed');
    await expect.poll(async () => (await agent(REMOTE))?.status, { timeout: 30_000 }).toBe('stopped');

    // 6. Started again, its link dropped: the session goes on on the host, and the move back ends it there.
    const again = await lead('start_agent', { id: REMOTE, prompt: 'ECHO again' });
    keep({ again });
    expect(again.isError, again.text).toBe(false);
    await expect.poll(() => hostLog(host.id).some((e) => e.answer === 'echo again'), { timeout: 90_000 }).toBe(true);
    const terminalSsh = () => execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n')
      .filter((l) => / -tt /.test(l) && l.includes(SSH_ALIAS) && l.includes(REMOTE))
      .map((l) => Number(l.trim().split(/\s+/)[0]));
    const [sshPid] = terminalSsh();
    keep({ sshPid });
    expect(sshPid).toBeGreaterThan(0);
    process.kill(sshPid, 'SIGKILL');
    await expect.poll(() => terminalSsh().length, { timeout: 20_000 }).toBe(0);
    await sleep(1_000);
    expect(onHost(host.id, `tmux has-session -t tars-${REMOTE}`).code, 'the session on the host outlived its link').toBe(0);
    const back = await lead('update_agent', { id: REMOTE, remote: null });
    keep({ back });
    expect(back.isError, back.text).toBe(false);
    expect(back.text).not.toMatch(/could not end/);
    await expect.poll(() => onHost(host.id, `tmux has-session -t tars-${REMOTE}`).code, { timeout: 30_000 }).not.toBe(0);
    expect((await agent(REMOTE))?.remote).toBeUndefined();
    const removed = await page.evaluate((h) => (window as unknown as Win).electronAPI.remoteHosts.remove(h), HOST_ID);
    keep({ removed, hostLogAtEnd: hostLog(host.id) });
    expect(removed).toMatchObject({ success: true });
    expect(errors).toEqual([]);
  } finally {
    for (const s of servers) s.kill();
    recordValues(values);
    await app.close().catch(() => undefined);
    spawnSync('docker', ['rm', '-f', host.id]);
    await removeHome(home);
  }
});
