import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The git configuration file of the repository a folder belongs to, the one every worktree of it
 * shares, or null outside any repository. From the main checkout it is `.git/config`; from a
 * worktree, `.git` is a file naming the worktree's own git folder, whose `commondir` leads back to
 * the main checkout's: a `git config` run in either writes there.
 */
export function sharedGitConfig(start: string): string | null {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    let stat: fs.Stats | null = null;
    try { stat = fs.statSync(dotGit); } catch { /* not here: look higher */ }
    if (stat?.isDirectory()) return path.join(dotGit, 'config');
    if (stat?.isFile()) {
      const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1];
      if (!gitdir) return null;
      const own = path.resolve(dir, gitdir);
      let common = own;
      try { common = path.resolve(own, fs.readFileSync(path.join(own, 'commondir'), 'utf8').trim()); } catch { /* a submodule's: its own */ }
      return path.join(common, 'config');
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * Its entries as `git config --list` spells them (section, subsection, key in lower case, `=`, the
 * value), without those of a tracking branch: every worktree's `git push -u` adds those, while a run
 * goes on, and they open nothing.
 */
export function configEntries(text: string): string[] {
  const entries: string[] = [];
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[\s*([^\s\]"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]$/.exec(line);
    if (header) {
      section = `${header[1].toLowerCase()}${header[2] === undefined ? '' : `.${header[2]}`}`;
      continue;
    }
    const pair = /^([A-Za-z][\w-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!pair || /^branch[.]/.test(section)) continue;
    entries.push(`${section}.${pair[1].toLowerCase()}=${pair[2] ?? 'true'}`);
  }
  return entries;
}

/** What changed from one text of the file to the other, entry by entry, or null when nothing did. */
export function configChange(before: string, after: string): { added: string[]; removed: string[] } | null {
  const left = configEntries(before);
  const right = configEntries(after);
  const take = (from: string[], against: string[]) => {
    const rest = [...against];
    return from.filter((entry) => {
      const at = rest.indexOf(entry);
      if (at === -1) return true;
      rest.splice(at, 1);
      return false;
    });
  };
  const added = take(right, left);
  const removed = take(left, right);
  return added.length || removed.length ? { added, removed } : null;
}
