import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The symbolic links of a home that lead out of it, whatever their spelling (#467, the Audit's L1).
 *
 * A bench that runs the app on a clone of a machine's home must not reach the live one through the clone: a Claude
 * account folder's shared entries are absolute links to the live ~/.claude (claude-accounts/provision.ts,
 * linkShared), `cp -cR` copies them as they are, and the Usage speed bench of 18/10 ran two measures with them.
 *
 * Each link is judged by where it really leads, not by how its target is written: absolute or relative, climbing out
 * with `..`, through another link on the way, or the home handed in through another spelling of its path. A link that
 * resolves, by the system's own resolution (realpath); a dangling one, component by component as far as the path
 * exists, then the rest as written, since a name that does not exist cannot be a link yet. A loop leads nowhere
 * known, and is reported. A linked directory is never walked into.
 *
 * Returns `{ link, target, leadsTo }` for each: the link relative to the home, its target as written, and the real
 * place it leads to, or null for a loop. Empty when every link stays inside.
 */
export function linksLeaving(root) {
  const realRoot = fs.realpathSync(root);
  const inside = (p) => p === realRoot || p.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep);
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const leadsTo = realTargetOf(at);
        if (leadsTo === null || !inside(leadsTo)) {
          found.push({ link: path.relative(realRoot, at), target: fs.readlinkSync(at), leadsTo });
        }
      } else if (entry.isDirectory()) {
        walk(at);
      }
    }
  };
  walk(realRoot);
  return found;
}

/** Where a link really leads: the system's answer when the target exists, a loose one when it does not. */
function realTargetOf(link) {
  try {
    return fs.realpathSync(link);
  } catch (err) {
    if (err && err.code === 'ELOOP') return null;
    return resolveLoose(path.dirname(link), fs.readlinkSync(link), 0);
  }
}

/**
 * `target` read from the real directory `from`, one name at a time: a link on the way followed, a name that does not
 * exist ending the walk with the rest of the path as written. Null past forty links, a loop.
 */
function resolveLoose(from, target, hops) {
  if (hops > 40) return null;
  const root = path.isAbsolute(target) ? path.parse(target).root : '';
  let at = root || from;
  const names = target.slice(root.length).split(/[\\/]+/).filter(Boolean);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    if (name === '.') continue;
    if (name === '..') {
      at = path.dirname(at);
      continue;
    }
    const next = path.join(at, name);
    let stat;
    try {
      stat = fs.lstatSync(next);
    } catch {
      return path.join(next, ...names.slice(i + 1));
    }
    if (stat.isSymbolicLink()) {
      const real = resolveLoose(at, fs.readlinkSync(next), hops + 1);
      if (real === null) return null;
      at = real;
    } else {
      at = next;
    }
  }
  return at;
}
