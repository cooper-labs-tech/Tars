import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseToml } from 'smol-toml';

/**
 * Every config file Tars writes for a CLI ends with a newline, parses, and is never left broken (28/10).
 *
 * Found on the owner's machine: ~/.codex/config.toml did not parse, so codex refused to start. Line 6 read
 * `args = [".../mcp-world/dist/bundle.js"][tui]`: a [mcp_servers.dorothy-world] table whose last line ran straight
 * into codex's own [tui] header. The file was last written on 25/10 at 19:16, the minute 2.0.4 first started,
 * which removed and registered again each of Tars's servers (their node command moved).
 *
 * Every way it can fail, written before the code:
 * F1. Removing a table that no blank line separates from the line before it takes that line's newline: the line
 *     runs into the next header (`args = [...][tui]`), or the file ends without its final newline. The same
 *     remover lives in codex-provider.ts, grok-provider.ts and the MCP page (mcp-config-handlers.ts).
 * F2. A config file left without a final newline: a CLI that adds its own table at the end (codex's [tui],
 *     written by its own TOML editor) puts the header on the last line, and the file no longer parses.
 * F3. A write whose result does not parse (a value the MCP page writes unescaped, a table added to a file that
 *     was already broken) replaces the file: the CLI refuses its whole config, and the previous one is gone.
 * F4. A JSON config written without its final newline (every writer used JSON.stringify alone): the shared
 *     writer (claude's settings, mcp.json, ~/.claude.json, pi, opencode), gemini's settings, amp's, the MCP page's
 *     JSON files, Qwen Code's per-agent settings.
 *
 * After the Audit's gate of e324cb6ea (AUDIT-PR531.md), written before the fix:
 * F5. (M1) A header the remover does not know as one is taken as a line of the table above it, and removed with
 *     it: a quoted key holding `[`, `]` or `=` (a trust table `[projects."/Users/me/Work [old]/app"]`, an owner's
 *     `[mcp_servers."a=b"]`), a dotted key with spaces, an array of tables `[[profiles]]`, a header with a comment.
 *     And a line of a value (`  [1, 2],`, `["a", "b"]`, `]`) taken for a header ends the table too early.
 * F6. (L1) A file that does not parse once written is left so: the read after the rename is never acted on.
 */

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  // No CLI here: every provider takes its file fallback, as when `codex mcp remove` cannot run.
  execFileSync: () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); },
}));
type Handler = (event: unknown, params: Record<string, unknown>) => Promise<{ success?: boolean; error?: string }>;
const handlers = vi.hoisted(() => new Map<string, Handler>());
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, h: Handler) => { handlers.set(channel, h); } } }));

import { CodexProvider } from '../../../electron/providers/codex-provider';
import { GrokProvider } from '../../../electron/providers/grok-provider';
import { GeminiProvider } from '../../../electron/providers/gemini-provider';
import { registerMcpConfigHandlers } from '../../../electron/handlers/mcp-config-handlers';
import { updateSharedJsonSync, updateSharedTextSync } from '../../../electron/utils/shared-file';
import { removeTomlTable } from '../../../electron/utils/toml-tables';

/** What the owner's file held before 2.0.4's first start, as far as it matters: world, a Tars server, codex's [tui]. */
const BEFORE = [
  'model = "gpt-5.3-codex"',
  '',
  '[mcp_servers.dorothy-world]',
  'command = "node"',
  'args = ["/Users/someone/mcp-world/dist/bundle.js"]',
  '[mcp_servers.claude-mgr-vault]',
  'command = "/old/node"',
  'args = ["/Users/someone/.dorothy/mcp-vault/dist/bundle.js"]',
  '[tui]',
  'notice = true',
  '',
].join('\n');

const codexFile = () => path.join(os.homedir(), '.codex', 'config.toml');
const grokFile = () => path.join(os.homedir(), '.grok', 'config.toml');
const seed = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = (file: string) => fs.readFileSync(file, 'utf8');
/** What a CLI does when it keeps a setting of its own: a table added at the file's end. */
const cliAppends = (file: string) => fs.appendFileSync(file, '[notice]\nhide_full_access_warning = true\n');

beforeAll(() => registerMcpConfigHandlers());
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const dir of ['.codex', '.grok', '.gemini']) fs.rmSync(path.join(os.homedir(), dir), { recursive: true, force: true });
});

describe('F1. removing a table keeps the line before it whole', () => {
  it('the remover: no newline taken, whether a table, the end of the file, or a blank line follows', () => {
    const removed = removeTomlTable(BEFORE, 'mcp_servers.claude-mgr-vault');
    const parsed = parseToml(removed) as { mcp_servers: Record<string, { args: string[] }>; tui: { notice: boolean } };
    expect(parsed.mcp_servers['dorothy-world'].args).toEqual(['/Users/someone/mcp-world/dist/bundle.js']);
    expect(parsed.mcp_servers['claude-mgr-vault']).toBeUndefined();
    expect(parsed.tui.notice).toBe(true);
    const last = removeTomlTable('[a]\nx = 1\n[b]\ny = 2\n', 'b');
    expect(last).toBe('[a]\nx = 1\n');
    expect(removeTomlTable('[a]\nx = 1\n\n[b]\ny = 2\n\n[c]\nz = 3\n', 'b')).toBe('[a]\nx = 1\n\n[c]\nz = 3\n');
  });

  it('codex, as 2.0.4\'s first start did it: removed, then registered again, and codex adds a table of its own', async () => {
    seed(codexFile(), BEFORE);
    const codex = new CodexProvider();
    await codex.removeMcpServer('claude-mgr-vault');
    expect(() => parseToml(read(codexFile()))).not.toThrow();
    await codex.registerMcpServer('claude-mgr-vault', '/new/node', ['/Users/someone/.tars/mcp-vault/dist/bundle.js'], ['CLAUDE_AGENT_ID']);
    cliAppends(codexFile());
    const parsed = parseToml(read(codexFile())) as { mcp_servers: Record<string, { args: string[] }>; tui: unknown };
    expect(parsed.mcp_servers['dorothy-world'].args).toEqual(['/Users/someone/mcp-world/dist/bundle.js']);
    expect(parsed.mcp_servers['claude-mgr-vault'].args).toEqual(['/Users/someone/.tars/mcp-vault/dist/bundle.js']);
    expect(parsed.tui).toEqual({ notice: true });
  });

  it('grok, the same remover', async () => {
    seed(grokFile(), BEFORE);
    await new GrokProvider().removeMcpServer('claude-mgr-vault');
    cliAppends(grokFile());
    expect((parseToml(read(grokFile())) as { tui: unknown }).tui).toEqual({ notice: true });
  });

  it('the MCP page, the same remover: a server deleted from Settings', async () => {
    seed(codexFile(), BEFORE.replace('claude-mgr-vault', 'docs'));
    expect((await handlers.get('mcp:delete')!({}, { provider: 'codex', name: 'docs' })).success).toBe(true);
    cliAppends(codexFile());
    expect((parseToml(read(codexFile())) as { tui: unknown }).tui).toEqual({ notice: true });
  });
});

describe('F5. every header is one, whatever its key holds, and no value line is', () => {
  const VAULT = '[mcp_servers.claude-mgr-vault]\ncommand = "node"\nargs = ["/v.js"]\n';
  it.each([
    ['a trust table whose folder holds brackets', '[projects."/Users/me/Work [old]/app"]\ntrust_level = "trusted"\n'],
    ['a trust table whose folder holds =', '[projects."/Users/me/a=b"]\ntrust_level = "trusted"\n'],
    ['an owner\'s server named with =', '[mcp_servers."a=b"]\ncommand = "x"\n'],
    ['a literal-string key holding ]', "[projects.'/Users/me/x]y']\ntrust_level = \"trusted\"\n"],
    ['a dotted key with spaces', '[ mcp_servers . other ]\ncommand = "x"\n'],
    ['an array of tables', '[[profiles]]\nname = "work"\n'],
    ['a header with a comment', '[tui] # my settings\nnotice = true\n'],
  ])('%s, after the Tars table removed, is kept', (_why, owners) => {
    const left = removeTomlTable(`model = "x"\n\n${VAULT}${owners}`, 'mcp_servers.claude-mgr-vault');
    expect(left).toBe(`model = "x"\n\n${owners}`);
    expect(() => parseToml(left)).not.toThrow();
  });

  it('a value\'s lines are not headers: the whole table goes, the next one stays', () => {
    const tars = '[mcp_servers.claude-mgr-vault]\nargs = [\n  [1, 2],\n  ["a", "b"],\n]\n';
    expect(removeTomlTable(`${tars}[tui]\nnotice = true\n`, 'mcp_servers.claude-mgr-vault')).toBe('[tui]\nnotice = true\n');
  });

  it('a quoted Tars key is found and removed', () => {
    expect(removeTomlTable('[a]\nx = 1\n[mcp_servers."tasmania.local"]\ncommand = "x"\n', 'mcp_servers."tasmania.local"')).toBe('[a]\nx = 1\n');
  });
});

describe('F6. a file that does not parse once written is put back', () => {
  it('as it was, when there was one; gone, when there was none', () => {
    // A parse that passes the text before the rename and fails the file read after it: another writer, between.
    const failsTheSecondTime = () => { let calls = 0; return () => { if (++calls > 1) throw new Error('not TOML'); }; };
    seed(codexFile(), 'model = "x"\n');
    expect(updateSharedTextSync(codexFile(), () => 'model = "y"\n', { parse: failsTheSecondTime() })).toBe('refused');
    expect(read(codexFile())).toBe('model = "x"\n');
    const fresh = path.join(os.homedir(), '.codex', 'fresh.toml');
    expect(updateSharedTextSync(fresh, () => 'model = "y"\n', { parse: failsTheSecondTime() })).toBe('refused');
    expect(fs.existsSync(fresh)).toBe(false);
  });
});

describe('F2. every TOML config ends with a newline', () => {
  it('a section removed last, from a file whose last table has no blank line before it', async () => {
    seed(codexFile(), 'model = "x"\n[mcp_servers.dorothy-world]\nargs = ["w"]\n[mcp_servers.claude-mgr-x]\nargs = ["x"]\n');
    await new CodexProvider().removeMcpServer('claude-mgr-x');
    expect(read(codexFile()).endsWith('\n')).toBe(true);
    cliAppends(codexFile());
    expect(() => parseToml(read(codexFile()))).not.toThrow();
  });

  it('a text written through the shared writer without one gets one', () => {
    const file = path.join(os.homedir(), '.codex', 'config.toml');
    updateSharedTextSync(file, () => 'model = "x"', { parse: parseToml });
    expect(read(file)).toBe('model = "x"\n');
  });
});

describe('F3. a write that would not parse leaves the previous file', () => {
  it('the shared writer refuses it, and the file keeps its bytes', () => {
    seed(codexFile(), 'model = "x"\n');
    expect(updateSharedTextSync(codexFile(), () => 'model = "x"\n[broken\n', { parse: parseToml })).toBe('refused');
    expect(read(codexFile())).toBe('model = "x"\n');
  });

  it('the MCP page: a command holding a quote, written unescaped, does not break codex\'s config', async () => {
    seed(codexFile(), 'model = "x"\n');
    const saved = await handlers.get('mcp:update')!({}, { provider: 'codex', name: 'docs', command: 'C:\\a "b"\\node.exe', args: [], env: {} });
    expect(() => parseToml(read(codexFile()))).not.toThrow();
    if (saved.success) expect((parseToml(read(codexFile())) as { mcp_servers: Record<string, { command: string }> }).mcp_servers.docs.command).toBe('C:\\a "b"\\node.exe');
    else expect(read(codexFile())).toBe('model = "x"\n');
  });

  it('a server registered into a file already broken leaves it as it was, said, not made worse', async () => {
    const broken = 'model = "x"\n[mcp_servers.dorothy-world]\nargs = ["w"][tui]\nnotice = true\n';
    seed(codexFile(), broken);
    await expect(new CodexProvider().registerMcpServer('claude-mgr-x', 'node', ['/x.js'], ['CLAUDE_AGENT_ID'])).rejects.toThrow(/would not parse/);
    expect(read(codexFile())).toBe(broken);
  });
});

describe('F4. every JSON config ends with a newline', () => {
  it('the shared writer: claude\'s settings, mcp.json, ~/.claude.json, pi, opencode', () => {
    const file = path.join(os.homedir(), '.claude', 'settings.json');
    updateSharedJsonSync<Record<string, unknown>>(file, () => ({ a: 1 }));
    expect(read(file)).toBe('{\n  "a": 1\n}\n');
  });

  it('gemini\'s settings, written when a server is registered without its CLI', async () => {
    await new GeminiProvider().registerMcpServer('docs', 'node', ['docs.js']);
    const file = path.join(os.homedir(), '.gemini', 'settings.json');
    expect(read(file).endsWith('}\n')).toBe(true);
    expect(JSON.parse(read(file)).mcpServers.docs).toMatchObject({ command: 'node' });
  });

  it('the MCP page\'s JSON files', async () => {
    expect((await handlers.get('mcp:update')!({}, { provider: 'claude', name: 'docs', command: 'node', args: ['d.js'], env: {} })).success).toBe(true);
    expect(read(path.join(os.homedir(), '.claude', 'mcp.json')).endsWith('}\n')).toBe(true);
  });
});
