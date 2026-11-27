import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { posixWords } from '../../../electron/platform/posix-words';
import { orchestratorToolFlags, workerPeerFlags } from '../../../electron/providers/cli-provider';

/**
 * A worker's door to the other sessions of the machine, shut (the owner's decision of 26/11 on the Audit's C1 of the
 * agent-inbox plan: "garder pour les orchestrateurs, mais il faut vérifier ça pour tous les cli, pas que claude code").
 * A worker takes no message from another session and has no tool that reaches one; an orchestrator, its project's or a
 * chat's runner (core/agent-role.ts, hasOrchestratorPowers), keeps what its CLI and the user's own settings give it.
 * What each CLI opens, and how it was measured, is in SECURITY.md, "What other sessions can send an agent".
 *
 * How it fails, written before the code (2026-11-27):
 * 1. A worker's claude starts with its inbox open: a post from any other process of the user's reaches it, and
 *    between two sessions in bypass with no review at all (measured on 2.1.332).
 * 2. A worker keeps ListAgents and SendMessage, the tools that list and reach the other sessions.
 * 3. An orchestrator loses its channel, or is handed a setting the user did not choose: nothing of the kind is on its
 *    line, and its own settings decide.
 * 4. The setting is written into a file of the user's (~/.claude/settings.json) rather than a source Tars owns: it
 *    rides on the command line, and building one writes nothing under ~/.claude.
 * 5. The setting's JSON is split or altered on its way to claude: by the shell on macOS and Linux, by the closed
 *    grammar of platform/posix-words.ts on Windows. Both read the same words.
 * 6. The orchestrator's own restriction (editing tools and Task away) lost, or given to a worker with this one.
 * 7. One of the providers that run the claude binary builds a worker's line without it.
 * 8. Tars's own one-shot claude (a kanban card's text) offered ListAgents (measured in print mode, 2.1.332), or its
 *    prompt taken for a tool's name by --disallowed-tools, which takes every word after it.
 * 9. A codex worker reached through the queue every codex of a CODEX_HOME reads (`codex queue --thread <id>`, a
 *    table in queue_1.sqlite), or through the shared app-server daemon it joins. Measured on 0.163: with its databases
 *    in a folder of its own (`-c sqlite_home=`) neither reaches it, and `codex resume <id>` still finds its thread
 *    from the rollout files, with those databases or without them. An orchestrator keeps the shared ones.
 * 10. Two workers sharing that folder, or its path not read as one TOML string (a Windows path's backslashes).
 * 11. A Qwen Code worker's inbox open (an orchestrator's took another yolo session's post unreviewed, measured on
 *     0.25.2): the settings file of Tars's that it runs with says agents.crossSessionMessaging false, and with it
 *     its session record has no inbox; an orchestrator's file says nothing of it; an administrator's value stands.
 */

const SETTING = JSON.stringify({ crossSessionInbound: 'refuse' });

/** The words of a line, as Windows reads them (posix-words) and as /bin/sh does for these quotes. */
function wordsOf(line: string): string[] {
  return posixWords(line);
}

describe('the flags of a worker of the claude binary', () => {
  it('1, 2. a worker: inbound posts refused, the two tools gone', () => {
    const words = wordsOf(`'claude'${workerPeerFlags(false)}`);
    const at = words.indexOf('--settings');
    expect(at, 'no --settings on a worker').toBeGreaterThan(0);
    expect(JSON.parse(words[at + 1])).toEqual({ crossSessionInbound: 'refuse' });
    const tools = words.indexOf('--disallowed-tools');
    expect(words.slice(tools + 1)).toEqual(expect.arrayContaining(['SendMessage', 'ListAgents']));
    expect(workerPeerFlags(undefined), 'no role said is a worker').toBe(workerPeerFlags(false));
  });

  it('3. an orchestrator: nothing of it', () => {
    expect(workerPeerFlags(true)).toBe('');
  });
});

describe('every provider that runs the claude binary', () => {
  async function claudeBinaryProviders() {
    const { getAllProviders } = await import('../../../electron/providers');
    return getAllProviders().filter(p => p.binaryName === 'claude');
  }

  it('7, 5. a worker\'s line carries the setting whole and the two tools away; an orchestrator\'s neither', async () => {
    const providers = await claudeBinaryProviders();
    expect(providers.length).toBeGreaterThanOrEqual(14);
    for (const provider of providers) {
      const params = { binaryPath: 'claude', prompt: 'Fix the build', permissionMode: 'bypass' as const };
      const worker = wordsOf(provider.buildInteractiveCommand({ ...params, orchestratorMode: false }));
      const at = worker.indexOf('--settings');
      expect(at, `${provider.id} starts a worker with its inbox open`).toBeGreaterThan(0);
      expect(worker[at + 1], `${provider.id}: the setting altered on its way`).toBe(SETTING);
      expect(worker, `${provider.id} leaves a worker ListAgents`).toContain('ListAgents');
      expect(worker, `${provider.id} leaves a worker SendMessage`).toContain('SendMessage');

      const orchestrator = wordsOf(provider.buildInteractiveCommand({ ...params, orchestratorMode: true }));
      expect(orchestrator, `${provider.id} hands an orchestrator a setting`).not.toContain('--settings');
      expect(orchestrator, `${provider.id} takes an orchestrator's ListAgents`).not.toContain('ListAgents');
    }
  });

  it('6. the orchestrator keeps its own restriction; a worker keeps its editing tools', async () => {
    for (const provider of await claudeBinaryProviders()) {
      const params = { binaryPath: 'claude', prompt: 'Fix the build' };
      expect(provider.buildInteractiveCommand({ ...params, orchestratorMode: true })).toContain(orchestratorToolFlags(true).trim());
      const worker = wordsOf(provider.buildInteractiveCommand({ ...params, orchestratorMode: false }));
      for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Task']) expect(worker, `${provider.id} takes a worker's ${tool}`).not.toContain(tool);
    }
  });

  it('4. building a worker\'s line writes nothing into the user\'s claude settings', async () => {
    const settings = path.join(os.homedir(), '.claude', 'settings.json');
    const before = fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : null;
    for (const provider of await claudeBinaryProviders()) provider.buildInteractiveCommand({ binaryPath: 'claude', prompt: 'x', orchestratorMode: false });
    const after = fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : null;
    expect(after).toBe(before);
  });

  it('8. Tars\'s own one-shot claude is no session\'s peer either', async () => {
    const { getProvider } = await import('../../../electron/providers');
    const words = wordsOf(getProvider('claude').buildOneShotCommand({ binaryPath: 'claude', prompt: 'Make a card of: fix the build', model: 'haiku' }));
    expect(words[words.indexOf('--settings') + 1]).toBe(SETTING);
    expect(words).toContain('ListAgents');
    // After `--`: --disallowed-tools takes every word that follows it, the prompt too without one.
    expect(words.slice(-2)).toEqual(['--', 'Make a card of: fix the build']);
  });
});

describe('a codex worker', () => {
  /** The value of a `-c key=value` of the line, or undefined. */
  function configValue(line: string, key: string): string | undefined {
    const words = posixWords(line);
    for (let i = 0; i < words.length - 1; i++) {
      if (words[i] === '-c' && words[i + 1].startsWith(`${key}=`)) return words[i + 1].slice(key.length + 1);
    }
    return undefined;
  }

  async function line(params: { agentId?: string; orchestratorMode?: boolean }) {
    const { CodexProvider } = await import('../../../electron/providers/codex-provider');
    const was = Object.getOwnPropertyDescriptor(process, 'platform')!;
    // The Windows line: the binary first, no `env` (codex-commands.test.ts, 8), so posix-words reads all of it.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      return new CodexProvider().buildInteractiveCommand({ binaryPath: 'codex', prompt: 'Fix the build', permissionMode: 'bypass', ...params });
    } finally {
      Object.defineProperty(process, 'platform', was);
    }
  }

  it('9. a worker runs on databases of its own, a folder of its agent\'s that exists; an orchestrator on the shared ones', async () => {
    const value = configValue(await line({ agentId: 'agent-w1', orchestratorMode: false }), 'sqlite_home');
    expect(value, 'a codex worker reads the shared queue').toBeDefined();
    const dir = JSON.parse(value!);
    expect(path.isAbsolute(dir)).toBe(true);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(dir.startsWith(path.join(os.homedir(), '.tars', 'tmp') + path.sep)).toBe(true);
    expect(configValue(await line({ agentId: 'agent-o1', orchestratorMode: true }), 'sqlite_home')).toBeUndefined();
  });

  it('10. two workers, two folders; the same worker, the same one; the path a TOML string, backslashes and all', async () => {
    const one = JSON.parse(configValue(await line({ agentId: 'agent-w1' }), 'sqlite_home')!);
    const two = JSON.parse(configValue(await line({ agentId: 'agent-w2' }), 'sqlite_home')!);
    expect(one).not.toBe(two);
    expect(JSON.parse(configValue(await line({ agentId: 'agent-w1' }), 'sqlite_home')!)).toBe(one);
    // A basic TOML string is a JSON string: a Windows path's backslashes go escaped, and come back whole.
    const { codexSqliteHomeArg } = await import('../../../electron/providers/codex-cli');
    expect(codexSqliteHomeArg('C:\\Users\\me\\.tars\\tmp\\0a1b2c3d4e\\codex')).toBe('sqlite_home="C:\\\\Users\\\\me\\\\.tars\\\\tmp\\\\0a1b2c3d4e\\\\codex"');
  });

  it('9. a worker with no agent id still gets a folder of its own, never the shared queue', async () => {
    const value = configValue(await line({}), 'sqlite_home');
    expect(value).toBeDefined();
    expect(JSON.parse(value!)).not.toBe(JSON.parse(configValue(await line({}), 'sqlite_home')!));
  });
});

describe('a Qwen Code worker', () => {
  let dataDir: string;
  let admin: string;
  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-peers-'));
    dataDir = path.join(root, 'qwen-code');
    admin = path.join(root, 'system', 'settings.json');
  });
  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

  it('11. a worker\'s file turns cross-session messaging off; an orchestrator\'s says nothing of it', async () => {
    const { writeQwenAgentSettings } = await import('../../../electron/services/qwen-code');
    expect(read(writeQwenAgentSettings('w1', { systemFile: admin, orchestratorMode: false }, dataDir)).agents).toEqual({ crossSessionMessaging: false });
    expect(read(writeQwenAgentSettings('w2', { systemFile: admin }, dataDir)).agents, 'no role said is a worker').toEqual({ crossSessionMessaging: false });
    expect(read(writeQwenAgentSettings('o1', { systemFile: admin, orchestratorMode: true }, dataDir)).agents).toBeUndefined();
  });

  it('11. an administrator\'s own value stands, as every other of theirs', async () => {
    const { writeQwenAgentSettings } = await import('../../../electron/services/qwen-code');
    fs.mkdirSync(path.dirname(admin), { recursive: true });
    fs.writeFileSync(admin, JSON.stringify({ agents: { crossSessionMessaging: true, crossSessionInbound: 'hold' } }));
    expect(read(writeQwenAgentSettings('w1', { systemFile: admin, orchestratorMode: false }, dataDir)).agents).toEqual({ crossSessionMessaging: true, crossSessionInbound: 'hold' });
  });

  it('11. the line and the terminal\'s environment write the same file for the same role', async () => {
    const { QwenCodeProvider } = await import('../../../electron/providers/qwen-code-provider');
    const provider = new QwenCodeProvider();
    const env = provider.getPtyEnvVars('qw-1', '/p', [], undefined, { orchestratorMode: false });
    expect(read(env.QWEN_CODE_SYSTEM_SETTINGS_PATH).agents).toEqual({ crossSessionMessaging: false });
    provider.buildInteractiveCommand({ agentId: 'qw-1', binaryPath: 'qwen', prompt: '', orchestratorMode: true });
    expect(read(env.QWEN_CODE_SYSTEM_SETTINGS_PATH).agents).toBeUndefined();
    provider.getPtyEnvVars('qw-1', '/p', [], undefined, { orchestratorMode: true });
    expect(read(env.QWEN_CODE_SYSTEM_SETTINGS_PATH).agents).toBeUndefined();
  });
});
