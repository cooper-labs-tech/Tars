import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import { cliPathDirs } from '../../../electron/utils/cli-path-dirs';
import { CLI_PATH_KEYS } from '../../../electron/types';

/**
 * The four hand-written key lists, and what they had stopped agreeing on.
 *
 * Every caller that builds an agent's PATH needed the same set and each spelled
 * it out. They drifted, and the drift was invisible: a binary the user had
 * configured in Settings simply never reached the PATH of an agent started
 * from one of the paths that had forgotten it.
 *
 * These are the four as they stood at dcbd87e, the commit before this one.
 * They are here as the historical record, not as a fixture: the point of the
 * suite is that nothing they covered was lost, and that has to be checked key
 * by key rather than by a count.
 */
const OLD_LISTS: Record<string, string[]> = {
  'agent-manager initAgentPty': ['amp', 'claude', 'codex', 'gemini', 'grok', 'gws', 'gh', 'node'],
  'ipc-handlers cli detection': ['amp', 'claude', 'codex', 'gemini', 'opencode', 'pi', 'gws', 'gh', 'node'],
  'ipc-handlers agent start': ['amp', 'claude', 'codex', 'gemini', 'opencode', 'pi', 'gws', 'gh', 'node'],
  'agent-routes spawnAgentSession': ['amp', 'claude', 'codex', 'gemini', 'grok', 'qwencode', 'opencode', 'pi', 'gws', 'gh', 'node'],
};

const EVERY_OLD_KEY = [...new Set(Object.values(OLD_LISTS).flat())].sort();

/** A settings blob with every key the current build knows about. */
function allKeysConfigured(): Record<string, unknown> {
  const cliPaths: Record<string, unknown> = {};
  for (const key of CLI_PATH_KEYS) cliPaths[key] = `/opt/${key}/bin/${key}`;
  return cliPaths;
}

describe('the four lists this replaced', () => {
  it.each(Object.entries(OLD_LISTS))('covers every key %s used to read', (_where, keys) => {
    const cliPaths: Record<string, unknown> = {};
    for (const key of keys) cliPaths[key] = `/opt/${key}/bin/${key}`;

    const dirs = cliPathDirs(cliPaths);

    // Key by key: a set comparison would pass while one binary quietly stopped
    // reaching the PATH, which is the failure being replaced.
    for (const key of keys) {
      expect(dirs, `${key} was on the old list and no longer reaches the PATH`)
        .toContain(`/opt/${key}/bin`);
    }
  });

  it('loses nothing at all, taking the four together', () => {
    const cliPaths: Record<string, unknown> = {};
    for (const key of EVERY_OLD_KEY) cliPaths[key] = `/opt/${key}/bin/${key}`;

    const dirs = cliPathDirs(cliPaths);

    expect(dirs).toHaveLength(EVERY_OLD_KEY.length);
    for (const key of EVERY_OLD_KEY) expect(dirs).toContain(`/opt/${key}/bin`);
  });

  it.each(['gcloud', 'minimax'])(
    'now reaches the PATH with %s, which none of the four had',
    key => {
      // The drift was worse than "they disagree": these two were missing from
      // all four, so a user who configured them in Settings had them ignored
      // by every path that starts an agent.
      for (const list of Object.values(OLD_LISTS)) expect(list).not.toContain(key);

      expect(cliPathDirs({ [key]: `/opt/${key}/bin/${key}` })).toEqual([`/opt/${key}/bin`]);
    },
  );

  it('is a strict superset: every old key survives, two are added, and Kimi Code\'s kimi (19/11), Kilo\'s kilo, Goose\'s goose (20/11) and Cline\'s cline (21/11) since', () => {
    for (const key of EVERY_OLD_KEY) expect(CLI_PATH_KEYS).toContain(key);
    expect([...CLI_PATH_KEYS].filter(k => !EVERY_OLD_KEY.includes(k)).sort())
      .toEqual(['cline', 'gcloud', 'goose', 'kilo', 'kimi', 'minimax']);
  });
});

describe('settings that predate a key, which is every settings file on disk', () => {
  it('returns nothing rather than throwing when there are no cliPaths at all', () => {
    expect(cliPathDirs(undefined)).toEqual([]);
    expect(cliPathDirs(null)).toEqual([]);
    expect(cliPathDirs({})).toEqual([]);
  });

  it('skips a key the settings file has never heard of', () => {
    // app-settings.json is written by older builds and hand-edited. Every key
    // is optional and always will be.
    const cliPaths = { claude: '/opt/claude/bin/claude' };

    expect(cliPathDirs(cliPaths)).toEqual(['/opt/claude/bin']);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a number', 42],
    ['an object', { path: '/opt/x' }],
    ['an array', ['/opt/x']],
  ])('skips a key whose value is %s', (_label, value) => {
    const cliPaths = { claude: '/opt/claude/bin/claude', gh: value };

    expect(cliPathDirs(cliPaths)).toEqual(['/opt/claude/bin']);
  });

  it('keeps the good keys when a neighbour is unusable', () => {
    const cliPaths = allKeysConfigured();
    cliPaths.gh = undefined;
    cliPaths.node = '';

    const dirs = cliPathDirs(cliPaths);

    expect(dirs).toHaveLength(CLI_PATH_KEYS.length - 2);
    expect(dirs).toContain('/opt/claude/bin');
    expect(dirs).not.toContain(path.dirname('/opt/gh/bin/gh'));
  });
});

describe('the directories the user added by hand', () => {
  it('are appended as they are, being directories already', () => {
    const dirs = cliPathDirs({
      claude: '/opt/claude/bin/claude',
      additionalPaths: ['/usr/local/custom', '/home/me/tools'],
    });

    expect(dirs).toEqual(['/opt/claude/bin', '/usr/local/custom', '/home/me/tools']);
  });

  it('survives a malformed additionalPaths without dropping the real keys', () => {
    for (const extra of [undefined, null, 'not-an-array', 7, {}]) {
      expect(cliPathDirs({ claude: '/opt/claude/bin/claude', additionalPaths: extra }))
        .toEqual(['/opt/claude/bin']);
    }
  });

  it('drops the entries in it that are not usable paths', () => {
    const dirs = cliPathDirs({
      additionalPaths: ['/good', '', null, 3, '/also-good'],
    });

    expect(dirs).toEqual(['/good', '/also-good']);
  });
});
