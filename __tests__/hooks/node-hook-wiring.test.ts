import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { moveTestHome } from '../setup/test-home';

/**
 * Where the hooks are wired: `configureHooks` of the Claude and Gemini
 * providers, and the statusline, which write the CLIs' settings files.
 *
 * On win32 they write `node "<abs>/tars-hook.mjs" <event>`. On
 * darwin and linux they write exactly what they wrote before: the same tests
 * pass against the code before this change, which is the proof.
 *
 * How the wiring can fail, written before the code:
 *  1. win32 keeps writing the bare `.sh` path: bash eats its backslashes, and
 *     no hook ever runs.
 *  2. darwin or linux entries change in any byte (command, timeout, matcher,
 *     order, Gemini's file layout).
 *  3. A second run adds a second entry per event, or the old `.sh` entries a
 *     previous Tars wrote on Windows stay beside the new ones, so each event
 *     runs twice (or runs a dead `.sh` once more).
 *  4. Gemini's probe looks for `gemini/<file>` in a backslash path and appends
 *     a copy of every hook at each start; those copies are kept.
 *  5. Gemini is wired on `UserPromptSubmit`, which it does not fire;
 *     `BeforeAgent` is its event. On every platform since 2026-10-12 (it was
 *     win32's alone): on darwin and linux the turn's start never reached
 *     Tars, and a Gemini agent read idle while it worked. The entry an older
 *     Tars wrote there goes; the user's own entries in that event stay.
 *  6. The agent token cannot reach a Gemini hook once the user turns on
 *     environment redaction (`CLAUDE_MGR_API_TOKEN` matches /TOKEN/): it is
 *     not in `security.environmentVariableRedaction.allowed`; or adding it
 *     drops the user's own entries or flips `enabled`. On every platform since
 *     2026-10-12 (it was win32's alone): Gemini redacts the same way on macOS.
 *  7. The user's own hooks, in the same event, are removed or rewritten.
 *  8. The command is quoted so that Git Bash, or PowerShell (Claude without
 *     Git Bash, and Gemini always on Windows), splits the path at a space
 *     (the dev checkout is under "Claude Project"), expands a `$`, or chokes
 *     on a `'`.
 *  9. The statusline command is unquoted, or turning it off does not
 *     recognise the Node form as Tars's and leaves it behind.
 * 10. A user's own script taken for Tars's because it has the same name
 *     (`~/.claude/hooks/on-stop.sh`, `C:/me/hooks/notification.sh`): it
 *     would be repointed at the runner and its copies deleted. A .sh is
 *     Tars's only in this app's own hooks folder, or in a hooks folder that
 *     also holds Tars's `tars-hook.sh`/`tars-hook.mjs`, and never under the
 *     CLI's own config folder.
 * 11. PowerShell also ends a string at a typographic quote: U+201C to U+201E
 *     end a double-quoted one, U+2018 to U+201B a single-quoted one. A path
 *     holding them is quoted with the other kind, or refused.
 * 12. Another app's hooks taken for Tars's because they sit in an Electron
 *     install too: the installed Dorothy keeps `.sh` and `.cmd` hooks under
 *     `...\Programs\Dorothy\resources\app.asar.unpacked\hooks\`, with no
 *     tars-hook.sh or tars-hook.mjs. Tars never touches another app's hooks,
 *     so `app.asar.unpacked` alone proves nothing.
 * 13. Turning the status line off takes a user's own Node status line for
 *     Tars's because its file is also called statusline.mjs (under
 *     `~/.claude/hooks/`, say), and deletes it at every launch while Tars's is
 *     off. It is Tars's only in this app's hooks folder, or in one that holds
 *     Tars's runner beside it, and never under a .claude or .gemini folder.
 * 14. On darwin and linux, removing an older Tars's Gemini UserPromptSubmit
 *     entry (5) by the name in its command takes a user's own
 *     `.../gemini/user-prompt-submit.sh`, or an installed Dorothy's, for
 *     Tars's and deletes it. The same rule as 10 and 12 decides.
 */

const HOOKS_DIR = path.join(__dirname, '../../hooks');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-hook-wiring-'));
const fwd = (p: string) => p.replace(/\\/g, '/');
const runnerCmd = (event: string) => `node "${fwd(path.join(HOOKS_DIR, 'tars-hook.mjs'))}" ${event}`;

/** A dev checkout of an older Tars: its hooks folder holds tars-hook.sh beside the scripts. */
function oldCheckout(): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'old-checkout-'));
  const hooks = path.join(dir, 'hooks');
  fs.mkdirSync(path.join(hooks, 'gemini'), { recursive: true });
  fs.writeFileSync(path.join(hooks, 'tars-hook.sh'), '# Tars\n');
  return hooks;
}
/** An installed Tars, older than this one: its hooks folder holds Tars's tars-hook.sh like every Tars since 1.8. */
function packagedTars(): string {
  const hooks = path.join(fs.mkdtempSync(path.join(tmp, 'Programs-tars-')), 'resources', 'app.asar.unpacked', 'hooks');
  fs.mkdirSync(path.join(hooks, 'gemini'), { recursive: true });
  fs.writeFileSync(path.join(hooks, 'tars-hook.sh'), '# Tars\n');
  return hooks;
}
/** The installed Dorothy, as it is laid out on this machine: its own .sh and .cmd hooks, no tars-hook. */
function dorothyInstall(): string {
  const hooks = path.join(fs.mkdtempSync(path.join(tmp, 'Programs-Dorothy-')), 'resources', 'app.asar.unpacked', 'hooks');
  fs.mkdirSync(path.join(hooks, 'gemini'), { recursive: true });
  for (const name of ['on-stop', 'session-start', 'notification']) {
    for (const ext of ['.sh', '.cmd', '.ps1']) fs.writeFileSync(path.join(hooks, `${name}${ext}`), '');
    for (const ext of ['.sh', '.cmd']) fs.writeFileSync(path.join(hooks, 'gemini', `${name}${ext}`), '');
  }
  fs.writeFileSync(path.join(hooks, '_hooks-common.ps1'), '');
  return hooks;
}
const DOROTHY_AS_INSTALLED = 'C:\\Users\\owner\\AppData\\Local\\Programs\\Dorothy\\resources\\app.asar.unpacked\\hooks';

const CLAUDE_EVENTS: Array<[string, string, string | undefined]> = [
  ['PostToolUse', 'post-tool-use', '*'],
  ['Stop', 'on-stop', undefined],
  ['StopFailure', 'stop-failure', undefined],
  ['SessionStart', 'session-start', '*'],
  ['SessionEnd', 'session-end', '*'],
  ['Notification', 'notification', '*'],
  ['PermissionRequest', 'permission-request', undefined],
  ['TaskCompleted', 'task-completed', undefined],
  ['UserPromptSubmit', 'user-prompt-submit', undefined],
];

let home = '';
let restoreHome: () => void = () => {};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(tmp, 'home-'));
  restoreHome = moveTestHome(home);
  expect(os.homedir()).toBe(home);
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

afterEach(() => {
  restoreHome();
  vi.resetModules();
});

async function claude() {
  const { ClaudeProvider } = await import('../../electron/providers/claude-provider');
  const p = new ClaudeProvider();
  expect(p.configDir.startsWith(home), `would write into ${p.configDir}`).toBe(true);
  return p;
}
async function gemini() {
  const { GeminiProvider } = await import('../../electron/providers/gemini-provider');
  const p = new GeminiProvider();
  expect(p.configDir.startsWith(home), `would write into ${p.configDir}`).toBe(true);
  return p;
}
const claudeSettingsFile = () => path.join(home, '.claude', 'settings.json');
const geminiSettingsFile = () => path.join(home, '.gemini', 'settings.json');
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf-8'));

describe('on darwin and linux the .sh wiring stays, Gemini on the event it fires', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    it(`Claude writes the bare .sh path, timeout 30, the same matchers (${platform})`, async () => {
      const p = await claude();
      await (p.configureHooks as (d: string, pl?: NodeJS.Platform) => Promise<void>)(HOOKS_DIR, platform);
      const expected: Record<string, unknown> = {};
      for (const [type, name, matcher] of CLAUDE_EVENTS) {
        expected[type] = [{ hooks: [{ type: 'command', command: path.join(HOOKS_DIR, `${name}.sh`), timeout: 30 }], ...(matcher ? { matcher } : {}) }];
      }
      expect(read(claudeSettingsFile())).toEqual({ hooks: expected });
      // Key order inside each entry, as JSON.stringify writes it.
      expect(JSON.stringify(read(claudeSettingsFile()).hooks.PostToolUse[0])).toBe(
        JSON.stringify({ hooks: [{ type: 'command', command: path.join(HOOKS_DIR, 'post-tool-use.sh'), timeout: 30 }], matcher: '*' }),
      );
    });

    it(`Gemini writes the .sh paths, BeforeAgent, timeout 10000, the same file text (${platform})`, async () => {
      const p = await gemini();
      await (p.configureHooks as (d: string, pl?: NodeJS.Platform) => Promise<void>)(HOOKS_DIR, platform);
      const g = (f: string) => path.join(HOOKS_DIR, 'gemini', f);
      const expected = {
        hooks: {
          AfterTool: [{ hooks: [{ type: 'command', command: g('post-tool-use.sh'), timeout: 10000 }], matcher: '*' }],
          AfterAgent: [{ hooks: [{ type: 'command', command: g('on-stop.sh'), timeout: 10000 }] }],
          SessionStart: [{ hooks: [{ type: 'command', command: g('session-start.sh'), timeout: 10000 }], matcher: '*' }],
          SessionEnd: [{ hooks: [{ type: 'command', command: g('session-end.sh'), timeout: 10000 }], matcher: '*' }],
          Notification: [{ hooks: [{ type: 'command', command: g('notification.sh'), timeout: 10000 }], matcher: '*' }],
          BeforeAgent: [{ hooks: [{ type: 'command', command: g('user-prompt-submit.sh'), timeout: 10000 }] }],
        },
        security: { environmentVariableRedaction: { allowed: ['CLAUDE_MGR_API_TOKEN'] } },
      };
      expect(fs.readFileSync(geminiSettingsFile(), 'utf-8')).toBe(JSON.stringify(expected, null, 2));
    });

    it(`6. Gemini lets the agent token through its redaction, the user's own settings kept (${platform})`, async () => {
      fs.mkdirSync(path.dirname(geminiSettingsFile()), { recursive: true });
      fs.writeFileSync(geminiSettingsFile(), JSON.stringify({
        security: { environmentVariableRedaction: { enabled: true, allowed: ['MY_KEY'] }, folderTrust: { enabled: true } },
      }, null, 2));
      const p = await gemini();
      await (p.configureHooks as (d: string, pl?: NodeJS.Platform) => Promise<void>)(HOOKS_DIR, platform);
      await (p.configureHooks as (d: string, pl?: NodeJS.Platform) => Promise<void>)(HOOKS_DIR, platform);
      expect(read(geminiSettingsFile()).security).toEqual({
        environmentVariableRedaction: { enabled: true, allowed: ['MY_KEY', 'CLAUDE_MGR_API_TOKEN'] }, folderTrust: { enabled: true },
      });
    });

    it(`5. Gemini moves an older Tars's UserPromptSubmit entry to BeforeAgent, and keeps the user's own (${platform})`, async () => {
      const g = (f: string) => path.join(HOOKS_DIR, 'gemini', f);
      const mine = { hooks: [{ type: 'command', command: '/Users/me/bin/log-prompt.sh', timeout: 5000 }] };
      fs.mkdirSync(path.dirname(geminiSettingsFile()), { recursive: true });
      fs.writeFileSync(geminiSettingsFile(), JSON.stringify({ hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: g('user-prompt-submit.sh'), timeout: 10000 }] }, mine],
      } }, null, 2));
      const p = await gemini();
      await (p.configureHooks as (d: string, pl?: NodeJS.Platform) => Promise<void>)(HOOKS_DIR, platform);
      await (p.configureHooks as (d: string, pl?: NodeJS.Platform) => Promise<void>)(HOOKS_DIR, platform);
      const hooks = read(geminiSettingsFile()).hooks;
      expect(hooks.UserPromptSubmit).toEqual([mine]);
      expect(hooks.BeforeAgent).toEqual([{ hooks: [{ type: 'command', command: g('user-prompt-submit.sh'), timeout: 10000 }] }]);
    });

    it(`14. Gemini leaves a user's own and Dorothy's user-prompt-submit.sh on UserPromptSubmit, and removes an older Tars's (${platform})`, async () => {
      const entry = (command: string) => ({ hooks: [{ type: 'command', command, timeout: 10000 }] });
      const userOwn = entry(path.join(home, '.gemini', 'hooks', 'gemini', 'user-prompt-submit.sh'));
      const elsewhere = path.join(fs.mkdtempSync(path.join(tmp, 'me-')), 'hooks', 'gemini');
      fs.mkdirSync(elsewhere, { recursive: true });
      const userElsewhere = entry(path.join(elsewhere, 'user-prompt-submit.sh'));
      const dorothy = entry(path.join(dorothyInstall(), 'gemini', 'user-prompt-submit.sh'));
      const olderTars = entry(path.join(oldCheckout(), 'gemini', 'user-prompt-submit.sh'));
      fs.mkdirSync(path.dirname(geminiSettingsFile()), { recursive: true });
      fs.writeFileSync(geminiSettingsFile(), JSON.stringify({ hooks: {
        UserPromptSubmit: [userOwn, userElsewhere, dorothy, olderTars],
      } }, null, 2));
      const p = await gemini();
      await (p.configureHooks as (d: string, pl?: NodeJS.Platform) => Promise<void>)(HOOKS_DIR, platform);
      expect(read(geminiSettingsFile()).hooks.UserPromptSubmit).toEqual([userOwn, userElsewhere, dorothy]);
    });
  }
});

describe('on win32, Claude runs the Node runner', () => {
  const configure = async () => {
    const p = await claude();
    await (p.configureHooks as (d: string, pl?: NodeJS.Platform) => Promise<void>)(HOOKS_DIR, 'win32');
  };

  it('writes one `node "<abs>" <event>` entry per event, timeout 30, the same matchers', async () => {
    await configure();
    const hooks = read(claudeSettingsFile()).hooks;
    for (const [type, name, matcher] of CLAUDE_EVENTS) {
      expect(hooks[type], type).toEqual([{ hooks: [{ type: 'command', command: runnerCmd(name), timeout: 30 }], ...(matcher ? { matcher } : {}) }]);
    }
    expect(Object.keys(hooks).sort()).toEqual(CLAUDE_EVENTS.map(e => e[0]).sort());
  });

  it('twice yields the same file, and the second run writes nothing', async () => {
    await configure();
    const first = fs.readFileSync(claudeSettingsFile(), 'utf-8');
    const before = fs.statSync(claudeSettingsFile()).mtimeMs;
    await new Promise(r => setTimeout(r, 30));
    await configure();
    expect(fs.readFileSync(claudeSettingsFile(), 'utf-8')).toBe(first);
    expect(fs.statSync(claudeSettingsFile()).mtimeMs).toBe(before);
  });

  it('replaces the .sh entries a previous Tars wrote, removes their copies, keeps the user\'s hooks and settings', async () => {
    const old = oldCheckout();
    const PACKAGED = packagedTars();
    const userHook = { type: 'command', command: 'C:\\me\\my-stop.ps1', timeout: 5 };
    fs.mkdirSync(path.dirname(claudeSettingsFile()), { recursive: true });
    fs.writeFileSync(claudeSettingsFile(), JSON.stringify({
      model: 'opus',
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: path.join(old, 'on-stop.sh'), timeout: 30 }] },
          { hooks: [userHook] },
          { hooks: [{ type: 'command', command: path.join(PACKAGED, 'on-stop.sh'), timeout: 30 }] },
        ],
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: path.join(PACKAGED, 'session-start.sh'), timeout: 45 }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
      },
    }, null, 2));

    await configure();
    await configure();

    const s = read(claudeSettingsFile());
    expect(s.model).toBe('opus');
    expect(s.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }]);
    expect(s.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: runnerCmd('on-stop'), timeout: 30 }] },
      { hooks: [userHook] },
    ]);
    // The user's matcher and timeout on Tars's own entry are theirs to keep.
    expect(s.hooks.SessionStart).toEqual([{ matcher: 'startup', hooks: [{ type: 'command', command: runnerCmd('session-start'), timeout: 45 }] }]);
    expect(JSON.stringify(s)).not.toContain('.sh');
  });

  it('never takes a user\'s own script of the same name for Tars\'s', async () => {
    // The worst case: a hooks folder in the CLI's own config folder, even holding a tars-hook.sh.
    const inConfig = path.join(home, '.claude', 'hooks');
    fs.mkdirSync(inConfig, { recursive: true });
    fs.writeFileSync(path.join(inConfig, 'tars-hook.sh'), '# copied by the user\n');
    const elsewhere = path.join(tmp, 'me', 'hooks');
    fs.mkdirSync(elsewhere, { recursive: true });
    const mine = [
      path.join(inConfig, 'on-stop.sh'),
      'C:\\Users\\me\\.claude\\hooks\\on-stop.sh',
      'C:\\me\\my-on-stop.sh',
      path.join(elsewhere, 'on-stop.sh'),
      'bash ~/.claude/hooks/on-stop.sh',
    ];
    const userEntries = mine.map(command => ({ hooks: [{ type: 'command', command, timeout: 7 }] }));
    fs.mkdirSync(path.dirname(claudeSettingsFile()), { recursive: true });
    fs.writeFileSync(claudeSettingsFile(), JSON.stringify({ hooks: { Stop: userEntries } }, null, 2));

    await configure();
    await configure();

    expect(read(claudeSettingsFile()).hooks.Stop).toEqual([
      ...userEntries,
      { hooks: [{ type: 'command', command: runnerCmd('on-stop'), timeout: 30 }] },
    ]);
  });

  it('leaves the installed Dorothy\'s hooks alone, .sh and .cmd, and adds its own beside them', async () => {
    const dorothy = dorothyInstall();
    const theirs = {
      Stop: [
        { hooks: [{ type: 'command', command: path.join(dorothy, 'on-stop.sh'), timeout: 30 }] },
        { hooks: [{ type: 'command', command: `${DOROTHY_AS_INSTALLED.replace(/\\/g, '/')}/on-stop.cmd`, timeout: 30 }] },
        { hooks: [{ type: 'command', command: `${DOROTHY_AS_INSTALLED}\\on-stop.sh`, timeout: 30 }] },
      ],
      SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: path.join(dorothy, 'session-start.cmd'), timeout: 30 }] }],
    };
    fs.mkdirSync(path.dirname(claudeSettingsFile()), { recursive: true });
    fs.writeFileSync(claudeSettingsFile(), JSON.stringify({ hooks: theirs }, null, 2));

    await configure();
    await configure();

    const s = read(claudeSettingsFile());
    expect(s.hooks.Stop).toEqual([...theirs.Stop, { hooks: [{ type: 'command', command: runnerCmd('on-stop'), timeout: 30 }] }]);
    expect(s.hooks.SessionStart).toEqual([...theirs.SessionStart, { matcher: '*', hooks: [{ type: 'command', command: runnerCmd('session-start'), timeout: 30 }] }]);
  });

  it('recognises its own old .sh entries when it runs from a dev worktree under .claude/worktrees', async () => {
    // The Windows port's own setup: <repo>/.claude/worktrees/<lot>/hooks. The
    // app's own hooks folder is never the CLI's config folder, whatever its path.
    const own = path.join(tmp, 'repo', '.claude', 'worktrees', 'win-x', 'hooks');
    fs.mkdirSync(path.join(own, 'gemini'), { recursive: true });
    fs.copyFileSync(path.join(HOOKS_DIR, 'tars-hook.mjs'), path.join(own, 'tars-hook.mjs'));
    for (const f of ['on-stop.sh', 'session-start.sh']) fs.writeFileSync(path.join(own, f), '');
    fs.mkdirSync(path.dirname(claudeSettingsFile()), { recursive: true });
    fs.writeFileSync(claudeSettingsFile(), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: path.join(own, 'on-stop.sh'), timeout: 30 }] }] },
    }, null, 2));

    const p = await claude();
    await (p.configureHooks as (d: string, pl?: NodeJS.Platform) => Promise<void>)(own, 'win32');

    expect(read(claudeSettingsFile()).hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: `node "${fwd(path.join(own, 'tars-hook.mjs'))}" on-stop`, timeout: 30 }] },
    ]);
  });

  it('points an entry of a moved checkout at this one', async () => {
    fs.mkdirSync(path.dirname(claudeSettingsFile()), { recursive: true });
    fs.writeFileSync(claudeSettingsFile(), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "D:/elsewhere/hooks/tars-hook.mjs" on-stop', timeout: 30 }] }] },
    }));
    await configure();
    expect(read(claudeSettingsFile()).hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: runnerCmd('on-stop'), timeout: 30 }] }]);
  });
});

describe('on win32, Gemini runs the Node runner on its own events, with the token allowed through', () => {
  const configure = async () => {
    const p = await gemini();
    await (p.configureHooks as (d: string, pl?: NodeJS.Platform) => Promise<void>)(HOOKS_DIR, 'win32');
  };
  const G_EVENTS: Array<[string, string, string | undefined]> = [
    ['AfterTool', 'gemini/post-tool-use', '*'],
    ['AfterAgent', 'gemini/on-stop', undefined],
    ['SessionStart', 'gemini/session-start', '*'],
    ['SessionEnd', 'gemini/session-end', '*'],
    ['Notification', 'gemini/notification', '*'],
    ['BeforeAgent', 'gemini/user-prompt-submit', undefined],
  ];

  it('writes BeforeAgent, never UserPromptSubmit, one entry each, timeout 10000', async () => {
    await configure();
    const s = read(geminiSettingsFile());
    for (const [type, event, matcher] of G_EVENTS) {
      expect(s.hooks[type], type).toEqual([{ hooks: [{ type: 'command', command: runnerCmd(event), timeout: 10000 }], ...(matcher ? { matcher } : {}) }]);
    }
    expect(s.hooks.UserPromptSubmit).toBeUndefined();
    expect(s.security.environmentVariableRedaction.allowed).toEqual(['CLAUDE_MGR_API_TOKEN']);
    expect(s.security.environmentVariableRedaction.enabled).toBeUndefined();
  });

  it('cleans the copies the old probe appended at every start, and the UserPromptSubmit entry', async () => {
    const old = oldCheckout();
    const PACKAGED = packagedTars();
    const sh = (f: string) => (f === 'on-stop.sh' ? path.join(PACKAGED, 'gemini', f) : path.join(old, 'gemini', f));
    const entry = (f: string, matcher?: string) => ({ hooks: [{ type: 'command', command: sh(f), timeout: 10000 }], ...(matcher ? { matcher } : {}) });
    fs.mkdirSync(path.dirname(geminiSettingsFile()), { recursive: true });
    fs.writeFileSync(geminiSettingsFile(), JSON.stringify({
      theme: 'dark',
      security: { environmentVariableRedaction: { enabled: true, allowed: ['MY_KEY'] }, folderTrust: { enabled: true } },
      hooks: {
        AfterTool: [entry('post-tool-use.sh', '*'), entry('post-tool-use.sh', '*'), entry('post-tool-use.sh', '*')],
        AfterAgent: [entry('on-stop.sh'), entry('on-stop.sh')],
        UserPromptSubmit: [entry('user-prompt-submit.sh'), entry('user-prompt-submit.sh')],
        BeforeTool: [{ matcher: 'x', hooks: [{ type: 'command', command: 'mine.ps1' }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: path.join(home, '.gemini', 'hooks', 'gemini', 'session-end.sh') }] }],
      },
    }, null, 2));

    await configure();
    await configure();

    const s = read(geminiSettingsFile());
    expect(s.theme).toBe('dark');
    expect(s.security).toEqual({ environmentVariableRedaction: { enabled: true, allowed: ['MY_KEY', 'CLAUDE_MGR_API_TOKEN'] }, folderTrust: { enabled: true } });
    expect(s.hooks.BeforeTool).toEqual([{ matcher: 'x', hooks: [{ type: 'command', command: 'mine.ps1' }] }]);
    expect(s.hooks.UserPromptSubmit).toBeUndefined();
    // A user's own script under ~/.gemini stays, and the runner is added beside it.
    expect(s.hooks.SessionEnd).toEqual([
      { hooks: [{ type: 'command', command: path.join(home, '.gemini', 'hooks', 'gemini', 'session-end.sh') }] },
      { hooks: [{ type: 'command', command: runnerCmd('gemini/session-end'), timeout: 10000 }], matcher: '*' },
    ]);
    for (const [type, event, matcher] of G_EVENTS.filter(e => e[0] !== 'SessionEnd')) {
      expect(s.hooks[type], type).toEqual([{ hooks: [{ type: 'command', command: runnerCmd(event), timeout: 10000 }], ...(matcher ? { matcher } : {}) }]);
    }
  });

  it('leaves the installed Dorothy\'s Gemini hooks alone and adds its own beside them', async () => {
    const dorothy = dorothyInstall();
    const theirs = {
      AfterAgent: [
        { hooks: [{ type: 'command', command: path.join(dorothy, 'gemini', 'on-stop.sh'), timeout: 10000 }] },
        { hooks: [{ type: 'command', command: `${DOROTHY_AS_INSTALLED}\\gemini\\on-stop.sh`, timeout: 10000 }] },
        { hooks: [{ type: 'command', command: `${DOROTHY_AS_INSTALLED}\\gemini\\on-stop.sh`, timeout: 10000 }] },
      ],
      Notification: [{ matcher: '*', hooks: [{ type: 'command', command: path.join(dorothy, 'gemini', 'notification.cmd'), timeout: 10000 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${DOROTHY_AS_INSTALLED}\\gemini\\user-prompt-submit.sh`, timeout: 10000 }] }],
    };
    fs.mkdirSync(path.dirname(geminiSettingsFile()), { recursive: true });
    fs.writeFileSync(geminiSettingsFile(), JSON.stringify({ hooks: theirs }, null, 2));

    await configure();
    await configure();

    const s = read(geminiSettingsFile());
    expect(s.hooks.AfterAgent).toEqual([...theirs.AfterAgent, { hooks: [{ type: 'command', command: runnerCmd('gemini/on-stop'), timeout: 10000 }] }]);
    expect(s.hooks.Notification).toEqual([...theirs.Notification, { matcher: '*', hooks: [{ type: 'command', command: runnerCmd('gemini/notification'), timeout: 10000 }] }]);
    expect(s.hooks.UserPromptSubmit).toEqual(theirs.UserPromptSubmit);
  });

  it('twice writes nothing the second time', async () => {
    await configure();
    const first = fs.readFileSync(geminiSettingsFile(), 'utf-8');
    const before = fs.statSync(geminiSettingsFile()).mtimeMs;
    await new Promise(r => setTimeout(r, 30));
    await configure();
    expect(fs.readFileSync(geminiSettingsFile(), 'utf-8')).toBe(first);
    expect(fs.statSync(geminiSettingsFile()).mtimeMs).toBe(before);
  });

  it('leaves a settings file that is not JSON untouched', async () => {
    fs.mkdirSync(path.dirname(geminiSettingsFile()), { recursive: true });
    fs.writeFileSync(geminiSettingsFile(), '{ not json');
    await configure();
    expect(fs.readFileSync(geminiSettingsFile(), 'utf-8')).toBe('{ not json');
  });
});

describe('the command survives the shells that run it', () => {
  const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
  const onWindows = process.platform === 'win32';

  /** A stand-in runner that reports how it was called. */
  function probeIn(dirName: string): string {
    const dir = path.join(tmp, dirName, 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, 'tars-hook.mjs');
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify({ script: process.argv[1], args: process.argv.slice(2) }));\n');
    return script;
  }

  const DIRS = ['Claude Project', 'with $HOME and `tick`', "O'Brien space", 'the \u201cbest\u201d \u201eone', 'it\u2019s \u2018mine\u2019 \u201b \u201a'];

  it.each(DIRS)('builds a command both shells read back to the same argv (%s)', async dirName => {
    const { nodeHookCommand } = await import('../../electron/utils/hook-command');
    const script = probeIn(dirName);
    const command = nodeHookCommand(script, 'gemini/on-stop');
    const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` };

    const shells: Array<[string, string, string[]]> = onWindows
      ? [
        // Claude Code's shell-form hooks: Git Bash when installed.
        ...(fs.existsSync(GIT_BASH) ? [['git-bash', GIT_BASH, ['-c', command]] as [string, string, string[]]] : []),
        // Claude Code without Git Bash, and Gemini CLI always (hookRunner, getShellConfiguration).
        ['powershell', 'powershell.exe', ['-NoProfile', '-Command', `${command}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`]],
      ]
      : [['sh', '/bin/sh', ['-c', command]]];
    expect(shells.length).toBeGreaterThan(0);

    for (const [name, exe, args] of shells) {
      const r = spawnSync(exe, args, { env, encoding: 'utf8', windowsHide: true });
      expect(r.status, `${name}: ${r.stderr}`).toBe(0);
      const got = JSON.parse(r.stdout);
      expect(path.resolve(got.script), name).toBe(path.resolve(script));
      expect(got.args, name).toEqual(['gemini/on-stop']);
    }
  }, 60_000);

  it('uses forward slashes and double quotes for an ordinary path', async () => {
    const { nodeHookCommand } = await import('../../electron/utils/hook-command');
    expect(nodeHookCommand('C:\\Users\\n\\Claude Project\\tars\\hooks\\tars-hook.mjs', 'on-stop'))
      .toBe('node "C:/Users/n/Claude Project/tars/hooks/tars-hook.mjs" on-stop');
    expect(nodeHookCommand('\\\\server\\share\\hooks\\statusline.mjs')).toBe('node "//server/share/hooks/statusline.mjs"');
  });

  it.each([
    ['C:\\a b\\tars-hook.mjs', 'node "C:/a b/tars-hook.mjs" on-stop'],
    ['C:\\a$b\\tars-hook.mjs', "node 'C:/a$b/tars-hook.mjs' on-stop"],
    ['C:\\a`b\\tars-hook.mjs', "node 'C:/a`b/tars-hook.mjs' on-stop"],
    ["C:\\O'B\\tars-hook.mjs", 'node "C:/O\'B/tars-hook.mjs" on-stop'],
    ['C:\\\u201cx\u201d\\tars-hook.mjs', "node 'C:/\u201cx\u201d/tars-hook.mjs' on-stop"],
    ['C:\\\u201ex\\tars-hook.mjs', "node 'C:/\u201ex/tars-hook.mjs' on-stop"],
    ['C:\\it\u2019s\\tars-hook.mjs', 'node "C:/it\u2019s/tars-hook.mjs" on-stop'],
    ['C:\\\u2018\u201a\u201b\\tars-hook.mjs', 'node "C:/\u2018\u201a\u201b/tars-hook.mjs" on-stop'],
  ])('quotes %s as %s', async (script, command) => {
    const { nodeHookCommand } = await import('../../electron/utils/hook-command');
    expect(nodeHookCommand(script, 'on-stop')).toBe(command);
  });

  it.each([
    "C:\\a$b'c\\tars-hook.mjs",
    'C:\\a`b\u2019c\\tars-hook.mjs',
    'C:\\a\u201cb\u2018c\\tars-hook.mjs',
    'C:\\a\u201db\u201bc\\tars-hook.mjs',
    "C:\\a\u201eb'c\\tars-hook.mjs",
  ])('refuses %s, which no quoting carries through both shells', async script => {
    const { nodeHookCommand } = await import('../../electron/utils/hook-command');
    expect(() => nodeHookCommand(script, 'on-stop')).toThrow(/cannot be quoted/);
  });
});

describe('the statusline on win32', () => {
  async function statusline() {
    vi.doMock('../../electron/constants', async importOriginal => {
      const actual = await importOriginal<typeof import('../../electron/constants')>();
      return { ...actual, DATA_DIR: path.join(home, '.dorothy'), dataPath: (...s: string[]) => path.join(home, '.dorothy', ...s) };
    });
    return import('../../electron/utils/statusline');
  }

  it('is wired as node "<abs>/statusline.mjs", installs no .sh, and turns off cleanly', async () => {
    const s = await statusline();
    s.enableStatusLine({ platform: 'win32', hooksDir: HOOKS_DIR });
    expect(read(claudeSettingsFile()).statusLine).toEqual({
      type: 'command', command: `node "${fwd(path.join(HOOKS_DIR, 'statusline.mjs'))}"`, padding: 1,
    });
    expect(fs.existsSync(path.join(home, '.dorothy', 'statusline.sh'))).toBe(false);
    expect(s.isStatusLineConfigured()).toBe(true);

    s.disableStatusLine({ platform: 'win32', hooksDir: HOOKS_DIR });
    expect(read(claudeSettingsFile()).statusLine).toBeUndefined();
  });

  it('turns off a Node statusline written from another checkout, and leaves a user one alone', async () => {
    const s = await statusline();
    // Another Tars: its hooks folder holds the runner beside the status line.
    const other = oldCheckout();
    fs.writeFileSync(path.join(other, 'tars-hook.mjs'), '// Tars\n');
    fs.writeFileSync(path.join(other, 'statusline.mjs'), '// Tars\n');
    fs.mkdirSync(path.dirname(claudeSettingsFile()), { recursive: true });
    fs.writeFileSync(claudeSettingsFile(), JSON.stringify({ statusLine: { type: 'command', command: `node "${fwd(path.join(other, 'statusline.mjs'))}"`, padding: 1 } }));
    s.disableStatusLine({ platform: 'win32', hooksDir: HOOKS_DIR });
    expect(read(claudeSettingsFile()).statusLine).toBeUndefined();

    fs.writeFileSync(claudeSettingsFile(), JSON.stringify({ statusLine: { type: 'command', command: 'node "C:/me/my-line.mjs"' } }));
    s.disableStatusLine({ platform: 'win32', hooksDir: HOOKS_DIR });
    expect(read(claudeSettingsFile()).statusLine).toEqual({ type: 'command', command: 'node "C:/me/my-line.mjs"' });
  });

  it.each([
    ['in ~/.claude/hooks, even beside a copy of the runner', () => {
      const hooks = path.join(home, '.claude', 'hooks');
      fs.mkdirSync(hooks, { recursive: true });
      fs.writeFileSync(path.join(hooks, 'tars-hook.mjs'), '// a copy\n');
      return path.join(hooks, 'statusline.mjs');
    }],
    ['in a .claude folder elsewhere', () => {
      const hooks = path.join(tmp, 'project', '.claude', 'hooks');
      fs.mkdirSync(hooks, { recursive: true });
      fs.writeFileSync(path.join(hooks, 'tars-hook.mjs'), '// a copy\n');
      return path.join(hooks, 'statusline.mjs');
    }],
    ['in a hooks folder of their own, with no Tars runner beside it', () => {
      const hooks = path.join(fs.mkdtempSync(path.join(tmp, 'mine-')), 'hooks');
      fs.mkdirSync(hooks, { recursive: true });
      return path.join(hooks, 'statusline.mjs');
    }],
  ])('13. leaves a user\'s own Node status line named statusline.mjs %s', async (_where, place) => {
    const s = await statusline();
    const script = place();
    fs.writeFileSync(script, '// theirs\n');
    const theirs = { type: 'command', command: `node "${fwd(script)}"`, padding: 0 };
    fs.mkdirSync(path.dirname(claudeSettingsFile()), { recursive: true });
    fs.writeFileSync(claudeSettingsFile(), JSON.stringify({ model: 'opus', statusLine: theirs }));

    s.disableStatusLine({ platform: 'win32', hooksDir: HOOKS_DIR });

    expect(read(claudeSettingsFile())).toEqual({ model: 'opus', statusLine: theirs });
    expect(fs.existsSync(script)).toBe(true);
  });

  it('on darwin still installs statusline.sh and points at it', async () => {
    const s = await statusline();
    s.enableStatusLine({ platform: 'darwin' });
    const script = path.join(home, '.dorothy', 'statusline.sh');
    expect(read(claudeSettingsFile()).statusLine).toEqual({ type: 'command', command: script, padding: 1 });
    expect(fs.readFileSync(script, 'utf-8').startsWith('#!/usr/bin/env bash')).toBe(true);
  });
});
