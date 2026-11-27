// The state of a set of folders, file by file, to tell what a run wrote there (27/11): the opt-in run on the real
// binary (hermes-agent.spec.ts) executes the account's installed Hermes, and two runs left bytecode files in its
// checkout. Each file is its path and `<size>:<modification time>:<change time>:<mode>` (a chmod, or a time put back
// after a write, changes the change time); a link is one entry, by its own state, never followed (a link out of the
// install, or a loop, is not walked). Each folder's modification time is kept apart, as information: an entry made
// and then removed leaves no file but moves its folder's time. A folder that does not exist counts as empty.
// __tests__/e2e-install-tree.test.ts says each way this goes wrong.
import fs from 'node:fs';
import path from 'node:path';

const stateOf = (st) => `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}`;

/** Every file and link under each folder (absolute path to its state), and every folder's modification time. */
export function installTree(dirs) {
  const files = new Map();
  const folders = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
      folders.set(dir, String(fs.lstatSync(dir).mtimeMs));
    } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      try {
        files.set(full, stateOf(fs.lstatSync(full)));
      } catch { /* gone between the listing and the stat: not there */ }
    }
  };
  for (const dir of dirs) walk(dir);
  return { files, folders };
}

function changes(before, after) {
  const out = [];
  for (const [entry, state] of after) {
    if (!before.has(entry)) out.push(['added', entry]);
    else if (before.get(entry) !== state) out.push(['changed', entry]);
  }
  for (const entry of before.keys()) if (!after.has(entry)) out.push(['removed', entry]);
  return out.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([what, entry]) => `${what} ${entry}`);
}

/** What changed in the files between two states: `added <path>`, `changed <path>`, `removed <path>`, by path. */
export function treeChanges(before, after) {
  return changes(before.files, after.files);
}

/** The folders whose modification time moved, appeared or went, by path: information, never a failure by itself. */
export function folderChanges(before, after) {
  return changes(before.folders, after.folders);
}
