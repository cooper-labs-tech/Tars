import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { DATA_DIR } from '../constants';

/**
 * The program Tars's own MCP servers run on: the Node inside the app.
 *
 * Every registration used to name `node`, and the CLI that starts a server
 * looks that up on its own PATH. An agent's terminal is `/bin/bash -l`, and on
 * macOS /etc/profile runs path_helper, which puts /etc/paths, /usr/local/bin
 * first, ahead of the PATH Tars hands the shell. Measured on 2026-09-24: the
 * live Tars's servers ran /usr/local/bin/node, Node 18.16, end of life, though
 * the settings named a Node 22 and nvm had 22 and 24. And a machine with no
 * Node at all, which claude's native installer does not need, got no Tars tools.
 *
 * The app's binary is a Node when ELECTRON_RUN_AS_NODE=1 is set, the version
 * Tars ships and runs its own main process on; the seven bundles answered
 * `tools/list` on it in the installed Tars 1.8 (Electron 43, Node 24.18). A
 * checked minimum among the machine's Nodes was the other way: it still leaves
 * a machine with none, or only an old one, without the tools.
 *
 * The CLIs take a command and arguments and no environment of Tars's choosing
 * (and the same files are read by the user's own sessions), so the variable is
 * set by a launcher, ~/.dorothy/bin/tars-mcp-node, which names the app binary.
 * Rewritten when the app has moved (an AppImage mounts somewhere new at each
 * launch), left alone otherwise. This relies on Electron's RunAsNode fuse,
 * which is on by default and which Tars does not turn off; turning it off
 * means giving these servers another runtime first.
 *
 * Windows has no such script to run: `node` there, as before. So is a launcher
 * that cannot be written.
 *
 * Written by a packaged Tars at a lasting place only (the Audit's gate of
 * #201). A dev run on the real HOME rewrote it to a worktree's Electron, and
 * once that was gone every Tars server of every claude session, in Tars and
 * out of it, failed to connect; a copy run from a DMG, or translocated by
 * macOS, is gone once it quits. Such a start names the launcher already there
 * and leaves it as it is, or names `node` when there is none. On Linux the
 * AppImage file ($APPIMAGE) is named, not its mount point under /tmp. And the
 * script itself falls back to the `node` on the PATH when the app it names is
 * gone. A symlinked ~/.dorothy/bin, or a symlinked launcher, is not written
 * through.
 */
export function mcpNodeCommand(
  appBinary: string = lastingAppBinary(),
  platform: NodeJS.Platform = process.platform,
  mayWrite: boolean = isPackaged() && !isTransientAppPath(appBinary),
): string {
  if (platform === 'win32') return 'node';
  const bin = path.join(DATA_DIR, 'bin');
  const launcher = path.join(bin, 'tars-mcp-node');
  const isLink = (p: string) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  if (!mayWrite) return fs.existsSync(launcher) && !isLink(bin) && !isLink(launcher) ? launcher : 'node';
  if (isLink(bin) || isLink(launcher)) {
    console.warn('[mcp] ~/.dorothy/bin/tars-mcp-node is a link: not written through, the MCP servers run on `node`');
    return 'node';
  }
  const quoted = `'${appBinary.replace(/'/g, `'\\''`)}'`;
  const script = [
    '#!/bin/sh',
    '# Written by a packaged Tars: its MCP servers run on the Node inside the app,',
    '# or on the node on the PATH once that app is gone.',
    `APP=${quoted}`,
    '[ -x "$APP" ] && ELECTRON_RUN_AS_NODE=1 exec "$APP" "$@"',
    'exec node "$@"',
    '',
  ].join('\n');
  try {
    let current: string | undefined;
    try { current = fs.readFileSync(launcher, 'utf-8'); } catch { /* not written yet */ }
    if (current !== script) {
      fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
      const tmp = `${launcher}.tmp`;
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(tmp, script, { flag: 'wx', mode: 0o700 });
      fs.renameSync(tmp, launcher);
    }
    fs.chmodSync(launcher, 0o700);
    return launcher;
  } catch (err) {
    console.warn('[mcp] the launcher for the MCP servers could not be written, they run on `node`:', err);
    return 'node';
  }
}

/** Whether this is a packaged Tars. Undefined outside Electron, as in a plain node test. */
function isPackaged(): boolean {
  return (app as { isPackaged?: boolean } | undefined)?.isPackaged === true;
}

/** The app's path as it will still be once it quits: an AppImage's file, not its mount. $APPIMAGE is set by the AppImage runtime only. */
export function lastingAppBinary(): string {
  return process.env.APPIMAGE || process.execPath;
}

/**
 * A copy run from a disk image, or translocated by macOS, is gone once it
 * quits: nothing that outlives it may name a path inside it (the launcher,
 * the MCP servers' registrations).
 */
export function isTransientAppPath(appPath: string): boolean {
  return appPath.startsWith('/Volumes/') || appPath.includes('/AppTranslocation/');
}
