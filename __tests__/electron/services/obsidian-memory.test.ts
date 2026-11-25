import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Obsidian as a memory backend.
 *
 * A vault is a folder of markdown, so the risk here is not the reading: it is
 * that a new source gets added to one list and left out of the other four, and
 * then reports itself as configured while no agent can actually reach it. So
 * this drives the three entry points that matter - status, search and write -
 * rather than the reader in isolation, and checks that a write cannot escape
 * the vault.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-obsidian-'));
const vault = path.join(home, 'MyVault');

vi.mock('../../../electron/constants', () => ({
  DATA_DIR: home,
  dataPath: (f: string) => path.join(home, f),
  API_PORT: 31415,
  // What the Hermes client loads with it since 2.0.4 (services/settings-secrets.ts).
  PRIVATE_DIR: path.join(home, '.tars-private'),
  privatePath: (...f: string[]) => path.join(home, '.tars-private', ...f),
  APP_SETTINGS_FILE: path.join(home, 'app-settings.json'),
}));

let hub: typeof import('../../../electron/services/memory-hub');

const settings = () => ({ obsidianVaultPaths: [vault] });

beforeEach(async () => {
  fs.rmSync(vault, { recursive: true, force: true });
  fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Notes', 'Deploys.md'), '# Deploys\n\nThe release is cut with gh release create.\n');
  fs.writeFileSync(path.join(vault, 'Index.md'), 'Everything starts here.\n');
  // The app's own config folder, which must never be read as notes.
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  fs.writeFileSync(path.join(vault, '.obsidian', 'app.json'), '{"secret":"not a note"}');

  vi.resetModules();
  hub = await import('../../../electron/services/memory-hub');
});

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe('status', () => {
  it('reports the vault and counts its notes', async () => {
    const sources = await hub.memoryStatus({ settings: settings() });
    const obsidian = sources.find(s => s.id === 'obsidian');

    expect(obsidian).toBeDefined();
    expect(obsidian!.configured).toBe(true);
    expect(obsidian!.reachable).toBe(true);
    expect(obsidian!.detail).toContain('2 notes');
  });

  it('says so plainly when no vault is set up', async () => {
    const sources = await hub.memoryStatus({ settings: {} });
    const obsidian = sources.find(s => s.id === 'obsidian');

    expect(obsidian!.configured).toBe(false);
    expect(obsidian!.detail).toBe('no vault set up');
  });

  it('does not claim a vault that is not on disk', async () => {
    const sources = await hub.memoryStatus({ settings: { obsidianVaultPaths: [path.join(home, 'gone')] } });
    expect(sources.find(s => s.id === 'obsidian')!.configured).toBe(false);
  });
});

describe('search', () => {
  it('finds a paragraph in a note', async () => {
    const { hits } = await hub.searchMemory({ query: 'gh release', settings: settings(), sources: ['obsidian'] });

    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('obsidian');
    expect(hits[0].title).toBe(path.join('Notes', 'Deploys.md'));
    expect(hits[0].content).toContain('gh release create');
  });

  it('never reads the vault config folder', async () => {
    const { hits } = await hub.searchMemory({ query: 'secret', settings: settings(), sources: ['obsidian'] });
    expect(hits).toHaveLength(0);
  });

  it('is part of the default source set, not opt-in', async () => {
    const { hits } = await hub.searchMemory({ query: 'gh release', settings: settings() });
    expect(hits.some(h => h.source === 'obsidian')).toBe(true);
  });
});

describe('write', () => {
  it('appends into a Tars folder rather than a note the user maintains', async () => {
    const [res] = await hub.writeMemory({
      content: 'The fork is cooper-labs-tech/Tars.',
      targets: ['obsidian'],
      projectPath: home,
      settings: settings(),
    });

    expect(res.success).toBe(true);
    expect(res.path).toBe(path.join(vault, 'Tars', 'Tars memory.md'));
    expect(fs.readFileSync(res.path!, 'utf-8')).toContain('cooper-labs-tech/Tars');
    // The user's own notes are untouched.
    expect(fs.readFileSync(path.join(vault, 'Index.md'), 'utf-8')).toBe('Everything starts here.\n');
  });

  it('appends rather than overwriting a second time', async () => {
    const args = { targets: ['obsidian'] as const, projectPath: home, settings: settings() };
    await hub.writeMemory({ ...args, content: 'first', targets: ['obsidian'] });
    const [res] = await hub.writeMemory({ ...args, content: 'second', targets: ['obsidian'] });

    const body = fs.readFileSync(res.path!, 'utf-8');
    expect(body).toContain('first');
    expect(body).toContain('second');
  });

  it('refuses to write outside the vault', async () => {
    const [res] = await hub.writeMemory({
      content: 'escape',
      targets: ['obsidian'],
      projectPath: home,
      settings: settings(),
      file: '../../escaped.md',
    });

    // The bad name is ignored, not honoured: the write lands on the default.
    expect(res.success).toBe(true);
    expect(res.path).toBe(path.join(vault, 'Tars', 'Tars memory.md'));
    expect(fs.existsSync(path.join(home, 'escaped.md'))).toBe(false);
  });

  it('reports the missing vault instead of silently succeeding', async () => {
    const [res] = await hub.writeMemory({
      content: 'nowhere to go',
      targets: ['obsidian'],
      projectPath: home,
      settings: {},
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('Obsidian');
  });

  it('is readable back through search, which is the whole point', async () => {
    await hub.writeMemory({
      content: 'The overseer runs on whatever model the gateway is set to.',
      targets: ['obsidian'],
      projectPath: home,
      settings: settings(),
    });

    const { hits } = await hub.searchMemory({ query: 'overseer runs', settings: settings(), sources: ['obsidian'] });
    expect(hits.some(h => h.content.includes('overseer runs on whatever model'))).toBe(true);
  });
});
