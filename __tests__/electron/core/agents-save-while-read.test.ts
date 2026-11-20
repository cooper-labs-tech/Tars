import '../../setup/home-guard';
import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * agents.json saved while another process reads it (ETHOS 7; the reviewer's
 * gate of win/paths-memory-security). saveAgents ends in a rename over the
 * live file, which Windows refuses (EPERM) while any process holds it open,
 * and the error is only logged: the change made in the app never reached the
 * disk, and nothing said so.
 *
 * How it can fail, written before the fix:
 * 1. a save whose rename a reader refuses a few times leaves the previous list on disk;
 * 2. a reader sees a partial file.
 *
 * The gate is the fake below: the rename is refused as Windows refuses it, on
 * any host. The real disk is a measurement, opt-in (TARS_STRESS=1): what it
 * counts depends on what else holds the file (the reviewer saw 6 to 10 s
 * blocks), so it prints and never fails the default suite.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-agents-read-')));
const AGENTS_FILE = path.join(tmp, 'agents.json');

const refusals = vi.hoisted(() => ({ left: 0, target: '' }));
refusals.target = AGENTS_FILE;
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (refusals.left > 0 && String(to) === refusals.target) {
        refusals.left--;
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
      }
      return actual.renameSync(from, to);
    },
  };
});
vi.mock('../../../electron/constants', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, DATA_DIR: tmp, AGENTS_FILE };
});
vi.mock('electron', () => ({
  app: { getPath: () => tmp, getAppPath: () => tmp, getVersion: () => '1.4.0' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
}));

const HOST = process.platform;
afterEach(() => { Object.defineProperty(process, 'platform', { value: HOST, configurable: true }); refusals.left = 0; });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const agentNamed = (name: string) => ({
  id: 'a1', name, status: 'idle', projectPath: tmp, output: [],
  lastActivity: new Date().toISOString(), provider: 'claude', skills: [],
}) as never;

describe('saveAgents while another program holds agents.json', () => {
  it('1. a save whose rename Windows refuses a few times still reaches the disk', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const manager = await import('../../../electron/core/agent-manager');
    manager.loadAgents();
    try {
      manager.agents.set('a1', agentNamed('before'));
      manager.saveAgents();
      refusals.left = 3;
      manager.agents.set('a1', agentNamed('while held'));
      manager.saveAgents();
      expect(refusals.left, 'the rename was never tried').toBe(0);
      expect(JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).agents[0]?.name).toBe('while held');
    } finally {
      manager.stopAgentAutosave();
    }
  });
});

const READER = `
const fs = require('fs');
const [file, stop] = process.argv.slice(1);
const pause = new Int32Array(new SharedArrayBuffer(4));
let torn = 0;
process.stdout.write('ready\\n');
while (!fs.existsSync(stop)) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (!['EPERM', 'EBUSY', 'EACCES', 'ENOENT'].includes(e.code)) torn++; }
  if (text !== undefined) { try { JSON.parse(text); } catch { torn++; } }
  Atomics.wait(pause, 0, 0, 1);
}
process.stdout.write(JSON.stringify({ torn }));
`;

describe.runIf(process.env.TARS_STRESS === '1')('saveAgents under 8 real readers (TARS_STRESS=1, a measurement)', () => {
  it('2. reports the saves lost, and no reader sees half a file', async () => {
    const manager = await import('../../../electron/core/agent-manager');
    manager.loadAgents();
    const stop = path.join(tmp, 'stop');
    fs.rmSync(stop, { force: true });
    const readers = Array.from({ length: 8 }, () => {
      const child = spawn(process.execPath, ['-e', READER, AGENTS_FILE, stop], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      const ready = new Promise<void>(resolve => child.stdout.on('data', (d: Buffer) => { out += d; if (out.includes('ready')) resolve(); }));
      const done = new Promise<{ torn: number }>(resolve => child.on('exit', () => resolve(JSON.parse(out.slice(out.indexOf('{'))))));
      return { ready, done };
    });
    const lost: number[] = [];
    try {
      await Promise.all(readers.map(r => r.ready));
      for (let n = 0; n < 40; n++) {
        manager.agents.set('a1', agentNamed(`save ${n}`));
        manager.saveAgents();
        const onDisk = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).agents[0]?.name;
        if (onDisk !== `save ${n}`) lost.push(n);
      }
    } finally {
      fs.writeFileSync(stop, '');
      manager.stopAgentAutosave();
    }
    const torn = (await Promise.all(readers.map(r => r.done))).reduce((a, r) => a + r.torn, 0);
    console.log(`[agents-stress] 40 saves under 8 readers: ${JSON.stringify({ lost: lost.length, torn })}`);
    expect(torn).toBe(0);
  }, 240_000);
});
