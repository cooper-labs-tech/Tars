import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The command lines Tars starts codex with, in every builder: an agent's terminal and a one-shot (2.0.4; the
 * scheduled-script builders went with PR 466, no path of the app having built one since 1.8.0). Measured on
 * codex-cli 0.163.0.
 *
 * The ways it fails:
 * 1. `--full-auto` anywhere: 0.163 refuses it ("unexpected argument", exit 2), so every codex agent in auto or bypass
 *    died at launch, and so did every scheduled run.
 * 2. `codex exec`'s own options before `exec`: `codex --json exec` is refused too (exit 2). Its options go after it.
 * 3. The effort dropped by a builder (codex-provider.ts had none: `"reasoning_effort": null` in codex's own log for an
 *    agent set to low), or the model.
 * 4. A permission mode turned into a flag the installed codex does not have, which is the same exit 2
 *    (codex-cli.test.ts says which flags each mode becomes; these say every builder uses them). The installed codex's
 *    flags are read before a launch builds its line (prepareLaunch, off the main thread: codex-cli.test.ts, 8). Until
 *    codex 0.170 only auto needed one, so only auto read them (a launch in normal or bypass waited on a --help it
 *    never used, up to 10 s on a loaded machine); since 0.170 every mode needs one (9), so every mode reads them,
 *    once per binary and version: a second launch of the same codex never asks it again.
 * 5. A prompt that leaves its quotes: a task is user text, and the line is run by a shell or read back into argv.
 * 6. A session Tars resumes after a restart started anew, or its id where codex does not read it. Measured on
 *    0.163: `codex resume [OPTIONS] [SESSION_ID] [PROMPT]` continues the session in its own rollout file, with its
 *    conversation (asked what the turn before said, it answered it), and `codex fork <id>` goes on under a new
 *    session, as a restart that applies new settings wants (agent-restart.ts).
 * 7. Anything but a session id after `resume`: it reaches a command line.
 * 8. Tars and the codex it starts reading two homes (the Audit's L4 on #465). Tars writes the folder's trust and the
 *    names of its MCP servers' variables into config.toml under the CODEX_HOME of its own environment (else
 *    ~/.codex), and reads the sessions there; the codex in an agent's terminal read the CODEX_HOME its shell's rc
 *    files set. Where they differ, codex asked "Trust this folder?" for good, and Tars's servers had no identity. The
 *    codex Tars starts is handed Tars's own: on macOS and Linux in its command line, which no rc file can change; on
 *    Windows, where nothing is sourced and the first word of the line is the binary itself, in its environment.
 * 9. A turn that outlives its terminal. codex 0.170's TUI hands its turns to a shared background server, an app-server
 *    daemon it starts under CODEX_HOME (or finds there, the user's own codex's included), detached from the terminal.
 *    Measured on 0.170.0 (20/11, a 15 s shell call, the terminal killed 3 s in, as Tars stops an agent): the call ran
 *    to its end and its result reached the endpoint 7 s after the kill, and two codex processes stayed up after it,
 *    so stopping, restarting or quitting stopped nothing a codex agent was doing. With `--no-daemon` the same kill
 *    ended the turn and left no process. So: `--no-daemon` in every mode, resumed and forked alike, on a codex whose
 *    --help lists it; never on one that does not (an unknown flag is exit 2, as in 4); never in `codex exec`, whose
 *    --help does not list it.
 */

import { CodexProvider } from '../../../electron/providers/codex-provider';
import { codexHome } from '../../../electron/providers/codex-cli';

const HELP_0163 = `Codex CLI
      --approve-for-me
      --dangerously-bypass-approvals-and-sandbox
  -a, --ask-for-approval <APPROVAL_POLICY>`;

/** What 0.170.0's --help lists of these (measured 20/11): its daemon's switch besides 0.163's. */
const HELP_0170 = `${HELP_0163}
      --no-daemon
          Run without the shared background server, even if it is already running`;

let codex016 = '';
const nowhere = path.join(os.tmpdir(), 'no-such-codex-for-tars-tests');
const provider = new CodexProvider();
const PROMPT = "fix it, it's \"quoted\"";

/** The argv a POSIX shell makes of one of these lines: single and double quotes, and backslash-escaped quotes. */
function words(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  let had = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") { if (ch === "'") quote = null; else cur += ch; continue; }
    if (quote === '"') { if (ch === '"') quote = null; else if (ch === '\\' && i + 1 < line.length) cur += line[++i]; else cur += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; had = true; continue; }
    if (ch === '\\' && i + 1 < line.length) { cur += line[++i]; had = true; continue; }
    if (/\s/.test(ch)) { if (cur || had) { out.push(cur); cur = ''; had = false; } continue; }
    cur += ch;
  }
  if (cur || had) out.push(cur);
  return out;
}

/** An agent's terminal line as argv, after the `env CODEX_HOME=<home>` it starts with on macOS and Linux (8). */
function argvOf(line: string): string[] {
  const argv = words(line);
  return argv[0] === 'env' && argv[1]?.startsWith('CODEX_HOME=') ? argv.slice(2) : argv;
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-0163-'));
  codex016 = path.join(dir, 'codex');
  fs.writeFileSync(codex016, `#!/bin/sh\ncat <<'EOF'\n${HELP_0163}\nEOF\n`, { mode: 0o755 });
  // As every launch path does before it builds the line.
  await provider.prepareLaunch(codex016, 'auto');
  await provider.prepareLaunch(nowhere, 'auto');
});

describe("an agent's terminal", () => {
  it('auto: the automatic review on a codex that has it; bypass: its own bypass; never --full-auto', () => {
    const auto = argvOf(provider.buildInteractiveCommand({ binaryPath: codex016, prompt: PROMPT, permissionMode: 'auto' }));
    expect(auto).toContain('--approve-for-me');
    const bypass = argvOf(provider.buildInteractiveCommand({ binaryPath: codex016, prompt: PROMPT, permissionMode: 'bypass' }));
    expect(bypass).toContain('--dangerously-bypass-approvals-and-sandbox');
    const older = argvOf(provider.buildInteractiveCommand({ binaryPath: nowhere, prompt: PROMPT, permissionMode: 'auto' }));
    expect(older).toEqual(expect.arrayContaining(['--ask-for-approval', 'never', '--sandbox', 'workspace-write']));
    for (const argv of [auto, bypass, older]) expect(argv).not.toContain('--full-auto');
  });

  it('the model and the effort, the prompt last and whole', () => {
    const argv = argvOf(provider.buildInteractiveCommand({ binaryPath: codex016, prompt: PROMPT, model: 'gpt-6-luna', effort: 'low', permissionMode: 'normal' }));
    expect(argv[0]).toBe(codex016);
    expect(argv.slice(1, 3)).toEqual(['--model', 'gpt-6-luna']);
    expect(argv).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort=low']));
    expect(argv[argv.length - 1]).toBe(PROMPT);
    expect(argv).not.toContain('--approve-for-me');
  });
});

/** A codex at a path of its own whose --help is `help`, counting how often it is asked. */
function fakeCodex(help: string): { bin: string; asks: () => number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-modes-'));
  const count = path.join(dir, 'count');
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\necho x >> '${count}'\ncat <<'EOF'\n${help}\nEOF\n`, { mode: 0o755 });
  return { bin, asks: () => (fs.existsSync(count) ? fs.readFileSync(count, 'utf8').trim().split('\n').length : 0) };
}

describe("what a launch reads of codex first", () => {
  it('4. its --help in every mode, once per binary: a second launch of the same codex does not ask it again', async () => {
    for (const mode of ['normal', 'bypass', undefined, 'auto']) {
      const { bin, asks } = fakeCodex(HELP_0170);
      await provider.prepareLaunch(bin, mode);
      expect(asks(), `a launch in ${mode ?? 'no mode'} read codex's flags`).toBe(1);
      expect(argvOf(provider.buildInteractiveCommand({ binaryPath: bin, prompt: PROMPT, permissionMode: mode })), `in ${mode ?? 'no mode'}`).toContain('--no-daemon');
    }
    const { bin, asks } = fakeCodex(HELP_0163);
    await provider.prepareLaunch(bin, 'normal');
    await provider.prepareLaunch(bin, 'bypass');
    await provider.prepareLaunch(bin, 'auto');
    expect(asks(), 'the same codex was asked again').toBe(1);
    expect(argvOf(provider.buildInteractiveCommand({ binaryPath: bin, prompt: PROMPT, permissionMode: 'auto' }))).toContain('--approve-for-me');
    // Five codex started one after the other: over 5 s on a loaded machine (a load average of 21, measured 20/11).
  }, 30_000);
});

describe("codex's shared background server", () => {
  const ID = '01a14fb7-9e95-7c81-8980-2b82c8316805';

  it('9. a codex that lists --no-daemon runs without it, in every mode, started, resumed or forked', async () => {
    const { bin } = fakeCodex(HELP_0170);
    await provider.prepareLaunch(bin, 'bypass');
    for (const mode of ['normal', 'auto', 'bypass', undefined]) {
      const fresh = argvOf(provider.buildInteractiveCommand({ binaryPath: bin, prompt: PROMPT, permissionMode: mode }));
      expect(fresh, `started in ${mode ?? 'no mode'}`).toContain('--no-daemon');
      expect(fresh[fresh.length - 1]).toBe(PROMPT);
    }
    const resumed = argvOf(provider.buildInteractiveCommand({ binaryPath: bin, prompt: PROMPT, permissionMode: 'bypass', resumeSessionId: ID }));
    expect(resumed.slice(0, 2)).toEqual([bin, 'resume']);
    expect(resumed).toContain('--no-daemon');
    expect(resumed.slice(-2)).toEqual([ID, PROMPT]);
    const forked = argvOf(provider.buildInteractiveCommand({ binaryPath: bin, prompt: '', resumeSessionId: ID, forkSession: true }));
    expect(forked.slice(0, 2)).toEqual([bin, 'fork']);
    expect(forked).toContain('--no-daemon');
    expect(forked[forked.length - 1]).toBe(ID);
  });

  it('9. never on a codex that does not list it, nor on one that could not answer, nor in codex exec', async () => {
    for (const mode of ['normal', 'auto', 'bypass']) {
      expect(argvOf(provider.buildInteractiveCommand({ binaryPath: codex016, prompt: PROMPT, permissionMode: mode })), `0.163 in ${mode}`).not.toContain('--no-daemon');
      expect(argvOf(provider.buildInteractiveCommand({ binaryPath: nowhere, prompt: PROMPT, permissionMode: mode })), `no codex in ${mode}`).not.toContain('--no-daemon');
    }
    const { bin } = fakeCodex(HELP_0170);
    await provider.prepareLaunch(bin, 'bypass');
    expect(words(provider.buildOneShotCommand({ binaryPath: bin, prompt: PROMPT }))).not.toContain('--no-daemon');
  });
});

describe('the codex home', () => {
  it('8. on macOS and Linux, the line hands codex the home Tars reads and writes, before the binary', () => {
    const argv = words(provider.buildInteractiveCommand({ binaryPath: codex016, prompt: PROMPT }));
    expect(argv.slice(0, 3)).toEqual(['env', `CODEX_HOME=${codexHome()}`, codex016]);
    expect(argv[argv.length - 1]).toBe(PROMPT);
  });

  it("8. on Windows, the terminal's environment does, and the line starts with codex itself", () => {
    const was = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      expect(words(provider.buildInteractiveCommand({ binaryPath: codex016, prompt: PROMPT }))[0]).toBe(codex016);
      expect(provider.getPtyEnvVars('a', '/p', []).CODEX_HOME).toBe(codexHome());
    } finally {
      Object.defineProperty(process, 'platform', was);
    }
  });
});

describe('a session resumed or forked', () => {
  const ID = '01a14fb7-9e95-7c81-8980-2b82c8316805';

  it('resumed: codex resume, its options, the session, then the prompt', () => {
    const argv = argvOf(provider.buildInteractiveCommand({ binaryPath: codex016, prompt: PROMPT, model: 'gpt-6-luna', effort: 'low', permissionMode: 'auto', resumeSessionId: ID }));
    expect(argv.slice(0, 2)).toEqual([codex016, 'resume']);
    expect(argv).toEqual(expect.arrayContaining(['--model', 'gpt-6-luna', '-c', 'model_reasoning_effort=low', '--approve-for-me']));
    expect(argv.slice(-2)).toEqual([ID, PROMPT]);
  });

  it('forked: codex fork; with no task, the session last', () => {
    const fork = argvOf(provider.buildInteractiveCommand({ binaryPath: codex016, prompt: PROMPT, resumeSessionId: ID, forkSession: true }));
    expect(fork.slice(0, 2)).toEqual([codex016, 'fork']);
    expect(fork.slice(-2)).toEqual([ID, PROMPT]);
    const bare = argvOf(provider.buildInteractiveCommand({ binaryPath: codex016, prompt: '', resumeSessionId: ID }));
    expect(bare.slice(0, 2)).toEqual([codex016, 'resume']);
    expect(bare[bare.length - 1]).toBe(ID);
  });

  it('anything but a session id is never resumed', () => {
    const line = provider.buildInteractiveCommand({ binaryPath: codex016, prompt: PROMPT, resumeSessionId: "x'; rm -rf ~; '" });
    expect(words(line)).not.toContain('resume');
    expect(line).not.toContain('rm -rf');
  });
});

describe('a one-shot', () => {
  it("puts codex exec's own options after exec, with the model and the effort", () => {
    const oneShot = words(provider.buildOneShotCommand({ binaryPath: codex016, prompt: PROMPT, model: 'gpt-6-luna', effort: 'medium' }));
    expect(oneShot.slice(0, 2)).toEqual([codex016, 'exec']);
    expect(oneShot).toEqual(expect.arrayContaining(['--model', 'gpt-6-luna', '-c', 'model_reasoning_effort=medium']));
    expect(oneShot[oneShot.length - 1]).toBe(PROMPT);
    expect(oneShot).not.toContain('--full-auto');
  });
});
