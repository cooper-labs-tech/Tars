import './home-guard';
import { it, expect, vi } from 'vitest';
import * as os from 'node:os';

/**
 * G7 of home-guard.test.ts: the guard reads the home Node has, not one a test file mocks.
 *
 * Two guarded files (hermes-desktop-import, posix-words) mock `os` with a homedir that returns a
 * folder they set after their imports. The guard, imported first, read that mock before the folder
 * was set, and both files stopped with "Cannot access ... before initialization" (QA's suite run,
 * 20/11 04:15). This file has the same shape: it loads only if the guard reads the real home.
 */

vi.mock('os', async importOriginal => ({ ...(await importOriginal<typeof import('os')>()), homedir: () => mocked }));
vi.mock('node:os', async importOriginal => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => mocked }));
const mocked = '/nowhere/a-mocked-home';

it('G7. a file that mocks os.homedir with a folder it sets after its imports still loads behind the guard', () => {
  expect(os.homedir()).toBe(mocked);
});
