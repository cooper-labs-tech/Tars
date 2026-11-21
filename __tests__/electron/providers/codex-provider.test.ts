import '../../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { pinPlatform } from './win-fake-disk';

let tmpDir: string;
let unpin: () => void;
let mockExecSync: ReturnType<typeof vi.fn>;
let mockExecFileSync: ReturnType<typeof vi.fn>;

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => tmpDir };
});

vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

beforeEach(() => {
  vi.resetModules();
  // The argv read below is the darwin/linux contract: the CLI's name as given.
  // How win32 resolves the same calls (an npm .cmd shim, a .exe) is proven
  // against a real shim in mcp-registration-cli.test.ts.
  unpin = pinPlatform('linux');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-prov-test-'));
  mockExecSync = vi.fn();
  // registerMcpServer moved from execSync to execFileSync (argv, no shell).
  // Delegating by default keeps every existing test that configures the CLI
  // outcome through mockExecSync working, while the argv assertion still reads
  // mockExecFileSync directly.
  mockExecFileSync = vi.fn((...args: unknown[]) => mockExecSync(...args));
});

afterEach(() => {
  vi.restoreAllMocks();
  unpin();
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function getProvider() {
  const { CodexProvider } = await import('../../../electron/providers/codex-provider');
  return new CodexProvider();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CodexProvider', () => {
  describe('getMcpConfigStrategy', () => {
    it('returns config-file', async () => {
      const provider = await getProvider();
      expect(provider.getMcpConfigStrategy()).toBe('config-file');
    });
  });

  describe('registerMcpServer', () => {
    it('uses codex mcp add when CLI succeeds', async () => {
      const provider = await getProvider();
      mockExecSync.mockReturnValue('Added global MCP server');

      await provider.registerMcpServer('my-mcp', 'node', ['/path/to/bundle.js']);

      // argv, not a shell string: the previous form wrapped each arg in
      // double quotes and handed the line to execSync, where $() still
      // expands.
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'codex',
        ['mcp', 'add', 'my-mcp', '--', 'node', '/path/to/bundle.js'],
        expect.objectContaining({ encoding: 'utf-8', stdio: 'pipe' }),
      );
    });

    it('does not write config.toml when CLI succeeds', async () => {
      const provider = await getProvider();
      mockExecSync.mockReturnValue('Added');

      await provider.registerMcpServer('my-mcp', 'node', ['/bundle.js']);

      const configPath = path.join(tmpDir, '.codex', 'config.toml');
      expect(fs.existsSync(configPath)).toBe(false);
    });

    it('falls back to config.toml when CLI fails', async () => {
      const provider = await getProvider();
      mockExecFileSync.mockImplementation(() => { throw new Error('command not found'); });

      await provider.registerMcpServer('my-mcp', 'node', ['/path/to/bundle.js']);

      const configPath = path.join(tmpDir, '.codex', 'config.toml');
      expect(fs.existsSync(configPath)).toBe(true);

      const content = fs.readFileSync(configPath, 'utf-8');
      expect(content).toContain('[mcp_servers.my-mcp]');
      expect(content).toContain('command = "node"');
      expect(content).toContain('"/path/to/bundle.js"');
    });

    it('creates .codex directory if missing in fallback', async () => {
      const provider = await getProvider();
      mockExecSync.mockImplementation(() => { throw new Error('fail'); });

      await provider.registerMcpServer('srv', 'node', ['/x.js']);

      expect(fs.existsSync(path.join(tmpDir, '.codex'))).toBe(true);
    });

    it('preserves existing config.toml content in fallback', async () => {
      const provider = await getProvider();
      mockExecSync.mockImplementation(() => { throw new Error('fail'); });

      const codexDir = path.join(tmpDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(path.join(codexDir, 'config.toml'), 'model = "gpt-5.3-codex"\n');

      await provider.registerMcpServer('my-mcp', 'node', ['/bundle.js']);

      const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
      expect(content).toContain('model = "gpt-5.3-codex"');
      expect(content).toContain('[mcp_servers.my-mcp]');
    });

    it('replaces existing MCP section in fallback', async () => {
      const provider = await getProvider();
      mockExecSync.mockImplementation(() => { throw new Error('fail'); });

      const codexDir = path.join(tmpDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(path.join(codexDir, 'config.toml'),
        'model = "gpt-5"\n\n[mcp_servers.my-mcp]\ncommand = "node"\nargs = ["/old.js"]\n'
      );

      await provider.registerMcpServer('my-mcp', 'node', ['/new.js']);

      const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
      expect(content).toContain('/new.js');
      expect(content).not.toContain('/old.js');
      // Should still only have one section for my-mcp
      expect(content.match(/\[mcp_servers\.my-mcp\]/g)).toHaveLength(1);
    });
  });

  describe('removeMcpServer', () => {
    it('calls codex mcp remove', async () => {
      const provider = await getProvider();
      mockExecFileSync.mockReturnValue('');

      await provider.removeMcpServer('my-mcp');

      // argv, never a shell string. The add path was fixed for this and its
      // sibling was left behind, so `$(id)` in a server name still reached
      // /bin/sh at every removal.
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'codex',
        ['mcp', 'remove', 'my-mcp'],
        expect.any(Object),
      );
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('never hands a crafted name to a shell', async () => {
      const provider = await getProvider();
      mockExecFileSync.mockReturnValue('');

      const nasty = 'evil$(id)`whoami`;rm -rf /';
      await provider.removeMcpServer(nasty);

      const [binary, args] = mockExecFileSync.mock.calls[0];
      expect(binary).toBe('codex');
      // The name arrives as one argument, intact and uninterpreted.
      expect(args).toContain(nasty);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('also cleans config.toml', async () => {
      const provider = await getProvider();
      mockExecFileSync.mockReturnValue('');

      const codexDir = path.join(tmpDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(path.join(codexDir, 'config.toml'),
        'model = "gpt-5"\n\n[mcp_servers.my-mcp]\ncommand = "node"\nargs = ["/x.js"]\n'
      );

      await provider.removeMcpServer('my-mcp');

      const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
      expect(content).not.toContain('[mcp_servers.my-mcp]');
      expect(content).toContain('model = "gpt-5"');
    });

    it('does not throw when config.toml does not exist', async () => {
      const provider = await getProvider();
      mockExecFileSync.mockReturnValue('');

      await expect(provider.removeMcpServer('nonexistent')).resolves.not.toThrow();
    });
  });

  describe('isMcpServerRegistered', () => {
    it('returns true when TOML section exists with matching path', async () => {
      const provider = await getProvider();
      const codexDir = path.join(tmpDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(path.join(codexDir, 'config.toml'),
        '[mcp_servers.my-mcp]\ncommand = "node"\nargs = ["/bundle.js"]\n'
      );

      expect(provider.isMcpServerRegistered('my-mcp', '/bundle.js')).toBe(true);
    });

    it('returns false when section exists but path differs', async () => {
      const provider = await getProvider();
      const codexDir = path.join(tmpDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(path.join(codexDir, 'config.toml'),
        '[mcp_servers.my-mcp]\ncommand = "node"\nargs = ["/old.js"]\n'
      );

      expect(provider.isMcpServerRegistered('my-mcp', '/new.js')).toBe(false);
    });

    it('returns false when config.toml does not exist', async () => {
      const provider = await getProvider();
      expect(provider.isMcpServerRegistered('my-mcp', '/bundle.js')).toBe(false);
    });

    it('returns false when section is missing', async () => {
      const provider = await getProvider();
      const codexDir = path.join(tmpDir, '.codex');
      fs.mkdirSync(codexDir, { recursive: true });
      fs.writeFileSync(path.join(codexDir, 'config.toml'), 'model = "gpt-5"\n');

      expect(provider.isMcpServerRegistered('my-mcp', '/bundle.js')).toBe(false);
    });
  });
});
