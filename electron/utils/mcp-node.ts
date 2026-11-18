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
 * set by a launcher, ~/.tars/bin/tars-mcp-node, which names the app binary.
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
 * gone. A symlinked ~/.tars/bin, or a symlinked launcher, is not written
 * through.
 */
export function mcpNodeCommand(
  appBinary: string = lastingAppBinary(),
  platform: NodeJS.Platform = process.platform,
  mayWrite: boolean = isPackaged() && !isTransientAppPath(appBinary),
): string {
  return launcherCommand('tars-mcp-node', app => [
    '# Written by a packaged Tars: its MCP servers run on the Node inside the app,',
    '# or on the node on the PATH once that app is gone.',
    `APP=${app}`,
    '[ -x "$APP" ] && ELECTRON_RUN_AS_NODE=1 exec "$APP" "$@"',
    'exec node "$@"',
  ], appBinary, platform, mayWrite);
}

/**
 * 22: the project's own floor (.nvmrc, package.json engines), the oldest LTS still maintained. Electron's own major
 * (24) would pass a Node 22 LTS over for the app's binary, where the server's native modules do not load.
 */
const USER_NODE_FLOOR = 22;

/**
 * The program a server the user names runs on (Settings, Tasmania: a path anywhere, with its own node_modules):
 * ~/.tars/bin/tars-user-mcp-node, the node on the PATH first, the Node inside the app when there is none.
 *
 * Signed with the hardened runtime (#591), the app's binary loads no native module but the app's own: library
 * validation. Measured on the first signed build (18/11): an N-API module of a server's own node_modules, which the ad
 * hoc 2.0.6 loaded run as Node, was refused ("different Team IDs"), and the system's node loads it. A module built
 * against Node's own ABI (NAN, better-sqlite3 installed with npm) never loaded in the app's binary anyway. Tars's own
 * bundles stay on mcpNodeCommand: they carry no native code of their own, and must not depend on the machine's Node.
 * The same rules of writing as that launcher; on Windows, `node`.
 *
 * The PATH's node is taken only from USER_NODE_FLOOR up (the Audit's L6): an older one, such as the Node 18 in
 * /usr/local/bin measured on 2026-09-24, would fail a server that ran on the app's Node 24 with nothing but a failed
 * server to show. Below it, or when node answers no version, the app's binary runs it, and one line on stderr (which
 * the CLI keeps in its MCP log; stdout is the protocol) says which runtime and why.
 */
export function userMcpNodeCommand(
  appBinary: string = lastingAppBinary(),
  platform: NodeJS.Platform = process.platform,
  mayWrite: boolean = isPackaged() && !isTransientAppPath(appBinary),
): string {
  return launcherCommand('tars-user-mcp-node', app => [
    `# Written by a packaged Tars: a server the user named runs on the node on the PATH when it is ${USER_NODE_FLOOR}`,
    '# or newer, which loads the native modules of its own node_modules; otherwise on the Node',
    '# inside the app (signed, it loads no native module but its own), said on stderr.',
    'MAJOR=$(node -p \'process.versions.node.split(".")[0]\' 2>/dev/null)',
    'case "$MAJOR" in \'\'|*[!0-9]*) MAJOR=0 ;; esac',
    `[ "$MAJOR" -ge ${USER_NODE_FLOOR} ] && exec node "$@"`,
    `if [ "$MAJOR" -gt 0 ]; then WHY="the node on the PATH is $MAJOR, under ${USER_NODE_FLOOR}"`,
    'elif command -v node >/dev/null 2>&1; then WHY="the node on the PATH answers no version"',
    'else WHY="no node on the PATH"; fi',
    `APP=${app}`,
    'if [ -x "$APP" ]; then',
    '  echo "tars-user-mcp-node: running on Tars\'s own Node ($WHY): native modules of the server\'s own node_modules will not load" >&2',
    '  ELECTRON_RUN_AS_NODE=1 exec "$APP" "$@"',
    'fi',
    'echo "tars-user-mcp-node: Tars is gone, running on the node on the PATH ($WHY)" >&2',
    'exec node "$@"',
  ], appBinary, platform, mayWrite);
}

/** ~/.tars/bin/<name>, a sh script of `lines` (given the app binary, quoted), written as mcpNodeCommand says. */
function launcherCommand(
  name: string,
  lines: (quotedApp: string) => string[],
  appBinary: string,
  platform: NodeJS.Platform,
  mayWrite: boolean,
): string {
  if (platform === 'win32') return 'node';
  const bin = path.join(DATA_DIR, 'bin');
  const launcher = path.join(bin, name);
  const isLink = (p: string) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  if (!mayWrite) return fs.existsSync(launcher) && !isLink(bin) && !isLink(launcher) ? launcher : 'node';
  if (isLink(bin) || isLink(launcher)) {
    console.warn(`[mcp] ~/.tars/bin/${name} is a link: not written through, the MCP servers run on \`node\``);
    return 'node';
  }
  const quoted = `'${appBinary.replace(/'/g, `'\\''`)}'`;
  const script = ['#!/bin/sh', ...lines(quoted), ''].join('\n');
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
function lastingAppBinary(): string {
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
