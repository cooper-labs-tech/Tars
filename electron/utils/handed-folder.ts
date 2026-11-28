import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR, PRIVATE_DIR } from '../constants';
import { isUnder, samePath } from '../platform/path-compare';

/**
 * Why a folder may not be handed to an agent besides its project (claude's and
 * codex's --add-dir, gemini's --include-directories), or null when it may.
 *
 * Never ~/.tars-private: nothing under it is ever passed to a CLI (CLAUDE.md),
 * and create_agent and update_agent took any folder that existed (the Audit's
 * L1 on #480). Refused: that folder, a folder inside it, and a folder that holds
 * it (the home folder, its parents, the root), by the spelling given and by
 * where its links lead: a folder not made yet is read where its nearest made
 * parent really is, so a link, a junction or a Windows 8.3 short name on its way
 * is followed too.
 *
 * The paths are compared by the rules of the `path` that resolved them, Windows
 * for path.win32 (separators, case, trailing dots and spaces, `\\?\`), never by
 * process.platform alone: a Windows host whose process.platform said linux read
 * a C:\ path by POSIX rules, and a folder inside the private one was not inside
 * it (update-agent-route.test.ts 12b on a Windows PC, 2026-10-20).
 */
export function handedFolderProblem(folder: string, where: { privateDir: string } = { privateDir: PRIVATE_DIR }): string | null {
  // A `.` or `..` is refused as written: the system follows a link before it goes up, path.resolve goes up on the
  // text first, so proj/lnk/../x was read as proj/x (the Audit's M1 on #503).
  if (folder.split(/[\\/]/).some(seg => seg === '.' || seg === '..')) {
    return `${folder} has a "." or ".." in it: name the folder by its plain path`;
  }
  const rules: NodeJS.Platform = path.sep === '\\' ? 'win32' : 'linux';
  const same = (a: string, b: string) => samePath(a, b, rules);
  const under = (a: string, b: string) => isUnder(a, b, rules);
  const privates = places(where.privateDir);
  for (const place of places(folder)) {
    for (const priv of privates) {
      if (same(place, priv) || under(place, priv)) {
        return `${folder} is ${same(place, priv) ? '' : 'inside '}${where.privateDir}, which agents are never handed`;
      }
      if (under(priv, place)) {
        return `${folder} holds ${where.privateDir}, which agents are never handed: name a folder of its own`;
      }
    }
  }
  return null;
}

/** A folder as spelled, and where it really is: its own real path, or its nearest made parent's with the rest after it. */
function places(folder: string): string[] {
  const spelled = path.resolve(folder);
  const rest: string[] = [];
  for (let dir = spelled; ; dir = path.dirname(dir)) {
    try {
      return [spelled, path.join(fs.realpathSync.native(dir), ...rest)];
    } catch {
      // Not made yet, or not readable: try its parent.
    }
    if (path.dirname(dir) === dir) return [spelled];
    rest.unshift(path.basename(dir));
  }
}

/**
 * The secondary folder a launch hands the CLI, or undefined when it may not
 * be: one saved before create_agent and update_agent checked it, through a
 * window path that did not, or by hand in agents.json (the Audit's L4 on
 * #480). The four providers that hand one ask it as they write the flag, so
 * every launch path does, and ask it of each template folder
 * (obsidianVaultPaths) too, read back from agents.json and templates.json,
 * which any agent can write (the Audit's L1 on #501). The folder is left out
 * with a line in the log; the launch itself goes on.
 */
export function handedSecondaryFolder(folder: string | undefined): string | undefined {
  if (!folder) return undefined;
  const problem = handedFolderProblem(folder);
  if (!problem) return folder;
  console.warn(`[launch] folder not handed: ${problem}`);
  return undefined;
}

/**
 * The folders a claude agent's line hands with --add-dir (providers/claude-provider.ts), in its order: its secondary
 * folder, a template's folders that exist, each as handedSecondaryFolder allows, and ~/.tars, which every agent is
 * handed. The one list both the line and its trust are made from (core/claude-trust.ts): Claude Code stops before its
 * first turn on any of these it does not trust (measured on 2.1.332, 27/11).
 */
export function claudeAddedFolders(agent: { secondaryProjectPath?: string | null; obsidianVaultPaths?: string[] | null }): string[] {
  const folders: string[] = [];
  const secondary = handedSecondaryFolder(agent.secondaryProjectPath ?? undefined);
  if (secondary) folders.push(secondary);
  for (const vp of agent.obsidianVaultPaths ?? []) {
    if (handedSecondaryFolder(vp) && fs.existsSync(vp)) folders.push(vp);
  }
  folders.push(DATA_DIR);
  return folders;
}
