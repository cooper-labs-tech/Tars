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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-prov-test-'));
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
  const { ClaudeProvider } = await import('../../../electron/providers/claude-provider');
  return new ClaudeProvider();
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ClaudeProvider', () => {
  describe('buildInteractiveCommand', () => {
    it('includes --mcp-config when mcpConfigPath is provided', async () => {
      const provider = await getProvider();
      const mcpPath = path.join(tmpDir, '.claude', 'mcp.json');
      fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
      fs.writeFileSync(mcpPath, '{}');

      const cmd = provider.buildInteractiveCommand({
        binaryPath: 'claude',
        prompt: 'hello',
        mcpConfigPath: mcpPath,
      });

      expect(cmd).toContain('--mcp-config');
      expect(cmd).toContain(mcpPath);
    });

    it('omits --mcp-config when mcpConfigPath is undefined', async () => {
      const provider = await getProvider();

      const cmd = provider.buildInteractiveCommand({
        binaryPath: 'claude',
        prompt: 'hello',
      });

      expect(cmd).not.toContain('--mcp-config');
    });

    it('omits --mcp-config when mcpConfigPath file does not exist', async () => {
      const provider = await getProvider();

      const cmd = provider.buildInteractiveCommand({
        binaryPath: 'claude',
        prompt: 'hello',
        mcpConfigPath: '/nonexistent/mcp.json',
      });

      expect(cmd).not.toContain('--mcp-config');
    });
  });

  describe('getMcpConfigStrategy', () => {
    it('returns flag', async () => {
      const provider = await getProvider();
      expect(provider.getMcpConfigStrategy()).toBe('flag');
    });
  });

  describe('registerMcpServer', () => {
    it('writes mcp.json, never Claude Code\'s user scope (2.0.5, services/mcp-roles.ts)', async () => {
      const provider = await getProvider();
      mockExecFileSync.mockReturnValue('');

      await provider.registerMcpServer('test-server', 'node', ['/path/to/bundle.js']);

      const config = JSON.parse(fs.readFileSync(path.join(tmpDir, '.claude', 'mcp.json'), 'utf-8'));
      expect(config.mcpServers['test-server']).toEqual({ command: 'node', args: ['/path/to/bundle.js'] });
      // The user scope holds no such server: nothing to take out, so the CLI is not run.
      expect(mockExecFileSync.mock.calls.some((c) => (c[1] as string[])?.[1] === 'add')).toBe(false);
    });

    it('falls back to mcp.json when CLI fails', async () => {
      const provider = await getProvider();
      mockExecFileSync.mockImplementation(() => { throw new Error('command not found'); });

      await provider.registerMcpServer('test-server', 'node', ['/path/to/bundle.js']);

      const mcpPath = path.join(tmpDir, '.claude', 'mcp.json');
      expect(fs.existsSync(mcpPath)).toBe(true);

      const config = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
      expect(config.mcpServers['test-server']).toEqual({
        command: 'node',
        args: ['/path/to/bundle.js'],
      });
    });

    it('creates .claude directory if missing in fallback', async () => {
      const provider = await getProvider();
      mockExecSync.mockImplementation(() => { throw new Error('fail'); });

      await provider.registerMcpServer('srv', 'node', ['/x.js']);

      expect(fs.existsSync(path.join(tmpDir, '.claude'))).toBe(true);
    });

    it('preserves existing mcp.json entries in fallback', async () => {
      const provider = await getProvider();
      mockExecSync.mockImplementation(() => { throw new Error('fail'); });

      const mcpDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(mcpDir, { recursive: true });
      fs.writeFileSync(path.join(mcpDir, 'mcp.json'), JSON.stringify({
        mcpServers: { existing: { command: 'node', args: ['/existing.js'] } },
      }));

      await provider.registerMcpServer('new-server', 'node', ['/new.js']);

      const config = JSON.parse(fs.readFileSync(path.join(mcpDir, 'mcp.json'), 'utf-8'));
      expect(config.mcpServers.existing).toBeDefined();
      expect(config.mcpServers['new-server']).toBeDefined();
    });
  });

  describe('removeMcpServer', () => {
    it('calls claude mcp remove', async () => {
      const provider = await getProvider();
      mockExecFileSync.mockReturnValue('');

      await provider.removeMcpServer('test-server');

      // argv, never a shell string. The add path was fixed for this and its
      // sibling was left behind, so `$(id)` in a server name still reached
      // /bin/sh at every removal.
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'claude',
        ['mcp', 'remove', '-s', 'user', 'test-server'],
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
      expect(binary).toBe('claude');
      // The name arrives as one argument, intact and uninterpreted.
      expect(args).toContain(nasty);
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('also cleans mcp.json', async () => {
      const provider = await getProvider();
      mockExecFileSync.mockReturnValue('');

      const mcpDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(mcpDir, { recursive: true });
      fs.writeFileSync(path.join(mcpDir, 'mcp.json'), JSON.stringify({
        mcpServers: {
          'test-server': { command: 'node', args: ['/x.js'] },
          'keep-server': { command: 'node', args: ['/y.js'] },
        },
      }));

      await provider.removeMcpServer('test-server');

      const config = JSON.parse(fs.readFileSync(path.join(mcpDir, 'mcp.json'), 'utf-8'));
      expect(config.mcpServers['test-server']).toBeUndefined();
      expect(config.mcpServers['keep-server']).toBeDefined();
    });
  });

  describe('isMcpServerRegistered', () => {
    it('returns true when server exists in mcp.json with matching path', async () => {
      const provider = await getProvider();
      const mcpDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(mcpDir, { recursive: true });
      fs.writeFileSync(path.join(mcpDir, 'mcp.json'), JSON.stringify({
        mcpServers: { 'my-mcp': { command: 'node', args: ['/bundle.js'] } },
      }));

      expect(provider.isMcpServerRegistered('my-mcp', '/bundle.js')).toBe(true);
    });

    it('returns false when server exists but path differs', async () => {
      const provider = await getProvider();
      const mcpDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(mcpDir, { recursive: true });
      fs.writeFileSync(path.join(mcpDir, 'mcp.json'), JSON.stringify({
        mcpServers: { 'my-mcp': { command: 'node', args: ['/old-bundle.js'] } },
      }));

      expect(provider.isMcpServerRegistered('my-mcp', '/new-bundle.js')).toBe(false);
    });

    it('returns false when mcp.json does not exist', async () => {
      const provider = await getProvider();
      expect(provider.isMcpServerRegistered('my-mcp', '/bundle.js')).toBe(false);
    });
  });
});
