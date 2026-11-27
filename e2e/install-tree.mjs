// The state of a set of folders, file by file, to tell what a run wrote there (27/11): the opt-in run on the real
// binary (hermes-agent.spec.ts) executes the account's installed Hermes, and two runs left bytecode files in its
// checkout. Each file is its path and `<size>:<modification time>`; a link is one entry, by its own size and time, never
// followed (a link out of the install, or a loop, is not walked). A folder that does not exist counts as empty.
// __tests__/e2e-install-tree.test.ts says each way this goes wrong.
import fs from 'node:fs';
import path from 'node:path';

/** Every file and link under each folder: absolute path to `<size>:<mtimeMs>`. */
export function installTree(dirs) {
  const tree = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      try {
        const st = fs.lstatSync(full);
        tree.set(full, `${st.size}:${st.mtimeMs}`);
      } catch { /* gone between the listing and the stat: not there */ }
    }
  };
  for (const dir of dirs) walk(dir);
  return tree;
}

/** What changed between two states: `added <path>`, `changed <path>`, `removed <path>`, sorted by path. */
export function treeChanges(before, after) {
  const out = [];
  for (const [file, state] of after) {
    if (!before.has(file)) out.push(['added', file]);
    else if (before.get(file) !== state) out.push(['changed', file]);
  }
  for (const file of before.keys()) if (!after.has(file)) out.push(['removed', file]);
  return out.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([what, file]) => `${what} ${file}`);
}
