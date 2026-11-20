import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * What Tars hands codex, read from codex itself (2.0.4): the flags its permission modes become, the effort, and the
 * models the account has. Measured on codex-cli 0.163.0 (standalone install, ChatGPT account), the version JeanBrasse
 * runs.
 *
 * The ways it fails:
 * 1. A flag the installed codex rejects: `--full-auto` (0.163: "unexpected argument '--full-auto'", exit 2) killed
 *    every agent in auto or bypass at launch; `-a untrusted` and `-a on-failure`, gone from 0.163, would do the same.
 * 2. auto handed a policy that waits for a person (`-a on-request`): nobody answers codex in an agent's terminal.
 * 3. `--approve-for-me` handed to a codex that does not have it (an older install): exit 2 again. Which flags the
 *    installed codex has is read from its own `--help`, once per binary, never on every launch; a codex that cannot
 *    be asked is handed the stable flags only.
 * 4. bypass not codex's own bypass flag; normal handed flags, which would override the user's own codex settings.
 * 5. The effort dropped (`"reasoning_effort": null` in codex's own session log for an agent set to low), handed in a
 *    form codex does not read, or at a level the model does not take, which codex refuses: clamped to the nearest
 *    level below that the model takes. An effort that is not one of Tars's levels is never handed over.
 * 6. The model list fixed and stale: a model the account cannot use offered (gpt-5-codex-mini, refused for a
 *    ChatGPT account), the account's own models missing, hidden ones offered (the guardian's codex-auto-review),
 *    codex's order lost, or a cache codex wrote otherwise (fields missing, another type) crashing the list.
 * 7. A codex slow to answer --help taken for one without the flags. Under a heavy load (a load average of 170 at the
 *    gate of #465's head, where the stand-in answered in up to 0.9 s), an auto agent of codex-works was handed the
 *    stable flags: its codex had taken longer than the 2 s Tars waited, and that answer is kept for the binary, so
 *    every launch of the run lost codex's automatic review. The answer is waited for as long as codex takes, to 10 s.
 * 8. codex asked on the main thread (the Audit's L6 on #465): read with execFileSync, --help froze the whole window
 *    for as long as codex took, up to the 10 s of 7, under the very load 7 is about. It is read with execFile, and
 *    nothing waits on it but the launch that needs it (CodexProvider.prepareLaunch): a line built before the answer
 *    has the stable flags, and the answer is then kept for the next. The asks made while codex answers share that one
 *    codex; a codex updated (its size or time of change) is asked again; a codex that could not answer (not there,
 *    failed, hung past its time) is asked again at the next launch, its failure never kept for the binary.
 */

import {
  codexPermissionArgs, codexEffortArgs, codexModelsFrom, readCodexModels, codexFlagsFromHelp, codexAccepts, codexHome,
  readCodexFlags,
} from '../../../electron/providers/codex-cli';

/** codex 0.163.0's own models_cache.json, cut to what Tars reads, in its order on disk. */
const CACHE = {
  fetched_at: '2026-10-18T12:03:37.654281Z', client_version: '0.163.0',
  models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.', visibility: 'list', priority: 1, default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort, description: '' })) },
    { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', description: 'Fast and efficient.', visibility: 'list', priority: 4, default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({ effort, description: '' })) },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', description: 'The guardian.', visibility: 'hide', priority: 43, default_reasoning_level: 'medium', supported_reasoning_levels: [{ effort: 'medium' }] },
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.', visibility: 'list', priority: 2, default_reasoning_level: 'low', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }] },
  ],
};

const HELP_0163 = `Codex CLI
  -s, --sandbox <SANDBOX_MODE>
      --approve-for-me
          Route approval requests through automatic review using the workspace-write sandbox
      --dangerously-bypass-approvals-and-sandbox
  -a, --ask-for-approval <APPROVAL_POLICY>`;
const HELP_OLDER = `Codex CLI
  -s, --sandbox <SANDBOX_MODE>
      --full-auto
      --dangerously-bypass-approvals-and-sandbox
  -a, --ask-for-approval <APPROVAL_POLICY>`;

const all = (flags: Set<string>) => (flag: string) => flags.has(flag);

describe("codex's permission flags", () => {
  const with0163 = all(codexFlagsFromHelp(HELP_0163));
  const withOlder = all(codexFlagsFromHelp(HELP_OLDER));

  it('never --full-auto, nor an approval policy 0.163 has dropped', () => {
    for (const accepts of [with0163, withOlder]) {
      for (const mode of ['normal', 'auto', 'bypass', 'plan', undefined]) {
        const args = codexPermissionArgs(mode, accepts).join(' ');
        expect(args, String(mode)).not.toContain('--full-auto');
        expect(args, String(mode)).not.toMatch(/untrusted|on-failure|on-request/);
      }
    }
  });

  it('auto: the automatic review where codex has it, else never asking inside the workspace sandbox', () => {
    expect(codexPermissionArgs('auto', with0163)).toEqual(['--approve-for-me']);
    expect(codexPermissionArgs('auto', withOlder)).toEqual(['--ask-for-approval', 'never', '--sandbox', 'workspace-write']);
  });

  it("bypass: codex's own bypass; normal (and plan, refused for codex upstream): codex's own settings", () => {
    expect(codexPermissionArgs('bypass', with0163)).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    expect(codexPermissionArgs('normal', with0163)).toEqual([]);
    expect(codexPermissionArgs(undefined, with0163)).toEqual([]);
    expect(codexPermissionArgs('plan', with0163)).toEqual([]);
  });
});

/** A codex whose --help counts its asks in `count`, after `before` (shell lines), and prints `help`. */
function fakeCodex(help: string, before = ''): { bin: string; count: string; asks: () => number } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-help-'));
  const count = path.join(dir, 'count');
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\necho x >> '${count}'\n${before}cat <<'EOF'\n${help}\nEOF\n`, { mode: 0o755 });
  return { bin, count, asks: () => (fs.existsSync(count) ? fs.readFileSync(count, 'utf8').trim().split('\n').length : 0) };
}

describe('which flags the installed codex has', () => {
  it('read from its own --help, once per binary', async () => {
    const { bin, asks } = fakeCodex(HELP_0163);
    await readCodexFlags(bin);
    expect(codexAccepts(bin)('--approve-for-me')).toBe(true);
    expect(codexAccepts(bin)('--full-auto')).toBe(false);
    await readCodexFlags(bin);
    expect(asks(), 'codex was asked on every launch').toBe(1);
  });

  it('7. a codex slow to answer, as under a heavy load, is waited for: the flags are its own', async () => {
    const { bin } = fakeCodex(HELP_0163, 'sleep 2.5\n');
    expect((await readCodexFlags(bin))?.has('--approve-for-me')).toBe(true);
    expect(codexAccepts(bin)('--approve-for-me')).toBe(true);
  }, 15_000);

  it('8. never on the main thread: the event loop runs while codex answers, and a line built meanwhile has the stable flags', async () => {
    const { bin } = fakeCodex(HELP_0163, 'sleep 1.5\n');
    const asked = Date.now();
    const meanwhile = codexAccepts(bin)('--approve-for-me');
    expect(Date.now() - asked, 'codex was run on the main thread').toBeLessThan(500);
    expect(meanwhile).toBe(false);
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 50);
    try {
      expect((await readCodexFlags(bin))?.has('--approve-for-me')).toBe(true);
    } finally {
      clearInterval(timer);
    }
    expect(ticks, 'the event loop waited on codex').toBeGreaterThan(10);
    expect(codexAccepts(bin)('--approve-for-me')).toBe(true);
  }, 15_000);

  it('8. the asks made while codex answers share it: one codex for three launches, and none after', async () => {
    const { bin, asks } = fakeCodex(HELP_0163, 'sleep 0.5\n');
    const answers = await Promise.all([readCodexFlags(bin), readCodexFlags(bin), readCodexFlags(bin)]);
    expect(answers.map(flags => flags?.has('--approve-for-me'))).toEqual([true, true, true]);
    await readCodexFlags(bin);
    expect(asks()).toBe(1);
  });

  it('8. a codex updated is asked again: its flags are the new one\'s', async () => {
    const { bin, count, asks } = fakeCodex(HELP_0163);
    expect((await readCodexFlags(bin))?.has('--approve-for-me')).toBe(true);
    fs.writeFileSync(bin, `#!/bin/sh\necho x >> '${count}'\ncat <<'EOF'\n${HELP_OLDER}\nEOF\n`, { mode: 0o755 });
    const older = await readCodexFlags(bin);
    expect(older?.has('--full-auto')).toBe(true);
    expect(codexAccepts(bin)('--approve-for-me')).toBe(false);
    expect(asks()).toBe(2);
  });

  it('8. a codex that could not answer is asked again at the next launch: its failure is not kept', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-help-'));
    const marker = path.join(dir, 'answered-once');
    const { bin } = fakeCodex(HELP_0163, `if [ ! -f '${marker}' ]; then : > '${marker}'; exit 3; fi\n`);
    expect(await readCodexFlags(bin)).toBeUndefined();
    expect(codexAccepts(bin)('--approve-for-me')).toBe(false);
    expect((await readCodexFlags(bin))?.has('--approve-for-me')).toBe(true);
    expect(codexAccepts(bin)('--approve-for-me')).toBe(true);
  });

  it('8. a codex that hangs on --help is given up on at its time', async () => {
    const { bin } = fakeCodex(HELP_0163, 'exec sleep 30\n');
    const asked = Date.now();
    expect(await readCodexFlags(bin, 300)).toBeUndefined();
    expect(Date.now() - asked).toBeLessThan(5_000);
  }, 15_000);

  it('a codex that cannot be asked is handed the stable flags only', async () => {
    const nowhere = path.join(os.tmpdir(), 'no-such-codex-binary');
    expect(await readCodexFlags(nowhere)).toBeUndefined();
    const accepts = codexAccepts(nowhere);
    expect(accepts('--approve-for-me')).toBe(false);
    expect(codexPermissionArgs('auto', accepts)).toEqual(['--ask-for-approval', 'never', '--sandbox', 'workspace-write']);
  });
});

describe("the effort, as codex takes it", () => {
  const models = codexModelsFrom(CACHE);

  it('as model_reasoning_effort, at the level asked when the model takes it', () => {
    expect(codexEffortArgs('low', 'gpt-6-luna', models)).toEqual(['-c', 'model_reasoning_effort=low']);
    expect(codexEffortArgs('max', 'gpt-6.1-sol', models)).toEqual(['-c', 'model_reasoning_effort=max']);
  });

  it('clamped to the nearest level below that the model takes', () => {
    expect(codexEffortArgs('max', 'gpt-6-astra', models)).toEqual(['-c', 'model_reasoning_effort=high']);
    expect(codexEffortArgs('xhigh', 'gpt-6-astra', models)).toEqual(['-c', 'model_reasoning_effort=high']);
  });

  it("as asked on a model codex's list does not hold, or with no model named; nothing for no effort or a word that is not a level", () => {
    expect(codexEffortArgs('medium', 'gpt-7-unknown', models)).toEqual(['-c', 'model_reasoning_effort=medium']);
    expect(codexEffortArgs('high', undefined, models)).toEqual(['-c', 'model_reasoning_effort=high']);
    expect(codexEffortArgs(undefined, 'gpt-6-luna', models)).toEqual([]);
    expect(codexEffortArgs('low; rm -rf ~', 'gpt-6-luna', models)).toEqual([]);
  });
});

describe("the account's models, from codex's own cache", () => {
  it('the models codex lists, in its order, with their names and efforts; never a hidden one', () => {
    const models = codexModelsFrom(CACHE);
    expect(models.map(m => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']);
    expect(models[0]).toMatchObject({ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.', defaultEffort: 'low' });
    expect(models[2].efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('nothing from a cache written otherwise, rather than a crash', () => {
    for (const odd of [null, 'text', 42, {}, { models: 'x' }, { models: [null, 3, { slug: 7 }, { display_name: 'no slug' }] }]) {
      expect(codexModelsFrom(odd), JSON.stringify(odd)).toEqual([]);
    }
    expect(codexModelsFrom({ models: [{ slug: 'gpt-6-luna' }] })).toEqual([{ id: 'gpt-6-luna', name: 'gpt-6-luna', description: '', efforts: [] }]);
  });

  it("read from CODEX_HOME's models_cache.json, or ~/.codex's; none when codex has not written it", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-home-'));
    expect(readCodexModels(home)).toEqual([]);
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify(CACHE));
    expect(readCodexModels(home).map(m => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']);
    expect(codexHome({ CODEX_HOME: home } as NodeJS.ProcessEnv)).toBe(home);
    expect(codexHome({} as NodeJS.ProcessEnv)).toBe(path.join(os.homedir(), '.codex'));
  });
});
