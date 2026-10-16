import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Where the e2e suite reads its visual references, per platform.
 *
 * The references in e2e/__screenshots__ are macOS's. A Windows run compared
 * against them fails on every surface for the fonts and the title bar alone,
 * and re-recording there would overwrite them. So Windows reads and writes its
 * own folder beside them, and macOS and Linux read the same files they always
 * have.
 *
 * How it can fail:
 *  1. macOS or Linux reads another folder than the one the references are in,
 *     and every surface is "missing" there;
 *  2. Windows reads the macOS references, and fails, or overwrites them;
 *  3. the folder depends on anything but the platform, and two runs of one
 *     machine disagree.
 */

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(ROOT, 'e2e', '__screenshots__');
const realPlatform = process.platform;
// Loading the config names a run directory in the environment; not this file's to keep.
const runDirBefore = process.env.E2E_RUN_DIR;

/** playwright.config.ts as a run on `platform` loads it, and the file it names for `name`. */
async function referenceFor(platform: NodeJS.Platform, name: string): Promise<string> {
  Object.defineProperty(process, 'platform', { value: platform });
  vi.resetModules();
  const config = (await import('../playwright.config')).default;
  const template = config.snapshotPathTemplate as string;
  // Playwright's own substitutions, for the tokens this template may use.
  const { name: base, ext } = path.parse(name);
  return path.normalize(template
    .replace('{testDir}', path.resolve(ROOT, config.testDir as string))
    .replace('{platform}', platform)
    .replace('{arg}', base)
    .replace('{ext}', ext));
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  if (runDirBefore === undefined) delete process.env.E2E_RUN_DIR;
  else process.env.E2E_RUN_DIR = runDirBefore;
});

describe('the visual references an e2e run compares against', () => {
  it('are the ones already recorded, on macOS (1)', async () => {
    const reference = await referenceFor('darwin', 'agents.png');
    expect(reference).toBe(path.join(SHOTS, 'agents.png'));
    expect(fs.existsSync(reference), `${reference} is not where the macOS references are`).toBe(true);
  });

  it('are a folder of their own on Windows, beside the macOS ones (2)', async () => {
    expect(await referenceFor('win32', 'agents.png')).toBe(path.join(SHOTS, 'win32', 'agents.png'));
  });

  it('are the ones already recorded on Linux too, as upstream reads them (1)', async () => {
    expect(await referenceFor('linux', 'agents.png')).toBe(path.join(SHOTS, 'agents.png'));
  });

  it('follow the platform and nothing else (3)', async () => {
    expect(await referenceFor('darwin', 'agents.png')).toBe(await referenceFor('darwin', 'agents.png'));
    expect(await referenceFor('win32', 'agents.png')).toBe(await referenceFor('win32', 'agents.png'));
  });
});
