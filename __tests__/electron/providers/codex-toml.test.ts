import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { pinPlatform } from './win-fake-disk';

/**
 * The config.toml fallback Codex and Grok write when `<cli> mcp add` cannot
 * run (audit A19).
 *
 * How it fails, written before the code (2026-09-25):
 * 1. A Windows path written raw into a TOML basic string: `\U` in C:\Users
 *    opens an 8-digit unicode escape, `\A`, `\P`, `\m` are no escape at all.
 *    ~/.codex/config.toml stops parsing and codex refuses to start.
 * 2. A `"` in a path or a server name ends the string early.
 * 3. A server name that needs quoting (a dot, a space, a quote) breaks the
 *    table header.
 * 4. darwin/linux: the bytes change for paths and names with no backslash and
 *    no quote. They must be what the old writer wrote.
 * 5. isMcpServerRegistered reads the file back raw and does not recognise a
 *    Windows path it wrote itself (escaped in the file): every boot registers
 *    again. Codex, and Grok, which already escaped its writes.
 * 6. The section of an escaped name is not removed by removeMcpServer.
 */

/**
 * A strict reader for the part of TOML these files use: tables, `k = "..."`,
 * `k = [ "...", ... ]`, `k = true|false`, comments. Basic strings accept
 * exactly the escapes TOML 1.0 defines, and refuse raw control characters,
 * as codex's parser does. Anything else is an error, never a guess.
 */
function parseTomlSubset(text: string): Record<string, Record<string, unknown>> {
  const tables: Record<string, Record<string, unknown>> = { '': {} };
  let current = tables[''];
  let i = 0;
  const fail = (why: string): never => { throw new Error(`TOML: ${why} at ${i}: ${JSON.stringify(text.slice(i, i + 40))}`); };
  const ws = () => { while (text[i] === ' ' || text[i] === '\t') i++; };
  const basic = (): string => {
    if (text[i] !== '"') fail('expected "');
    i++;
    let out = '';
    for (;;) {
      const ch = text[i];
      if (ch === undefined || ch === '\n') fail('unterminated string');
      if (ch === '"') { i++; return out; }
      const code = ch.charCodeAt(0);
      if ((code < 0x20 && ch !== '\t') || code === 0x7f) fail('raw control character');
      if (ch !== '\\') { out += ch; i++; continue; }
      const e = text[i + 1];
      const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
      if (e in simple) { out += simple[e]; i += 2; continue; }
      const width = e === 'u' ? 4 : e === 'U' ? 8 : 0;
      if (!width) fail(`invalid escape \\${e}`);
      const hex = text.slice(i + 2, i + 2 + width);
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) fail(`invalid \\${e} escape`);
      const cp = parseInt(hex, 16);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail('invalid scalar value');
      out += String.fromCodePoint(cp);
      i += 2 + width;
    }
  };
  const key = (): string => {
    if (text[i] === '"') return basic();
    const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
    if (!m) fail('expected a key');
    i += m![0].length;
    return m![0];
  };
  const value = (): unknown => {
    if (text[i] === '"') return basic();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text[i] !== '[') fail('expected a value');
    i++;
    const items: unknown[] = [];
    for (;;) {
      ws();
      if (text[i] === ']') { i++; return items; }
      items.push(value());
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] !== ']') fail('expected , or ]');
    }
  };
  while (i < text.length) {
    ws();
    if (text[i] === '\n') { i++; continue; }
    if (text[i] === '\r' && text[i + 1] === '\n') { i += 2; continue; }
    if (text[i] === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (text[i] === '[') {
      i++;
      const parts = [key()];
      while (text[i] === '.') { i++; parts.push(key()); }
      if (text[i] !== ']') fail('expected ]');
      i++;
      const name = parts.join('\u0000');
      if (tables[name]) fail('table defined twice');
      current = tables[name] = {};
    } else {
      const k = key();
      ws();
      if (text[i] !== '=') fail('expected =');
      i++;
      ws();
      if (k in current) fail('key defined twice');
      current[k] = value();
    }
    ws();
    if (i < text.length && text[i] !== '\n' && text[i] !== '\r' && text[i] !== '#') fail('trailing characters');
  }
  return tables;
}

let tmpDir: string;
let unpin: () => void;

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => tmpDir };
});

// The CLI is never there: every call below takes the file fallback.
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFileSync: () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); },
}));

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-toml-'));
  // The TOML written does not depend on the platform; linux keeps the CLI
  // lookup off the disk so the fallback is what runs.
  unpin = pinPlatform('linux');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  unpin();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function codex() {
  const { CodexProvider } = await import('../../../electron/providers/codex-provider');
  return new CodexProvider();
}
async function grok() {
  const { GrokProvider } = await import('../../../electron/providers/grok-provider');
  return new GrokProvider();
}
const configOf = (dir: string) => fs.readFileSync(path.join(tmpDir, dir, 'config.toml'), 'utf-8');

const WIN_NODE = 'C:\\Program Files\\nodejs\\node.exe';
const WIN_BUNDLE = 'C:\\Users\\x\\AppData\\Local\\Programs\\Tars\\resources\\mcp-orchestrator\\dist\\bundle.js';

describe('codex config.toml fallback', () => {
  it('Windows paths parse back to themselves', async () => {
    const p = await codex();
    await p.registerMcpServer('claude-mgr-orchestrator', WIN_NODE, [WIN_BUNDLE, 'C:\\a\\b c (x)\\d.js']);

    const table = parseTomlSubset(configOf('.codex'))['mcp_servers\u0000claude-mgr-orchestrator'];
    expect(table).toEqual({ command: WIN_NODE, args: [WIN_BUNDLE, 'C:\\a\\b c (x)\\d.js'] });
  });

  it('a quote in a name or a path, a dotted name, parse back to themselves', async () => {
    const p = await codex();
    await p.registerMcpServer('we"ird.name x', 'node', ['/tmp/a "b"/s.js']);

    const table = parseTomlSubset(configOf('.codex'))['mcp_servers\u0000we"ird.name x'];
    expect(table).toEqual({ command: 'node', args: ['/tmp/a "b"/s.js'] });
  });

  it('a control character in a path, DEL included, parses back to itself', async () => {
    // TOML refuses U+007F raw in a basic string, which JSON leaves as it is.
    const p = await codex();
    await p.registerMcpServer('srv', 'node', ['/tmp/a\u007fb\u0001c/s.js']);

    const table = parseTomlSubset(configOf('.codex'))['mcp_servers\u0000srv'];
    expect(table).toEqual({ command: 'node', args: ['/tmp/a\u007fb\u0001c/s.js'] });
  });

  it('darwin/linux: the bytes the old writer wrote, for paths with no backslash and no quote', async () => {
    const p = await codex();
    fs.mkdirSync(path.join(tmpDir, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.codex', 'config.toml'), 'model = "gpt-5.3-codex"\n');
    await p.registerMcpServer('claude-mgr-orchestrator', 'node', ['/Applications/Tars.app/Contents/Resources/mcp-orchestrator/dist/bundle.js']);
    await p.registerMcpServer('tasmania.local', 'npx', ['tsx', '/Users/demo/tasmania/src/index.ts']);

    expect(configOf('.codex')).toBe([
      'model = "gpt-5.3-codex"',
      '',
      '[mcp_servers.claude-mgr-orchestrator]',
      'command = "node"',
      'args = ["/Applications/Tars.app/Contents/Resources/mcp-orchestrator/dist/bundle.js"]',
      '',
      '[mcp_servers."tasmania.local"]',
      'command = "npx"',
      'args = ["tsx", "/Users/demo/tasmania/src/index.ts"]',
      '',
    ].join('\n'));
  });

  it('knows a Windows path it wrote, and removes an escaped name', async () => {
    const p = await codex();
    await p.registerMcpServer('claude-mgr-orchestrator', WIN_NODE, [WIN_BUNDLE]);
    await p.registerMcpServer('we"ird', 'node', ['C:\\w.js']);

    expect(p.isMcpServerRegistered('claude-mgr-orchestrator', WIN_BUNDLE)).toBe(true);
    expect(p.isMcpServerRegistered('claude-mgr-orchestrator', 'C:\\Users\\x\\other.js')).toBe(false);

    await p.removeMcpServer('we"ird');
    const tables = parseTomlSubset(configOf('.codex'));
    expect(Object.keys(tables).filter((k) => k.startsWith('mcp_servers'))).toEqual(['mcp_servers\u0000claude-mgr-orchestrator']);
  });
});

describe('grok config.toml fallback', () => {
  it('Windows paths parse back, and grok knows the path it wrote', async () => {
    const p = await grok();
    await p.registerMcpServer('claude-mgr-orchestrator', WIN_NODE, [WIN_BUNDLE]);

    const table = parseTomlSubset(configOf('.grok'))['mcp_servers\u0000claude-mgr-orchestrator'];
    expect(table).toEqual({ command: WIN_NODE, args: [WIN_BUNDLE], enabled: true });
    expect(p.isMcpServerRegistered('claude-mgr-orchestrator', WIN_BUNDLE)).toBe(true);
  });
});

describe('the reader itself', () => {
  it('refuses what codex refuses', () => {
    expect(() => parseTomlSubset('[t]\nk = "C:\\Users\\x"\n')).toThrow(/escape/);
    expect(() => parseTomlSubset('[t]\nk = "C:\\Program Files"\n')).toThrow(/invalid escape/);
    expect(() => parseTomlSubset('[t]\nk = "a"b"\n')).toThrow();
    expect(() => parseTomlSubset('[t.a.b]\nk = ["x", "y"]\n')).not.toThrow();
  });
});
