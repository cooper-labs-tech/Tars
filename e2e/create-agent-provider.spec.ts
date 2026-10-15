import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An agent makes another on any provider and any CLI, through its own MCP tool (2.0.2). JeanBrasse: "ça doit supporter
 * n'importe quel provider/cli", after an orchestrator answered him that its tool only made Claude agents.
 *
 * The real app on a sandbox HOME, and the real orchestrator MCP server (mcp-orchestrator/dist/bundle.js) run with
 * the identity Tars hands agent o1 (a token of its own, its id, its project, Tars's instance), spoken to over stdio
 * as Claude Code speaks to it. Settings name a recording stand-in as codex's CLI; a second stand-in is a CLI of
 * the agent's own choosing. Both record their argv and stay up, as a CLI would.
 *
 * Asserted:
 * 1. create_agent makes a codex agent with its model, effort and permission mode, and agents.json keeps them;
 * 2. start_agent starts it: the binary Settings name for codex runs, with the task, in the project;
 * 3. an agent on a cliPath of its own runs that binary, not the provider's;
 * 4. refused, each with its reason, and nothing made: an unknown provider (with the providers' ids), an API-key
 *    provider without its key, a cliPath that is not absolute, one that is not executable, and plan on a provider
 *    that has none (the Audit's Low 2 on #407).
 * The artefact: values.json (each tool's answer, agents.json's records, each launch) and launches.jsonl.
 */

test('an agent makes and starts an agent on any provider and any CLI through its own MCP tool', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-create-agent-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.dorothy');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const launchesFile = path.join(home, 'launches.jsonl');
  const standIn = (name: string) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(launchesFile)}, JSON.stringify({ bin: ${JSON.stringify(name)}, argv: process.argv.slice(2), cwd: process.cwd(), agent: process.env.CLAUDE_AGENT_ID || null }) + '\\n');
process.stdout.write('${name} ready\\r\\n');
setInterval(() => {}, 1 << 30);
`, { mode: 0o755 });
    return file;
  };
  const codexCli = standIn('codex');
  const ownCli = standIn('my-cli');
  const plainFile = path.join(bin, 'plain');
  fs.writeFileSync(plainFile, 'not a program', { mode: 0o644 });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'o1', name: 'Lead', character: 'robot', provider: 'claude', status: 'idle', role: 'orchestrator', permissionMode: 'normal',
    projectPath: project, skills: [], createdAt: '2026-10-14T08:00:00.000Z', lastActivity: '2026-10-14T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, cliPaths: { codex: codexCli } }));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  const port = apiPort(31454);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = { home, project };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  let mcp: ChildProcessWithoutNullStreams | undefined;
  try {
    await app.firstWindow();
    // What Tars hands o1's tools: a token naming o1, and the instance they check before sending it.
    const identity = await app.evaluate((_e, { dist }) => {
      const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
      return { token: tokens.mintRunToken('o1').token as string, instance: tokens.tarsInstanceId() as string };
    }, { dist });
    mcp = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
      env: {
        PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: identity.token,
        CLAUDE_AGENT_ID: 'o1', CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: identity.instance,
      },
    });
    const replies = new Map<number, (msg: { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown }) => void>();
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
    const rpc = (method: string, params: unknown) => new Promise<Parameters<NonNullable<ReturnType<typeof replies.get>>>[0]>((resolve) => {
      const id = nextId++;
      replies.set(id, resolve);
      mcp!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tool = async (name: string, args: Record<string, unknown>) => {
      const reply = await rpc('tools/call', { name, arguments: args });
      return { text: reply.result?.content?.map((c) => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
    };
    const idIn = (text: string) => /with ID: ([0-9a-f-]{36})/.exec(text)?.[1];
    const launches = () => (fs.existsSync(launchesFile) ? fs.readFileSync(launchesFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    // As Tars saves it: { version, savedAt, agents }.
    const records = () => {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')) as { agents?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
      return Array.isArray(saved) ? saved : saved.agents ?? [];
    };
    const recordOf = async (id: string) => {
      await expect.poll(() => records().some((a) => a.id === id), { timeout: 15_000 }).toBe(true);
      return records().find((a) => a.id === id)!;
    };

    // 1. A codex agent, with its model, effort and permission mode.
    const made = await tool('create_agent', { name: 'Tester', provider: 'codex', model: 'gpt-5-codex', effort: 'high', permissionMode: 'normal' });
    keep({ made });
    expect(made.isError).toBe(false);
    const codexId = idIn(made.text)!;
    expect(codexId).toBeTruthy();
    const codexRecord = await recordOf(codexId);
    keep({ codexRecord });
    expect(codexRecord).toMatchObject({ provider: 'codex', model: 'gpt-5-codex', effort: 'high', permissionMode: 'normal', projectPath: project });

    // 2. Started: codex's binary, as Settings name it, with the task, in the project.
    const started = await tool('start_agent', { id: codexId, prompt: 'CODEX>> run the tests' });
    keep({ started });
    expect(started.isError).toBe(false);
    await expect.poll(() => launches().filter((l) => l.agent === codexId).length, { timeout: 30_000 }).toBe(1);
    const codexLaunch = launches().find((l) => l.agent === codexId)!;
    keep({ codexLaunch });
    expect(codexLaunch.bin).toBe('codex');
    expect(codexLaunch.argv.join(' ')).toContain('CODEX>> run the tests');
    expect(codexLaunch.argv.join(' ')).toContain('gpt-5-codex');
    expect(fs.realpathSync(codexLaunch.cwd)).toBe(fs.realpathSync(project));

    // 3. A CLI of the agent's own: that binary runs, not the provider's.
    const own = await tool('create_agent', { name: 'Own CLI', provider: 'codex', cliPath: ownCli });
    keep({ own });
    const ownId = idIn(own.text)!;
    expect((await recordOf(ownId)).cliPath).toBe(ownCli);
    expect((await tool('start_agent', { id: ownId, prompt: 'OWN>> hello' })).isError).toBe(false);
    await expect.poll(() => launches().filter((l) => l.agent === ownId).map((l) => l.bin), { timeout: 30_000 }).toEqual(['my-cli']);

    // 4. Refused, each with its reason, and nothing made.
    const unknown = await tool('create_agent', { name: 'X', provider: 'nope' });
    const keyless = await tool('create_agent', { name: 'X', provider: 'openrouter' });
    const relative = await tool('create_agent', { name: 'X', cliPath: 'my-cli' });
    const notExecutable = await tool('create_agent', { name: 'X', cliPath: plainFile });
    // Plan on a provider that has none ran as normal, and edited once it had asked (the Audit's Low 2 on #407).
    const planless = await tool('create_agent', { name: 'X', provider: 'codex', permissionMode: 'plan' });
    keep({ unknown, keyless, relative, notExecutable, planless, finalRecords: records().map((a) => ({ id: a.id, provider: a.provider, cliPath: a.cliPath })) });
    for (const refused of [unknown, keyless, relative, notExecutable, planless]) expect(refused.isError).toBe(true);
    expect(planless.text).toContain('has no plan mode here: plan would run as manual');
    expect(unknown.text).toContain('Unknown provider "nope". Providers: amp, claude, codex,');
    expect(unknown.text).toContain('custom-openai');
    expect(keyless.text).toContain('No API key configured for provider "openrouter"');
    expect(relative.text).toContain('absolute path');
    expect(notExecutable.text).toContain('is not executable');
    expect(records().map((a) => a.id).sort()).toEqual(['o1', codexId, ownId].sort());
  } finally {
    mcp?.kill();
    await app.close();
    if (fs.existsSync(launchesFile)) fs.copyFileSync(launchesFile, test.info().outputPath('launches.jsonl'));
    await removeHome(home);
  }
});
