import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A folder an agent is given (its secondary folder, a vault) that its CLI can never see, refused when it is set, and
 * said on the agent at its launch when it already holds one (the Audit's read of #636 at aef730f1c, L1 and I-4).
 *
 * Read in their bundles: gemini 0.70.0 (coerceCommaSeparated) and Qwen Code 0.28.4 (its own coerce) split every
 * --include-directories value at commas and trim each piece, with no escape, so a folder named "Acme, Inc" reaches
 * either as two other folders. grok 1.0.92 has no flag for a secondary folder at all, and is handed none.
 *
 * How it fails, written before the code (25/11):
 * 1. A gemini or Qwen Code agent's secondary folder or vault whose path holds a comma, or ends in a space, accepted
 *    where it is set: the agent then works without it, its tools refuse paths there, and nothing the window shows says
 *    why.
 * 2. A grok agent given a secondary folder, accepted: grok never sees it.
 * 3. A folder any of them can take refused, or a CLI that takes such a folder whole refused one.
 * 4. An agent already holding such a folder told only in Tars's log: its launch says it in the agent's own output.
 * 5. Qwen Code's line handing the folder anyway, as gemini's did before aef730f1c.
 */

const notices: Array<[string, string]> = [];
let root: string;

beforeEach(async () => {
  vi.resetModules();
  notices.length = 0;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'added-folders-')));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const sinkNotices = async () => {
  const { setAgentNoticeSink } = await import('../../../electron/core/agent-notices');
  setAgentNoticeSink((agentId, line) => { notices.push([agentId, line]); });
};

describe('a folder its CLI can never see is refused where it is set (1 to 3)', () => {
  it.each(['gemini', 'qwen-code'])('1. %s: a secondary folder or a vault with a comma, or ending in a space', async (provider) => {
    const { addedFolderRefusal } = await import('../../../electron/providers/added-folders');
    expect(addedFolderRefusal(provider, { secondary: '/home/me/Acme, Inc' })).toMatch(/comma/);
    expect(addedFolderRefusal(provider, { vaults: ['/home/me/notes', '/home/me/Vault, 2'] })).toMatch(/Vault, 2/);
    expect(addedFolderRefusal(provider, { secondary: '/home/me/space ' })).toBeTruthy();
    expect(addedFolderRefusal(provider, { secondary: '/home/me/Acme Inc', vaults: ['/home/me/notes'] })).toBeNull();
  });

  it('2. grok: any secondary folder, which grok has no flag for', async () => {
    const { addedFolderRefusal } = await import('../../../electron/providers/added-folders');
    expect(addedFolderRefusal('grok', { secondary: '/home/me/other' })).toMatch(/grok/i);
    expect(addedFolderRefusal('grok', { secondary: null })).toBeNull();
    expect(addedFolderRefusal('grok', {})).toBeNull();
  });

  it('3. a CLI that takes a folder whole, and no folder at all', async () => {
    const { addedFolderRefusal } = await import('../../../electron/providers/added-folders');
    expect(addedFolderRefusal('claude', { secondary: '/home/me/Acme, Inc' })).toBeNull();
    expect(addedFolderRefusal('codex', { vaults: ['/home/me/Vault, 2'] })).toBeNull();
    expect(addedFolderRefusal(undefined, { secondary: '/home/me/Acme, Inc' })).toBeNull();
    expect(addedFolderRefusal('gemini', {})).toBeNull();
  });
});

describe("an agent already holding one is told at its launch, in its own output (4, 5)", () => {
  it("4 and 5. Qwen Code leaves the folder out of its line, and says so to the agent", async () => {
    await sinkNotices();
    const secondary = path.join(root, 'Acme, Inc');
    fs.mkdirSync(secondary);
    const { QwenCodeProvider } = await import('../../../electron/providers/qwen-code-provider');
    const command = new QwenCodeProvider().buildInteractiveCommand({ agentId: 'q1', binaryPath: '/opt/bin/qwen', prompt: 'go', secondaryProjectPath: secondary } as never);
    expect(command).not.toContain('Acme, Inc');
    expect(command).toContain('--include-directories');
    expect(notices.filter(([id, line]) => id === 'q1' && line.includes(secondary))).toHaveLength(1);
  });

  it('4. grok says the secondary folder it is not handed', async () => {
    await sinkNotices();
    const { GrokProvider } = await import('../../../electron/providers/grok-provider');
    new GrokProvider().buildInteractiveCommand({ agentId: 'k1', binaryPath: '/opt/bin/grok', prompt: 'go', secondaryProjectPath: path.join(root, 'other') } as never);
    expect(notices.filter(([id, line]) => id === 'k1' && /secondary folder/.test(line))).toHaveLength(1);
  });
});
