import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRequire, syncBuiltinESMExports } from 'node:module';

import { pinPlatform } from './win-fake-disk';

/**
 * Gemini's own settings file, `~/.gemini/settings.json`, which Tars writes its hooks into at every start
 * (configureStatusHooks, main.ts) and its MCP servers into when `gemini mcp add` fails (the Audit's P-1 on #633).
 *
 * How gemini 0.70.0 reads it, read in its bundle (`npm pack @google/gemini-cli@0.70.0`, never run here):
 * `_doLoadSettings` parses each file as `JSON.parse(stripJsonComments(content))`, so `//` and block comments are
 * valid; a trailing comma is not (strip-json-comments called with no options); anything but an object is "Settings
 * file is not a valid JSON object." and read as nothing. Its own writer (`updateSettingsFilePreservingFormat`)
 * parses with comment-json and writes the comments back; an empty file is `{}` to it; a file it cannot parse is not
 * written ("Error parsing settings file. Please check the JSON syntax.").
 *
 * How it fails, written before the code:
 * 1. A file Tars cannot parse (a trailing comma, a half-written file) replaced by Tars's hooks alone, at every start
 *    of Tars, on macOS and Linux: the user's mcpServers, their auth and everything else gone. (On Windows such a file
 *    was left as it was.)
 * 2. A file with comments, which gemini reads, taken for an unreadable one (Tars's hooks never written there), or
 *    written back without its comments, or with the user's settings changed.
 * 3. An empty file, or one of blanks, which holds nothing, left without Tars's hooks.
 * 4. A file whose JSON is not an object (an array, a string, null, a number), which gemini reads as nothing,
 *    replaced by Tars's hooks rather than left as the user wrote it.
 * 5. A missing file, or a missing folder, no longer created with Tars's hooks.
 * 6. A concurrent writer (gemini, or the user saving it) whose change lands while Tars writes: lost under Tars's,
 *    rather than Tars's change made again on what the file holds now.
 * 7. A platform left out: the .sh wiring on macOS and Linux and the node runner's on Windows read and write the file
 *    differently.
 * 8. The MCP fallback (`gemini mcp add` failed) and the removal of a server read the file their own way: an
 *    unreadable file replaced by Tars's server alone, a commented one read as holding no server.
 * 9. Silence: the hooks not written and nothing said. The agent still starts, without Tars's hooks, so Tars hears
 *    neither its turns nor its answers: said in the log at Tars's start, and as a notice in the agent's output at each
 *    of its launches, which tries the hooks again first (a file fixed since needs no restart of Tars).
 * 10. (Found by the mutation bench, after the code: its read-back check had no case.) A file Tars's edits cannot
 *    express: a key written twice, which gemini reads as the last one while an edit lands in the first. Written all the
 *    same, gemini would never see Tars's hooks or its allow-list there. Left as it is, and said.
 *
 * Written before their code (the Audit's M1 on #634, 23/11):
 * 11. The window's MCP channels for gemini (`mcp:list`, `mcp:update`, `mcp:delete`, handlers/mcp-config-handlers.ts)
 *    read the file their own way, as plain JSON: a commented file, which gemini reads, lists no server, and saving or
 *    deleting one replaces the file with `mcpServers` alone (the user's auth and other settings gone, and Tars's
 *    hooks and the token's allow-list until its next start); a trailing comma does the same, and the window is told
 *    the save worked. Expected: listed as gemini reads it; a save or a deletion changes `mcpServers.<name>` and
 *    nothing else, the comments kept; a file gemini could not read either left byte for byte, and the answer the
 *    window shows says the file could not be read and nothing was saved; a deletion with no file creates none.
 * 12. A worker's allow-list (`--allowed-mcp-server-names`, services/mcp-roles.ts) read from the same file as plain
 *    JSON: a commented file gives the worker no allow-list at all, so the orchestrator's own servers reach it.
 */

let tmpDir: string;
let unpin: () => void;
let mockExecFileSync: ReturnType<typeof vi.fn>;

type PageAnswer = { success?: boolean; error?: string; servers?: Array<{ name: string; command: string; args: string[] }> };
const ipcHandlers = vi.hoisted(() => new Map<string, (event: unknown, params: Record<string, unknown>) => Promise<PageAnswer>>());
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, h: never) => { ipcHandlers.set(channel, h); } } }));

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => tmpDir };
});
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecFileSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

const nodeFs = createRequire(import.meta.url)('fs') as typeof fs;
const settingsPath = () => path.join(tmpDir, '.gemini', 'settings.json');
const hooksDir = () => path.join(tmpDir, 'tars-hooks');
const HOOK_FILES = ['post-tool-use', 'on-stop', 'session-start', 'session-end', 'notification', 'user-prompt-submit'];

beforeEach(() => {
  vi.resetModules();
  unpin = pinPlatform('linux');
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-settings-')));
  fs.mkdirSync(path.join(hooksDir(), 'gemini'), { recursive: true });
  for (const name of HOOK_FILES) for (const ext of ['.sh', '.cmd']) fs.writeFileSync(path.join(hooksDir(), 'gemini', `${name}${ext}`), '');
  fs.writeFileSync(path.join(hooksDir(), 'tars-hook.mjs'), '');
  // No gemini on PATH: its `mcp add` fails, and the fallback writes the file.
  mockExecFileSync = vi.fn(() => { throw new Error('gemini: command not found'); });
});

afterEach(() => {
  vi.restoreAllMocks();
  unpin();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function provider() {
  const { GeminiProvider } = await import('../../../electron/providers/gemini-provider');
  return new GeminiProvider();
}
function seed(text: string): void {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), text);
}
const read = () => fs.readFileSync(settingsPath(), 'utf-8');
/** As gemini 0.70.0 reads it: its comments out, then strict JSON. */
function asGeminiReads(text: string): Record<string, unknown> {
  const stripped = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => (str ? m : ' '.repeat(m.length)));
  return JSON.parse(stripped);
}
const hookCommands = (settings: Record<string, unknown>) => JSON.stringify((settings as { hooks?: unknown }).hooks ?? {});

const USERS = '{\n  "mcpServers": { "mine": { "command": "my-server" } },\n  "security": { "auth": { "selectedType": "oauth-personal" } }\n}\n';
const UNPARSEABLE = [
  ['a trailing comma', '{\n  "mcpServers": { "mine": { "command": "my-server" } },\n  "theme": "Dracula",\n}\n'],
  ['a half-written file', '{\n  "mcpServers": { "mine": { "command": "my-ser'],
] as const;
const COMMENTED = [
  '// My gemini settings, kept by hand.',
  '{',
  '  /* the servers I use */',
  '  "mcpServers": { "mine": { "command": "my-server" } }, // mine',
  '  "security": { "auth": { "selectedType": "oauth-personal" } }',
  '}',
  '',
].join('\n');

describe("gemini's settings file and Tars's hooks", () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    describe(`on ${platform} (7)`, () => {
      beforeEach(() => { unpin(); unpin = pinPlatform(platform); });

      for (const [what, text] of UNPARSEABLE) {
        it(`1. ${what}: left byte for byte, and said`, async () => {
          seed(text);
          const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
          await (await provider()).configureHooks(hooksDir(), platform);
          expect(read(), 'the user\'s settings were replaced').toBe(text);
          expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/settings\.json/);
        });
      }

      it('2. one with comments: Tars\'s hooks written, the comments and the user\'s settings kept', async () => {
        seed(COMMENTED);
        await (await provider()).configureHooks(hooksDir(), platform);
        const text = read();
        for (const comment of ['// My gemini settings, kept by hand.', '/* the servers I use */', '// mine']) {
          expect(text, comment).toContain(comment);
        }
        const settings = asGeminiReads(text);
        expect(settings.mcpServers).toEqual({ mine: { command: 'my-server' } });
        expect((settings.security as { auth: unknown }).auth).toEqual({ selectedType: 'oauth-personal' });
        expect(hookCommands(settings)).toMatch(/session-start/);
        expect((settings.security as { environmentVariableRedaction: { allowed: string[] } }).environmentVariableRedaction.allowed).toContain('CLAUDE_MGR_API_TOKEN');
      });

      for (const [what, text] of [['empty', ''], ['blank', '  \n\n']] as const) {
        it(`3. an ${what} file: Tars's hooks written into it`, async () => {
          seed(text);
          await (await provider()).configureHooks(hooksDir(), platform);
          expect(hookCommands(asGeminiReads(read()))).toMatch(/session-start/);
        });
      }

      for (const text of ['[]\n', '"settings"\n', 'null\n', '42\n']) {
        it(`4. JSON that is no object (${text.trim()}): left as it is`, async () => {
          seed(text);
          vi.spyOn(console, 'warn').mockImplementation(() => {});
          await (await provider()).configureHooks(hooksDir(), platform);
          expect(read()).toBe(text);
        });
      }

      it('5. no file, nor folder: created with Tars\'s hooks', async () => {
        await (await provider()).configureHooks(hooksDir(), platform);
        expect(hookCommands(asGeminiReads(read()))).toMatch(/session-start/);
      });
    });
  }

  it('10. a key written twice: the edit would land where gemini does not read, so the file is left as it is, and said', async () => {
    const twice = '{\n  "security": { "auth": { "selectedType": "a" } },\n  "mcpServers": { "mine": { "command": "my-server" } },\n  "security": { "auth": { "selectedType": "oauth-personal" } }\n}\n';
    seed(twice);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await (await provider()).configureHooks(hooksDir(), 'linux');
    expect(read()).toBe(twice);
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/read back differently/);
  });

  it('6. a writer whose change lands while Tars writes: kept, and Tars\'s hooks made again on it', async () => {
    seed(USERS);
    const original = nodeFs.writeFileSync;
    let wrote = false;
    nodeFs.writeFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      // gemini saves its theme at the moment Tars writes its temp file beside the settings.
      if (!wrote && typeof file === 'string' && file.startsWith(`${settingsPath()}.tars-`)) {
        wrote = true;
        (original as (...a: unknown[]) => void)(settingsPath(), USERS.replace('{\n', '{\n  "ui": { "theme": "Dracula" },\n'));
      }
      return (original as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.writeFileSync;
    syncBuiltinESMExports();
    try {
      await (await provider()).configureHooks(hooksDir(), 'linux');
    } finally {
      nodeFs.writeFileSync = original;
      syncBuiltinESMExports();
    }
    expect(wrote, 'the other writer never ran: the case proves nothing').toBe(true);
    const settings = asGeminiReads(read());
    expect(settings.ui, 'the other writer\'s change was lost').toEqual({ theme: 'Dracula' });
    expect(hookCommands(settings)).toMatch(/session-start/);
    expect(settings.mcpServers).toEqual({ mine: { command: 'my-server' } });
  });
});

describe("gemini's MCP servers in the same file, when `gemini mcp add` fails (8)", () => {
  for (const [what, text] of UNPARSEABLE) {
    it(`${what}: left byte for byte, never replaced by Tars's server alone`, async () => {
      seed(text);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      await (await provider()).registerMcpServer('claude-mgr-orchestrator', 'node', ['/app/bundle.js']);
      expect(read()).toBe(text);
    });
  }

  it('a commented file: the server added, read back and removed, the comments kept', async () => {
    seed(COMMENTED);
    const p = await provider();
    await p.registerMcpServer('claude-mgr-orchestrator', 'node', ['/app/bundle.js']);
    expect(read()).toContain('/* the servers I use */');
    expect(asGeminiReads(read()).mcpServers).toEqual({ mine: { command: 'my-server' }, 'claude-mgr-orchestrator': { command: 'node', args: ['/app/bundle.js'] } });
    expect(p.isMcpServerRegistered('claude-mgr-orchestrator', '/app/bundle.js')).toBe(true);
    await p.removeMcpServer('claude-mgr-orchestrator');
    expect(asGeminiReads(read()).mcpServers).toEqual({ mine: { command: 'my-server' } });
    expect(read()).toContain('// mine');
  });
});

describe('what the agent and the user are told (9)', () => {
  async function noticesOf(run: () => Promise<void> | void): Promise<Array<{ agentId: string; line: string }>> {
    const said: Array<{ agentId: string; line: string }> = [];
    const notices = await import('../../../electron/core/agent-notices');
    notices.setAgentNoticeSink((agentId: string, line: string) => { said.push({ agentId, line }); });
    await run();
    return said;
  }
  const launch = (p: Awaited<ReturnType<typeof provider>>, agentId: string) =>
    p.buildInteractiveCommand({ binaryPath: '/usr/bin/gemini', prompt: '', agentId } as Parameters<typeof p.buildInteractiveCommand>[0]);

  it('an unreadable file: the start of Tars says it in the log, and each launch of a gemini agent in its output', async () => {
    seed(UNPARSEABLE[0][1]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = await provider();
    await p.configureHooks(hooksDir(), 'linux');
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/hooks.*not|not.*hooks/i);
    const said = await noticesOf(() => { launch(p, 'agent-g1'); });
    expect(said).toHaveLength(1);
    expect(said[0].agentId).toBe('agent-g1');
    expect(said[0].line).toMatch(/settings\.json/);
    expect(said[0].line).toMatch(/turns/);
    expect(said[0].line).not.toMatch(/[\u2013\u2014]/);
    expect(read()).toBe(UNPARSEABLE[0][1]);
  });

  it('a file fixed since: the launch writes the hooks, and says nothing', async () => {
    seed(UNPARSEABLE[0][1]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = await provider();
    await p.configureHooks(hooksDir(), 'linux');
    seed(USERS);
    const said = await noticesOf(() => { launch(p, 'agent-g2'); });
    expect(said).toEqual([]);
    expect(hookCommands(asGeminiReads(read()))).toMatch(/session-start/);
  });

  it('a readable file: nothing said at the launch', async () => {
    seed(USERS);
    const p = await provider();
    await p.configureHooks(hooksDir(), 'linux');
    expect(await noticesOf(() => { launch(p, 'agent-g3'); })).toEqual([]);
  });
});

describe("the window's MCP channels for gemini (11)", () => {
  const DOCS = { name: 'docs', command: 'node', args: ['docs.js'], env: { DOCS_KEY: 'k' } };
  async function page() {
    ipcHandlers.clear();
    const { registerMcpConfigHandlers } = await import('../../../electron/handlers/mcp-config-handlers');
    registerMcpConfigHandlers();
    const call = (channel: string, params: Record<string, unknown>) => ipcHandlers.get(channel)!({}, { provider: 'gemini', ...params });
    return { list: () => call('mcp:list', {}), save: () => call('mcp:update', DOCS), remove: (name: string) => call('mcp:delete', { name }) };
  }
  const COMMENTS = ['// My gemini settings, kept by hand.', '/* the servers I use */', '// mine'];

  it('a commented file lists its servers, as gemini reads it', async () => {
    seed(COMMENTED);
    const listed = await (await page()).list();
    expect(listed.error).toBeUndefined();
    expect(listed.servers?.map((s) => s.name)).toEqual(['mine']);
  });

  it('a save into a commented file adds the server and changes nothing else: comments, auth, Tars\'s hooks and allow-list kept', async () => {
    seed(COMMENTED);
    await (await provider()).configureHooks(hooksDir(), 'linux');
    const before = asGeminiReads(read());
    expect(await (await page()).save()).toEqual({ success: true });
    for (const comment of COMMENTS) expect(read(), comment).toContain(comment);
    const { name: _name, ...docs } = DOCS;
    expect(asGeminiReads(read())).toEqual({ ...before, mcpServers: { ...(before.mcpServers as object), docs } });
  });

  it('a deletion from a commented file takes the server out and changes nothing else', async () => {
    seed(COMMENTED);
    await (await provider()).configureHooks(hooksDir(), 'linux');
    const before = asGeminiReads(read());
    const p = await page();
    expect(await p.save()).toEqual({ success: true });
    expect(await p.remove('docs')).toEqual({ success: true });
    for (const comment of COMMENTS) expect(read(), comment).toContain(comment);
    expect(asGeminiReads(read())).toEqual(before);
  });

  for (const [what, text] of [...UNPARSEABLE, ['JSON that is no object', '[]\n']] as const) {
    it(`${what}: left byte for byte by the list, a save and a deletion, and each answer says why`, async () => {
      seed(text);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const p = await page();
      const listed = await p.list();
      const saved = await p.save();
      const removed = await p.remove('mine');
      expect(read(), 'the user\'s settings file was replaced').toBe(text);
      expect(listed.servers).toEqual([]);
      expect(saved.success).toBe(false);
      expect(removed.success).toBe(false);
      for (const answer of [listed, saved, removed]) {
        expect(answer.error, 'the window was not told why').toMatch(/settings\.json could not be read as gemini reads it/);
        expect(answer.error).not.toMatch(/[–—]/);
      }
      expect(saved.error).toMatch(/docs not saved/);
      expect(removed.error).toMatch(/mine not removed/);
    });
  }

  it('no file: a deletion creates none, a save creates it with the server', async () => {
    const p = await page();
    expect(await p.remove('docs')).toEqual({ success: true });
    expect(fs.existsSync(settingsPath()), 'a deletion created the file').toBe(false);
    expect(await p.save()).toEqual({ success: true });
    const { name: _name, ...docs } = DOCS;
    expect(asGeminiReads(read()).mcpServers).toEqual({ docs });
  });
});

describe("a gemini worker's allow-list, read from the same file (12)", () => {
  it('a commented file: the worker allowed every server of it but the orchestrator\'s own', async () => {
    seed(COMMENTED.replace('"mcpServers": { "mine": { "command": "my-server" } }',
      '"mcpServers": { "mine": { "command": "my-server" }, "claude-mgr-orchestrator": { "command": "node" }, "dorothy-x": { "command": "node" } }'));
    const { geminiRoleArgs } = await import('../../../electron/services/mcp-roles');
    expect(geminiRoleArgs(false, settingsPath())).toEqual(['--allowed-mcp-server-names', 'mine', 'claude-mgr-orchestrator']);
    expect(geminiRoleArgs(true, settingsPath())).toEqual([]);
  });
});
