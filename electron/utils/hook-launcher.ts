import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { childEnv } from '../platform/child-env';
import type { Env } from '../platform/fs-probe';
import { isPlainAbsolute } from '../platform/cli-binary';
import { envValue, pathEntries } from '../platform/path-env';
import { lastingAppBinary } from './mcp-node';
import { buildFullPath } from './path-builder';

/**
 * What every hook and the status line Tars wires start through, on macOS,
 * Linux and Windows alike (2.0.4, parity P4):
 * `<launcher> "<hooks>/tars-hook.mjs" <event>`, and `statusline.mjs` with no
 * event. The launcher is ~/.dorothy/bin/tars-hook, a POSIX sh script, or
 * tars-hook.cmd on Windows, written by Tars at each start.
 *
 * It runs the Node runner on, in this order:
 *  - the Node found at start: the first `node` on the agents' PATH that
 *    answers a version of 16 or later (what the runner needs). A Node of the
 *    machine starts in about half the time of the app's (measured on
 *    2026-10-17: 125 to 147 ms a tool call against 182 to 195 at load 110);
 *  - the app's own Node, the app binary with ELECTRON_RUN_AS_NODE=1, as the
 *    MCP servers do (utils/mcp-node.ts), so no machine needs a Node;
 *  - the `node` of the PATH, once both are gone.
 * So no hook needs bash, jq, curl or awk anywhere: until 2.0.4 macOS and Linux
 * ran the .sh hooks and a bash status line, which need all four.
 *
 * In a session Tars did not start there is no terminal token
 * (CLAUDE_MGR_API_TOKEN), and every post most hooks make goes to Tars's hook
 * routes, which take that token and nothing else. Those events answer in the
 * launcher, as the runner would, before any Node starts (SKIPPED_OUTSIDE_TARS).
 * SessionStart (the memory context), PostToolUse (the memory remember), which
 * read with the shared token there, and the status line (the quota counters)
 * run everywhere.
 *
 * Windows: the command line is read by Git Bash (Claude Code with Git) and by
 * PowerShell (Claude Code without Git Bash, Gemini always), and PowerShell
 * does not run a command line that starts with a quoted path. So the launcher
 * starts one only when its path needs no quotes, as is or in its 8.3 form;
 * otherwise the command starts with `node`, as it did before, and needs a Node
 * on the PATH. A .cmd is read in the console's code page: a path in it that is
 * not plain ASCII is taken in its 8.3 form, or left out.
 */

const CONTINUE = '{"continue":true,"suppressOutput":true}';

/**
 * The events a session Tars did not start has nothing to do with, and what
 * the runner answers for each: its posts all go to /api/hooks/*, which takes
 * a terminal's own token alone (__tests__/electron/utils/hook-launcher.test.ts
 * runs the runner outside Tars to hold this list to it).
 */
export const SKIPPED_OUTSIDE_TARS: Readonly<Record<string, string>> = Object.freeze({
  'user-prompt-submit': `${CONTINUE}\n`,
  'on-stop': `${CONTINUE}\n`,
  'stop-failure': '',
  'session-end': `${CONTINUE}\n`,
  notification: `${CONTINUE}\n`,
  'permission-request': `${CONTINUE}\n`,
  'task-completed': `${CONTINUE}\n`,
  'gemini/session-start': `${CONTINUE}\n`,
  'gemini/user-prompt-submit': `${CONTINUE}\n`,
  'gemini/on-stop': `${CONTINUE}\n`,
  'gemini/session-end': `${CONTINUE}\n`,
  'gemini/notification': `${CONTINUE}\n`,
});

const MIN_NODE_MAJOR = 16;
const NODE_PROBE_MS = 5_000;
const SHORT_PATH_MS = 10_000;

/** The launcher's file name in ~/.dorothy/bin. */
export function launcherName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'tars-hook.cmd' : 'tars-hook';
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** A path a .cmd carries as it is: printable ASCII, no double quote. */
const cmdSafe = (p: string) => /^[\x20-\x7e]+$/.test(p) && !p.includes('"');
const cmdQuote = (p: string) => `"${p.replace(/%/g, '%%')}"`;

/** The launcher's text. A path that cannot be carried is left out, and the next step is taken. */
export function launcherScript({ platform, node, app }: { platform: NodeJS.Platform; node: string | null; app: string | null }): string {
  const groups = new Map<string, string[]>();
  for (const [event, answer] of Object.entries(SKIPPED_OUTSIDE_TARS)) groups.set(answer, [...(groups.get(answer) ?? []), event]);

  if (platform === 'win32') {
    const lines = [
      '@echo off',
      'rem Written by Tars at each start (electron/utils/hook-launcher.ts): what its hooks and its',
      'rem status line start through. %1 is the script, %2 the event. Outside a session Tars started',
      'rem (no terminal token) these events only post to its hook routes, which take that token alone.',
      'setlocal',
      'if defined CLAUDE_MGR_API_TOKEN goto run',
    ];
    for (const [answer, events] of groups) {
      const say = answer ? `echo ${answer.trimEnd()}& ` : '';
      lines.push(`for %%E in (${events.join(' ')}) do if /i "%~2"=="%%E" (${say}exit /b 0)`);
    }
    lines.push(':run');
    if (node && cmdSafe(node)) lines.push(`if not exist ${cmdQuote(node)} goto app`, `${cmdQuote(node)} %*`, 'exit /b');
    lines.push(':app');
    if (app && cmdSafe(app)) lines.push(`if not exist ${cmdQuote(app)} goto path`, 'set ELECTRON_RUN_AS_NODE=1', `${cmdQuote(app)} %*`, 'exit /b');
    lines.push(':path', 'node %*', '');
    return lines.join('\r\n');
  }

  const lines = [
    '#!/bin/sh',
    '# Written by Tars at each start (electron/utils/hook-launcher.ts): what its hooks and its',
    '# status line start through. $1 is the script, $2 the event. Outside a session Tars started',
    '# (no terminal token) these events only post to its hook routes, which take that token alone.',
    'if [ -z "${CLAUDE_MGR_API_TOKEN:-}" ]; then',
    '  case "${2:-}" in',
  ];
  for (const [answer, events] of groups) {
    lines.push(`    ${events.join('|')}) ${answer ? `printf '%s\\n' ${shQuote(answer.trimEnd())}; ` : ''}exit 0 ;;`);
  }
  lines.push('  esac', 'fi');
  if (node) lines.push(`NODE=${shQuote(node)}`, '[ -x "$NODE" ] && exec "$NODE" "$@"');
  if (app) lines.push(`APP=${shQuote(app)}`, '[ -x "$APP" ] && ELECTRON_RUN_AS_NODE=1 exec "$APP" "$@"');
  lines.push('exec node "$@"', '');
  return lines.join('\n');
}

/**
 * How a command line names the launcher, or null when it cannot: POSIX in
 * double quotes, or single ones when the path holds a `$`, a backtick, a
 * double quote or a backslash; win32 bare, with forward slashes, only when
 * the path needs no quoting in Git Bash or PowerShell.
 */
export function launcherFirstWord(file: string, platform: NodeJS.Platform): string | null {
  if (platform === 'win32') {
    const fwd = file.replace(/\\/g, '/');
    return /^[A-Za-z]:\/[A-Za-z0-9._~/-]+$/.test(fwd) ? fwd : null;
  }
  if (!path.posix.isAbsolute(file)) return null;
  if (!/[$`"\\]/.test(file)) return `"${file}"`;
  if (!file.includes("'")) return `'${file}'`;
  return null;
}

type Run = (file: string) => Promise<string>;

/** The first `node` on the PATH that answers a version of 16 or later, by absolute path; null when none does. */
export async function findHookNode({ env, platform, run, isFile, timeoutMs = NODE_PROBE_MS }: {
  env: Env;
  platform: NodeJS.Platform;
  run?: Run;
  isFile?: (p: string) => boolean;
  timeoutMs?: number;
}): Promise<string | null> {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const name = platform === 'win32' ? 'node.exe' : 'node';
  const probe = run ?? ((file: string) => new Promise<string>((resolve, reject) => {
    // Without NODE_OPTIONS: a flag of Tars's own environment is no business of a version probe.
    const probeEnv = { ...process.env };
    delete probeEnv.NODE_OPTIONS;
    execFile(file, ['-p', 'process.versions.node'], { timeout: timeoutMs, windowsHide: true, env: probeEnv, encoding: 'utf8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  }));
  const exists = isFile ?? ((file: string) => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  const seen = new Set<string>();
  for (const raw of pathEntries(envValue(env, 'PATH', platform), platform)) {
    const dir = raw.replace(/^"(.*)"$/, '$1');
    if (!dir || !p.isAbsolute(dir) || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = p.join(dir, name);
    if (!exists(candidate)) continue;
    try {
      const m = /^v?(\d+)\.\d+\.\d+\s*$/.exec(await probe(candidate));
      if (m && Number(m[1]) >= MIN_NODE_MAJOR) return candidate;
    } catch {
      // Not a Node that answers: the next one.
    }
  }
  return null;
}

/** A Windows path's 8.3 form, through the Windows PowerShell under SystemRoot; null when there is none. */
async function windowsShortPath(file: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const root = envValue(env, 'SystemRoot', 'win32');
  const systemRoot = root && isPlainAbsolute(root) ? root : 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = '$f = New-Object -ComObject Scripting.FileSystemObject; '
    + 'if (Test-Path -LiteralPath $env:TARS_FILE -PathType Leaf) { $f.GetFile($env:TARS_FILE).ShortPath }';
  return new Promise((resolve) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      timeout: SHORT_PATH_MS, windowsHide: true, encoding: 'utf8', env: childEnv(powershell, { ...env, TARS_FILE: file }, 'win32') as NodeJS.ProcessEnv,
    }, (err, stdout) => {
      const out = String(stdout ?? '').trim();
      resolve(!err && path.win32.isAbsolute(out) ? out : null);
    });
  });
}

/**
 * Writes the launcher: beside itself, then renamed over it, 0700; not again
 * when it says the same; never through a symlinked folder or file. Its path,
 * or null when it could not be written.
 */
export function writeHookLauncher({ platform, node, app, dataDir = DATA_DIR }: {
  platform: NodeJS.Platform; node: string | null; app: string | null; dataDir?: string;
}): string | null {
  const bin = path.join(dataDir, 'bin');
  const file = path.join(bin, launcherName(platform));
  const isLink = (p: string) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
  if (isLink(bin) || isLink(file)) {
    console.warn(`[hooks] ${file} is a link: not written through, the hooks run on \`node\``);
    return null;
  }
  const script = launcherScript({ platform, node, app });
  try {
    let current: string | undefined;
    try { current = fs.readFileSync(file, 'utf-8'); } catch { /* not written yet */ }
    if (current !== script) {
      fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(tmp, script, { flag: 'wx', mode: 0o700 });
      fs.renameSync(tmp, file);
    }
    if (platform !== 'win32') fs.chmodSync(file, 0o700);
    return file;
  } catch (err) {
    console.warn('[hooks] the hook launcher could not be written, the hooks run on `node`:', err);
    return null;
  }
}

let firstWord: string | null = null;

/** What the hook commands start with from now on: the launcher as a command line names it, or null for `node`. */
export function setHookLauncherWord(word: string | null): void {
  firstWord = word;
}

/** The first word of every hook command: the launcher once prepared, else `node`. */
export function hookRunnerFirstWord(): string {
  return firstWord ?? 'node';
}

/**
 * At each start, before the CLIs' hooks are configured: finds the Node, writes
 * the launcher and makes it the first word of every hook command. Returns
 * that word.
 */
export async function prepareHookLauncher(platform: NodeJS.Platform = process.platform): Promise<string> {
  const node = await findHookNode({ env: { PATH: buildFullPath() }, platform });
  let app: string | null = lastingAppBinary();
  let named = node;
  if (platform === 'win32') {
    if (named && !cmdSafe(named)) named = await windowsShortPath(named);
    if (app && !cmdSafe(app)) app = await windowsShortPath(app);
  }
  const file = writeHookLauncher({ platform, node: named, app });
  let word = file ? launcherFirstWord(file, platform) : null;
  if (!word && file && platform === 'win32') {
    const short = await windowsShortPath(file);
    word = short ? launcherFirstWord(short, platform) : null;
  }
  setHookLauncherWord(word);
  console.log(`[hooks] the hooks start through ${word ?? 'node'}, on ${named ?? (app ? 'the app\'s own Node' : 'the node of the PATH')}`);
  return hookRunnerFirstWord();
}
