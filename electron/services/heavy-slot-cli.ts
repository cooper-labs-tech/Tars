import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { getSlotScriptPath } from '../utils';

/**
 * `tars-slot`, the heavy-run slot's command line (electron/resources/tars-slot.cjs), in every agent's terminal: for
 * git hooks and scripts, which cannot call an MCP tool (kotsna's heaviest run is the pre-push hook inside `git push`).
 *
 * Two shims in ~/.tars/bin, `tars-slot` (POSIX sh) and `tars-slot.cmd` (Windows), named by TARS_SLOT in every agent's
 * terminal and found last on its PATH: last, because every agent can write in ~/.tars, and a file put there first
 * would run instead of the command it is named after, for every agent (the Audit's M1 on #537). Last, it can only
 * supply a name nothing else on the PATH has. A login shell that sets PATH anew (Debian's and Ubuntu's /etc/profile)
 * drops it: "$TARS_SLOT" needs no PATH. They name no path of the app: they run "$TARS_NODE" "$TARS_SLOT_SCRIPT", which the terminal's environment
 * gives (slotEnv), so a run from source writing them changes nothing for a packaged Tars, and a moved app (an
 * AppImage mounted anew at each launch) needs no rewrite. TARS_NODE is the app's own binary, run as Node
 * (ELECTRON_RUN_AS_NODE, which the shim sets and the script takes back from the command it runs).
 *
 * A symlinked ~/.tars/bin, or a symlinked shim, is not written through (as utils/mcp-node.ts). ~/.tars is every
 * agent's (--add-dir): an agent can rewrite the shims, as it can tars-mcp-node, being the same user; SECURITY.md says
 * so.
 */

const POSIX_SHIM = [
  '#!/bin/sh',
  '# Written by Tars: the heavy-run slot\'s command line (tars-slot run -- <command>). Run from an agent\'s terminal.',
  '[ -n "$TARS_SLOT_SCRIPT" ] || { echo "tars-slot: run it from an agent\'s terminal started by Tars" >&2; exit 2; }',
  'if [ -z "$ELECTRON_RUN_AS_NODE" ]; then ELECTRON_RUN_AS_NODE=1 TARS_SLOT_UNSET_RUN_AS_NODE=1; export ELECTRON_RUN_AS_NODE TARS_SLOT_UNSET_RUN_AS_NODE; fi',
  'exec "${TARS_NODE:-node}" "$TARS_SLOT_SCRIPT" "$@"',
  '',
].join('\n');

const WINDOWS_SHIM = [
  '@echo off',
  'rem Written by Tars: the heavy-run slot\'s command line (tars-slot run -- <command>). Run from an agent\'s terminal.',
  'if "%TARS_SLOT_SCRIPT%"=="" (echo tars-slot: run it from an agent\'s terminal started by Tars 1>&2 & exit /b 2)',
  'if "%ELECTRON_RUN_AS_NODE%"=="" (set ELECTRON_RUN_AS_NODE=1& set TARS_SLOT_UNSET_RUN_AS_NODE=1)',
  'if "%TARS_NODE%"=="" (node "%TARS_SLOT_SCRIPT%" %*) else ("%TARS_NODE%" "%TARS_SLOT_SCRIPT%" %*)',
  '',
].join('\r\n');

export function slotBin(): string {
  return path.join(DATA_DIR, 'bin');
}

const isLink = (p: string) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

/** Both shims, written when missing or different; never through a link. */
export function installSlotShims(bin: string = slotBin()): void {
  if (isLink(bin)) {
    console.warn('[heavy-slot] ~/.tars/bin is a link: tars-slot is not written through it');
    return;
  }
  for (const [name, text, mode] of [['tars-slot', POSIX_SHIM, 0o700], ['tars-slot.cmd', WINDOWS_SHIM, 0o600]] as const) {
    const file = path.join(bin, name);
    try {
      if (isLink(file)) { console.warn(`[heavy-slot] ${file} is a link: not written through`); continue; }
      let current: string | undefined;
      try { current = fs.readFileSync(file, 'utf-8'); } catch { /* not written yet */ }
      if (current !== text) {
        fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
        const tmp = `${file}.tmp`;
        fs.rmSync(tmp, { force: true });
        fs.writeFileSync(tmp, text, { flag: 'wx', mode });
        fs.renameSync(tmp, file);
      }
      if (process.platform !== 'win32') fs.chmodSync(file, mode);
    } catch (err) {
      console.warn(`[heavy-slot] ${name} could not be written in ${bin}:`, err);
    }
  }
}

/**
 * What an agent's terminal gets for `tars-slot`: the script, the Node to run it on (the app's own binary: an
 * AppImage's file, not its mount), the shim's own path (TARS_SLOT), and ~/.tars/bin last on its PATH (under the key
 * the environment already uses: `Path` on Windows).
 */
export function slotEnv(env: Record<string, string | undefined>, bin: string = slotBin()): Record<string, string> {
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key] ?? '';
  // The platform's separator, read from process.platform as the rest of electron/platform/ reads it.
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const parts = current.split(delimiter).filter(Boolean);
  // The script is found through the running app; outside one (a unit test's stand-in of Electron) there is none to
  // name, the shim then says it needs an agent's terminal, and the terminal is started all the same.
  let script: string | undefined;
  try { script = getSlotScriptPath(); } catch { script = undefined; }
  return {
    ...(script ? { TARS_SLOT_SCRIPT: script } : {}),
    TARS_NODE: process.env.APPIMAGE || process.execPath,
    TARS_SLOT: path.join(bin, process.platform === 'win32' ? 'tars-slot.cmd' : 'tars-slot'),
    // Last, never first: see the header. One already there, wherever it stands, is left where the user put it.
    [key]: parts.includes(bin) ? current : [...parts, bin].join(delimiter),
  };
}
