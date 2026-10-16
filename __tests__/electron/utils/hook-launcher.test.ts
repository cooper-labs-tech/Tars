import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SKIPPED_OUTSIDE_TARS, launcherScript, launcherFirstWord, findHookNode, writeHookLauncher,
} from '../../../electron/utils/hook-launcher';

/**
 * The hook launcher (2.0.4, parity P4): what every hook and the status line of every CLI Tars wires starts through,
 * on macOS, Linux and Windows alike. `<launcher> "<hooks>/tars-hook.mjs" <event>`, written by Tars at each start in
 * ~/.dorothy/bin: `tars-hook`, a POSIX sh script, or `tars-hook.cmd` on Windows. It runs the Node runner on a Node
 * found once at start (16 or later, the first on the agents' PATH), else on the app's own Node
 * (ELECTRON_RUN_AS_NODE=1), else on the `node` of the PATH. So no jq, curl or awk on any platform, and on Windows no
 * Node installed either. In a session Tars did not start (no terminal token), the events whose every post is refused
 * there stop in the launcher, before any Node starts.
 *
 * How it fails, written before the code:
 * 1. The Node it names is older than 16, or not a Node; or the first `node` on the PATH is too old and a later one
 *    is passed over; or the search throws, hangs, or names a relative path.
 * 2. No Node at start, or the one named removed since: the hooks stop, instead of running on the app's own Node, and
 *    once the app is gone, on the `node` of the PATH.
 * 3. A path baked in breaks the script: a quote, a space or a `$` in a POSIX path; a `%` in a .cmd, or a character the
 *    console code page reads otherwise.
 * 4. Written in place (a hook starting meanwhile reads half a script), through a symlinked folder or file, not
 *    executable, or rewritten at every start when nothing changed.
 * 5. Outside Tars, an event with nothing to do there still starts Node (the cost of each of them), or one that has
 *    work there is skipped: the SessionStart memory context and the PostToolUse memory remember, which read with the
 *    shared token, and the status line's quota counters. Inside Tars, any event is skipped.
 * 6. The skip list drifts from the runner: an event skipped while the runner, outside Tars, sends something that is
 *    not refused (anything but /api/hooks/*), or the launcher answers otherwise than the runner would.
 * 7. Windows: the command line starts with a quoted path, which PowerShell (Gemini always, Claude Code without Git
 *    Bash) does not run; or a launcher path that needs quoting is used anyway instead of the `node` form.
 * 8. Its exit code, its arguments or its stdin are not the runner's: a hook that fails reads as one that worked, an
 *    event or a script path with a space is cut, the hook's JSON does not reach the runner.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-hook-launcher-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const posix = process.platform !== 'win32';
const HOOKS = path.join(__dirname, '../../../hooks');

/** A stand-in Node that prints `tag`, ELECTRON_RUN_AS_NODE, its argv and its stdin, and exits 7; `-p` answers `version`. */
function fakeNode(dir: string, version: string, name = 'node', tag = name): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `if [ "$1" = "-p" ]; then echo ${version}; exit 0; fi`,
    `printf '%s|' "${tag}" "$ELECTRON_RUN_AS_NODE" "$@"; cat; exit 7`,
    '',
  ].join('\n'), { mode: 0o755 });
  return file;
}

describe('the Node a launcher names', () => {
  it.runIf(posix)('1. the first Node of 16 or later on the PATH, by absolute path', async () => {
    const old = path.dirname(fakeNode(path.join(tmp, 'n1-old'), '14.21.3'));
    const good = fakeNode(path.join(tmp, 'n1-good'), '22.12.0');
    const later = path.dirname(fakeNode(path.join(tmp, 'n1-later'), '24.1.0'));
    const PATH = ['relative/bin', path.join(tmp, 'n1-missing'), old, path.dirname(good), later].join(':');
    expect(await findHookNode({ env: { PATH }, platform: process.platform })).toBe(good);
  });

  it.runIf(posix)('1. none when no Node answers a version of 16 or later', async () => {
    const old = path.dirname(fakeNode(path.join(tmp, 'n2-old'), '15.9.0'));
    const notNode = path.join(tmp, 'n2-odd');
    fs.mkdirSync(notNode, { recursive: true });
    fs.writeFileSync(path.join(notNode, 'node'), '#!/bin/sh\necho hello\n', { mode: 0o755 });
    const hangs = path.join(tmp, 'n2-hangs');
    fs.mkdirSync(hangs, { recursive: true });
    fs.writeFileSync(path.join(hangs, 'node'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const started = Date.now();
    expect(await findHookNode({ env: { PATH: [old, notNode, hangs].join(':') }, platform: process.platform, timeoutMs: 500 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await findHookNode({ env: {}, platform: process.platform })).toBeNull();
  });

  it('1. win32: node.exe on the PATH, its version asked of it', async () => {
    const asked: string[] = [];
    const run = async (file: string) => { asked.push(file); return file.startsWith('C:\\old') ? 'v12.0.0' : '20.11.1\r\n'; };
    const isFile = (p: string) => /^C:\\(old|nodejs)\\node\.exe$/i.test(p);
    expect(await findHookNode({ env: { Path: 'C:\\old;rel\\bin;C:\\nodejs' }, platform: 'win32', run, isFile })).toBe('C:\\nodejs\\node.exe');
    expect(asked).toEqual(['C:\\old\\node.exe', 'C:\\nodejs\\node.exe']);
  });
});

describe('the launcher script', () => {
  it('5-6. stops, outside Tars, exactly the events whose posts are all refused there, answering as the runner does', () => {
    expect(Object.keys(SKIPPED_OUTSIDE_TARS).sort()).toEqual([
      'gemini/notification', 'gemini/on-stop', 'gemini/session-end', 'gemini/session-start', 'gemini/user-prompt-submit',
      'notification', 'on-stop', 'permission-request', 'session-end', 'stop-failure', 'task-completed', 'user-prompt-submit',
    ]);
    for (const kept of ['session-start', 'post-tool-use', 'gemini/post-tool-use']) expect(SKIPPED_OUTSIDE_TARS).not.toHaveProperty(kept);
  });

  it('3. POSIX: every path single-quoted, whatever it holds', () => {
    const odd = "/Users/o'neil $x/Tars `y`.app/Contents/MacOS/Tars";
    const script = launcherScript({ platform: 'darwin', node: '/opt/n o/node', app: odd });
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain("NODE='/opt/n o/node'");
    expect(script).toContain(`APP='/Users/o'\\''neil $x/Tars \`y\`.app/Contents/MacOS/Tars'`);
    expect(launcherScript({ platform: 'linux', node: null, app: null })).not.toMatch(/^NODE=|^APP=/m);
  });

  it('3. win32: a .cmd, its paths doubled-%, a path the console could misread left out', () => {
    const script = launcherScript({ platform: 'win32', node: 'C:\\Program Files\\nodejs\\node.exe', app: 'C:\\Users\\a%b\\Tars.exe' });
    expect(script.startsWith('@echo off\r\n')).toBe(true);
    expect(script.split('\r\n').length).toBeGreaterThan(5);
    expect(script).not.toMatch(/[^\r]\n/);
    expect(script).toContain('"C:\\Program Files\\nodejs\\node.exe" %*');
    expect(script).toContain('"C:\\Users\\a%%b\\Tars.exe" %*');
    const accented = launcherScript({ platform: 'win32', node: 'C:\\Users\\Jérôme\\node.exe', app: null });
    expect(accented).not.toContain('Jérôme');
    expect(/^[\x20-\x7e\r\n]*$/.test(accented)).toBe(true);
  });

  it('7. win32: a command line starting with a bare path, or none', () => {
    expect(launcherFirstWord('C:\\Users\\dev\\.dorothy\\bin\\tars-hook.cmd', 'win32')).toBe('C:/Users/dev/.dorothy/bin/tars-hook.cmd');
    expect(launcherFirstWord('C:\\Users\\JOHNSM~1\\.dorothy\\bin\\tars-hook.cmd', 'win32')).toBe('C:/Users/JOHNSM~1/.dorothy/bin/tars-hook.cmd');
    for (const needsQuotes of ['C:\\Users\\John Smith\\.dorothy\\bin\\tars-hook.cmd', 'C:\\Users\\a$b\\x.cmd', 'C:\\Users\\Jérôme\\x.cmd', 'C:\\Users\\a(b)\\x.cmd', 'relative\\x.cmd']) {
      expect(launcherFirstWord(needsQuotes, 'win32'), needsQuotes).toBeNull();
    }
    expect(launcherFirstWord('/Users/dev/.dorothy/bin/tars-hook', 'darwin')).toBe('"/Users/dev/.dorothy/bin/tars-hook"');
    expect(launcherFirstWord("/Users/a'b/.dorothy/bin/tars-hook", 'linux')).toBe(`"/Users/a'b/.dorothy/bin/tars-hook"`);
    expect(launcherFirstWord('/Users/a$b/.dorothy/bin/tars-hook', 'darwin')).toBe("'/Users/a$b/.dorothy/bin/tars-hook'");
  });
});

describe.runIf(posix)('the launcher, run as a CLI runs a hook', () => {
  let home: string;
  let bin: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(tmp, 'home-'));
    bin = path.join(home, '.dorothy', 'bin');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const run = (launcher: string, args: string[], env: NodeJS.ProcessEnv, input = '{"session_id":"s"}') =>
    spawnSync('/bin/sh', ['-c', `${launcherFirstWord(launcher, process.platform)} ${args.map((a) => `"${a}"`).join(' ')}`], { env: { HOME: home, ...env }, input, encoding: 'utf8' });

  it('4. written beside itself and renamed, 0700, and not again when unchanged', () => {
    const plan = { platform: process.platform, node: null, app: null, dataDir: path.join(home, '.dorothy') };
    const file = writeHookLauncher(plan)!;
    expect(file).toBe(path.join(bin, 'tars-hook'));
    expect(fs.statSync(file).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(bin)).toEqual(['tars-hook']);
    const mtime = fs.statSync(file).mtimeMs;
    const ino = fs.statSync(file).ino;
    expect(writeHookLauncher(plan)).toBe(file);
    expect([fs.statSync(file).mtimeMs, fs.statSync(file).ino]).toEqual([mtime, ino]);
    // Changed: a new file renamed over it, never the old one rewritten under a hook that reads it.
    expect(writeHookLauncher({ ...plan, node: '/opt/node/bin/node' })).toBe(file);
    expect(fs.statSync(file).ino).not.toBe(ino);
    expect(fs.readFileSync(file, 'utf8')).toContain("NODE='/opt/node/bin/node'");
  });

  it('4. not written through a symlinked folder or file', () => {
    const elsewhere = fs.mkdtempSync(path.join(tmp, 'elsewhere-'));
    fs.mkdirSync(path.join(home, '.dorothy'), { recursive: true });
    fs.symlinkSync(elsewhere, bin);
    expect(writeHookLauncher({ platform: process.platform, node: null, app: null, dataDir: path.join(home, '.dorothy') })).toBeNull();
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    fs.unlinkSync(bin);
    fs.mkdirSync(bin);
    fs.symlinkSync(path.join(elsewhere, 'target'), path.join(bin, 'tars-hook'));
    expect(writeHookLauncher({ platform: process.platform, node: null, app: null, dataDir: path.join(home, '.dorothy') })).toBeNull();
    expect(fs.existsSync(path.join(elsewhere, 'target'))).toBe(false);
  });

  it('2, 8. the named Node, else the app with ELECTRON_RUN_AS_NODE=1, else node on the PATH; argv, stdin and exit code passed on', () => {
    const node = fakeNode(path.join(tmp, 'r-node'), '22.0.0', 'node', 'named');
    const app = fakeNode(path.join(tmp, 'r-app'), '22.0.0', 'Tars');
    const onPath = path.dirname(fakeNode(path.join(tmp, 'r-path'), '22.0.0', 'node', 'on-path'));
    const dataDir = path.join(home, '.dorothy');
    const inTars = { CLAUDE_MGR_API_TOKEN: 't', PATH: `${onPath}:/usr/bin:/bin` };
    const script = '/a dir/tars-hook.mjs';

    const file = writeHookLauncher({ platform: process.platform, node, app, dataDir })!;
    const first = run(file, [script, 'on-stop'], inTars, 'the-json');
    expect([first.status, first.stdout]).toEqual([7, `named||${script}|on-stop|the-json`]);

    fs.rmSync(node);
    const second = run(file, [script, 'on-stop'], inTars, 'the-json');
    expect([second.status, second.stdout]).toEqual([7, `Tars|1|${script}|on-stop|the-json`]);

    fs.rmSync(app);
    const third = run(file, [script, 'on-stop'], inTars, 'the-json');
    expect([third.status, third.stdout]).toEqual([7, `on-path||${script}|on-stop|the-json`]);
  });

  it('5. outside Tars: a skipped event answers before any Node starts; kept ones and the status line still run', () => {
    const node = fakeNode(path.join(tmp, 's-node'), '22.0.0');
    const file = writeHookLauncher({ platform: process.platform, node, app: null, dataDir: path.join(home, '.dorothy') })!;
    // No node here (a skipped event's exact answer, which no stand-in Node would give, shows none started).
    const outside = { PATH: '/usr/bin:/bin' };
    for (const [event, answer] of Object.entries(SKIPPED_OUTSIDE_TARS)) {
      const r = run(file, ['/h/tars-hook.mjs', event], outside);
      expect([r.status, r.stdout, r.stderr], event).toEqual([0, answer, '']);
    }
    for (const event of ['session-start', 'post-tool-use', 'gemini/post-tool-use']) {
      expect(run(file, ['/h/tars-hook.mjs', event], outside).stdout, event).toBe(`node||/h/tars-hook.mjs|${event}|{"session_id":"s"}`);
    }
    expect(run(file, ['/h/statusline.mjs'], outside).stdout).toBe('node||/h/statusline.mjs|{"session_id":"s"}');
    expect(run(file, ['/h/tars-hook.mjs', 'on-stop'], { ...outside, CLAUDE_MGR_API_TOKEN: 't' }).status).toBe(7);
  });
});

describe.runIf(posix)('6. the skip list against the runner itself, outside Tars', () => {
  let server: Server;
  let api: string;
  const seen: string[] = [];
  beforeEach(async () => {
    seen.length = 0;
    server = createServer((req, res) => {
      seen.push(`${req.method} ${new URL(req.url ?? '/', 'http://x').pathname}`);
      res.statusCode = req.headers.authorization === 'Bearer shared' && !req.url?.startsWith('/api/hooks/') ? 200 : 401;
      res.end(res.statusCode === 200 ? '{"context":"remembered","success":true}' : '{"error":"unauthorized"}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const address = server.address();
    api = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  const runner = (event: string, input: object, home: string) => new Promise<{ out: string; code: number | null }>((resolve) => {
    const child = spawn(process.execPath, [path.join(HOOKS, 'tars-hook.mjs'), event], { env: { HOME: home, PATH: process.env.PATH, CLAUDE_MGR_API_URL: api } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ out, code }));
    child.stdin.end(JSON.stringify(input));
  });

  it('a skipped event sends nothing that is not refused, and the runner answers what the launcher answers', async () => {
    const home = fs.mkdtempSync(path.join(tmp, 'runner-home-'));
    fs.mkdirSync(path.join(home, '.dorothy'));
    fs.writeFileSync(path.join(home, '.dorothy', 'api-token'), 'shared');
    const input = { session_id: 's1', cwd: '/w', hook_event_name: 'X', tool_name: 'Bash', tool_input: { command: 'ls' }, last_assistant_message: 'done', transcript_path: '/nonexistent.jsonl' };
    for (const [event, answer] of Object.entries(SKIPPED_OUTSIDE_TARS)) {
      seen.length = 0;
      const { out } = await runner(event, input, home);
      expect(out, event).toBe(answer);
      expect(seen.filter((s) => !s.includes(' /api/hooks/')), event).toEqual([]);
    }
    for (const event of ['session-start', 'post-tool-use', 'gemini/post-tool-use']) {
      seen.length = 0;
      await runner(event, input, home);
      expect(seen.filter((s) => !s.includes(' /api/hooks/')).length, event).toBeGreaterThan(0);
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
});
