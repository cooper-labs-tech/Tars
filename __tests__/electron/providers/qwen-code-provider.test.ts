import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Qwen Code as a CLI of Tars's (2.0.4): provider `qwen-code`, binary `qwen`,
 * beside the provider `qwen`, which is the Qwen API through the claude binary
 * and stays. Measured on 2026-10-18 with qwen 0.25.2 on deepseek-v4-flash:
 * `-i` keeps the session after its first prompt (a positional prompt is
 * one-shot); `--resume <id>` continues one; `--approval-mode
 * plan|default|auto-edit|yolo`; Claude Code's hooks (SessionStart,
 * UserPromptSubmit, Stop, StopFailure, Notification, PermissionRequest), fed
 * the same fields; a settings file named by QWEN_CODE_SYSTEM_SETTINGS_PATH,
 * read above the user's (hooks concatenated), which carries the hooks, the MCP
 * servers and `model.reasoningEffort` (the status bar read "low"); MCP servers
 * get qwen's whole environment (the agent's identity) and their own `env`;
 * transcripts in ~/.qwen/projects/<cwd, every non-alphanumeric a dash>/chats/
 * <session>.jsonl, `parts` of text with `usageMetadata`.
 *
 * Every way it can fail, written before the code:
 *  Q1. The task is passed as a positional prompt, which qwen runs once and
 *      exits: the agent is gone with its task. Or a model that is no model
 *      id reaches the command line.
 *  Q2. A permission mode is not carried, or onto the wrong approval mode
 *      (normal must ask, bypass must not).
 *  Q3. A Tars restart starts a new conversation, or resumes with a flag qwen
 *      has not (Claude's --fork-session reaches it bare).
 *  Q4. An orchestrator on qwen keeps its edit, write and sub-agent tools.
 *  Q5. The models offered are not the ones in the user's ~/.qwen/settings.json
 *      modelProviders, or reading them writes that file, or a file missing or
 *      broken throws.
 *  Q6. The agent does not get its key under its model's envKey, or the key
 *      lands in the command line or in a file.
 *  Q7. Its settings file of Tars's is missing a hook Tars needs to see turns,
 *      rests, failures and permission dialogs, names hooks that cannot run on
 *      the platform, carries no MCP server of Tars's, holds a token or a key,
 *      leaves qwen's own updater on, or ignores the agent's effort; or the
 *      user's ~/.qwen/settings.json is written.
 *  Q8. Registering Tars's MCP servers writes into ~/.qwen.
 *  Q9. `qwen-code` falls back to Claude, or `qwen` (the Qwen API) is replaced.
 *  Q10. Tars does not hear its turns (they read as never ending), or reads no
 *      answer, no tokens and no resume from its transcript, or reads the
 *      thinking as the answer.
 *  Q11. (The Audit's L1 on #462, written before its code.) A model's baseUrl
 *      carrying credentials (`https://user:key@host`, `?api_key=...`) reaches
 *      the window whole in its description (models:cli).
 *  Q12. (The Audit's L1 on #461, written before its code.) Esc in a qwen turn
 *      sends no Stop: Tars never sees the turn cut, and a delegated task ends
 *      `completed` instead of `interrupted`. What qwen 0.25.2 writes, measured
 *      on 2026-10-18 (~/Documents/Tars-revue-2026-09-24/runs/qwen-fixes-1810):
 *      a system ui_telemetry record, request_lifecycle, phase ended, outcome
 *      cancelled, 146 ms after the Esc. A tool call the user refused is
 *      cancelled too, and is no cut turn.
 *  Q13. (L4) An agent id is used raw as its settings file's name: one with a
 *      `/` or `..` writes outside Tars's folder.
 *  Q14. (L4) `--resume` is handed an id that is not a session's: it must be
 *      the UUID qwen names its transcripts by, or nothing.
 *  Q15. (The QA's BLOCK at af9ff3da, 19/10) A project reached through a link
 *      (anything under macOS's /var or /tmp): qwen files its transcript under
 *      the real path it runs in, and the cut is looked for under the saved
 *      spelling alone, so an Esc never ends the delegated task. Every other
 *      reader of a qwen transcript tries both (transcriptRoots).
 */

import { getProvider } from '../../../electron/providers';
import {
  qwenProjectDir, qwenTranscriptPath, qwenModels, qwenApprovalMode, qwenHookTable, QWEN_ORCHESTRATOR_EXCLUDED,
  writeQwenAgentSettings,
} from '../../../electron/services/qwen-code';
import { lastInterruptAt } from '../../../electron/services/agent-truth';
import { hasEndOfTurn } from '../../../electron/core/end-of-turn';
import { readFinalAnswer } from '../../../electron/services/terminal-answer';
import { readTaskCosts, clearTaskCostCache } from '../../../electron/services/task-cost';
import { resolveResumeSessionId } from '../../../electron/utils/resume-session';
import { withCliKey } from '../../../electron/services/cli-keys';
import { DATA_DIR } from '../../../electron/constants';
import type { AppSettings } from '../../../electron/types';
import type { TaskRecord } from '../../../electron/services/task-ledger';

const home = () => os.homedir();
const USER_SETTINGS = {
  env: { DEEPSEEK_API_KEY: 'user-own-key' },
  model: { name: 'deepseek-v4-pro' },
  modelProviders: { openai: [
    { id: 'deepseek-v4-pro', name: '[DeepSeek] deepseek-v4-pro', baseUrl: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY' },
    { id: 'deepseek-v4-flash', name: '[DeepSeek] deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY' },
  ], anthropic: [{ id: 'kimi-k3', name: 'Kimi', envKey: 'MOONSHOT_API_KEY' }] },
};
function userSettings(content: unknown = USER_SETTINGS) {
  fs.mkdirSync(path.join(home(), '.qwen'), { recursive: true });
  const file = path.join(home(), '.qwen', 'settings.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}
const provider = () => getProvider('qwen-code' as never);
const base = { binaryPath: '/opt/qwen', prompt: '' };

beforeEach(() => {
  fs.rmSync(path.join(home(), '.qwen'), { recursive: true, force: true });
  clearTaskCostCache();
});

describe('the qwen-code provider', () => {
  it('Q9. qwen-code is Qwen Code, on the binary qwen; qwen stays the Qwen API on the claude binary', () => {
    expect(provider()).toMatchObject({ id: 'qwen-code', displayName: 'Qwen Code', binaryName: 'qwen' });
    expect(getProvider('qwen').binaryName).toBe('claude');
  });

  it('Q1. its task goes with -i, the session staying; no task, no prompt; a model that is no id is refused', () => {
    const cmd = provider().buildInteractiveCommand({ ...base, prompt: 'review the notes', model: 'deepseek-v4-flash' });
    expect(cmd).toContain("-i 'review the notes'");
    expect(cmd).toContain("-m 'deepseek-v4-flash'");
    expect(cmd, 'a positional prompt runs one-shot').toMatch(/ -i 'review the notes'$/);
    expect(provider().buildInteractiveCommand(base)).not.toContain(' -i ');
    expect(() => provider().buildInteractiveCommand({ ...base, model: 'x; rm -rf /' })).toThrow();
  });

  it('Q2. each permission mode onto its approval mode', () => {
    expect(qwenApprovalMode('plan')).toBe('plan');
    expect(qwenApprovalMode('normal')).toBe('default');
    expect(qwenApprovalMode(undefined)).toBe('default');
    expect(qwenApprovalMode('auto')).toBe('auto-edit');
    expect(qwenApprovalMode('bypass')).toBe('yolo');
    expect(provider().buildInteractiveCommand({ ...base, permissionMode: 'bypass' })).toContain('--approval-mode yolo');
    expect(provider().buildInteractiveCommand({ ...base, permissionMode: 'normal' })).toContain('--approval-mode default');
  });

  it('Q3. a session resumes by its id, and a fork with --fork-session beside it', () => {
    const id = '0f9b3c1e-1234-4abc-8def-0123456789ab';
    expect(provider().buildInteractiveCommand({ ...base, resumeSessionId: id })).toContain(`--resume '${id}'`);
    const forked = provider().buildInteractiveCommand({ ...base, resumeSessionId: id, forkSession: true });
    expect(forked).toContain(`--resume '${id}'`);
    expect(forked).toContain('--fork-session');
    expect(provider().buildInteractiveCommand({ ...base, forkSession: true })).not.toContain('--fork-session');
  });

  it('Q4. an orchestrator has no edit, write, sub-agent, code search or web tool, and keeps reading and its shell', () => {
    const cmd = provider().buildInteractiveCommand({ ...base, orchestratorMode: true });
    // Qwen Code 0.25.2's ToolNames: the work is its agents' (2.0.7), as for claude (orchestrator-tools.test.ts).
    for (const tool of ['edit', 'notebook_edit', 'write_file', 'agent', 'grep_search', 'glob', 'web_fetch', 'web_search']) expect(QWEN_ORCHESTRATOR_EXCLUDED).toContain(tool);
    for (const tool of ['read_file', 'run_shell_command', 'list_directory']) expect(QWEN_ORCHESTRATOR_EXCLUDED).not.toContain(tool);
    expect(cmd).toContain(`--exclude-tools ${QWEN_ORCHESTRATOR_EXCLUDED.join(' ')}`);
    expect(provider().buildInteractiveCommand(base)).not.toContain('--exclude-tools');
  });

  it('Q5. its models are the user\'s modelProviders, read without writing, and nothing breaks without them', () => {
    const file = userSettings();
    const before = fs.readFileSync(file, 'utf8');
    const ids = qwenModels().map((m) => m.id);
    expect(ids).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash', 'kimi-k3']);
    expect(provider().getModels().map((m) => m.id)).toEqual(ids);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    userSettings('{ broken');
    expect(qwenModels()).toEqual([]);
    fs.rmSync(path.join(home(), '.qwen'), { recursive: true });
    expect(qwenModels()).toEqual([]);
  });

  it('Q11. a model\'s address reaches the window without its credentials', () => {
    userSettings({ modelProviders: { openai: [
      { id: 'm1', baseUrl: 'https://user:s3cret-key@llm.example.com/v1?api_key=s3cret-q&x=1#frag' },
      { id: 'm2', baseUrl: 'not a url, s3cret-raw' },
      { id: 'm3', baseUrl: 'https://api.deepseek.com' },
    ] } });
    const models = qwenModels();
    expect(JSON.stringify(models)).not.toMatch(/s3cret|user/);
    expect(models.find((m) => m.id === 'm1')?.description).toBe('openai, https://llm.example.com/v1');
    expect(models.find((m) => m.id === 'm2')?.description).toBe('openai');
    expect(models.find((m) => m.id === 'm3')?.description).toBe('openai, https://api.deepseek.com');
  });

  it('Q12. a turn cut with Esc reads as cut, from qwen\'s own transcript, and a refused tool call does not', () => {
    const sid = '1c0ffee0-1234-4abc-8def-0123456789ab';
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-esc-'));
    const file = qwenTranscriptPath(project, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const telemetry = (uiEvent: Record<string, unknown>) => JSON.stringify({ sessionId: sid, type: 'system', subtype: 'ui_telemetry', systemPayload: { uiEvent } });
    const refused = telemetry({ 'event.name': 'qwen-code.tool_call', status: 'cancelled', decision: 'reject', 'event.timestamp': '2026-10-18T12:50:42.993Z' });
    const finished = telemetry({ kind: 'request', 'event.name': 'request_lifecycle', phase: 'ended', outcome: 'completed', endedAt: 1792350000000 });
    fs.writeFileSync(file, [refused, finished].join('\n') + '\n');
    const agent = { provider: 'qwen-code', currentSessionId: sid, projectPath: project };
    expect(lastInterruptAt(agent), 'a refused tool call or a finished turn read as a cut').toBeUndefined();
    fs.appendFileSync(file, telemetry({ kind: 'request', 'event.name': 'request_lifecycle', phase: 'ended', outcome: 'cancelled', endedAt: 1792351006222 }) + '\n');
    expect(lastInterruptAt(agent)).toBe(1792351006222);
  });

  it('Q15. a turn cut with Esc reads as cut when qwen filed its transcript under the real path of a linked project', () => {
    const sid = '2c0ffee0-1234-4abc-8def-0123456789ab';
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-esc-link-')));
    const real = path.join(base, 'checkout');
    fs.mkdirSync(real);
    const linked = path.join(base, 'linked');
    fs.symlinkSync(real, linked, 'junction');
    const file = qwenTranscriptPath(real, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sessionId: sid, type: 'system', subtype: 'ui_telemetry', systemPayload: { uiEvent: { kind: 'request', 'event.name': 'request_lifecycle', phase: 'ended', outcome: 'cancelled', endedAt: 1792351006333 } } }) + '\n');
    expect(lastInterruptAt({ provider: 'qwen-code', currentSessionId: sid, projectPath: linked })).toBe(1792351006333);
  });

  it('Q13. an agent id never names a file outside Tars\'s folder', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-ids-'));
    for (const id of ['../../escape', 'a/b', '..', '/etc/passwd']) {
      const file = writeQwenAgentSettings(id, {}, dataDir);
      expect(path.dirname(file), id).toBe(path.join(dataDir, 'qwen-code', 'agents'));
      expect(path.basename(file), id).toMatch(/^[A-Za-z0-9_-]+\.json$/);
    }
  });

  it('Q14. --resume takes a session\'s id and nothing else', () => {
    for (const id of ["x'; touch /tmp/owned; '", 'not-a-session', '0f9b3c1e-1234-4abc-8def-0123456789ab --yolo']) {
      expect(provider().buildInteractiveCommand({ ...base, resumeSessionId: id }), id).not.toContain('--resume');
    }
  });

  it('Q6. its key under its model\'s envKey, in its environment only', () => {
    userSettings();
    const r = withCliKey({} as AppSettings, 'qwen-code', { key: 'tars-key-123' });
    if (!r.ok) throw new Error(r.error);
    const env = provider().getPtyEnvVars('a1', '/p', [], r.settings, { model: 'kimi-k3' });
    expect(env.MOONSHOT_API_KEY).toBe('tars-key-123');
    expect(provider().getPtyEnvVars('a1', '/p', [], r.settings, {}).DEEPSEEK_API_KEY).toBe('tars-key-123');
    expect(provider().buildInteractiveCommand({ ...base, prompt: 'x', appSettings: r.settings } as never)).not.toContain('tars-key-123');
    expect(fs.readFileSync(env.QWEN_CODE_SYSTEM_SETTINGS_PATH, 'utf8')).not.toContain('tars-key-123');
  });

  it('Q7. its settings file of Tars\'s: every hook, for its platform, Tars\'s MCP servers, its effort, no updater, no secret, and the user\'s file untouched', async () => {
    const file = userSettings();
    const before = fs.readFileSync(file, 'utf8');
    const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-hooks-'));
    for (const f of ['session-start.sh', 'user-prompt-submit.sh', 'on-stop.sh', 'stop-failure.sh', 'notification.sh', 'permission-request.sh', 'session-end.sh', 'post-tool-use.sh', 'tars-hook.mjs']) {
      fs.writeFileSync(path.join(hooksDir, f), '');
    }
    await provider().configureHooks(hooksDir);
    await provider().registerMcpServer('claude-mgr-orchestrator', '/usr/bin/node', ['/app/mcp-orchestrator/dist/bundle.js']);
    const env = provider().getPtyEnvVars('a1', '/p', [], { } as AppSettings, { effort: 'high' });
    const written = env.QWEN_CODE_SYSTEM_SETTINGS_PATH;
    expect(written.startsWith(DATA_DIR)).toBe(true);
    const s = JSON.parse(fs.readFileSync(written, 'utf8'));
    for (const ev of ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'PermissionRequest']) {
      expect(JSON.stringify(s.hooks[ev]), ev).toContain(hooksDir);
    }
    expect(s.mcpServers['claude-mgr-orchestrator']).toEqual({ command: '/usr/bin/node', args: ['/app/mcp-orchestrator/dist/bundle.js'] });
    expect(s.model).toEqual({ reasoningEffort: 'high' });
    expect(s.general).toEqual({ enableAutoUpdate: false });
    expect(JSON.stringify(s)).not.toMatch(/TOKEN|KEY|user-own-key/);
    expect(JSON.parse(fs.readFileSync(provider().getPtyEnvVars('a2', '/p', [], {} as AppSettings, {}).QWEN_CODE_SYSTEM_SETTINGS_PATH, 'utf8')).model).toBeUndefined();
    // On Windows the Node runner, never a .sh.
    const win = qwenHookTable(hooksDir, 'win32');
    expect(JSON.stringify(win)).toContain('tars-hook.mjs');
    expect(JSON.stringify(win)).not.toContain('.sh');
    expect(JSON.stringify(qwenHookTable(hooksDir, 'linux'))).toContain('on-stop.sh');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.join(home(), '.qwen'))).toEqual(['settings.json']);
  });

  it('Q8. registering and removing an MCP server never touches ~/.qwen', async () => {
    await provider().registerMcpServer('x-server', '/usr/bin/node', ['/x.js']);
    expect(provider().isMcpServerRegistered('x-server', '/x.js')).toBe(true);
    await provider().removeMcpServer('x-server');
    expect(provider().isMcpServerRegistered('x-server', '/x.js')).toBe(false);
    expect(fs.existsSync(path.join(home(), '.qwen'))).toBe(false);
  });

  it('Q10. its turns are heard, and its answer, tokens and resume read from its own transcript', async () => {
    expect(hasEndOfTurn({ provider: 'qwen-code' as never })).toBe(true);
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-proj-'));
    const sid = '0f9b3c1e-1234-4abc-8def-0123456789ab';
    expect(qwenProjectDir('/Users/a b/x_y.z', 'darwin')).toBe('-Users-a-b-x-y-z');
    expect(qwenProjectDir('C:\\Users\\Me\\P', 'win32')).toBe('c--users-me-p');
    const file = qwenTranscriptPath(project, sid);
    expect(file).toBe(path.join(home(), '.qwen', 'projects', qwenProjectDir(project), 'chats', `${sid}.jsonl`));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const t0 = Date.now();
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    fs.writeFileSync(file, [
      { type: 'user', timestamp: at(0), sessionId: sid, message: { role: 'user', parts: [{ text: 'review' }] } },
      { type: 'assistant', uuid: 'u1', timestamp: at(100), model: 'deepseek-v4-flash', message: { role: 'model', parts: [{ text: 'thinking hard', thought: true }, { functionCall: { name: 'x' } }] },
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50, thoughtsTokenCount: 10, cachedContentTokenCount: 800, totalTokenCount: 1060 } },
      { type: 'assistant', uuid: 'u2', timestamp: at(200), model: 'deepseek-v4-flash', message: { role: 'model', parts: [{ text: 'The notes are fine.' }] },
        usageMetadata: { promptTokenCount: 1100, candidatesTokenCount: 20, thoughtsTokenCount: 0, cachedContentTokenCount: 1000, totalTokenCount: 1120 } },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const task = { id: 't1', agentId: 'a1', provider: 'qwen-code', projectPath: project, worktreePath: null, sessionIds: [sid], startedAt: t0 - 1, endedAt: t0 + 300 };
    expect(await readFinalAnswer(task)).toBe('The notes are fine.');
    const costs = await readTaskCosts([{ ...task, model: 'deepseek-v4-flash', accountId: null, source: 'agent', requesterAgentId: null, parentTaskId: null, text: 'review', lastAt: t0, outcome: 'completed', turns: 1 } as unknown as TaskRecord]);
    const cost = costs.get('t1')!;
    expect(cost.from).toBe('transcript');
    expect(cost.tokens).toEqual({ input: 300, output: 80, cacheRead: 1800, cacheWrite: 0 });
    expect(cost.costUSD).toBeGreaterThan(0);
    expect(resolveResumeSessionId({ provider: 'qwen-code', resumableSessionId: sid, projectPath: project } as never)).toBe(sid);
    expect(resolveResumeSessionId({ provider: 'qwen-code', resumableSessionId: '0f9b3c1e-1234-4abc-8def-0123456789ac', projectPath: project } as never)).toBeNull();
  });
});
