import '../../setup/home-guard';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * The folder an agent is handed besides its project, as the launch writes it on the CLI's line (claude's and codex's
 * --add-dir, gemini's and Qwen Code's --include-directories): never ~/.tars-private, whatever agents.json says. The
 * create_agent and update_agent routes refuse it since #480 (handed-folder.ts); an agent saved before them, through a
 * window path that did not check, or by hand in agents.json, still carried it to the launch (the Audit's L4 on #480).
 *
 * How it fails, written before the code:
 * 1. A launch hands ~/.tars-private, or a folder inside it, to the CLI.
 * 2. A launch hands a folder that holds it: the home folder, or the root.
 * 3. A launch hands a link in a project that leads to it.
 * 4. Over-refusal: a plain secondary folder is no longer on the line of a provider that hands one, or a launch
 *    throws instead of leaving the refused folder out.
 * 5. The template's folders (obsidianVaultPaths), which a launch hands with the same flag, hand any of those: they are
 *    read back from agents.json and templates.json under ~/.tars, which any agent can write (the Audit's L1 on #501).
 *    And over-refusal there: a plain vault beside a refused one is left out too.
 */

let root: string;
let home: string;

vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: () => home, default: { ...mod, homedir: () => home } };
});

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secondary-launch-')));
  home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.tars-private', 'accounts'), { recursive: true });
  fs.mkdirSync(path.join(home, 'projects', 'demo'), { recursive: true });
  fs.mkdirSync(path.join(home, 'projects', 'shared'), { recursive: true });
  fs.symlinkSync(path.join(home, '.tars-private'), path.join(home, 'projects', 'demo', 'secrets'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** The four providers that hand a secondary folder, and the flag each hands it with. */
const HANDING = { claude: '--add-dir', codex: '--add-dir', gemini: '--include-directories', 'qwen-code': '--include-directories' } as const;

async function lineFor(id: keyof typeof HANDING, secondaryProjectPath?: string, obsidianVaultPaths?: string[]): Promise<string> {
  vi.resetModules();
  const { getProvider } = await import('../../../electron/providers');
  return getProvider(id).buildInteractiveCommand({
    binaryPath: 'cli',
    prompt: 'go',
    permissionMode: 'normal',
    secondaryProjectPath,
    obsidianVaultPaths,
  });
}

/** What a launch must never hand, spelled each way it can be (cases 1 to 3). */
const refusedFolders = () => [
  path.join(home, '.tars-private'),
  path.join(home, '.tars-private', 'accounts'),
  `${path.join(home, '.tars-private')}/`,
  home,
  path.parse(home).root,
  path.join(home, 'projects', 'demo', 'secrets'),
];

/** Whether the line hands `folder` with `flag`, quoted or not. */
function hands(line: string, flag: string, folder: string): boolean {
  return line.includes(`${flag} '${folder}'`) || line.includes(`${flag} ${folder}`) || line.includes(`${flag}="${folder}"`);
}

describe('the secondary folder on a launch line', () => {
  it('1 to 3. never hands ~/.tars-private, a folder inside it, a folder that holds it, or a link to it', async () => {
    const refused = refusedFolders();
    const wrong: string[] = [];
    for (const [id, flag] of Object.entries(HANDING) as [keyof typeof HANDING, string][]) {
      for (const folder of refused) {
        const line = await lineFor(id, folder);
        if (hands(line, flag, folder)) wrong.push(`${id} hands ${folder}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('4. still hands a plain folder, on each of the four', async () => {
    const shared = path.join(home, 'projects', 'shared');
    for (const [id, flag] of Object.entries(HANDING) as [keyof typeof HANDING, string][]) {
      expect(hands(await lineFor(id, shared), flag, shared), id).toBe(true);
    }
  });

  it.each(Object.entries(HANDING) as [keyof typeof HANDING, string][])('5. %s never hands one as a template\'s folder, and still hands a plain one', async (id, flag) => {
    const vault = path.join(home, 'projects', 'shared');
    const line = await lineFor(id, undefined, [...refusedFolders(), vault]);
    expect(refusedFolders().filter(folder => hands(line, flag, folder))).toEqual([]);
    expect(hands(line, flag, vault)).toBe(true);
  });
});
