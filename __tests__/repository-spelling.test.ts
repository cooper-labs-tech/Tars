import './setup/home-guard';
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The repository's address, spelled once everywhere it is shipped (QA's gate of
 * #349, the move from JeanBrasse/Tars to cooper-labs-tech/Tars on 2026-10-07).
 * Read from the files on disk, never through an import a test could mock:
 * update-checker.test.ts mocks GITHUB_REPO with its own value, and a GITHUB_REPO
 * put back to the old owner passed the whole suite.
 *
 * How it fails, written before this test (2026-10-12):
 * 1. GITHUB_REPO (the update check's API fallback, OpenRouter's site URL) names
 *    another repository than build.publish (electron-updater's feed): an
 *    installed app looks for its updates in two places, and one goes quiet.
 * 2. The landing's REPO (its download link and download count) names another.
 * 3. The privacy policy link in Settings opens another repository's file.
 * 4. A link the app, the landing, the Hermes plugin, an MCP server, a hook or
 *    the state mod carries (a page, a raw file, an API route) keeps an older
 *    spelling after a move, or another case of the same one.
 * 5. A file moves or a constant is renamed, and the test reads nothing: it must
 *    fail then, not pass on an empty list.
 */

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The one spelling: electron-updater's feed, what an installed app follows. */
function published(): string {
  const { owner, repo } = JSON.parse(read('package.json')).build.publish as { owner: string; repo: string };
  return `${owner}/${repo}`;
}

/** The value of `export const <name> = '<value>'` in a source file, or undefined. */
function constant(rel: string, name: string): string | undefined {
  return new RegExp(`export const ${name} = '([^']+)'`).exec(read(rel))?.[1];
}

/** Every file under `dir` with one of `exts`, build output and dependencies left out. */
function files(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', '.next', 'out'].includes(entry.name)) walk(child);
      } else if (exts.some(ext => entry.name.endsWith(ext))) out.push(child);
    }
  };
  walk(dir);
  return out;
}

/** What ships: the app, the landing, the Hermes plugin, the MCP servers, the hooks, the state mod. */
const SHIPPED_DIRS = [
  'src', 'electron', 'landing/src', 'hermes-plugins', 'hooks', 'mods',
  ...fs.readdirSync(ROOT).filter(name => name.startsWith('mcp-')),
];
const TEXT = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sh', '.py', '.yaml', '.yml', '.md', '.json'];

/** github.com/<owner>/Tars, raw.githubusercontent.com/<owner>/Tars and api.github.com/repos/<owner>/Tars, any case. */
const TARS_LINK = /(?:github|githubusercontent)\.com\/(?:repos\/)?([\w.-]+\/tars)\b/gi;

describe("the repository's address, one spelling", () => {
  it('1. the update check and electron-updater name the same repository', () => {
    const repo = published();
    expect(repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
    expect(constant('electron/constants/index.ts', 'GITHUB_REPO'), 'GITHUB_REPO').toBe(repo);
  });

  it("2. the landing's download link and count read the same repository", () => {
    expect(constant('landing/src/lib/downloads.ts', 'REPO'), "the landing's REPO").toBe(published());
  });

  it('3. the privacy policy link opens a file of the same repository', () => {
    const url = constant('src/components/Settings/constants.ts', 'PRIVACY_POLICY_URL');
    expect(url, 'PRIVACY_POLICY_URL').toBeDefined();
    expect(url!.startsWith(`https://github.com/${published()}/`), url).toBe(true);
  });

  it('4, 5. every link to a Tars repository in what ships is the same one', () => {
    const repo = published();
    const shipped = SHIPPED_DIRS.flatMap(dir => files(dir, TEXT));
    expect(shipped.length, 'no shipped file was read').toBeGreaterThan(100);
    const links: Array<{ file: string; repo: string }> = [];
    for (const file of shipped) {
      for (const m of read(file).matchAll(TARS_LINK)) links.push({ file, repo: m[1] });
    }
    // Seven when this was written, all rewritten by the move (#349): ClientLayout's
    // release page, the privacy policy, the landing's three, the plugin's two.
    expect(links.length, 'fewer Tars links than the move rewrote').toBeGreaterThanOrEqual(7);
    expect(links.filter(l => l.repo !== repo), `links to another spelling than ${repo}`).toEqual([]);
  });
});
