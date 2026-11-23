import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { pinPlatform } from './win-fake-disk';

/**
 * Grok's turns reach Tars through its own hooks (grok 1.0.92, measured on 23/11 in a PTY, isolated, against a local
 * stand-in model: a custom `[model.<name>] base_url` in config.toml, no xAI account):
 * - its hooks are Claude Code's, on the wire: `SessionStart` at launch (2.8 s, before anything is typed),
 *   `UserPromptSubmit` with the prompt, `Stop` with `last_assistant_message` and `reason: end_turn`, `StopFailure`,
 *   `SessionEnd` (then a `Stop` with `reason: shutdown` at exit), each with `session_id` and the CLI's environment
 *   (CLAUDE_AGENT_ID, CLAUDE_MGR_API_URL, the token): Tars's own hook scripts read them as they read Claude Code's;
 * - it reads them from `~/.grok/hooks/*.json` (files of Claude's settings shape), and, through its Claude
 *   compatibility, from `~/.claude/settings.json`, where Tars's hooks for claude are; `GROK_CLAUDE_HOOKS_ENABLED=0`
 *   turns that compatibility off (measured: the Claude file's Stop no longer fired);
 * - with a hook installed it asks, in every folder, whether to trust it: the task typed at launch answered the
 *   question, its Enter chose "Yes", and the task was lost. `--trust` trusts the folder and records it in grok's own
 *   store (`~/.grok/trusted_folders.toml`): no question.
 *
 * How it fails, written before the code:
 * 1. A grok agent's line without `--trust`: the trust question takes the task.
 * 2. No Tars hooks among grok's: Tars sees no session, no turn, no end of turn and no answer, and a task delegated to
 *    grok is only `delivered` (the CLI matrix's red, "a CLI without hooks").
 * 3. Tars's file in `~/.grok/hooks/` takes the user's own hooks with it: another file there changed or removed.
 * 4. Tars's hooks run twice, once from grok's own folder and once from `~/.claude/settings.json` through the Claude
 *    compatibility: every event posted twice.
 * 5. On Windows the `.sh` scripts, which cannot run there, instead of the Node runner (`tars-hook.mjs <event>`).
 * 6. A hook Tars has no script for wired anyway, or a hook wired to a script that is not there.
 */

let tmpDir: string;
let hooksDir: string;
let unpin: () => void;

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => tmpDir };
});

const SCRIPTS = ['session-start.sh', 'user-prompt-submit.sh', 'on-stop.sh', 'stop-failure.sh', 'session-end.sh', 'notification.sh', 'post-tool-use.sh'];

beforeEach(() => {
  vi.resetModules();
  unpin = pinPlatform('linux');
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-hooks-test-'));
  hooksDir = path.join(tmpDir, 'app-hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const s of [...SCRIPTS, 'tars-hook.mjs']) fs.writeFileSync(path.join(hooksDir, s), '#!/bin/sh\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  unpin();
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function grok() {
  const { GrokProvider } = await import('../../../electron/providers/grok-provider');
  return new GrokProvider();
}
const tarsFile = () => path.join(tmpDir, '.grok', 'hooks', 'tars.json');
type HookFile = { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>> };
const commandsOf = (file: HookFile) => Object.fromEntries(Object.entries(file.hooks).map(([event, entries]) => [event, entries.flatMap((e) => e.hooks.map((h) => h.command))]));

describe('a grok agent (1, 4)', () => {
  it('trusts its folder on its line, with a prompt or without, and on a resumed session', async () => {
    const p = await grok();
    for (const params of [{ prompt: '' }, { prompt: 'Run the probe.' }, { prompt: '', resumeSessionId: '01a20854-b73a-7b32-89f6-94916c856dda' }]) {
      const line = p.buildInteractiveCommand({ binaryPath: '/opt/grok', ...params } as never);
      expect(line.split(' '), line).toContain('--trust');
    }
  });

  it("runs with grok's Claude compatibility for hooks off, so Tars's hooks run once", async () => {
    const p = await grok();
    expect(p.getPtyEnvVars('a-1', '/p', [])).toMatchObject({ GROK_CLAUDE_HOOKS_ENABLED: '0' });
  });
});

describe("Tars's hooks among grok's own (2, 3, 6)", () => {
  it('says it has native hooks, so Tars hands it its hooks folder and waits for its turns', async () => {
    const p = await grok();
    expect(p.getHookConfig().supportsNativeHooks).toBe(true);
    const { hasEndOfTurn } = await import('../../../electron/core/end-of-turn');
    expect(hasEndOfTurn({ provider: 'grok' })).toBe(true);
  });

  it('writes its own file in ~/.grok/hooks, each event to the script Tars has for it, and leaves the others there alone', async () => {
    const mine = path.join(tmpDir, '.grok', 'hooks', 'mine.json');
    fs.mkdirSync(path.dirname(mine), { recursive: true });
    const users = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } });
    fs.writeFileSync(mine, users);
    const p = await grok();
    await p.configureHooks(hooksDir);
    expect(commandsOf(JSON.parse(fs.readFileSync(tarsFile(), 'utf8')))).toEqual({
      SessionStart: [path.join(hooksDir, 'session-start.sh')],
      UserPromptSubmit: [path.join(hooksDir, 'user-prompt-submit.sh')],
      Stop: [path.join(hooksDir, 'on-stop.sh')],
      StopFailure: [path.join(hooksDir, 'stop-failure.sh')],
      SessionEnd: [path.join(hooksDir, 'session-end.sh')],
      Notification: [path.join(hooksDir, 'notification.sh')],
      PostToolUse: [path.join(hooksDir, 'post-tool-use.sh')],
    });
    expect(fs.readFileSync(mine, 'utf8')).toBe(users);
    const before = fs.statSync(tarsFile()).mtimeMs;
    await p.configureHooks(hooksDir);
    expect(fs.statSync(tarsFile()).mtimeMs, 'rewritten with nothing to change').toBe(before);
  });

  it('wires no event whose script is missing', async () => {
    fs.rmSync(path.join(hooksDir, 'post-tool-use.sh'));
    const p = await grok();
    await p.configureHooks(hooksDir);
    expect(Object.keys(JSON.parse(fs.readFileSync(tarsFile(), 'utf8')).hooks)).not.toContain('PostToolUse');
  });
});

describe('on Windows (5)', () => {
  it("runs Tars's Node runner with the event's name, never a .sh", async () => {
    unpin();
    unpin = pinPlatform('win32');
    const p = await grok();
    await p.configureHooks(hooksDir);
    const commands = commandsOf(JSON.parse(fs.readFileSync(tarsFile(), 'utf8')));
    expect(commands.Stop).toEqual([`node "${path.join(hooksDir, 'tars-hook.mjs').replace(/\\/g, '/')}" on-stop`]);
    for (const list of Object.values(commands)) for (const c of list) expect(c).not.toMatch(/\.sh\b/);
  });
});
