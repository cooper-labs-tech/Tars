import '../../setup/home-guard';
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Tars's data folder as every reader outside the app finds it (the Audit's L2
 * on #473): the hooks (tars-hook-lib.mjs, tars-hook.sh), the status line
 * (statusline.mjs), the MCP servers (mcp-shared) and worktree.mjs. They run
 * in the CLIs and shells Tars starts, and they cannot ask Tars where its data
 * is: each finds it on disk, by the rule Tars decides with (pickDataDir).
 *
 * Every way it can fail, written before the code (2026-10-19):
 *  R1. A reader picks ~/.tars because something is there, a file, a link to a
 *      file or a link that leads nowhere, while Tars stays on ~/.dorothy: it
 *      reads app-settings.json under a file (ENOTDIR), and its settings go
 *      unread.
 *  R2. A reader picks ~/.tars where Tars, finding two different folders, uses
 *      the one that holds its records (~/.dorothy): the hooks log, the status
 *      line counts and the MCP servers' keys go to a folder Tars never reads.
 *  R3. One reader follows a rule of its own: whatever the rule, they must all
 *      land on the folder settleDataDir answered, on the home it left.
 */

import { settleDataDir } from '../../../electron/core/data-dir-move';
// @ts-expect-error a plain .mjs module, without types
import { dataDir as hookLibDataDir } from '../../../hooks/tars-hook-lib.mjs';
// @ts-expect-error a plain .mjs module, without types
import { tarsDataDir as worktreeDataDir } from '../../../scripts/worktree.mjs';
import { dataDir as mcpDataDir } from '../../../mcp-shared/src/settings';

const ROOT = path.join(__dirname, '../../..');
const put = (file: string, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const link = (target: string, at: string) => fs.symlinkSync(target, at, 'dir');

/** The homes a user can have, by what is at ~/.tars and ~/.dorothy. */
const HOMES: Array<[string, (h: string) => void]> = [
  ['nothing', () => {}],
  ['~/.dorothy only (a 2.0.3 home)', (h) => put(path.join(h, '.dorothy', 'agents.json'))],
  ['moved, with the link', (h) => { put(path.join(h, '.tars', 'agents.json')); link('.tars', path.join(h, '.dorothy')); }],
  ['two real folders, both with records', (h) => { put(path.join(h, '.tars', 'agents.json')); put(path.join(h, '.dorothy', 'agents.json')); }],
  ['~/.tars a file', (h) => { put(path.join(h, '.tars'), 'file'); put(path.join(h, '.dorothy', 'agents.json')); }],
  ['~/.tars a file, no ~/.dorothy', (h) => put(path.join(h, '.tars'), 'file')],
  ['~/.tars a link to a file', (h) => { put(path.join(h, 'f'), 'f'); fs.symlinkSync(path.join(h, 'f'), path.join(h, '.tars')); put(path.join(h, '.dorothy', 'agents.json')); }],
  ['~/.tars a dangling link', (h) => { fs.symlinkSync(path.join(h, 'gone'), path.join(h, '.tars')); put(path.join(h, '.dorothy', 'agents.json')); }],
  ['~/.dorothy a link elsewhere with records, ~/.tars without', (h) => { put(path.join(h, 'ext', 'app-settings.json'), '{}'); link(path.join(h, 'ext'), path.join(h, '.dorothy')); put(path.join(h, '.tars', 'x')); }],
  ['~/.tars a link to a foreign folder, ~/.dorothy with records', (h) => { put(path.join(h, 'ext', 'x')); link(path.join(h, 'ext'), path.join(h, '.tars')); put(path.join(h, '.dorothy', 'agents.json')); }],
];

/** A home as Tars leaves it at its start: the move settled, its folder made. */
function started(seed: (h: string) => void): { home: string; dir: string } {
  const home = fs.mkdtempSync(path.join(os.homedir(), 'readers-'));
  seed(home);
  const { dir } = settleDataDir(home);
  fs.mkdirSync(dir, { recursive: true });
  return { home, dir };
}

const realHome = process.env.HOME;
afterEach(() => { process.env.HOME = realHome; });
const inHome = <T>(home: string, read: () => T): T => { process.env.HOME = home; try { return read(); } finally { process.env.HOME = realHome; } };

function cleanEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE_|DOROTHY_|TARS_)/.test(k)) env[k] = v;
  return { ...env, HOME: home, USERPROFILE: home };
}

function statusLineWrites(home: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'hooks', 'statusline.mjs')], { cwd: home, env: cleanEnv(home) });
    child.on('error', reject);
    child.on('close', () => resolve());
    child.stdin.end(JSON.stringify({ session_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', model: { display_name: 'Opus' }, rate_limits: { five_hour: { used_percentage: 1 } } }));
  });
}

describe('every reader outside the app finds the folder Tars settled on', () => {
  for (const [name, seed] of HOMES) {
    it(`R1 to R3. ${name}`, async () => {
      let s = started(seed);
      expect(inHome(s.home, () => hookLibDataDir()), 'tars-hook-lib.mjs').toBe(s.dir);
      expect(inHome(s.home, () => mcpDataDir()), 'mcp-shared').toBe(s.dir);
      expect(inHome(s.home, () => worktreeDataDir()), 'worktree.mjs').toBe(s.dir);

      // tars-hook.sh makes its logs folder in the folder it picks: a home of its own.
      s = started(seed);
      const sh = spawnSync('/bin/bash', ['-c', `source "${path.join(ROOT, 'hooks', 'tars-hook.sh')}"; printf %s "$TARS_DATA_DIR"`], { env: cleanEnv(s.home), encoding: 'utf8' });
      expect(sh.stdout, 'tars-hook.sh').toBe(s.dir);

      s = started(seed);
      await statusLineWrites(s.home);
      expect(fs.existsSync(path.join(s.dir, 'rate-limits.json')), 'statusline.mjs wrote into Tars\'s folder').toBe(true);
      for (const other of ['.tars', '.dorothy'].map((n) => path.join(s.home, n))) {
        let same = false;
        try { same = fs.realpathSync(other) === fs.realpathSync(s.dir); } catch { /* not there */ }
        if (!same) expect(fs.existsSync(path.join(other, 'rate-limits.json')), `statusline.mjs wrote into ${other}`).toBe(false);
      }
    });
  }
});
